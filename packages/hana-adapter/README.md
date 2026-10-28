# Hana Browser Adapter

把 [dsh-browser](https://github.com/omdsh-dev/dsh-browser) 的浏览器能力接到 HanaAgent 上的适配层。

上游是一个「Chrome MV3 侧边栏扩展 + dsh 桥接插件」的组合：模型能读取和操作用户正在使用的标签页，保留登录态，页面以结构化文本加编号交互清单呈现，永不截图。

这里做的是把**宿主侧**从 dsh 换成 Hana。扩展侧只改了两处非协议逻辑，协议层完全不动。

## 目录

```
packages/hana-adapter/          Hana 插件（纯 ESM，零 npm 依赖）
  manifest.json                 Hana 插件清单
  lib/protocol.js               线协议：帧定义与解析（翻译自 dsh 的 protocol.ts）
  lib/bridge-core.js            WebSocket 服务端 + 工具分发
  lib/bilibili.js               B 站取流：链接解析、DASH 音频、下载
  lib/audio.js                  ffmpeg 转码到 16k 单声道 WAV
  lib/asr.js                    识别引擎层：配置、命令行执行、HTTP 兼容模式
  asr/sensevoice_oneshot.py     一次性识别脚本（sherpa-onnx + SenseVoice）
  tools/*.js                    17 个模型可调用工具
  test/bridge-smoke.mjs         协议层自验，不需要浏览器
  test/video-transcript-smoke.mjs  转写链路离线自检，不需要联网
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
| `browser_video_transcript` | B 站视频本地转文字稿，见下节 |

## 视频转写（B 站）

给侧边栏加一个「总结这个视频」的能力。链路是：

```
播放页链接 → DASH 音频（m4s）→ ffmpeg 转 16k wav → 本地识别 → 文稿
```

**没有常驻服务。** 识别引擎是每次调用拉起一个进程，跑完就退：没有端口、
没有守护进程、闲时占用严格为零。代价是每次重新加载模型，
SenseVoice int8 大约 1 到 2 秒。

之所以不用 MCP stdio 托管、也不用插件托管的常驻子进程：MCP 会把转写暴露成
模型可调用的工具，接不进 Hana 的 `speech_recognition` provider 体系；常驻子进程
要多管一套生死。一次性进程在这两个维度上都不用做决定。

### 装依赖（三步）

#### 1. Python 包

```powershell
pip install sherpa-onnx -i https://mirrors.aliyun.com/pypi/simple/
python -c "import sherpa_onnx; print(sherpa_onnx.__version__)"
```

> **镜像坑**：清华镜像（`pypi.tuna.tsinghua.edu.cn`）对这个包的索引 pip 解析不出可用文件，
> 会报 `No matching distribution found for sherpa-onnx`，看着像环境问题，其实是镜像问题。
> 同一条命令换成阿里云或官方 `https://pypi.org/simple` 就能装上。不用改全局配置，
> 只给这一条命令换源即可。

需要 Python 3.9+ 的 64 位版本（wheel 是 cp39/cp310/cp311/cp312/cp313 编译的，32 位没有）。

#### 2. 模型

推荐 `sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09`，两个文件：

| 文件 | 大小 |
|---|---|
| `model.int8.onnx` | 237,115,547 字节（约 226 MB） |
| `tokens.txt` | 315,894 字节（约 309 KB） |

下载地址（国内直连可用）：

```
https://hf-mirror.com/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09/resolve/main/model.int8.onnx
https://hf-mirror.com/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09/resolve/main/tokens.txt
```

放到插件数据目录下的 `models/sensevoice`，Windows 默认是：

```
%USERPROFILE%\.hanako\plugin-data\hana-browser\models\sensevoice\
  model.int8.onnx
  tokens.txt
```

这个位置不是硬编码的：配置里的 `asr.modelDir` 指到哪就用哪。不知道实际路径时，
用下面的 `probe: true` 调一次工具，它会把解析出来的路径打出来。

模型文件不要放进插件目录，插件更新会覆盖。

#### 3. ffmpeg

装好加进 PATH 即可。探测顺序是 PATH → `C:\ffmpeg\bin` → chocolatey → scoop；
都不在时在配置里写 `ffmpeg.path`。

### 验证安装

先单独验一遍 Python 包（不需要 Hana）：

```powershell
python -c "import sherpa_onnx; print('ok')"
```

再在 Hana 里调一次 `browser_video_transcript`，参数 `{"probe": true}`。
它会逐项报引擎、ffmpeg、模型目录、配置文件的状态，缺什么直接说。

### 配置

插件数据目录下的 `config.json`，缺失就用默认值：

```json
{
  "asr": {
    "engine": "cli",
    "python": "python",
    "modelDir": "{dataDir}/models/sensevoice",
    "language": "zh",
    "threads": 4,
    "timeoutMs": 1200000,
    "command": [
      "{python}", "{pluginDir}/asr/sensevoice_oneshot.py",
      "--model", "{modelDir}", "--input", "{input}",
      "--language", "{language}", "--threads", "{threads}"
    ],
    "output": "stdout"
  },
  "ffmpeg": { "path": "", "timeoutMs": 300000 },
  "cache": { "keepAudio": false }
}
```

`asr.engine` 有两个值：

- `cli`（默认）：按 `command` 拉起进程，支持 `{input}` `{modelDir}` `{language}`
  `{threads}` `{dataDir}` `{pluginDir}` `{python}` `{output}` 占位符。
  `output` 可设 `stdout` / `json-stdout` / `file`。
  **换模型只改 `modelDir` 或换一条 `command`，插件代码一行不动。**
- `http`：指向一个 OpenAI 兼容的 `/v1/audio/transcriptions`，适合已经在跑
  `funasr-server` 之类服务的情况，省掉每次 1 到 2 秒的冷启动。插件本身不启动服务。

### 为什么是这几个取舍

- **不碰显卡。** SenseVoice 是非自回归模型，一次前向出一整段文本。
  实测 522 秒的中文视频，从转码到出稿 13.4 秒（含模型加载），约 39 倍实时；
  1 小时视频大约 1 分半到 2 分钟。GPU 一旦被占，风扇和显存争用比 CPU 占用更让人分心。
- **线程钉在 4，进程降到 BelowNormal。** 这两项在 Windows 上对体感的改善比换更小的模型明显。
- **分块流式读取。** 1 小时音频不一次性读进内存，按 30 秒窗口喂，峰值内存只有几十 MB。
- **结果落盘缓存。** 同一视频第二次调用秒回；`force: true` 才重转。

### 验证

```sh
node packages/hana-adapter/test/video-transcript-smoke.mjs
node packages/hana-adapter/test/turn-complete.mjs
```

在 Hana 里调一次 `browser_video_transcript`，参数 `{"probe": true}`，
它会报出引擎、ffmpeg、模型目录各自的状态。

## 验证

```sh
# 协议层，不需要浏览器
node packages/hana-adapter/test/bridge-smoke.mjs

# 转写链路，不需要联网和浏览器
node packages/hana-adapter/test/video-transcript-smoke.mjs

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
- **转写依赖外部引擎**：插件自己不带模型。没装 `sherpa-onnx` 或没下模型时，
  工具会返回明确的缺失项，不影响其余浏览器工具。
- **B 站接口风控**：请求带完整 Chrome UA 反而会被拦（实测 412），必须用短 UA。
  音频地址两小时过期，所以每次现取，只缓存文稿不缓存 URL。
- **会话长度上限**：宿主的 `session:history` 是取**前** N 条而不是最后 N 条，
  所以一个标签页聊到 200 条之后新回复就看不到了。到达上限时插件会直接报错
  让你点「新对话」，而不是默默挂着不动。
- **只走音频**：画面里的 PPT、代码、演示不被理解，知识类视频的总结会有信息损失。
- **上游依赖**：协议、快照渲染、隐私遮罩、标签页归属协商都来自上游，升级上游时这三个文件的补丁要重新应用。
