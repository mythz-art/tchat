# Architecture

## Overview

TermChat is a small constellation of services around one room registry:

```
                      internet (HTTPS only)
                              │
                ┌─────────────▼──────────────┐
                │   reverse proxy / gateway  │   (Caddy in the reference
                │   TLS termination          │    deployment, see Caddyfile)
                └──┬────────┬────────┬───────┬┘
     static + pages │        │ ?XTransformPort=3003   │ ?XTransformPort=3004
                   ▼        ▼                        ▼
            ┌──────────┐ ┌──────────────┐    ┌─────────────┐
            │ Next.js  │ │ chat-service │    │ SSE bridge  │
            │ :3000    │ │ socket.io    │    │ (same proc, │
            │ / + /r/* │ │ :3003        │    │  :3004)     │
            └──────────┘ └──────┬───────┘    └──────┬──────┘
                                │   one shared rooms Map  │
                                └────────────┬────────────┘
                                             ▼
                                  ┌─────────────────────┐
                                  │ ssh-service :22/2222│
                                  │ socket.io client →  │
                                  │ chat-service        │
                                  └─────────────────────┘
```

## Components

### 1 · chat-service (`mini-services/chat-service/index.ts`)

A single Bun process exposing two transports over **one shared room registry**:

- **socket.io on :3003** (`path: '/'`) — used by the native CLI, `chat.cjs` and the
  browser. Events: `join`, `message`, `action`, `nick`, `users`, `rooms` in;
  `joined`, `message`, `system`, `users-list`, `presence`, `name-rejected`,
  `renamed`, `rooms-list`, `kicked`, `error` out. See [PROTOCOL.md](PROTOCOL.md).
- **SSE bridge on :3004** — plain HTTP so `curl` can play:
  - `GET /stream?name=X&room=Y` → `text/event-stream`, one `data:` line per event
    (server renders ANSI-free plain text),
  - `POST /send` (`name`, `text`, `room?`) — form or JSON; sender must have an open
    stream; ambiguous cross-room names are rejected with `409` + room hint,
  - `GET /health` — JSON summary of rooms/occupancy.

Key behaviors: room codes case-insensitive (label preserved), names unique **per
room** (2–20 chars, Unicode letters allowed, control chars stripped), duplicate-name
rejection includes a `freeSuggestion`, last-20 history replay on join (50 kept),
`/me` `/nick` `/quit` handled server-side on the SSE bridge, presence counts per room
+ global, **no rate limiting** (200-client capacity cap is resource protection only),
SIGTERM/SIGINT graceful shutdown.

### 2 · Clients (`scripts/chat-client-entry.ts`)

One TypeScript source, two bundle shapes (`scripts/build-client.sh`):

- **Native binaries** — `bun build --compile` per target
  (`tchat-linux-x64`, `tchat-darwin-arm64`, `tchat-darwin-x64`,
  `tchat-windows-x64.exe`), gzipped into `public/dl/` and installed by the
  installers. Zero runtime dependencies.
- **`public/chat.cjs`** — `bun build --target=node --format=cjs` (~223 KB,
  zero-dependency CJS with shebang) for `curl …/c | node`.

Client features: room-code arguments (`tchat join R`, `tchat R`, bare `tchat`),
`-n NAME`, `-s URL`, `/rooms`, deterministic per-user ANSI palette, message printing
above the input line, infinite auto-reconnect + rejoin, early-typed-input buffering,
gateway-aware URL normalization.

### 3 · Zero-install terminal clients

- **`public/g.sh`** — POSIX sh + curl. A background `curl -Ns` SSE receiver prints
  lines; the foreground loop POSTs to `/send`. Piped execution (`curl | bash`) is
  handled by moving interactive reads to `/dev/tty` (falling back to stdin for
  scripted runs). Room via `ROOM=` / `TCHAT_ROOM=`.
- **`public/p.txt`** — PowerShell 5.1+/7+. A runspace streams curl.exe SSE to the
  console while the main thread runs a non-blocking key reader (Enter/Backspace/
  Ctrl+C). Room via `TCHAT_ROOM=`. Works over plain HTTPS only.

### 4 · ssh-service (`mini-services/ssh-service/index.ts`) — optional

A guest SSH door, not a shell: any username/password is accepted, the **username is
the room code**. Each SSH session gets a PTY-driven line editor bridged to the chat
via a socket.io client connection to chat-service. Host key: RSA PKCS#1 (ssh2 cannot
parse PKCS#8 ed25519), auto-generated at `mini-services/ssh-service/hostkey.pem`
(0600) on first start, `SSH_HOSTKEY` to override. Probes port 22 first, falls back to
**:2222** without root. Session cap 100.

> Managed PaaS hosts often expose **only HTTP/HTTPS** — there, SSH is unreachable
> regardless of configuration, and the HTTPS terminal (`/g`, `/p`) is the zero-install
> equivalent. Self-host on a host with an open port 22 to use real SSH.

### 5 · Web app (`src/`)

- `/` — landing page: the three ways in with copy buttons, live presence badge,
  embedded browser chat (same rooms).
- `/r/[room]` — room page: locked room, per-room invites, live chat.
- `/i.ps1`, `/i.sh` route handlers serve the installers as `text/plain` (Windows
  PowerShell 5.1's `Invoke-RestMethod` returns `byte[]` for `application/octet-stream`,
  which would break `| iex`).
- The UI is dark-first; `globals.css` defines the theme via `.dark` on `<html>` and
  `color-scheme: dark`.

## The gateway pattern

In the reference deployment, public traffic flows through Caddy (:81) which routes to
mini-services by the `?XTransformPort=NNNN` query parameter; static assets and pages
are served by Next.js. All clients therefore talk **plain HTTPS/WSS** with that query
hint appended (see `normalizeServerUrl()` in the client and the `X` constant in
`g.sh`). When self-hosting behind your own proxy, the parameter is unnecessary —
see [SELF-HOSTING.md](SELF-HOSTING.md).

## Capacity & limits

| Limit | Value | Purpose |
|-------|-------|---------|
| socket.io clients | 200 | resource protection |
| SSH sessions | 100 | resource protection |
| history per room | 50 (20 replayed) | context on join |
| message length | 500 chars | abuse ceiling |
| name / room length | 20 / 24 chars | layout sanity |
| rate limiting | **none** | by design |
