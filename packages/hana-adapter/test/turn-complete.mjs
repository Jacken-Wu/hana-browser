/**
 * 一轮对话何时算结束：纯函数，不联网、不需要宿主。
 *
 * 这个判断错过两次，症状都是「第一段回复显示了，第二段要刷新才出现」。
 * 第二次错在消息形状：`session:history` 返回的不是会话文件里的块数组，
 * 而是宿主拍平过的 { content: '字符串', thinking, toolCalls }。
 * 所以这里按真实形状造用例，不按文件形状。
 *
 * 运行：node packages/hana-adapter/test/turn-complete.mjs
 */

import assert from 'node:assert/strict'
import { isTurnComplete } from '../lib/chat-session.js'

let passed = 0
function check(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ok  ${name}`)
  } catch (error) {
    console.error(`  FAIL ${name}`)
    console.error(`       ${error.message}`)
    process.exitCode = 1
  }
}

const user = (text) => ({ role: 'user', content: text })
const assistant = (extra) => ({ role: 'assistant', content: '', ...extra })

console.log('isTurnComplete')

check('空历史不算结束', () => {
  assert.equal(isTurnComplete([]), false)
})

check('最后一条是用户消息', () => {
  assert.equal(isTurnComplete([user('总结这个视频')]), false)
})

check('助理说了话 → 结束', () => {
  assert.equal(isTurnComplete([user('x'), assistant({ content: '说完了' })]), true)
})

check('助理带工具调用 → 没结束', () => {
  const messages = [
    user('总结这个视频'),
    assistant({ content: '开始转写', thinking: '先取文稿', toolCalls: [{ name: 'browser_video_transcript' }] }),
  ]
  assert.equal(isTurnComplete(messages), false)
})

check('工具返回后、模型还没写正文 → 没结束', () => {
  const messages = [
    user('总结这个视频'),
    assistant({ content: '开始转写', toolCalls: [{ name: 'browser_video_transcript' }] }),
    assistant({ content: '', thinking: '收到文稿，组织一下' }),
  ]
  assert.equal(isTurnComplete(messages), false)
})

check('工具返回后写了正文 → 结束', () => {
  const messages = [
    user('总结这个视频'),
    assistant({ content: '开始转写', toolCalls: [{ name: 'browser_video_transcript' }] }),
    assistant({ content: '总结如下…' }),
  ]
  assert.equal(isTurnComplete(messages), true)
})

check('空的 toolCalls 数组不算挂起', () => {
  assert.equal(isTurnComplete([assistant({ content: '说完了', toolCalls: [] })]), true)
})

console.log(`\n${passed} 项通过${process.exitCode ? '，有失败项' : ''}`)
