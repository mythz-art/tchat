import { readFile } from 'fs/promises';
import path from 'path';

/**
 * Ultra-short installer endpoint:  curl -fsSL https://<host>/i.sh | sh
 * Same script as /install.sh (kept working); served as text/plain.
 */
export const dynamic = 'force-dynamic';

export async function GET() {
  const body = await readFile(path.join(process.cwd(), 'public', 'install.sh'), 'utf8');
  return new Response(body, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}
