'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { motion } from 'framer-motion';
import {
  Terminal,
  Copy,
  Check,
  Users,
  Keyboard,
  Radio,
  Zap,
  Globe,
  ArrowRight,
  CircleCheck,
  Plug,
  Download,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import BrowserChat, { cleanRoomInput } from '@/components/BrowserChat';

const SITE = 'https://tchat.space-z.ai';

/* ------------------------------ copy helper ------------------------------ */

function CopyRow({ cmd, hint, note }: { cmd: string; hint: string; note?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(() => {
    navigator.clipboard?.writeText(cmd).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1800);
      },
      () => {}
    );
  }, [cmd]);
  return (
    <div>
      <button
        type="button"
        onClick={copy}
        className="group w-full text-left rounded-lg border border-zinc-800 bg-black/60 hover:border-emerald-500/40 transition-colors px-3 py-2.5"
        aria-label={`Copy: ${cmd}`}
      >
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] font-mono text-zinc-400 group-hover:text-zinc-200 truncate">{hint}</span>
          {copied ? (
            <Check className="h-3.5 w-3.5 text-emerald-400 shrink-0" aria-hidden="true" />
          ) : (
            <Copy className="h-3 w-3 text-zinc-500 group-hover:text-zinc-300 shrink-0" aria-hidden="true" />
          )}
        </div>
        <code className="mt-1 block text-[12.5px] font-mono text-zinc-100 truncate">{cmd}</code>
      </button>
      {note && <p className="mt-1 text-[11px] text-zinc-400 px-1">{note}</p>}
    </div>
  );
}

/* ----------------------------- component ----------------------------- */

export default function Home() {
  const router = useRouter();
  const [online, setOnline] = useState(0);
  const [roomCode, setRoomCode] = useState('');

  // Live "N online" counter for everyone on the page (joined or not).
  // Polls the chat-service /health endpoint through the same gateway the
  // socket uses; the BrowserChat onStats callback keeps it updated in
  // between polls once you actually join a room.
  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const res = await fetch('/health?XTransformPort=3004', { cache: 'no-store' });
        if (!res.ok) return;
        const j = await res.json();
        if (alive && j?.ok) setOnline(Number(j.users) || 0);
      } catch {
        /* gateway hiccup — keep the last known value */
      }
    };
    poll();
    const iv = setInterval(poll, 5000);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, []);

  const openRoom = useCallback(() => {
    const r = cleanRoomInput(roomCode) || 'lobby';
    router.push(`/r/${encodeURIComponent(r)}`);
  }, [roomCode, router]);

  return (
    <div
      className="min-h-screen flex flex-col bg-zinc-950 text-zinc-100 selection:bg-emerald-500/30"
      style={{ fontFamily: 'var(--font-geist-mono), ui-monospace, SFMono-Regular, Menlo, monospace' }}
    >
      {/* ------------------------------- header ------------------------------- */}
      <header className="border-b border-zinc-800/80 bg-zinc-950/90 backdrop-blur sticky top-0 z-20">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="h-9 w-9 rounded-lg border border-emerald-500/40 bg-emerald-500/10 flex items-center justify-center shrink-0">
              <Terminal className="h-5 w-5 text-emerald-400" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <div className="font-bold tracking-tight leading-none">TermChat</div>
              <div className="text-[11px] text-zinc-500 leading-tight truncate">one chatroom · every terminal</div>
            </div>
          </div>
          <div className="flex items-center gap-2 sm:gap-3 shrink-0">
            <Badge variant="outline" className="gap-1.5 font-mono text-xs border-emerald-500/40 text-emerald-400">
              <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" aria-hidden="true" />
              LIVE
            </Badge>
            <Badge variant="outline" className="gap-1.5 font-mono text-xs border-zinc-700 text-zinc-300">
              <Users className="h-3.5 w-3.5" aria-hidden="true" />
              {online} online
            </Badge>
          </div>
        </div>
      </header>

      <main className="flex-1">
        {/* -------------------------------- hero -------------------------------- */}
        <section className="relative overflow-hidden border-b border-zinc-800/80">
          <div
            className="pointer-events-none absolute inset-0 opacity-[0.06]"
            style={{
              backgroundImage:
                'repeating-linear-gradient(0deg, transparent, transparent 2px, #10b981 3px, #10b981 4px)',
            }}
            aria-hidden="true"
          />
          <div className="relative max-w-6xl mx-auto px-4 sm:px-6 py-14 sm:py-20">
            <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5 }}>
              <div className="inline-flex items-center gap-2 text-emerald-400 text-sm mb-4 font-mono">
                <Radio className="h-4 w-4" aria-hidden="true" />
                <span>tchat.space-z.ai · realtime · rooms · guest access</span>
              </div>
              <h1 className="text-3xl sm:text-5xl font-bold tracking-tight leading-tight">
                One chatroom.
                <br />
                Every <span className="text-emerald-400">terminal</span> you have.
              </h1>
              <p className="mt-4 text-zinc-300 text-base sm:text-lg leading-relaxed max-w-2xl">
                Join with a room code from the native CLI, a zero-install HTTPS terminal, or right here in the
                browser — no account, everything real-time and cross-connected. Pure HTTPS, so it works on any
                network.
              </p>

              {/* room quick-open */}
              <div className="mt-8 flex flex-col sm:flex-row gap-2 max-w-xl">
                <Input
                  value={roomCode}
                  onChange={e => setRoomCode(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') openRoom();
                  }}
                  placeholder="room code, e.g. 7XK92 (blank = lobby)"
                  maxLength={24}
                  className="bg-zinc-950 border-zinc-800 text-zinc-100 placeholder:text-zinc-500 font-mono"
                  aria-label="Room code"
                />
                <Button
                  onClick={openRoom}
                  className="gap-1.5 bg-emerald-500 hover:bg-emerald-600 text-zinc-950 font-semibold shrink-0"
                >
                  Open web room
                  <ArrowRight className="h-4 w-4" aria-hidden="true" />
                </Button>
              </div>
              <p className="mt-2 text-xs text-zinc-400">
                or scroll down — the live web chat is embedded on this page.
              </p>
            </motion.div>
          </div>
        </section>

        {/* --------------------------- 3 joining methods --------------------------- */}
        <section className="max-w-6xl mx-auto px-4 sm:px-6 py-12 sm:py-16">
          <h2 className="text-xl font-bold tracking-tight mb-6 flex items-center gap-2">
            <Plug className="h-5 w-5 text-emerald-400" aria-hidden="true" />
            Three ways in — pick your favorite
          </h2>
          <div className="grid gap-4 sm:gap-6 md:grid-cols-3 items-start">
            {/* 1 — native CLI */}
            <motion.div initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, delay: 0.05 }}>
              <Card className="h-full bg-zinc-900/60 border-zinc-800 hover:border-emerald-500/30 transition-colors">
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <div className="h-10 w-10 rounded-lg border border-zinc-800 bg-zinc-950 flex items-center justify-center">
                      <Terminal className="h-5 w-5 text-emerald-400" aria-hidden="true" />
                    </div>
                    <span className="text-[10px] font-mono uppercase tracking-wider text-emerald-400/80 border border-emerald-500/30 rounded px-1.5 py-0.5">
                      best experience
                    </span>
                  </div>
                  <CardTitle className="text-base pt-2 text-zinc-100">1 · Native CLI — tchat</CardTitle>
                  <CardDescription>
                    Install once (a single standalone binary — no Node, no npm), then join any room with one short
                    command.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-2.5">
                  <CopyRow
                    hint="macOS / Linux — install"
                    cmd={`curl -fsSL ${SITE}/i.sh | sh`}
                  />
                  <CopyRow
                    hint="Windows PowerShell — install"
                    cmd={`irm ${SITE}/i.ps1 | iex`}
                  />
                  <CopyRow hint="then, from any terminal" cmd="tchat join 7XK92" note="Or: tchat 7XK92 -n Sam · tchat (Enter = lobby)" />
                </CardContent>
              </Card>
            </motion.div>

            {/* 2 — HTTPS terminal, zero install */}
            <motion.div initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, delay: 0.1 }}>
              <Card className="h-full bg-zinc-900/60 border-zinc-800 hover:border-emerald-500/30 transition-colors">
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <div className="h-10 w-10 rounded-lg border border-zinc-800 bg-zinc-950 flex items-center justify-center">
                      <Zap className="h-5 w-5 text-emerald-400" aria-hidden="true" />
                    </div>
                    <span className="text-[10px] font-mono uppercase tracking-wider text-zinc-400 border border-zinc-600 rounded px-1.5 py-0.5">
                      zero install · pure https
                    </span>
                  </div>
                  <CardTitle className="text-base pt-2 text-zinc-100">2 · HTTPS terminal — nothing to install</CardTitle>
                  <CardDescription>
                    A live terminal chat with zero setup — it only needs curl or PowerShell, which your system
                    already has. Works on networks and hosts where SSH ports are blocked.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-2.5">
                  <CopyRow
                    hint="macOS / Linux / WSL — just run it"
                    cmd={`curl -fsSL ${SITE}/g | bash`}
                  />
                  <CopyRow
                    hint="Windows PowerShell — just run it"
                    cmd={`iex (irm ${SITE}/p)`}
                  />
                  <p className="text-[11px] text-zinc-400 px-1">
                    Pick a room:{' '}
                    <span className="font-mono text-zinc-200 break-all">curl -fsSL {SITE}/g | ROOM=7XK92 bash</span>
                    {' '}·{' '}
                    <span className="font-mono text-zinc-200 break-all">$env:TCHAT_ROOM=&apos;7XK92&apos;; iex (irm {SITE}/p)</span>
                  </p>
                </CardContent>
              </Card>
            </motion.div>

            {/* 3 — web */}
            <motion.div initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, delay: 0.15 }}>
              <Card className="h-full bg-zinc-900/60 border-zinc-800 hover:border-emerald-500/30 transition-colors">
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <div className="h-10 w-10 rounded-lg border border-zinc-800 bg-zinc-950 flex items-center justify-center">
                      <Globe className="h-5 w-5 text-emerald-400" aria-hidden="true" />
                    </div>
                    <span className="text-[10px] font-mono uppercase tracking-wider text-zinc-500 border border-zinc-700 rounded px-1.5 py-0.5">
                      no terminal
                    </span>
                  </div>
                  <CardTitle className="text-base pt-2 text-zinc-100">3 · Web</CardTitle>
                  <CardDescription>
                    No terminal around? Any browser works. Share the link and the whole room joins you.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-2.5">
                  <CopyRow hint="lobby — always open" cmd={`${SITE}/r/lobby`} />
                  <CopyRow hint="any room" cmd={`${SITE}/r/7XK92`} />
                  <p className="text-[11px] text-zinc-400 px-1">
                    The live web chat is embedded right below — try it now.
                  </p>
                </CardContent>
              </Card>
            </motion.div>
          </div>
        </section>

        {/* ------------------------------ how it works ------------------------------ */}
        <section className="border-t border-zinc-800/80 bg-zinc-900/30">
          <div className="max-w-6xl mx-auto px-4 sm:px-6 py-12">
            <div className="grid gap-4 sm:gap-6 md:grid-cols-3">
              {[
                {
                  icon: Download,
                  step: '01',
                  title: 'Install once (optional)',
                  body: 'The CLI is a single native binary — no runtime, no dependencies. Or skip installation entirely and chat right in the browser.',
                },
                {
                  icon: Keyboard,
                  step: '02',
                  title: 'Pick a room + guest name',
                  body: 'Room codes are free-form — invent one (7XK92, team, family) and share it. Names are unique per room, no account needed.',
                },
                {
                  icon: Zap,
                  step: '03',
                  title: 'Chat in real time',
                  body: 'Messages appear instantly on every connected CLI, zero-install terminal and browser in the room. /me, /nick, /rooms all included.',
                },
              ].map(({ icon: Icon, step, title, body }) => (
                <div key={step} className="flex gap-3">
                  <div className="h-9 w-9 rounded-lg border border-zinc-800 bg-zinc-950 flex items-center justify-center shrink-0">
                    <Icon className="h-5 w-5 text-emerald-400" aria-hidden="true" />
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold">{title}</span>
                      <span className="text-[10px] font-mono text-zinc-500">{step}</span>
                    </div>
                    <p className="mt-1 text-sm text-zinc-400 leading-relaxed">{body}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* --------------------------- embedded web chat --------------------------- */}
        <section className="max-w-6xl mx-auto px-4 sm:px-6 pb-12 sm:pb-16">
          <Card className="bg-zinc-900/60 border-zinc-800 max-w-2xl mx-auto">
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2 text-zinc-100">
                <Globe className="h-4 w-4 text-emerald-400" aria-hidden="true" />
                Live web chat — same rooms, right now
              </CardTitle>
              <CardDescription>
                This is the real room, not a demo. Say hi and it appears instantly in every connected CLI,
                zero-install terminal and browser.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <BrowserChat onStats={setOnline} />
            </CardContent>
          </Card>
        </section>

        {/* --------------------------- commands table --------------------------- */}
        <section className="border-t border-zinc-800/80 bg-zinc-900/30">
          <div className="max-w-6xl mx-auto px-4 sm:px-6 py-12 sm:py-16 grid gap-6 lg:grid-cols-2">
            <div>
              <h2 className="text-xl font-bold tracking-tight flex items-center gap-2">
                <Keyboard className="h-5 w-5 text-emerald-400" aria-hidden="true" />
                Commands inside the room
              </h2>
              <p className="mt-2 text-sm text-zinc-300 leading-relaxed">
                Everything works without leaving your keyboard, on every transport.{' '}
                <span className="text-zinc-100">/me</span>, <span className="text-zinc-100">/nick</span> and{' '}
                <span className="text-zinc-100">/quit</span> work everywhere; the native CLI adds{' '}
                <span className="text-zinc-100">/rooms</span> to hop between rooms, plus colored names, history replay
                and auto-reconnect.
              </p>
              <p className="mt-3 text-sm text-zinc-400 flex items-center gap-1.5">
                <CircleCheck className="h-4 w-4 text-emerald-500 shrink-0" aria-hidden="true" />
                Room codes are case-insensitive — <span className="text-zinc-200 font-mono">7xk92</span> ={' '}
                <span className="text-zinc-200 font-mono">7XK92</span>.
              </p>
            </div>
            <div className="rounded-xl border border-zinc-800 bg-black/60 overflow-hidden">
              <table className="w-full text-sm font-mono">
                <tbody>
                  {[
                    ['/nick <name>', 'rename yourself'],
                    ['/me <action>', 'send an emote, e.g. /me waves'],
                    ['/users', 'list everyone in this room'],
                    ['/rooms', 'list active rooms + headcounts'],
                    ['/clear', 'clear the terminal screen'],
                    ['/url', 'show the server + room you are on'],
                    ['/help', 'show command help'],
                    ['/quit', 'leave the room'],
                  ].map(([cmd, desc]) => (
                    <tr key={cmd} className="border-b border-zinc-800/70 last:border-0">
                      <td className="px-4 py-2.5 text-emerald-400 whitespace-nowrap align-top">{cmd}</td>
                      <td className="px-4 py-2.5 text-zinc-400">{desc}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      </main>

      {/* ------------------------------- footer ------------------------------- */}
      <footer className="mt-auto border-t border-zinc-800/80 bg-zinc-950">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-5 flex flex-col sm:flex-row items-center justify-between gap-2 text-xs text-zinc-500">
          <span className="font-mono">tchat.space-z.ai — realtime guest chatroom · CLI + HTTPS terminal + Web</span>
          <span className="font-mono">{online} guest(s) online across all rooms</span>
        </div>
      </footer>
    </div>
  );
}
