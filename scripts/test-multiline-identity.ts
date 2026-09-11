#!/usr/bin/env bun
/** Smoke test: (1) multi-line /send via SSE identity, (2) /send routed into a
 * socket.io identity (was 403 "socket.io clients should use the socket protocol"). */
import { io, type Socket } from 'socket.io-client'

const BASE = 'http://localhost:3004'
let pass = 0, fail = 0
const ok = (c: boolean, label: string) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${label}`); c ? pass++ : fail++ }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// --- web user (socket.io identity) in room "smoke9" ---
const web: Socket = io('http://localhost:3003', { path: '/', transports: ['websocket'], forceNew: true })
const seen: any[] = []
web.on('message', (m: any) => seen.push(m))
web.on('connect', () => web.emit('join', { name: 'WebGuy', room: 'smoke9' }))
await new Promise<void>(r => web.on('joined', () => r()))
await sleep(300)

// SSE user in the same room
const ac = new AbortController()
const sse = fetch(`${BASE}/stream?name=SseGuy&room=smoke9`, { signal: ac.signal })
const reader = (await sse).body!.getReader()
const dec = new TextDecoder()
let buf = ''
;(async () => { while (true) { const { value, done } = await reader.read(); if (done) break; buf += dec.decode(value, { stream: true }) } })()
await sleep(400)

// 1) multi-line message FROM the SSE user (joined lines with \n)
await fetch(`${BASE}/send`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'SseGuy', room: 'smoke9', text: 'line one\nline two\nline three' }) })
await sleep(400)
const ml = seen.find(m => m.from === 'SseGuy')
ok(!!ml && ml.text.includes('\n') && ml.text.split('\n').length === 3, 'multi-line text preserved over socket.io')

// 2) /send addressed to a socket.io identity (previously 403)
const r2 = await fetch(`${BASE}/send`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'WebGuy', room: 'smoke9', text: 'delivered to web identity via http' }) })
ok(r2.status === 200, `/send to socket.io identity returns 200 (got ${r2.status})`)
await sleep(400)
const viaHttp = seen.find(m => m.from === 'WebGuy' && m.text.includes('delivered to web identity'))
ok(!!viaHttp, 'message delivered + echoed into the room')

// 3) SSE rendering of multi-line stays single SSE event (newline -> " / ")
ok(!buf.includes('data: [') || !/\[.*\n.*\] SseGuy/.test(buf), 'SSE lines never contain raw newlines')

// 4) /quit via /send to socket.io identity frees the name
await fetch(`${BASE}/send`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'WebGuy', room: 'smoke9', text: '/quit' }) })
await sleep(500)
const web2: Socket = io('http://localhost:3003', { path: '/', transports: ['websocket'], forceNew: true })
let rejoined = false
web2.on('connect', () => web2.emit('join', { name: 'WebGuy', room: 'smoke9' }))
web2.on('joined', () => { rejoined = true })
await sleep(800)
ok(rejoined, 'name freed after http /quit to socket.io identity')
web2.disconnect(); web.disconnect(); ac.abort()
console.log(`\nResult: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
