/**
 * TermChat — SSH transport service
 *
 *   ssh <ROOM>@tchat.space-z.ai        (room code = SSH username, any password / none)
 *
 * Every SSH session becomes a chat client bridged to the chat service
 * (socket.io on :3003). Zero install on the guest side — any SSH client works.
 *
 * Port: tries 22 first (needs root); falls back to 2222 when not privileged.
 *   ssh -p 2222 <ROOM>@tchat.space-z.ai
 */

import { Server, type ClientInfo } from 'ssh2'
import { generateKeyPairSync } from 'crypto'
import { existsSync, readFileSync, writeFileSync, chmodSync } from 'fs'
import { io as sio, type Socket } from 'socket.io-client'

const CHAT_URL = process.env.CHAT_SVC_URL || 'http://localhost:3003'
const PREF_PORT = Number(process.env.SSH_PORT || 22)
const FALLBACK_PORT = Number(process.env.SSH_FALLBACK_PORT || 2222)
const MAX_SESSIONS = 100
const KEY_PATH = process.env.SSH_HOSTKEY || new URL('./hostkey.pem', import.meta.url).pathname

/* ------------------------------- shared helpers ------------------------------- */

const R = '\x1b[0m'
const DIM = '\x1b[2m'
const BOLD = '\x1b[1m'
const CYAN = '\x1b[36m'
const GREEN = '\x1b[32m'
const YELLOW = '\x1b[33m'
const MAGENTA = '\x1b[35m'
const RED = '\x1b[31m'
const WHITE = '\x1b[37m'
const PALETTE = [CYAN, MAGENTA, GREEN, YELLOW, '\x1b[96m', '\x1b[95m', '\x1b[92m', '\x1b[93m', WHITE]

function colorFor(name: string): string {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  return PALETTE[h % PALETTE.length]
}

function stripUnsafe(s: string): string {
  return String(s).replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028\u2029]/g, '')
}

function hhmm(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}

const ROOM_RE = /^[A-Za-z0-9][A-Za-z0-9 _.\-]*$/
const MAX_ROOM_LEN = 24
const DEFAULT_ROOM = 'lobby'

function cleanText(input: unknown, maxLen: number): string {
  if (typeof input !== 'string') return ''
  return input.replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028\u2029]/g, '').trim().slice(0, maxLen).trimEnd()
}

function resolveRoom(raw: unknown): { key: string; label: string } {
  const label = cleanText(raw, MAX_ROOM_LEN)
  if (label && ROOM_RE.test(label)) return { key: label.toLowerCase(), label }
  return { key: DEFAULT_ROOM, label: DEFAULT_ROOM }
}

/* ---------------------------------- host key ---------------------------------- */

function loadOrCreateHostKey(): string {
  try {
    if (existsSync(KEY_PATH)) return readFileSync(KEY_PATH, 'utf8')
  } catch {}
  // ssh2's parser needs PKCS#1 RSA PEM (PKCS#8 ed25519 is not supported by it)
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString()
  try {
    writeFileSync(KEY_PATH, pem)
    chmodSync(KEY_PATH, 0o600)
  } catch {}
  return pem
}

/* -------------------------------- chat bridge --------------------------------- */

interface SessionHandle {
  sock: Socket | null
}

function bridgeSession(stream: any, roomLabel: string, onEnd: () => void) {
  const write = (s: string) => {
    try {
      stream.write(s)
    } catch {}
  }
  let state: 'naming' | 'chatting' = 'naming'
  let myName = ''
  let lineBuf = ''
  let promptText = ''
  let closed = false

  const sock: Socket = sio(CHAT_URL, {
    path: '/',
    transports: ['websocket', 'polling'],
    reconnection: false,
    timeout: 8000,
    forceNew: true,
  })

  const render = (m: { kind: string; subtype?: string; from?: string; text: string; ts: number }) => {
    const t = stripUnsafe(m.text)
    const stamp = `${DIM}${hhmm(m.ts)}${R}`
    if (m.kind === 'chat') {
      const name = stripUnsafe(m.from || '?')
      const c = name === myName ? `${BOLD}${GREEN}` : colorFor(name)
      printLine(`${stamp}  ${c}${name}${R}: ${t}`)
    } else if (m.kind === 'action') {
      const name = stripUnsafe(m.from || '?')
      const c = name === myName ? `${BOLD}${GREEN}` : colorFor(name)
      printLine(`${stamp}  ${DIM}* ${c}${name}${R} ${DIM}${t}${R}`)
    } else {
      const color = m.subtype === 'kick' ? RED : m.subtype === 'info' ? DIM : YELLOW
      printLine(`${stamp}  ${color}— ${t}${R}`)
    }
  }

  const setPrompt = (p: string) => {
    promptText = p
    write(p)
  }

  const printLine = (line: string) => {
    write(`\r\x1b[K${line}\r\n`)
    if (promptText) write(promptText)
  }

  write(`\x1b[2J\x1b[H`)
  write(`${GREEN}${BOLD}  TermChat over SSH${R}\r\n`)
  write(`  ${DIM}room ${R}${CYAN}${BOLD}${roomLabel}${R}${DIM} · no account needed · type /quit to leave${R}\r\n\r\n`)
  setPrompt(`${BOLD}guest name:${R} `)

  const submit = (raw: string) => {
    const line = stripUnsafe(raw).trim()
    if (state === 'naming') {
      if (!line) {
        printLine(`${RED}A name is required to join.${R}`)
        setPrompt(`${BOLD}guest name:${R} `)
        return
      }
      myName = line.slice(0, 20)
      write(`${DIM}connecting…${R}\r\n`)
      sock.emit('join', { name: myName, room: roomLabel })
      return
    }
    if (!line) return setPrompt(promptText)
    if (line.startsWith('/')) {
      const [cmd, ...rest] = line.slice(1).split(/\s+/)
      const argStr = rest.join(' ')
      switch ((cmd || '').toLowerCase()) {
        case 'help':
          printLine(`  ${DIM}/nick <name> | /me <action> | /users | /rooms | /history [n] | /clear | /quit${R}`)
          break
        case 'nick':
          if (argStr) sock.emit('nick', { name: argStr })
          else printLine(`  ${YELLOW}Usage: /nick <new-name>${R}`)
          break
        case 'me':
          if (argStr) sock.emit('action', { text: argStr })
          else printLine(`  ${YELLOW}Usage: /me <action>${R}`)
          break
        case 'users':
        case 'who':
          sock.emit('users')
          break
        case 'rooms':
          sock.emit('rooms')
          break
        case 'history': {
          const n = Math.min(100, Math.max(1, parseInt(argStr, 10) || 30))
          if (histInFlight) {
            printLine(`  ${DIM}history page already in flight…${R}`)
            break
          }
          histInFlight = true
          sock.emit('history', { before: histCursor ?? undefined, limit: n })
          break
        }
        case 'clear':
          write('\x1b[2J\x1b[H')
          break
        case 'url':
          printLine(`  ${DIM}${CHAT_URL} (room ${roomLabel})${R}`)
          break
        case 'quit':
        case 'exit':
          printLine(`${DIM}Bye!${R}`)
          end(0)
          return
        default:
          printLine(`  ${YELLOW}Unknown command /${cmd}. Type /help.${R}`)
      }
    } else {
      sock.emit('message', { text: line.slice(0, 500) })
    }
    setPrompt(promptText)
  }

  const end = (code: number) => {
    if (closed) return
    closed = true
    try {
      sock.disconnect()
    } catch {}
    try {
      stream.end()
      stream.exit?.(code)
      stream.close?.()
    } catch {}
    onEnd()
  }

  sock.on('connect', () => {
    if (state === 'naming' && myName) sock.emit('join', { name: myName, room: roomLabel })
  })

  sock.on('joined', (info: any) => {
    state = 'chatting'
    myName = info.you
    write('\r\x1b[1A\r\x1b[K') // wipe the "connecting…" line
    printLine(`${GREEN}${BOLD}Connected to room ${info.room || roomLabel} as ${info.you}${R}`)
    printLine(`  ${DIM}${info.count} guest(s) here: ${(info.users || []).map((u: any) => u.name).join(', ')}${R}`)
    if (Array.isArray(info.history) && info.history.length) {
      printLine(`  ${DIM}—— recent messages ————${R}`)
      for (const m of info.history) render(m)
      printLine(`  ${DIM}———————————————————————${R}`)
      // v3.1: remember the oldest seq we rendered — /history pages above it.
      const first = info.history[0]
      if (first && typeof first.seq === 'number') histCursor = first.seq
      if (info.hasMore) printLine(`  ${DIM}older messages on record — /history to load more${R}`)
    }
    printLine(`  ${DIM}Type /help for commands.${R}`)
    setPrompt(`${GREEN}${BOLD}${myName}${R} ${DIM}@${info.room || roomLabel}${R} ${GREEN}>${R} `)
  })

  sock.on('name-rejected', (d: { reason: string }) => {
    printLine(`${RED}${d.reason}${R}`)
    state = 'naming'
    myName = ''
    setPrompt(`${BOLD}guest name:${R} `)
  })

  sock.on('message', (m: any) => render(m))
  sock.on('system', (m: any) => render(m))

  // Lazy history (v3.1): /history pages OLDER messages downward from the
  // oldest message rendered so far (cursor = its seq).
  let histCursor: number | null = null
  let histHasMore = false
  let histInFlight = false
  sock.on('history-page', (d: { messages?: any[]; hasMore?: boolean }) => {
    histInFlight = false
    const page = (d.messages || []).filter(m => m && typeof m.seq === 'number')
    histHasMore = !!d.hasMore
    if (!page.length) {
      printLine(`  ${DIM}no older messages on record${R}`)
      return
    }
    histCursor = page[0].seq
    printLine(`  ${DIM}—— ${page.length} older message(s) ——${R}`)
    for (const m of page) render(m)
    printLine(histHasMore ? `  ${DIM}··· /history for more${R}` : `  ${DIM}··· start of history${R}`)
  })

  sock.on('users-list', (d: { users: { name: string }[]; count: number }) => {
    printLine(`  ${DIM}${d.count} in this room: ${(d.users || []).map(u => u.name).join(', ') || '(nobody)'}${R}`)
  })

  sock.on('rooms-list', (d: { rooms: { key: string; label: string; users: number }[]; total: number }) => {
    printLine(`  ${DIM}${d.total} guest(s) across ${d.rooms.length} room(s):${R}`)
    for (const r of d.rooms) printLine(`  ${CYAN}${r.label.padEnd(16)}${R} ${DIM}${r.users} online${R}`)
  })

  sock.on('error', (d: { text: string }) => printLine(`${YELLOW}${d.text}${R}`))

  sock.on('connect_error', (err: Error) => {
    printLine(`${RED}Could not reach the chat service (${err.message}). Goodbye.${R}`)
    end(1)
  })

  sock.on('disconnect', reason => {
    if (closed || reason === 'io client disconnect') return
    printLine(`${RED}Disconnected from the room. Goodbye.${R}`)
    end(1)
  })

  /* ---- PTY line editing ---- */
  stream.on('data', (chunk: Buffer) => {
    const s = chunk.toString('utf8')
    for (const ch of s) {
      if (ch === '\r' || ch === '\n') {
        write('\r\n')
        const line = lineBuf
        lineBuf = ''
        submit(line)
        if (closed) return
      } else if (ch === '\x7f' || ch === '\b') {
        if (lineBuf.length > 0) {
          lineBuf = lineBuf.slice(0, -1)
          write('\b \b')
        }
      } else if (ch === '\x03') {
        // Ctrl+C
        write('^C\r\n')
        printLine(`${DIM}Bye!${R}`)
        end(0)
        return
      } else if (ch === '\x04') {
        // Ctrl+D
        printLine(`${DIM}Bye!${R}`)
        end(0)
        return
      } else if (ch >= ' ') {
        lineBuf += ch
        write(ch)
      }
    }
  })

  stream.on('close', () => end(1))
  stream.on('error', () => end(1))
}

/* ----------------------------------- server ----------------------------------- */

const hostKey = loadOrCreateHostKey()
let sessions = 0

const sshd = new Server({ hostKeys: [hostKey] }, (client: any) => {
  let roomLabel = DEFAULT_ROOM
  let username = ''

  client.on('authentication', (ctx: any) => {
    username = stripUnsafe(String(ctx.username || '')).slice(0, MAX_ROOM_LEN)
    // room = username; any auth method accepted (guest access)
    ctx.accept()
  })

  client.on('ready', () => {
    const { key, label } = resolveRoom(username)
    roomLabel = label
    client.on('session', (accept: any, _reject: any) => {
      const session = accept()
      session.on('pty', (acceptPty: any) => acceptPty())
      session.on('window-change', (accept: any) => {
        try {
          accept()
        } catch {}
      })
      session.on('shell', (accept: any, reject: any) => {
        if (sessions >= MAX_SESSIONS) {
          try {
            const st = accept()
            st.write('Too many SSH sessions. Try again later.\r\n')
            setTimeout(() => st.close(), 500)
          } catch {}
          return
        }
        const stream = accept()
        sessions++
        console.log(`[ssh] session opened (room=${roomLabel}, active=${sessions})`)
        bridgeSession(stream, roomLabel, () => {
          sessions--
          console.log(`[ssh] session closed (room=${roomLabel}, active=${sessions})`)
          try {
            client.end()
          } catch {}
        })
      })
    })
  })

  client.on('error', (err: Error) => console.error(`[ssh-client-error] ${err.message}`))
})

function listenOn(port: number) {
  sshd.on('error', (err: any) => {
    console.error(`[ssh] fatal: ${err.message}`)
    process.exit(1)
  })
  sshd.listen(port, () => {
    console.log(
      `TermChat SSH server on :${port} — usage: ssh ${'ROOMCODE'}@tchat.space-z.ai` +
        (port === 22 ? '' : `  (-p ${port}; port 22 needs root, auto-fell back)`)
    )
  })
}

// decide the port BEFORE binding the real server (root? → 22, else → fallback)
import { createServer as createNetServer } from 'net'
const canBind = (port: number) =>
  new Promise<boolean>(resolve => {
    const probe = createNetServer()
    probe.once('error', () => resolve(false))
    probe.listen(port, () => probe.close(() => resolve(true)))
  })

const chosen = (await canBind(PREF_PORT)) ? PREF_PORT : FALLBACK_PORT
if (chosen !== PREF_PORT) console.log(`[ssh] cannot bind :${PREF_PORT} (EACCES) — using :${chosen}`)
listenOn(chosen)

process.on('SIGTERM', () => {
  console.log('SSH service shutting down (SIGTERM)...')
  try {
    sshd.close(() => process.exit(0))
  } catch {}
  setTimeout(() => process.exit(0), 1500)
})
process.on('SIGINT', () => {
  try {
    sshd.close(() => process.exit(0))
  } catch {}
  setTimeout(() => process.exit(0), 1500)
})
