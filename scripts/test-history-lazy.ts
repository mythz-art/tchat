/**
 * TermChat history test v3.1 — persistent history + lazy pagination (#22).
 *
 * Spawns a DEDICATED chat-service child (ports 3113/3114, temp CHAT_HISTORY_DIR)
 * so it can hard-kill and restart it without touching the live dev service.
 *
 * Covers:
 *   1. join replay: recent page served, hasMore=true when older exists
 *   2. socket 'history' pagination walks back to the very first message
 *      (hasMore=false at the end; the full set, no gaps, no dupes)
 *   3. HTTP GET /history JSON pagination matches the socket feed
 *   4. HTTP /history?format=text: pre-formatted lines + X-History-Next/More
 *   5. CROSS-RESTART PERSISTENCE: kill -9 the service, restart on the same
 *      history dir, page again — every pre-restart message still readable
 *   6. SSE join replay + "older messages" hint line
 *   7. empty rooms dropped from RAM do not delete the disk log (sweeper-safe
 *      hydration path — exercised by the restart in step 5)
 */

import { io, type Socket } from 'socket.io-client'
import { spawn, type ChildProcess } from 'node:child_process'
import { rmSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PORT_IO = 32000 + Math.floor(Math.random() * 1500) * 2 // unique per run: orphaned children from crashed runs can never collide
const PORT_BRIDGE = PORT_IO + 1
const BASE_IO = `http://localhost:${PORT_IO}`
const BRIDGE = `http://localhost:${PORT_BRIDGE}`
const ROOM = 'histroom'
const N_MSGS = 80 // > 50 (join replay window) so lazy pagination must wrap

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
async function sseJoin(name: string): Promise<string[]> {
  const lines: string[] = []
  const ac = new AbortController()
  const res = await fetch(`${BRIDGE}/stream?name=${name}&room=${ROOM}`, { signal: ac.signal })
  ;(async () => {
    try {
      const reader = res.body!.getReader()
      const dec = new TextDecoder()
      let buf = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        let i: number
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim()
          buf = buf.slice(i + 1)
          if (line.startsWith('data:')) lines.push(line.slice(5).trim())
        }
      }
    } catch {}
  })()
  await wait(300)
  return lines as any
}
const send = (text: string) =>
  fetch(`${BRIDGE}/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'writer', room: ROOM, text }),
  }).then(r => r.json())

let child: ChildProcess | undefined
const HIST_DIR = mkdtempSync(join(tmpdir(), 'tchat-hist-'))

function startService() {
  // spawn the file DIRECTLY (not `bun run`) — `bun run` interposes a wrapper
  // process, and kill(9) on the wrapper orphans the real listener.
  child = spawn('bun', ['index.ts'], {
    cwd: join(process.cwd(), 'mini-services', 'chat-service'),
    env: { ...process.env, CHAT_SERVICE_PORT: String(PORT_IO), CHAT_BRIDGE_PORT: String(PORT_BRIDGE), CHAT_HISTORY_DIR: HIST_DIR },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
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
async function waitDead() {
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(`${BRIDGE}/health`)
    } catch {
      return
    }
    await wait(200)
  }
  throw new Error('test service still alive 10s after kill(9)')
}
const drain = () => Promise.allSettled([])

try {
  console.log(`history dir: ${HIST_DIR}\n`)

  /* ---------------- step 1: seed 40 messages ---------------- */
  startService()
  await waitHealthy()

  const writer = connect()
  writer.emit('join', { name: 'writer', room: ROOM })
  await once(writer, 'joined')
  for (let i = 1; i <= N_MSGS; i++) {
    await send(`msg ${String(i).padStart(2, '0')}`)
    await wait(30)
  }
  await wait(300)

  /* ---------------- step 2: join replay + hasMore ---------------- */
  const reader = connect()
  const joinedP = once<any>(reader, 'joined')
  reader.emit('join', { name: 'reader', room: ROOM })
  const joined = await joinedP
  ok('join replayes 50 recent messages', Array.isArray(joined.history) && joined.history.length === 50, `got ${joined.history?.length}`)
  ok('join marks hasMore=true', joined.hasMore === true)
  ok('join payload carries lastSeq', typeof joined.lastSeq === 'number' && joined.lastSeq >= N_MSGS, `lastSeq=${joined.lastSeq}`)
  const seqs = joined.history.map((m: any) => m.seq)
  ok('replay seqs strictly ascending', seqs.every((s: number, i: number) => i === 0 || s > seqs[i - 1]))
  const newestChat = [...joined.history].reverse().find((m: any) => m.kind === 'chat')?.text
  ok('replay ends at the newest chat message', newestChat === `msg ${String(N_MSGS).padStart(2, '0')}`, newestChat)

  /* ---------------- step 3: socket pagination to the start ---------------- */
  const collected: any[] = [...joined.history]
  let more = true
  let guard = 0
  while (more && guard++ < 10) {
    const pageP = once<any>(reader, 'history-page')
    reader.emit('history', { before: collected[0].seq, limit: 30 })
    const page = await pageP
    collected.unshift(...page.messages)
    more = page.hasMore
  }
  const chatMsgs = collected.filter(m => m.kind === 'chat')
  const nums = chatMsgs.map(m => Number(m.text.replace('msg ', '')))
  ok('pagination reaches hasMore=false', more === false)
  ok('all 40 seeded messages retrievable', chatMsgs.length >= N_MSGS, `got ${chatMsgs.length}`)
  ok('no gaps in paged history', new Set(nums).size === nums.length && nums.every(n => n >= 1 && n <= N_MSGS))
  ok('oldest page starts at msg 01', chatMsgs[0]?.text === 'msg 01', chatMsgs[0]?.text)

  /* ---------------- step 4: HTTP /history JSON ---------------- */
  const r1 = await (await fetch(`${BRIDGE}/history?room=${ROOM}&limit=35`)).json()
  ok('HTTP json: page size honored', r1.messages.length === 35, `got ${r1.messages?.length}`)
  const r1NewestChat = [...r1.messages].reverse().find((m: any) => m.kind === 'chat')?.text
  ok('HTTP json: newest page ends at last chat msg', r1NewestChat === `msg ${String(N_MSGS).padStart(2, '0')}`, r1NewestChat)
  ok('HTTP json: hasMore=true on latest page', r1.hasMore === true)
  const r2 = await (await fetch(`${BRIDGE}/history?room=${ROOM}&before=${r1.messages[0].seq}&limit=35`)).json()
  ok('HTTP json: second page reaches older messages', r2.messages.length > 0 && r2.messages[0].seq < r1.messages[0].seq)
  ok('HTTP json: two pages overlap-free', !r1.messages.some((m: any) => r2.messages.some((x: any) => x.id === m.id)))

  /* ---------------- step 5: HTTP /history text mode ---------------- */
  const tres = await fetch(`${BRIDGE}/history?room=${ROOM}&limit=5&format=text`)
  const ttext = await tres.text()
  ok('HTTP text: content-type text/plain', (tres.headers.get('content-type') || '').includes('text/plain'))
  ok('HTTP text: 5 formatted lines', ttext.trim().split('\n').length === 5)
  ok('HTTP text: X-History-More=1', tres.headers.get('x-history-more') === '1')
  const next = tres.headers.get('x-history-next')
  ok('HTTP text: X-History-Next cursor present', !!next && next !== '')
  const tres2 = await fetch(`${BRIDGE}/history?room=${ROOM}&before=${next}&limit=100&format=text`)
  const t2text = await tres2.text()
  ok('HTTP text: paging via cursor reaches msg 01', t2text.includes('msg 01'))

  /* ---------------- step 6: SSE replay + hint ---------------- */
  const sseLines = await sseJoin('ssewatch')
  await send('after-sse-joined')
  await wait(400)
  ok('SSE join replays recent messages', sseLines.filter(l => l.includes('msg ')).length >= 12, `got ${sseLines.filter(l => l.includes('msg ')).length}`)
  ok('SSE join shows older-history hint', sseLines.some(l => l.includes('older message') && l.includes('/history')))

  /* ---------------- step 7: KILL -9 + restart = history survives ---------------- */
  writer.disconnect(); reader.disconnect()
  child?.kill(9)
  await waitDead() // hard guarantee the listener is gone before the restart leg
  await drain()
  await wait(300)

  startService()
  await waitHealthy()
  const r3 = await (await fetch(`${BRIDGE}/history?room=${ROOM}&limit=100`)).json()
  const postMsgs = r3.messages.filter((m: any) => m.kind === 'chat')
  ok('RESTART: pre-restart messages all readable', postMsgs.length >= N_MSGS + 1, `got ${postMsgs.length}`)
  ok('RESTART: msg 01 still there', postMsgs.some((m: any) => m.text === 'msg 01'))
  ok('RESTART: seq continuity preserved', r3.lastSeq >= N_MSGS + 1, `lastSeq=${r3.lastSeq}`)

  const restartReader = connect()
  const j2P = once<any>(restartReader, 'joined')
  restartReader.emit('join', { name: 'afterrestart', room: ROOM })
  const j2 = await j2P
  ok('RESTART: join replays hydrated history', j2.history.length === 50 && j2.hasMore === true)
  // msg 01 sits BELOW the 50-item replay window now — reach it by paging, as
  // any lazy client would (this is the cross-restart socket-path proof).
  const restCollected: any[] = [...j2.history]
  let restMore = true
  let restGuard = 0
  while (restMore && restGuard++ < 10) {
    const pP = once<any>(restartReader, 'history-page')
    restartReader.emit('history', { before: restCollected[0].seq, limit: 50 })
    const pg = await pP
    restCollected.unshift(...pg.messages)
    restMore = pg.hasMore
  }
  ok('RESTART: paging from join reaches pre-restart msg 01', restCollected.some((m: any) => m.text === 'msg 01'))

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
} catch (e) {
  console.error('TEST ERROR:', e)
  process.exit(1)
} finally {
  for (const s of clients) try { s.disconnect() } catch {}
  try { child?.kill(9); await drain() } catch {}
  try { rmSync(HIST_DIR, { recursive: true, force: true }) } catch {}
}
