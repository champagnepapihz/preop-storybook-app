/**
 * 角色图归一化：去绿边 + 裁掉透明留白（保住同一基线）
 *
 * 为什么必须做：24 张角色图是分别生成的，每张的透明留白不同，
 * 直接按 height 摆放时"脚底"对不齐 —— 有的人站在地上，有的人浮在半空。
 * 处理完以后，每张图的底边就是脚底，height 才等于视觉高度。
 *
 * 用法：node tooling/normalize.mjs [目录]
 *   默认处理 assets/characters 下的所有 png。
 */
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = process.argv[2] || 'assets/characters';
const absDir = join(ROOT, DIR);
const PREFIX = process.argv[3] || '';
const files = readdirSync(absDir)
  .filter((f) => extname(f).toLowerCase() === '.png' && (!PREFIX || f.startsWith(PREFIX)))
  .sort();
const PORT = 5197;

const PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>
<pre id="log">running</pre><script>
const FILES = ${JSON.stringify(files)};
const log = (s) => { document.getElementById('log').textContent = s; };

function smoothstep(x) { const t = Math.min(1, Math.max(0, x)); return t * t * (3 - 2 * t); }

async function processOne(name) {
  const img = new Image();
  img.src = '/asset?f=' + encodeURIComponent(name);
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; });

  const W = img.naturalWidth, H = img.naturalHeight;
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const g = cv.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0);
  const im = g.getImageData(0, 0, W, H);
  const d = im.data;

  // 1) 去绿边：绿通道明显高于 R/B 的像素，把绿压回中性；同时按绿差轻微削 alpha
  let despilled = 0;
  for (let i = 0; i < W * H; i++) {
    const p = i * 4;
    if (d[p + 3] === 0) continue;
    const r = d[p], gg = d[p + 1], b = d[p + 2];
    const over = gg - Math.max(r, b);
    if (over > 6) {
      const limit = Math.max(r, b);
      d[p + 1] = limit + (gg - limit) * 0.12;
      if (over > 22) d[p + 3] = Math.round(d[p + 3] * (1 - smoothstep((over - 22) / 60) * 0.85));
      despilled++;
    }
  }

  // 2) 裁到不透明包围盒（阈值 12/255，避开发丝上的极淡像素）
  let minX = W, maxX = -1, minY = H, maxY = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (d[(y * W + x) * 4 + 3] > 12) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return { name, skipped: true };

  g.putImageData(im, 0, 0);

  // 3) 裁切（保留 2% 呼吸位），输出
  const pad = Math.round(Math.min(maxX - minX, maxY - minY) * 0.02);
  const sx = Math.max(0, minX - pad), sy = Math.max(0, minY - pad);
  const sw = Math.min(W - sx, maxX - minX + pad * 2), sh = Math.min(H - sy, maxY - minY + pad * 2);

  const out = document.createElement('canvas'); out.width = sw; out.height = sh;
  const og = out.getContext('2d');
  og.imageSmoothingQuality = 'high';
  og.drawImage(cv, sx, sy, sw, sh, 0, 0, sw, sh);

  const blob = await new Promise((r) => out.toBlob(r, 'image/png'));
  await fetch('/save?f=' + encodeURIComponent(name), { method: 'POST', body: await blob.arrayBuffer() });

  return { name, size: sw + 'x' + sh, bboxBottomGap: H - 1 - maxY, despilled };
}

(async () => {
  const results = [];
  for (const f of FILES) {
    try { results.push(await processOne(f)); } catch (e) { results.push({ name: f, error: String(e) }); }
  }
  log(JSON.stringify(results));
  document.title = 'done';
})();
</script></body></html>`;

const server = createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/asset') {
    const f = u.searchParams.get('f');
    try {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(readFileSync(join(absDir, f)));
    } catch { res.writeHead(404); res.end(); }
    return;
  }
  if (req.method === 'POST' && u.pathname === '/save') {
    const f = u.searchParams.get('f');
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const buf = Buffer.concat(chunks);
      const path = join(absDir, f);
      const before = statSync(path).size;
      writeFileSync(path, buf);
      console.log(`✓ ${f}  ${(before / 1024).toFixed(0)}KB → ${(buf.length / 1024).toFixed(0)}KB`);
      res.writeHead(200); res.end('ok');
    });
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(PAGE);
});

server.listen(PORT, () => {
  const chrome = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
  const child = spawn(chrome, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars',
    `--user-data-dir=${join(ROOT, '.cutout-profile')}`,
    '--window-size=900,900', '--virtual-time-budget=50000',
    `http://localhost:${PORT}/`,
  ], { stdio: 'ignore' });

  let done = false;
  const finish = (code) => { if (done) return; done = true; try { child.kill(); } catch {} server.close(() => process.exit(code)); };
  setTimeout(() => finish(0), 55000);
  child.on('exit', () => setTimeout(() => finish(0), 1500));
});
