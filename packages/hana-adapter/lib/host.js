/**
 * Hana 宿主上下文容器。
 *
 * 桥是常驻的 WebSocket 服务，但宿主 ctx 只在插件生命周期回调里出现。
 * index.js 在 onload 时把 ctx 存进来，桥和聊天模块从这里取。
 *
 * @module
 */

let host = null

/**
 * @param {object} ctx Hana 插件上下文。
 */
export function setHostContext(ctx) {
  host = ctx ?? null
}

/** @returns {object | null} */
export function getHostContext() {
  return host
}

/** 是否具备调用会话能力的条件。 */
export function hasSessionCapability() {
  return Boolean(host && host.bus && typeof host.bus.request === 'function')
}

/**
 * 调一个宿主 capability，统一错误收敛。
 * @param {string} type capability 名，如 session:send。
 * @param {object} payload 参数。
 */
export async function requestCapability(type, payload) {
  if (!hasSessionCapability()) {
    throw Object.assign(new Error('宿主上下文尚未就绪，插件可能刚加载'), { code: 'no-host-context' })
  }
  return host.bus.request(type, payload)
}
