/**
 * Hana 侧边栏：贴着当前页面问问题。
 *
 * 每个标签页对应一个 plugin_private 会话，主窗口的 Hana 看不到这里，
 * 这里也看不到主窗口。
 *
 * 标签页归属是显式的：切换标签页后面板不会偷偷跟着走，而是问一句
 * 「跟随新页面 / 保持原页面」，跟你确认之后才切。
 *
 * 走 background 已有的 rpc 通道（type: 'rpc'），方法名统一 hana.chat.*。
 * 回复由桥以 event 帧（method: 'hana.chat'）推回来。
 */

const els = {
  dot: document.getElementById('dot'),
  status: document.getElementById('status'),
  pagebar: document.getElementById('pagebar'),
  banner: document.getElementById('banner'),
  bannertext: document.getElementById('bannertext'),
  follow: document.getElementById('follow'),
  stay: document.getElementById('stay'),
  newchat: document.getElementById('newchat'),
  messages: document.getElementById('messages'),
  quote: document.getElementById('quote'),
  quotelabel: document.getElementById('quotelabel'),
  quotetext: document.getElementById('quotetext'),
  quoteclear: document.getElementById('quoteclear'),
  input: document.getElementById('input'),
  send: document.getElementById('send'),
}

const state = {
  boundTabId: null,
  boundTitle: '',
  pendingTab: null,
  dismissedTabId: null,
  connected: false,
  sending: false,
  messages: [],
  selection: null,
}

const pending = new Map()
let port = null

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * 行内标记。输入必须已经转义过。
 * @param {string} text
 */
function renderInline(text) {
  let out = text
  // 行内代码先抽出来，避免内部星号被当成强调
  const codes = []
  out = out.replace(/`([^`]+)`/g, (_, code) => {
    codes.push(code)
    return `\u0000CODE${codes.length - 1}\u0000`
  })
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  out = out.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
  out = out.replace(/\[([^\]]+)\]\(((?:[^()]|\([^()]*\))*)\)/g, (whole, label, href) => {
    const decoded = href.replace(/&amp;/g, '&')
    if (!/^https?:\/\//i.test(decoded)) return label
    return `<a href="${href}" target="_blank" rel="noreferrer noopener">${label}</a>`
  })
  out = out.replace(/\u0000CODE(\d+)\u0000/g, (_, index) => `<code>${codes[Number(index)]}</code>`)
  return out
}

/**
 * 把模型输出的 markdown 转成 HTML。先整体转义，再逐行认结构，
 * 所以页面注入的标签只会显示成文字，不会被执行。
 * @param {string} text
 */
function renderMarkdown(text) {
  const source = String(text ?? '').replace(/\r\n?/g, '\n')
  const lines = source.split('\n')
  const out = []
  let index = 0
  let inCode = false
  let codeBuf = []
  let listBuf = []
  let listTag = null

  const flushList = () => {
    if (listBuf.length === 0) return
    const tag = listTag === 'ol' ? 'ol' : 'ul'
    out.push(`<${tag}>${listBuf.map((item) => `<li>${renderInline(escapeHtml(item))}</li>`).join('')}</${tag}>`)
    listBuf = []
    listTag = null
  }

  while (index < lines.length) {
    const line = lines[index]

    if (/^\s*```/.test(line)) {
      if (!inCode) {
        flushList()
        inCode = true
        codeBuf = []
        index += 1
        continue
      }
      out.push(`<pre><code>${escapeHtml(codeBuf.join('\n'))}</code></pre>`)
      inCode = false
      codeBuf = []
      index += 1
      continue
    }
    if (inCode) {
      codeBuf.push(line)
      index += 1
      continue
    }

    if (line.trim() === '') {
      flushList()
      index += 1
      continue
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/)
    if (heading) {
      flushList()
      const level = Math.min(heading[1].length + 2, 6)
      out.push(`<h${level}>${renderInline(escapeHtml(heading[2]))}</h${level}>`)
      index += 1
      continue
    }

    const quote = line.match(/^>\s?(.*)$/)
    if (quote) {
      flushList()
      out.push(`<blockquote>${renderInline(escapeHtml(quote[1]))}</blockquote>`)
      index += 1
      continue
    }

    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) {
      flushList()
      out.push('<hr>')
      index += 1
      continue
    }

    const ordered = line.match(/^\s*\d+\.\s+(.*)$/)
    const unordered = line.match(/^\s*[-*+]\s+(.*)$/)
    if (ordered || unordered) {
      const tag = ordered ? 'ol' : 'ul'
      if (listTag && listTag !== tag) flushList()
      listTag = tag
      listBuf.push(ordered ? ordered[1] : unordered[1])
      index += 1
      continue
    }

    flushList()
    out.push(`<p>${renderInline(escapeHtml(line))}</p>`)
    index += 1
  }

  if (inCode && codeBuf.length > 0) {
    out.push(`<pre><code>${escapeHtml(codeBuf.join('\n'))}</code></pre>`)
  }
  flushList()
  return out.join('')
}

function setStatus(kind, text) {
  els.dot.className = `dot ${kind}`
  els.status.textContent = text
}

function updatePagebar() {
  els.pagebar.textContent = state.boundTitle || '未绑定页面'
  els.pagebar.title = state.boundTitle || ''
}

function syncSendButton() {
  els.send.disabled = state.sending || state.boundTabId === null || !els.input.value.trim()
}

function render() {
  const visible = state.messages.filter((m) => m && (m.text || m.mood))
  if (visible.length === 0 && !state.sending) {
    els.messages.innerHTML = '<div class="empty">在这里问关于当前页面的事。<br />对话走独立会话，不打扰主窗口。</div>'
    return
  }
  const parts = visible.map((m) => {
    if (m.role === 'assistant') {
      const blocks = []
      if (m.thinking) {
        blocks.push(`<details class="mood"><summary>思考过程</summary><div class="mood-body">${escapeHtml(m.thinking)}</div></details>`)
      }
      if (m.mood) {
        blocks.push(`<details class="mood"><summary>内心</summary><div class="mood-body">${escapeHtml(m.mood)}</div></details>`)
      }
      if (m.text) blocks.push(`<div class="body">${renderMarkdown(m.text)}</div>`)
      return `<div class="msg assistant">${blocks.join('')}</div>`
    }
    return `<div class="msg ${m.role}">${escapeHtml(m.text)}</div>`
  })
  if (state.sending) parts.push('<div class="thinking">思考中…</div>')
  els.messages.innerHTML = parts.join('')
  els.messages.scrollTop = els.messages.scrollHeight
}

function request(method, payload, onDone) {
  if (!port) {
    onDone?.(null, { message: '后台未连接' })
    return
  }
  const id = `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  pending.set(id, onDone)
  try {
    port.postMessage({ type: 'rpc', id, method, payload })
  } catch (error) {
    pending.delete(id)
    onDone?.(null, { message: String(error && error.message ? error.message : error) })
  }
}

function finishTurn() {
  state.sending = false
  render()
  syncSendButton()
}

function renderQuote() {
  const selection = state.selection
  if (!selection || !selection.text) {
    els.quote.classList.remove('show')
    return
  }
  els.quotelabel.textContent = selection.title ? `选中自「${selection.title}」` : '选中内容'
  els.quotetext.textContent = selection.text + (selection.truncated ? '…' : '')
  els.quote.classList.add('show')
}

function applySelection(selection) {
  if (!selection || typeof selection.text !== 'string' || !selection.text.trim()) {
    state.selection = null
  } else {
    state.selection = {
      text: selection.text,
      title: typeof selection.title === 'string' ? selection.title : '',
      url: typeof selection.url === 'string' ? selection.url : '',
      truncated: selection.truncated === true,
    }
  }
  renderQuote()
}

/**
 * 提醒 background 引用已被消费，避免切回来又浮出旧引用。
 * @param {object|null} selection
 */
function releaseSelection(selection) {
  if (!selection || !port) return
  try {
    port.postMessage({ type: 'selection.clear', selection })
  } catch {
    /* 端口已断，后台会自己清理 */
  }
}

/**
 * 把选中内容拼成引用块。界面气泡仍只显示用户自己写的那句话。
 * @param {string} text
 * @param {object|null} selection
 */
function composeText(text, selection) {
  if (!selection || !selection.text) return text
  const quoted = selection.text.split('\n').map((line) => `> ${line}`).join('\n')
  const source = selection.title
    ? `（以下是用户在网页上选中的内容，来自《${selection.title}》）\n`
    : '（以下是用户在网页上选中的内容）\n'
  return `${source}${quoted}\n\n${text}`
}

function onMessage(message) {
  if (!message || typeof message !== 'object') return

  if (message.type === 'status') {
    state.connected = message.state === 'connected'
    const kind = state.connected ? 'ok' : message.state === 'reconnecting' ? 'pending' : 'bad'
    setStatus(kind, state.connected ? '已连接' : message.state === 'reconnecting' ? '重连中' : '未连接')
    return
  }

  if (message.type === 'selection') {
    applySelection(message.selection)
    return
  }

  if (message.type === 'rpc.result') {
    const done = pending.get(message.id)
    if (!done) return
    pending.delete(message.id)
    if (message.ok) done(message.result, null)
    else done(null, message.error || { message: '未知错误' })
    return
  }

  if (message.type === 'event') {
    // background 转发的是整个 ServerFrame：
    // { t: 'event', frame: { rpcId, method, payload } }
    const serverFrame = message.frame
    if (!serverFrame || serverFrame.t !== 'event') return
    const inner = serverFrame.frame
    if (!inner || inner.method !== 'hana.chat') return
    const payload = inner.payload || {}
    if (String(payload.tabId) !== String(state.boundTabId)) return

    if (payload.kind === 'reply') {
      state.messages.push({
        role: 'assistant',
        text: payload.text || '',
        mood: payload.mood || null,
        thinking: payload.thinking || '',
      })
      render()
      return
    }
    if (payload.kind === 'empty') {
      state.messages.push({ role: 'system', text: '这一轮没有文字回复' })
      render()
      return
    }
    if (payload.kind === 'done') {
      finishTurn()
      return
    }
    if (payload.kind === 'timeout') {
      state.messages.push({ role: 'system', text: '等太久了，回复可能还在路上' })
      finishTurn()
      return
    }
  }
}

async function currentTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
    if (!tab || typeof tab.id !== 'number') return null
    return { id: tab.id, title: tab.title || tab.url || '' }
  } catch {
    return null
  }
}

/**
 * 重新向 background 要一次当前窗口的选区。
 * 面板开着但文字是之前划的，光靠 selectionchange 事件可能已经错过。
 */
async function refreshSelection() {
  try {
    const win = await chrome.windows.getCurrent()
    if (win && typeof win.id === 'number' && port) {
      port.postMessage({ type: 'panel.window', windowId: win.id })
    }
  } catch {
    /* 窗口不可读就跳过 */
  }
}

function showBanner(tab) {
  state.pendingTab = tab
  els.bannertext.textContent = `页面已切换到「${tab.title || '新页面'}」，要继续聊原来的页面吗？`
  els.banner.classList.add('show')
}

function hideBanner() {
  state.pendingTab = null
  els.banner.classList.remove('show')
}

function loadHistory() {
  return new Promise((resolve) => {
    if (state.boundTabId === null) {
      state.messages = []
      render()
      resolve()
      return
    }
    request('hana.chat.history', { tabId: state.boundTabId }, (result, error) => {
      state.messages = error || !result || !Array.isArray(result.messages)
        ? []
        : result.messages
            .filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
            .map((m) => ({
              role: m.role,
              text: m.text || '',
              mood: m.mood || null,
              thinking: m.thinking || '',
            }))
      render()
      resolve()
    })
  })
}

function send() {
  const text = els.input.value.trim()
  if (!text || state.sending || state.boundTabId === null) return

  els.input.value = ''
  els.input.style.height = ''
  state.messages.push({ role: 'user', text })
  state.sending = true
  render()
  syncSendButton()

  const outgoing = composeText(text, state.selection)
  if (state.selection) {
    releaseSelection(state.selection)
    state.selection = null
    renderQuote()
  }

  request(
    'hana.chat.send',
    { tabId: state.boundTabId, text: outgoing, title: state.boundTitle },
    (_result, error) => {
      if (!error) return
      state.messages.push({ role: 'system', text: `发送失败：${error.message || '未知错误'}` })
      finishTurn()
    },
  )
}

els.input.addEventListener('focus', () => {
  void refreshSelection()
})

els.input.addEventListener('input', () => {
  els.input.style.height = 'auto'
  els.input.style.height = `${Math.min(els.input.scrollHeight, 120)}px`
  syncSendButton()
})

els.input.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
  event.preventDefault()
  send()
})

els.send.addEventListener('click', send)

els.quoteclear.addEventListener('click', () => {
  releaseSelection(state.selection)
  state.selection = null
  renderQuote()
})

els.follow.addEventListener('click', () => {
  const tab = state.pendingTab
  if (!tab) return
  hideBanner()
  state.boundTabId = tab.id
  state.boundTitle = tab.title
  state.dismissedTabId = null
  updatePagebar()
  state.messages = []
  render()
  void loadHistory()
})

els.stay.addEventListener('click', () => {
  state.dismissedTabId = state.pendingTab ? state.pendingTab.id : null
  hideBanner()
})

els.newchat.addEventListener('click', () => {
  if (state.boundTabId === null) return
  request('hana.chat.reset', { tabId: state.boundTabId }, () => {
    state.messages = []
    state.sending = false
    render()
    syncSendButton()
  })
})

chrome.tabs.onActivated.addListener(() => {
  void (async () => {
    const tab = await currentTab()
    if (!tab) return
    if (tab.id === state.boundTabId) {
      hideBanner()
      state.dismissedTabId = null
      return
    }
    if (tab.id === state.dismissedTabId) return
    showBanner(tab)
  })()
})

function boot() {
  try {
    port = chrome.runtime.connect({ name: 'dsh-panel' })
    port.onMessage.addListener(onMessage)
    port.onDisconnect.addListener(() => {
      port = null
      setStatus('bad', '后台已断开')
      syncSendButton()
    })
  } catch (error) {
    setStatus('bad', `无法连接后台：${error && error.message ? error.message : error}`)
    return
  }
  setStatus('pending', '连接中…')
  void (async () => {
    // 必须先把自己的窗口告诉 background：它靠这个判断是否有面板能显示引用，
    // 进而决定要不要让 content script 监听页面选区。
    try {
      const win = await chrome.windows.getCurrent()
      if (win && typeof win.id === 'number') {
        port.postMessage({ type: 'panel.window', windowId: win.id })
      }
    } catch {
      /* 窗口不可读就跳过，只影响选中文本 */
    }

    const tab = await currentTab()
    if (tab) {
      state.boundTabId = tab.id
      state.boundTitle = tab.title
    }
    updatePagebar()
    syncSendButton()
    await loadHistory()
  })()
}

boot()
