# TermChat — a live chatroom in every terminal

**TermChat** is a real-time, multi-room, guest-access chatroom that you can join from a
native CLI, a zero-install HTTPS terminal, or any web browser — no accounts, no setup,
and nothing to install for two of the three entry methods.

Live deployment: **[https://tchat.space-z.ai](https://tchat.space-z.ai)**

```
┌────────────┐   ┌──────────────────┐   ┌───────────────┐
│  tchat CLI │   │ curl | bash      │   │ Browser       │
│  (native)  │   │ iex (irm …/p)    │   │ /r/ROOM       │
└─────┬──────┘   └────────┬─────────┘   └──────┬────────┘
      │ WebSocket (socket.io)  │ HTTPS SSE + POST │ WebSocket
      └────────────┬──────────┴───────────────────┘
                   ▼
         ┌─────────────────────┐        ┌──────────────────┐
         │  chat-service       │◄───────│  ssh-service     │
         │  :3003 ws + :3004   │  :2222 │  (optional SSH   │
         │  SSE bridge         │        │   bridge)        │
         └─────────────────────┘        └──────────────────┘
```

---

## Three ways in

Pick whichever fits the moment — all three land in the **same rooms, in real time**.

| # | Method | Needs | Command |
|---|--------|-------|---------|
| 1 | **Native CLI** — best experience | nothing pre-installed | `curl -fsSL https://tchat.space-z.ai/i.sh \| sh` · `irm https://tchat.space-z.ai/i.ps1 \| iex` |
| 2 | **HTTPS terminal** — zero install | `curl` or PowerShell only | `curl -fsSL https://tchat.space-z.ai/g \| bash` · `iex (irm https://tchat.space-z.ai/p)` |
| 3 | **Web** — no terminal at all | any browser | open `https://tchat.space-z.ai/r/lobby` (or `/r/ROOMCODE`) |

### 1 · Native CLI — `tchat`

One short install, then joining any room is a single word:

```sh
# macOS / Linux
curl -fsSL https://tchat.space-z.ai/i.sh | sh

# Windows PowerShell
irm https://tchat.space-z.ai/i.ps1 | iex
```

```sh
tchat join 7XK92     # join (or invent) room 7XK92
tchat 7XK92          # short form
tchat 7XK92 -n Sam   # with a guest name
tchat                # interactive: prompts for room + name
```

The installer ships a **single native binary** (linux-x64, darwin-x64/arm64,
windows-x64) — there is **no Node.js, no npm, no runtime** to install. It lands in
`~/.local/bin` (or `%LOCALAPPDATA%\Programs\TermChat` on Windows) and the installer
configures your PATH automatically. Re-run the installer any time to update.

### 2 · HTTPS terminal — nothing to install

Where you can't (or don't want to) install anything, TermChat runs on **pure HTTPS**
using only tools your OS already ships:

```sh
# macOS / Linux / WSL — run it straight from the pipe
curl -fsSL https://tchat.space-z.ai/g | bash

# join a specific room
curl -fsSL https://tchat.space-z.ai/g | ROOM=7XK92 bash
```

```powershell
# Windows PowerShell 5.1+ / 7+
iex (irm https://tchat.space-z.ai/p)

# join a specific room
$env:TCHAT_ROOM='7XK92'; iex (irm https://tchat.space-z.ai/p)
```

This is the recommended path on **locked-down hosts and networks where SSH ports are
blocked** — it is a live, streaming terminal chat that works anywhere HTTPS works.

> **Note for the curious:** piping `curl` into `bash` normally breaks interactive
> prompts (stdin is the script text). `g.sh` detects this and moves its interactive
> reads to `/dev/tty`, so the piped one-liner works like a locally saved script.

### 3 · Web — no terminal needed

Open **`https://tchat.space-z.ai/r/anything`** — the room code is the URL. Share the
link and the whole room joins you. The home page embeds the same live chat, so you can
try it immediately.

---

## Rooms and names

- A **room code** is free-form: `7XK92`, `team`, `family` — whatever you invent.
  Room codes are **case-insensitive** (`7xk92` = `7XK92`).
- **Names are unique per room** (2–20 chars). If a name is taken, the server suggests
  a free alternative.
- Room codes are just the **username** for the SSH bridge (`ssh 7XK92@your-host`) —
  see [docs/SELF-HOSTING.md](docs/SELF-HOSTING.md).

## In-room commands

| Command | Action |
|---------|--------|
| `/nick <name>` | rename yourself |
| `/me <action>` | send an emote (`/me waves`) |
| `/users` | list everyone in this room |
| `/rooms` | list active rooms + headcounts (CLI / SSH) |
| `/clear` | clear the terminal screen |
| `/url` | show server + room you are on |
| `/help` | command help |
| `/quit` | leave the room |

---

## Features

- **Real-time fan-out** — messages appear instantly on every connected CLI, HTTPS
  terminal and browser in the room.
- **Rooms** — unlimited, implicit (created on first join), auto-pruned when empty;
  presence and history are scoped per room.
- **History** — last 20 messages replayed on join, 50 kept per room.
- **Cross-transport** — native CLI (WebSocket), zero-install terminal (SSE + POST),
  browser (WebSocket) and SSH bridge are all first-class citizens of the same room.
- **No rate limiting** — chat freely; capacity caps (200 concurrent clients) exist only
  as resource protection.
- **Zero-dependency clients** — the CLI is a self-contained native binary; the
  HTTPS-terminal client needs nothing but `curl`/PowerShell.
- **Deterministic name colors** in terminals; dark-first web UI.

## How it works

TermChat is three small moving parts (see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
for the full picture):

1. **`mini-services/chat-service`** — a Bun + socket.io server (:3003) with a
   plain-HTTP **SSE bridge** (:3004) so even `curl` can be a first-class chat client.
   Multi-room registry, per-room history, presence, name validation.
2. **Clients** — `scripts/chat-client-entry.ts` is bundled two ways:
   - `bun build --compile` → **native single-file binaries** (installed by `i.sh` / `i.ps1`),
   - `bun build --target=node --format=cjs` → `public/chat.cjs`, a zero-dependency
     223 KB script (`curl …/c | node` also works).
3. **Web app** — Next.js (App Router) landing page + `/r/[room]` room pages sharing the
   same rooms over socket.io.

Short public endpoints: `/i.sh`, `/i.ps1` (installers), `/g` (shell client), `/p`
(PowerShell client), `/c` (Node client), `/r/<room>` (web rooms).

## Repo layout

```
├── src/app/               # landing page, /r/[room] pages, /i.sh + /i.ps1 routes
├── src/components/        # BrowserChat + shadcn/ui primitives
├── mini-services/
│   ├── chat-service/      # socket.io (:3003) + SSE bridge (:3004) — the chat core
│   └── ssh-service/       # optional SSH bridge (:22/:2222) — username = room code
├── scripts/
│   ├── chat-client-entry.ts   # the terminal client source (CLI + SSH share logic)
│   ├── build-client.sh        # native + CJS bundling
│   └── test-*.ts              # E2E suites (80 assertions total)
├── public/                # served assets: installers, zero-install clients, chat.cjs
└── docs/                  # ARCHITECTURE · SELF-HOSTING · PROTOCOL
```

## Run it yourself

```sh
# 1. the chat core
cd mini-services/chat-service && bun install && bun run dev     # :3003 + :3004

# 2. the web app
bun install && bun run dev                                      # :3000

# 3. (optional) the SSH bridge
cd mini-services/ssh-service && bun install && bun run dev       # :2222 (root: :22)
```

Full deployment guide — including a real-SSH setup and notes for HTTPS-only hosts —
in **[docs/SELF-HOSTING.md](docs/SELF-HOSTING.md)**.

## Testing

The repo ships three E2E suites plus a bundled-client check (all run against the real
services):

```sh
bun scripts/test-chat-e2e.ts        # 41 assertions: rooms, names, SSE bridge, isolation
bun scripts/test-multi-terminal.ts  # 21: real install.sh → native binary ↔ node ↔ curl ↔ socket
bun scripts/test-ssh.ts             # 12: real ssh2 sessions against the SSH bridge
bun scripts/test-bundled-client.ts  #  6: the actual public/chat.cjs subprocess
```

## Security notes

- Guests are anonymous by design; there are no passwords and no persistence beyond
  in-memory history. Don't send secrets to public rooms.
- The SSH bridge performs **no authentication** (any username/password is accepted) —
  it is a guest chat door, not a shell. It never grants shell access.
- Installers fetch binaries only from the host you point them at
  (`TCHAT_DOWNLOAD_BASE` to override).

## License

[MIT](LICENSE) © mythz-art
