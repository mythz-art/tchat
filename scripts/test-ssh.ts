/**
 * SSH transport E2E — connects to the TermChat SSH server with a real SSH client
 * (ssh2 lib; no system ssh needed) and verifies the full chat flow.
 *
 *   ssh 7XK92@localhost -p 2222   (username = room code, any auth accepted)
 *
 * Covers: name prompt, join banner with room, socket.io -> SSH delivery,
 *         SSH -> socket.io delivery, /users, /quit (clean session close).
 */

// ssh2 is installed in the ssh-service workspace
import { Client } from '../mini-services/ssh-service/node_modules/ssh2/lib/index.js'
import { io, type Socket } from 'socket.io-client'

const SSH_PORT = Number(process.env.SSH_TEST_PORT || 2222)
const ROOM = '7XK92'

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

class SshTerm {
  out = ''
  private waiters: { pred: (o: string) => boolean; resolve: () => void; timer: NodeJS.Timeout }[] = []
  closed = false

  constructor(private stream: any) {
    stream.on('data', (d: Buffer) => {
      this.out += String(d)
      this.waiters = this.waiters.filter(w => {
        if (w.pred(this.out)) {
          clearTimeout(w.timer)
          w.resolve()
          return false
        }
        return true
      })
    })
    stream.on('close', () => {
      this.closed = true
      this.flushWaiters()
    })
  }

  private flushWaiters() {
    this.waiters = this.waiters.filter(w => {
      if (this.closed && w.pred(this.out)) {
        clearTimeout(w.timer)
        w.resolve()
        return false
      }
      if (this.closed) {
        clearTimeout(w.timer)
        w.reject?.(new Error('ssh stream closed'))
        return false
      }
      return true
    })
  }

  waitFor(pred: (o: string) => boolean, timeoutMs = 8000): Promise<void> {
    if (pred(this.out)) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter(w => w.resolve !== resolve)
        reject(new Error(`ssh timeout. out=${this.out.slice(-240)}`))
      }, timeoutMs)
      this.waiters.push({ pred, resolve, timer } as any)
    })
  }

  write(s: string) {
    this.stream.write(s)
  }
}

function once<T = any>(socket: Socket, event: string, timeoutMs = 8000): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting "${event}"`)), timeoutMs)
    socket.once(event, (data: T) => {
      clearTimeout(t)
      resolve(data)
    })
  })
}

async function main() {
  console.log('TermChat SSH E2E — starting\n')
  const NAME = `SshSue${Math.random().toString(36).slice(2, 5)}`

  // socket.io peer in the same room for cross-transport assertions
  const peer: Socket = io('http://localhost:3003', {
    path: '/',
    transports: ['websocket', 'polling'],
    forceNew: true,
    reconnection: false,
  })
  await once(peer, 'connect')
  peer.emit('join', { name: 'SsoSam', room: ROOM })
  const pj = await once<any>(peer, 'joined')
  ok('peer SsoSam joined ' + ROOM, pj.room === ROOM)

  // --- SSH connect (room code as username, no password -> 'none' auth) ---
  const conn = new Client()
  const stream = await new Promise<any>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('ssh connect/shell timeout')), 12000)
    conn
      .on('ready', () => {
        conn.shell({ term: 'xterm-256color', cols: 100, rows: 30 }, (err: any, s: any) => {
          clearTimeout(t)
          if (err) reject(err)
          else resolve(s)
        })
      })
      .on('error', (e: Error) => {
        clearTimeout(t)
        reject(e)
      })
      .connect({ host: '127.0.0.1', port: SSH_PORT, username: ROOM, readyTimeout: 10000 })
  })
  ok(`ssh session opened (room=${ROOM} as username)`, !!stream)

  const term = new SshTerm(stream)

  // --- name prompt + join ---
  await term.waitFor(o => o.includes('guest name:'))
  ok('ssh shows guest name prompt', true)
  term.write(`${NAME}\r`)
  await term.waitFor(o => stripAnsi(o).includes(`Connected to room ${ROOM} as ${NAME}`))
  ok('ssh joined room ' + ROOM, true)

  // peer sees the ssh user
  peer.emit('users')
  const ul = await once<any>(peer, 'users-list')
  ok('ssh user appears in room users list', (ul.users || []).some((u: any) => u.name === NAME))

  // --- socket.io -> SSH delivery ---
  peer.emit('message', { text: 'ping over socket' })
  await term.waitFor(o => stripAnsi(o).includes('SsoSam: ping over socket'))
  ok('socket.io message reached SSH session', true)

  // --- SSH -> socket.io delivery ---
  const gotP = once<any>(peer, 'message')
  term.write('hello from ssh\r')
  const got = await gotP
  ok('ssh message reached socket.io peer', got.from === NAME && got.text === 'hello from ssh')

  // --- /me over ssh ---
  const actP = once<any>(peer, 'message')
  term.write('/me waves from the shell\r')
  const act = await actP
  ok('ssh /me action delivered', act.kind === 'action' && act.from === NAME && act.text === 'waves from the shell')

  // --- /users over ssh ---
  term.write('/users\r')
  await term.waitFor(o => stripAnsi(o).includes('in this room'))
  ok('ssh /users works', true)

  // --- /quit closes cleanly ---
  const peerLeaveP = once<any>(peer, 'system', 8000)
  term.write('/quit\r')
  await term.waitFor(o => stripAnsi(o).includes('Bye!'))
  ok('ssh /quit says bye', true)
  const leave = await peerLeaveP
  ok('peer saw ssh user leave', String(leave?.text || '').includes(`${NAME} left`))
  await wait(400)
  ok('ssh stream closed by server', term.closed)

  conn.end()
  peer.disconnect()

  console.log(`\nResult: ${passed} passed, ${failed} failed`)
  process.exitCode = failed === 0 ? 0 : 1
}

main().catch(err => {
  console.error('SSH E2E ERROR:', err.message)
  process.exitCode = 1
})

setTimeout(() => {
  console.error('GLOBAL WATCHDOG: ssh test did not finish in 60s')
  process.exit(2)
}, 60_000).unref()
