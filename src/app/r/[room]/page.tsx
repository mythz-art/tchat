import Link from 'next/link';
import { ArrowLeft, Terminal, Globe, KeyRound } from 'lucide-react';
import BrowserChat from '@/components/BrowserChat';
import { Badge } from '@/components/ui/badge';

export default async function RoomPage({ params }: { params: Promise<{ room: string }> }) {
  const { room: rawRoom } = await params;
  const room = decodeURIComponent(rawRoom).replace(/[^A-Za-z0-9 _.\-]/g, '').trim().slice(0, 24) || 'lobby';

  return (
    <div
      className="min-h-screen flex flex-col bg-zinc-950 text-zinc-100 selection:bg-emerald-500/30"
      style={{ fontFamily: 'var(--font-geist-mono), ui-monospace, SFMono-Regular, Menlo, monospace' }}
    >
      <header className="border-b border-zinc-800/80 bg-zinc-950/90 backdrop-blur sticky top-0 z-20">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-3">
          <Link href="/" className="flex items-center gap-2 text-sm text-zinc-400 hover:text-emerald-400 transition-colors">
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            TermChat
          </Link>
          <Badge variant="outline" className="gap-1.5 font-mono text-xs border-emerald-500/40 text-emerald-400">
            <KeyRound className="h-3.5 w-3.5" aria-hidden="true" />
            room: {room}
          </Badge>
        </div>
      </header>

      <main className="flex-1 w-full max-w-3xl mx-auto px-4 sm:px-6 py-10">
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">
          Room <span className="text-emerald-400">{room}</span>
        </h1>
        <p className="mt-2 text-sm text-zinc-400 leading-relaxed">
          You are in via the web — the zero-install way. Everyone in this room sees your messages in real time,
          whether they joined from the CLI, a zero-install HTTPS terminal, or a browser like you.
        </p>

        <div className="mt-6 rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 sm:p-6">
          <BrowserChat initialRoom={room} lockedRoom variant="page" />
        </div>

        <div className="mt-8 grid gap-3 sm:grid-cols-3 text-xs">
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
            <div className="flex items-center gap-1.5 text-emerald-400 font-semibold mb-1.5">
              <Terminal className="h-3.5 w-3.5" aria-hidden="true" />
              CLI
            </div>
            <code className="block text-zinc-300 break-all">tchat join {room}</code>
            <p className="mt-1 text-zinc-500">install: curl -fsSL tchat.space-z.ai/i.sh | sh</p>
          </div>
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
            <div className="flex items-center gap-1.5 text-emerald-400 font-semibold mb-1.5">
              <Terminal className="h-3.5 w-3.5" aria-hidden="true" />
              Terminal · no install
            </div>
            <code className="block text-zinc-300 break-all">curl -fsSL tchat.space-z.ai/g | ROOM={room} bash</code>
            <p className="mt-1 text-zinc-500 break-all">
              PowerShell: $env:TCHAT_ROOM=&apos;{room}&apos;; iex (irm tchat.space-z.ai/p)
            </p>
          </div>
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
            <div className="flex items-center gap-1.5 text-emerald-400 font-semibold mb-1.5">
              <Globe className="h-3.5 w-3.5" aria-hidden="true" />
              Web
            </div>
            <code className="block text-zinc-300 break-all">/r/{room}</code>
            <p className="mt-1 text-zinc-500">share this link — guests join with any name</p>
          </div>
        </div>
      </main>

      <footer className="mt-auto border-t border-zinc-800/80 bg-zinc-950">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-4 text-center text-xs text-zinc-500 font-mono">
          tchat.space-z.ai — realtime guest chatroom · CLI + HTTPS terminal + Web
        </div>
      </footer>
    </div>
  );
}
