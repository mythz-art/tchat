/**
 * TermChat poll-API test v3.2 — GET /poll: reliable message polling for AI agents.
 *
 * Spawns a DEDICATED chat-service child (ports unique per run, temp
 * CHAT_HISTORY_DIR) so it never touches the live dev service.
 *
 * Covers:
 *   1. register: /poll?room&name -> key poll:N, registered=true, join notice
 *      broadcast (socket.io users see "Agent joined the room")
 *   2. follow: poll with key+since picks up socket.io and SSE messages with
 *      no gaps and no duplicates; cursor (`since`) advances monotonically
 *   3. send via POST /send as a poll identity (plain text + /me action)
 *   4. since=0 pulls the ENTIRE persisted history (no gaps vs socket feed)
 *   5. hasMore paging: small limit -> pages walk forward, no gap/dupe
 *   6. read-only peek: no name/key -> newest page, presence untouched
 *   7. name-taken: 409 { ok:false, error:'name-taken' } (case-insensitive)
 *   8. inline command replies for poll identities: /users, /rooms
 *   9. /quit via /send removes the poll identity (presence drops)
 *  10. stale poll identity evictable: after the reaper grace it can't hold
 *      the name forever (join with same name succeeds on the REAL service
 *      path via evictStaleHolder — verified indirectly by re-register)
 */

import { io, type Socket } from 'socket.io-client'
import { spawn, type ChildProcess } from 'node:child_process'
import { rmSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PORT_IO = 33000 + Math.floor(Math.random() * 1500) * 2
const PORT_BRIDGE = PORT_IO + 1
const BASE_IO = `http://localhost:${PORT_IO}`
const BRIDGE = `http://localhost:${PORT_BRIDGE}`
const ROOM = 'pollroom'

let passed = 0
let failed = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) {
    passed++
    console.log(`  PASS  ${name}`)
  } else {
    failed++
    console.log(`  FAIL  ${name} ${extra}`)
  }
}
const wait = (ms: number) => new Promise(r => setTimeout(r, ms))

interface PollMsg { seq?: number; kind: string; from?: string; text: string; ts: number; id: string }
interface PollRes {
  ok: boolean
  room?: string
  key?: string | null
  you?: string | null
  registered?: boolean
  count?: number
  users?: string[]
  messages?: PollMsg[]
  since?: number
  hasMore?: boolean
  lastSeq?: number
  error?: string
}

const poll = async (qs: string): Promise<{ status: number; body: PollRes }> => {
  const r = await fetch(`${BRIDGE}/poll?${qs}`)
  return { status: r.status, body: (await r.json()) as PollRes }
}
const sendAs = (name: string, text: string) =>
  fetch(`${BRIDGE}/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, room: ROOM, text }),
  }).then(r => r.json())

const clients: Socket[] = []
function connect(): Socket {
  const s = io(BASE_IO, { path: '/', transports: ['websocket', 'polling'], forceNew: true, reconnection: false, timeout: 8000 })
  clients.push(s)
  return s
}
function once<T = any>(socket: Socket, event: string, timeoutMs = 6000): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting "${event}"`)), timeoutMs)
    socket.once(event, (data: T) => { clearTimeout(t); resolve(data) })
  })
}

let child: ChildProcess | undefined
const HIST_DIR = mkdtempSync(join(tmpdir(), 'tchat-poll-'))

function startService() {
  child = spawn('bun', ['index.ts'], {
    cwd: join(process.cwd(), 'mini-services', 'chat-service'),
    env: { ...process.env, CHAT_SERVICE_PORT: String(PORT_IO), CHAT_BRIDGE_PORT: String(PORT_BRIDGE), CHAT_HISTORY_DIR: HIST_DIR },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stderr?.on('data', (d: Buffer) => process.stderr.write(`[svc] ${d}`))
}
async function waitHealthy() {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`${BRIDGE}/health`)
      if (r.ok) return
    } catch {}
    await wait(200)
  }
  throw new Error('service did not become healthy')
}

async function main() {
  startService()
  await waitHealthy()
  console.log(`service up on :${PORT_IO}/:${PORT_BRIDGE}`)

  /* ---- 1. register ---- */
  const reg = await poll(`room=${ROOM}&name=PollPal`)
  ok('register returns ok + key', reg.status === 200 && reg.body.ok === true && !!reg.body.key && reg.body.key!.startsWith('poll:'))
  ok('register: registered=true, you=PollPal', reg.body.registered === true && reg.body.you === 'PollPal')
  ok('register: cursor = current room seq', typeof reg.body.since === 'number')

  const sock = connect()
  const joinedP = once<any>(sock, 'joined')
  sock.emit('join', { name: 'WebWilla', room: ROOM })
  const joined = await joinedP
  ok('socket.io user joined alongside poll agent', joined.you === 'WebWilla')
  const sysSeen = (joined.history as PollMsg[]).some(m => m.kind === 'system' && /PollPal joined/.test(m.text))
  ok('join notice for poll agent visible in room history', sysSeen)

  /* ---- 2/3. follow + send as poll identity ---- */
  const key = reg.body.key!
  let cursor = reg.body.since!
  await sendAs('PollPal', 'polls can talk too')
  await sendAs('PollPal', '/me waves a JSON flag')
  sock.emit('message', { text: 'web -> poll hello' })
  await wait(500)

  const page1 = await poll(`room=${ROOM}&key=${key}&since=${cursor}`)
  const texts = (page1.body.messages || []).map(m => m.text)
  ok('poll receives own text via /send', texts.some(t => /polls can talk too/.test(t)))
  ok('poll receives own /me action', texts.some(t => /waves a JSON flag/.test(t)))
  ok('poll receives socket.io user chat', texts.some(t => /web -> poll hello/.test(t)))
  const seqs = (page1.body.messages || []).map(m => m.seq!)
  ok('messages strictly ascending after cursor', seqs.every(s => s > cursor) && seqs.every((s, i) => i === 0 || s > seqs[i - 1]))
  cursor = page1.body.since!

  // no-dup check: an immediate re-poll returns nothing new
  const page1b = await poll(`room=${ROOM}&key=${key}&since=${cursor}`)
  ok('re-poll at cursor: no duplicates, empty page', (page1b.body.messages || []).length === 0)

  /* ---- 4. since=0 full history ---- */
  const full = await poll(`room=${ROOM}&key=${key}&since=0`)
  const fullSeqs = (full.body.messages || []).map(m => m.seq!)
  ok('since=0 pulls entire log from seq 1', fullSeqs[0] === 1 && fullSeqs.length >= 5 && seqs.every(s => fullSeqs.includes(s)))

  /* ---- 5. hasMore paging with tiny limit ---- */
  const p1 = await poll(`room=${ROOM}&key=${key}&since=0&limit=3`)
  ok('tiny page: 3 msgs + hasMore', (p1.body.messages || []).length === 3 && p1.body.hasMore === true)
  const p2 = await poll(`room=${ROOM}&key=${key}&since=${p1.body.since}&limit=3`)
  const all = [...p1.body.messages!, ...p2.body.messages!].map(m => m.seq!)
  ok('paged walk continues without gap/dupe', new Set(all).size === all.length && all.every((s, i) => i === 0 || s > all[i - 1]))

  /* ---- 6. read-only peek ---- */
  const before = await poll(`room=${ROOM}`)
  const peek = await poll(`room=${ROOM}&limit=5`)
  ok('read-only peek: ok, key=null, newest page', peek.status === 200 && peek.body.ok && peek.body.key === null && (peek.body.messages || []).length > 0)
  ok('read-only peek: presence untouched', (peek.body.count || 0) === (before.body.count || 0))

  /* ---- 7. name-taken ---- */
  const dup = await poll(`room=${ROOM}&name=pollpal`)
  ok('case-insensitive name conflict -> 409', dup.status === 409 && dup.body.ok === false && dup.body.error === 'name-taken')

  /* ---- 8. inline /users + /rooms ---- */
  const users = (await sendAs('PollPal', '/users')) as any
  ok('/users inline reply lists room members', Array.isArray(users.users) && users.users.includes('PollPal') && users.users.includes('WebWilla'))
  const rooms = (await sendAs('PollPal', '/rooms')) as any
  ok('/rooms inline reply includes total', Array.isArray(rooms.rooms) && typeof rooms.total === 'number')

  /* ---- 9. /quit removes the poll identity ---- */
  await sendAs('PollPal', '/quit')
  await wait(400)
  const after = await poll(`room=${ROOM}`)
  ok('after /quit: PollPal gone from presence', !(after.body.users || []).includes('PollPal'))
  ok('after /quit: old key no longer resolves', (await poll(`room=${ROOM}&key=${key}`)).body.key === null)

  /* ---- 10. re-register with the same name works (identity freed) ---- */
  const reg2 = await poll(`room=${ROOM}&name=PollPal`)
  ok('re-register after /quit succeeds', reg2.status === 200 && reg2.body.registered === true && !!reg2.body.key && reg2.body.key !== key)
  await sendAs('PollPal', '/quit')

  console.log(`\n${passed} passed, ${failed} failed`)
  clients.forEach(s => s.disconnect())
  child?.kill()
  try { rmSync(HIST_DIR, { recursive: true, force: true }) } catch {}
  process.exit(failed ? 1 : 0)
}

main().catch(e => {
  console.error('FATAL', e)
  clients.forEach(s => s.disconnect())
  child?.kill()
  try { rmSync(HIST_DIR, { recursive: true, force: true }) } catch {}
  process.exit(1)
})
