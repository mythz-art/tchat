# Self-hosting guide

TermChat is four small processes. This guide runs it locally first, then puts it
behind a real domain — with and without the reference Caddy gateway.

## Prerequisites

- [Bun](https://bun.sh) ≥ 1.1 (runtime + bundler)
- That's it. Clients need nothing (native binary) or curl/PowerShell (zero-install).

## 1 · Run the chat core

```sh
cd mini-services/chat-service
bun install
bun run dev            # socket.io :3003 + SSE bridge :3004
```

Environment: none required. Both ports bind `0.0.0.0`.

## 2 · Run the web app

```sh
# repo root
bun install
bun run dev            # :3000
```

The landing page talks to the chat core at `/?XTransformPort=3003` (see
[ARCHITECTURE.md](ARCHITECTURE.md)). For a plain reverse proxy without the gateway
parameter, set the socket path in `src/components/BrowserChat.tsx` and
`normalizeServerUrl()` in `scripts/chat-client-entry.ts` to your proxied path, then
rebuild the clients (`bash scripts/build-client.sh`).

## 3 · (Optional) the SSH bridge

```sh
cd mini-services/ssh-service
bun install
bun run dev            # probes :22, falls back to :2222 without root
```

- `ssh <roomcode>@your-host` — any password (or none) walks straight into the room.
- The host key is generated on first start at
  `mini-services/ssh-service/hostkey.pem` (RSA PKCS#1, chmod 0600). Point
  `SSH_HOSTKEY=/path/key` elsewhere if you like.
- To serve SSH on the standard port without running the service as root:
  ```sh
  sudo setcap cap_net_bind_service=+ep "$(which bun)"
  ```
- **HTTPS-only platforms** (many managed PaaS hosts publish just 80/443) cannot
  expose port 22 at all — the SSH door will time out from outside no matter what the
  service does. On those hosts, point users at the zero-install HTTPS terminal
  (`/g`, `/p`), which needs nothing but curl/PowerShell.

## 4 · Put it on a domain

### Option A — the reference Caddy gateway (zero-config clients)

The bundled `Caddyfile` listens on :81 and forwards to mini-services based on the
`?XTransformPort=` query parameter, keeping every client URL short and uniform:

```
curl -fsSL https://your-host/i.sh | sh
```

Terminate TLS in front (Caddy itself, or your platform's edge).

### Option B — your own reverse proxy (nginx/caddy/traefik)

Route by path and drop the `XTransformPort` parameter:

| Path | Upstream |
|------|----------|
| `/socket.io/` (WS upgrade) | `chat-service :3003` |
| `/stream`, `/send`, `/health` | `SSE bridge :3004` |
| `/r/*`, `/`, static | `Next.js :3000` |

Then rebuild clients with `TCHAT_URL=https://your-host bash scripts/build-client.sh`
so the baked-in default URL matches your domain.

## 5 · Installers & public endpoints

| Endpoint | Serves |
|----------|--------|
| `/i.sh` , `/install.sh` | POSIX installer (linux/darwin native binary) |
| `/i.ps1` , `/install.ps1` | PowerShell installer (windows/linux/darwin), `text/plain` |
| `/g` | zero-install shell client |
| `/p` | zero-install PowerShell client |
| `/c` | zero-dependency `chat.cjs` for `curl \| node` |
| `/r/<room>` | web room |
| `/version.txt` | current client version (installers use it to skip re-downloads) |

## 6 · Build the native clients yourself

```sh
bash scripts/build-client.sh
```

Produces `tchat-linux-x64`, `tchat-darwin-arm64`, `tchat-darwin-x64`,
`tchat-windows-x64.exe` (gzipped, in `public/dl/`) plus a refreshed
`public/chat.cjs`, and bumps `public/version.txt` if `VERSION` is set:

```sh
VERSION=1.2.3 bash scripts/build-client.sh
```

The installers download exactly these files from `TCHAT_DOWNLOAD_BASE`
(default: the live host), so a self-hosted deployment should build and ship its own
binaries.

## 7 · Environment variables

| Variable | Where | Default | Meaning |
|----------|-------|---------|---------|
| `TCHAT_URL` | g.sh / p.txt | live host | override chat host |
| `TCHAT_ROOM` / `ROOM` | g.sh | `lobby` | room to join |
| `TCHAT_ROOM` | p.txt | `lobby` | room to join |
| `TCHAT_DOWNLOAD_BASE` | installers | live host | where to fetch binaries |
| `TCHAT_INSTALL_DIR` | installers | `~/.local/bin` / `%LOCALAPPDATA%\…` | install target |
| `SSH_HOSTKEY` | ssh-service | `./hostkey.pem` | host key path |
| `CHAT_URL` / argv | chat.cjs | live host | server URL |

## 8 · Operations notes

- Everything is **in-memory** — restarts clear history and presence by design.
- Capacity caps: 200 chat clients, 100 SSH sessions (see ARCHITECTURE.md).
- No rate limiting is enforced; put your own at the proxy if you expect abuse.
- The SSH bridge never grants shell access and accepts any credentials — treat it as
  a public guest door.
