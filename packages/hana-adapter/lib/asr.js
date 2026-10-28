/**
 * 识别引擎层：把「一段 wav」变成「一段文字」，不带任何常驻进程。
 *
 * 这里是整个功能唯一需要换的东西。上层只认 `transcribe()`，它返回
 * `{ text, engine, elapsedMs }`，别的什么都不管。想换模型，改配置；
 * 想换引擎类型，改 `engine` 字段；想接云端，把 engine 换成 http 指向远端。
 *
 * 两种引擎形态：
 * - `cli`：每次调用拉起一个进程，跑完就退。零常驻、零端口、零管理。
 *   代价是每次重新加载模型，SenseVoice int8 大约 1–2 秒。
 * - `http`：指向一个 OpenAI 兼容的 `/v1/audio/transcriptions`，
 *   适合已经在跑 funasr-server 之类服务的情况。想省那 1–2 秒冷启动时用。
 *
 * @module
 */

import { spawn } from 'node:child_process'
import fsp from 'node:fs/promises'
import path from 'node:path'

/** 配置默认值。所有路径都支持 {dataDir} / {pluginDir} 占位符。 */
export const DEFAULT_CONFIG = {
  asr: {
    engine: 'cli',
    command: [
      '{python}',
      '{pluginDir}/asr/sensevoice_oneshot.py',
      '--model', '{modelDir}',
      '--input', '{input}',
      '--language', '{language}',
      '--threads', '{threads}',
    ],
    output: 'stdout',
    python: 'python',
    modelDir: '{dataDir}/models/sensevoice',
    language: 'zh',
    threads: 4,
    timeoutMs: 1_200_000,
    http: {
      url: 'http://127.0.0.1:8000/v1',
      model: 'sensevoice',
      apiKey: '',
      timeoutMs: 1_800_000,
    },
  },
  ffmpeg: {
    path: '',
    timeoutMs: 300_000,
  },
  cache: {
    keepAudio: false,
  },
}

/** 同一时刻只跑一个识别进程：多开会互相抢核，反而更吵。 */
let queue = Promise.resolve()

function shallowMerge(base, override) {
  const out = { ...base }
  for (const [key, value] of Object.entries(override || {})) {
    if (value && typeof value === 'object' && !Array.isArray(value) && base[key] && typeof base[key] === 'object') {
      out[key] = shallowMerge(base[key], value)
    } else if (value !== undefined) {
      out[key] = value
    }
  }
  return out
}

/**
 * 读插件配置。优先宿主 ctx.config，其次 dataDir/config.json，最后默认值。
 * @param {{ config?: any, dataDir?: string, pluginDir?: string }} ctx
 */
export async function loadConfig(ctx) {
  let fromHost = null
  try {
    if (ctx?.config && typeof ctx.config === 'object') {
      fromHost = typeof ctx.config.get === 'function'
        ? await ctx.config.get()
        : (typeof ctx.config.values === 'object' ? ctx.config.values : ctx.config)
    }
  } catch {
    fromHost = null
  }

  let fromFile = null
  let fileExists = false
  const filePath = ctx?.dataDir ? path.join(ctx.dataDir, 'config.json') : null
  if (filePath) {
    try {
      fromFile = JSON.parse(await fsp.readFile(filePath, 'utf8'))
      fileExists = true
    } catch {
      fromFile = null
    }
  }

  const merged = shallowMerge(DEFAULT_CONFIG, fromHost || {})
  const config = shallowMerge(merged, fromFile || {})
  return { config, sources: { host: Boolean(fromHost), file: fileExists, filePath } }
}

/**
 * 展开命令里的占位符。未知占位符原样保留，方便排查配置写错。
 * @param {string[]} parts
 * @param {Record<string, string|number>} vars
 */
function expand(parts, vars) {
  return parts.map((part) => String(part).replace(/\{(\w+)\}/g, (whole, key) => (
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : whole
  )))
}

/** 把 `"a b" c` 这种字符串拆成参数数组，配置里写字符串也能用。 */
function splitCommand(command) {
  if (Array.isArray(command)) return command.map(String)
  const out = []
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g
  let match
  while ((match = pattern.exec(String(command || '')))) {
    out.push(match[1] ?? match[2] ?? match[3])
  }
  return out
}

function runProcess(command, args, { cwd, timeoutMs, env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    let settled = false

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        child.kill('SIGKILL')
      } catch {
        /* 已经退出 */
      }
      reject(Object.assign(new Error(`识别进程超时（${Math.round(timeoutMs / 1000)} 秒）`), { code: 'asr-timeout' }))
    }, timeoutMs)

    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString('utf8')
      if (stdout.length > 4_000_000) stdout = stdout.slice(-4_000_000)
    })
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString('utf8')
      if (stderr.length > 200_000) stderr = stderr.slice(-200_000)
    })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(Object.assign(new Error(`无法启动识别进程：${error.message}`), { code: 'asr-spawn' }))
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code !== 0) {
        const reason = stderr.trim().split('\n').slice(-3).join(' ').trim()
        reject(Object.assign(new Error(`识别进程退出码 ${code}${reason ? `：${reason}` : ''}`), {
          code: 'asr-exit',
          stderr,
        }))
        return
      }
      resolve({ stdout, stderr })
    })
  })
}

/** 把引擎输出归一成纯文本。 */
function normalizeCliOutput(stdout, mode, outputPath) {
  if (mode === 'json-stdout') {
    const parsed = JSON.parse(stdout)
    const text = parsed?.text ?? parsed?.result ?? parsed?.data?.text
    if (typeof text !== 'string') throw Object.assign(new Error('json-stdout 输出里没有 text 字段'), { code: 'asr-parse' })
    return text.trim()
  }
  if (mode === 'file') {
    return fsp.readFile(outputPath, 'utf8').then((text) => text.trim())
  }
  return Promise.resolve(stdout.trim())
}

/**
 * 走 OpenAI 兼容的 HTTP 接口。给已经在跑服务的人用，插件本身不启动服务。
 */
async function transcribeHttp({ wavPath, language, settings }) {
  const url = `${String(settings.url).replace(/\/+$/, '')}/audio/transcriptions`
  const bytes = await fsp.readFile(wavPath)
  const form = new FormData()
  form.set('model', String(settings.model || 'sensevoice'))
  form.set('file', new Blob([bytes], { type: 'audio/wav' }), path.basename(wavPath))
  if (language && language !== 'auto') form.set('language', language)

  const headers = {}
  if (settings.apiKey) headers.Authorization = `Bearer ${settings.apiKey}`

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: form,
    signal: AbortSignal.timeout(Number(settings.timeoutMs) || 1_800_000),
  })
  const raw = await res.text()
  if (!res.ok) {
    throw Object.assign(new Error(`ASR 服务返回 HTTP ${res.status}：${raw.slice(0, 300)}`), { code: 'asr-http' })
  }
  let text = ''
  try {
    const json = JSON.parse(raw)
    text = String(json.text ?? json.result ?? '').trim()
  } catch {
    text = raw.trim()
  }
  if (!text) throw Object.assign(new Error('ASR 服务返回空文本'), { code: 'asr-empty' })
  return text
}

/**
 * 转写一个 wav 文件。并发被限制为 1，调用方不用自己排队。
 * @param {{ wavPath: string, language?: string, ctx?: any, config?: any }} options
 * @returns {Promise<{ text: string, engine: string, elapsedMs: number }>}
 */
export async function transcribe({ wavPath, language, ctx, config }) {
  const settings = config?.asr || DEFAULT_CONFIG.asr
  const engine = String(settings.engine || 'cli').toLowerCase()

  const task = queue.then(async () => {
    const startedAt = Date.now()
    if (engine === 'http') {
      const text = await transcribeHttp({ wavPath, language: language || settings.language, settings: settings.http || {} })
      return { text, engine: 'http', elapsedMs: Date.now() - startedAt }
    }

    const vars = {
      input: wavPath,
      language: language || settings.language || 'zh',
      threads: settings.threads || 4,
      modelDir: String(settings.modelDir || '')
        .replace(/\{dataDir\}/g, ctx?.dataDir || '.')
        .replace(/\{pluginDir\}/g, ctx?.pluginDir || '.'),
      dataDir: ctx?.dataDir || '.',
      pluginDir: ctx?.pluginDir || '.',
      python: settings.python || 'python',
      output: path.join(path.dirname(wavPath), `${path.basename(wavPath, path.extname(wavPath))}.out.txt`),
    }

    const argv = expand(splitCommand(settings.command), vars)
    if (!argv.length) throw Object.assign(new Error('识别命令是空的，检查配置里的 asr.command'), { code: 'asr-config' })

    const [command, ...args] = argv
    const { stdout, stderr } = await runProcess(command, args, {
      cwd: ctx?.dataDir,
      timeoutMs: Number(settings.timeoutMs) || 1_200_000,
      env: {
        // 把线程数钉死，避免引擎自己吃掉所有核。这是「不打扰」的关键一环。
        OMP_NUM_THREADS: String(vars.threads),
        MKL_NUM_THREADS: String(vars.threads),
        OPENBLAS_NUM_THREADS: String(vars.threads),
        TOKENIZERS_PARALLELISM: 'false',
        PYTHONIOENCODING: 'utf-8',
        PYTHONUNBUFFERED: '1',
      },
    })

    const text = await normalizeCliOutput(stdout, String(settings.output || 'stdout'), vars.output)
    if (!text) {
      const hint = stderr.trim().split('\n').slice(-2).join(' ').trim()
      throw Object.assign(new Error(`识别结果为空${hint ? `：${hint}` : ''}`), { code: 'asr-empty' })
    }
    return { text, engine: 'cli', elapsedMs: Date.now() - startedAt }
  })

  // 队列只保证顺序，不让失败把后面的调用堵死。
  queue = task.catch(() => undefined)
  return task
}

function wordsAfter(argv, flag, fallback) {
  const index = argv.indexOf(flag)
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback
}

/**
 * 环境自检。给工具在失败时用，也让用户在动手前知道缺什么。
 * @param {{ ctx?: any, config?: any }} options
 */
export async function probe({ ctx, config }) {
  const settings = config?.asr || DEFAULT_CONFIG.asr
  const report = {
    engine: String(settings.engine || 'cli'),
    ready: false,
    problems: [],
    notes: [],
  }

  if (report.engine === 'http') {
    const url = `${String(settings.http?.url || '').replace(/\/+$/, '')}/audio/transcriptions`
    try {
      const res = await fetch(url, { method: 'OPTIONS', signal: AbortSignal.timeout(3_000) })
      report.ready = res.status < 500
      if (!report.ready) report.problems.push(`ASR 服务返回 HTTP ${res.status}`)
    } catch (error) {
      report.problems.push(`连不上 ASR 服务 ${url}：${error.message}`)
    }
    return report
  }

  const argv = expand(splitCommand(settings.command), {
    input: 'x.wav',
    language: settings.language || 'zh',
    threads: settings.threads || 4,
    modelDir: String(settings.modelDir || '')
      .replace(/\{dataDir\}/g, ctx?.dataDir || '.')
      .replace(/\{pluginDir\}/g, ctx?.pluginDir || '.'),
    dataDir: ctx?.dataDir || '.',
    pluginDir: ctx?.pluginDir || '.',
    python: settings.python || 'python',
    output: 'x.out.txt',
  })
  report.command = argv.join(' ')
  report.notes.push('命令行从配置展开，实际能否跑通要看你装了没')

  const modelDir = wordsAfter(argv, '--model', '')
  if (modelDir) {
    try {
      const stat = await fsp.stat(modelDir)
      if (!stat.isDirectory()) report.problems.push(`模型路径不是目录：${modelDir}`)
    } catch {
      report.problems.push(`模型目录不存在：${modelDir}`)
    }
  }

  const script = argv.find((item) => item.endsWith('.py'))
  if (script) {
    try {
      await fsp.access(script)
    } catch {
      report.problems.push(`识别脚本不存在：${script}`)
    }
  }

  report.ready = report.problems.length === 0
  return report
}
