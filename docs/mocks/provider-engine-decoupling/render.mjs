// Renders the boards in this directory to PNG at 2x, light and dark: <board>-light.png, <board>-dark.png.
//   FONTCONFIG_FILE=<fonts.conf> node docs/mocks/provider-engine-decoupling/render.mjs [board ...]
// No board names = every *.html here. Same toolchain as the other hand-drawn boards (headless
// Chromium over raw CDP, the whole .m-sheet captured): CHROME defaults to Playwright's chromium-1243.
// The host has no SF Pro / PingFang, so FONTCONFIG_FILE should alias -apple-system, system-ui and
// "PingFang SC" to Inter and Noto Sans SC (the fonts.conf the Kimi boards used does). Each PNG is then
// squeezed to a 256-colour palette with Pillow (python3), about a third of the size; skipped without it.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const boards = process.argv.slice(2).length
  ? process.argv.slice(2).map((b) => b.replace(/\.html$/, ''))
  : readdirSync(here).filter((f) => f.endsWith('.html')).map((f) => f.replace(/\.html$/, '')).sort();
const CHROME = process.env.CHROME ?? `${process.env.HOME}/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SQUEEZE = `import sys
from PIL import Image
for f in sys.argv[1:]:
    Image.open(f).convert('RGB').quantize(colors=256, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE).save(f, optimize=True)`;
const squeeze = (file) => spawnSync('python3', ['-I', '-c', SQUEEZE, file], { stdio: 'inherit' }).status === 0;

const port = 9700 + Math.floor(Math.random() * 200);
const profile = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'pe-board-'));
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
const errors = [];
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
});
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.result?.value;
await send('Page.enable');
await send('Runtime.enable');

let failed = false;
for (const board of boards) {
  for (const theme of ['light', 'dark']) {
    errors.length = 0;
    await send('Emulation.setDeviceMetricsOverride', { width: 2200, height: 1400, deviceScaleFactor: 2, mobile: false });
    await send('Page.navigate', { url: `file://${join(here, board + '.html')}?theme=${theme}` });
    await sleep(1200);
    const fonts = await evaluate(`(async () => { await document.fonts.ready; return document.fonts.status; })()`);
    const box = await evaluate(`(() => { const r = document.querySelector('.m-sheet').getBoundingClientRect(); return { w: Math.ceil(r.right), h: Math.ceil(r.bottom) }; })()`);
    if (!box || errors.length) { console.error(board, theme, 'FAILED', errors.join(' | ')); failed = true; continue; }
    await send('Emulation.setDeviceMetricsOverride', { width: box.w, height: box.h, deviceScaleFactor: 2, mobile: false });
    await sleep(400);
    const shot = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: box.w, height: box.h, scale: 1 } });
    const out = join(here, `${board}-${theme}.png`);
    writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
    console.log('wrote', out.replace(here + '/', ''), `${box.w}x${box.h}`, fonts, squeeze(out) ? 'squeezed' : 'not squeezed');
  }
}
ws.close();
chrome.kill();
process.exit(failed ? 1 : 0);
