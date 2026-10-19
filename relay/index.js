import { DurableObject } from 'cloudflare:workers'

const ADJ = 'brave calm clever cosmic dizzy eager fuzzy gentle happy jolly lucky mellow mighty nimble noisy plucky quiet rapid rusty salty shiny sly snappy sneaky spicy sunny swift tiny witty zesty'.split(' ')
const ANIMAL = 'otter falcon badger crab panda koala lynx gecko heron moose narwhal octopus owl puffin raven shark sloth squid tiger walrus wombat yak lemur bison cobra dingo ferret hippo marmot newt'.split(' ')
const pick = a => a[crypto.getRandomValues(new Uint32Array(1))[0] % a.length]
// Payloads are end-to-end encrypted by the client ("e1:" + base64), so these caps are on ciphertext
const MAX = { text: 100_000, status: 2_000, note: 8_000, summary: 16_000, body: 256 * 1024 }
const INVITE_TTL = 10 * 60 * 1000
const NAME_RE = /^[a-z]+-[a-z]+(-\d{1,2})?$/

async function sha(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('')
}
const json = (data, status = 200) => Response.json(data, { status })

export default {
  async fetch(req, env) {
    const path = new URL(req.url).pathname
    // per-IP rate limits: tight on the endpoints that create sessions or guess codes
    const limiter = ['/register', '/join', '/invite'].includes(path) ? env.AUTH_LIMIT : env.API_LIMIT
    const ip = req.headers.get('CF-Connecting-IP') ?? 'local'
    if (limiter && !(await limiter.limit({ key: ip })).success) return json({ error: 'rate limited, slow down' }, 429)
    // ponytail: one global Durable Object holds everything; shard per group if it ever gets busy
    return env.RELAY.get(env.RELAY.idFromName('global')).fetch(req)
  },
}

export class Relay extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env)
    this.sql = ctx.storage.sql
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS sessions (name TEXT PRIMARY KEY, token_hash TEXT UNIQUE, grp TEXT, status TEXT DEFAULT '', seen INTEGER);
      CREATE TABLE IF NOT EXISTS invites (name TEXT PRIMARY KEY, proof_hash TEXT, exp INTEGER, tries INTEGER DEFAULT 0, wrapped TEXT);
      CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, to_name TEXT, from_name TEXT, text TEXT, ts INTEGER);
      CREATE INDEX IF NOT EXISTS messages_to ON messages(to_name);`)
    if (!this.sql.exec('PRAGMA table_info(invites)').toArray().some(c => c.name === 'proof_hash'))
      this.sql.exec('DROP TABLE invites; CREATE TABLE invites (name TEXT PRIMARY KEY, proof_hash TEXT, exp INTEGER, tries INTEGER DEFAULT 0, wrapped TEXT)') // pre-0.4 invites are short-lived anyway
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
  history(grp, limit = 20, peer) {
    limit = Math.min(Math.max(Number(limit) || 20, 1), 200)
    return peer
      ? this.rows('SELECT from_name, to_name, text, ts FROM history WHERE grp = ? AND (from_name = ? OR to_name = ?) ORDER BY id DESC LIMIT ?', grp, peer, peer, limit)
      : this.rows('SELECT from_name, to_name, text, ts FROM history WHERE grp = ? ORDER BY id DESC LIMIT ?', grp, limit)
  }

  one(q, ...a) { return this.sql.exec(q, ...a).toArray()[0] }

  async auth(token) {
    if (!token) return null
    const s = this.one('SELECT * FROM sessions WHERE token_hash = ?', await sha(token))
    if (s) this.sql.exec('UPDATE sessions SET seen = ? WHERE name = ?', Date.now(), s.name)
    return s
  }

  peers(me) {
    return this.sql.exec('SELECT name, status, seen FROM sessions WHERE grp = ? AND name != ?', me.grp, me.name).toArray()
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
    if (url.pathname === '/register') {
      let name = `${pick(ADJ)}-${pick(ANIMAL)}`
      while (this.one('SELECT 1 AS x FROM sessions WHERE name = ?', name)) name = `${pick(ADJ)}-${pick(ANIMAL)}-${Math.floor(Math.random() * 100)}`
      const token = crypto.randomUUID() + crypto.randomUUID()
      this.sql.exec('INSERT INTO sessions (name, token_hash, grp, seen) VALUES (?, ?, ?, ?)', name, await sha(token), crypto.randomUUID(), Date.now())
      return json({ name, token })
    }

    const me = await this.auth(req.headers.get('Authorization')?.replace(/^Bearer /, ''))
    if (!me) return json({ error: 'unauthorized' }, 401)

    switch (url.pathname) {
      case '/ws': {
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
        return json({ history: (await this.history(me.grp, body.limit, body.peer)).reverse() })
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
        this.sql.exec('UPDATE sessions SET status = ? WHERE name = ?', this.field(body, 'text', MAX.status), me.name)
        return json({ ok: true })
      case '/invite': {
        // The invite secret never reaches the relay. It only gets:
        //   wrapped    = the group key encrypted with a key derived from the secret
        //   proof_hash = sha256 of a second value derived from the secret, which the joiner must present
        // So joining needs the full 128-bit secret: nothing to guess, and the relay can't unwrap the key.
        if (!body.wrapped) return json({ error: 'this Clawkie client is outdated (pre-0.4). Run: claude plugin marketplace update clawkie && claude plugin update clawkie@clawkie, then restart Claude Code' }, 426)
        const wrapped = this.field(body, 'wrapped', 200)
        const proofHash = this.field(body, 'proof_hash', 64, false)
        if (!/^[0-9a-f]{64}$/.test(proofHash)) return json({ error: 'bad proof_hash' }, 400)
        this.sql.exec('INSERT OR REPLACE INTO invites (name, proof_hash, exp, tries, wrapped) VALUES (?, ?, ?, 0, ?)', me.name, proofHash, Date.now() + INVITE_TTL, wrapped)
        return json({ name: me.name, expires_in_minutes: INVITE_TTL / 60000 })
      }
      case '/join': {
        if (body.code && !body.proof) return json({ error: 'this Clawkie client is outdated (pre-0.4). Run: claude plugin marketplace update clawkie && claude plugin update clawkie@clawkie, then restart Claude Code and use a new invite' }, 426)
        if (!NAME_RE.test(String(body.name)) || !/^[A-Za-z0-9_-]{43}$/.test(String(body.proof))) return json({ error: 'expected a session name and an invite proof' }, 400)
        const inv = this.one('SELECT * FROM invites WHERE name = ?', String(body.name))
        if (!inv || inv.exp < Date.now()) return json({ error: 'no active invite for that session; ask it to create a new one' }, 404)
        if (inv.proof_hash !== await sha(body.proof)) {
          // 5 wrong tries burns the invite (a griefer can only cancel it, never get in)
          if (inv.tries >= 4) this.sql.exec('DELETE FROM invites WHERE name = ?', inv.name)
          else this.sql.exec('UPDATE invites SET tries = tries + 1 WHERE name = ?', inv.name)
          return json({ error: 'wrong invite secret' }, 403)
        }
        if (inv.name === me.name) return json({ error: 'cannot join yourself' }, 400)
        this.sql.exec('DELETE FROM invites WHERE name = ?', inv.name)
        const host = this.one('SELECT grp FROM sessions WHERE name = ?', inv.name)
        // Only the joining session moves; its old peers didn't consent to the new group.
        const oldPeers = this.peers(me).map(p => p.name)
        this.sql.exec('UPDATE sessions SET grp = ? WHERE name = ?', host.grp, me.name)
        await this.db.prepare('UPDATE handoffs SET grp = ? WHERE name = ?').bind(host.grp, me.name).run()
        this.notify(oldPeers, { type: 'left', name: me.name })
        const peers = this.peers({ ...me, grp: host.grp })
        this.notify(peers.map(p => p.name), { type: 'joined', name: me.name })
        return json({ ok: true, peers, wrapped: inv.wrapped })
      }
      case '/leave': {
        const grp = crypto.randomUUID()
        this.sql.exec('UPDATE sessions SET grp = ? WHERE name = ?', grp, me.name)
        await this.db.prepare('UPDATE handoffs SET grp = ? WHERE name = ?').bind(grp, me.name).run()
        this.notify(this.peers(me).map(p => p.name), { type: 'left', name: me.name })
        return json({ ok: true })
      }
      case '/kick': { // remove a lost or compromised device from the group
        const peer = this.one('SELECT name FROM sessions WHERE name = ? AND grp = ?', String(body.name), me.grp)
        if (!peer) return json({ error: 'not a peer in your group' }, 404)
        this.sql.exec('UPDATE sessions SET grp = ? WHERE name = ?', crypto.randomUUID(), peer.name)
        this.sql.exec('DELETE FROM messages WHERE to_name = ?', peer.name)
        await this.db.prepare('DELETE FROM handoffs WHERE name = ?').bind(peer.name).run()
        for (const ws of this.ctx.getWebSockets(peer.name)) ws.send(JSON.stringify({ type: 'kicked', by: me.name }))
        this.notify(this.peers(me).map(p => p.name), { type: 'left', name: peer.name })
        return json({ ok: true })
      }
      case '/send': {
        const text = this.field(body, 'text', MAX.text)
        const peers = this.peers(me).map(p => p.name)
        const to = body.to === 'all' ? peers : [String(body.to)]
        if (!to.length || !to.every(n => peers.includes(n))) return json({ error: `unknown peer; your peers are: ${peers.join(', ') || 'none'}` }, 400)
        await this.db.prepare('INSERT INTO history (grp, from_name, to_name, text, ts) VALUES (?, ?, ?, ?, ?)')
          .bind(me.grp, me.name, body.to === 'all' ? 'all' : to[0], text, Date.now()).run()
        for (const n of to) {
          const { id } = this.one('INSERT INTO messages (to_name, from_name, text, ts) VALUES (?, ?, ?, ?) RETURNING id', n, me.name, text, Date.now())
          this.deliver(n, id)
        }
        return json({ ok: true, sent_to: to })
      }
    }
    return json({ error: 'not found' }, 404)
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
