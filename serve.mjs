/**
 * 零依赖静态服务器：node serve.mjs [端口]
 * 默认把 dist/ 发出去。MIME 表必须包含 .mjs —— 页面是原生 ES module，
 * 少了这一条浏览器会以 application/octet-stream 拒载，白屏。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(HERE, 'dist', 'index.html');
// dist/ 是构建产物，不在版本库里。裸克隆后必须先构建，否则这里只会 404，
// 而且不会告诉你为什么 —— 直接说清楚比让人猜。
if (!fs.existsSync(DIST)) {
  console.error('[serve] 没有找到 dist/index.html —— 这个目录是构建产物，不在仓库里。');
  console.error('[serve] 先构建一次：');
  console.error('        npm install && npm run build');
  console.error('[serve] 只想看效果、不想装依赖：解压发布的 zip，里面已含 dist/。');
  process.exit(1);
}
const ROOT = path.join(HERE, 'dist');
const PORT = Number(process.argv[2] || 5173);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.mp4': 'video/mp4',
  '.pdf': 'application/pdf',
  '.ico': 'image/x-icon',
};

http.createServer((req, res) => {
  let url = '/';
  try { url = decodeURIComponent((req.url || '/').split('?')[0]); } catch { url = '/'; }
  let rel = url.replace(/^\/+/, '');
  if (!rel || rel.endsWith('/')) rel += 'index.html';
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('404');
    return;
  }
  res.writeHead(200, {
    'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'cache-control': 'no-cache',
  });
  fs.createReadStream(file).pipe(res);
}).listen(PORT, '127.0.0.1', () => {
  console.log(`serving ${ROOT}`);
  console.log(`http://127.0.0.1:${PORT}/`);
});
