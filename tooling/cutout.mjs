/**
 * 抠图 + 去水印（无第三方依赖，无头 Chrome 做 Canvas 计算）
 *
 * 算法（v2）：不用泛洪，改用「背景曲面拟合」——棚拍背景是平滑渐晕，
 * 用四边环形采样拟合一个平面，再按像素与拟合背景的色差生成软 alpha。
 * 泛洪会被绒毛纹理漏进去，色差阈值不会。
 *
 *   1. 四边 2% 环带采样，逐通道拟合 z = a + bx + cy
 *   2. dist = max|p - fit| → smoothstep(t0, t1) 得软 alpha
 *   3. 连通域：面积过小的块丢弃（水印笔画、绒尘）
 *   4. 洞填充：从边界反向泛洪，没被淹到的封闭区域补成主体
 *   5. 1px 羽化 → 裁包围盒 → 等比装进 840×1040 透明画布
 *
 * 用法：node tooling/cutout.mjs <in.jpeg> <out-id> [t0] [minArea]
 *   t0 小＝抠得狠（适合深色主体）；t0 大＝保守（适合奶白主体贴着奶油底）
 */
import { createServer } from 'node:http';
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const [inFile, outId, t0Arg, areaArg] = process.argv.slice(2);
if (!inFile || !outId) {
  console.error('用法: node tooling/cutout.mjs <in.jpeg> <out-id> [t0] [minArea]');
  process.exit(1);
}

const T0 = Number(t0Arg || 12);
const T1 = Math.round(T0 * 1.8);
const MIN_AREA = Number(areaArg || 3000);
const PORT = 5199;
const srcAbs = resolve(ROOT, inFile);
const b64 = readFileSync(srcAbs).toString('base64');
const mime = /\.png$/i.test(inFile) ? 'image/png' : 'image/jpeg';

const PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>
<pre id="log">running</pre>
<script>
const T0 = ${T0}, T1 = ${T1}, MIN_AREA = ${MIN_AREA}, OUT_ID = ${JSON.stringify(outId)};
const img = new Image();
img.onload = async () => {
  const W = img.naturalWidth, H = img.naturalHeight, N = W * H;
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const g = cv.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0);
  const im = g.getImageData(0, 0, W, H);
  const d = im.data;

  // ---- 1. 环带采样 + 平面拟合 ----
  const ring = Math.max(4, Math.round(Math.min(W, H) * 0.02));
  const S = [];
  for (let y = 0; y < H; y += 4) for (let x = 0; x < W; x += 4) {
    if (x < ring || y < ring || x >= W - ring || y >= H - ring) S.push([x, y]);
  }
  const fit = (ch) => {
    let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0, sz = 0, sxz = 0, syz = 0;
    for (const [x, y] of S) {
      const z = d[(y * W + x) * 4 + ch];
      n++; sx += x; sy += y; sxx += x * x; sxy += x * y; syy += y * y;
      sz += z; sxz += x * z; syz += y * z;
    }
    const A = [[n, sx, sy], [sx, sxx, sxy], [sy, sxy, syy]];
    const B = [sz, sxz, syz];
    const det = (m) => m[0][0]*(m[1][1]*m[2][2]-m[1][2]*m[2][1])
                     - m[0][1]*(m[1][0]*m[2][2]-m[1][2]*m[2][0])
                     + m[0][2]*(m[1][0]*m[2][1]-m[1][1]*m[2][0]);
    const D = det(A);
    if (Math.abs(D) < 1e-9) return [sz / n, 0, 0];
    const rep = (col) => A.map((r, i) => r.map((v, j) => (j === col ? B[i] : v)));
    return [det(rep(0)) / D, det(rep(1)) / D, det(rep(2)) / D];
  };
  const [ar, br, cr] = fit(0), [ag, bg2, cg] = fit(1), [ab, bb, cb] = fit(2);

  // ---- 2. 色差 → 软 alpha ----
  const soft = new Float32Array(N);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const dr = Math.abs(d[i]     - (ar + br * x + cr * y));
      const dg = Math.abs(d[i + 1] - (ag + bg2 * x + cg * y));
      const db = Math.abs(d[i + 2] - (ab + bb * x + cb * y));
      const dist = Math.max(dr, dg, db);
      let a = (dist - T0) / (T1 - T0);
      a = a < 0 ? 0 : a > 1 ? 1 : a;
      soft[y * W + x] = a * a * (3 - 2 * a); // smoothstep
    }
  }

  // ---- 3. 连通域：只留够大的主体块 ----
  const binary = new Uint8Array(N);
  for (let i = 0; i < N; i++) binary[i] = soft[i] > 0.5 ? 1 : 0;

  const label = new Int32Array(N).fill(-1);
  const comps = [];
  for (let i = 0; i < N; i++) {
    if (!binary[i] || label[i] >= 0) continue;
    const cid = comps.length, q = [i];
    label[i] = cid;
    let area = 0, lum = 0;
    let cMinX = W, cMaxX = -1, cMinY = H, cMaxY = -1;
    while (q.length) {
      const k = q.pop(); area++;
      lum += d[k * 4] * 0.299 + d[k * 4 + 1] * 0.587 + d[k * 4 + 2] * 0.114;
      const x = k % W, y = (k - x) / W;
      if (x < cMinX) cMinX = x; if (x > cMaxX) cMaxX = x;
      if (y < cMinY) cMinY = y; if (y > cMaxY) cMaxY = y;
      const nb = [k - 1, k + 1, k - W, k + W];
      for (const m of nb) {
        if (m < 0 || m >= N) continue;
        if (!binary[m] || label[m] >= 0) continue;
        if ((m === k - 1 || m === k + 1) && Math.abs((m % W) - x) !== 1) continue;
        label[m] = cid; q.push(m);
      }
    }
    comps.push({ cid, area, lum: lum / area, minX: cMinX, maxX: cMaxX, minY: cMinY, maxY: cMaxY });
  }
  comps.sort((a, b) => b.area - a.area);
  // 只保留「贴着主体」的块：面积够大，且包围盒落在最大块的邻域内
  // （水印笔画、远处的绒尘都被这条筛掉，主体身上的小部件不会被误伤）
  const main = comps[0];
  const margin = Math.round(Math.min(W, H) * 0.06);
  const keep = new Set(
    comps
      .filter((c) => {
        if (c.area < MIN_AREA) return false;
        if (!main) return true;
        const cx = (c.minX + c.maxX) / 2, cy = (c.minY + c.maxY) / 2;
        return cx >= main.minX - margin && cx <= main.maxX + margin &&
               cy >= main.minY - margin && cy <= main.maxY + margin;
      })
      .map((c) => c.cid)
  );

  const mask = new Uint8Array(N);
  for (let i = 0; i < N; i++) if (label[i] >= 0 && keep.has(label[i])) mask[i] = 1;

  // ---- 3.5 闭运算：膨胀 2 次 + 腐蚀 2 次，补掉绒毛轮廓上的小豁口 ----
  const morph = (src, mode, iter) => {
    let cur = src;
    for (let it = 0; it < iter; it++) {
      const nxt = new Uint8Array(N);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        let v = mode === 'max' ? 0 : 1;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          const s2 = (nx < 0 || ny < 0 || nx >= W || ny >= H) ? 0 : cur[ny * W + nx];
          v = mode === 'max' ? Math.max(v, s2) : Math.min(v, s2);
        }
        nxt[y * W + x] = v;
      }
      cur = nxt;
    }
    return cur;
  };
  const closed = morph(morph(mask, 'max', 3), 'min', 3);
  mask.set(closed);

  // ---- 4. 洞填充：从边界反向泛洪 ----
  const outside = new Uint8Array(N);
  const st = [];
  const seed = (x, y) => { const i = y * W + x; if (!mask[i] && !outside[i]) { outside[i] = 1; st.push(i); } };
  for (let x = 0; x < W; x++) { seed(x, 0); seed(x, H - 1); }
  for (let y = 0; y < H; y++) { seed(0, y); seed(W - 1, y); }
  while (st.length) {
    const k = st.pop(), x = k % W;
    for (const m of [k - 1, k + 1, k - W, k + W]) {
      if (m < 0 || m >= N) continue;
      if ((m === k - 1 || m === k + 1) && Math.abs((m % W) - x) !== 1) continue;
      if (!mask[m] && !outside[m]) { outside[m] = 1; st.push(m); }
    }
  }
  for (let i = 0; i < N; i++) if (!outside[i]) mask[i] = 1;

  // ---- 5. 羽化 + 包围盒 ----
  const alpha = new Float32Array(N);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let s = 0, n = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      s += mask[ny * W + nx]; n++;
    }
    alpha[y * W + x] = s / n;
  }

  // ---- 5.5 绿幕渗色清理 ----
  // 绿底棚拍时，主体轮廓会带一圈绿渗色；脚底接触阴影还会把两脚之间的洞口封住，
  // 让洞填充把背景绿整块当成主体。这里只处理「绿通道明显压过 R/B」的像素：
  // 本项目角色是粉/蓝/驼/奶白，绿色占优不可能是主体本色，删了不会缺角。
  const GREEN_T0 = 14, GREEN_T1 = 44;
  let greened = 0;
  for (let i = 0; i < N; i++) {
    const p = i * 4;
    if (d[p + 3] === 0) continue;
    const r = d[p], g = d[p + 1], b = d[p + 2];
    const lim = Math.max(r, b);
    const over = g - lim;
    if (over <= GREEN_T0) continue;
    const k = Math.min(1, (over - GREEN_T0) / (GREEN_T1 - GREEN_T0));
    alpha[i] *= 1 - k;
    d[p + 1] = Math.round(lim + (g - lim) * 0.12); // 顺带把剩下的绿压回中性
    if (k > 0.5) greened++;
  }

  // 注：地面接触阴影保留。按色相剥离会误伤浅色主体（奶白大褂被啃出洞），
  // 且立牌本身带一点接触影更自然，页面另有 drop-shadow，不冲突。

  let minX = W, maxX = -1, minY = H, maxY = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (mask[y * W + x]) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) { document.getElementById('log').textContent = 'EMPTY_MASK'; document.title = 'done'; return; }

  for (let i = 0; i < N; i++) d[i * 4 + 3] = Math.round(alpha[i] * 255);
  g.putImageData(im, 0, 0);

  // ---- 6. 裁切 + 缩放 ----
  const pad = Math.round(Math.min(maxX - minX, maxY - minY) * 0.05);
  const sx = Math.max(0, minX - pad), sy = Math.max(0, minY - pad);
  const sw = Math.min(W - sx, maxX - minX + pad * 2), sh = Math.min(H - sy, maxY - minY + pad * 2);

  const OW = 840, OH = 1040;
  const out = document.createElement('canvas'); out.width = OW; out.height = OH;
  const og = out.getContext('2d');
  og.imageSmoothingQuality = 'high';
  const scale = Math.min(OW / sw, OH / sh);
  const dw = sw * scale, dh = sh * scale;
  og.drawImage(cv, sx, sy, sw, sh, (OW - dw) / 2, (OH - dh) / 2, dw, dh);

  const blob = await new Promise((r) => out.toBlob(r, 'image/png'));
  const buf = await blob.arrayBuffer();
  await fetch('/save?id=' + encodeURIComponent(OUT_ID), { method: 'POST', body: buf });

  document.getElementById('log').textContent =
    'OK ' + OUT_ID + ' comps=' + comps.length + ' kept=' + keep.size +
    ' greenKilled=' + greened +
    ' bbox=' + [minX, minY, maxX, maxY].join(',');
  document.title = 'done';
};
img.onerror = () => { document.getElementById('log').textContent = 'LOAD_FAIL'; document.title = 'done'; };
img.src = 'data:${mime};base64,${b64}';
</script></body></html>`;

mkdirSync(join(ROOT, 'assets/characters'), { recursive: true });

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
    `--user-data-dir=${join(ROOT, '.cutout-profile')}`, '--no-first-run', '--no-default-browser-check',
    '--window-size=1200,1400', '--virtual-time-budget=25000',
    `http://localhost:${PORT}/`,
  ], { stdio: 'ignore' });

  let done = false;
  const finish = (code) => { if (done) return; done = true; try { child.kill(); } catch {} server.close(() => process.exit(code)); };
  setTimeout(() => finish(0), 26000);
  child.on('exit', () => setTimeout(() => finish(0), 1200));
});
