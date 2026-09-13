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
 * Polling API (v3.2) — reliable follow-for-AI-agents, no persistent stream:
 *   GET  /poll?room=X [&name=AgentB | &key=poll:N] [&since=SEQ] [&limit=N]
 *         -> { ok, room, key, you, registered, count, users, messages[],
 *              since, hasMore, lastSeq, serverTime }
 *         register once with name -> keep the returned key -> poll with
 *         key+since; the poll itself is the heartbeat (identity dropped
 *         after 90s of silence). since=0 replays the whole persisted log.
 *
 * Rooms: every join carries a room code (default "lobby"). Room keys are case-insensitive.
 *        Names are unique PER ROOM. All transports in the same room share one user registry,
 *        one history and one broadcast. No rate limiting. Global capacity cap kept.
 *
 * Extra socket events:
 *   client -> 'rooms'                       list active rooms
 *   server -> 'rooms-list' { rooms, total }
 *   client -> 'history' { before?, limit? } lazy-load OLDER messages (before =
 *                                           exclusive upper seq bound)
 *   server -> 'history-page' { room, messages, hasMore, lastSeq }
 *
 * HTTP bridge extras:
 *   GET  /history?room=X&before=SEQ&limit=N format=json|text
 *         -> JSON { ok, room, messages, hasMore, lastSeq }
 *         -> text mode: one pre-formatted line per message + headers
 *            X-History-Next (cursor for the next older page) / X-History-More
 *
 * Persistence (v3.1): every message is appended to db/chat-history/<room>.jsonl
 * (override with CHAT_HISTORY_DIR). Rooms keep a RAM window of the last 2000
 * messages; anything older — or anything written before a restart — is paged
 * straight from disk. Empty rooms may still be dropped from RAM after the
 * grace period, but their log survives and re-hydrates on the next touch:
 * history is NEVER lost when the service restarts or a room goes quiet.
 *
 * Durability (v3.3): writes are fsync'd, and both the per-append path and a
 * 60s sweeper detect a disk log that went missing or SHRANK behind RAM (host
 * snapshot restore / truncation) and rebuild it from the RAM window — the
 * disk log can never silently regress behind what the process has seen.
 * NOTE: the service must run WITHOUT `bun --hot` — a hot module reload
 * re-executes this file and resets the rooms map (live state loss).
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import {
  closeSync,
  existsSync,
  fdatasyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'
import { Server, type Socket } from 'socket.io'

const IO_PORT = Number(process.env.CHAT_SERVICE_PORT || 3003)
const BRIDGE_PORT = Number(process.env.CHAT_BRIDGE_PORT || 3004)
const MAX_CLIENTS = 200
const MAX_NAME_LEN = 20
const MAX_ROOM_LEN = 24
const MAX_TEXT_LEN = 500
// History (v3.1): everything is persisted to disk; RAM holds a generous window.
const HISTORY_RAM = 2000 // in-RAM messages per room (older pages stream from disk)
// v3.4 "show all history": joins replay EVERYTHING a room realistically holds
// (the cap only guards pathological payloads; socket.io maxPayload is 1MB and
// 1000 * 500-char messages ≈ 500KB). Beyond the cap clients lazy-load pages.
// Env-overridable so test suites can exercise the paging path with a small window.
const HISTORY_REPLAY_SOCKET = Number(process.env.CHAT_REPLAY_SOCKET || 1000) // messages replayed on socket.io join
const HISTORY_REPLAY_SSE = Number(process.env.CHAT_REPLAY_SSE || process.env.CHAT_REPLAY_SOCKET || 1000) // lines replayed on SSE join
const HISTORY_PAGE_DEFAULT = 30 // page size when the client does not ask
const HISTORY_PAGE_MAX = 1000 // v3.4: big pages so "load all" needs few round-trips

// Polling API (v3.2): AI agents (and any HTTP client) can follow a room with
// plain request/response polling instead of holding an SSE stream open —
// much more robust in sandboxes where background processes get reaped.
const POLL_GRACE_MS = 90_000 // poll identity dropped after 90s without a poll
const POLL_PAGE_DEFAULT = 200
const POLL_PAGE_MAX = 500

/** History dir: CHAT_HISTORY_DIR wins; otherwise locate the project's db/ dir
 * whether the service was started from the repo root or from mini-services/. */
function resolveHistoryDir(): string {
  if (process.env.CHAT_HISTORY_DIR) return process.env.CHAT_HISTORY_DIR
  const roots = [process.cwd(), join(process.cwd(), '..', '..')]
  for (const r of roots) {
    try {
      if (existsSync(join(r, 'db'))) return join(r, 'db', 'chat-history')
    } catch {}
  }
  return join(process.cwd(), 'db', 'chat-history')
}
const HISTORY_DIR = resolveHistoryDir()
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
  seq?: number // room-scoped monotonic sequence (assigned in pushHistory)
}

interface SystemMessage {
  id: string
  kind: 'system'
  subtype: SysSubtype
  text: string
  ts: number
  seq?: number
}

type AnyMessage = RoomMessage | SystemMessage

interface Room {
  key: string // normalized (lowercase) — stable identifier
  label: string // display form (first-seen casing)
  users: Map<string, RoomUser> // connKey -> user
  sse: Map<string, ServerResponse> // connKey -> SSE stream (subset of users)
  history: AnyMessage[]
  seq: number // last assigned message sequence
  hydrated?: boolean // disk log already loaded into RAM for this room object
  diskMinSeq?: number // smallest seq that exists on disk (for hasMore math)
  diskBytes?: number // byte size of the room's JSONL as of our last write
  lastDiskSeq?: number // seq of the last line known to be on disk
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
    r = { key, label: label || key, users: new Map(), sse: new Map(), history: [], seq: 0 }
    rooms.set(key, r)
    hydrateRoom(r) // restore a dropped/restarted room's log from disk
  }
  return r
}

/** History retention window for an EMPTY room. Bug #10: any full departure
 * used to delete the room instantly, wiping history mid-conversation (quick
 * join/leave churn, refresh races). The room object survives this long after
 * the last person leaves; afterwards the sweeper drops it from RAM — but its
 * disk log stays forever and re-hydrates on the next touch (v3.1). */
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

/* --------------------------- persistent history (v3.1) ---------------------------
 * Append-only JSONL per room + monotonic seq. RAM window = HISTORY_RAM newest
 * messages; older pages (incl. pre-restart history) are read from disk on
 * demand. Client-facing pagination: pageHistory(). */

function roomLogPath(key: string): string {
  return join(HISTORY_DIR, `${key.replace(/[^a-z0-9_.-]/g, '_')}.jsonl`)
}

/** Load a room's disk log tail into RAM (called once per room object). */
function hydrateRoom(room: Room) {
  if (room.hydrated) return
  room.hydrated = true
  try {
    const p = roomLogPath(room.key)
    if (!existsSync(p)) return
    const msgs: AnyMessage[] = []
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      if (!line) continue
      try {
        const m = JSON.parse(line) as AnyMessage
        if (m && typeof m.seq === 'number' && typeof m.kind === 'string') msgs.push(m)
      } catch {}
    }
    if (!msgs.length) return
    room.history = msgs.slice(-HISTORY_RAM)
    room.seq = msgs[msgs.length - 1]!.seq!
    room.diskMinSeq = msgs[0]?.seq
    room.diskBytes = statSync(p).size
    room.lastDiskSeq = msgs[msgs.length - 1]!.seq!
    console.log(`[history] hydrated ${room.label}: ${room.history.length} in RAM, seq ${room.diskMinSeq}..${room.seq}`)
  } catch (e) {
    console.error(`[history] hydrate failed for ${room.key}:`, e)
  }
}

/** Rebuild a room's JSONL from the in-RAM window (fsync'd). Used when the
 * file on disk is found missing or SHORTER than what we already wrote — e.g.
 * the host restored an older disk snapshot while the process kept running.
 * RAM is the source of truth for the newest HISTORY_RAM messages; the disk
 * log must never regress behind it. */
function rebuildRoomLog(room: Room): void {
  const p = roomLogPath(room.key)
  const text = room.history.map(m => JSON.stringify(m) + '\n').join('')
  writeFileSync(p, text)
  const fh = openSync(p, 'r+')
  try {
    fdatasyncSync(fh)
  } finally {
    closeSync(fh)
  }
  room.diskBytes = Buffer.byteLength(text)
  room.lastDiskSeq = room.history.length ? room.history[room.history.length - 1]!.seq : room.lastDiskSeq
  room.diskMinSeq = room.history[0]?.seq
  console.log(`[history] repaired ${room.label}: rebuilt log from RAM (${room.history.length} msgs, ${room.diskBytes}B)`)
}

/** Append messages to the room's JSONL durably: rollback check + fsync.
 * If the file on disk is smaller than our last recorded size, the disk
 * regressed (snapshot restore / truncation) — rebuild from RAM first. */
function appendDurable(room: Room, msgs: AnyMessage[]): void {
  const p = roomLogPath(room.key)
  let size = -1
  try {
    size = statSync(p).size
  } catch {}
  if (room.diskBytes !== undefined && (size < 0 || size < room.diskBytes)) {
    // file missing entirely OR shorter than what we already wrote -> rebuild
    rebuildRoomLog(room)
  } else if (room.diskBytes === undefined) {
    room.diskBytes = Math.max(0, size) // adopt whatever a previous run wrote
  }
  // A rebuild already flushed the whole RAM window (including anything with
  // seq <= lastDiskSeq) — never write a line twice.
  const pending = msgs.filter(
    m => typeof m.seq !== 'number' || room.lastDiskSeq === undefined || m.seq > room.lastDiskSeq
  )
  const fh = openSync(p, 'a')
  try {
    for (const m of pending) {
      const line = JSON.stringify(m) + '\n'
      writeSync(fh, line)
      room.diskBytes = (room.diskBytes ?? 0) + Buffer.byteLength(line)
      if (typeof m.seq === 'number') room.lastDiskSeq = m.seq
    }
    try {
      fdatasyncSync(fh)
    } catch {}
  } finally {
    closeSync(fh)
  }
}

function pushHistory(room: Room, msg: AnyMessage) {
  msg.seq = ++room.seq
  room.history.push(msg)
  try {
    mkdirSync(HISTORY_DIR, { recursive: true })
    appendDurable(room, [msg])
  } catch (e) {
    console.error(`[history] append failed for ${room.key}:`, e)
  }
  if (room.history.length > HISTORY_RAM) {
    room.history.splice(0, room.history.length - HISTORY_RAM)
  }
  if (room.diskMinSeq === undefined) room.diskMinSeq = room.history[0]?.seq
}

/** Read messages with seq < upper (and < belowSeq when given) from the disk log,
 * ascending, newest `want` of them. Best-effort: corrupt lines are skipped. */
function readDiskRange(key: string, upper: number, want: number, belowSeq?: number): AnyMessage[] {
  try {
    const p = roomLogPath(key)
    if (!existsSync(p) || want <= 0) return []
    const out: AnyMessage[] = []
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      if (!line) continue
      try {
        const m = JSON.parse(line) as AnyMessage
        if (typeof m.seq !== 'number') continue
        if (m.seq >= upper) continue
        if (belowSeq !== undefined && m.seq >= belowSeq) continue
        out.push(m)
      } catch {}
    }
    return out.slice(-want)
  } catch {
    return []
  }
}

/** Upward counterpart of readDiskRange: messages with seq > lower (and
 * < aboveSeq when given), ascending, oldest `want` of them. Used by /poll
 * to bridge the gap between a client cursor and the RAM window. */
function readDiskAfter(key: string, lower: number, want: number, aboveSeq?: number): AnyMessage[] {
  try {
    const p = roomLogPath(key)
    if (!existsSync(p) || want <= 0) return []
    const out: AnyMessage[] = []
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      if (!line) continue
      try {
        const m = JSON.parse(line) as AnyMessage
        if (typeof m.seq !== 'number') continue
        if (m.seq <= lower) continue
        if (aboveSeq !== undefined && m.seq >= aboveSeq) continue
        out.push(m)
      } catch {}
    }
    return out.slice(0, want)
  } catch {
    return []
  }
}

const roomMinSeq = (room: Room) =>
  Math.min(room.history[0]?.seq ?? Infinity, room.diskMinSeq ?? Infinity)

/** One page of history, strictly older than `before` (exclusive; undefined =
 * newest page), ascending. RAM-first with disk fallback so "older than the
 * window" and "written before the last restart" both resolve. */
function pageHistory(
  room: Room,
  before: number | undefined,
  limit: number
): { messages: AnyMessage[]; hasMore: boolean } {
  hydrateRoom(room)
  const lim = Math.max(1, Math.min(Math.floor(limit) || HISTORY_PAGE_DEFAULT, HISTORY_PAGE_MAX))
  const upper = before ?? Infinity
  let msgs = room.history.filter(m => typeof m.seq === 'number' && m.seq < upper)
  if (msgs.length > lim) msgs = msgs.slice(-lim)
  if (msgs.length < lim) {
    const older = readDiskRange(room.key, upper, lim - msgs.length, msgs[0]?.seq)
    if (older.length) msgs = [...older, ...msgs]
  }
  const hasMore = msgs.length > 0 && (msgs[0]?.seq ?? 0) > roomMinSeq(room)
  // v3.4: how many persisted messages sit above the page floor (informational —
  // seq gaps from healing/dedup make it approximate, never smaller than truth).
  const olderCount = hasMore
    ? Math.max(0, (msgs[0]?.seq ?? 0) - roomMinSeq(room))
    : 0
  return { messages: msgs, hasMore, olderCount }
}

/** Messages with seq > since (strictly newer), ascending, capped at `limit`.
 * The upward-looking twin of pageHistory — this is what /poll serves. RAM
 * first, disk fills the gap between the cursor and the RAM window start. */
function pollAfter(room: Room, since: number, limit: number): { messages: AnyMessage[]; hasMore: boolean } {
  hydrateRoom(room)
  const lim = Math.max(1, Math.min(Math.floor(limit) || POLL_PAGE_DEFAULT, POLL_PAGE_MAX))
  const ram = room.history.filter(m => typeof m.seq === 'number' && m.seq > since)
  const ramFirst = ram[0]?.seq as number | undefined
  let msgs: AnyMessage[]
  if (ram.length >= lim) {
    msgs = ram.slice(0, lim) // oldest first — client advances its cursor and polls again
  } else {
    let older: AnyMessage[] = []
    if (ramFirst !== undefined && ramFirst > since + 1) {
      older = readDiskAfter(room.key, since, lim - ram.length, ramFirst)
    } else if (ram.length === 0 && (room.diskMinSeq ?? Infinity) < Infinity) {
      older = readDiskAfter(room.key, since, lim)
    }
    msgs = [...older, ...ram]
  }
  const hasMore = msgs.length >= lim
  return { messages: msgs, hasMore }
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
 * - poll holder that polled within POLL_GRACE_MS                   => keep name.
 * - poll holder silent for POLL_GRACE_MS                           => evict, free.
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
    if (key.startsWith('poll:')) {
      if (Date.now() - (u.lastPong ?? 0) <= POLL_GRACE_MS) return false // actively polling
      removeMember(key, 'timed out')
      console.log(`[evict] stale poll holder "${u.name}" removed from ${room.label}`)
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
    const replay = pageHistory(room, undefined, HISTORY_REPLAY_SOCKET)
    socket.emit('joined', {
      you: user.name,
      room: room.label,
      count: room.users.size,
      users: publicUsersIn(room),
      history: replay.messages,
      hasMore: replay.hasMore,
      olderCount: replay.olderCount,
      lastSeq: room.seq,
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

  // Lazy history: fetch a page of OLDER messages. `before` is the seq to page
  // above (exclusive); omit it for the newest page. Reply: 'history-page'.
  socket.on('history', (data: { before?: number; limit?: number } = {}) => {
    const roomKey = socket.data.roomKey as string | undefined
    const room = roomKey ? rooms.get(roomKey) : undefined
    if (!room) {
      socket.emit('error', { text: 'Join the room first.' })
      return
    }
    const before = typeof data?.before === 'number' && Number.isFinite(data.before) ? data.before : undefined
    const page = pageHistory(room, before, Number(data?.limit) || HISTORY_PAGE_DEFAULT)
    socket.emit('history-page', {
      room: room.label,
      messages: page.messages,
      hasMore: page.hasMore,
      olderCount: page.olderCount,
      lastSeq: room.seq,
      before: before ?? null,
    })
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
let pollCounter = 0

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
    res.write(`data: *** Connected as ${user.name} in room "${room.label}". Commands: /me <action>, /nick <name>, /history, /quit\n\n`)
    const sseReplay = pageHistory(room, undefined, HISTORY_REPLAY_SSE)
    for (const m of sseReplay.messages) sseWrite(room, key, formatLine(m))
    if (sseReplay.hasMore) {
      sseWrite(room, key, `*** ${sseReplay.olderCount} older message(s) on record — send /history to load more (or /history all)`)
    }
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

  /* ---------- GET /poll — reliable message polling for AI agents ----------
   * Plain request/response alternative to the SSE stream: no persistent
   * connection, survives background-process reaping, trivially scriptable.
   *
   *   GET /poll?room=X                          read-only peek (newest page)
   *   GET /poll?room=X&name=AgentB              register a poll identity
   *   GET /poll?room=X&key=poll:7&since=42      follow the room from a cursor
   *
   * Response (JSON): { ok, room, key, you, registered, count, users,
   *                    messages[], since, hasMore, lastSeq, serverTime }
   * - `since` is the cursor to pass back next poll (seq of the last message
   *   returned; equals the room's current seq when nothing new).
   * - `hasMore: true` => more messages beyond this page: poll again
   *   immediately with the returned `since` before backing off.
   * - Poll identities stay alive as long as they keep polling (any poll with
   *   their key refreshes them); after POLL_GRACE_MS of silence the name is
   *   freed with a "timed out" leave notice.
   * - With `since=0` an agent pulls the room's ENTIRE persisted history.
   */
  if (req.method === 'GET' && url.pathname === '/poll') {
    const { key: roomKey, label: roomLabel } = resolveRoom(url.searchParams.get('room'))
    const room = getRoom(roomKey, roomLabel)
    const out = (obj: unknown, code = 200) => {
      res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify(obj))
    }

    // Identity resolution: existing poll key > register by name > read-only.
    const presKey = clean(url.searchParams.get('key'), 40)
    let pollConnKey: string | undefined
    let pollUser: RoomUser | undefined
    if (presKey.startsWith('poll:')) {
      const u = room.users.get(presKey)
      if (u) {
        pollConnKey = presKey
        pollUser = u
      }
    }
    let registered = false
    if (!pollUser) {
      const nameParam = clean(url.searchParams.get('name'), MAX_NAME_LEN)
      if (nameParam) {
        evictStaleHolder(room, nameParam)
        const verdict = validateName(room, nameParam)
        if (!verdict.ok) {
          dropIfEmpty(room)
          out({ ok: false, error: 'name-taken', reason: verdict.reason }, 409)
          return
        }
        const ck = `poll:${++pollCounter}`
        const u: RoomUser = { name: verdict.name, joinedAt: Date.now() }
        room.users.set(ck, u)
        room.everJoined = true
        room.emptyAt = undefined
        broadcastSystem(room, 'join', `${u.name} joined the room`)
        emitPresence()
        pollConnKey = ck
        pollUser = u
        registered = true
        console.log(`[poll-join] ${u.name} @ ${room.label} (room=${room.users.size}, online=${totalOnline()})`)
      }
    }

    // Refresh liveness for registered identities — the poll IS the heartbeat.
    if (pollUser && pollConnKey) {
      pollUser.everPonged = true
      pollUser.lastPong = Date.now()
    }

    const sinceRaw = url.searchParams.get('since')
    const sinceParam =
      sinceRaw !== null && sinceRaw !== '' && Number.isFinite(Number(sinceRaw)) ? Number(sinceRaw) : undefined
    const limit = Number(url.searchParams.get('limit')) || POLL_PAGE_DEFAULT

    let messages: AnyMessage[] = []
    let hasMore = false
    let since: number
    if (sinceParam === undefined) {
      if (pollConnKey) {
        // First contact for an identity: hand back the current tail position.
        since = room.seq
      } else {
        const page = pageHistory(room, undefined, limit)
        messages = page.messages
        hasMore = page.hasMore
        since = messages.length ? messages[messages.length - 1]!.seq! : room.seq
      }
    } else {
      const r = pollAfter(room, sinceParam, limit)
      messages = r.messages
      hasMore = r.hasMore
      since = messages.length ? messages[messages.length - 1]!.seq! : sinceParam
    }

    dropIfEmpty(room) // a read-only peek must not leave a phantom room behind
    out({
      ok: true,
      room: roomLabel,
      key: pollConnKey ?? null,
      you: pollUser?.name ?? null,
      registered,
      count: room.users.size,
      users: publicUsersIn(room).map(u => u.name),
      messages,
      since,
      hasMore,
      lastSeq: room.seq,
      serverTime: Date.now(),
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
        // (web user, CLI via socket.io, bot) or a poll identity (AI agent
        // following the room via GET /poll). Deliver through the room path
        // instead of 403ing — mixed-transport setups, multi-instance
        // deploys and polling agents hit the old rejection constantly.
        const isPoll = key.startsWith('poll:')
        const sock = isPoll ? undefined : io.sockets.sockets.get(key)
        if (text === '/quit' || text === '/exit') {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: true }))
          if (isPoll) removeMember(key, 'left')
          else sock?.disconnect() // runs the normal leave/cleanup path
          return
        }
        if (text.startsWith('/nick ')) {
          const verdict = validateName(room, text.slice(6), key)
          if (!verdict.ok) {
            if (isPoll) res.writeHead(200, { 'Content-Type': 'application/json' }), res.end(JSON.stringify({ ok: false, reason: verdict.reason }))
            else sock?.emit('error', { text: verdict.reason }), res.writeHead(200, { 'Content-Type': 'application/json' }), res.end(JSON.stringify({ ok: true }))
          } else {
            const old = userName
            const u = room.users.get(key)
            if (u) u.name = verdict.name
            broadcastSystem(room, 'nick', `${old} is now known as ${verdict.name}`)
            if (!isPoll) sock?.emit('renamed', { you: verdict.name })
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ ok: true, renamed: verdict.name }))
          }
          return
        }
        if (text.startsWith('/me ')) {
          const act = clean(text.slice(4), 200)
          if (act) broadcastChat(room, userName, act, 'action')
        } else if (text === '/rooms' || text === '/users') {
          // Poll identities have no socket to emit to — answer inline.
          if (isPoll) {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(
              JSON.stringify(
                text === '/users'
                  ? { ok: true, users: publicUsersIn(room).map(u => u.name), count: room.users.size }
                  : { ok: true, rooms: roomsSummary(), total: totalOnline() }
              )
            )
            return
          }
          if (text === '/rooms') sock?.emit('rooms-list', { rooms: roomsSummary(), total: totalOnline() })
          else sock?.emit('users-list', { users: publicUsersIn(room), count: room.users.size })
        } else if (text.startsWith('/')) {
          const hint = 'Unknown command. Try: /me <action>, /nick <name>, /users, /rooms, /quit'
          if (isPoll) {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ ok: false, reason: hint }))
            return
          }
          sock?.emit('error', { text: hint })
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

  /* ---------- GET /history?room=X&before=SEQ&limit=N : lazy history ----------
   * Read-only, no join required (anyone with the room code may read).
   * format=json (default): { ok, room, messages, hasMore, lastSeq }
   * format=text: pre-formatted lines + X-History-Next / X-History-More headers
   *              (shell clients parse headers, never JSON). */
  if (req.method === 'GET' && url.pathname === '/history') {
    const { key: roomKey, label: roomLabel } = resolveRoom(url.searchParams.get('room'))
    const room = getRoom(roomKey, roomLabel)
    const beforeRaw = url.searchParams.get('before')
    const before =
      beforeRaw !== null && beforeRaw !== '' && Number.isFinite(Number(beforeRaw)) ? Number(beforeRaw) : undefined
    const page = pageHistory(room, before, Number(url.searchParams.get('limit')) || HISTORY_PAGE_DEFAULT)
    dropIfEmpty(room) // never leave a phantom room behind just for a history read
    if (url.searchParams.get('format') === 'text') {
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'X-History-Next': String(page.messages[0]?.seq ?? ''),
        'X-History-More': page.hasMore ? '1' : '0',
        'Cache-Control': 'no-store',
      })
      res.end(page.messages.length ? page.messages.map(m => formatLine(m)).join('\n') + '\n' : '')
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(
      JSON.stringify({
        ok: true,
        room: roomLabel,
        messages: page.messages,
        hasMore: page.hasMore,
        olderCount: page.olderCount,
        lastSeq: room.seq,
      })
    )
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
  res.end('not found — use GET /poll?room=X, GET /stream?name=X&room=Y, GET /history?room=Y or POST /send')
})

bridge.listen(BRIDGE_PORT, () => {
  console.log(
    `TermChat SSE bridge listening on :${BRIDGE_PORT} (GET /stream, GET /poll, POST /send, POST /pong, GET /history, rooms enabled)`
  )
  console.log(`History dir: ${HISTORY_DIR}`)
})

/* ---------- stale SSE + poll reaper: destroy zombie streams so names free up ---------- */
setInterval(() => {
  const now = Date.now()
  for (const room of [...rooms.values()]) {
    for (const [key, u] of [...room.users]) {
      if (key.startsWith('sse:')) {
        if (isSseStale(u)) {
          console.log(`[reaper] stale sse "${u.name}" @ ${room.label} (no pong > ${SSE_PONG_GRACE / 1000}s)`)
          room.sse.get(key)?.destroy() // 'close' handler performs the cleanup broadcast
        }
      } else if (key.startsWith('poll:')) {
        if (now - (u.lastPong ?? 0) > POLL_GRACE_MS) {
          console.log(`[reaper] stale poll "${u.name}" @ ${room.label} (no poll > ${POLL_GRACE_MS / 1000}s)`)
          removeMember(key, 'timed out') // broadcasts the leave notice + presence
        }
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

/* ---------- durability sweeper: keep every room's disk log in step with RAM ----------
 * Every 60s each live room's JSONL is stat-checked. If the file went missing or
 * SHRANK behind what we already wrote (host snapshot restore rolled the disk
 * back while this process kept running), the log is rebuilt from the in-RAM
 * window so history can never silently regress to an older snapshot. */
setInterval(() => {
  for (const room of rooms.values()) {
    if (!room.everJoined || !room.history.length) continue
    try {
      let size = -1
      try {
        size = statSync(roomLogPath(room.key)).size
      } catch {}
      if (size === room.diskBytes) continue
      if (size >= 0 && room.diskBytes !== undefined && size > room.diskBytes) {
        room.diskBytes = size // grew out-of-band (e.g. a second writer) — adopt, never clobber
        continue
      }
      if (room.diskBytes === undefined && size >= 0) {
        room.diskBytes = size // file appeared out-of-band — adopt
        continue
      }
      rebuildRoomLog(room)
    } catch (e) {
      console.error(`[history] sweep error for ${room.key}:`, e)
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
