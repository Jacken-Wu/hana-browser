/**
 * B 站取流：把一个播放页链接变成磁盘上的音频文件。
 *
 * 这一层只碰网络和文件，不碰浏览器，也不碰 ASR。桥接断开时它照样能用，
 * 因为 Referer 是插件自己加的头，不依赖页面上下文。
 *
 * 实测约束（见 README「视频总结」一节）：
 * - DASH 音频地址必须带 `Referer: https://www.bilibili.com/`，否则 CDN 返回 403。
 * - 地址里带 deadline 签名，约两小时过期，所以每次都要现取，不能缓存 URL。
 * - m4s 是自包含 fMP4（ftyp/moov/moof/mdat），ffmpeg 或 PyAV 能直接解码。
 *
 * @module
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

/**
 * B 站接口的 UA 陷阱：带完整 Chrome UA 反而会被风控拦（实测 412 request was banned），
 * 短 UA 或不带 UA 都是 200。这里故意用最短的那个。
 */
const UA = 'Mozilla/5.0'

const API_HEADERS = {
  'User-Agent': UA,
  Referer: 'https://www.bilibili.com/',
}

/** 音频码率档位。30216≈64k / 30232≈132k / 30280≈192k，语音识别用最低档足够。 */
const AUDIO_QUALITY_PREFERENCE = [30216, 30232, 30280]

/** 单次接口请求预算。 */
const API_TIMEOUT_MS = 15_000

function fail(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra })
}

/**
 * 带超时的 JSON 请求。B 站接口超时很常见，失败一次就重试一次。
 * @param {string} url
 * @param {{ retries?: number }} [options]
 */
async function getJson(url, { retries = 1 } = {}) {
  let lastError
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const res = await fetch(url, {
        headers: API_HEADERS,
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      })
      if (!res.ok) throw fail('bilibili-http', `B 站接口返回 HTTP ${res.status}`)
      const json = await res.json()
      if (json && typeof json.code === 'number' && json.code !== 0) {
        throw fail('bilibili-api', `B 站接口报错 ${json.code}：${json.message || '未知错误'}`)
      }
      return json?.data ?? json
    } catch (error) {
      lastError = error
      if (attempt === retries) break
      await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)))
    }
  }
  throw lastError
}

/**
 * 从链接、BV 号、av 号里解析出视频标识。
 * @param {string} input
 * @returns {{ bvid?: string, aid?: number, page: number }}
 */
export function parseVideoRef(input) {
  const raw = String(input || '').trim()
  if (!raw) throw fail('bad-input', '没有拿到视频链接或 BV 号')

  const bv = raw.match(/BV[0-9A-Za-z]{10}/)
  if (bv) {
    const page = raw.match(/[?&]p=(\d+)/)
    return { bvid: bv[0], page: page ? Number(page[1]) : 1 }
  }
  const av = raw.match(/av(\d+)/i)
  if (av) {
    const page = raw.match(/[?&]p=(\d+)/)
    return { aid: Number(av[1]), page: page ? Number(page[1]) : 1 }
  }
  throw fail('bad-input', `无法从「${raw.slice(0, 80)}」里认出 BV 号或 av 号`)
}

/**
 * 取视频元信息，顺带把 cid 定位到具体的分 P。
 * @param {{ bvid?: string, aid?: number, page: number }} ref
 */
export async function resolveVideo(ref) {
  const query = ref.bvid ? `bvid=${ref.bvid}` : `aid=${ref.aid}`
  const view = await getJson(`https://api.bilibili.com/x/web-interface/view?${query}`)

  const pages = Array.isArray(view.pages) ? view.pages : []
  const page = Math.min(Math.max(ref.page || 1, 1), Math.max(pages.length, 1))
  const target = pages[page - 1]
  const cid = target?.cid ?? view.cid
  if (!cid) throw fail('bilibili-api', '没有拿到 cid，无法定位音频流')

  return {
    aid: view.aid,
    bvid: view.bvid,
    cid,
    page,
    pageCount: pages.length || 1,
    partTitle: target?.part || '',
    title: view.title || '',
    owner: view.owner?.name || '',
    duration: target?.duration ?? view.duration ?? 0,
    cover: view.pic || '',
  }
}

/**
 * 解析 DASH 音频流地址。优先最低码率，语音识别用不上高码率。
 * @param {{ aid: number, bvid: string, cid: number }} video
 */
export async function resolveAudioUrl(video) {
  // fnval=4048 同时要 DASH 与全部编码；部分视频只认 16，失败再降级试一次。
  const attempts = [4048, 16]
  let lastError
  for (const fnval of attempts) {
    try {
      const url = `https://api.bilibili.com/x/player/playurl?bvid=${video.bvid}&cid=${video.cid}&fnval=${fnval}&fourk=1`
      const data = await getJson(url)
      const audios = Array.isArray(data?.dash?.audio) ? data.dash.audio : []
      if (!audios.length) throw fail('no-audio', '这个视频没有返回 DASH 音频轨，可能是番剧或需要登录的内容')

      const sorted = [...audios].sort((a, b) => {
        const ia = AUDIO_QUALITY_PREFERENCE.indexOf(a.id)
        const ib = AUDIO_QUALITY_PREFERENCE.indexOf(b.id)
        return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib)
      })
      const picked = sorted[0]
      const primary = picked.baseUrl || picked.base_url
      if (!primary) throw fail('no-audio', '音频轨没有可用地址')
      return {
        url: primary,
        backups: [picked.backupUrl, picked.backup_url_2].flat().filter(Boolean),
        quality: picked.id,
        bandwidth: picked.bandwidth,
        mime: picked.mimeType || 'audio/mp4',
      }
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}

/**
 * 把音频流落到磁盘。CDN 要求 Referer，缺了就 403（实测定过）。
 * @param {string} url
 * @param {string} destPath
 * @param {{ backups?: string[], onProgress?: (received: number, total: number) => void }} [options]
 */
export async function downloadAudio(url, destPath, options = {}) {
  const candidates = [url, ...(options.backups || [])]
  let lastError

  for (const candidate of candidates) {
    try {
      const res = await fetch(candidate, {
        headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' },
        signal: AbortSignal.timeout(180_000),
      })
      if (!res.ok || !res.body) throw fail('bilibili-cdn', `音频下载失败：HTTP ${res.status}`)

      const total = Number(res.headers.get('content-length') || 0)
      let received = 0
      const source = Readable.fromWeb(res.body)
      // 用 Transform 计数，不要给源流挂 'data' 监听：那会把流切成 flowing 模式，
      // 和 pipe 抢数据，实测会丢尾部几十 KB，m4s 就废了。
      const counter = new Transform({
        transform(chunk, _enc, callback) {
          received += chunk.length
          if (typeof options.onProgress === 'function') {
            try {
              options.onProgress(received, total)
            } catch {
              /* 进度回调不能打断下载 */
            }
          }
          callback(null, chunk)
        },
      })
      await fsp.mkdir(path.dirname(destPath), { recursive: true })
      await pipeline(source, counter, fs.createWriteStream(destPath))
      const stat = await fsp.stat(destPath)
      if (stat.size < 1024) throw fail('bilibili-cdn', '音频文件过小，可能被 CDN 拦了')
      if (total > 0 && stat.size !== total) {
        throw fail('bilibili-cdn', `音频下载不完整（${stat.size}/${total} 字节）`)
      }
      return { bytes: stat.size, path: destPath }
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}

/**
 * 判断本地是否已经有这个视频的原始音频。
 * @param {string} filePath
 */
export async function hasFile(filePath) {
  try {
    const stat = await fsp.stat(filePath)
    return stat.size > 1024
  } catch {
    return false
  }
}
