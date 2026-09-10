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
  const [room, setRoom] = useState(initialRoom);
  const [webName, setWebName] = useState('');
  const [myName, setMyName] = useState('');
  const [joinedRoom, setJoinedRoom] = useState('');
  const [joinError, setJoinError] = useState('');
  const [draft, setDraft] = useState('');
  const [users, setUsers] = useState<string[]>([]);
  const logRef = useRef<HTMLDivElement | null>(null);
  const joinedRef = useRef(false);

  const joined = !!joinedRoom;

  useEffect(() => {
    const socket = io('/?XTransformPort=3003', {
      path: '/',
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 1000,
      timeout: 10000,
      forceNew: true,
    });
    socketRef.current = socket;

    socket.on('connect', () => setConnected(true));
    socket.on('disconnect', () => setConnected(false));
    socket.on('presence', (d: { count: number; total: number }) => {
      setRoomTotal(d.count);
      onStats?.(d.total);
    });
    socket.on('message', (m: RoomMessage) => setMessages(prev => [...prev.slice(-199), m]));
    socket.on('system', (m: RoomMessage) => {
      setMessages(prev => [...prev.slice(-199), m]);
      if (joinedRef.current) socket.emit('users');
    });
    socket.on(
      'joined',
      (d: { you: string; room?: string; count: number; users: { name: string }[]; history: RoomMessage[] }) => {
        setMyName(d.you);
        setJoinedRoom(d.room || room || 'lobby');
        joinedRef.current = true;
        setJoinError('');
        setRoomTotal(d.count);
        setUsers(d.users.map(u => u.name));
        setMessages(d.history && d.history.length ? d.history : []);
      }
    );
    socket.on('name-rejected', (d: { reason: string }) => setJoinError(d.reason));
    socket.on('renamed', (d: { you: string }) => setMyName(d.you));
    socket.on('users-list', (d: { users: { name: string }[] }) => setUsers(d.users.map(u => u.name)));
    socket.on('error', (d: { text: string }) => setJoinError(d.text));

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, []);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const joinWeb = useCallback(() => {
    const name = webName.trim();
    const r = cleanRoomInput(room) || 'lobby';
    if (!name || !socketRef.current) return;
    setJoinError('');
    socketRef.current.emit('join', { name, room: r });
  }, [webName, room]);

  const sendWeb = useCallback(() => {
    const text = draft.trim();
    if (!text || !socketRef.current || !joined) return;
    socketRef.current.emit('message', { text });
    setDraft('');
  }, [draft, joined]);

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
          <p className="text-xs text-zinc-500">
            {connected
              ? 'Connected to the chat service. Pick any name to join.'
              : 'Connecting to the chat service…'}
          </p>
        </div>
      ) : (
        <>
          <div
            ref={logRef}
            className={`rounded-lg border border-zinc-800 bg-zinc-950 p-3 ${height} overflow-y-auto font-mono text-[13px] leading-relaxed space-y-1 [scrollbar-color:#3f3f46_transparent]`}
          >
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
                  <span className="text-zinc-100">{m.text}</span>
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

          <div className="flex gap-2">
            <Input
              value={draft}
              onChange={e => setDraft(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') sendWeb();
              }}
              placeholder={`message as ${myName}`}
              maxLength={500}
              disabled={!connected}
              className="bg-zinc-950 border-zinc-800 text-zinc-100 placeholder:text-zinc-500 font-mono"
              aria-label="Message"
            />
            <Button
              onClick={sendWeb}
              disabled={!connected || !draft.trim()}
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
          </div>
        </>
      )}

      {variant === 'page' && (
        <p className="text-xs text-zinc-500 flex items-center gap-1.5">
          <Users className="h-3.5 w-3.5" aria-hidden="true" />
          {roomTotal} guest(s) in this room · you are chatting from the browser
          <Terminal className="h-3.5 w-3.5 ml-2" aria-hidden="true" />
          terminal users: <code className="text-emerald-400">tchat join {joinedRoom || room || 'lobby'}</code>
        </p>
      )}
    </div>
  );
}
