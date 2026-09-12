/** Manual repro: does an SSH-typed message reach a socket.io peer? Prints
 * every 'message' event the peer receives so races are visible. */
import { Client } from '../mini-services/ssh-service/node_modules/ssh2/lib/index.js'
import { io, type Socket } from 'socket.io-client'

const ROOM = 'sshdbg'
const NAME = `Dbg${Math.random().toString(36).slice(2, 5)}`
const wait = (ms: number) => new Promise(r => setTimeout(r, ms))

const peer: Socket = io('http://localhost:3003', { path: '/', forceNew: true, reconnection: false })
await new Promise(r => peer.once('connect', r))
peer.emit('join', { name: 'SsoSam', room: ROOM })
await new Promise<any>(r => peer.once('joined', r))
console.log('[peer] joined', ROOM)

peer.on('message', (m: any) => console.log(`[peer] message from=${m.from} kind=${m.kind} text=${JSON.stringify(m.text)}`))
peer.on('system', (m: any) => console.log(`[peer] system: ${m.text}`))

const conn = new Client()
const stream: any = await new Promise((resolve, reject) => {
  conn.on('ready', () =>
    conn.shell({ term: 'xterm' }, (err: any, s: any) => (err ? reject(err) : resolve(s)))
  )
  conn.on('error', reject)
  conn.connect({ host: '127.0.0.1', port: 2222, username: ROOM, readyTimeout: 10000 })
})
let out = ''
stream.on('data', (d: Buffer) => (out += String(d)))
await wait(500)
stream.write(`${NAME}\r`)
await wait(800)
console.log('[ssh] joined?', out.includes(`Connected to room ${ROOM} as ${NAME}`))

console.log('--- peer sends ping, then ssh types ---')
peer.emit('message', { text: 'ping over socket' })
await wait(600)
stream.write('hello from ssh\r')
await wait(1200)
stream.write('/me waves from the shell\r')
await wait(1200)
console.log('--- done ---')
stream.end()
conn.end()
peer.disconnect()
process.exit(0)
