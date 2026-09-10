/**
 * TermChat E2E test v3 — socket.io users + zero-dependency SSE clients, MULTI-ROOM.
 *
 *   A, B connect DIRECTLY   -> http://localhost:3003                       (socket.io)
 *   G connects VIA GATEWAY  -> http://localhost:81/?XTransformPort=3003
 *   S/GW as SSE             -> :3004 /stream (direct + via gateway)
 *   RoomX/roomy             -> room isolation, per-room names, rooms-list
 *
 * Covers: joins, duplicate-name rejection (per room), cross-transport broadcast,
 *         gateway round-trips, /nick, users list, history replay, /me, /quit,
 *         name-taken over SSE, NO rate limiting (30 rapid sends), room isolation.
 */

import { io, type Socket } from 'socket.io-client'

const DIRECT_IO = 'http://localhost:3003'
const GATEWAY_IO = 'http://localhost:81/?XTransformPort=3003'
const DIRECT_SSE_BASE = 'http://localhost:3004'
const GATEWAY_SSE_BASE = 'http://localhost:81'

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

function connect(url: string): Socket {
  const s = io(url, {
    path: '/',
    transports: ['websocket', 'polling'],
    forceNew: true,
    reconnection: false,
    timeout: 8000,
  })
  clients.push(s)
  return s
}

function once<T = any>(socket: Socket, event: string, timeoutMs = 5000): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting "${event}"`)), timeoutMs)
    socket.once(event, (data: T) => {
      clearTimeout(t)
      resolve(data)
    })
  })
}

function collect(socket: Socket, event: string, pred: (d: any) => boolean, timeoutMs = 5000): Promise<any> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout collecting "${event}"`)), timeoutMs)
    const handler = (d: any) => {
      if (pred(d)) {
        clearTimeout(t)
        socket.off(event, handler)
        resolve(d)
      }
    }
    socket.on(event, handler)
  })
}

/** Minimal SSE consumer: reads `data:` lines from a text/event-stream response. */
class SseClient {
  lines: string[] = []
  closed = false
  private buf = ''
  private decoder = new TextDecoder()
  private pending: {
    pred: (l: string) => boolean
    resolve: (v: string) => void
    reject: (e: Error) => void
    timer: ReturnType<typeof setTimeout>
  } | null = null
  private ac = new AbortController()

  close() {
    try {
      this.ac.abort()
    } catch {}
  }

  constructor(url: string) {
    fetch(url, { headers: { Accept: 'text/event-stream' }, signal: this.ac.signal }).then(
      async resp => {
        const reader = resp.body!.getReader()
        try {
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            this.buf += this.decoder.decode(value, { stream: true })
            let idx: number
            while ((idx = this.buf.indexOf('\n\n')) >= 0) {
              const frame = this.buf.slice(0, idx)
              this.buf = this.buf.slice(idx + 2)
              for (const l of frame.split('\n')) {
                if (l.startsWith('data:')) {
                  const d = l.slice(5).trimStart()
                  if (d) {
                    this.lines.push(d)
                    this.pump()
                  }
                }
              }
            }
          }
        } catch {}
        this.closed = true
        const p = this.pending
        if (p) {
          this.pending = null
          clearTimeout(p.timer)
          p.reject(new Error('SSE stream closed while waiting'))
        }
      },
      () => {
        this.closed = true
      }
    )
  }

  /** If a waiter is pending, resolve it with the FIRST buffered line matching its pred. */
  private pump() {
    const p = this.pending
    if (!p) return
    const i = this.lines.findIndex(p.pred)
    if (i >= 0) {
      const [line] = this.lines.splice(i, 1)
      this.pending = null
      clearTimeout(p.timer)
      p.resolve(line)
    }
  }

  /** Wait for a line matching pred; checks the buffer first, then every live arrival. */
  waitFor(pred: (line: string) => boolean, timeoutMs = 5000): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = null
        reject(new Error('timeout waiting SSE line'))
      }, timeoutMs)
      this.pending = { pred, resolve, reject, timer }
      this.pump()
    })
  }
}

async function sendViaBridge(base: string, name: string, text: string): Promise<number> {
  const resp = await fetch(`${base}/send?XTransformPort=3004`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ name, text }).toString(),
  })
  return resp.status
}

async function main() {
  console.log('TermChat E2E v3 — starting\n')

  const A = connect(DIRECT_IO)
  const B = connect(DIRECT_IO)
  const G = connect(GATEWAY_IO)

  await Promise.all([once(A, 'connect'), once(B, 'connect'), once(G, 'connect')])
  console.log('  ....  sockets connected (2 direct, 1 via gateway :81)')

  A.emit('join', { name: 'Alice' })
  const joinedA = await once(A, 'joined')
  ok('A joined as Alice', joinedA.you === 'Alice')

  B.emit('join', { name: 'alice' }) // case-insensitive duplicate
  const rejectedB = await once<any>(B, 'name-rejected')
  ok('duplicate name rejected', typeof rejectedB.reason === 'string' && rejectedB.reason.includes('taken'))

  B.emit('join', { name: 'Bob' })
  await once(B, 'joined')

  const joinNoticeA = collect(A, 'system', d => d.text?.includes('GuestG'))
  G.emit('join', { name: 'GuestG' })
  const joinedG = await once(G, 'joined')
  const nA = await joinNoticeA
  ok('G joined via gateway as GuestG', joinedG.you === 'GuestG')
  ok('join notice broadcast', nA.text.includes('GuestG joined'))

  /* -------- socket.io <-> socket.io basics -------- */
  const msgA = collect(A, 'message', d => d.text === 'hello from the gateway')
  G.emit('message', { text: 'hello from the gateway' })
  const mA = await msgA
  ok('gateway message broadcast', mA.from === 'GuestG')

  const msgG = collect(G, 'message', d => d.text === 'hi direct here')
  const selfEcho = collect(A, 'message', d => d.text === 'hi direct here')
  A.emit('message', { text: 'hi direct here' })
  const [mG, mSelf] = await Promise.all([msgG, selfEcho])
  ok('direct message broadcast', mG.from === 'Alice')
  ok('sender receives own echo', mSelf.from === 'Alice')

  /* -------- SSE shell client (direct :3004) -------- */
  const joinSeenAPromise = collect(A, 'system', d => d.text.includes('ShellSam joined'))
  const S = new SseClient(`${DIRECT_SSE_BASE}/stream?name=ShellSam`)
  const sConn = await S.waitFor(l => l.includes('Connected as ShellSam'))
  ok('SSE client connected as ShellSam', sConn.includes('ShellSam'), sConn)
  const joinSeen = await joinSeenAPromise
  ok('socket.io user sees SSE join', joinSeen.text.includes('ShellSam'))

  // shell -> socket.io (register collector BEFORE sending — server broadcasts before replying)
  const fromShellP = collect(A, 'message', d => d.text === 'hello from curl')
  await sendViaBridge(DIRECT_SSE_BASE, 'ShellSam', 'hello from curl')
  const fromShell = await fromShellP
  ok('shell message reaches socket.io room', fromShell.from === 'ShellSam')

  // socket.io -> shell
  A.emit('message', { text: 'hi shell friend' })
  const shellGot = await S.waitFor(l => l.includes('hi shell friend'))
  ok('socket.io message reaches shell client', shellGot.includes('Alice: hi shell friend'), shellGot)

  // /me from shell
  const actP = collect(A, 'message', d => d.kind === 'action' && d.text === 'waves a fin')
  await sendViaBridge(DIRECT_SSE_BASE, 'ShellSam', '/me waves a fin')
  const act = await actP
  ok('shell /me action broadcast', act.from === 'ShellSam')

  // /nick from shell
  const nickLineP = collect(A, 'system', d => d.subtype === 'nick')
  await sendViaBridge(DIRECT_SSE_BASE, 'ShellSam', '/nick ShellTerry')
  const nickLine = await nickLineP
  ok('shell /nick rename broadcast', nickLine.text.includes('ShellSam is now known as ShellTerry'))

  // shell user appears in socket.io users-list (merged registry)
  G.emit('users')
  const usersList = await once<any>(G, 'users-list')
  const names = usersList.users.map((u: any) => u.name)
  ok('users list merges SSE + socket users', names.includes('ShellTerry') && names.includes('Alice'), JSON.stringify(names))

  /* -------- duplicate name over SSE -> rejected + stream closed -------- */
  const S2 = new SseClient(`${DIRECT_SSE_BASE}/stream?name=ShellTerry`)
  const rej = await S2.waitFor(l => l.startsWith('!!'))
  ok('SSE duplicate name rejected', rej.includes('taken'), rej)
  await wait(400)
  ok('SSE duplicate stream closed by server', S2.closed)

  /* -------- SSE via gateway (public path) -------- */
  const GW = new SseClient(`${GATEWAY_SSE_BASE}/stream?XTransformPort=3004&name=GwSam`)
  const gwConn = await GW.waitFor(l => l.includes('Connected as GwSam'))
  ok('SSE via gateway connected as GwSam', gwConn.includes('GwSam'), gwConn)

  const gwMsgP = collect(A, 'message', d => d.text === 'gateway shell hello')
  await sendViaBridge(GATEWAY_SSE_BASE, 'GwSam', 'gateway shell hello')
  const gwMsg = await gwMsgP
  ok('gateway shell message reaches room', gwMsg.from === 'GwSam')

  A.emit('message', { text: 'reply to gateway shell' })
  const gwGot = await GW.waitFor(l => l.includes('reply to gateway shell'))
  ok('room message reaches gateway shell', gwGot.includes('Alice: reply to gateway shell'), gwGot)

  /* -------- history replay for a newcomer (socket.io) -------- */
  const D = connect(DIRECT_IO)
  await once(D, 'connect')
  D.emit('join', { name: 'Dave' })
  const joinedD = await once<any>(D, 'joined')
  const histTexts = (joinedD.history || []).map((m: any) => m.text)
  ok('newcomer history includes shell msg', histTexts.includes('hello from curl'))

  /* -------- NO rate limiting: 30 rapid messages all accepted + delivered -------- */
  const rapidCollector = collect(A, 'message', d => d.text === 'rapid 29', 10000)
  let rapidFail = false
  for (let i = 0; i < 30; i++) {
    const st = await sendViaBridge(GATEWAY_SSE_BASE, 'GwSam', `rapid ${i}`)
    if (st !== 200) rapidFail = true
  }
  await rapidCollector
  ok('no rate limiting — 30 rapid sends all accepted', !rapidFail)
  ok('rapid message #30 delivered', true)

  /* -------- /quit closes the SSE stream + leaves the room -------- */
  const leaveLine = collect(A, 'system', d => d.subtype === 'leave' && d.text.includes('GwSam'))
  await sendViaBridge(GATEWAY_SSE_BASE, 'GwSam', '/quit')
  await leaveLine
  await wait(400)
  ok('shell /quit leaves the room (stream closed)', GW.closed)

  /* ================= v3: ROOMS ================= */
  const RX = connect(DIRECT_IO)
  const RY = connect(DIRECT_IO)
  await Promise.all([once(RX, 'connect'), once(RY, 'connect')])

  RX.emit('join', { name: 'Xavier', room: 'RoomX' })
  const joinedRX = await once<any>(RX, 'joined')
  ok('Xavier joined RoomX (label kept)', joinedRX.room === 'RoomX', JSON.stringify(joinedRX.room))

  RY.emit('join', { name: 'Yara', room: 'roomy' })
  const joinedRY = await once<any>(RY, 'joined')
  ok('Yara joined roomy', joinedRY.room === 'roomy', JSON.stringify(joinedRY.room))

  // isolation: RoomX traffic must NOT leak into roomy
  let yaraGot = false
  const yaraHandler = (d: any) => {
    if (d.text === 'secret for RoomX') yaraGot = true
  }
  RY.on('message', yaraHandler)
  RX.emit('message', { text: 'secret for RoomX' })
  const xavierSelf = await collect(RX, 'message', d => d.text === 'secret for RoomX')
  ok('RoomX message echoed to sender', xavierSelf.from === 'Xavier')
  await wait(800)
  RY.off('message', yaraHandler)
  ok('rooms are isolated (roomy saw nothing)', !yaraGot)

  // same name in two different rooms is allowed
  const RX2 = connect(DIRECT_IO)
  await once(RX2, 'connect')
  RX2.emit('join', { name: 'Xavier', room: 'roomy' })
  const joinedRX2 = await once<any>(RX2, 'joined')
  ok('same name allowed in another room', joinedRX2.you === 'Xavier' && joinedRX2.room === 'roomy')

  // duplicate name INSIDE the same room still rejected
  const RX3 = connect(DIRECT_IO)
  await once(RX3, 'connect')
  RX3.emit('join', { name: 'xavier', room: 'RoomX' }) // case-insensitive, same room
  const dupRoom = await once<any>(RX3, 'name-rejected')
  ok('duplicate name rejected within a room', String(dupRoom.reason).includes('taken'))
  RX3.disconnect()

  // SSE client with room param
  const joinRinaP = collect(RX, 'system', d => d.text.includes('SseRina'))
  const SR = new SseClient(`${DIRECT_SSE_BASE}/stream?name=SseRina&room=RoomX`)
  const srConn = await SR.waitFor(l => l.includes('Connected as SseRina') && l.includes('RoomX'))
  ok('SSE joined RoomX', srConn.includes('RoomX'), srConn)
  await joinRinaP

  // socket.io -> SSE (same room)
  RX.emit('message', { text: 'room hello sse' })
  const srGot = await SR.waitFor(l => l.includes('room hello sse'))
  ok('room-scoped socket.io -> SSE delivery', srGot.includes('Xavier: room hello sse'), srGot)

  // SSE -> socket.io (same room)
  const rinaP = collect(RX, 'message', d => d.text === 'sse room hello')
  const resp = await fetch(`${DIRECT_SSE_BASE}/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ name: 'SseRina', text: 'sse room hello', room: 'RoomX' }).toString(),
  })
  ok('SSE room send accepted', resp.status === 200)
  const rinaMsg = await rinaP
  ok('room-scoped SSE -> socket.io delivery', rinaMsg.from === 'SseRina')

  // ambiguous name across rooms -> 409 without room hint
  const ambResp = await fetch(`${DIRECT_SSE_BASE}/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ name: 'Xavier', text: 'which room am i?' }).toString(),
  })
  ok('ambiguous cross-room send rejected (409)', ambResp.status === 409)
  // room-hinted send: the sender must be an SSE user; hint scopes the search
  const hintP = collect(RX, 'message', d => d.text === 'hinted room send')
  let yaraHintGot = false
  const yaraHint = (d: any) => {
    if (d.text === 'hinted room send') yaraHintGot = true
  }
  RY.on('message', yaraHint)
  const hintResp = await fetch(`${DIRECT_SSE_BASE}/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ name: 'SseRina', text: 'hinted room send', room: 'RoomX' }).toString(),
  })
  ok('room-hinted SSE send accepted', hintResp.status === 200)
  await hintP
  await wait(500)
  RY.off('message', yaraHint)
  ok('room-hinted send stayed in RoomX', !yaraHintGot)

  // rooms-list
  RX.emit('rooms')
  const roomsList = await once<any>(RX, 'rooms-list')
  const roomKeys = roomsList.rooms.map((r: any) => r.key)
  ok(
    'rooms-list shows active rooms + counts',
    roomKeys.includes('roomx') && roomKeys.includes('roomy') && roomKeys.includes('lobby'),
    JSON.stringify(roomKeys)
  )
  ok('rooms-list carries headcounts', roomsList.rooms.every((r: any) => typeof r.users === 'number'))

  // leave notice is room-scoped
  let yaraLeaveGot = false
  const yaraLeave = (d: any) => {
    if (d.text?.includes('Xavier left')) yaraLeaveGot = true
  }
  RY.on('system', yaraLeave)
  const srLeaveP = SR.waitFor(l => l.includes('Xavier left the room'), 4000)
  RX.disconnect()
  await srLeaveP
  ok('leave notice room-scoped (SSE RoomX saw it)', true)
  await wait(600)
  RY.off('system', yaraLeave)
  ok('roomy did not see RoomX leave notice', !yaraLeaveGot)

  SR.close()
  RX2.disconnect()
  RY.disconnect()

  /* -------- cleanup: rename + leave notice -------- */
  const leaveNotice = collect(B, 'system', d => d.subtype === 'leave' && d.text.includes('Alicia'))
  A.emit('nick', { name: 'Alicia' })
  await once(A, 'renamed')
  A.disconnect()
  const ln = await leaveNotice
  ok('leave notice broadcast on disconnect', ln.text.includes('Alicia left the room'))

  B.disconnect()
  G.disconnect()
  D.disconnect()
  S.close()
  S2.close()
  GW.close()

  console.log(`\nResult: ${passed} passed, ${failed} failed`)
  process.exitCode = failed === 0 ? 0 : 1
}

main()
  .catch(err => {
    console.error('E2E ERROR:', err.message)
    process.exitCode = 1
  })
  .finally(() => {
    for (const s of clients) {
      try {
        s.disconnect()
      } catch {}
    }
  })

setTimeout(() => {
  console.error('GLOBAL WATCHDOG: test did not finish in 75s')
  process.exit(2)
}, 75_000).unref()
