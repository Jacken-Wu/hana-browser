/**
 * 音频转码：把 B 站的 m4s（AAC in fMP4）变成识别引擎能吃的 16k 单声道 WAV。
 *
 * 为什么不让插件自己做：Node 里没有可靠的 AAC 解码器，WebAudio 只在浏览器里，
 * 而解码 1 小时音频到 Float32 要几百 MB 内存。交给 ffmpeg 是最省事也最省内存的路。
 *
 * @module
 */

import { execFile } from 'node:child_process'
import fsp from 'node:fs/promises'
import path from 'node:path'

/** 常见安装位置，PATH 里没有时按顺序找。 */
const FFMPEG_CANDIDATES = {
  win32: [
    'ffmpeg.exe',
    'C:\\ffmpeg\\bin\\ffmpeg.exe',
    'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe',
    'D:\\ffmpeg\\bin\\ffmpeg.exe',
    'C:\\ProgramData\\chocolatey\\bin\\ffmpeg.exe',
    'D:\\files\\chocolatey\\bin\\ffmpeg.exe',
    `${process.env.USERPROFILE || ''}\\scoop\\shims\\ffmpeg.exe`,
  ],
  darwin: ['ffmpeg', '/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg'],
  linux: ['ffmpeg', '/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg'],
}

function run(command, args, { timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const reason = String(stderr || error.message || '').split('\n').slice(-4).join(' ').trim()
        reject(Object.assign(new Error(reason || 'ffmpeg 执行失败'), { code: 'ffmpeg-failed', stdout, stderr }))
        return
      }
      resolve({ stdout, stderr })
    })
  })
}

/**
 * 确认 ffmpeg 可用，返回可执行路径。
 * @param {string} [configured] 配置里指定的路径。
 */
export async function resolveFfmpeg(configured) {
  const candidates = configured
    ? [configured]
    : (FFMPEG_CANDIDATES[process.platform] || ['ffmpeg'])
  for (const candidate of candidates) {
    try {
      await run(candidate, ['-version'], { timeoutMs: 8_000 })
      return candidate
    } catch {
      /* 换下一个 */
    }
  }
  throw Object.assign(
    new Error('没找到 ffmpeg。装一个并加进 PATH，或在插件配置里写 ffmpeg.path。'),
    { code: 'ffmpeg-missing' },
  )
}

/**
 * 转成 16 kHz 单声道 PCM WAV。识别引擎基本都吃这个格式。
 * @param {{ ffmpeg: string, input: string, output: string, timeoutMs?: number }} options
 */
export async function toWav({ ffmpeg, input, output, timeoutMs }) {
  await fsp.mkdir(path.dirname(output), { recursive: true })
  await run(
    ffmpeg,
    [
      '-hide_banner',
      '-loglevel', 'error',
      '-y',
      '-i', input,
      '-vn',
      '-ac', '1',
      '-ar', '16000',
      '-c:a', 'pcm_s16le',
      output,
    ],
    { timeoutMs: timeoutMs || 300_000 },
  )
  const stat = await fsp.stat(output)
  if (stat.size < 1024) {
    throw Object.assign(new Error('转码结果为空，源音频可能损坏'), { code: 'ffmpeg-empty' })
  }
  return { path: output, bytes: stat.size }
}
