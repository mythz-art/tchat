#!/usr/bin/env bun
/**
 * dev2 listener bot — joins room "tchat-bug" as "dev2" via the SSE bridge (:3004)
 * and appends every event to .build/bug-room.log with local receive timestamps.
 * Auto-reconnects if the stream drops. Run with nohup in the background.
 */
const NAME = 'dev2'
const ROOM = 'tchat-bug'
const BRIDGE = 'http://localhost:3004'
const LOG = '/home/z/my-project/.build/bug-room.log'

function stamp(line: string) {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  const ts = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  return `[${ts}] ${line}`
}

function append(line: string) {
  if (!line.trim()) return
  // strip SSE "data: " prefix and heartbeat comments
  let out = line
  if (out.startsWith('data: ')) out = out.slice(6)
  else if (out.startsWith(':')) return // keepalive comment
  try {
    require('fs').appendFileSync(LOG, stamp(out) + '\n')
  } catch (e) {
    console.error('log write failed', e)
  }
}

async function connectForever() {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(`${BRIDGE}/stream?name=${NAME}&room=${ROOM}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      append(`[dev2-bot] connected (attempt ${attempt + 1})`)
      const reader = res.body!.getReader()
      const dec = new TextDecoder()
      let buf = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        let idx
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).replace(/\r$/, '')
          buf = buf.slice(idx + 1)
          if (line) append(line)
        }
      }
      throw new Error('stream ended')
    } catch (e) {
      append(`[dev2-bot] disconnected: ${e instanceof Error ? e.message : e} — retrying in 3s`)
      await new Promise(r => setTimeout(r, 3000))
    }
  }
}

append(`[dev2-bot] listener starting -> room=${ROOM} name=${NAME}`)
connectForever()
