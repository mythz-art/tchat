import { io } from 'socket.io-client'
const s = io('http://localhost:3003', { path: '/', forceNew: true, reconnection: false })
s.on('connect', () => {
  s.emit('join', { name: 'TerminalTom' })
  setTimeout(() => s.emit('message', { text: 'greetings from a real terminal client' }), 800)
  setTimeout(() => { s.disconnect(); process.exit(0) }, 2600)
})
