// Clawkie website: sign in / register, device approval, dashboard. No framework; decrypted text only ever goes into textContent.
import { fingerprint, newKey, openMsg, sealMsg, seal, unseal, wrapFor } from './crypto.js'

const $ = s => document.querySelector(s)
async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw Object.assign(new Error(data.error?.message ?? data.error ?? data.message ?? `request failed (${res.status})`), { status: res.status, code: data.code })
  return data
}
const session = () => api('/api/auth/get-session').catch(() => null)
const toLogin = () => location.replace('/login?next=' + encodeURIComponent(location.pathname + location.search))
const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e }
const ago = ts => { const m = Math.round((Date.now() - ts) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago` }
const safeNext = n => (n && n.startsWith('/') && !n.startsWith('//') ? n : '/dashboard')

// The account key lives only in this browser (and on signed-in machines), per user
const keyName = id => `clawkie-key-${id}`
const getKey = id => { try { return localStorage.getItem(keyName(id)) } catch { return null } }
const setKey = (id, k) => { try { localStorage.setItem(keyName(id), k) } catch {} }

// ---------- sign in / register / forgot / reset
async function authPage() {
  const mode = location.pathname.slice(1) || 'login'
  const params = new URLSearchParams(location.search)
  const next = safeNext(params.get('next'))
  const titles = { login: 'Sign in', register: 'Create your account', forgot: 'Reset your password', reset: 'Choose a new password' }
  const buttons = { login: 'Sign in', register: 'Create account', forgot: 'Send reset link', reset: 'Save password' }
  document.title = `${titles[mode]} · Clawkie`
  $('#title').textContent = titles[mode]
  $('#submit').textContent = buttons[mode]
  for (const e of document.querySelectorAll('[data-modes]')) {
    const on = e.dataset.modes.split(' ').includes(mode)
    e.hidden = !on
    for (const i of e.querySelectorAll('input')) i.disabled = !on
  }
  if (mode === 'register') $('#password').autocomplete = 'new-password'
  if (mode === 'reset') $('#password').autocomplete = 'new-password'
  if (params.get('error')) $('#error').textContent = 'That link is invalid or expired.'
  if (mode === 'login' && (await session())) return location.replace(next)

  $('#form').addEventListener('submit', async ev => {
    ev.preventDefault()
    $('#error').textContent = $('#success').textContent = ''
    const email = $('#email').value.trim(), password = $('#password').value
    $('#submit').disabled = true
    try {
      if (mode === 'login') {
        await api('/api/auth/sign-in/email', { email, password })
        return location.replace(next)
      }
      if (mode === 'register') {
        if (password.length < 8) throw new Error('Use at least 8 characters for the password.')
        await api('/api/auth/sign-up/email', { name: $('#name').value.trim() || email.split('@')[0], email, password, callbackURL: next })
        $('#form').reset()
        $('#success').textContent = `Check ${email} for a link to verify your email. It signs you in.`
      }
      if (mode === 'forgot') {
        await api('/api/auth/request-password-reset', { email, redirectTo: '/reset' })
        $('#success').textContent = 'If that email has an account, a reset link is on its way.'
      }
      if (mode === 'reset') {
        await api('/api/auth/reset-password', { newPassword: password, token: params.get('token') })
        $('#success').textContent = 'Password saved. You can sign in now.'
        setTimeout(() => location.replace('/login'), 1200)
      }
    } catch (e) {
      if (e.code === 'EMAIL_NOT_VERIFIED') {
        await api('/api/auth/send-verification-email', { email, callbackURL: next }).catch(() => {})
        $('#error').textContent = 'Verify your email first. We just sent you a new link.'
      } else $('#error').textContent = e.message
    } finally { $('#submit').disabled = false }
  })
}

// ---------- approve a /clawkie:login
async function devicePage() {
  if (!(await session())) return toLogin()
  const me = await api('/api/me')
  const code = new URLSearchParams(location.search).get('code')
  if (code) $('#code').value = code
  $('#form').addEventListener('submit', async ev => {
    ev.preventDefault()
    $('#error').textContent = $('#success').textContent = ''
    $('#submit').disabled = true
    try {
      const userCode = $('#code').value.trim().toUpperCase().replace(/^([A-Z]{4})([A-Z]{4})$/, '$1-$2')
      const info = await api('/api/device/info', { user_code: userCode })
      let key = getKey(me.user_id)
      if (key && me.kfp && (await fingerprint(key)) !== me.kfp) key = null
      if (!key) {
        // First machine on the account: this browser creates the key. Otherwise it must already hold it.
        if (me.kfp) throw new Error('This browser doesn\'t have your account key. Approve from the browser you used before, or run /clawkie:dashboard on a signed-in machine to open the dashboard here first.')
        key = newKey()
      }
      $('#device').hidden = false
      $('#device').textContent = `Machine: ${info.label || 'unknown'}`
      await api('/api/device/approve', { user_code: userCode, wrapped: await wrapFor(info.pub, key), kfp: await fingerprint(key) })
      setKey(me.user_id, key)
      $('#success').textContent = 'Approved. Go back to your terminal: Claude Code signs in by itself in a few seconds.'
      $('#submit').hidden = true
    } catch (e) { $('#error').textContent = e.message } finally { $('#submit').disabled = false }
  })
}

// ---------- dashboard
async function dashboardPage() {
  const s = await session()
  if (!s) return toLogin()
  const me = await api('/api/me')
  $('#email').textContent = me.email
  $('#signout').onclick = async () => { await api('/api/auth/sign-out', {}); location.replace('/') }

  // /clawkie:dashboard hands over the key in the #fragment, which never reaches the server
  const frag = new URLSearchParams(location.hash.slice(1)).get('k')
  if (frag) {
    history.replaceState(null, '', location.pathname)
    if (!me.kfp || (await fingerprint(frag)) === me.kfp) setKey(me.user_id, frag)
  }
  let key = getKey(me.user_id)
  if (key && me.kfp && (await fingerprint(key)) !== me.kfp) key = null
  $('#nokey').hidden = !!key || !me.kfp

  const cache = new Map() // ciphertext -> plaintext
  const dec = async c => { if (!c) return ''; if (!key) return '🔒 encrypted'; if (!cache.has(c)) cache.set(c, (await unseal(c, key)) ?? '[unreadable]'); return cache.get(c) }
  const decMsg = async m => { const k = 'm' + m.text; if (!key) return '🔒 encrypted'; if (!cache.has(k)) cache.set(k, (await openMsg(m, key)) ?? '[unreadable: not sealed with your account key]'); return cache.get(k) }

  let selected = 'all', tab = 'notes', state = null
  for (const b of document.querySelectorAll('[data-tab]')) b.onclick = () => {
    tab = b.dataset.tab
    for (const x of document.querySelectorAll('[data-tab]')) x.setAttribute('aria-selected', x === b)
    for (const p of document.querySelectorAll('[data-panel]')) p.hidden = p.dataset.panel !== tab
  }

  async function renderSessions() {
    const items = [{ name: 'all', label: 'All sessions', meta: `${state.sessions.filter(x => x.online).length} online` }]
    for (const x of state.sessions) items.push({ ...x, label: x.name, path: await dec(x.cwd), meta: (await dec(x.status)) || `seen ${ago(x.seen)}` })
    $('#sessions').replaceChildren(...items.map(x => {
      const btn = el('button', { className: 'sess', type: 'button', onclick: () => { selected = x.name; refresh() } },
        el('span', { className: 'dot ' + (x.name === 'all' || x.online ? 'dot-online' : 'dot-offline'), title: x.online ? 'online' : 'offline' }),
        el('b', { textContent: x.label }),
        x.name === 'all' ? el('span') : el('span', { className: 'small muted', textContent: x.online ? 'online' : ago(x.seen) }),
        ...(x.path ? [el('span', { className: 'project', textContent: x.path.split(/[\\/]/).filter(Boolean).pop() || x.path, title: x.path }),
          el('span', { className: 'path', textContent: '\u200E' + x.path + '\u200E', title: x.path })] : []),
        el('span', { className: 'meta', textContent: x.meta, title: x.meta }))
      btn.setAttribute('aria-current', x.name === selected)
      return el('li', {}, btn)
    }))
  }

  async function renderThread() {
    $('#thread-title').textContent = selected === 'all' ? 'All messages' : `Conversation with ${selected}`
    $('#text').placeholder = `Message ${selected === 'all' ? 'all sessions' : selected}… (⌘/Ctrl+Enter to send)`
    const { history } = await api('/api/history', { limit: 100, ...(selected !== 'all' && { peer: selected }) })
    const t = $('#thread'), atBottom = t.scrollHeight - t.scrollTop - t.clientHeight < 40
    const rows = []
    for (const m of history) rows.push(el('div', { className: 'msg' + (m.from_name === 'web' ? ' mine' : '') },
      el('div', { className: 'head', textContent: `${m.from_name === 'web' ? 'you (web)' : m.from_name} → ${m.to_name === 'web' ? 'you' : m.to_name} · ${ago(m.ts)}` }),
      el('div', { className: 'body', textContent: await decMsg(m) })))
    if (!rows.length) rows.push(el('p', { className: 'muted', textContent: 'No messages yet.' }))
    t.replaceChildren(...rows)
    if (atBottom || !t.dataset.seen) { t.scrollTop = t.scrollHeight; t.dataset.seen = 1 }
  }

  async function renderPanels() {
    const notes = []
    for (const n of state.notes) notes.push(el('li', { className: 'item' },
      el('div', {}, el('div', { className: 'body', textContent: await dec(n.text) }), el('div', { className: 'small muted', textContent: `${n.author} · ${ago(n.ts)}` })),
      el('button', { className: 'btn btn-sm', textContent: 'Delete', onclick: async () => { await api('/api/forget', { id: n.id }); refresh() } })))
    $('#notes').replaceChildren(...(notes.length ? notes : [el('li', { className: 'muted', textContent: 'No shared notes yet.' })]))
    const hand = []
    for (const h of state.handoffs) hand.push(el('li', { className: 'item' }, el('details', {},
      el('summary', { textContent: `${h.name} · ${ago(h.ts)}` }), el('div', { className: 'body', textContent: await dec(h.summary) }))))
    $('#handoffs').replaceChildren(...(hand.length ? hand : [el('li', { className: 'muted', textContent: 'No handoffs yet.' })]))
    $('#devices').replaceChildren(...(state.devices.length ? state.devices.map(d => el('li', { className: 'item' },
      el('div', {}, el('b', { textContent: d.label || 'machine' }), el('div', { className: 'small muted', textContent: `signed in ${ago(d.created)} · seen ${ago(d.seen)}` })),
      el('button', { className: 'btn btn-sm btn-danger', textContent: 'Sign out', onclick: async () => { if (confirm(`Sign out ${d.label}? Its sessions stop working until it runs /clawkie:login again.`)) { await api('/api/revoke', { id: d.id }); refresh() } } }))) : [el('li', { className: 'muted', textContent: 'No machines yet.' })]))
  }

  let busy = false
  async function refresh() {
    if (busy) return
    busy = true
    try {
      state = await api('/api/state')
      $('#empty').hidden = state.devices.length > 0
      if (selected !== 'all' && !state.sessions.some(x => x.name === selected)) selected = 'all'
      await renderSessions()
      await renderThread()
      await renderPanels()
    } catch (e) { if (e.status === 401) return toLogin() } finally { busy = false }
  }

  $('#composer').addEventListener('submit', async ev => {
    ev.preventDefault()
    const text = $('#text').value.trim()
    $('#send-error').textContent = ''
    if (!text) return
    if (!key) return ($('#send-error').textContent = 'This browser needs your account key to send. Run /clawkie:dashboard in a signed-in session.')
    try {
      await api('/api/send', { to: selected, text: await sealMsg(selected, text, key) })
      $('#text').value = ''
      $('#thread').dataset.seen = ''
      refresh()
    } catch (e) { $('#send-error').textContent = e.message }
  })
  $('#text').addEventListener('keydown', e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) $('#composer').requestSubmit() })
  $('#note-form').addEventListener('submit', async ev => {
    ev.preventDefault()
    const text = $('#note').value.trim()
    if (!text || !key) return
    await api('/api/remember', { text: await seal(text, key) })
    $('#note').value = ''
    refresh()
  })

  await refresh()
  // ponytail: polling every 3s; a dashboard websocket if this ever needs to be instant
  setInterval(() => { if (!document.hidden) refresh() }, 3000)
}

const pages = { auth: authPage, device: devicePage, dashboard: dashboardPage }
pages[document.body.dataset.page]?.()
