import { DurableObject } from 'cloudflare:workers'

const ADJ = 'brave calm clever cosmic dizzy eager fuzzy gentle happy jolly lucky mellow mighty nimble noisy plucky quiet rapid rusty salty shiny sly snappy sneaky spicy sunny swift tiny witty zesty'.split(' ')
const ANIMAL = 'otter falcon badger crab panda koala lynx gecko heron moose narwhal octopus owl puffin raven shark sloth squid tiger walrus wombat yak lemur bison cobra dingo ferret hippo marmot newt'.split(' ')
const pick = a => a[crypto.getRandomValues(new Uint32Array(1))[0] % a.length]
const MAX_TEXT = 64 * 1024
const INVITE_TTL = 10 * 60 * 1000

async function sha(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('')
}
const json = (data, status = 200) => Response.json(data, { status })

export default {
  // ponytail: one global Durable Object holds everything; shard per group if it ever gets busy
  fetch: (req, env) => env.RELAY.get(env.RELAY.idFromName('global')).fetch(req),
}

export class Relay extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env)
    this.sql = ctx.storage.sql
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS sessions (name TEXT PRIMARY KEY, token_hash TEXT UNIQUE, grp TEXT, status TEXT DEFAULT '', seen INTEGER);
      CREATE TABLE IF NOT EXISTS invites (code TEXT, name TEXT PRIMARY KEY, exp INTEGER, tries INTEGER DEFAULT 0);
      CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, to_name TEXT, from_name TEXT, text TEXT, ts INTEGER);
      CREATE INDEX IF NOT EXISTS messages_to ON messages(to_name);`)
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

  deliver(name) {
    const sockets = this.ctx.getWebSockets(name)
    if (!sockets.length) return
    for (const m of this.sql.exec('SELECT * FROM messages WHERE to_name = ? ORDER BY id', name).toArray())
      for (const ws of sockets) ws.send(JSON.stringify({ type: 'message', id: m.id, from: m.from_name, text: m.text, ts: m.ts }))
  }

  async fetch(req) {
    const url = new URL(req.url)
    if (req.method === 'GET' && url.pathname !== '/ws') return json({ ok: true, service: 'clawkie-relay' })

    const body = await req.json().catch(() => ({}))
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
      case '/whoami':
        return json({ name: me.name, peers: this.peers(me) })
      case '/peers':
        return json({ peers: this.peers(me) })
      case '/status':
        this.sql.exec('UPDATE sessions SET status = ? WHERE name = ?', String(body.text ?? '').slice(0, 500), me.name)
        return json({ ok: true })
      case '/invite': {
        const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1e6).padStart(6, '0')
        this.sql.exec('INSERT OR REPLACE INTO invites (code, name, exp, tries) VALUES (?, ?, ?, 0)', code, me.name, Date.now() + INVITE_TTL)
        return json({ name: me.name, code, expires_in_minutes: INVITE_TTL / 60000 })
      }
      case '/join': {
        const inv = this.one('SELECT * FROM invites WHERE name = ?', String(body.name ?? ''))
        if (!inv || inv.exp < Date.now()) return json({ error: 'no active invite for that session; ask it to create a new one' }, 404)
        if (inv.code !== String(body.code ?? '')) {
          // 5 wrong guesses burns the invite, so a 6-digit code can't be brute forced
          if (inv.tries >= 4) this.sql.exec('DELETE FROM invites WHERE name = ?', inv.name)
          else this.sql.exec('UPDATE invites SET tries = tries + 1 WHERE name = ?', inv.name)
          return json({ error: 'wrong code' }, 403)
        }
        if (inv.name === me.name) return json({ error: 'cannot join yourself' }, 400)
        this.sql.exec('DELETE FROM invites WHERE name = ?', inv.name)
        const host = this.one('SELECT grp FROM sessions WHERE name = ?', inv.name)
        this.sql.exec('UPDATE sessions SET grp = ? WHERE grp = ?', host.grp, me.grp) // my whole group moves into theirs
        const peers = this.peers({ ...me, grp: host.grp })
        this.notify(peers.map(p => p.name), { type: 'joined', name: me.name })
        return json({ ok: true, peers })
      }
      case '/leave':
        this.sql.exec('UPDATE sessions SET grp = ? WHERE name = ?', crypto.randomUUID(), me.name)
        this.notify(this.peers(me).map(p => p.name), { type: 'left', name: me.name })
        return json({ ok: true })
      case '/send': {
        const text = String(body.text ?? '')
        if (!text || text.length > MAX_TEXT) return json({ error: `text must be 1..${MAX_TEXT} chars` }, 400)
        const peers = this.peers(me).map(p => p.name)
        const to = body.to === 'all' ? peers : [String(body.to)]
        if (!to.length || !to.every(n => peers.includes(n))) return json({ error: `unknown peer; your peers are: ${peers.join(', ') || 'none'}` }, 400)
        for (const n of to) {
          this.sql.exec('INSERT INTO messages (to_name, from_name, text, ts) VALUES (?, ?, ?, ?)', n, me.name, text, Date.now())
          this.deliver(n)
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
    const msg = JSON.parse(raw)
    const me = ws.deserializeAttachment()
    if (msg.type === 'ack' && me) this.sql.exec('DELETE FROM messages WHERE id = ? AND to_name = ?', msg.id, me.name)
  }
}
