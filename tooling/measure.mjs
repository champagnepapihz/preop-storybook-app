import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5202;
const files = ['villain_pebble__happy.webp', 'villain_volcano__wow.webp', 'villain_corona__happy.webp', 'doctor__wave.webp', 'nurse__wave.webp'];
const BIN = {};
for (const f of files) BIN[f] = readFileSync(join(ROOT, 'assets/characters', f)).toString('base64');
const PAGE = `<!DOCTYPE html><html><body><pre id="log">run</pre><script>
const BIN = ${JSON.stringify(BIN)};
(async () => {
  const out = [];
  for (const [name, b64] of Object.entries(BIN)) {
    const img = new Image();
    await new Promise((res) => { img.onload = res; img.src = 'data:image/webp;base64,' + b64; });
    const cv = document.createElement('canvas'); cv.width = img.naturalWidth; cv.height = img.naturalHeight;
    const g = cv.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, cv.width, cv.height).data;
    let minY = cv.height, maxY = -1, minX = cv.width, maxX = -1;
    for (let y = 0; y < cv.height; y++) for (let x = 0; x < cv.width; x++) {
      if (d[(y * cv.width + x) * 4 + 3] > 20) {
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
      }
    }
    out.push(name + ' W=' + cv.width + ' H=' + cv.height + ' topPad=' + minY + ' botPad=' + (cv.height - 1 - maxY) + ' leftPad=' + minX);
  }
  document.getElementById('log').textContent = out.join('\\n');
  document.title = 'done';
})();
</script></body></html>`;
const server = createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(PAGE); });
server.listen(PORT, () => {
  const chrome = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
  const child = spawn(chrome, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--dump-dom', `http://localhost:${PORT}/`], { stdio: ['ignore', 'pipe', 'ignore'] });
  let html = '';
  child.stdout.on('data', (c) => { html += c; });
  child.on('exit', () => { const m = html.match(/<pre id="log">([\s\S]*?)<\/pre>/); console.log(m ? m[1] : 'NO_LOG'); server.close(() => process.exit(0)); });
  setTimeout(() => { try { child.kill(); } catch {} }, 25000);
});
