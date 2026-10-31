// 极简 CDP 驱动：
//   node cdp.mjs qa <url> <outDir>        逐张截打印副本 + 诊断
//   node cdp.mjs pdf <url> <outPdf>       导出打印 PDF
const PORT = 9333;
import { writeFileSync, mkdirSync } from 'node:fs';

const [mode, url, out] = process.argv.slice(2);

const tab = await (await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })).json();
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let seq = 0;
const waiters = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && waiters.has(msg.id)) {
    const { res, rej, t } = waiters.get(msg.id);
    clearTimeout(t);
    waiters.delete(msg.id);
    msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
  }
};
const send = (method, params = {}, ms = 30000) => new Promise((res, rej) => {
  const id = ++seq;
  const t = setTimeout(() => { waiters.delete(id); rej(new Error('timeout ' + method)); }, ms);
  waiters.set(id, { res, rej, t });
  ws.send(JSON.stringify({ id, method, params }));
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function evalJS(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url });
await sleep(5000);

if (mode === 'pdf' || mode === 'pdf-nobg') {
  // pdf-nobg = 模拟"背景图形"复选框没勾（printBackground:false）
  const r = await send('Page.printToPDF', { preferCSSPageSize: true, printBackground: mode === 'pdf' });
  writeFileSync(out, Buffer.from(r.data, 'base64'));
  console.log('pdf ->', out);
} else {
  // 报告：打印副本里每张图的加载状态
  const diag = await evalJS(`(() => {
    const pr = document.getElementById('print-root');
    const sheets = [...pr.querySelectorAll('.print-sheet')];
    return {
      ph: getComputedStyle(document.documentElement).getPropertyValue('--ph'),
      sheets: sheets.length,
      rows: sheets.map((s, i) => {
        const imgs = [...s.querySelectorAll('img')];
        return {
          i: i + 1,
          cls: s.querySelector('.page')?.className.replace('page ', ''),
          imgs: imgs.length,
          broken: imgs.filter((x) => !x.complete || !x.naturalWidth).map((x) => x.getAttribute('src')),
        };
      }),
    };
  })()`);
  console.log(JSON.stringify(diag, null, 1));

  // 让打印副本顶到最前，逐页截图（看的就是"会打出来的样子"）
  await evalJS(`(() => {
    const pr = document.getElementById('print-root');
    pr.style.cssText = 'position:static;left:0;top:0;opacity:1;width:430px;pointer-events:none;--ph:560px';
    document.querySelectorAll('body > *:not(#print-root)').forEach((n) => { n.style.display = 'none'; });
    document.body.style.margin = '0';
    document.body.style.background = '#333';
    return true;
  })()`);
  await sleep(1200);

  mkdirSync(out, { recursive: true });
  const boxes = await evalJS(`[...document.querySelectorAll('.print-sheet')].map((s) => {
    const r = s.getBoundingClientRect();
    return { x: r.x + window.scrollX, y: r.y + window.scrollY, w: r.width, h: r.height };
  })`);
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i];
    try {
      const r = await send('Page.captureScreenshot', {
        format: 'png',
        clip: { x: b.x, y: b.y, width: b.w, height: b.h, scale: 2 },
        captureBeyondViewport: true,
      }, 15000);
      writeFileSync(`${out}/s${String(i + 1).padStart(2, '0')}.png`, Buffer.from(r.data, 'base64'));
    } catch (e) { console.log('shot fail', i + 1, e.message); }
  }
  console.log('shots ->', out, boxes.length);
}

ws.close();
process.exit(0);
