# dsh Browser Control [![dshfind](https://dshfind.com/api/badge/Lum1104/dsh-browser?lang=zh)](https://dshfind.com/zh/plugins/Lum1104/dsh-browser?ref=badge)

**English** | [中文](README.zh.md)

> [!IMPORTANT]
> **本仓库已适配 HanaAgent。** 宿主从 dsh 换成了 Hana，上游 dsh 的说明保留在下方作参考。
>
> 重装或给别人装时，只需要认准这两个文件夹：
>
> | 装什么 | 用哪个文件夹 | 装到哪里 |
> |---|---|---|
> | **Hana 插件**（连接桥 + 16 个 browser 工具 + 侧边栏会话） | `packages/hana-adapter/` | Hana → 设置 → 插件 → 从本地安装，指向该目录 |
> | **浏览器扩展**（Edge / Chrome 加载的那个） | `extension-build/` | 浏览器扩展页 → 开发者模式 → 加载已解压缩的扩展 |
>
> `packages/hana-adapter/` 里必须有 `manifest.json`，那是 Hana 插件清单。
> `extension-build/` 是构建产物的稳定副本；源码在 `extensions/dsh-browser/`，构建产物在 `extensions/dsh-browser/dist/`。

## 安装（HanaAgent 适配版）

### 1. 装 Hana 插件

在 Hana 的设置 → 插件里选择从本地目录安装，指向：

```
packages/hana-adapter/
```

装完确认插件状态是 `loaded`，并且 `browser_bridge_status` 能报出监听端口（默认从 `43190` 起）。

### 2. 构建并装浏览器扩展

先明确一件事：**`extension-build/` 不在仓库里**，它已写进 `.gitignore`。那是从源码构建出来的稳定副本，首次使用需要自己生成。

#### 2.1 构建

需要 Node.js 22 以上。仓库是 pnpm workspace，先装扩展需要的依赖：

```powershell
# 首次安装依赖，只需要一次，约两分钟
corepack pnpm install --filter "dsh-browser-extension..." --no-frozen-lockfile --pm-on-fail=ignore
```

`--pm-on-fail=ignore` 是为了绕开一个版本冲突：`package.json` 里锁了 `packageManager: pnpm@11.7.0`，而 corepack 可能已经装了别的大版本，两者对不上会直接报 `ERR_PNPM_BAD_PM_VERSION`。如果你的 corepack 恰好就是 11.7.0，可以去掉这个参数。

然后构建并同步：

```powershell
$env:PATH = "$PWD\extensions\dsh-browser\node_modules\.bin;$env:PATH"
node extensions\dsh-browser\scripts\build.mjs
.\scripts\install-extension.ps1
```

三步分别做的是：编译扩展源码到 `extensions/dsh-browser/dist/`，把 dist 复制到 `extension-build/`，然后打开扩展管理页。

产物结构：

```
extension-build/
  manifest.json      浏览器靠这个认出扩展
  background.js      桥连接、工具分发、审批
  content.js         页面快照与操作，注入到网页
  hana-panel.html    侧边栏界面
  hana-panel.js      侧边栏逻辑
  panel/ assets/ _locales/
```

#### 2.2 加载到浏览器

在 Edge 或 Chrome 打开 `edge://extensions`（或 `chrome://extensions`），开启开发人员模式，点「加载已解压缩的扩展」，选择：

```
extension-build/
```

扩展装好后不需要配置地址，它会自己探测本机的 Hana 桥（从端口 `43190` 开始找）。

### 3. 改完代码之后

| 改了什么 | 要做什么 |
|---|---|
| `packages/hana-adapter/` | 重新安装 Hana 插件，然后重启 Hana |
| `extensions/dsh-browser/` | 构建 → 同步 → 扩展页点「重新加载」 |

构建和同步：

```powershell
$env:PATH = "$PWD\extensions\dsh-browser\node_modules\.bin;$env:PATH"
node extensions\dsh-browser\scripts\build.mjs
.\scripts\install-extension.ps1
```

> 注意：Hana 的插件运行时按文件路径缓存 ES 模块，改了 `lib/` 下的文件后，单纯的插件重载不会生效，需要重启 Hana 或换文件名。正式安装 + 重启一次之后不会再遇到。

### 目录速查

```
packages/hana-adapter/        Hana 插件（装进 Hana 的就是这个）
  manifest.json               插件清单
  index.js                    生命周期入口，捕获宿主上下文
  lib/bridge-core.js          WebSocket 桥（纯 Node 内置实现）
  lib/chat-session.js         侧边栏会话与独立 agent
  lib/host.js                 宿主上下文容器
  lib/protocol.js             线协议定义
  tools/*.js                  16 个模型可调用工具
  test/                       协议层与端到端自测脚本
extensions/dsh-browser/       浏览器扩展源码（TypeScript + React）
  src/background/             桥连接、工具分发、审批
  src/content/                页面快照与操作（注入到网页）
  dist/                       构建产物
extension-build/              给浏览器加载的稳定副本
scripts/install-extension.ps1 构建产物同步到 extension-build 并打开扩展页
```

---

以下为上游 dsh 版本的原始说明，保留作参考。Hana 环境不需要执行其中的 `dsh plugin` 命令。

---

<img width="1701" height="897" alt="dsh Browser Control" src="https://github.com/user-attachments/assets/3b1f3a25-f962-4e02-a9ef-d23e0d01fc8e" />

Connect [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) to the Chrome or Firefox tabs you are already using. The model can read page content, operate controls, navigate, and manage tabs while preserving your login state, session, and cookies. A side panel or sidebar provides the conversation UI.

`dsh` is DeepSeek AI's open-source, plugin-based agent harness. This repository provides a companion browser bridge plugin and Chrome/Firefox MV3 extension as one standalone pnpm workspace.

Browser operation remains text-only: pages become structured text with a numbered inventory of interactive elements, and the model addresses those elements by number. dsh 0.2.0 multimodal chat is separate from that page channel—the side panel accepts PNG, JPEG, WebP, and GIF attachments when the host advertises image support, while browser tools still never capture screenshots.

> [!IMPORTANT]
> The workspace pins dsh 0.2.0-rc.2, the minimum supported runtime. Older DSH releases are not supported.

## Quick install

The standard `dsh plugin` command alone cannot install this project. The integration contains both a dsh bridge plugin and a browser extension. The one-line installer currently sets up the Chrome build.

macOS and Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/Lum1104/dsh-browser/refs/heads/main/scripts/install.sh | bash
```

Windows, in PowerShell:

```powershell
$s="$env:TEMP\dsh-install.ps1"; irm https://raw.githubusercontent.com/Lum1104/dsh-browser/refs/heads/main/scripts/install.ps1 -OutFile $s; powershell -NoProfile -ExecutionPolicy Bypass -File $s
```

When the installer opens `chrome://extensions`, follow its instructions to load or reload **dsh Browser Assistant**. If dsh is already running, restart it after installation. See [Detailed installation and usage](#detailed-installation-and-usage) for prerequisites, startup commands, updates, and developer installation.

> [!IMPORTANT]
> The unscoped [`dsh-browser`](https://www.npmjs.com/package/dsh-browser) package on npm belongs to a different project and is not affiliated with this repository. This project is not currently published as an npm package; use the installer above.

## Performance

In a paired 60-run end-to-end benchmark on August 18, 2026, both backends completed all 30 assigned runs successfully, while dsh Browser Control required fewer model/tool round trips and finished faster:

| Backend | Success | Mean end-to-end latency | Mean browser tool calls |
|---|---:|---:|---:|
| **dsh Browser Control** | **30/30** | **5.32 s** | **3.4** |
| Matched Playwright baseline | 30/30 | 6.67 s | 4.7 |

The paired Playwright / extension duration ratio was **1.24** (95% CI **1.16–1.34**): Playwright took about 24% longer, or equivalently, dsh Browser Control reduced latency by about 20% and saved 1.35 seconds per task on average. The suite used six browser tasks, five deterministic seeds, the same DSH profile and model (`deepseek-v4-flash`), and independently validated page state. See the [benchmark methodology and reproduction guide](benchmark/README.md).

## Core capabilities

| Capability | Tool | Notes |
|---|---|---|
| Read page | `browser_snapshot` | Structured text snapshot: title, URL, main text, numbered controls, and masked form fields; `delta: true` returns only changes |
| Click element | `browser_click` | Click links, buttons, checkboxes, and other controls by inventory number |
| Fill forms | `browser_type` | React/Vue-compatible input; `replace` clears the field first |
| Press keys | `browser_press` | Keyboard events such as Enter, Tab, Escape, and arrow keys |
| Scroll | `browser_scroll` | Viewport scrolling: up, down, top, and bottom |
| Navigate | `browser_navigate` / `browser_open_tab` / `browser_back` / `browser_forward` / `browser_reload` | Navigation inside the controlled tab, or open a URL in a new tab and follow it (`active:false` keeps the current tab in front) |
| List tabs | `browser_list_tabs` | List accessible tabs with stable IDs, titles, URLs, window/index metadata, and active/controlled state |
| Follow tab | `browser_follow_tab` | Bind later browser tools to a tab returned by `browser_list_tabs` without activating it |
| Close tab | `browser_close_tab` | Close a tab returned by `browser_list_tabs` |
| Read region | `browser_get_text` | Lazy-loaded or partial page text |
| Wait for stability | `browser_wait` | Page-load and render-settle detection |
| Send images | `session.prompt` / `session.attachment` | Host-capability-gated image drafts, image-only prompts, and durable history previews |
| Quote a selection | side panel composer | Text you highlight in the page appears in the composer and is sent with your next message as fenced, attributed page content |

## Repository layout

```
packages/browser/bridge-browser/
  cordis.patch.yml
extensions/dsh-browser/
scripts/install.sh
scripts/install.ps1
```

## Why this design

- **Your real browser, not a headless copy**: the model works in the page you already have open, retaining logins, sessions, and cookies.
- **A text-first page interface**: numbered controls, stable IDs across snapshots, delta updates, and masked sensitive values make pages operable without screenshots; user-attached chat images use dsh's separate multimodal message path.
- **Pointing instead of describing**: highlight the passage you mean and the side panel quotes it, so "explain this" needs no page tour. The quote is captured only while a panel is open, and nothing is sent until you send the message.
- **A narrow privacy boundary**: passwords and payment-card values are always rendered as `••••` and never leave the page.
- **A guarded bridge**: authenticated handshakes protect remote connections, privileged gateway methods reject non-loopback callers, and the extension binds tools to one user-controlled tab.

## Detailed installation and usage

Requirements: Node.js `^22.19` or `>=24`, Corepack/pnpm, and Chrome 116+ or Firefox 140+. Windows additionally needs Windows PowerShell 5.1, which ships with Windows, or PowerShell 7+.

### Install or update

For a managed installation, run:

```sh
curl -fsSL https://raw.githubusercontent.com/Lum1104/dsh-browser/refs/heads/main/scripts/install.sh | bash
```

or, on Windows:

```powershell
$s="$env:TEMP\dsh-install.ps1"; irm https://raw.githubusercontent.com/Lum1104/dsh-browser/refs/heads/main/scripts/install.ps1 -OutFile $s; powershell -NoProfile -ExecutionPolicy Bypass -File $s
```

The installer downloads `main`, builds and registers the bridge plugin, builds the Chrome extension into `~/.dsh/browser-extension`, and opens `chrome://extensions`. On the first install, load that directory as an unpacked extension; on updates, click **Reload**. Restart dsh if it is already running.

`scripts/install.sh` covers macOS and Linux, and `scripts/install.ps1` covers Windows; both write the same managed workspace and the same install metadata. The installer copies the extension path to the clipboard when a clipboard tool is available (`pbcopy`, `wl-copy`, `xclip`, `xsel`, or PowerShell's `Set-Clipboard`), and prints the path either way. When no Chrome or Chromium install is found, it prints the command that installs one; set `DSH_INSTALL_BROWSER=1` to let the installer attempt that install itself.

The Windows command downloads `install.ps1` and runs it rather than piping it into `Invoke-Expression`: the script is UTF-8 with a byte order mark so Windows PowerShell renders its Chinese output, and `Invoke-Expression` rejects a leading mark. Local checkout paths may contain spaces; the installer registers the bridge through a profile-local directory junction so the package spec never contains the absolute Windows path.

To install the current branch from a source checkout instead:

```sh
git clone https://github.com/Lum1104/dsh-browser.git
cd dsh-browser
./scripts/install.sh
```

On Windows, run `.\scripts\install.ps1` from the checkout instead. After pulling or switching revisions, rerun the installer and reload the extension.

### Firefox source build

Firefox uses a separate MV3 manifest, event-page background, and sidebar. Build it from a checkout, then open `about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on**, and select `extensions/dsh-browser/dist-firefox/manifest.json`:

```sh
pnpm install
pnpm --filter dsh-browser-extension run build:firefox
```

The bridge address is still auto-discovered. Firefox's `moz-extension://` UUID does not authenticate an add-on, so copy the bearer token from `~/.dsh/ext-bridge-token` into the extension settings (the dsh startup log reports that file's path). Signed distribution can package the same `dist-firefox/` output.

### Start and use

Start the managed installation with:

```sh
cd ~/.dsh/dsh-browser && pnpm start
```

From a source checkout, run `pnpm start` in the repository root. The exact supported public runtime is:

```sh
npx @deepseek-ai/dsh@0.2.0-rc.2 web
```

Local Chrome use requires no configuration; Firefox requires the local bridge token described above. Open a page, click the DeepSeek whale icon, and wait for **Connected**. Existing HTTP(S) tabs are instrumented on the first action. On browser-protected pages and extension stores, the model can read tab metadata and use browser-level HTTP(S) navigation, back, forward, and reload, but it cannot inspect or operate the protected page DOM.

## Troubleshooting

**Side panel stays "Not connected"**

- Make sure dsh web is running locally (default `http://127.0.0.1:3080`).
- Verify the bridge is loaded: open `http://127.0.0.1:3080/ext/bridge-config`. It should return JSON such as `{"wsUrl":"ws://127.0.0.1:3080/ext/bridge"}`. If it returns a web page instead of JSON, the running dsh predates the bridge registration — restart dsh and refresh the page; the extension reconnects on its own.
- The extension probes ports 3080, 3081, 3090, and 14389 automatically. If dsh runs on another port — or you use a remote `--host 0.0.0.0` deployment — set the address (and bridge token) in the panel settings. Firefox always requires the token.

## Development

The bridge plugin and Chrome/Firefox extension are both members of this repository's workspace. Run all commands from the repository root. For the first development installation, run `pnpm install`.

```sh
pnpm run build
pnpm run typecheck
pnpm run test
pnpm run check:runtime
pnpm run test:smoke

pnpm --filter @yuxianglin/dsh-bridge-browser run build
pnpm --filter @yuxianglin/dsh-bridge-browser run typecheck
pnpm --filter @yuxianglin/dsh-bridge-browser run test

pnpm --filter dsh-browser-extension run build
pnpm --filter dsh-browser-extension run build:firefox
pnpm --filter dsh-browser-extension run test
```

Notes:

- The bridge plugin must have a built `lib/` before startup because the loader consumes it; both `scripts/install.sh` and the root `pnpm run build` build the plugin before the extension.
- The bridge build copies its browser client with Node.js `copyFileSync`, so the same package script works without a Unix `cp` executable.
- The dependencies of `@deepseek-ai/dsh` and the bridge plugin are pinned to the same tested public release line. An upgrade must update the manifests and lockfile together and rerun the root checks.

`check:runtime` checks the resolved DSH dependencies and lockfile; `test:smoke` starts the real web host in a temporary DSH home and verifies the bridge and session reads after a restart, without model credentials. CI runs these checks after a clean installation.

If you encounter `cache.hydratePrepared is not a function`, update the repository, rerun `pnpm install --frozen-lockfile` and `pnpm run build`, then restart `pnpm start`. Session data and the global package cache can be kept.

## Security

- The bridge path sits outside the `/api` trust boundary and performs its own bearer-token authentication.
- Local Chrome extension origins retain zero-configuration loopback access; Firefox origins are per-install UUIDs and must present the bearer token.
- Privileged gateway methods such as `settings.*`, `credentials.*`, and `host.open*` reject non-loopback sources.
- The browser-page pipeline is text-only and never captures screenshots; explicitly attached chat images use dsh's durable attachment service. Password and payment-card values never leave the page.
- When work begins, the assistant binds to the active tab (at prompt submission, or at the first direct browser-tool call). If you switch tabs manually, later browser actions pause and the side panel asks whether the assistant should continue on the original tab or follow the new one. Choosing the original tab permits background operation; the extension never silently retargets or changes your visible tab. Closing the controlled tab also pauses tools until you explicitly select the current page.
- Text you highlight is captured only while a side panel is open and page sharing is not `off`, and never from password or payment-card fields. It stays inside the extension until you send the message, is dropped when you dismiss it or its page navigates or closes, and reaches the model inside the same untrusted-content boundary as page snapshots — including its source title and URL, which the page also controls.
- Page-authored text is wrapped as untrusted input. The default `auto` mode reads only the controlled tab without an extra prompt; privacy-sensitive users can select `ask` for per-read confirmation or `off` to block reads entirely. In `ask` mode, the read dialog can allow one read or persistently switch back to `auto`; this can be reversed in Settings. Read page text is sent to the selected model.
- Click, type, keypress, navigation, history, and reload calls fail closed until the user approves them. An origin may be trusted for the current side-panel session (cleared when the last panel closes or the service worker restarts), while permanent trust is managed explicitly in Settings. Explicit cross-origin `browser_navigate` calls and unknown history destinations always prompt again.
- **Allow unrestricted browser control** is an explicit global opt-in. It becomes active only after the setting is saved successfully; while enabled, page reads, page actions, and tab list/follow/close operations run without approval prompts. Calls capture their access mode when received, so enabling unrestricted control never retroactively elevates an existing restricted call. Disabling it takes effect immediately, cancels calls that have not dispatched an action, waits for already-dispatched browser operations to settle, and only then saves the restrictive setting. A rapid re-enable remains restricted until that revocation finishes, and concurrent saves persist in request order. Browser-protected DOM content remains inaccessible in either mode.
