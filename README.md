# Remote Agent Runtime

A self-hosted gateway that puts a terminal-based AI coding agent behind a mobile web client.

Coding agents like Claude Code run only on the machine they're installed on. This project wraps one in a host agent, brokers it through a small stateless relay, and exposes it as a chat interface you can drive from a phone — with file upload/download, persistent conversations, and multi-user access control.

## Architecture

```
   phone / browser
        │  WebSocket  (role=client)
        ▼
┌────────────────────┐
│  relay  (public)   │   stateless broker, ~180 LOC
│  token-scoped      │   one host ⇄ many clients
│  rooms             │   also proxies file downloads over HTTP
└────────────────────┘
        ▲
        │  WebSocket  (role=host)  ← host dials OUT
┌────────────────────┐
│  host agent        │   spawns the agent CLI
│  (desktop)         │   parses its streaming JSON events
└────────────────────┘
        │
        ▼
   agent CLI  (--output-format stream-json)
```

**The host connects outbound.** It is never listened to. That means the machine running the agent needs no inbound port, no port forwarding, and no firewall exception — the relay only ever sees a connection the host chose to open.

The relay holds no state beyond in-memory room routing. Everything durable — conversations, files, sessions — lives on the host.

## How it works

**Host agent** (`server.js`)
- Spawns the agent CLI with `--output-format stream-json` and parses the line-delimited event stream
- Forwards assistant text and tool-use events to clients as they arrive
- Resumes prior sessions via the CLI's `--resume <session_id>`
- Per-conversation working directories, each git-backed
- Multi-user auth with role-based access control and per-user data isolation
- Ephemeral ("incognito") conversations with a kill switch that purges them from disk and version control

**Relay** (`relay/server.js`)
- Token-scoped rooms map one `host` socket to N `client` sockets
- Replaces a host cleanly on reconnect, with an identity guard so a stale socket's close handler can't clear a freshly reconnected host
- Proxies file downloads: streams base64 chunks from the host and reassembles them into HTTP chunked transfer encoding
- 20s keepalive ping, added after diagnosing platform idle-timeout disconnects

**Client** (`relay/index.html`)
- Single-page vanilla JS. Chat list, search, file attachments, conversation rename/delete, storage gauge.

`public/index.html` is the earlier local-only client, served straight off the host before the relay existed. Kept because it still works if you only ever reach the host on your own network and want to skip the relay entirely.

## Things that turned out to matter

- **Reconnect races.** When the host reconnects, the *old* socket's `close` handler fires after the new one registers. Without an identity check it nulls out the live host. One line, non-obvious bug.
- **Idle timeouts.** Cloud platforms drop quiet WebSockets. Keepalive pings, not reconnect logic, were the fix.
- **`ENAMETOOLONG`.** Long prompts passed as CLI arguments hit the OS argument-length limit. Piping via stdin removed the ceiling entirely.
- **Terminal output is not text.** ANSI escape sequences — including extended CSI parameters — have to be stripped before anything reaches a browser.

## Running it

```bash
npm install

# relay (deploy anywhere that speaks WebSocket)
node relay/server.js

# host (on the machine with the agent CLI installed)
ADMIN_PASS=... USER_PASS=... RELAY_URL=wss://your-relay RELAY_TOKEN=... node server.js
```

| Variable | Purpose |
|---|---|
| `RELAY_URL` | WebSocket URL of the relay |
| `RELAY_TOKEN` | Shared room token — host and client must match |
| `ADMIN_PASS` | Password for the admin account |
| `USER_PASS` | Password for the standard account |
| `PORT` | Relay listen port (default 3580) |

Credentials are read from the environment. Nothing is committed.

## Notes and known limitations

- Password hashing is SHA-256 with a fixed salt. It should be argon2 or bcrypt — SHA-256 is fast by design, which is the opposite of what password hashing wants.
- The host runs the agent CLI with permission prompts disabled. Appropriate for a single-operator setup; not for shared or untrusted use.
- The relay trusts anyone holding the room token. There is no per-client authorization at the relay layer — that is enforced on the host.

## About this repository

Published as a clean snapshot. The original working repository carried 174 commits over five weeks
of daily use, along with conversation data, logs, and personal files that do not belong in public.
Rather than rewrite that history, this repo contains the source only, squashed to a single commit.

## Stack

Node.js · Express · `ws` · `node-pty` · vanilla JS
