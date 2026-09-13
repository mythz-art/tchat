/**
 * Probe the PUBLIC gateway exactly like BrowserChat.tsx does:
 *   io('/?XTransformPort=3003', { path: '/', transports: [...] })
 * Try websocket-first (site config) and polling-only; join a room and print
 * what the client would see. Usage: bun test-website-join-public.ts [room] [transport]
 */
import { io } from 'socket.io-client';

const room = process.argv[2] || 'lobby';
const mode = process.argv[3] || 'site'; // site = websocket,polling like the site
const base = 'https://tchat.space-z.ai';

function attempt(transports: string[]): Promise<string> {
  return new Promise((resolve) => {
    const sock = io(`${base}/?XTransformPort=3003`, {
      path: '/',
      transports: transports as any,
      reconnection: false,
      timeout: 8000,
    });
    const done = (msg: string) => { try { sock.close(); } catch {} resolve(msg); };
    const t = setTimeout(() => done(`FAIL: timeout (${transports.join(',')})`), 9000);
    sock.on('connect', () => {
      sock.emit('join', { name: 'PubProbe', room });
    });
    sock.on('joined', (d: any) => {
      const hist = d.history || [];
      clearTimeout(t);
      resolve(`OK (${transports.join(',')}): room=${d.room} history=${hist.length} hasMore=${d.hasMore} lastSeq=${d.lastSeq}`);
    });
    sock.on('connect_error', (e: any) => { clearTimeout(t); done(`FAIL: connect_error ${e.message} (${transports.join(',')})`); });
  });
}

console.log('site-mode (websocket first):', await attempt(['websocket', 'polling']));
console.log('polling-only:', await attempt(['polling']));
process.exit(0);
