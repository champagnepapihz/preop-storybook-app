/** 本地预览：node tooling/serve.mjs [port]  默认 5173，服务 dist/ */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const PORT = Number(process.argv[2] || 5173);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf',
  '.ico': 'image/x-icon',
};

createServer(async (req, res) => {
  try {
    let url = '/';
    try { url = decodeURIComponent((req.url || '/').split('?')[0]); } catch { url = '/'; }
    let p = join(DIST, url === '/' ? '/index.html' : url);
    if (!p.startsWith(DIST)) throw new Error('forbidden');
    try {
      if ((await stat(p)).isDirectory()) p = join(p, 'index.html');
    } catch {}
    const buf = await readFile(p);
    res.writeHead(200, {
      'Content-Type': MIME[extname(p).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(buf);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404');
  }
}).listen(PORT, () => {
  console.log(`预览：http://localhost:${PORT}`);
});
