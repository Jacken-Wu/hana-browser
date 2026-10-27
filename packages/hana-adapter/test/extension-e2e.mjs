/**
 * 端到端验证：真 Edge + 真扩展 + 本脚本当桥。
 *
 * 验证链路：扩展自动发现并连接桥 → tool.call 抵达扩展 → 扩展在真实标签页执行
 * → tool.result 回到桥。不依赖 Hana 插件安装，也不依赖侧边栏。
 *
 * 运行：node packages/hana-adapter/test/extension-e2e.mjs
 */

import { rmSync, mkdirSync, existsSync } from 'node:fs'
import { ensureStarted, status, callTool } from '../lib/bridge.js'

const PLAYWRIGHT = 'file:///D:/files/projects/nodejs/hana-browser/node_modules/.pnpm/playwright-core@1.62.1/node_modules/playwright-core/index.mjs'
const EXT = 'D:\\files\\projects\\nodejs\\hana-browser\\extensions\\dsh-browser\\dist'
const PROFILE = 'D:\\files\\temp_files\\OH-Works\\temp\\edge-ext-profile'

if (!existsSync(EXT)) {
  console.error('扩展产物不存在，先运行构建:', EXT)
  process.exit(1)
}

const { chromium } = await import(PLAYWRIGHT)

rmSync(PROFILE, { recursive: true, force: true })
mkdirSync(PROFILE, { recursive: true })

const port = await ensureStarted()
console.log(`桥监听: 127.0.0.1:${port}`)

const ctx = await chromium.launchPersistentContext(PROFILE, {
  channel: 'msedge',
  headless: false,
  args: [
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=DisableLoadExtensionCommandLineSwitch',
  ],
})

ctx.on('serviceworker', (worker) => console.log(`service worker: ${worker.url()}`))

let sw = ctx.serviceWorkers()[0]
if (!sw) {
  try {
    sw = await ctx.waitForEvent('serviceworker', { timeout: 20_000 })
  } catch {
    /* 扩展没起来 */
  }
}
console.log(`扩展 SW: ${sw ? sw.url() : '未启动'}`)

const waitUntil = Date.now() + 25_000
while (Date.now() < waitUntil && !status().connected) {
  await new Promise((resolve) => setTimeout(resolve, 500))
}
const connected = status().connected
console.log(`扩展已连接桥: ${connected}`)
if (!connected) {
  console.log('诊断:', JSON.stringify(status(), null, 2))
  await ctx.close()
  process.exit(1)
}

const page = await ctx.newPage()
await page.goto('https://example.com', { waitUntil: 'domcontentloaded' })
await new Promise((resolve) => setTimeout(resolve, 1200))
console.log(`页面: ${await page.title()} @ ${page.url()}`)

async function attempt(name, args) {
  try {
    const result = await callTool(name, args, 30_000)
    const text = typeof result?.text === 'string' ? result.text : JSON.stringify(result)
    console.log(`\n--- ${name} OK (${text.length} chars) ---`)
    console.log(text.slice(0, 900))
    return true
  } catch (error) {
    console.log(`\n--- ${name} FAILED: [${error.code}] ${error.message} ---`)
    return false
  }
}

const snapOk = await attempt('browser_snapshot', {})
const listOk = await attempt('browser_list_tabs', {})
const navOk = await attempt('browser_navigate', { url: 'https://example.com/' })
const waitOk = await attempt('browser_wait', { ms: 500 })
const deltaOk = await attempt('browser_snapshot', { delta: true })

console.log('\n=== 汇总 ===')
console.log(`snapshot: ${snapOk ? 'OK' : 'FAIL'}`)
console.log(`list_tabs: ${listOk ? 'OK' : 'FAIL'}`)
console.log(`navigate(写操作): ${navOk ? 'OK' : 'FAIL'}`)
console.log(`wait: ${waitOk ? 'OK' : 'FAIL'}`)
console.log(`delta snapshot: ${deltaOk ? 'OK' : 'FAIL'}`)

await ctx.close()
process.exit(snapOk && listOk && navOk ? 0 : 1)
