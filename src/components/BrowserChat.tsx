'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { SendHorizontal, Users, CircleCheck, CircleX, Terminal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';

/* ------------------------------- types ------------------------------- */

type RoomMessage = {
  id: string;
  kind: 'chat' | 'action' | 'system';
  subtype?: string;
  from?: string;
  text: string;
  ts: number;
  seq?: number; // room-scoped monotonic sequence — cursor for lazy history
};

const NAME_COLORS = [
  'text-emerald-400',
  'text-amber-300',
  'text-rose-400',
  'text-fuchsia-400',
  'text-lime-300',
  'text-orange-300',
  'text-teal-300',
  'text-yellow-200',
];

function nameColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return NAME_COLORS[h % NAME_COLORS.length];
}

function hhmm(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/* Local (client-only) system-style line id, e.g. command help or offline notes.
 * Rendered like server system messages but never part of room history. */
function localId(): string {
  return `local-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

/* Live presence probe — the /health endpoint of the chat service reached
 * through the same gateway the socket uses. Lets the UI show real guest
 * counts BEFORE joining (fixes stale "0 guests" on room pages) and powers
 * the homepage "N online" counter for visitors who never joined. */
async function fetchLiveStats(): Promise<{
  total: number;
  rooms: { key?: string; label?: string; users?: number }[];
} | null> {
  try {
    const res = await fetch('/health?XTransformPort=3004', { cache: 'no-store' });
    if (!res.ok) return null;
    const j = await res.json();
    if (!j?.ok) return null;
    return {
      total: Number(j.users) || 0,
      rooms: Array.isArray(j.rooms) ? j.rooms : [],
    };
  } catch {
    return null;
  }
}

/* --------------------------- session persistence --------------------------- */
/* Refresh/reopen used to drop the user back to the join form (and race the
 * old connection for the same name). Persist the session and resume it.
 * sessionStorage is PRIMARY (per-tab: reloading tab A can no longer be
 * hijacked into tab B's room — bug #11), localStorage is the fallback so a
 * brand-new tab still prefills the last identity. */
const SESSION_KEY = 'tchat.session.v1';

function loadSession(): { name: string; room: string } | null {
  if (typeof window === 'undefined') return null;
  for (const store of [window.sessionStorage, window.localStorage]) {
    try {
      const raw = store.getItem(SESSION_KEY);
      if (!raw) continue;
      const s = JSON.parse(raw);
      if (typeof s?.name === 'string' && s.name)
        return { name: String(s.name), room: typeof s.room === 'string' ? s.room : '' };
    } catch {}
  }
  return null;
}

function saveSession(name: string, room: string) {
  if (typeof window === 'undefined') return;
  const payload = JSON.stringify({ name, room });
  try {
    window.sessionStorage.setItem(SESSION_KEY, payload);
  } catch {}
  try {
    window.localStorage.setItem(SESSION_KEY, payload);
  } catch {}
}

export function cleanRoomInput(raw: string): string {
  return raw.replace(/[^A-Za-z0-9 _.\-]/g, '').trim().slice(0, 24);
}

/* ----------------------------- component ----------------------------- */

export default function BrowserChat({
  initialRoom = '',
  lockedRoom = false,
  variant = 'card',
  onStats,
}: {
  initialRoom?: string;
  lockedRoom?: boolean;
  variant?: 'card' | 'page';
  onStats?: (total: number) => void;
}) {
  const socketRef = useRef<Socket | null>(null);
  const [connected, setConnected] = useState(false);
  const [roomTotal, setRoomTotal] = useState(0);

  const [messages, setMessages] = useState<RoomMessage[]>([]);
  const [hasMoreHistory, setHasMoreHistory] = useState(false);
  // v3.4: how many persisted messages sit OLDER than what we hold — the
  // banner states the number so "there is more history" is never a guess.
  const [olderCount, setOlderCount] = useState(0);
  const olderCountRef = useRef(0);
  const [room, setRoom] = useState(initialRoom);
  const [webName, setWebName] = useState('');
  const [myName, setMyName] = useState('');
  const [joinedRoom, setJoinedRoom] = useState('');
  const [joinError, setJoinError] = useState('');
  const [draft, setDraft] = useState('');
  const [users, setUsers] = useState<string[]>([]);
  const [outboxCount, setOutboxCount] = useState(0);
  const [liveCount, setLiveCount] = useState<number | null>(null);
  const [liveTotal, setLiveTotal] = useState<number | null>(null);
  const [slowConnect, setSlowConnect] = useState(false);
  const logRef = useRef<HTMLDivElement | null>(null);
  const joinedRef = useRef(false);
  const reconnectRef = useRef({ name: '', room: '' });
  const autoJoinRef = useRef(false);
  const autoJoinTriedRef = useRef(false);
  const autoJoinRetryRef = useRef(0);
  const outboxRef = useRef<string[]>([]);
  const usersReqRef = useRef(false);
  // Lazy history (v3.1): paging state. oldestSeqRef = seq cursor of the oldest
  // message we hold; scrollRestoreRef keeps the viewport anchored while older
  // messages are prepended; atBottomRef avoids yanking the user down on live
  // traffic while they are reading old messages.
  const oldestSeqRef = useRef<number | null>(null);
  const loadingHistoryRef = useRef(false);
  const scrollRestoreRef = useRef<{ h: number; top: number } | null>(null);
  const atBottomRef = useRef(true);
  // v3.4 "load all": when true, every history-page that still reports hasMore
  // immediately requests the next page — one click walks the whole log.
  const loadAllRef = useRef(false);
  // Dedupe ledger: mount-only socket handlers cannot read fresh `messages`, so
  // ids of every ingested message (live or replayed) live here instead.
  const seenIdsRef = useRef<Set<string>>(new Set());

  const joined = !!joinedRoom;

  useEffect(() => {
    const socket = io('/?XTransformPort=3003', {
      path: '/',
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: Infinity, // keep trying — the banner explains, never give up silently
      reconnectionDelay: 1000,
      timeout: 10000,
      forceNew: true,
    });
    socketRef.current = socket;

    const goOnline = () => {
      // Browser regained network: reconnect immediately instead of waiting
      // for the next backoff tick.
      if (!socket.connected) socket.connect();
    };
    const goOffline = () => {
      // Network gone: flip the UI to "offline" instantly instead of waiting
      // for the ping/pong timeout to notice the dead transport.
      setConnected(false);
    };
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);

    socket.on('connect', () => {
      setConnected(true);
      // The server runs WITHOUT connectionStateRecovery: after a dropped
      // socket (network blip, server restart, laptop sleep) we must join
      // again explicitly or the user sits "connected" but outside the room.
      if (joinedRef.current && reconnectRef.current.name) {
        socket.emit('join', { name: reconnectRef.current.name, room: reconnectRef.current.room });
      }
    });
    socket.on('disconnect', () => setConnected(false));
    socket.on('presence', (d: { count: number; total: number }) => {
      setRoomTotal(d.count);
      onStats?.(d.total);
    });
    socket.on('message', (m: RoomMessage) => {
      if (m?.id) {
        seenIdsRef.current.add(m.id);
        if (seenIdsRef.current.size > 4000) seenIdsRef.current = new Set([...seenIdsRef.current].slice(-2000));
      }
      setMessages(prev => [...prev.slice(-399), m]);
    });
    socket.on('system', (m: RoomMessage) => {
      if (m?.id && !m.id.startsWith('local-')) seenIdsRef.current.add(m.id);
      setMessages(prev => [...prev.slice(-399), m]);
      if (joinedRef.current) socket.emit('users');
    });
    socket.on('history-page', (d: { room?: string; messages?: RoomMessage[]; hasMore?: boolean; olderCount?: number }) => {
      loadingHistoryRef.current = false;
      const seen = seenIdsRef.current;
      const page = (d.messages || []).filter(m => m && typeof m.seq === 'number' && m.id && !seen.has(m.id));
      hasMoreRef.current = !!d.hasMore;
      setHasMoreHistory(!!d.hasMore);
      olderCountRef.current = typeof d.olderCount === 'number' ? d.olderCount : olderCountRef.current;
      setOlderCount(olderCountRef.current);
      if (!page.length) {
        if (loadAllRef.current && !hasMoreRef.current) loadAllRef.current = false;
        return;
      }
      for (const m of page) seen.add(m.id);
      if (typeof page[0].seq === 'number') oldestSeqRef.current = page[0].seq;
      const el = logRef.current;
      if (el) scrollRestoreRef.current = { h: el.scrollHeight, top: el.scrollTop };
      setMessages(prev => [...page, ...prev].slice(-3000));
      // load-all chaining: keep walking until the server says the floor is reached
      if (loadAllRef.current) {
        if (hasMoreRef.current) loadOlderRef.current();
        else loadAllRef.current = false;
      }
    });
    socket.on('joined', (d: { you: string; room?: string; count: number; users: { name: string }[]; history: RoomMessage[]; hasMore?: boolean; olderCount?: number; lastSeq?: number }) => {
        setMyName(d.you);
        const r = d.room || room || 'lobby';
        setJoinedRoom(r);
        joinedRef.current = true;
        reconnectRef.current = { name: d.you, room: r };
        autoJoinRef.current = false;
        autoJoinTriedRef.current = false;
        autoJoinRetryRef.current = 0;
        saveSession(d.you, r);
        setJoinError('');
        setRoomTotal(d.count);
        setUsers(d.users.map(u => u.name));
        const hist = (d.history || []).filter(m => m && m.id);
        setMessages(hist);
        seenIdsRef.current = new Set(hist.map(m => m.id));
        oldestSeqRef.current = hist.length && typeof hist[0].seq === 'number' ? hist[0].seq : null;
        loadingHistoryRef.current = false;
        hasMoreRef.current = !!d.hasMore;
        setHasMoreHistory(!!d.hasMore);
        olderCountRef.current = typeof d.olderCount === 'number' ? d.olderCount : 0;
        setOlderCount(olderCountRef.current);
        loadAllRef.current = false;
        scrollRestoreRef.current = null;
        atBottomRef.current = true;
        // Joined from the homepage card: sync the URL to /r/<room> WITHOUT
        // navigating (no remount, no second join). A refresh then lands on
        // the room page and auto-resumes from the saved session.
        if (typeof window !== 'undefined' && !window.location.pathname.startsWith('/r/')) {
          try {
            window.history.replaceState(null, '', `/r/${encodeURIComponent(r)}`);
          } catch {}
        }
        // Flush anything typed while the connection was down.
        const ob = outboxRef.current;
        if (ob.length) {
          outboxRef.current = [];
          setOutboxCount(0);
          for (const t of ob) socket.emit('message', { text: t });
        }
      }
    );
    socket.on('name-rejected', (d: { reason: string }) => {
      setJoinError(d.reason);
      // Automated join hit a name race (ghost of the previous connection not
      // reaped yet): retry once after a beat — server-side stale-holder
      // eviction frees the name. After one retry, surface the error.
      if (autoJoinRef.current && autoJoinRetryRef.current < 1) {
        autoJoinRetryRef.current += 1;
        window.setTimeout(() => {
          if (!joinedRef.current && socket.connected) {
            socket.emit('join', {
              name: reconnectRef.current.name || webName,
              room: reconnectRef.current.room || room || 'lobby',
            });
          }
        }, 2000);
      } else {
        autoJoinRef.current = false;
      }
    });
    socket.on('renamed', (d: { you: string }) => setMyName(d.you));
    socket.on('users-list', (d: { users: { name: string }[] }) => {
      setUsers(d.users.map(u => u.name));
      // Only echo a line for an explicit /users request — server system
      // messages also refresh the badge list as a side effect.
      if (usersReqRef.current) {
        usersReqRef.current = false;
        const names = d.users.map(u => u.name).join(', ') || '(none)';
        setMessages(prev => [
          ...prev.slice(-199),
          { id: localId(), kind: 'system', subtype: 'local', text: `users here: ${names}`, ts: Date.now() },
        ]);
      }
    });
    socket.on('rooms-list', (d: { rooms: { label: string; users: number }[]; total: number }) => {
      const parts = (d.rooms || []).map(r => `${r.label} (${r.users})`);
      setMessages(prev => [
        ...prev.slice(-199),
        {
          id: localId(),
          kind: 'system',
          subtype: 'local',
          text: `active rooms: ${parts.join(' · ') || '(none)'} — ${d.total} online`,
          ts: Date.now(),
        },
      ]);
    });
    socket.on('error', (d: { text: string }) => setJoinError(d.text));

    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
      socket.disconnect();
      socketRef.current = null;
    };
  }, []);

  // Prefill the last session (name; room on the home page) so rejoining is
  // one click instead of retyping everything. Deliberate one-shot mount-time
  // prefill from localStorage: cannot run during render (SSR has no storage).
  useEffect(() => {
    const saved = loadSession();
    if (!saved) return;
    setWebName(saved.name);
    if (!lockedRoom && !initialRoom && saved.room) setRoom(saved.room);
  }, []);

  // Auto-resume on locked room pages: a refresh keeps the user in the room
  // instead of kicking them back to the join form. No setState here — the
  // server's 'joined' event echoes the room/name back and drives the UI.
  useEffect(() => {
    if (!connected || joined || autoJoinTriedRef.current) return;
    if (!lockedRoom) return;
    const saved = loadSession();
    if (!saved?.name) return;
    autoJoinTriedRef.current = true;
    autoJoinRef.current = true;
    socketRef.current?.emit('join', { name: saved.name, room: initialRoom || 'lobby' });
  }, [connected, joined, lockedRoom, initialRoom]);

  // Live guest count BEFORE joining — poll /health through the gateway and
  // match the current room (case-insensitive; room keys are case-insensitive
  // server-side too). Stops while joined: presence events take over.
  useEffect(() => {
    if (joined) return;
    let alive = true;
    const poll = async () => {
      const stats = await fetchLiveStats();
      if (!alive) return;
      if (!stats) return;
      const target = String(initialRoom || cleanRoomInput(room) || 'lobby').toLowerCase();
      const hit = stats.rooms.find(
        r => String(r?.key || '').toLowerCase() === target || String(r?.label || '').toLowerCase() === target
      );
      setLiveCount(hit ? Number(hit.users) || 0 : 0);
      setLiveTotal(stats.total);
    };
    poll();
    const iv = setInterval(poll, 5000);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, [joined, initialRoom, room]);

  // Keep the viewport sane across message updates: pin to bottom for live
  // traffic, but PRESERVE position when older history was prepended.
  useEffect(() => {
    const el = logRef.current;
    if (!el) return;
    const restore = scrollRestoreRef.current;
    if (restore) {
      scrollRestoreRef.current = null;
      el.scrollTop = restore.top + (el.scrollHeight - restore.h);
    } else if (atBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  const onLogScroll = useCallback(() => {
    const el = logRef.current;
    if (!el) return;
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (atBottomRef.current) return;
    if (el.scrollTop < 56) loadOlderRef.current();
  }, []);

  const loadOlder = useCallback(() => {
    const sock = socketRef.current;
    if (!sock || loadingHistoryRef.current || !hasMoreRef.current) return;
    loadingHistoryRef.current = true;
    sock.emit('history', { before: oldestSeqRef.current ?? undefined, limit: 200 });
  }, []);
  const loadOlderRef = useRef(loadOlder);
  // v3.4: one click = walk the ENTIRE persisted log (pages of 200 until the
  // server reports hasMore:false; the history-page handler does the chaining).
  const startLoadAll = useCallback(() => {
    const sock = socketRef.current;
    if (!sock || !hasMoreRef.current || loadingHistoryRef.current) return;
    loadAllRef.current = true;
    loadingHistoryRef.current = true;
    sock.emit('history', { before: oldestSeqRef.current ?? undefined, limit: 200 });
  }, []);
  const startLoadAllRef = useRef(startLoadAll);
  // hasMore lives in a ref (mirrored at the same ingestion points as the
  // state below) so the scroll handler always sees the latest value without
  // re-binding onScroll on every state flip.
  const hasMoreRef = useRef(false);

  const joinWeb = useCallback(() => {
    const name = webName.trim();
    const r = cleanRoomInput(room) || 'lobby';
    if (!name || !socketRef.current) return;
    setJoinError('');
    socketRef.current.emit('join', { name, room: r });
  }, [webName, room]);

  // "Connecting…" for too long with no explanation = dead-looking page
  // (bug #8). After 8s without a socket, offer a manual retry — the socket
  // itself keeps auto-retrying in the background.
  useEffect(() => {
    const t = window.setTimeout(() => setSlowConnect(!connected), 0);
    return () => window.clearTimeout(t);
  }, [connected]);
  useEffect(() => {
    if (connected) return;
    const t = window.setTimeout(() => setSlowConnect(true), 8000);
    return () => window.clearTimeout(t);
  }, [connected]);

  const quitRoom = useCallback(() => {
    // Leave the room for real (server broadcasts "X left the room") and
    // return to the join form on the same connection.
    socketRef.current?.emit('leave');
    joinedRef.current = false;
    reconnectRef.current = { name: '', room: '' };
    autoJoinTriedRef.current = true; // don't let auto-resume instantly re-join the saved session
    outboxRef.current = [];
    setOutboxCount(0);
    setJoinedRoom('');
    setMessages([]);
    // Refs mirror paging state for the unthrottled scroll handler; resetting
    // them here is plain event-handler cleanup, no render-phase writes.
    // eslint-disable-next-line react-hooks/immutability
    hasMoreRef.current = false;
    setHasMoreHistory(false);
    oldestSeqRef.current = null;
    loadingHistoryRef.current = false;
    scrollRestoreRef.current = null;
    seenIdsRef.current = new Set();
    setUsers([]);
    setRoomTotal(0);
    if (typeof window !== 'undefined' && !lockedRoom) {
      try {
        window.history.replaceState(null, '', '/');
      } catch {}
    }
  }, [lockedRoom]);

  /* Client-side slash-command interpreter — web parity with the terminal
   * clients (the homepage commands table advertises these). Unknown commands
   * get a hint instead of being sent as literal chat text. */
  const runCommand = useCallback(
    (raw: string): boolean => {
      if (!raw.startsWith('/')) return false;
      const [cmd, ...rest] = raw.slice(1).split(' ');
      const arg = rest.join(' ').trim();
      const sock = socketRef.current;
      const local = (text: string) =>
        setMessages(prev => [...prev.slice(-199), { id: localId(), kind: 'system' as const, subtype: 'local', text, ts: Date.now() }]);
      switch ((cmd || '').toLowerCase()) {
        case 'help':
          local('commands: /nick <name> · /me <action> · /users · /rooms · /history [n|all] · /clear · /url · /help · /quit');
          return true;
        case 'me':
          if (!arg) {
            local('usage: /me <action> — e.g. /me waves');
            return true;
          }
          sock?.emit('action', { text: arg });
          return true;
        case 'nick':
          if (!arg) {
            local('usage: /nick <new name>');
            return true;
          }
          sock?.emit('nick', { name: arg });
          return true;
        case 'users':
          if (!sock) return true;
          usersReqRef.current = true;
          sock.emit('users');
          return true;
        case 'rooms':
          sock?.emit('rooms');
          return true;
        case 'clear':
          setMessages([]);
          return true;
        case 'history': {
          if (!sock) return true;
          const harg = arg.toLowerCase();
          if (harg === 'all') {
            if (!hasMoreRef.current) {
              local('no older messages on record for this room');
            } else {
              local(`loading full history (${olderCountRef.current || 'remaining'} older message(s))…`);
              startLoadAllRef.current();
            }
            return true;
          }
          const n = Number(harg);
          if (Number.isFinite(n) && n > 0 && hasMoreRef.current && !loadingHistoryRef.current) {
            loadingHistoryRef.current = true;
            sock.emit('history', { before: oldestSeqRef.current ?? undefined, limit: Math.min(Math.floor(n), 1000) });
            return true;
          }
          loadOlderRef.current();
          if (!hasMoreRef.current) local('no older messages on record for this room');
          return true;
        }
        case 'url':
          local(`server: tchat.space-z.ai · room: ${joinedRoom || room || 'lobby'} · web transport: socket.io`);
          return true;
        case 'quit': {
          quitRoom();
          return true;
        }
        default:
          local(`unknown command: /${cmd} — try /help`);
          return true;
      }
    },
    [joinedRoom, room, lockedRoom, quitRoom]
  );

  const sendWeb = useCallback(() => {
    const text = draft.trim();
    if (!text || !joined) return;
    setDraft('');
    if (runCommand(text)) return;
    const sock = socketRef.current;
    if (!sock?.connected) {
      // Offline: queue instead of silently dropping. Flushed in order on the
      // next successful join (reconnect auto-rejoins first).
      outboxRef.current = [...outboxRef.current.slice(-19), text];
      setOutboxCount(outboxRef.current.length);
      setMessages(prev => [
        ...prev.slice(-199),
        { id: localId(), kind: 'system' as const, subtype: 'local', text: 'offline — message queued, will send on reconnect', ts: Date.now() },
      ]);
      return;
    }
    sock.emit('message', { text });
  }, [draft, joined, runCommand]);

  const reconnectNow = useCallback(() => {
    const sock = socketRef.current;
    if (sock && !sock.connected) sock.connect();
  }, []);

  const height = variant === 'page' ? 'h-[62vh] max-h-[560px]' : 'h-80 max-h-80';

  return (
    <div className="space-y-4 text-zinc-100">
      {!joined ? (
        <div className="space-y-2.5">
          {!lockedRoom && (
            <div className="flex gap-2">
              <Input
                value={room}
                onChange={e => setRoom(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') document.getElementById('web-name-input')?.focus();
                }}
                placeholder="room code (blank = lobby)"
                maxLength={24}
                className="bg-zinc-950 border-zinc-800 text-zinc-100 placeholder:text-zinc-500 font-mono uppercase"
                aria-label="Room code"
              />
            </div>
          )}
          <div className="flex gap-2">
            <Input
              id="web-name-input"
              value={webName}
              onChange={e => setWebName(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') joinWeb();
              }}
              placeholder="guest name"
              maxLength={20}
              disabled={!connected}
              className="bg-zinc-950 border-zinc-800 text-zinc-100 placeholder:text-zinc-500 font-mono"
              aria-label="Guest name"
            />
            <Button
              onClick={joinWeb}
              disabled={!connected || !webName.trim()}
              className="gap-1.5 bg-emerald-500 hover:bg-emerald-600 text-zinc-950 font-semibold shrink-0"
            >
              Join room
            </Button>
          </div>
          {joinError && (
            <p className="text-xs text-red-400 flex items-center gap-1.5" role="alert">
              <CircleX className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              {joinError}
            </p>
          )}
          {lockedRoom && (
            <p className="text-xs text-zinc-400 flex items-center gap-1.5" aria-live="polite">
              <Users className="h-3.5 w-3.5 text-emerald-500 shrink-0" aria-hidden="true" />
              {liveCount === null
                ? 'checking who is in the room…'
                : `${liveCount} guest(s) in this room right now · ${liveTotal ?? 0} online overall`}
            </p>
          )}
          <p className="text-xs text-zinc-500">
            {connected ? (
              'Connected to the chat service. Pick any name to join.'
            ) : slowConnect ? (
              'Still connecting — the chat service may be restarting. It keeps retrying automatically.'
            ) : (
              'Connecting to the chat service…'
            )}
          </p>
          {slowConnect && (
            <button
              type="button"
              onClick={reconnectNow}
              className="text-xs font-semibold text-emerald-400 underline hover:text-emerald-300"
            >
              retry now
            </button>
          )}
        </div>
      ) : (
        <>
          <div
            ref={logRef}
            onScroll={onLogScroll}
            className={`rounded-lg border border-zinc-800 bg-zinc-950 p-3 ${height} overflow-y-auto font-mono text-[13px] leading-relaxed space-y-1 [scrollbar-color:#3f3f46_transparent]`}
          >
            {hasMoreHistory && (
              <div className="flex items-center justify-center gap-2 pb-1 flex-wrap">
                <span className="text-[11px] font-mono text-zinc-500">
                  {olderCount > 0 ? `${olderCount} older message${olderCount === 1 ? '' : 's'} on record` : 'older messages on record'}
                </span>
                <button
                  type="button"
                  onClick={loadOlder}
                  className="text-[11px] font-mono text-emerald-400 border border-emerald-500/30 rounded-full px-3 py-0.5 hover:bg-emerald-500/10 transition-colors"
                >
                  ↑ load older
                </button>
                <button
                  type="button"
                  onClick={startLoadAll}
                  className="text-[11px] font-mono text-zinc-400 hover:text-emerald-400 underline underline-offset-2 transition-colors"
                >
                  load all
                </button>
              </div>
            )}
            {messages.length === 0 && (
              <p className="text-zinc-500 text-center py-10">No messages yet — be the first to say hi.</p>
            )}
            {messages.map(m =>
              m.kind === 'chat' ? (
                <div key={m.id} className="break-words">
                  <span className="text-zinc-500 mr-2">{hhmm(m.ts)}</span>
                  <span className={`font-semibold ${m.from === myName ? 'text-emerald-400' : nameColor(m.from || '')}`}>
                    {m.from}
                  </span>
                  <span className="text-zinc-500">: </span>
                  <span className="text-zinc-100 whitespace-pre-wrap">{m.text}</span>
                </div>
              ) : m.kind === 'action' ? (
                <div key={m.id} className="break-words italic text-zinc-300">
                  <span className="text-zinc-500 mr-2">{hhmm(m.ts)}</span>*{' '}
                  <span className={m.from === myName ? 'text-emerald-400' : nameColor(m.from || '')}>{m.from}</span>{' '}
                  {m.text}
                </div>
              ) : (
                <div key={m.id} className="break-words text-yellow-500/90 italic">
                  <span className="text-zinc-500 mr-2">{hhmm(m.ts)}</span>— {m.text}
                </div>
              )
            )}
          </div>

          {joined && !connected && (
            <div
              className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-300 flex items-center justify-between gap-2"
              role="status"
            >
              <span>
                Connection lost — reconnecting…{outboxCount > 0 ? ` ${outboxCount} message(s) queued.` : ' you can keep typing.'}
              </span>
              <button
                type="button"
                onClick={reconnectNow}
                className="underline font-semibold hover:text-amber-200 shrink-0"
              >
                try now
              </button>
            </div>
          )}

          <div className="flex gap-2">
            <Input
              value={draft}
              onChange={e => setDraft(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') sendWeb();
              }}
              placeholder={`message as ${myName}`}
              maxLength={500}
              className="bg-zinc-950 border-zinc-800 text-zinc-100 placeholder:text-zinc-500 font-mono"
              aria-label="Message"
            />
            <Button
              onClick={sendWeb}
              disabled={!draft.trim()}
              className="gap-1.5 bg-emerald-500 hover:bg-emerald-600 text-zinc-950 font-semibold shrink-0"
              aria-label="Send message"
            >
              <SendHorizontal className="h-4 w-4" aria-hidden="true" />
            </Button>
          </div>
          {joinError && (
            <p className="text-xs text-red-400 flex items-center gap-1.5" role="alert">
              <CircleX className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              {joinError}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-zinc-500 flex items-center gap-1 mr-1">
              <CircleCheck className="h-3.5 w-3.5 text-emerald-500" aria-hidden="true" />
              {users.length} in {joinedRoom}:
            </span>
            {users.map(u => (
              <Badge
                key={u}
                variant="outline"
                className={`text-[11px] font-mono border-zinc-600 ${u === myName ? 'text-emerald-400 border-emerald-500/40' : 'text-zinc-200'}`}
              >
                {u}
              </Badge>
            ))}
            <button
              type="button"
              onClick={quitRoom}
              className="ml-auto text-[11px] font-mono text-zinc-400 border border-zinc-700 rounded px-2 py-0.5 hover:text-red-300 hover:border-red-500/40 transition-colors"
              aria-label="Leave the room"
            >
              /quit — leave room
            </button>
          </div>
        </>
      )}

      {variant === 'page' && (
        <p className="text-xs text-zinc-500 flex items-center gap-1.5">
          <Users className="h-3.5 w-3.5" aria-hidden="true" />
          {(joined ? roomTotal : liveCount ?? 0)} guest(s) in this room · you are chatting from the browser
          <Terminal className="h-3.5 w-3.5 ml-2" aria-hidden="true" />
          terminal users: <code className="text-emerald-400">tchat join {joinedRoom || room || 'lobby'}</code>
        </p>
      )}
    </div>
  );
}
