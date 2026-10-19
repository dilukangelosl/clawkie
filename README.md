<p align="center"><img src="assets/logo.png" width="160" alt="Clawkie logo"></p>

# Clawkie

A walkie-talkie for your Claude Code agents. Claude Code sessions on different machines (laptop, VM, servers) working on the same project pair up, see what each other is doing, and pass prompts and results back and forth, so you stop copy-pasting between terminals.

```
laptop (brave-otter)  ──"run the squid migration, report back"──▶  vm (rusty-falcon)
                      ◀──"done: 3 migrations applied, please verify"──
```

## Setup (each machine)

Needs Node 22+ and Claude Code logged in with claude.ai.

```bash
claude plugin marketplace add dilukangelosl/clawkie
claude plugin install clawkie@clawkie
```

Then start Claude Code with the channel on, so incoming messages wake Claude up. Add an alias so every session gets it:

```bash
alias claude='claude --dangerously-load-development-channels plugin:clawkie@clawkie'
```

(The flag is needed while Claude Code channels are in research preview and Clawkie isn't on the allowlist. Without it, everything still works, but Claude only sees messages when it calls `clawkie_inbox`.)

No plugin? `claude mcp add -s user clawkie -- npx -y clawkie` gives you the tools without the hooks.

## What happens on every session

- **Session start (hook):** the session gets its name (e.g. `brave-otter`, also set as the session title), and Claude is told its rules, its mode, and which paired sessions are online and what they're doing.
- **Incoming message (channel):** a peer's prompt lands straight in the session.
- **Before Claude stops (hook):** if a peer sent work and Claude hasn't reported back, it gets one nudge to `clawkie_send` the result.

## Pairing

1. In session A: *"clawkie invite"* → shows e.g. `brave-otter · 482913` (valid 10 min, single use).
2. In session B: *"clawkie join brave-otter 482913"*.

They're now in one group. Pair more sessions the same way. *"clawkie leave"* unpairs.

## Modes

- **ask** (default): when a peer sends work, Claude shows you who sent it and what it is, and waits for your yes.
- **auto**: Claude acts right away (your normal tool permissions still apply).

Switch in `/config` (Clawkie → Mode), or `CLAWKIE_MODE=auto` for the plain MCP setup. No tool can change it, so a peer message can't talk a session into auto.

## Tools

`clawkie_whoami` · `clawkie_invite` · `clawkie_join` · `clawkie_send` · `clawkie_status` · `clawkie_peers` · `clawkie_inbox` · `clawkie_leave`

Built-in instructions tell every session to report back with `clawkie_send` when it finishes a peer's task, and to keep its `clawkie_status` line current.

## How it works

- `clawkie.js`: zero-dependency local MCP server per session, and the plugin's hooks (`clawkie.js hook session-start|stop`). Gets a name (`adjective-animal`) on first run and stores it in `~/.clawkie/` per working directory (`CLAWKIE_ID` to override). Holds a WebSocket to the relay and pushes messages into Claude Code as channel events.
- `relay/`: Cloudflare Worker + one SQLite Durable Object. Stores sessions (token hashed), groups, invites, and undelivered messages until they're acked.

## Dev

```bash
npm run dev                                   # relay on :8787
CLAWKIE_URL=http://localhost:8787 npm test    # two real sessions pair + message end-to-end
npm run deploy
```

Release to npm: bump `version` in `package.json` and `.claude-plugin/plugin.json`, then `git tag v<version> && git push --tags`. GitHub Actions tests against the live relay and publishes.
