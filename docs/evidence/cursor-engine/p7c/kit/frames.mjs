// Every phone of the owner's iOS boards (docs/mocks/cursor-engine/ios-*.html) as a PNG of its own, light and dark, with its label:
//   FONTCONFIG_FILE=<fonts.conf> node frames.mjs <mocks dir> <out dir>
// The board's own render (render.mjs): headless Chromium over raw CDP, 2x; each `.ph-wrap` (a stage label over a phone) clipped.
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [mocks, out] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const boards = readdirSync(mocks).filter((f) => /^ios-.*\.html$/.test(f)).map((f) => f.replace(/\.html$/, '')).sort();
const CHROME = process.env.CHROME ?? `${process.env.HOME}/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const port = 9500 + Math.floor(Math.random() * 200);
const profile = mkdtempSync(join(tmpdir(), 'p7c-frames-'));
const chrome = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${port}`,
  '--allow-file-access-from-files', `--user-data-dir=${profile}`, '--hide-scrollbars', '--lang=en-US', 'about:blank'], { stdio: 'ignore' });
let target;
for (let i = 0; i < 80 && !target; i++) {
  await sleep(250);
  try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page'); } catch {}
}
if (!target) { console.error('chrome did not start'); chrome.kill(); process.exit(1); }
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0;
const pending = new Map();
ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.result?.value;
await send('Page.enable');
const index = [];
for (const board of boards) {
  for (const theme of ['light', 'dark']) {
    await send('Emulation.setDeviceMetricsOverride', { width: 2200, height: 1400, deviceScaleFactor: 2, mobile: false });
    await send('Page.navigate', { url: `file://${join(mocks, board + '.html')}?theme=${theme}` });
    await sleep(1200);
    await evaluate(`document.fonts.ready.then(() => true)`);
    const box = await evaluate(`(() => { const r = document.querySelector('.m-sheet').getBoundingClientRect(); return { w: Math.ceil(r.right), h: Math.ceil(r.bottom) }; })()`);
    await send('Emulation.setDeviceMetricsOverride', { width: box.w, height: box.h, deviceScaleFactor: 2, mobile: false });
    await sleep(400);
    const wraps = await evaluate(`[...document.querySelectorAll('.ph-wrap')].map((e) => { const r = e.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height, label: e.innerText.split('\\n').slice(0, 2).join(' / ') }; })`);
    for (const [n, w] of wraps.entries()) {
      const shot = await send('Page.captureScreenshot', { format: 'png', clip: { x: w.x, y: w.y, width: w.w, height: w.h, scale: 1 } });
      const name = `${board}-${n + 1}-${theme}.png`;
      writeFileSync(join(out, name), Buffer.from(shot.result.data, 'base64'));
      if (theme === 'light') index.push({ board, n: n + 1, label: w.label });
    }
  }
}
writeFileSync(join(out, 'index.json'), JSON.stringify(index, null, 1));
ws.close(); chrome.kill();
