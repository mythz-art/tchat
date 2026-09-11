#!/usr/bin/env bun
/**
 * dev2 public-instance bot — connects to https://tchat.space-z.ai via socket.io
 * (same path as the website), joins room tchat-bug as dev2.
 * Logs all room events to .build/bug-room-public.log.
 * Watching a control file for replies: append "SEND::text" lines to
 * .build/dev2-pub-send.txt and the bot emits them as chat messages.
 */
import { io } from 'socket.io-client'
import { appendFileSync, readFileSync, statSync } from 'fs'

/* NOTE: no file lock here — the overlayfs/FUSE layer serves stale metadata
 * across processes (rm'd files still visible), which made lock races
 * unwinnable. Single instance is ensured by starting exactly one bot. */

const NAME = 'dev2'
const ROOM = 'tchat-bug'
const URL_ = 'https://tchat.space-z.ai/?XTransformPort=3003'
const LOG = '/home/z/my-project/.build/bug-room-public.log'
const SEND_FILE = '/home/z/my-project/.build/dev2-pub-send.txt'

const stamp = () => {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}
const log = (line: string) => {
  try { appendFileSync(LOG, `[${stamp()}] ${line}\n`) } catch {}
}

const socket = io(URL_, {
  path: '/',
  transports: ['websocket', 'polling'],
  reconnection: true,
  reconnectionDelay: 2000,
})

let sendOffset = 0

function pollSendFile() {
  try {
    const st = statSync(SEND_FILE)
    if (st.size > sendOffset) {
      const chunk = readFileSync(SEND_FILE, 'utf8').slice(sendOffset)
      sendOffset = st.size
      for (const line of chunk.split('\n')) {
        const t = line.trim()
        if (!t.startsWith('SEND::')) continue
        const text = t.slice(6)
        if (text) {
          socket.emit('message', { text })
          log(`[dev2-SEND] ${text}`)
        }
      }
    }
  } catch { /* file may not exist yet */ }
}

socket.on('connect', () => {
  log(`[bot] connected sid=${socket.id} — joining ${ROOM} as ${NAME}`)
  socket.emit('join', { name: NAME, room: ROOM })
})

let joinRetries = 0
socket.on('name-rejected', (e: any) => {
  log(`[name-rejected] ${e?.reason}`)
  // ghost of a previous instance may hold the name for up to pingTimeout — retry
  if (joinRetries < 20) {
    joinRetries += 1
    setTimeout(() => {
      if (socket.connected && !joinedOk) socket.emit('join', { name: NAME, room: ROOM })
    }, 5000)
  }
})
let joinedOk = false

socket.on('joined', (d: any) => {
  joinedOk = true
  log(`[bot] joined room "${d?.room}" as "${d?.you}" — users: ${(d?.users || []).map((u: any) => u.name).join(', ')}`)
  for (const m of d?.history || []) {
    if (m.kind === 'chat') log(`[hist] ${m.from}: ${m.text}`)
    else if (m.kind === 'action') log(`[hist] * ${m.from} ${m.text}`)
    else log(`[hist] — ${m.text}`)
  }
})

socket.on('message', (m: any) => log(`${m?.from}: ${m?.text}`))
socket.on('action', (m: any) => log(`* ${m?.from} ${m?.text}`))
socket.on('system', (m: any) => log(`— ${m?.text}`))
socket.on('presence', (p: any) => log(`[presence] ${p?.room}: ${p?.count} (total ${p?.total})`))
socket.on('name-rejected', (e: any) => log(`[name-rejected] ${e?.reason}`))
socket.on('error', (e: any) => log(`[server-error] ${e?.text || JSON.stringify(e)}`))
socket.on('disconnect', (reason: string) => log(`[bot] disconnected: ${reason}`))
socket.on('reconnect', () => log('[bot] reconnected'))

setInterval(pollSendFile, 1000)
