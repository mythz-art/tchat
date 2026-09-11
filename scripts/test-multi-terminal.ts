/**
 * Multi-terminal E2E — REAL terminal processes in REAL rooms.
 *
 *  1. runs public/install.sh (downloads the NATIVE binary through the gateway)
 *  2. spawns the installed native `tchat` binary  -> room 7XK92 as "Nina"
 *  3. spawns node public/chat.cjs                 -> room 7XK92 as "TermTom"
 *  4. spawns bash public/g.sh (legacy SSE client) -> lobby as "BashDan"
 *  5. an in-process socket.io user "Ollie" joins 7XK92 for assertions
 *
 * Verifies: install.sh works end-to-end; native binary connects; cross-client
 * realtime delivery inside a room; /rooms output; lobby <-> 7XK92 isolation.
 */

import { spawn, type ChildProcess } from 'child_process'
import { io, type Socket } from 'socket.io-client'
import { existsSync, rmSync } from 'fs'

const GATEWAY = 'http://localhost:81'
const INSTALL_DIR = '/tmp/tchat-inst-test'
const BIN = `${INSTALL_DIR}/tchat`

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

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '')

/** Collects output from a child process and waits for matching lines. */
class Term {
  out = ''
  private waiters: { pred: (o: string) => boolean; resolve: () => void; timer: NodeJS.Timeout }[] = []
  private done = false
  private exitCode: number | null = null
  exitWaiters: ((c: number | null) => void)[] = []

  constructor(public child: ChildProcess) {
    child.stdout?.on('data', d => this.push(String(d)))
    child.stderr?.on('data', d => this.push(String(d)))
    child.on('exit', c => {
      this.done = true
      this.exitCode = c
      for (const w of this.exitWaiters.splice(0)) w(c)
    })
  }

  private push(chunk: string) {
    if (this.done) return
    this.out += chunk
    this.waiters = this.waiters.filter(w => {
      if (w.pred(this.out)) {
        clearTimeout(w.timer)
        w.resolve()
        return false
      }
      return true // keep waiting for future chunks
    })
  }

  waitFor(pred: (o: string) => boolean, timeoutMs = 8000): Promise<void> {
    if (pred(this.out)) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter(w => w.resolve !== resolve)
        reject(new Error(`timeout waiting for output: ${this.out.slice(-300)}`))
      }, timeoutMs)
      this.waiters.push({ pred, resolve, timer })
    })
  }

  write(s: string) {
    this.child.stdin?.write(s)
  }

  async exit(timeoutMs = 6000): Promise<number | null> {
    if (this.done) return this.exitCode
    return new Promise(resolve => {
      const t = setTimeout(() => resolve(null), timeoutMs)
      this.exitWaiters.push(c => {
        clearTimeout(t)
        resolve(c)
      })
    })
  }

  kill() {
    try {
      this.child.kill('SIGKILL')
    } catch {}
  }
}

function spawnTerm(cmd: string, args: string[], env: Record<string, string>): Term {
  // Wrap in `bash -c 'exec ...'`: bun's fork+exec of the 94MB binary blocks the parent
  // event loop; letting bash perform the exec keeps the test process responsive.
  const quoted = [cmd, ...args].map(a => `'${String(a).replace(/'/g, `'\''`)}'`).join(' ')
  const child = spawn('bash', ['-c', `exec ${quoted}`], {
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  return new Term(child)
}

function once<T = any>(socket: Socket, event: string, timeoutMs = 6000, pred?: (data: T) => boolean): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting "${event}"`)), timeoutMs)
    const handler = (data: T) => {
      // optional predicate: skip events that belong to someone else (e.g. the
      // sender's own echo arriving late — same race class as the pump fix)
      if (pred && !pred(data)) {
        socket.once(event, handler)
        return
      }
      clearTimeout(t)
      resolve(data)
    }
    socket.once(event, handler)
  })
}

async function main() {
  console.log('TermChat multi-terminal E2E — starting\n')

  // unique suffix per run — dead sockets from crashed runs keep names taken for ~60s
  const SUF = Math.random().toString(36).slice(2, 6)
  const NINA = `Nina${SUF}`
  const TOM = `Tom${SUF}`
  const DAN = `Dan${SUF}`

  /* -------- step 1: install.sh end-to-end through the gateway -------- */
  rmSync(INSTALL_DIR, { recursive: true, force: true })
  const inst = spawn('sh', ['public/install.sh'], {
    cwd: '/home/z/my-project',
    env: { ...process.env, TCHAT_INSTALL_DIR: INSTALL_DIR, TCHAT_DOWNLOAD_BASE: GATEWAY },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const instOut = await new Promise<string>((resolve, reject) => {
    let o = ''
    inst.stdout?.on('data', d => (o += d))
    inst.stderr?.on('data', d => (o += d))
    inst.on('exit', c => (c === 0 ? resolve(o) : reject(new Error(`install.sh exit ${c}: ${o}`))))
    setTimeout(() => reject(new Error('install.sh timeout')), 120000)
  })
  ok('install.sh completed', instOut.includes('Installed:'), instOut.slice(-200))
  // the installer may upgrade the location to a dir already on PATH (e.g. /usr/local/bin)
  const binPath = existsSync(BIN) ? BIN : existsSync('/usr/local/bin/tchat') ? '/usr/local/bin/tchat' : BIN
  ok('install.sh placed the binary', existsSync(binPath), instOut.slice(-300))
  const ver = spawn(binPath, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] })
  const verOut = await new Promise<string>(res => {
    let o = ''
    ver.stdout?.on('data', d => (o += d))
    ver.on('exit', () => res(o))
  })
  ok('installed binary runs --version', verOut.includes('tchat 3.0.0'), verOut)

  /* -------- step 2-4: spawn three real terminals (handshake each) -------- */
  const ENV = { CHAT_URL: GATEWAY }
  const nina = spawnTerm(binPath, ['7XK92'], ENV) // native binary -> room 7XK92
  await nina.waitFor(o => o.includes('guest name:'), 15000)
  nina.write(`${NINA}\n`)

  const tom = spawnTerm('node', ['public/chat.cjs', '7XK92'], ENV) // node cli -> room 7XK92
  await tom.waitFor(o => o.includes('guest name:'), 15000)
  tom.write(`${TOM}\n`)

  const dan = spawnTerm('bash', ['public/g.sh'], { TCHAT_URL: GATEWAY }) // legacy SSE -> lobby
  await dan.waitFor(o => o.includes('guest name:'), 15000)
  dan.write(`${DAN}\n`)

  await nina.waitFor(o => stripAnsi(o).includes(`Connected to room 7XK92 as ${NINA}`))
  ok('native binary joined 7XK92 as ' + NINA, true)
  await tom.waitFor(o => stripAnsi(o).includes(`Connected to room 7XK92 as ${TOM}`))
  ok('node chat.cjs joined 7XK92 as ' + TOM, true)
  await dan.waitFor(o => o.includes(`Connected as ${DAN}`))
  ok('legacy g.sh joined lobby as ' + DAN, true)

  /* -------- step 5: socket.io observer in 7XK92 -------- */
  const ollie: Socket = io(GATEWAY + '/?XTransformPort=3003', {
    path: '/',
    transports: ['websocket', 'polling'],
    forceNew: true,
    reconnection: false,
  })
  await once(ollie, 'connect')
  ollie.emit('join', { name: 'Ollie', room: '7XK92' })
  const j = await once<any>(ollie, 'joined')
  ok('Ollie joined 7XK92 via gateway', j.room === '7XK92')

  /* -------- cross-client delivery in 7XK92 -------- */
  ollie.emit('message', { text: 'hello from ollie' })
  await nina.waitFor(o => stripAnsi(o).includes('Ollie: hello from ollie'))
  ok('native binary received socket.io message', true)
  await tom.waitFor(o => stripAnsi(o).includes('Ollie: hello from ollie'))
  ok('node cli received socket.io message', true)

  await tom.waitFor(o => stripAnsi(o).includes(`${NINA} joined the room`)) // system notice sanity

  tom.write('hi from node cli\n')
  const gotTom = await once<any>(ollie, 'message', 6000, m => m.from === TOM)
  ok('node cli message reached Ollie', gotTom.from === TOM && gotTom.text === 'hi from node cli')
  await nina.waitFor(o => stripAnsi(o).includes(`${TOM}: hi from node cli`))
  ok('native binary saw node cli message', true)

  nina.write('hi from native binary\n')
  const gotNina = await once<any>(ollie, 'message', 6000, m => m.from === NINA)
  ok('native binary message reached Ollie', gotNina.from === NINA && gotNina.text === 'hi from native binary')
  await tom.waitFor(o => stripAnsi(o).includes(`${NINA}: hi from native binary`))
  ok('node cli saw native binary message', true)

  /* -------- /rooms from the native binary -------- */
  nina.write('/rooms\n')
  await nina.waitFor(o => /7xk92/i.test(stripAnsi(o)) && /lobby/i.test(stripAnsi(o)))
  ok('native binary /rooms lists rooms + lobby', true)

  /* -------- isolation: lobby (BashDan) <-> 7XK92 -------- */
  let ollieSawLobby = false
  const leak = (d: any) => {
    if (d.text === 'lobby only hello') ollieSawLobby = true
  }
  ollie.on('message', leak)
  dan.write('lobby only hello\n')
  await dan.waitFor(o => o.includes(`${DAN}: lobby only hello`))
  ok('g.sh client sees own message in lobby', true)
  await wait(800)
  ollie.off('message', leak)
  ok('lobby message did NOT leak into 7XK92', !ollieSawLobby)
  const tomHasLobby = stripAnsi(tom.out).includes(`${DAN}: lobby only hello`)
  ok('node cli in 7XK92 did not receive lobby traffic', !tomHasLobby)

  /* -------- leave: /quit from native binary -------- */
  const leaveP = once<any>(ollie, 'system', 8000).then(() => true).catch(() => false) // register BEFORE quitting
  nina.write('/quit\n')
  const ninaExit = await nina.exit()
  ok('native binary /quit exits cleanly (0)', ninaExit === 0, String(ninaExit))
  await wait(500)
  ok(`Ollie saw ${NINA} leave (system notice)`, await leaveP)

  tom.write('/quit\n')
  const tomExit = await tom.exit()
  ok('node cli /quit exits cleanly (0)', tomExit === 0, String(tomExit))

  dan.write('/quit\n')
  const danExit = await dan.exit()
  ok('g.sh /quit exits cleanly (0)', danExit === 0, String(danExit))

  ollie.disconnect()

  console.log(`\nResult: ${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1) // hard exit: spawned pty children keep the loop alive
}

main()
  .catch(err => {
    console.error('MULTI-TERMINAL ERROR:', err.message)
    process.exitCode = 1
  })
  .finally(() => {
    // best-effort cleanup
  })

setTimeout(() => {
  console.error('GLOBAL WATCHDOG: multi-terminal test did not finish in 180s')
  process.exit(2)
}, 180_000).unref()
