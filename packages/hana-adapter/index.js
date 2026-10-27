/**
 * Hana 插件生命周期入口。
 *
 * 桥是常驻服务，需要在插件加载时就把宿主 ctx 拿到手，否则侧边栏第一条消息
 * 就没有可用的会话能力。onload 是唯一能拿到 ctx 的时机。
 *
 * @module
 */

import { setHostContext } from './lib/host.js'
import { registerChatSink } from './lib/chat-session.js'
import { broadcastChat, closeBridge, ensureStarted, status } from './lib/bridge-core.js'

export default class HanaBrowserPlugin {
  async onload() {
    setHostContext(this.ctx)
    registerChatSink((payload) => broadcastChat(payload))

    // 立刻把桥拉起来，扩展随时可以连上来。
    const port = await ensureStarted()
    const log = this.ctx?.log
    if (port) log?.info?.(`[hana-browser] bridge listening on 127.0.0.1:${port}`)
    else log?.warn?.(`[hana-browser] bridge failed to bind: ${status().lastError}`)
  }

  async onunload() {
    registerChatSink(null)
    setHostContext(null)
    await closeBridge()
  }
}
