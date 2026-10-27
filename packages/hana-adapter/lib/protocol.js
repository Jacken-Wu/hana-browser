/**
 * Wire contract between the Hana browser plugin and the Chrome extension.
 *
 * 移植自 dsh-browser 的 packages/browser/bridge-browser/src/protocol.ts。
 * 帧格式保持一致，这样扩展侧不需要改动协议层；只有宿主侧（dsh → Hana）换了。
 *
 * 一帧一个 JSON 对象，用 `t` 区分类型。id 由请求方生成，响应方原样回显。
 *
 * @module
 */

/** 扩展连接的 WebSocket 路径。 */
export const BRIDGE_PATH = '/ext/bridge'

/** 零配置发现端点：返回 `{ wsUrl }`。 */
export const BRIDGE_CONFIG_PATH = '/ext/bridge-config'

/** 新连接必须在这个时间内发 hello，否则断开。 */
export const HELLO_TIMEOUT_MS = 5_000

/** 服务端 ping 间隔。 */
export const PING_INTERVAL_MS = 30_000

/** 单次快照的默认字符预算。 */
export const DEFAULT_SNAPSHOT_MAX_CHARS = 32_000

/** 能被接受的最小快照预算。 */
export const MIN_SNAPSHOT_MAX_CHARS = 500

/** 单次快照的交互元素上限。 */
export const DEFAULT_MAX_INTERACTIVE_ITEMS = 60

/** 单次工具调用的默认预算，留出扩展 60 秒审批窗口的余量。 */
export const DEFAULT_TOOL_TIMEOUT_MS = 90_000

/** 扩展关闭码：另一个连接接管了单槽位。 */
export const REPLACED_CLOSE_CODE = 4000

/** hello 超时关闭码。 */
export const HELLO_TIMEOUT_CLOSE_CODE = 4001

/** 帧无法解析时的关闭码。 */
export const PROTOCOL_CLOSE_CODE = 1008

/**
 * 解析一条 WebSocket 消息。
 * @param {string} text - 原始消息文本。
 * @returns {object | undefined} 帧对象，或 undefined 表示非法。
 */
export function parseFrame(text) {
  let value
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  if (typeof value.t !== 'string') return undefined
  switch (value.t) {
    case 'hello':
      return typeof value.token === 'string' && isCaps(value.caps) ? value : undefined
    case 'rpc':
      return typeof value.id === 'string' && typeof value.method === 'string' ? value : undefined
    case 'respond':
      return typeof value.id === 'string' && typeof value.rpcId === 'string' ? value : undefined
    case 'tool.result':
      if (typeof value.id !== 'string') return undefined
      if (value.ok === true) return value
      return isToolError(value.error) ? value : undefined
    case 'pong':
    case 'hello.ok':
    case 'ping':
      return value
    case 'rpc.result':
      return typeof value.id === 'string' ? value : undefined
    case 'respond.result':
      return typeof value.id === 'string' ? value : undefined
    case 'event':
      return typeof value.frame === 'object' && value.frame !== null ? value : undefined
    case 'tool.call':
      return typeof value.id === 'string' && typeof value.name === 'string' ? value : undefined
    case 'tool.cancel':
      return typeof value.id === 'string' ? value : undefined
    case 'error':
      return typeof value.code === 'string' ? value : undefined
    default:
      return undefined
  }
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isCaps(value) {
  if (typeof value !== 'object' || value === null) return false
  const caps = /** @type {Record<string, unknown>} */ (value)
  return caps.textOnly === true
    && typeof caps.snapshotMaxChars === 'number'
    && Number.isInteger(caps.snapshotMaxChars)
    && caps.snapshotMaxChars >= MIN_SNAPSHOT_MAX_CHARS
    && typeof caps.maxInteractiveItems === 'number'
    && caps.maxInteractiveItems > 0
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isToolError(value) {
  return typeof value === 'object'
    && value !== null
    && typeof (/** @type {Record<string, unknown>} */ (value).code) === 'string'
    && typeof (/** @type {Record<string, unknown>} */ (value).message) === 'string'
}
