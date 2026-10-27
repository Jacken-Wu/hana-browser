import { ensureStarted, status, textContent } from '../lib/bridge-core.js'

export const name = 'browser_bridge_status'

export const description =
  '检查 Hana 浏览器桥的状态：监听端口、扩展是否已连接、最近工具调用、侧边栏会话与错误。'
  + '桥没起来或工具报 bridge-closed 时先调这个。'

export const parameters = { type: 'object', properties: {} }

export async function execute() {
  const port = await ensureStarted()
  const snapshot = status()
  const lines = [
    `监听: ${snapshot.listening ? `是（127.0.0.1:${snapshot.port}）` : '否'}`,
    `候选端口: ${snapshot.ports.join(', ')}`,
    `扩展连接: ${snapshot.connected ? '已连接' : '未连接'}`,
    `连接序号: ${snapshot.connectionSeq}`,
    `待决工具调用: ${snapshot.pendingCalls}`,
    `累计工具调用: ${snapshot.totalToolCalls}`,
    `token 校验: ${snapshot.tokenRequired ? '开启' : '关闭（仅回环）'}`,
  ]

  if (snapshot.caps) {
    lines.push(`协商预算: 快照 ${snapshot.caps.snapshotMaxChars} 字符 / 交互项 ${snapshot.caps.maxInteractiveItems}`)
  }
  if (snapshot.lastTool) {
    lines.push(`最近工具调用: ${snapshot.lastTool.name} @ ${snapshot.lastTool.at}`)
  }

  const chat = snapshot.chat || {}
  lines.push('', `侧边栏宿主上下文: ${chat.hostReady ? '已就绪' : '未就绪（会话功能不可用）'}`)
  if (Array.isArray(chat.sessions) && chat.sessions.length > 0) {
    lines.push(`侧边栏会话 ${chat.sessions.length} 个:`)
    for (const item of chat.sessions) {
      lines.push(`  tab ${item.tabId}: ${item.busy ? '回复中' : '空闲'} · ${item.sessionPath}`)
    }
  } else {
    lines.push('侧边栏会话: 尚无')
  }

  if (snapshot.lastError) lines.push('', `最近错误: ${snapshot.lastError}`)
  if (port === null) {
    lines.push('', '桥无法绑定任何候选端口，请检查端口占用。')
  } else if (!snapshot.connected) {
    lines.push('', `请在浏览器扩展里确认桥地址指向 ws://127.0.0.1:${port}/ext/bridge，或让它自动探测。`)
  }
  return textContent(lines.join('\n'))
}
