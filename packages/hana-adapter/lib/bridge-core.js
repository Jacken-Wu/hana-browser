/**
 * Hana 侧的浏览器桥：一个纯 Node 内置模块实现的 WebSocket 服务端，
 * 让 Chrome 扩展把它当作 dsh bridge 连上来。
 *
 * 与 dsh 版本的差别：
 * - 没有 Cordis 的 ctx、没有 Typert Remote、没有 session 投影。
 * - 只保留工具通道（tool.call / tool.result），rpc 与 event 通道回以明确错误。
 * - 服务端由插件进程常驻，不依赖任何 GUI 生命周期。
 *
 * 设计约束：
 * - 插件目录没有 node_modules，只能用 node: 内置模块。
 * - 因此 WebSocket 握手与帧编解码在这里手写，约百行。
 *
 * @module
 */

import http from 'node:http'
import crypto from 'node:crypto'
import {
  BRIDGE_CONFIG_PATH,
  BRIDGE_PATH,
  DEFAULT_MAX_INTERACTIVE_ITEMS,
  DEFAULT_SNAPSHOT_MAX_CHARS,
  DEFAULT_TOOL_TIMEOUT_MS,
  HELLO_TIMEOUT_CLOSE_CODE,
  HELLO_TIMEOUT_MS,
  PING_INTERVAL_MS,
  PROTOCOL_CLOSE_CODE,
  REPLACED_CLOSE_CODE,
  parseFrame,
} from './protocol.js'
import { abortChat, chatStatus, readChat, resetChat, sendChat } from './chat-session.js'

/**
 * 扩展会按顺序探测 discovery 端口，这里必须与扩展侧的 HANA_DISCOVERY_PORTS 前缀一致。
 * 43190 起避开 dsh 的 3080/3081/3090/14389/43189。
 */
const HANA_PORTS = [43190, 43191, 43192, 43193, 43194]

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/** 允许的 hello token。loopback 连接默认豁免，填了则必须匹配。 */
const EXPECTED_TOKEN = process.env.HANA_BROWSER_TOKEN || ''

function freshState() {
  return {
    server: null,
    port: null,
    socket: null,
    authed: false,
    caps: null,
    pingTimer: null,
    helloTimer: null,
    connectSeq: 0,
    toolCalls: 0,
    lastError: null,
    startedAt: null,
    pending: new Map(),
    lastTool: null,
  }
}

const STATE_KEY = '__hanaBrowserBridgeServer'
const LEGACY_STATE_KEYS = ['__hanaBrowserBridge', '__hanaBrowserBridgeV2', '__hanaBrowserBridgeV3', '__hanaBrowserBridgeRuntime']

const state = (() => {
  // 开发期重载会留下上一代实例：它们的 server 还占着端口，回调也指向旧模块。
  // 宿主不会清 ESM 缓存，所以这里主动把残留的连接释放掉，新实例才能拿到原端口。
  for (const key of LEGACY_STATE_KEYS) {
    const previous = globalThis[key]
    if (previous && previous.server) {
      try {
        previous.server.close()
      } catch {
        /* 已经关闭 */
      }
      previous.server = null
      previous.port = null
    }
    try {
      delete globalThis[key]
    } catch {
      /* 不可删除就留着，不影响本轮 */
    }
  }
  if (!globalThis[STATE_KEY]) globalThis[STATE_KEY] = freshState()
  return globalThis[STATE_KEY]
})()

let readyPromise = null

// ---------------------------------------------------------------- WebSocket

function wsAccept(key) {
  return crypto.createHash('sha1').update(key + WS_GUID).digest('base64')
}

function encodeFrame(payload, opcode = 0x1) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf-8')
  const len = data.length
  let header
  if (len < 126) {
    header = Buffer.alloc(2)
    header[1] = len
  } else if (len < 65536) {
    header = Buffer.alloc(4)
    header[1] = 126
    header.writeUInt16BE(len, 2)
  } else {
    header = Buffer.alloc(10)
    header[1] = 127
    header.writeBigUInt64BE(BigInt(len), 2)
  }
  header[0] = 0x80 | opcode
  return Buffer.concat([header, data])
}

/**
 * 解出一批完整帧，返回剩余未成帧的字节。
 * 只处理单帧消息：扩展发的是小 JSON，不会分片。
 */
function decodeFrames(buf) {
  const frames = []
  let offset = 0
  while (offset + 2 <= buf.length) {
    const b0 = buf[offset]
    const b1 = buf[offset + 1]
    const opcode = b0 & 0x0f
    const masked = (b1 & 0x80) !== 0
    let len = b1 & 0x7f
    let p = offset + 2
    if (len === 126) {
      if (p + 2 > buf.length) break
      len = buf.readUInt16BE(p)
      p += 2
    } else if (len === 127) {
      if (p + 8 > buf.length) break
      len = Number(buf.readBigUInt64BE(p))
      p += 8
    }
    let maskKey = null
    if (masked) {
      if (p + 4 > buf.length) break
      maskKey = buf.subarray(p, p + 4)
      p += 4
    }
    if (p + len > buf.length) break
    const payload = Buffer.from(buf.subarray(p, p + len))
    if (maskKey) {
      for (let i = 0; i < payload.length; i += 1) payload[i] ^= maskKey[i % 4]
    }
    frames.push({ opcode, payload })
    offset = p + len
  }
  return { frames, rest: buf.subarray(offset) }
}

function sendFrame(socket, frame) {
  if (!socket || socket.destroyed || !socket.writable) return false
  try {
    socket.write(encodeFrame(JSON.stringify(frame)))
    return true
  } catch {
    return false
  }
}

function closeSocket(socket, code, reason) {
  if (!socket || socket.destroyed) return
  const payload = Buffer.alloc(2 + Buffer.byteLength(reason || '', 'utf-8'))
  payload.writeUInt16BE(code, 0)
  if (reason) payload.write(reason, 2, 'utf-8')
  try {
    socket.write(encodeFrame(payload, 0x8))
    socket.end()
  } catch {
    /* 已经断开 */
  }
}

// ---------------------------------------------------------------- 连接管理

function settleAllPending(code, message) {
  for (const [, entry] of state.pending) {
    clearTimeout(entry.timer)
    entry.reject(Object.assign(new Error(message), { code }))
  }
  state.pending.clear()
}

function replaceConnection(socket) {
  const previous = state.socket
  state.socket = socket
  state.authed = false
  state.caps = null
  state.connectSeq += 1
  if (previous && previous !== socket) {
    settleAllPending('bridge-closed', '另一个浏览器连接接管了桥')
    closeSocket(previous, REPLACED_CLOSE_CODE, 'replaced by a newer connection')
  }
}

function attachSocket(socket) {
  replaceConnection(socket)

  state.helloTimer = setTimeout(() => {
    if (state.socket === socket && !state.authed) {
      closeSocket(socket, HELLO_TIMEOUT_CLOSE_CODE, 'hello timeout')
    }
  }, HELLO_TIMEOUT_MS)

  let buf = Buffer.alloc(0)

  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk])
    const { frames, rest } = decodeFrames(buf)
    buf = rest
    for (const frame of frames) {
      if (frame.opcode === 0x8) {
        closeSocket(socket, 1000, '')
        return
      }
      if (frame.opcode === 0x9) {
        try {
          socket.write(encodeFrame(frame.payload, 0xa))
        } catch {
          /* ignore */
        }
        continue
      }
      if (frame.opcode !== 0x1 && frame.opcode !== 0x2) continue
      handleText(socket, frame.payload.toString('utf-8'))
    }
  })

  socket.on('error', () => {
    /* 断开在下游 close 处理 */
  })

  socket.on('close', () => {
    if (state.socket === socket) {
      state.socket = null
      state.authed = false
      state.caps = null
      if (state.pingTimer) {
        clearInterval(state.pingTimer)
        state.pingTimer = null
      }
      if (state.helloTimer) {
        clearTimeout(state.helloTimer)
        state.helloTimer = null
      }
      settleAllPending('bridge-closed', '浏览器扩展已断开')
    }
  })
}

function handleText(socket, text) {
  const frame = parseFrame(text)
  if (!frame) {
    closeSocket(socket, PROTOCOL_CLOSE_CODE, 'unparseable frame')
    return
  }

  if (!state.authed) {
    if (frame.t !== 'hello') {
      closeSocket(socket, PROTOCOL_CLOSE_CODE, 'hello required first')
      return
    }
    if (EXPECTED_TOKEN && frame.token !== EXPECTED_TOKEN) {
      sendFrame(socket, { t: 'error', code: 'unauthorized', message: 'token mismatch' })
      closeSocket(socket, 4003, 'unauthorized')
      return
    }
    if (state.helloTimer) {
      clearTimeout(state.helloTimer)
      state.helloTimer = null
    }
    state.authed = true
    state.caps = frame.caps
    sendFrame(socket, { t: 'hello.ok', caps: frame.caps })
    if (state.pingTimer) clearInterval(state.pingTimer)
    state.pingTimer = setInterval(() => {
      if (!sendFrame(state.socket, { t: 'ping' })) return
    }, PING_INTERVAL_MS)
    return
  }

  switch (frame.t) {
    case 'tool.result': {
      const entry = state.pending.get(frame.id)
      if (!entry) return
      state.pending.delete(frame.id)
      clearTimeout(entry.timer)
      if (frame.ok === true) entry.resolve(frame.result)
      else entry.reject(Object.assign(new Error(frame.error?.message || '浏览器操作失败'), {
        code: frame.error?.code || 'internal',
      }))
      return
    }
    case 'pong':
      return
    case 'rpc': {
      const method = String(frame.method || '')
      if (method.startsWith('hana.chat.')) {
        void handleChatRpc(socket, frame)
        return
      }
      // 除聊天外的 dsh 网关方法（session.create / settings.* 等）不实现。
      sendFrame(socket, {
        t: 'rpc.result',
        id: frame.id,
        ok: false,
        error: { code: 'unsupported', message: `Hana 未实现 dsh 网关方法 ${method}` },
      })
      return
    }
    case 'respond':
      sendFrame(socket, {
        t: 'respond.result',
        id: frame.id,
        ok: false,
        error: { code: 'unsupported', message: 'Hana 未实现宿主交互通道', details: {} },
      })
      return
    default:
      return
  }
}

// ---------------------------------------------------------------- HTTP

function handleHttp(req, res) {
  const url = req.url || '/'
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Cache-Control': 'no-store',
  }

  if (url.split('?')[0] === BRIDGE_CONFIG_PATH) {
    const body = JSON.stringify({ wsUrl: `ws://127.0.0.1:${state.port}${BRIDGE_PATH}`, host: 'hana' })
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json; charset=utf-8' })
    res.end(body)
    return
  }

  if (url.split('?')[0] === '/ext/status') {
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(status()))
    return
  }

  res.writeHead(404, { ...cors, 'Content-Type': 'text/plain; charset=utf-8' })
  res.end('not found')
}

function handleUpgrade(req, socket) {
  const path = (req.url || '').split('?')[0]
  if (path !== BRIDGE_PATH) {
    socket.destroy()
    return
  }
  const key = req.headers['sec-websocket-key']
  if (!key) {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n')
    socket.destroy()
    return
  }
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n'
    + 'Upgrade: websocket\r\n'
    + 'Connection: Upgrade\r\n'
    + `Sec-WebSocket-Accept: ${wsAccept(key)}\r\n\r\n`,
  )
  attachSocket(socket)
}

// ---------------------------------------------------------------- 启动

function listenOn(server, port) {
  return new Promise((resolve) => {
    const onError = (err) => {
      server.removeListener('listening', onOk)
      resolve({ ok: false, code: err && err.code })
    }
    const onOk = () => {
      server.removeListener('error', onError)
      resolve({ ok: true, port })
    }
    server.once('error', onError)
    server.once('listening', onOk)
    server.listen(port, '127.0.0.1')
  })
}

async function start() {
  if (state.server) return state.port
  const server = http.createServer(handleHttp)
  server.on('upgrade', handleUpgrade)

  for (const port of HANA_PORTS) {
    const result = await listenOn(server, port)
    if (result.ok) {
      state.server = server
      state.port = port
      state.startedAt = new Date().toISOString()
      state.lastError = null
      return port
    }
    if (result.code !== 'EADDRINUSE') {
      state.lastError = `listen failed on ${port}: ${result.code}`
      break
    }
  }
  state.lastError = state.lastError || '所有候选端口都被占用'
  return null
}

export function ensureStarted() {
  if (!readyPromise) readyPromise = start()
  return readyPromise
}

// ---------------------------------------------------------------- 对外接口

/**
 * 请求扩展执行一个浏览器动作。
 * @param {string} name 工具名，同时也是线上的 action 名。
 * @param {Record<string, unknown>} args 工具参数。
 * @param {number} [timeoutMs] 单次预算。
 * @returns {Promise<unknown>} 扩展返回的结果。
 */
export async function callTool(name, args, timeoutMs = DEFAULT_TOOL_TIMEOUT_MS) {
  await ensureStarted()

  const socket = state.socket
  if (!socket || !state.authed) {
    throw Object.assign(new Error('浏览器扩展未连接。请在 Chrome 中打开 Hana Browser 侧边栏或确认扩展已启用。'), {
      code: 'bridge-closed',
    })
  }

  const id = crypto.randomUUID()
  const expiresAt = Date.now() + timeoutMs
  state.toolCalls += 1
  state.lastTool = { name, at: new Date().toISOString(), id }

  const dispatched = sendFrame(socket, { t: 'tool.call', id, name, args, expiresAt })
  if (!dispatched) {
    throw Object.assign(new Error('桥已断开，动作未发送'), { code: 'bridge-closed' })
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      state.pending.delete(id)
      sendFrame(state.socket, { t: 'tool.cancel', id })
      reject(Object.assign(new Error(`浏览器操作超时（${timeoutMs}ms）：${name}`), { code: 'timeout' }))
    }, timeoutMs)
    state.pending.set(id, { resolve, reject, timer, name })
  })
}

/** 当前桥与连接的快照，供诊断工具使用。 */
export function status() {
  return {
    listening: Boolean(state.server),
    port: state.port,
    startedAt: state.startedAt,
    connected: Boolean(state.socket) && state.authed,
    connectionSeq: state.connectSeq,
    caps: state.caps,
    pendingCalls: state.pending.size,
    totalToolCalls: state.toolCalls,
    lastTool: state.lastTool,
    lastError: state.lastError,
    tokenRequired: Boolean(EXPECTED_TOKEN),
    ports: HANA_PORTS,
    chat: chatStatus(),
  }
}

/**
 * 处理侧边栏聊天请求。方法名前缀 hana.chat.
 * @param {import('node:net').Socket} socket
 * @param {object} frame
 */
async function handleChatRpc(socket, frame) {
  const payload = frame.payload && typeof frame.payload === 'object' ? frame.payload : {}
  try {
    let result
    if (frame.method === 'hana.chat.send') {
      result = await sendChat(payload.tabId, String(payload.text || ''), { title: payload.title })
    } else if (frame.method === 'hana.chat.history') {
      result = await readChat(payload.tabId)
    } else if (frame.method === 'hana.chat.abort') {
      result = await abortChat(payload.tabId)
    } else if (frame.method === 'hana.chat.reset') {
      result = resetChat(payload.tabId)
    } else {
      throw Object.assign(new Error(`unknown chat method ${frame.method}`), { code: 'bad-method' })
    }
    sendFrame(socket, { t: 'rpc.result', id: frame.id, ok: true, result })
  } catch (error) {
    sendFrame(socket, {
      t: 'rpc.result',
      id: frame.id,
      ok: false,
      error: { code: error?.code || 'internal', message: String(error?.message || error) },
    })
  }
}

/**
 * 关闭桥并释放端口。插件卸载时必须调，否则下一次加载会因端口占用漂到候选端口。
 */
export async function closeBridge() {
  if (state.pingTimer) {
    clearInterval(state.pingTimer)
    state.pingTimer = null
  }
  if (state.helloTimer) {
    clearTimeout(state.helloTimer)
    state.helloTimer = null
  }
  settleAllPending('bridge-closed', '插件已卸载')
  const socket = state.socket
  state.socket = null
  state.authed = false
  if (socket && !socket.destroyed) {
    try {
      closeSocket(socket, 1001, 'plugin unloaded')
    } catch {
      /* 已经断开 */
    }
  }
  const server = state.server
  state.server = null
  state.port = null
  readyPromise = null
  if (!server) return
  await new Promise((resolve) => {
    server.close(() => resolve())
    setTimeout(resolve, 1500)
  })
}

/**
 * 把聊天事件推给已连接的扩展。
 * @param {object} payload
 */
export function broadcastChat(payload) {
  const socket = state.socket
  if (!socket || !state.authed) return
  sendFrame(socket, { t: 'event', frame: { rpcId: '', method: 'hana.chat', payload } })
}

/** 把扩展返回的任意形状归一成 `{ text }`。 */
export function normalizeTextResult(result, name) {
  if (result && typeof result === 'object' && typeof result.text === 'string') {
    return { text: result.text }
  }
  return { text: `${name} 未返回文本：${JSON.stringify(result)}` }
}

/** Hana 工具统一返回单条文本。 */
export function textContent(text) {
  return { content: [{ type: 'text', text }] }
}

/**
 * 工具统一执行入口：把异常收敛成模型可读的文本，而不是让整次调用失败。
 * @param {string} name 工具名。
 * @param {Record<string, unknown>} args 参数。
 * @param {number} [timeoutMs] 预算。
 */
export async function runTool(name, args = {}, timeoutMs) {
  try {
    const result = await callTool(name, args, timeoutMs)
    return textContent(normalizeTextResult(result, name).text)
  } catch (error) {
    const code = (error && error.code) || 'error'
    const message = (error && error.message) || String(error)
    const hint = code === 'bridge-closed'
      ? '\n\n提示：扩展需要在 Chrome 里保持一个已连接的面板，或确认扩展已启用且桥地址指向 Hana 的端口。'
      : code === 'action-failed'
        ? '\n\n提示：页面上的编号可能已过期，重新调用 browser_snapshot 取新编号。'
        : ''
    return textContent(`[${code}] ${message}${hint}`)
  }
}

export { DEFAULT_SNAPSHOT_MAX_CHARS, DEFAULT_MAX_INTERACTIVE_ITEMS }
