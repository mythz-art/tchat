/**
 * Runs the REAL bundled client (public/chat.cjs) as a subprocess, joins the room,
 * and verifies a broadcast from another user is delivered to the client's stdout
 * in real time. Then exercises /me and /quit.
 */

import { spawn } from 'child_process'
import { io } from 'socket.io-client'

const CLIENT_URL = 'http://localhost:81/?XTransformPort=3003' // same path as public users

let passed = 0
let failed = 0
const ok = (name: string, cond: boolean, extra = '') => {
  if (cond) {
    passed++
    console.log(`  PASS  ${name}`)
  } else {
    failed++
    console.log(`  FAIL  ${name} ${extra}`)
  }
}

async function main() {
  console.log('Bundled client E2E — starting\n')

  const child = spawn('node', ['/home/z/my-project/public/chat.cjs', CLIENT_URL], {
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  let out = ''
  child.stdout.on('data', d => (out += d.toString()))
  child.stderr.on('data', d => (out += d.toString()))
  const wrote = (s: string) => child.stdin.write(s)

  await new Promise(r => setTimeout(r, 1500))
  ok('client started and shows room prompt', out.includes('Room code'), out.slice(0, 200))

  wrote('7XK92\n') // pick the room
  await new Promise(r => setTimeout(r, 1200))
  ok('client shows guest name prompt', out.includes('Choose a guest name'), out.slice(-300))
  wrote('ShellGuy\n') // pick the guest name
  await new Promise(r => setTimeout(r, 1500))
  const plainEarly = out.replace(/\x1b\[[0-9;]*m/g, '')
  ok('client joined room 7XK92', plainEarly.includes('Connected to room 7XK92 as ShellGuy'), plainEarly.slice(-300))

  // another user sends a broadcast; it must appear in the client's stdout
  const bot = io('http://localhost:3003', { path: '/', forceNew: true, reconnection: false })
  await new Promise(r => bot.on('connect', r))
  bot.emit('join', { name: 'EchoBot', room: '7XK92' })
  await new Promise(r => setTimeout(r, 600))
  bot.emit('message', { text: 'ping from EchoBot' })

  let delivered = false
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 250))
    if (out.includes('ping from EchoBot')) {
      delivered = true
      break
    }
  }
  ok('realtime message delivered into the terminal client', delivered)

  wrote('/me waves\n')
  await new Promise(r => setTimeout(r, 800))
  const plainOut = out.replace(/\x1b\[[0-9;]*m/g, '') // strip ANSI color codes
  ok('/me action echoed back', plainOut.includes('* ShellGuy waves'))

  wrote('/quit\n')
  const code: number = await new Promise(r => child.on('exit', c => r(c ?? -1)))
  ok('client exits cleanly on /quit', code === 0, `code=${code}`)
  bot.disconnect()

  console.log(`\nResult: ${passed} passed, ${failed} failed`)
  process.exitCode = failed === 0 ? 0 : 1
}

main().catch(err => {
  console.error('ERROR:', err)
  process.exitCode = 1
})
