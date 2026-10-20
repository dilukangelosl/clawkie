import { DurableObject } from 'cloudflare:workers'
import { betterAuth } from 'better-auth'

const ADJ = 'brave calm clever cosmic dizzy eager fuzzy gentle happy jolly lucky mellow mighty nimble noisy plucky quiet rapid rusty salty shiny sly snappy sneaky spicy sunny swift tiny witty zesty'.split(' ')
const ANIMAL = 'otter falcon badger crab panda koala lynx gecko heron moose narwhal octopus owl puffin raven shark sloth squid tiger walrus wombat yak lemur bison cobra dingo ferret hippo marmot newt'.split(' ')
const pick = a => a[crypto.getRandomValues(new Uint32Array(1))[0] % a.length]
// Payloads are end-to-end encrypted by the client ("e1:" + base64), so these caps are on ciphertext
const MAX = { text: 100_000, status: 2_000, note: 8_000, summary: 16_000, cwd: 2_000, body: 256 * 1024 }
const CODE_TTL = 10 * 60 * 1000
const UPDATE = 'Clawkie 0.5 replaced invites with accounts. Update (claude plugin marketplace update clawkie && claude plugin update clawkie@clawkie), restart Claude Code, then run /clawkie:login'
const WEB = 'web' // the dashboard's name as a message sender/recipient

async function sha(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('')
}
const json = (data, status = 200) => Response.json(data, { status })
const rand = n => [...crypto.getRandomValues(new Uint8Array(n))].map(b => b.toString(16).padStart(2, '0')).join('')
const userCode = () => Array.from({ length: 8 }, (_, i) => (i === 4 ? '-' : '') + pick([...'BCDFGHJKLMNPQRSTVWXZ'])).join('')

// ---------- accounts (Better Auth on D1, mail via Cloudflare Email Sending) ----------
// PBKDF2 via WebCrypto instead of Better Auth's JS scrypt, which blows the Workers CPU budget
const te = new TextEncoder()
async function pbkdf2(password, salt) {
  const key = await crypto.subtle.importKey('raw', te.encode(password), 'PBKDF2', false, ['deriveBits'])
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100_000 }, key, 256))
}
const hex = u => [...u].map(b => b.toString(16).padStart(2, '0')).join('')
const unhex = s => new Uint8Array(s.match(/../g).map(h => parseInt(h, 16)))
const password = {
  hash: async pw => { const salt = crypto.getRandomValues(new Uint8Array(16)); return `pbkdf2$${hex(salt)}$${hex(await pbkdf2(pw, salt))}` },
  verify: async ({ hash, password: pw }) => {
    const [, salt, want] = hash.split('$')
    const got = await pbkdf2(pw, unhex(salt))
    return crypto.subtle.timingSafeEqual(got, unhex(want))
  },
}

const mailHtml = (title, text, url, label) => `<div style="font-family:system-ui,sans-serif;max-width:480px;margin:auto;padding:24px">
<h2 style="margin:0 0 12px">${title}</h2><p>${text}</p>
<p><a href="${url}" style="display:inline-block;background:#f97316;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none">${label}</a></p>
<p style="color:#888;font-size:13px">Or paste this link: ${url}<br>If you didn't ask for this, ignore this email.</p></div>`

let auth // one per isolate
function getAuth(env) {
  const mail = (to, subject, html) => env.EMAIL.send({ from: { name: 'Clawkie', email: env.MAIL_FROM }, to, subject, html })
  return (auth ??= betterAuth({
    database: env.DB,
    baseURL: env.BASE_URL,
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: [env.BASE_URL],
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      password,
      sendResetPassword: ({ user, url }) => mail(user.email, 'Reset your Clawkie password', mailHtml('Reset your password', 'Someone (hopefully you) asked to reset your Clawkie password.', url, 'Reset password')),
    },
    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
      sendVerificationEmail: ({ user, url }) => mail(user.email, 'Verify your Clawkie email', mailHtml('Welcome to Clawkie', 'Confirm your email to finish creating your account.', url, 'Verify email')),
    },
  }))
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url)
    const path = url.pathname
    // per-IP rate limits: tight on the endpoints that create sessions, start logins, or check passwords
    const tight = ['/register', '/device/start'].includes(path) || (path.startsWith('/api/auth/') && req.method === 'POST')
    const limiter = tight ? env.AUTH_LIMIT : env.API_LIMIT
    const ip = req.headers.get('CF-Connecting-IP') ?? 'local'
    if (limiter && !(await limiter.limit({ key: ip })).success) return json({ error: 'rate limited, slow down' }, 429)

    if (path.startsWith('/api/auth/')) return getAuth(env).handler(req)
    const relay = env.RELAY.get(env.RELAY.idFromName('global')) // ponytail: one global Durable Object holds everything; shard per account if it ever gets busy
    // Dashboard API: a logged-in browser acts as the "web" member of its own account
    if (path.startsWith('/api/')) {
      const s = await getAuth(env).api.getSession({ headers: req.headers })
      if (!s) return json({ error: 'not signed in' }, 401)
      const inner = new Request(new URL(path.slice(4), url), { method: 'POST', body: req.method === 'POST' ? await req.text() : '{}' })
      inner.headers.set('X-Clawkie-User', s.user.id) // only ever set here; stripped from outside requests below
      inner.headers.set('X-Clawkie-Email', s.user.email)
      return relay.fetch(inner)
    }
    const isRelay = req.method === 'POST' || path === '/ws'
    if (!isRelay) {
      // Pages: /login, /register, /forgot, /reset all render the one auth page
      if (['/login', '/register', '/forgot', '/reset'].includes(path)) return env.ASSETS.fetch(new Request(new URL('/auth', url), req))
      return env.ASSETS.fetch(req)
    }
    const clean = new Request(req)
    clean.headers.delete('X-Clawkie-User')
    clean.headers.delete('X-Clawkie-Email')
    return relay.fetch(clean)
  },
}

export class Relay extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env)
    this.sql = ctx.storage.sql
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS sessions (name TEXT PRIMARY KEY, token_hash TEXT UNIQUE, grp TEXT, status TEXT DEFAULT '', seen INTEGER);
      CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, to_name TEXT, from_name TEXT, text TEXT, ts INTEGER);
      CREATE INDEX IF NOT EXISTS messages_to ON messages(to_name);
      CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, token_hash TEXT UNIQUE, user_id TEXT, label TEXT, created INTEGER, seen INTEGER);
      CREATE TABLE IF NOT EXISTS device_codes (user_code TEXT PRIMARY KEY, code_hash TEXT UNIQUE, pub TEXT, label TEXT, exp INTEGER, user_id TEXT, wrapped TEXT);
      CREATE TABLE IF NOT EXISTS accounts (user_id TEXT PRIMARY KEY, kfp TEXT);
      DROP TABLE IF EXISTS invites;`)
    const cols = this.sql.exec('PRAGMA table_info(sessions)').toArray().map(c => c.name)
    if (!cols.includes('device')) this.sql.exec('ALTER TABLE sessions ADD COLUMN device TEXT')
    if (!cols.includes('cwd')) this.sql.exec('ALTER TABLE sessions ADD COLUMN cwd TEXT')
    // D1 keeps the long-lived memory: message history, shared notes, session handoffs
    this.db = env.DB
    ctx.blockConcurrencyWhile(() => this.db.batch([
      'CREATE TABLE IF NOT EXISTS history (id INTEGER PRIMARY KEY AUTOINCREMENT, grp TEXT, from_name TEXT, to_name TEXT, text TEXT, ts INTEGER)',
      'CREATE INDEX IF NOT EXISTS history_grp ON history(grp, id)',
      'CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY AUTOINCREMENT, grp TEXT, author TEXT, text TEXT, ts INTEGER)',
      'CREATE INDEX IF NOT EXISTS notes_grp ON notes(grp)',
      'CREATE TABLE IF NOT EXISTS handoffs (name TEXT PRIMARY KEY, grp TEXT, summary TEXT, ts INTEGER)',
    ].map(q => this.db.prepare(q))))
  }

  async rows(q, ...a) { return (await this.db.prepare(q).bind(...a).all()).results }

  // ponytail: history is kept forever; add a retention sweep if the D1 bill ever matters
  history(grp, limit = 20, peer, before) {
    limit = Math.min(Math.max(Number(limit) || 20, 1), 200)
    before = Number(before) || Number.MAX_SAFE_INTEGER
    return peer
      ? this.rows('SELECT id, from_name, to_name, text, ts FROM history WHERE grp = ? AND id < ? AND (from_name = ? OR to_name = ?) ORDER BY id DESC LIMIT ?', grp, before, peer, peer, limit)
      : this.rows('SELECT id, from_name, to_name, text, ts FROM history WHERE grp = ? AND id < ? ORDER BY id DESC LIMIT ?', grp, before, limit)
  }

  one(q, ...a) { return this.sql.exec(q, ...a).toArray()[0] }

  async auth(req) {
    const user = req.headers.get('X-Clawkie-User')
    if (user) return { name: WEB, grp: user, email: req.headers.get('X-Clawkie-Email'), web: true }
    const token = req.headers.get('Authorization')?.replace(/^Bearer /, '')
    if (!token) return null
    const s = this.one('SELECT * FROM sessions WHERE token_hash = ?', await sha(token))
    if (s) this.sql.exec('UPDATE sessions SET seen = ? WHERE name = ?', Date.now(), s.name)
    return s
  }

  async device(req) {
    const token = req.headers.get('Authorization')?.replace(/^Bearer /, '')
    const d = token && this.one('SELECT * FROM devices WHERE token_hash = ?', await sha(token))
    if (d) this.sql.exec('UPDATE devices SET seen = ? WHERE id = ?', Date.now(), d.id)
    return d
  }

  peers(me) {
    return this.sql.exec('SELECT name, status, seen, cwd, device FROM sessions WHERE grp = ? AND name != ? ORDER BY seen DESC', me.grp, me.name).toArray()
      .map(p => ({ ...p, online: this.ctx.getWebSockets(p.name).length > 0 }))
  }

  // Flush a session's whole queue on connect, or push just one new message (so unacked ones aren't re-sent each time)
  deliver(name, onlyId) {
    const sockets = this.ctx.getWebSockets(name)
    if (!sockets.length) return
    const q = onlyId ? this.sql.exec('SELECT * FROM messages WHERE id = ?', onlyId) : this.sql.exec('SELECT * FROM messages WHERE to_name = ? ORDER BY id', name)
    for (const m of q.toArray())
      for (const ws of sockets) ws.send(JSON.stringify({ type: 'message', id: m.id, from: m.from_name, text: m.text, ts: m.ts }))
  }

  // Reject (never truncate) oversized fields: cutting ciphertext would make it undecryptable.
  field(body, key, max, sealed = true) {
    const v = String(body[key] ?? '')
    if (!v) throw new HttpError(400, `${key} required`)
    if (v.length > max) throw new HttpError(413, `${key} too long (max ${max})`)
    // The relay can't read payloads, but it refuses anything that isn't client-side ciphertext
    if (sealed && !/^e1:[A-Za-z0-9_-]+$/.test(v)) throw new HttpError(400, `${key} must be end-to-end encrypted (update your clawkie client)`)
    return v
  }

  async fetch(req) {
    try { return await this.route(req) } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status)
      throw e
    }
  }

  async route(req) {
    const url = new URL(req.url)
    if (req.method === 'GET' && url.pathname !== '/ws') return json({ ok: true, service: 'clawkie-relay' })

    const raw = req.method === 'POST' ? await req.text() : ''
    if (raw.length > MAX.body) return json({ error: 'request too large' }, 413)
    let body = {}
    try { body = raw ? JSON.parse(raw) : {} } catch { return json({ error: 'invalid JSON' }, 400) }
    if (typeof body !== 'object' || body === null) body = {}

    // ---- device login (like `gh auth login`): the CLI starts, the browser approves, the CLI polls
    if (url.pathname === '/device/start') {
      // pub: the CLI's ephemeral ECDH key; the browser wraps the account key to it, so the relay never sees the key
      const pub = String(body.pub ?? '')
      if (!/^[A-Za-z0-9_-]{80,100}$/.test(pub)) return json({ error: 'bad pub' }, 400)
      const deviceCode = rand(32), code = userCode()
      this.sql.exec('DELETE FROM device_codes WHERE exp < ?', Date.now())
      this.sql.exec('INSERT INTO device_codes (user_code, code_hash, pub, label, exp) VALUES (?, ?, ?, ?, ?)', code, await sha(deviceCode), pub, String(body.label ?? '').slice(0, 100), Date.now() + CODE_TTL)
      const web = this.env.BASE_URL
      return json({ device_code: deviceCode, user_code: code, verification_uri: `${web}/device`, verification_uri_complete: `${web}/device?code=${code}`, interval: 2, expires_in: CODE_TTL / 1000 })
    }
    if (url.pathname === '/device/poll') {
      const c = this.one('SELECT * FROM device_codes WHERE code_hash = ?', await sha(String(body.device_code)))
      if (!c || c.exp < Date.now()) return json({ error: 'expired_token' }, 400)
      if (!c.user_id) return json({ error: 'authorization_pending' }, 400)
      this.sql.exec('DELETE FROM device_codes WHERE user_code = ?', c.user_code)
      const token = rand(32), id = rand(8)
      this.sql.exec('INSERT INTO devices (id, token_hash, user_id, label, created, seen) VALUES (?, ?, ?, ?, ?, ?)', id, await sha(token), c.user_id, c.label, Date.now(), Date.now())
      return json({ token, wrapped: c.wrapped, user_id: c.user_id })
    }
    if (url.pathname === '/register') {
      const dev = await this.device(req)
      if (!dev) return json({ error: req.headers.get('Authorization') ? 'signed out: run /clawkie:login' : UPDATE }, req.headers.get('Authorization') ? 401 : 426)
      let name = `${pick(ADJ)}-${pick(ANIMAL)}`
      while (this.one('SELECT 1 AS x FROM sessions WHERE name = ?', name)) name = `${pick(ADJ)}-${pick(ANIMAL)}-${Math.floor(Math.random() * 100)}`
      const token = crypto.randomUUID() + crypto.randomUUID()
      const cwd = body.cwd ? this.field(body, 'cwd', MAX.cwd) : null
      this.sql.exec('INSERT INTO sessions (name, token_hash, grp, seen, device, cwd) VALUES (?, ?, ?, ?, ?, ?)', name, await sha(token), dev.user_id, Date.now(), dev.id, cwd)
      this.notify(this.peers({ grp: dev.user_id, name }).map(p => p.name), { type: 'joined', name })
      return json({ name, token, user_id: dev.user_id })
    }
    if (['/invite', '/join', '/leave'].includes(url.pathname)) return json({ error: UPDATE }, 426)

    const me = await this.auth(req)
    if (!me) return json({ error: 'unauthorized' }, 401)

    // ---- dashboard-only
    if (me.web) switch (url.pathname) {
      case '/me': {
        const acct = this.one('SELECT kfp FROM accounts WHERE user_id = ?', me.grp)
        return json({ user_id: me.grp, email: me.email, kfp: acct?.kfp ?? null })
      }
      case '/state':
        return json({
          sessions: this.peers(me),
          devices: this.sql.exec('SELECT id, label, created, seen FROM devices WHERE user_id = ? ORDER BY seen DESC', me.grp).toArray(),
          notes: await this.rows('SELECT id, author, text, ts FROM notes WHERE grp = ? ORDER BY id DESC LIMIT 200', me.grp),
          handoffs: await this.rows('SELECT name, summary, ts FROM handoffs WHERE grp = ? ORDER BY ts DESC LIMIT 50', me.grp),
        })
      case '/device/info': {
        const c = this.one('SELECT pub, label, exp, user_id FROM device_codes WHERE user_code = ?', String(body.user_code).toUpperCase())
        if (!c || c.exp < Date.now() || c.user_id) return json({ error: 'that code is invalid or expired; run /clawkie:login again' }, 404)
        return json({ pub: c.pub, label: c.label })
      }
      case '/device/approve': {
        const kfp = String(body.kfp ?? '')
        if (!/^[0-9a-f]{64}$/.test(kfp)) return json({ error: 'bad kfp' }, 400)
        const acct = this.one('SELECT kfp FROM accounts WHERE user_id = ?', me.grp)
        // every device of an account must share one key; a browser holding a different one can't approve
        if (acct && acct.kfp !== kfp) return json({ error: 'this browser has a different account key than your devices' }, 409)
        const wrapped = String(body.wrapped ?? '') // "<browser ECDH pub>.<sealed account key>"
        if (!/^[A-Za-z0-9_-]{80,100}\.e1:[A-Za-z0-9_-]{20,300}$/.test(wrapped)) return json({ error: 'bad wrapped key' }, 400)
        const c = this.one('SELECT * FROM device_codes WHERE user_code = ?', String(body.user_code).toUpperCase())
        if (!c || c.exp < Date.now() || c.user_id) return json({ error: 'that code is invalid or expired; run /clawkie:login again' }, 404)
        if (!acct) this.sql.exec('INSERT INTO accounts (user_id, kfp) VALUES (?, ?)', me.grp, kfp)
        this.sql.exec('UPDATE device_codes SET user_id = ?, wrapped = ? WHERE user_code = ?', me.grp, wrapped, c.user_code)
        return json({ ok: true })
      }
      case '/revoke': { // sign a lost device out: its token and all its sessions stop working
        const d = this.one('SELECT id FROM devices WHERE id = ? AND user_id = ?', String(body.id), me.grp)
        if (!d) return json({ error: 'no such device' }, 404)
        for (const s of this.sql.exec('SELECT name FROM sessions WHERE device = ?', d.id).toArray()) await this.drop(s.name, me)
        this.sql.exec('DELETE FROM devices WHERE id = ?', d.id)
        return json({ ok: true })
      }
    }

    switch (url.pathname) {
      case '/ws': {
        if (me.web) return json({ error: 'not for the dashboard' }, 400)
        if (req.headers.get('Upgrade') !== 'websocket') return json({ error: 'expected websocket' }, 426)
        const [client, server] = Object.values(new WebSocketPair())
        this.ctx.acceptWebSocket(server, [me.name]) // tag = name, so getWebSockets(name) finds it
        server.serializeAttachment({ name: me.name })
        server.send(JSON.stringify({ type: 'ready', name: me.name }))
        this.deliver(me.name)
        return new Response(null, { status: 101, webSocket: client })
      }
      case '/context': // everything a new session needs, in one call (SessionStart hook)
        return json({
          name: me.name,
          peers: this.peers(me),
          history: (await this.history(me.grp, body.limit ?? 10)).reverse(),
          notes: await this.rows('SELECT id, author, text, ts FROM notes WHERE grp = ? ORDER BY id DESC LIMIT 50', me.grp),
          handoffs: await this.rows('SELECT name, summary, ts FROM handoffs WHERE grp = ? ORDER BY ts DESC LIMIT 10', me.grp),
        })
      case '/history':
        return json({ history: (await this.history(me.grp, body.limit, body.peer, body.before)).reverse() })
      case '/remember': {
        const text = this.field(body, 'text', MAX.note)
        const { meta } = await this.db.prepare('INSERT INTO notes (grp, author, text, ts) VALUES (?, ?, ?, ?)').bind(me.grp, me.name, text, Date.now()).run()
        return json({ ok: true, id: meta.last_row_id })
      }
      case '/notes':
        return json({ notes: await this.rows('SELECT id, author, text, ts FROM notes WHERE grp = ? ORDER BY id DESC LIMIT 200', me.grp) })
      case '/forget': {
        const { meta } = await this.db.prepare('DELETE FROM notes WHERE id = ? AND grp = ?').bind(Number(body.id), me.grp).run()
        return json({ ok: meta.changes > 0 })
      }
      case '/handoff': {
        const summary = this.field(body, 'summary', MAX.summary)
        await this.db.prepare('INSERT OR REPLACE INTO handoffs (name, grp, summary, ts) VALUES (?, ?, ?, ?)').bind(me.name, me.grp, summary, Date.now()).run()
        return json({ ok: true })
      }
      case '/whoami':
        return json({ name: me.name, peers: this.peers(me) })
      case '/peers':
        return json({ peers: this.peers(me) })
      case '/status':
        if (me.web) return json({ error: 'not for the dashboard' }, 400)
        this.sql.exec('UPDATE sessions SET status = ? WHERE name = ?', this.field(body, 'text', MAX.status), me.name)
        return json({ ok: true })
      case '/kick': { // forget a session of this account (a stale folder, a finished VM)
        if (!this.one('SELECT 1 AS x FROM sessions WHERE name = ? AND grp = ?', String(body.name), me.grp)) return json({ error: 'not a session in your account' }, 404)
        await this.drop(String(body.name), me)
        return json({ ok: true })
      }
      case '/send': {
        const text = this.field(body, 'text', MAX.text)
        const peers = this.peers(me).map(p => p.name)
        // "web" is a recipient sessions can reply to; it reads replies from history
        const to = body.to === 'all' ? peers : [String(body.to)]
        if (!to.length || !to.every(n => peers.includes(n) || (n === WEB && !me.web))) return json({ error: `unknown peer; your peers are: ${[...peers, ...(me.web ? [] : [WEB])].join(', ') || 'none'}` }, 400)
        const { meta } = await this.db.prepare('INSERT INTO history (grp, from_name, to_name, text, ts) VALUES (?, ?, ?, ?, ?)')
          .bind(me.grp, me.name, body.to === 'all' ? 'all' : to[0], text, Date.now()).run()
        for (const n of to) {
          if (n === WEB) continue
          const { id } = this.one('INSERT INTO messages (to_name, from_name, text, ts) VALUES (?, ?, ?, ?) RETURNING id', n, me.name, text, Date.now())
          this.deliver(n, id)
        }
        return json({ ok: true, sent_to: to, id: meta.last_row_id })
      }
    }
    return json({ error: 'not found' }, 404)
  }

  async drop(name, by) {
    this.sql.exec('DELETE FROM sessions WHERE name = ?', name)
    this.sql.exec('DELETE FROM messages WHERE to_name = ?', name)
    await this.db.prepare('DELETE FROM handoffs WHERE name = ?').bind(name).run()
    for (const ws of this.ctx.getWebSockets(name)) { ws.send(JSON.stringify({ type: 'kicked', by: by.name })); ws.close(4001, 'kicked') }
    this.notify(this.peers(by).map(p => p.name), { type: 'left', name })
  }

  notify(names, event) {
    for (const n of names) for (const ws of this.ctx.getWebSockets(n)) ws.send(JSON.stringify(event))
  }

  async webSocketMessage(ws, raw) {
    let msg
    try { msg = JSON.parse(raw) } catch { return }
    const me = ws.deserializeAttachment()
    if (msg?.type === 'ack' && me) this.sql.exec('DELETE FROM messages WHERE id = ? AND to_name = ?', msg.id, me.name)
  }
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status }
}
