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
  // SSE liveness tracking (clients that pong heartbeats):
  // everPonged = client speaks the pong protocol (new g.sh/p.txt/web listener);
  // lastPong   = time of last /pong. Old clients never pong -> never enforced.
  everPonged?: boolean
  lastPong?: number
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
  everJoined?: boolean // at least one successful join happened here
  emptyAt?: number // set when the last user leaves; room kept for history grace
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

/** Like clean(), but keeps newlines — multi-line chat messages (terminal
 * clients join continuation lines with "\\"). Other control chars still go. */
function cleanText(input: unknown, maxLen: number): string {
  if (typeof input !== 'string') return ''
  return input
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f\u200b-\u200f\u2028\u2029]/g, '')
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

/** History retention window for an EMPTY room. Bug #10: any full departure
 * used to delete the room instantly, wiping history mid-conversation (quick
 * join/leave churn, refresh races). Now the room — and its history — survives
 * this long after the last person leaves; a sweeper drops it afterwards. */
const EMPTY_ROOM_GRACE_MS = 10 * 60_000

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

/** Plain-text rendering for SSE (shell/PowerShell) clients. Newlines become
 * a visible separator so one message stays ONE SSE event (data: lines may
 * not contain raw newlines). */
function formatLine(m: AnyMessage): string {
  const d = new Date(m.ts)
  const p = (n: number) => String(n).padStart(2, '0')
  const t = `${p(d.getHours())}:${p(d.getMinutes())}`
  if (m.kind === 'chat') return `[${t}] ${m.from}: ${String(m.text).replace(/\n/g, ' / ')}`
  if (m.kind === 'action') return `[${t}] * ${m.from} ${String(m.text).replace(/\n/g, ' / ')}`
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
  room.everJoined = true
  room.emptyAt = undefined
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
    if (room.users.size === 0 && room.key !== DEFAULT_ROOM) {
      if (room.everJoined) {
        // Keep the room (and its history) for a grace window instead of
        // wiping it instantly — quick join/leave churn and reconnect races
        // used to erase conversations mid-flight (bug #10).
        room.emptyAt = Date.now()
      } else {
        rooms.delete(room.key) // phantom room created by a failed join
      }
    }
    emitPresence()
    return user
  }
  return null
}

/** Delete a room object if it has no users (used after failed joins to avoid leaks). */
function dropIfEmpty(room: Room) {
  if (room.users.size === 0 && room.key !== DEFAULT_ROOM && !room.everJoined) {
    rooms.delete(room.key)
  } else if (room.users.size === 0 && room.key !== DEFAULT_ROOM) {
    room.emptyAt = room.emptyAt ?? Date.now()
  }
}

const SSE_PONG_GRACE = 45_000 // no /pong for 45s from a pong-capable client => dead

const isSseStale = (u: RoomUser) => !!u.everPonged && Date.now() - (u.lastPong ?? 0) > SSE_PONG_GRACE

/**
 * Free a name held by a connection the server can prove is dead.
 * Returns true when the caller may proceed with the join.
 * - socket.io holder still connected (incl. ping-timeout limbo) => keep name.
 * - socket.io holder that already disconnected but lingers         => evict, free.
 * - SSE holder whose pong-capable client went silent               => destroy stream, free.
 * - SSE holder without pong data (old client / healthy unknown)    => keep name.
 */
function evictStaleHolder(room: Room, name: string): boolean {
  const lower = name.toLowerCase()
  for (const [key, u] of [...room.users]) {
    if (u.name.toLowerCase() !== lower) continue
    if (key.startsWith('sse:')) {
      if (!isSseStale(u)) return false
      room.sse.get(key)?.destroy() // 'close' handler runs the normal cleanup
      console.log(`[evict] stale sse holder "${u.name}" removed from ${room.label}`)
      return true
    }
    const sock = io.of('/').sockets.get(key)
    if (sock && sock.connected) return false // alive socket.io holder wins
    removeMember(key) // disconnected socket.io remnant
    console.log(`[evict] stale socket holder "${u.name}" removed from ${room.label}`)
    return true
  }
  return true // name not held
}

/* ---------------------------------- socket.io ---------------------------------- */

const httpServer = createServer()

const io = new Server(httpServer, {
  // DO NOT change the path: Caddy forwards /?XTransformPort=3003 to this server.
  path: '/',
  cors: { origin: '*', methods: ['GET', 'POST'] },
  // Fast dead-client detection: a vanished client (no close frame) is reaped
  // after pingTimeout + pingInterval (~20s) instead of ~85s.
  pingTimeout: 15000,
  pingInterval: 5000,
  // NOTE: connectionStateRecovery deliberately REMOVED. It restored socket.io
  // room membership on quick reconnects WITHOUT re-registering the app-level
  // user entry -> refresh could leave a user half-joined (in room, but not in
  // the user registry: presence wrong, sends rejected). Clients now re-join
  // explicitly on reconnect.
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
    evictStaleHolder(room, clean(data?.name, MAX_NAME_LEN))
    const verdict = validateName(room, data?.name)
    if (!verdict.ok) {
      socket.emit('name-rejected', { reason: verdict.reason })
      dropIfEmpty(room)
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
    const text = cleanText(data?.text, MAX_TEXT_LEN)
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

  // Explicit leave (web /quit, future clients). The socket stays connected so
  // the user can join again (or another room) without a full reconnect.
  socket.on('leave', () => {
    const roomKey = socket.data.roomKey as string | undefined
    const room = roomKey ? rooms.get(roomKey) : undefined
    if (room?.users.has(socket.id)) {
      socket.leave(room.key)
      socket.data.roomKey = undefined
      removeMember(socket.id, 'left') // broadcasts system msg + drops empty room
    }
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
      for (const k of ['name', 'text', 'room', 'key']) if (typeof j?.[k] === 'string') out[k] = j[k]
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
    evictStaleHolder(room, clean(url.searchParams.get('name'), MAX_NAME_LEN))
    const verdict = validateName(room, url.searchParams.get('name'))
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    if (!verdict.ok) {
      res.write(`data: !! ${verdict.reason}\n\n`)
      res.end()
      dropIfEmpty(room)
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

    // TCP keepalive so a half-open connection errors out instead of lingering for hours
    req.socket.setKeepAlive(true, 15000)
    const bail = (why: string) => {
      clearInterval(hb)
      if (room.sse.has(key)) {
        removeMember(key)
        console.log(`[sse-leave] ${user.name} (${why}, online=${totalOnline()})`)
      }
    }
    res.on('error', () => bail('write error'))
    req.socket.on('error', () => bail('socket error'))

    // Liveness heartbeat: comment line carrying a seq + this connection's key.
    // Invisible to old clients (they only print "data:" lines). Pong-capable
    // clients (new g.sh / p.txt / bots) reply via POST /pong {key}; a pong-
    // capable client silent for SSE_PONG_GRACE is considered dead and reaped.
    let hbSeq = 0
    const hb = setInterval(() => {
      try {
        if (!room.sse.has(key) || res.writableEnded) {
          clearInterval(hb)
          return
        }
        res.write(`: hb ${++hbSeq} ${key}\n\n`)
      } catch {
        bail('heartbeat failure')
      }
    }, 15000)

    req.on('close', () => bail('stream closed'))
    return
  }

  /* ---------- POST /pong {key} : SSE liveness reply ---------- */
  if (req.method === 'POST' && url.pathname === '/pong') {
    readBody(req, body => {
      const params = parseParams(body, req.headers['content-type'] || '')
      const key = clean(params.key ?? url.searchParams.get('key'), 40)
      let hit = false
      for (const room of rooms.values()) {
        const u = room.users.get(key)
        if (u && key.startsWith('sse:')) {
          u.everPonged = true
          u.lastPong = Date.now()
          hit = true
          break
        }
      }
      if (!hit) console.log(`[pong] MISS for key="${key}" (body=${JSON.stringify(body).slice(0, 60)})`)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, hit }))
    })
    return
  }

  /* ---------- POST /send {name, text, room?} : send ---------- */
  if (req.method === 'POST' && url.pathname === '/send') {
    readBody(req, body => {
      const params = parseParams(body, req.headers['content-type'] || '')
      const name = clean(params.name || url.searchParams.get('name'), MAX_NAME_LEN)
      const text = cleanText(params.text ?? url.searchParams.get('text'), MAX_TEXT_LEN)
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
      const hit = found[0]
      if (!hit) {
        sendErr(403, 'you are not connected — open the stream first')
        return
      }
      const { room, key, userName } = hit
      if (!key.startsWith('sse:')) {
        // The named identity is a socket.io connection ON THIS INSTANCE
        // (web user, CLI via socket.io, bot). Deliver through the room path
        // instead of 403ing — mixed-transport setups and multi-instance
        // deploys hit the old rejection constantly (bug R3-#12/#13).
        const sock = io.sockets.sockets.get(key)
        if (text === '/quit' || text === '/exit') {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: true }))
          sock?.disconnect() // runs the normal leave/cleanup path
          return
        }
        if (text.startsWith('/nick ')) {
          const verdict = validateName(room, text.slice(6), key)
          if (!verdict.ok) {
            sock?.emit('error', { text: verdict.reason })
          } else {
            const old = userName
            const u = room.users.get(key)
            if (u) u.name = verdict.name
            broadcastSystem(room, 'nick', `${old} is now known as ${verdict.name}`)
            sock?.emit('renamed', { you: verdict.name })
          }
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: true }))
          return
        }
        if (text.startsWith('/me ')) {
          const act = clean(text.slice(4), 200)
          if (act) broadcastChat(room, userName, act, 'action')
        } else if (text === '/rooms' || text === '/users') {
          if (text === '/rooms') sock?.emit('rooms-list', { rooms: roomsSummary(), total: totalOnline() })
          else sock?.emit('users-list', { users: publicUsersIn(room), count: room.users.size })
        } else if (text.startsWith('/')) {
          sock?.emit('error', { text: 'Unknown command. Try: /me <action>, /nick <name>, /quit' })
        } else if (text) {
          broadcastChat(room, userName, text) // io.to(room) echoes to the sender too
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
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
    if (url.searchParams.get('verbose') === '1') {
      const detail = [...rooms.values()].map(r => ({
        room: r.label,
        users: [...r.users.entries()].map(([k, u]) => ({
          key: k,
          name: u.name,
          everPonged: !!u.everPonged,
          lastPongAgoMs: u.lastPong ? Date.now() - u.lastPong : null,
        })),
      }))
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, service: 'termchat-bridge', users: totalOnline(), rooms: detail }, null, 1))
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, service: 'termchat-bridge', users: totalOnline(), rooms: roomsSummary() }))
    return
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
  res.end('not found — use GET /stream?name=X&room=Y or POST /send')
})

bridge.listen(BRIDGE_PORT, () => {
  console.log(`TermChat SSE bridge listening on :${BRIDGE_PORT} (GET /stream, POST /send, POST /pong, rooms enabled)`)
})

/* ---------- stale SSE reaper: destroy zombie streams so names free up ---------- */
setInterval(() => {
  for (const room of [...rooms.values()]) {
    for (const [key, u] of [...room.users]) {
      if (!key.startsWith('sse:')) continue
      if (isSseStale(u)) {
        console.log(`[reaper] stale sse "${u.name}" @ ${room.label} (no pong > ${SSE_PONG_GRACE / 1000}s)`)
        room.sse.get(key)?.destroy() // 'close' handler performs the cleanup broadcast
      }
    }
  }
}, 15000).unref()

/* ---------- empty-room sweeper: drop rooms nobody has joined for a while ---------- */
setInterval(() => {
  const now = Date.now()
  for (const [key, room] of [...rooms]) {
    if (
      room.key !== DEFAULT_ROOM &&
      room.users.size === 0 &&
      room.everJoined &&
      room.emptyAt &&
      now - room.emptyAt > EMPTY_ROOM_GRACE_MS
    ) {
      console.log(`[sweeper] empty room "${room.label}" dropped after ${EMPTY_ROOM_GRACE_MS / 60000}min grace`)
      rooms.delete(key)
    }
  }
}, 60_000).unref()

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
