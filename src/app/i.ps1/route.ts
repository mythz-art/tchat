import { readFile } from 'fs/promises';
import path from 'path';

/**
 * Ultra-short installer endpoint:  irm https://<host>/i.ps1 | iex
 * Served as text/plain so Invoke-RestMethod returns a string on Windows
 * PowerShell 5.1 too (octet-stream would yield byte[] and break iex).
 */
export const dynamic = 'force-dynamic';

export async function GET() {
  const body = await readFile(path.join(process.cwd(), 'public', 'install.ps1'), 'utf8');
  return new Response(body, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}
