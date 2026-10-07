// node render-board.mjs <board.html> <out.png> — renders a self-contained board at 2x, full size.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const [file, out] = process.argv.slice(2);
const CHROME = '/root/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome';
const PORT = 9300 + Math.floor(Math.random() * 600);
const proc = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${PORT}`, `--user-data-dir=/tmp/oc-rig-profb-${PORT}`,
  '--hide-scrollbars', '--allow-file-access-from-files', 'about:blank'], { stdio: 'ignore', env: { ...process.env, FONTCONFIG_FILE: '/tmp/orbit-mock/fonts.conf' } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let target;
for (let i = 0; i < 80 && !target; i++) { await sleep(250); try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page'); } catch {} }
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0; const pending = new Map(); const loaded = [];
ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } if (m.method === 'Page.loadEventFired') loaded.splice(0).forEach((f) => f()); });
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 2200, height: 1200, deviceScaleFactor: 2, mobile: false });
const p = new Promise((r) => loaded.push(r)); await send('Page.navigate', { url: `file://${file}` }); await Promise.race([p, sleep(15000)]);
await sleep(800);
const size = (await send('Runtime.evaluate', { expression: `JSON.stringify([Math.ceil(document.body.scrollWidth), Math.ceil(document.body.scrollHeight), [...document.images].filter(i => !i.complete || !i.naturalWidth).map(i => i.src)])`, returnByValue: true })).result.result.value;
const [w, h, broken] = JSON.parse(size);
if (broken.length) console.log('BROKEN IMAGES', broken);
await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: false });
await sleep(600);
const shot = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: w, height: h, scale: 1 } });
writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
console.log('wrote', out, w, 'x', h);
ws.close(); proc.kill(); process.exit(0);
