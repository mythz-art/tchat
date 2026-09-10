/**
 * TermChat — realtime MULTI-ROOM chat service v3 (socket.io + plain-HTTP SSE bridge)
 *
 * Two listeners:
 *  :3003  socket.io   (path "/") — browser page + native tchat CLI, via Caddy /?XTransformPort=3003
 *  :3004  plain HTTP  — legacy shell clients (g.sh / p.txt), via Caddy /?XTransformPort=3004
 *         GET  /stream?name=X&room=Y  -> text/event-stream, one plain-text line per room event
 *         POST /send                  -> form-urlencoded or JSON { name, text, room? }
 *         GET  /health                -> { ok, users, rooms }
 *
 * Rooms: every join carries a room code (default "lobby"). Room keys are case-insensitive.
 *        Names are unique PER ROOM. All transports in the same room share one user registry,
 *        one history and one broadcast. No rate limiting. Global capacity cap kept.
 *
 * Extra socket events:
 *   client -> 'rooms'                       list active rooms
 *   server -> 'rooms-list' { rooms, total }
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import { Server, type Socket } from 'socket.io'

const IO_PORT = Number(process.env.CHAT_SERVICE_PORT || 3003)
const BRIDGE_PORT = Number(process.env.CHAT_BRIDGE_PORT || 3004)
const MAX_CLIENTS = 200
const MAX_NAME_LEN = 20
const MAX_ROOM_LEN = 24
const MAX_TEXT_LEN = 500
const HISTORY_LIMIT = 50
const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} _.\-]*$/u
const ROOM_RE = /^[A-Za-z0-9][A-Za-z0-9 _.\-]*$/
const DEFAULT_ROOM = 'lobby'

/* --------------------------------- room state --------------------------------- */

interface RoomUser {
  name: string
  joinedAt: number
}

type MsgKind = 'chat' | 'action'
type SysSubtype = 'join' | 'leave' | 'nick' | 'info'

interface RoomMessage {
  id: string
  kind: MsgKind
  from: string
  text: string
  ts: number
}

interface SystemMessage {
  id: string
  kind: 'system'
  subtype: SysSubtype
  text: string
  ts: number
}

type AnyMessage = RoomMessage | SystemMessage

interface Room {
  key: string // normalized (lowercase) — stable identifier
  label: string // display form (first-seen casing)
  users: Map<string, RoomUser> // connKey -> user
  sse: Map<string, ServerResponse> // connKey -> SSE stream (subset of users)
  history: AnyMessage[]
}

const rooms = new Map<string, Room>()
const totalOnline = () => {
  let n = 0
  for (const r of rooms.values()) n += r.users.size
  return n
}

const genId = () => Math.random().toString(36).slice(2, 11) + Date.now().toString(36).slice(-4)

/** Strip control characters (incl. ANSI escapes) and trim. */
function clean(input: unknown, maxLen: number): string {
  if (typeof input !== 'string') return ''
  return input
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028\u2029]/g, '')
    .trim()
    .slice(0, maxLen)
    .trimEnd()
}

/** Validate + normalize a room code. Empty/invalid falls back to the default room. */
function resolveRoom(raw: unknown): { key: string; label: string } {
  const label = clean(raw, MAX_ROOM_LEN)
  if (label && ROOM_RE.test(label)) return { key: label.toLowerCase(), label }
  return { key: DEFAULT_ROOM, label: DEFAULT_ROOM }
}

function getRoom(key: string, label?: string): Room {
  let r = rooms.get(key)
  if (!r) {
    r = { key, label: label || key, users: new Map(), sse: new Map(), history: [] }
    rooms.set(key, r)
  }
  return r
}

function nameTakenIn(room: Room, name: string, excludeKey?: string): boolean {
  const lower = name.toLowerCase()
  for (const [key, u] of room.users) {
    if (key !== excludeKey && u.name.toLowerCase() === lower) return true
  }
  return false
}

function freeSuggestion(room: Room, base: string): string {
  let n = 2
  while (n < 100) {
    if (!nameTakenIn(room, `${base}${n}`)) return `${base}${n}`
    n++
  }
  return `${base}${Date.now() % 1000}`
}

function validateName(room: Room, raw: unknown, excludeKey?: string): { ok: true; name: string } | { ok: false; reason: string } {
  const name = clean(raw, MAX_NAME_LEN)
  if (!name) return { ok: false, reason: 'Name cannot be empty.' }
  if (name.length < 2) return { ok: false, reason: 'Name must be at least 2 characters.' }
  if (!NAME_RE.test(name))
    return { ok: false, reason: 'Use letters, numbers, spaces, or _ . - only (start with a letter/number).' }
  if (name.toLowerCase() === 'system') return { ok: false, reason: 'That name is reserved.' }
  if (nameTakenIn(room, name, excludeKey)) {
    return { ok: false, reason: `Name "${name}" is already taken in this room. Try "${freeSuggestion(room, name)}" instead.` }
  }
  return { ok: true, name }
}

const publicUsersIn = (room: Room) => [...room.users.values()].map(u => ({ name: u.name, joinedAt: u.joinedAt }))

const roomsSummary = () =>
  [...rooms.values()]
    .map(r => ({ key: r.key, label: r.label, users: r.users.size }))
    .sort((a, b) => b.users - a.users || a.key.localeCompare(b.key))

function pushHistory(room: Room, msg: AnyMessage) {
  room.history.push(msg)
  if (room.history.length > HISTORY_LIMIT) room.history.splice(0, room.history.length - HISTORY_LIMIT)
}

/** Plain-text rendering for SSE (shell/PowerShell) clients. */
function formatLine(m: AnyMessage): string {
  const d = new Date(m.ts)
  const p = (n: number) => String(n).padStart(2, '0')
  const t = `${p(d.getHours())}:${p(d.getMinutes())}`
  if (m.kind === 'chat') return `[${t}] ${m.from}: ${m.text}`
  if (m.kind === 'action') return `[${t}] * ${m.from} ${m.text}`
  return `[${t}] — ${m.text}`
}

function sseWrite(room: Room, key: string, line: string) {
  const res = room.sse.get(key)
  if (!res) return
  try {
    res.write(`data: ${line}\n\n`)
  } catch {}
}

/** Broadcast a chat/action message to everyone in ONE room (socket.io + SSE). */
function broadcastChat(room: Room, from: string, text: string, kind: MsgKind = 'chat') {
  const msg: RoomMessage = { id: genId(), kind, from, text, ts: Date.now() }
  pushHistory(room, msg)
  io.to(room.key).emit('message', msg)
  for (const key of room.sse.keys()) sseWrite(room, key, formatLine(msg))
}

/** Broadcast a system notice to everyone in ONE room. */
function broadcastSystem(room: Room, subtype: SysSubtype, text: string) {
  const msg: SystemMessage = { id: genId(), kind: 'system', subtype, text, ts: Date.now() }
  pushHistory(room, msg)
  io.to(room.key).emit('system', msg)
  for (const key of room.sse.keys()) sseWrite(room, key, formatLine(msg))
}

function emitPresence() {
  const total = totalOnline()
  for (const r of rooms.values()) {
    io.to(r.key).emit('presence', { count: r.users.size, room: r.label, total })
  }
}

function addMember(room: Room, key: string, user: RoomUser) {
  room.users.set(key, user)
  broadcastSystem(room, 'join', `${user.name} joined the room`)
  emitPresence()
}

function removeMember(key: string, reason = 'left') {
  for (const room of rooms.values()) {
    const user = room.users.get(key)
    if (!user) continue
    room.users.delete(key)
    room.sse.delete(key)
    broadcastSystem(room, 'leave', `${user.name} ${reason} the room`)
    if (room.users.size === 0 && room.key !== DEFAULT_ROOM) rooms.delete(room.key)
    emitPresence()
    return user
  }
  return null
}

/* ---------------------------------- socket.io ---------------------------------- */

const httpServer = createServer()

const io = new Server(httpServer, {
  // DO NOT change the path: Caddy forwards /?XTransformPort=3003 to this server.
  path: '/',
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 60000,
  pingInterval: 25000,
  connectionStateRecovery: { maxDisconnectionDuration: 60000 },
})

io.on('connection', (socket: Socket) => {
  if (totalOnline() >= MAX_CLIENTS) {
    socket.emit('kicked', { text: 'Service is full. Please try again later.' })
    socket.disconnect(true)
    return
  }
  console.log(`[connect] ${socket.id} (online=${totalOnline()})`)

  socket.on('join', (data: { name?: string; room?: string }) => {
    if ([...rooms.values()].some(r => r.users.has(socket.id))) {
      socket.emit('error', { text: 'You already joined. Use /nick to change your name.' })
      return
    }
    const { key, label } = resolveRoom(data?.room)
    const room = getRoom(key, label)
    const verdict = validateName(room, data?.name)
    if (!verdict.ok) {
      socket.emit('name-rejected', { reason: verdict.reason })
      return
    }
    socket.join(room.key)
    socket.data.roomKey = room.key
    const user: RoomUser = { name: verdict.name, joinedAt: Date.now() }
    addMember(room, socket.id, user)
    socket.emit('joined', {
      you: user.name,
      room: room.label,
      count: room.users.size,
      users: publicUsersIn(room),
      history: room.history.slice(-20),
    })
    console.log(`[join] ${user.name} @ ${room.label} (room=${room.users.size}, online=${totalOnline()})`)
  })

  socket.on('message', (data: { text?: string }) => {
    const roomKey = socket.data.roomKey as string | undefined
    if (!roomKey) {
      socket.emit('error', { text: 'Pick a name first — type your name and press Enter.' })
      return
    }
    const room = rooms.get(roomKey)
    const user = room?.users.get(socket.id)
    if (!room || !user) {
      socket.emit('error', { text: 'Pick a name first — type your name and press Enter.' })
      return
    }
    const text = clean(data?.text, MAX_TEXT_LEN)
    if (text) broadcastChat(room, user.name, text)
  })

  socket.on('action', (data: { text?: string }) => {
    const roomKey = socket.data.roomKey as string | undefined
    const room = roomKey ? rooms.get(roomKey) : undefined
    const user = room?.users.get(socket.id)
    if (!room || !user) {
      socket.emit('error', { text: 'Join the room first.' })
      return
    }
    const text = clean(data?.text, 200)
    if (text) broadcastChat(room, user.name, text, 'action')
  })

  socket.on('nick', (data: { name?: string }) => {
    const roomKey = socket.data.roomKey as string | undefined
    const room = roomKey ? rooms.get(roomKey) : undefined
    const user = room?.users.get(socket.id)
    if (!room || !user) {
      socket.emit('error', { text: 'Join the room first.' })
      return
    }
    const verdict = validateName(room, data?.name, socket.id)
    if (!verdict.ok) {
      socket.emit('name-rejected', { reason: verdict.reason })
      return
    }
    const old = user.name
    user.name = verdict.name
    broadcastSystem(room, 'nick', `${old} is now known as ${verdict.name}`)
    socket.emit('renamed', { you: verdict.name })
    console.log(`[nick] ${old} -> ${verdict.name} @ ${room.label}`)
  })

  socket.on('users', () => {
    const roomKey = socket.data.roomKey as string | undefined
    const room = roomKey ? rooms.get(roomKey) : undefined
    if (!room) {
      socket.emit('users-list', { users: [], count: 0 })
      return
    }
    socket.emit('users-list', { users: publicUsersIn(room), count: room.users.size })
  })

  socket.on('rooms', () => {
    socket.emit('rooms-list', { rooms: roomsSummary(), total: totalOnline() })
  })

  socket.on('disconnect', reason => {
    const user = removeMember(socket.id)
    if (user) console.log(`[leave] ${user.name} (${reason}, online=${totalOnline()})`)
    else console.log(`[disconnect] ${socket.id} (${reason}, online=${totalOnline()})`)
  })

  socket.on('error', err => console.error(`[socket-error] ${socket.id}:`, err))
})

httpServer.listen(IO_PORT, () => {
  console.log(`TermChat socket.io listening on :${IO_PORT} (path "/", rooms enabled)`)
})

/* ------------------------------- HTTP SSE bridge ------------------------------- */

function cors(res: ServerResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
}

function readBody(req: IncomingMessage, cb: (body: string) => void) {
  let body = ''
  req.on('data', c => {
    body += c
    if (body.length > 4096) req.destroy()
  })
  req.on('end', () => cb(body))
}

function parseParams(body: string, contentType: string): Record<string, string> {
  const out: Record<string, string> = {}
  if (contentType.includes('application/json')) {
    try {
      const j = JSON.parse(body)
      for (const k of ['name', 'text', 'room']) if (typeof j?.[k] === 'string') out[k] = j[k]
    } catch {}
  } else {
    for (const [k, v] of new URLSearchParams(body)) out[k] = v
  }
  return out
}

let sseCounter = 0

const bridge = createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://x')
  cors(res)

  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  /* ---------- GET /stream?name=X&room=Y : SSE receive ---------- */
  if (req.method === 'GET' && url.pathname === '/stream') {
    if (totalOnline() >= MAX_CLIENTS) {
      res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('room is full')
      return
    }
    const { key: roomKey, label: roomLabel } = resolveRoom(url.searchParams.get('room'))
    const room = getRoom(roomKey, roomLabel)
    const verdict = validateName(room, url.searchParams.get('name'))
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    if (!verdict.ok) {
      sseWrite(room, '__none__', `!! ${verdict.reason}`)
      res.write(`data: !! ${verdict.reason}\n\n`)
      res.end()
      return
    }
    const key = `sse:${++sseCounter}`
    const user: RoomUser = { name: verdict.name, joinedAt: Date.now() }
    room.users.set(key, user)
    broadcastSystem(room, 'join', `${user.name} joined the room`)
    room.sse.set(key, res) // register after the join broadcast: self sees own join via history only
    res.write(`data: *** Connected as ${user.name} in room "${room.label}". Commands: /me <action>, /nick <name>, /quit\n\n`)
    for (const m of room.history.slice(-15)) sseWrite(room, key, formatLine(m))
    emitPresence()
    console.log(`[sse-join] ${user.name} @ ${room.label} (room=${room.users.size}, online=${totalOnline()})`)

    const hb = setInterval(() => {
      try {
        res.write(': hb\n\n')
      } catch {}
    }, 25000)

    req.on('close', () => {
      clearInterval(hb)
      removeMember(key)
      console.log(`[sse-leave] ${user.name} (online=${totalOnline()})`)
    })
    return
  }

  /* ---------- POST /send {name, text, room?} : send ---------- */
  if (req.method === 'POST' && url.pathname === '/send') {
    readBody(req, body => {
      const params = parseParams(body, req.headers['content-type'] || '')
      const name = clean(params.name || url.searchParams.get('name'), MAX_NAME_LEN)
      const text = clean(params.text ?? url.searchParams.get('text'), MAX_TEXT_LEN)
      const roomHint = clean(params.room || url.searchParams.get('room'), MAX_ROOM_LEN).toLowerCase()

      // resolve the sender: match name (case-insensitive); scope to roomHint when provided
      let found: { room: Room; key: string; userName: string }[] = []
      for (const room of rooms.values()) {
        if (roomHint && room.key !== roomHint) continue
        for (const [k, u] of room.users) {
          if (u.name.toLowerCase() === name.toLowerCase()) {
            found.push({ room, key: k, userName: u.name })
            break
          }
        }
      }

      const sendErr = (code: number, msg: string) => {
        res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end(msg)
      }
      if (found.length === 0) {
        sendErr(403, 'you are not connected — open the stream first')
        return
      }
      if (found.length > 1) {
        sendErr(409, `name "${name}" is online in several rooms — add &room=<code>`)
        return
      }
      const { room, key, userName } = found[0]
      if (!key.startsWith('sse:')) {
        sendErr(403, 'socket.io clients should use the socket protocol')
        return
      }
      if (!text) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
        return
      }

      if (text === '/quit' || text === '/exit') {
        sseWrite(room, key, `*** Bye!`)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
        const sseRes = room.sse.get(key)
        sseRes?.end()
        return
      }
      if (text.startsWith('/nick ')) {
        const verdict = validateName(room, text.slice(6), key)
        if (!verdict.ok) {
          sseWrite(room, key, `!! ${verdict.reason}`)
        } else {
          const old = userName
          const u = room.users.get(key)
          if (u) u.name = verdict.name
          broadcastSystem(room, 'nick', `${old} is now known as ${verdict.name}`)
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
        return
      }
      if (text.startsWith('/me ')) {
        const act = clean(text.slice(4), 200)
        if (act) broadcastChat(room, userName, act, 'action')
      } else if (text.startsWith('/')) {
        sseWrite(room, key, `!! Unknown command. Try: /me <action>, /nick <name>, /quit`)
      } else {
        broadcastChat(room, userName, text)
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    })
    return
  }

  /* ---------- GET /health ---------- */
  if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/')) {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, service: 'termchat-bridge', users: totalOnline(), rooms: roomsSummary() }))
    return
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
  res.end('not found — use GET /stream?name=X&room=Y or POST /send')
})

bridge.listen(BRIDGE_PORT, () => {
  console.log(`TermChat SSE bridge listening on :${BRIDGE_PORT} (GET /stream, POST /send, rooms enabled)`)
})

process.on('SIGTERM', () => {
  console.log('TermChat service shutting down (SIGTERM)...')
  httpServer.close(() => process.exit(0))
  bridge.close(() => process.exit(0))
})
process.on('SIGINT', () => {
  console.log('TermChat service shutting down (SIGINT)...')
  httpServer.close(() => process.exit(0))
  bridge.close(() => process.exit(0))
})
