/**
 * 色度键抠图（绿幕/蓝幕）+ 去绿边（despill）
 *
 * 用法：node tooling/chroma.mjs <in.jpeg> <out-id> [t0] [t1]
 *   t0/t1 是「绿色优势 key = G - max(R,B)」的软阈值，默认 18/55。
 *   背景绿 key≈130，地面投影是暗绿 key≈60-90，都会被吃掉；中性灰的水印 key≈0 会留下，
 *   所以后面还有一道「离主体太远的小块直接丢弃」。
 */
import { createServer } from 'node:http';
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const [inFile, outId, t0Arg, t1Arg] = process.argv.slice(2);
if (!inFile || !outId) {
  console.error('用法: node tooling/chroma.mjs <in.jpeg> <out-id> [t0] [t1]');
  process.exit(1);
}
const T0 = Number(t0Arg || 18);
const T1 = Number(t1Arg || 55);
const PORT = 5198;
const b64 = readFileSync(resolve(ROOT, inFile)).toString('base64');
const mime = /\.png$/i.test(inFile) ? 'image/png' : 'image/jpeg';

const PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>
<pre id="log">running</pre><script>
const T0 = ${T0}, T1 = ${T1}, OUT = ${JSON.stringify(outId)};
const img = new Image();
img.onload = async () => {
  const W = img.naturalWidth, H = img.naturalHeight, N = W * H;
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const g = cv.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0);
  const im = g.getImageData(0, 0, W, H);
  const d = im.data;

  const smooth = (x) => { const t = Math.min(1, Math.max(0, x)); return t * t * (3 - 2 * t); };

  // 1. chroma key -> alpha + hue-preserving despill.
  // Thresholds adapt to luminance: shadowed cream keeps key~40 but dim spill
  // must still die. adapt = (1-lum)*20 added to T0/T1.
  const alpha = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const p = i * 4;
    let r = d[p], gg = d[p + 1], b = d[p + 2];
    const key = gg - Math.max(r, b);
    const lum = (0.299 * r + 0.587 * gg + 0.114 * b) / 255;
    const adapt = (1 - lum) * 20;
    const a = 1 - smooth((key - (T0 + adapt)) / ((T1 + adapt) - (T0 + adapt)));
    alpha[i] = a;
    if (a > 0.02) {
      const cap = Math.max(r, b) + 10; // pull G down to neutral+10, keep hue (mint stays mint)
      if (a < 0.92) { if (gg > cap) d[p + 1] = cap; }
      else if (key > 40 && gg > cap) { d[p + 1] = cap + (gg - cap) * 0.16; }
    }
  }

  // ---- 2. 连通域：丢掉离主体太远的小块（水印）----
  const bin = new Uint8Array(N);
  for (let i = 0; i < N; i++) bin[i] = alpha[i] > 0.5 ? 1 : 0;

  const label = new Int32Array(N).fill(-1);
  const comps = [];
  for (let i = 0; i < N; i++) {
    if (!bin[i] || label[i] >= 0) continue;
    const cid = comps.length, q = [i]; label[i] = cid;
    let area = 0, minX = W, maxX = 0, minY = H, maxY = 0;
    while (q.length) {
      const k = q.pop(); area++;
      const x = k % W, y = (k / W) | 0;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      for (const m of [k - 1, k + 1, k - W, k + W]) {
        if (m < 0 || m >= N || !bin[m] || label[m] >= 0) continue;
        if ((m === k - 1 || m === k + 1) && Math.abs((m % W) - x) !== 1) continue;
        label[m] = cid; q.push(m);
      }
    }
    comps.push({ cid, area, minX, maxX, minY, maxY });
  }
  comps.sort((a, b) => b.area - a.area);
  const main = comps[0];
  const margin = Math.round(Math.min(W, H) * 0.10);
  const keep = new Set();
  for (const c of comps) {
    if (!main) break;
    if (c.area < main.area * 0.004) continue;
    const small = c.area < main.area * 0.02;
    if (small && c.minY > main.maxY - 5) continue; // small bits hanging below subject (watermark)
    const m = small ? 0 : margin;            // 小块必须完整落在主体包围盒内（水印就这样被筛掉）
    if (c.minX >= main.minX - m && c.maxX <= main.maxX + m &&
        c.minY >= main.minY - m && c.maxY <= main.maxY + m) keep.add(c.cid);
  }
  for (let i = 0; i < N; i++) if (label[i] >= 0 && !keep.has(label[i])) alpha[i] = 0;

  // ---- 3. 羽化 1px ----
  const soft = new Float32Array(N);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let s = 0, n = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      s += alpha[ny * W + nx]; n++;
    }
    soft[y * W + x] = s / n;
  }

  let minX = W, maxX = -1, minY = H, maxY = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (soft[y * W + x] > 0.4) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) { document.getElementById('log').textContent = 'EMPTY'; document.title = 'done'; return; }

  for (let i = 0; i < N; i++) d[i * 4 + 3] = Math.round(soft[i] * 255);
  g.putImageData(im, 0, 0);

  // ---- 4. 裁切 + 装进 840×1040 ----
  const pad = Math.round(Math.min(maxX - minX, maxY - minY) * 0.05);
  const sx = Math.max(0, minX - pad), sy = Math.max(0, minY - pad);
  const sw = Math.min(W - sx, maxX - minX + pad * 2), sh = Math.min(H - sy, maxY - minY + pad * 2);
  const OW = 840, OH = 1040;
  const out = document.createElement('canvas'); out.width = OW; out.height = OH;
  const og = out.getContext('2d'); og.imageSmoothingQuality = 'high';
  const scale = Math.min(OW / sw, OH / sh);
  const dw = sw * scale, dh = sh * scale;
  og.drawImage(cv, sx, sy, sw, sh, (OW - dw) / 2, (OH - dh) / 2, dw, dh);

  const blob = await new Promise((r) => out.toBlob(r, 'image/png'));
  await fetch('/save?id=' + encodeURIComponent(OUT), { method: 'POST', body: await blob.arrayBuffer() });
  document.getElementById('log').textContent = 'OK ' + OUT + ' comps=' + comps.length + ' kept=' + keep.size;
  document.title = 'done';
};
img.onerror = () => { document.getElementById('log').textContent = 'LOAD_FAIL'; document.title = 'done'; };
img.src = 'data:${mime};base64,${b64}';
</script></body></html>`;

const server = createServer((req, res) => {
  if (req.method === 'POST' && req.url.startsWith('/save')) {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const buf = Buffer.concat(chunks);
      const dir = /^badge/.test(outId) ? join(ROOT, 'assets/badges') : join(ROOT, 'assets/characters');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${outId}.png`), buf);
      console.log(`✓ ${outId}.png  ${(buf.length / 1024).toFixed(0)} KB`);
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
    '--window-size=1200,1400', '--virtual-time-budget=25000',
    `http://localhost:${PORT}/`,
  ], { stdio: 'ignore' });

  let done = false;
  const finish = (code) => { if (done) return; done = true; try { child.kill(); } catch {} server.close(() => process.exit(code)); };
  setTimeout(() => finish(0), 26000);
  child.on('exit', () => setTimeout(() => finish(0), 1500));
});
