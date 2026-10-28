import fsp from 'node:fs/promises'
import path from 'node:path'

import { getHostContext } from '../lib/host.js'
import { broadcastChat, callTool, textContent } from '../lib/bridge-core.js'
import { downloadAudio, hasFile, parseVideoRef, resolveAudioUrl, resolveVideo } from '../lib/bilibili.js'
import { resolveFfmpeg, toWav } from '../lib/audio.js'
import { loadConfig, probe, transcribe } from '../lib/asr.js'

export const name = 'browser_video_transcript'

export const description = [
  '把 B 站视频的音频在本地转成文字稿，用于总结、检索或引用。',
  '流程：取 DASH 音频 → ffmpeg 转 16k wav → 本地识别引擎转写（无常驻服务，跑完即退）。',
  '1 小时视频大约 3 到 6 分钟；同一视频第二次调用直接读缓存，秒回。',
  '不传 url 时，自动从当前浏览器里已打开的 B 站视频标签页取。',
  '返回正文可能被截断，完整文稿路径写在返回头里，需要全文时按 offset 分段读取。',
].join(' ')

export const parameters = {
  type: 'object',
  properties: {
    url: {
      type: 'string',
      description: 'B 站视频链接、BV 号或 av 号。省略则从当前打开的 B 站标签页里找。',
    },
    page: {
      type: 'number',
      description: '分 P 序号，从 1 开始。省略时取链接里的 ?p= 或第 1 P。',
    },
    language: {
      type: 'string',
      description: '语言代码，默认 zh。识别引擎支持多语言时用得上。',
    },
    force: {
      type: 'boolean',
      description: '为 true 时忽略已缓存的文稿，重新转写。',
    },
    maxChars: {
      type: 'number',
      description: '返回正文的字符上限，默认 24000。超出时返回头尾并指向完整文件。',
    },
    probe: {
      type: 'boolean',
      description: '只做环境自检（ffmpeg、模型、脚本是否就位），不真正转写。',
    },
  },
}

const DEFAULT_MAX_CHARS = 24_000

function fail(code, message) {
  return Object.assign(new Error(message), { code })
}

function progress(tabId, stage, detail) {
  if (!tabId) return
  try {
    broadcastChat({ kind: 'progress', tabId, stage, detail })
  } catch {
    /* 面板不认这个事件也无所谓 */
  }
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}

function formatElapsed(ms) {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds} 秒`
  return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`
}

/**
 * 从标签页文本里抠出 B 站视频链接。扩展返回的是包了一层的 JSON，
 * 这里不依赖它的格式稳定性，直接按 BV 号找。
 */
async function findBilibiliTab() {
  let result
  try {
    result = await callTool('browser_list_tabs', {})
  } catch (error) {
    throw fail('no-url', `没有传 url，且读不到浏览器标签页（${error.message}）。请直接把视频链接传进来。`)
  }
  const text = typeof result?.text === 'string' ? result.text : JSON.stringify(result)
  if (!/bilibili\.com\/video/i.test(text) && !/BV[0-9A-Za-z]{10}/.test(text)) {
    throw fail('no-url', '没有传 url，当前打开的标签页里也没找到 B 站视频。请直接传链接。')
  }

  // 优先激活中的标签页
  const activeMatch = text.match(/"active":\s*true[\s\S]{0,400}?"url":\s*"([^"]+)"/)
  const anyMatch = text.match(/"url":\s*"((?:https?:\/\/)[^"]*bilibili\.com\/video[^"]*)"/i)
  const candidate = activeMatch?.[1]?.includes('bilibili') ? activeMatch[1] : anyMatch?.[1]
  if (!candidate) throw fail('no-url', '找到了 B 站标签页但没解析出链接，请直接传 url。')

  const tabIdMatch = text.match(/"tabId":\s*(\d+)[\s\S]{0,300}?"url":\s*"([^"]*bilibili\.com\/video[^"]*)"/i)
  return { url: candidate, tabId: tabIdMatch ? Number(tabIdMatch[1]) : null }
}

/** 缓存目录：dataDir 下，插件更新不会覆盖。 */
async function ensureCacheDir(ctx) {
  const base = ctx?.dataDir
  if (!base) throw fail('no-data-dir', '插件数据目录不可用，无法缓存音频和文稿')
  const dir = path.join(base, 'video-cache')
  await fsp.mkdir(dir, { recursive: true })
  return dir
}

function cacheKey(video) {
  return `${video.bvid}${video.page > 1 ? `-p${video.page}` : ''}`
}

async function readCachedTranscript(cacheDir, key) {
  try {
    const text = await fsp.readFile(path.join(cacheDir, `${key}.txt`), 'utf8')
    const meta = JSON.parse(await fsp.readFile(path.join(cacheDir, `${key}.json`), 'utf8'))
    return { text, meta }
  } catch {
    return null
  }
}

function truncate(text, maxChars) {
  if (text.length <= maxChars) return { body: text, truncated: false }
  const head = Math.floor(maxChars * 0.7)
  const tail = maxChars - head
  return {
    body: `${text.slice(0, head)}\n\n…（中间省略 ${text.length - maxChars} 字，完整文稿见上面的路径）…\n\n${text.slice(-tail)}`,
    truncated: true,
  }
}

export async function execute(input = {}) {
  const ctx = getHostContext()
  const { config, sources } = await loadConfig(ctx)

  if (input.probe === true) {
    const report = await probe({ ctx, config })
    const ffmpeg = await resolveFfmpeg(config.ffmpeg?.path).catch((error) => ({ error: error.message }))
    const lines = [
      `引擎：${report.engine}`,
      typeof ffmpeg === 'string' ? `ffmpeg：${ffmpeg}` : `ffmpeg：${ffmpeg.error}`,
      report.command ? `命令：${report.command}` : null,
      report.ready && typeof ffmpeg === 'string' ? '状态：就绪' : '状态：还不能跑',
      ...report.problems.map((item) => `问题：${item}`),
      ...report.notes.map((item) => `说明：${item}`),
      sources.filePath
        ? `配置文件：${sources.filePath}${sources.file ? '' : '（尚未创建，当前用默认值）'}`
        : null,
    ].filter(Boolean)
    return textContent(lines.join('\n'))
  }

  let tabId = null
  try {
    let sourceUrl = input.url
    if (!sourceUrl) {
      const found = await findBilibiliTab()
      sourceUrl = found.url
      tabId = found.tabId
    }

    const ref = parseVideoRef(sourceUrl)
    if (input.page) ref.page = Number(input.page)

    progress(tabId, 'resolve', '解析视频信息')
    const video = await resolveVideo(ref)
    const key = cacheKey(video)
    const cacheDir = await ensureCacheDir(ctx)

    const cached = input.force ? null : await readCachedTranscript(cacheDir, key)
    if (cached) {
      const { body, truncated } = truncate(cached.text, Number(input.maxChars) || DEFAULT_MAX_CHARS)
      return textContent([
        `[视频] ${video.title}`,
        video.pageCount > 1 ? `[分 P] 第 ${video.page}/${video.pageCount} P ${video.partTitle}` : null,
        `[时长] ${formatDuration(video.duration)}　[UP 主] ${video.owner || '未知'}`,
        `[字幕] 命中缓存 · ${cached.meta?.engine || 'local'} · 转写于 ${cached.meta?.createdAt || '未知时间'}`,
        `[全文] ${cached.text.length} 字${truncated ? '（本次只返回头尾）' : ''}`,
        `[文稿] ${path.join(cacheDir, `${key}.txt`)}`,
        '',
        body,
      ].filter((line) => line !== null).join('\n'))
    }

    progress(tabId, 'audio', '解析音频地址')
    const audio = await resolveAudioUrl(video)
    const audioPath = path.join(cacheDir, `${key}.m4s`)

    let audioBytes = 0
    if (await hasFile(audioPath)) {
      const stat = await fsp.stat(audioPath)
      audioBytes = stat.size
    } else {
      progress(tabId, 'download', '下载音频')
      const downloaded = await downloadAudio(audio.url, audioPath, { backups: audio.backups })
      audioBytes = downloaded.bytes
    }

    progress(tabId, 'decode', '转码为 16k wav')
    const ffmpeg = await resolveFfmpeg(config.ffmpeg?.path)
    const wavPath = path.join(cacheDir, `${key}.16k.wav`)
    await toWav({
      ffmpeg,
      input: audioPath,
      output: wavPath,
      timeoutMs: config.ffmpeg?.timeoutMs,
    })

    progress(tabId, 'asr', '本地转写中')
    const startedAt = Date.now()
    const result = await transcribe({
      wavPath,
      language: input.language || config.asr?.language,
      ctx,
      config,
    })

    const createdAt = new Date().toISOString()
    const meta = {
      bvid: video.bvid,
      page: video.page,
      cid: video.cid,
      title: video.title,
      owner: video.owner,
      duration: video.duration,
      engine: result.engine,
      elapsedMs: result.elapsedMs,
      audioBytes,
      chars: result.text.length,
      createdAt,
    }

    await fsp.writeFile(path.join(cacheDir, `${key}.txt`), result.text, 'utf8')
    await fsp.writeFile(path.join(cacheDir, `${key}.json`), JSON.stringify(meta, null, 2), 'utf8')
    if (!config.cache?.keepAudio) {
      await fsp.rm(audioPath, { force: true })
      await fsp.rm(wavPath, { force: true })
    }

    progress(tabId, 'done', `转写完成，${formatElapsed(Date.now() - startedAt)}`)

    const { body, truncated } = truncate(result.text, Number(input.maxChars) || DEFAULT_MAX_CHARS)
    return textContent([
      `[视频] ${video.title}`,
      video.pageCount > 1 ? `[分 P] 第 ${video.page}/${video.pageCount} P ${video.partTitle}` : null,
      `[时长] ${formatDuration(video.duration)}　[UP 主] ${video.owner || '未知'}`,
      `[字幕] 本地转写 · ${result.engine} · 用时 ${formatElapsed(result.elapsedMs)}`,
      `[全文] ${result.text.length} 字${truncated ? '（本次只返回头尾）' : ''}`,
      `[文稿] ${path.join(cacheDir, `${key}.txt`)}`,
      '',
      body,
    ].filter((line) => line !== null).join('\n'))
  } catch (error) {
    const code = error?.code || 'error'
    const message = error?.message || String(error)
    const hint = code === 'ffmpeg-missing'
      ? '\n\n装一个 ffmpeg 并加进 PATH，或在配置文件里写 ffmpeg.path。'
      : code === 'asr-spawn' || code === 'asr-exit'
        ? '\n\n识别引擎没起来。用 probe: true 调一次本工具，看具体缺什么。'
        : code === 'no-url'
          ? '\n\n把 B 站视频链接直接作为 url 参数传进来最稳。'
          : ''
    return textContent(`[${code}] ${message}${hint}`)
  }
}
