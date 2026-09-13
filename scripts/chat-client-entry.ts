/**
 * TermChat — tchat CLI client v3 (bundled to chat.cjs + compiled to native binaries)
 *
 * Usage:
 *   tchat <room> [-n <name>]              join a room (prompted if omitted)
 *   tchat join <room> [-n <name>]         same thing, "join" reads nicer
 *   tchat                                 prompts for room (Enter = lobby)
 *   tchat --server <url> ...              point at another host (default: baked-in)
 *   CHAT_URL=<url> tchat ...              same via environment
 *
 * Once inside: /help /nick /me /users /rooms /history /clear /url /quit
 */

import { io, type Socket } from 'socket.io-client'
import * as readline from 'readline'

const VERSION = '3.1.0'
const DEFAULT_SERVER = 'https://tchat.space-z.ai'
const DEFAULT_ROOM = 'lobby'

/* ------------------------------- ANSI helpers ------------------------------- */

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
  // Remove control chars / ANSI escapes so remote users cannot mangle your terminal.
  return String(s).replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028\u2029]/g, '')
}

function hhmm(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}

/* --------------------------------- arguments --------------------------------- */

interface Parsed {
  server: string
  room: string
  name: string
}

function looksLikeServerUrl(s: string): boolean {
  return /^https?:\/\//i.test(s) || /^wss?:\/\//i.test(s) || /^localhost(:\d+)?/i.test(s) || /^127\.0\.0\.1(:\d+)?/.test(s) || /^[\w.-]+:\d+$/.test(s)
}

function parseArgs(argv: string[]): Parsed {
  const args = argv.slice(2)
  let server = process.env.CHAT_URL || ''
  let room = process.env.TCHAT_ROOM || ''
  let name = process.env.TCHAT_NAME || ''
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--name' || a === '-n') name = args[++i] || ''
    else if (a === '--room' || a === '-r') room = args[++i] || ''
    else if (a === '--server' || a === '-s') server = args[++i] || ''
    else if (a === '--version' || a === '-v') {
      console.log(`tchat ${VERSION} — https://tchat.space-z.ai`)
      process.exit(0)
    } else if (a === '--help' || a === '-h') {
      printUsage()
      process.exit(0)
    } else if (a === 'join' || a === 'in') {
      // decorative subcommand: tchat join <room>
    } else if (!room && !looksLikeServerUrl(a)) room = a
    else if (!server && looksLikeServerUrl(a)) server = a
  }
  if (!server) server = DEFAULT_SERVER
  return { server, room, name }
}

function printUsage() {
  console.log(`tchat ${VERSION} — join a live chatroom from any terminal

Usage:
  tchat <room> [-n <name>]        join a room (lobby if you skip the code)
  tchat join <room> [-n <name>]   same, reads nicer
  tchat                           prompts for a room code
  tchat --server <url> <room>     point at another TermChat host

Options:
  -n, --name <name>      skip the name prompt
  -r, --room <code>      room code (also positional)
  -s, --server <url>     server URL (default: ${DEFAULT_SERVER})
  -v, --version          print version
  -h, --help             this help

Examples:
  tchat join 7XK92
  tchat 7XK92 -n Sam
  tchat                       # Enter -> lobby

Inside the room:
  /help  /nick <name>  /me <action>  /users  /rooms  /history [n]  /clear  /url  /quit`)
}

/** Ensure the gateway query XTransformPort=3003 is present (unless a direct port is used). */
function normalizeServerUrl(input: string): string {
  let raw = stripUnsafe(input).trim()
  if (!raw) return ''
  if (!/^https?:\/\//i.test(raw) && !/^wss?:\/\//i.test(raw)) {
    raw = /:\d+$/.test(raw) || /^localhost/i.test(raw) || /^127\.0\.0\.1/i.test(raw) ? 'http://' + raw : 'https://' + raw
  }
  raw = raw.replace(/^wss:/i, 'https:').replace(/^ws:/i, 'http:')
  try {
    const u = new URL(raw)
    // Always route through the Caddy gateway hint unless already present.
    // (Harmless when the service is hit directly — the server ignores it.)
    if (!u.searchParams.has('XTransformPort') && u.port !== '3003') u.searchParams.set('XTransformPort', '3003')
    if (u.pathname === '/') u.pathname = ''
    return u.toString()
  } catch {
    return raw
  }
}

/* --------------------------------- app state --------------------------------- */

const { server: argServer, room: argRoom, name: argName } = parseArgs(process.argv)
const SERVER_URL = normalizeServerUrl(argServer)

if (!SERVER_URL) {
  printUsage()
  process.exit(1)
}

let state: 'connecting' | 'rooming' | 'naming' | 'chatting' = 'connecting'
let myName = argName ? stripUnsafe(argName).slice(0, 20) : ''
let myRoom = argRoom ? stripUnsafe(argRoom).slice(0, 24) : ''
let lastCtrlC = 0
let earlyInput = '' // a line typed while still connecting — used as room (or name) once connected
// Lazy history cursor: seq of the OLDEST message we have rendered, plus whether
// the server says there is more below it. /history pages downward from here.
let histCursor: number | null = null
let histHasMore = false
let histLoading = false
// v3.4 /history all: when true, each history-page that still reports hasMore
// immediately requests the next page — dumps the whole persisted log.
let histDumpAll = false

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: `${GREEN}>${R} `,
  // terminal mode only for real TTYs — bun's readline drops lines on piped stdin
  // when terminal:true (node tolerates it); plain line mode is reliable everywhere.
  terminal: process.stdin.isTTY === true,
})

/** Print a line above wherever the user is currently typing, then restore the prompt. */
function printLine(line: string) {
  readline.cursorTo(process.stdout, 0)
  readline.clearLine(process.stdout, 0)
  process.stdout.write(line + '\n')
  if (state === 'chatting') rl.prompt(true)
}

function renderMessage(m: { kind: string; subtype?: string; from?: string; text: string; ts: number }) {
  const t = stripUnsafe(m.text)
  if (m.kind === 'chat') {
    const name = stripUnsafe(m.from || '?')
    const c = name === myName ? `${BOLD}${GREEN}` : colorFor(name)
    printLine(`  ${DIM}${hhmm(m.ts)}${R}  ${c}${name}${R}: ${t}`)
  } else if (m.kind === 'action') {
    const name = stripUnsafe(m.from || '?')
    const c = name === myName ? `${BOLD}${GREEN}` : colorFor(name)
    printLine(`  ${DIM}${hhmm(m.ts)}${R}  ${DIM}* ${c}${name}${R} ${DIM}${t}${R}`)
  } else if (m.kind === 'system') {
    const sub = m.subtype
    const color = sub === 'kick' ? RED : sub === 'info' ? DIM : YELLOW
    printLine(`  ${DIM}${hhmm(m.ts)}${R}  ${color}— ${t}${R}`)
  }
}

function askRoom() {
  state = 'rooming'
  rl.question(`${BOLD}Room code${R} ${DIM}(Enter = ${DEFAULT_ROOM})${R}: `, attempt => {
    myRoom = stripUnsafe(attempt).trim().slice(0, 24) || DEFAULT_ROOM
    if (myName) socket.emit('join', { name: myName, room: myRoom })
    else askName()
  })
}

function askName() {
  state = 'naming'
  rl.question(`${BOLD}Choose a guest name:${R} `, attempt => {
    const clean = stripUnsafe(attempt).trim()
    if (!clean) {
      printLine(`${RED}A name is required to join.${R}`)
      askName()
      return
    }
    myName = clean.slice(0, 20)
    socket.emit('join', { name: myName, room: myRoom || DEFAULT_ROOM })
  })
}

function enterRoom(info: { you: string; room?: string; count: number; users: { name: string }[]; history: any[]; hasMore?: boolean; olderCount?: number }) {
  state = 'chatting'
  myName = info.you
  myRoom = info.room || myRoom || DEFAULT_ROOM
  process.stdout.write('\x1b[2J\x1b[H') // clear screen
  console.log(`${GREEN}${BOLD}  Connected to room ${BOLD}${myRoom}${R}${GREEN}${BOLD} as ${info.you}${R}`)
  console.log(`  ${DIM}${info.count} guest(s) here: ${info.users.map(u => u.name).join(', ')}${R}`)
  console.log(`  ${DIM}Type /help for commands · invite: tchat join ${myRoom}${R}`)
  console.log('')
  const hist = Array.isArray(info.history) ? info.history : []
  histCursor = hist.length && typeof hist[0]?.seq === 'number' ? hist[0].seq : null
  histHasMore = !!info.hasMore
  histLoading = false
  histDumpAll = false
  if (hist.length) {
    console.log(`  ${DIM}—— recent messages ————${R}`)
    for (const m of hist) renderMessage(m)
    console.log(`  ${DIM}———————————————————————${R}`)
    if (histHasMore) {
      const n = typeof info.olderCount === 'number' && info.olderCount > 0 ? info.olderCount : null
      console.log(`  ${DIM}${n ? n + ' older message(s) on record — ' : 'older messages on record — '}/history to load more · /history all for everything${R}`)
    }
    console.log('')
  }
  rl.setPrompt(`${GREEN}${BOLD}${info.you}${R} ${DIM}@${myRoom}${R} ${GREEN}>${R} `)
  rl.prompt(true)
}

/* --------------------------------- socket io --------------------------------- */

const socket: Socket = io(SERVER_URL, {
  path: '/',
  transports: ['websocket', 'polling'],
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 800,
  reconnectionDelayMax: 5000,
  timeout: 12000,
  forceNew: true,
})

socket.on('connect', () => {
  if (state === 'connecting') {
    printLine(`${DIM}Connected to ${SERVER_URL.replace(/^https?:\/\//, '').replace(/\?.*$/, '')}${R}`)
    const early = earlyInput
    earlyInput = ''
    if (myRoom) {
      if (myName) socket.emit('join', { name: myName, room: myRoom })
      else if (early) {
        myName = early.slice(0, 20)
        socket.emit('join', { name: myName, room: myRoom })
      } else askName()
    } else if (early) {
      // user answered the room question before we were even connected
      myRoom = early
      if (myName) socket.emit('join', { name: myName, room: myRoom })
      else askName()
    } else askRoom()
  } else if (state === 'chatting') {
    // reconnected mid-session — re-claim the name + room
    printLine(`${GREEN}Reconnected.${R}`)
    socket.emit('join', { name: myName, room: myRoom || DEFAULT_ROOM })
  } else if (state === 'rooming') {
    // wait for the room question already on screen
  } else if (state === 'naming') {
    socket.emit('join', { name: myName, room: myRoom || DEFAULT_ROOM })
  }
})

socket.on('joined', (info: any) => enterRoom(info))

socket.on('renamed', (data: { you: string }) => {
  myName = data.you
  rl.setPrompt(`${GREEN}${BOLD}${myName}${R} ${DIM}@${myRoom}${R} ${GREEN}>${R} `)
  rl.prompt(true)
})

socket.on('name-rejected', (data: { reason: string }) => {
  printLine(`${RED}${data.reason}${R}`)
  if (state !== 'chatting') askName()
})

socket.on('message', (m: any) => renderMessage(m))
socket.on('system', (m: any) => renderMessage(m))

// Older-history page arrives here (from /history). Rendered like normal
// traffic above the prompt, oldest-first, with a one-line status footer.
socket.on('history-page', (d: { messages?: any[]; hasMore?: boolean; before?: number | null }) => {
  histLoading = false
  const page = Array.isArray(d?.messages) ? d.messages : []
  if (!page.length) {
    histHasMore = false
    histDumpAll = false
    printLine(`  ${DIM}no older messages on record${R}`)
    return
  }
  if (typeof page[0]?.seq === 'number') histCursor = page[0].seq
  histHasMore = !!d.hasMore
  for (const m of page) renderMessage(m)
  if (histHasMore) {
    printLine(`  ${DIM}—— ${page.length} older message(s) · /history for more${histDumpAll ? '' : ' · /history all for everything'} ——${R}`)
    if (histDumpAll) socket.emit('history', { before: histCursor ?? undefined, limit: 200 })
  } else {
    histDumpAll = false
    printLine(`  ${DIM}—— ${page.length} older message(s) · start of history ——${R}`)
  }
})

socket.on('users-list', (data: { users: { name: string }[]; count: number }) => {
  const names = data.users.map(u => u.name).join(', ') || '(nobody)'
  printLine(`  ${DIM}${data.count} in this room: ${names}${R}`)
})

socket.on('rooms-list', (data: { rooms: { key: string; label: string; users: number }[]; total: number }) => {
  printLine(`  ${DIM}${data.total} guest(s) across ${data.rooms.length} room(s):${R}`)
  for (const r of data.rooms) {
    printLine(`  ${CYAN}${r.label.padEnd(16)}${R} ${DIM}${r.users} online${R}`)
  }
})

socket.on('error', (data: { text: string }) => printLine(`${YELLOW}${data.text}${R}`))

socket.on('kicked', (data: { text: string }) => {
  printLine(`${RED}${data.text}${R}`)
  socket.disconnect()
  process.exit(1)
})

socket.on('disconnect', reason => {
  if (reason === 'io client disconnect') return
  printLine(`${RED}Disconnected (${reason}). Retrying…${R}`)
})

let reportedConnectError = false
socket.on('connect_error', (err: Error) => {
  if (!reportedConnectError) {
    reportedConnectError = true
    printLine(`${RED}Could not reach ${SERVER_URL}${R}`)
    printLine(`${DIM}  ${err.message}${R}`)
    printLine(`${DIM}  Check the URL, then try again. Example: tchat --server https://your-host 7XK92${R}`)
  }
})

/* --------------------------------- commands --------------------------------- */

function handleCommand(line: string): boolean {
  const [cmd, ...rest] = line.slice(1).split(/\s+/)
  const argStr = rest.join(' ')
  switch ((cmd || '').toLowerCase()) {
    case 'help':
      printLine(`  ${DIM}/nick <name>  change name | /me <action>  emote | /users  who is here${R}`)
      printLine(`  ${DIM}/rooms  list rooms | /history [n|all]  load older messages | /clear | /url | /quit${R}`)
      return true
    case 'history': {
      const wantsAll = argStr.trim().toLowerCase() === 'all'
      const n = wantsAll ? 200 : Math.max(1, Math.min(parseInt(argStr, 10) || 30, 1000))
      if (histLoading) {
        printLine(`  ${DIM}history page already in flight…${R}`)
        return true
      }
      if (!histHasMore && histCursor !== null) {
        printLine(`  ${DIM}no older messages on record${R}`)
        return true
      }
      histLoading = true
      histDumpAll = wantsAll
      socket.emit('history', { before: histCursor ?? undefined, limit: n })
      return true
    }
    case 'nick':
      if (!argStr) printLine(`${YELLOW}Usage: /nick <new-name>${R}`)
      else socket.emit('nick', { name: argStr })
      return true
    case 'me':
      if (!argStr) printLine(`${YELLOW}Usage: /me <action>  e.g. /me waves${R}`)
      else socket.emit('action', { text: argStr })
      return true
    case 'users':
    case 'who':
      socket.emit('users')
      return true
    case 'rooms':
      socket.emit('rooms')
      return true
    case 'clear':
      process.stdout.write('\x1b[2J\x1b[H')
      rl.prompt(true)
      return true
    case 'url':
      printLine(`  ${DIM}${SERVER_URL}${R}`)
      return true
    case 'quit':
    case 'exit':
      printLine(`${DIM}Bye! ${R}`)
      socket.disconnect()
      process.exit(0)
      return true
    default:
      printLine(`${YELLOW}Unknown command /${stripUnsafe(cmd)}. Type /help.${R}`)
      return true
  }
}

rl.on('line', line => {
  const text = line.replace(/\s+$/, '')
  if (!text.trim()) {
    rl.prompt(true)
    return
  }
  if (state === 'chatting') {
    if (text.startsWith('/')) handleCommand(text)
    else socket.emit('message', { text: stripUnsafe(text).slice(0, 500) })
    rl.prompt(true)
  } else if (state === 'rooming' || state === 'naming') {
    // handled by the pending rl.question — ignore stray lines
  } else if (state === 'connecting') {
    // fast typers: remember the answer for whichever question comes first
    earlyInput = stripUnsafe(text).slice(0, 24)
  } else {
    printLine(`${DIM}Still connecting… one moment.${R}`)
  }
})

/* ------------------------------ exit & signals ------------------------------ */

function shutdown(msg = 'Bye!') {
  try {
    printLine(`${DIM}${msg}${R}`)
  } catch {}
  try {
    socket.disconnect()
  } catch {}
  process.exit(0)
}

rl.on('SIGINT', () => {
  const now = Date.now()
  if (now - lastCtrlC < 4000) shutdown('Bye!')
  lastCtrlC = now
  printLine(`${DIM}Press Ctrl+C again (or /quit) to leave.${R}`)
  if (state === 'chatting') rl.prompt(true)
})

rl.on('close', () => shutdown())
process.on('SIGTERM', () => shutdown())
