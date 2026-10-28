/**
 * 视频转写链路的离线自检：不联网、不启动浏览器、不需要 ffmpeg。
 *
 * 覆盖两件事：
 * 1. 各种写法的视频链接能被认出来（用户粘什么都有可能）。
 * 2. 转写脚本和 lib 文件确实在包里，防止打包时漏掉。
 *
 * 联网部分（取流 → 转码 → 识别）不在这里跑，见 README 的手动验证步骤。
 *
 * 运行：node packages/hana-adapter/test/video-transcript-smoke.mjs
 */

import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseVideoRef } from '../lib/bilibili.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.dirname(here)

let passed = 0
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1
      console.log(`  ok  ${name}`)
    })
    .catch((error) => {
      console.error(`  FAIL ${name}`)
      console.error(`       ${error.message}`)
      process.exitCode = 1
    })
}

console.log('parseVideoRef')

await check('标准链接', () => {
  assert.deepEqual(parseVideoRef('https://www.bilibili.com/video/BV1GJ411x7h7'), { bvid: 'BV1GJ411x7h7', page: 1 })
})

await check('带查询串和分 P', () => {
  const ref = parseVideoRef('https://www.bilibili.com/video/BV1GJ411x7h7/?spm_id_from=333.999&p=3')
  assert.equal(ref.bvid, 'BV1GJ411x7h7')
  assert.equal(ref.page, 3)
})

await check('手机端短链', () => {
  assert.equal(parseVideoRef('https://b23.tv/BV1GJ411x7h7').bvid, 'BV1GJ411x7h7')
})

await check('裸 BV 号', () => {
  assert.equal(parseVideoRef('BV1GJ411x7h7').bvid, 'BV1GJ411x7h7')
})

await check('av 号', () => {
  assert.deepEqual(parseVideoRef('https://www.bilibili.com/video/av80433022'), { aid: 80433022, page: 1 })
})

await check('认不出来要报错', () => {
  assert.throws(() => parseVideoRef('https://example.com/hello'), /无法从/)
})

console.log('包内文件')

await check('识别脚本存在', async () => {
  await fsp.access(path.join(root, 'asr', 'sensevoice_oneshot.py'))
})

await check('工具与 lib 存在', async () => {
  for (const file of ['tools/video-transcript.js', 'lib/bilibili.js', 'lib/audio.js', 'lib/asr.js']) {
    await fsp.access(path.join(root, file))
  }
})

console.log(`\n${passed} 项通过${process.exitCode ? '，有失败项' : ''}`)
