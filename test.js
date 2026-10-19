// End-to-end: two real clawkie sessions pair through the relay and exchange a message.
// Usage: CLAWKIE_URL=http://localhost:8787 node test.js   (with `npm run dev` running)
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import assert from 'node:assert'
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'

const home = mkdtempSync(join(tmpdir(), 'clawkie-test-'))
const events = { a: [], b: [] }

async function session(key) {
  const client = new Client({ name: 'test', version: '0' })
  client.setNotificationHandler(
    z.object({ method: z.literal('notifications/claude/channel'), params: z.any() }),
    n => events[key].push(n.params),
  )
  await client.connect(new StdioClientTransport({
    command: 'node', args: ['clawkie.js'],
    env: { ...process.env, HOME: home, CLAWKIE_ID: key },
  }))
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args })
    assert(!r.isError, r.content[0].text)
    return JSON.parse(r.content[0].text)
  }
  return { client, call }
}

const until = async (fn, ms = 5000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise(r => setTimeout(r, 100))) if (fn()) return
  throw new Error('timed out')
}

const a = await session('a'), b = await session('b')
const inv = await a.call('clawkie_invite')
assert.match(inv.code, /^\d{6}$/)

// wrong code is rejected
const bad = await b.client.callTool({ name: 'clawkie_join', arguments: { name: inv.name, code: 'nope' } })
assert(bad.isError)

const joined = await b.call('clawkie_join', { name: inv.name, code: inv.code })
assert.equal(joined.peers[0].name, inv.name)
await until(() => events.a.some(e => e.meta.event === 'joined'))

const bName = (await b.call('clawkie_whoami')).name
await a.call('clawkie_status', { text: 'running migrations' })
assert.equal((await b.call('clawkie_peers')).peers[0].status, 'running migrations')

await a.call('clawkie_send', { to: bName, text: 'run the squid migration and report back' })
await until(() => events.b.some(e => e.content.includes('squid migration')))
assert.equal(events.b.find(e => e.meta.msg_id).meta.from, inv.name)

// the code is single-use
const reuse = await b.client.callTool({ name: 'clawkie_join', arguments: { name: inv.name, code: inv.code } })
assert(reuse.isError)

// hooks: SessionStart names the session and lists peers; Stop nudges once about the unanswered request
const hook = (event, input) => JSON.parse(execFileSync('node', ['clawkie.js', 'hook', event], {
  input: JSON.stringify(input), env: { ...process.env, HOME: home, CLAWKIE_ID: 'b' },
}).toString() || '{}')
const start = hook('session-start', { cwd: '/x' })
assert.equal(start.hookSpecificOutput.sessionTitle, bName)
assert.match(start.hookSpecificOutput.additionalContext, new RegExp(inv.name))
assert.match(hook('stop', { cwd: '/x' }).hookSpecificOutput.additionalContext, new RegExp(inv.name))
assert.deepEqual(hook('stop', { cwd: '/x' }), {}) // only once
await b.call('clawkie_send', { to: inv.name, text: 'done' })
await until(() => events.a.some(e => e.content === 'done'))

console.log('ok: pair, status, send, single-use invite, hooks')
await a.client.close(); await b.client.close()
process.exit(0)
