/**
 * Live check: simulate the WEBSITE join via socket.io on :3003 and print
 * exactly what a browser sees on join — history length, hasMore, oldest seq.
 * Then request one older page the way the website does.
 */
import { io } from 'socket.io-client';

const room = process.argv[2] || 'lobby';
const url = process.argv[3] || 'http://localhost:3003';

const sock = io(url, { path: '/', transports: ['websocket'] });
const timeout = setTimeout(() => { console.error('TIMEOUT'); process.exit(2); }, 8000);

sock.on('connect', () => {
  sock.emit('join', { name: 'HistoryProbe', room });
});

sock.on('joined', (d: any) => {
  const hist = d.history || [];
  const seqs = hist.map((m: any) => m.seq).filter((s: any) => typeof s === 'number');
  console.log(JSON.stringify({
    event: 'joined',
    room: d.room,
    historyCount: hist.length,
    hasMore: d.hasMore,
    lastSeq: d.lastSeq,
    oldestSeq: seqs.length ? Math.min(...seqs) : null,
    newestSeq: seqs.length ? Math.max(...seqs) : null,
    firstText: hist[0]?.text?.slice(0, 60),
    lastText: hist[hist.length - 1]?.text?.slice(0, 60),
  }, null, 2));

  if (d.hasMore) {
    const oldest = seqs.length ? Math.min(...seqs) : undefined;
    sock.emit('history', { before: oldest, limit: 30 });
  } else {
    finish();
  }
});

sock.on('history-page', (d: any) => {
  const msgs = d.messages || [];
  console.log(JSON.stringify({
    event: 'history-page',
    got: msgs.length,
    hasMore: d.hasMore,
    oldestSeq: msgs.length ? msgs[0].seq : null,
  }, null, 2));
  finish();
});

function finish() { clearTimeout(timeout); sock.close(); process.exit(0); }
