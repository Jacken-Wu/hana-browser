# Hana Browser Adapter

把 [dsh-browser](https://github.com/omdsh-dev/dsh-browser) 的浏览器能力接到 HanaAgent 上的适配层。

上游是一个「Chrome MV3 侧边栏扩展 + dsh 桥接插件」的组合：模型能读取和操作用户正在使用的标签页，保留登录态，页面以结构化文本加编号交互清单呈现，永不截图。

这里做的是把**宿主侧**从 dsh 换成 Hana。扩展侧只改了两处非协议逻辑，协议层完全不动。

## 目录

```
packages/hana-adapter/          Hana 插件（纯 ESM，零 npm 依赖）
  manifest.json                 Hana 插件清单
  lib/protocol.js               线协议：帧定义与解析（翻译自 dsh 的 protocol.ts）
  lib/bridge.js                 WebSocket 服务端 + 工具分发
  tools/*.js                    16 个模型可调用工具
  test/bridge-smoke.mjs         协议层自验，不需要浏览器
  test/extension-e2e.mjs        真浏览器端到端验证
extensions/dsh-browser/         上游扩展（已打补丁）
  dist/                         构建产物，加载这个目录
```

## 相对上游改了什么

**扩展侧（3 处）**

1. `DISCOVERY_PORTS` 前置 `43190-43194`。Hana 的端口段排在 dsh 的 `3080/3081/3090/14389/43189` 之前，避免本机同时装着 dsh 时扩展先连到 dsh。
2. 常驻连接。上游把桥连接设计成「面板租约」：侧边栏打开才允许占用单槽位，关闭就断开。Hana 自带对话界面，扩展只当执行器，所以改成扩展启用即连接，靠 `chrome.alarms` 定期唤醒 service worker 重连。由 `PERSISTENT_BRIDGE` 常量控制，置 `false` 可回到上游行为。
3. `unrestrictedBrowserAccess` 默认改为 `true`。上游要求每次写操作都在侧边栏确认，没有面板就 60 秒超时失败。Hana 没有这个面板，审批责任交给 Hana 自己的工具审批层。

**宿主侧（全新实现）**

`lib/bridge.js` 用纯 Node 内置模块实现了原来靠 `ws` 库和 Cordis 插件框架完成的事：

- WebSocket 握手与帧编解码手写，约百行，因为插件目录没有 `node_modules`
- 只保留工具通道（`tool.call` / `tool.result`）与心跳（`ping` / `pong`）
- `rpc` 通道（侧边栏对话）明确回 `unsupported`，`event` 通道不实现
- 单连接语义：新连接接管旧连接，旧连接的待决调用以 `bridge-closed` 结算

## 安装

### 1. Hana 插件

插件源码在 `packages/hana-adapter/`。用 Hana 的插件开发工具装入，或在设置里指向该目录。

装入后调一次 `browser_bridge_status`，桥会启动并占用 `43190`（被占用时依次尝试 `43191-43194`）。

### 2. 浏览器扩展

```powershell
.\scripts\install-extension.ps1
```

脚本会把 `extensions/dsh-browser/dist` 复制到 `%LOCALAPPDATA%\hana-browser-extension`，然后打开扩展管理页。选择「加载解压缩的扩展」，指向该目录。

Edge 和 Chrome 都能用（116+）。改了扩展源码后重新构建，再在扩展管理页点「重新加载」。

## 工具

| 工具 | 作用 |
|---|---|
| `browser_bridge_status` | 诊断：端口、连接状态、待决调用、最近错误 |
| `browser_snapshot` | 结构化文本快照，`delta: true` 只返回变化 |
| `browser_click` / `browser_type` / `browser_press` | 按快照里的稳定编号操作 |
| `browser_scroll` / `browser_navigate` / `browser_open_tab` | 页面移动 |
| `browser_list_tabs` / `browser_follow_tab` / `browser_close_tab` | 标签页管理 |
| `browser_back` / `browser_forward` / `browser_reload` | 导航 |
| `browser_get_text` / `browser_wait` | 读区域 / 等待稳定 |

## 验证

```sh
# 协议层，不需要浏览器
node packages/hana-adapter/test/bridge-smoke.mjs

# 端到端，会用 Playwright 拉起 Edge 并加载扩展
node packages/hana-adapter/test/extension-e2e.mjs
```

端到端脚本自己当桥，验证链路是：扩展自动发现并连接 → `tool.call` 抵达扩展 → 扩展在真实标签页执行 → `tool.result` 回桥。

## 已知限制

- **单连接**：同一时刻只有一个扩展连接。第二个窗口连上来会顶掉第一个。
- **MV3 挂起**：没有侧边栏时 service worker 仍可能被浏览器挂起，最坏情况下有约 30 秒的重连空窗（靠 `chrome.alarms` 的 0.5 分钟周期兜底）。工具报 `bridge-closed` 时重试即可。
- **登录态不跨会话持久**：扩展本身持有浏览器，登录态跟着浏览器走，不跟 Hana 会话走。
- **无视觉**：页面只以文本呈现，不截图。也正因如此，图形验证码、纯 Canvas 内容读不到。
- **端口冲突**：`43190-43194` 全被占用时桥起不来，`browser_bridge_status` 会报出来。
- **上游依赖**：协议、快照渲染、隐私遮罩、标签页归属协商都来自上游，升级上游时这三个文件的补丁要重新应用。
