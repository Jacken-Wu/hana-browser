/**
 * 桥的自验脚本：不依赖 Hana、不依赖扩展，用一个内置 WebSocket 客户端
 * 扮演扩展，走一遍 hello → tool.call → tool.result 的完整回路。
 *
 * 运行：node packages/hana-adapter/test/bridge-smoke.mjs
 */

import { ensureStarted, callTool, status } from '../lib/bridge-core.js'

const problems = []

function fail(message) {
  problems.push(message)
  console.error(`FAIL ${message}`)
}

function ok(message) {
  console.log(`ok   ${message}`)
}

await ensureStarted()
const snapshot = status()
if (!snapshot.listening) {
  console.error('桥没起来:', snapshot.lastError)
  process.exit(1)
}
ok(`监听 127.0.0.1:${snapshot.port}`)

const url = `ws://127.0.0.1:${snapshot.port}/ext/bridge`
const ws = new WebSocket(url)
const seen = { helloOk: false, toolCall: null }
let autoReply = true

ws.addEventListener('open', () => {
  ws.send(JSON.stringify({
    t: 'hello',
    token: '',
    caps: { textOnly: true, snapshotMaxChars: 32000, maxInteractiveItems: 60 },
  }))
})

ws.addEventListener('message', (event) => {
  const frame = JSON.parse(String(event.data))
  if (frame.t === 'hello.ok') {
    seen.helloOk = true
    ok('收到 hello.ok')
    return
  }
  if (frame.t === 'ping') {
    ws.send(JSON.stringify({ t: 'pong' }))
    return
  }
  if (frame.t === 'tool.call') {
    seen.toolCall = frame
    ok(`收到 tool.call name=${frame.name} args=${JSON.stringify(frame.args)}`)
    if (!autoReply) return
    ws.send(JSON.stringify({
      t: 'tool.result',
      id: frame.id,
      ok: true,
      result: { text: `FAKE_SNAPSHOT_FOR_${frame.name}` },
    }))
    return
  }
})

ws.addEventListener('error', (error) => {
  fail(`socket error: ${error.message ?? error}`)
})

await new Promise((resolve) => setTimeout(resolve, 400))

if (!seen.helloOk) fail('没收到 hello.ok')

const text = await callTool('browser_snapshot', { delta: true })
const expected = 'FAKE_SNAPSHOT_FOR_browser_snapshot'
if (text?.text === expected) ok(`callTool 拿到正确结果: ${text.text}`)
else fail(`callTool 结果不对: ${JSON.stringify(text)}`)

if (seen.toolCall?.name === 'browser_snapshot') ok('tool.call 名称正确')
else fail(`tool.call 名称不对: ${seen.toolCall?.name}`)

if (seen.toolCall?.args?.delta === true) ok('参数透传正确')
else fail(`参数透传不对: ${JSON.stringify(seen.toolCall?.args)}`)

// 错误路径：扩展回 ok:false
autoReply = false
let caught = null
const second = callTool('browser_click', { index: 3 }).catch((error) => { caught = error })
await new Promise((resolve) => setTimeout(resolve, 250))
ws.send(JSON.stringify({
  t: 'tool.result',
  id: 'definitely-not-a-real-id',
  ok: false,
  error: { code: 'internal', message: 'should be ignored' },
}))
await new Promise((resolve) => setTimeout(resolve, 100))
const realId = status().lastTool?.id
ws.send(JSON.stringify({
  t: 'tool.result',
  id: realId,
  ok: false,
  error: { code: 'action-failed', message: 'stale index' },
}))
await second
if (caught?.code === 'action-failed') ok('错误路径正确透传 code')
else fail(`错误路径不对: ${caught?.code} / ${caught?.message}`)

// rpc 通道应被明确拒绝
const rpcReply = await new Promise((resolve) => {
  const listener = (event) => {
    const frame = JSON.parse(String(event.data))
    if (frame.t === 'rpc.result') {
      ws.removeEventListener('message', listener)
      resolve(frame)
    }
  }
  ws.addEventListener('message', listener)
  ws.send(JSON.stringify({ t: 'rpc', id: 'rpc-1', method: 'session.list', payload: {} }))
  setTimeout(() => resolve(null), 1500)
})
if (rpcReply?.ok === false && rpcReply.error?.code === 'unsupported') ok('rpc 通道返回 unsupported')
else fail(`rpc 通道行为不对: ${JSON.stringify(rpcReply)}`)

ws.close()

console.log('')
if (problems.length === 0) {
  console.log('全部通过')
  process.exit(0)
}
console.log(`${problems.length} 项失败`)
process.exit(1)
