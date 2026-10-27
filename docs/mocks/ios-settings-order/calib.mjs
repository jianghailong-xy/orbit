// Re-lays the board's "today" phone at the owner's Pro Max width (440 pt, 20 pt margins) and prints its Sessions
// rows' heights and where Machines & models lands, to hold the drawing against the owner's 2026-10-27 screenshot
// (Suggested replies 150 pt, Session recaps 171 pt there).
//   FONTCONFIG_FILE=<fonts.conf> node docs/mocks/ios-settings-order/calib.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const board = join(dirname(fileURLToPath(import.meta.url)), '01-board.html');
const CHROME = `${process.env.HOME}/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const port = 9500 + Math.floor(Math.random() * 100);
const chrome = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${port}`, '--allow-file-access-from-files',
  `--user-data-dir=${mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'iso-calib-'))}`, 'about:blank'], { stdio: 'ignore' });
let target;
for (let i = 0; i < 80 && !target; i++) { await sleep(250); try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page'); } catch {} }
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0; const pending = new Map();
ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 2200, height: 1400, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: `file://${board}?theme=light` });
await sleep(1500);
const res = await send('Runtime.evaluate', { returnByValue: true, expression: `(() => {
  const ph = document.getElementById('ph-today');
  ph.style.width = '440px';
  ph.querySelectorAll('.sx-card').forEach((c) => { c.style.margin = '0 20px'; });
  ph.querySelectorAll('.sx-h, .sx-f').forEach((e) => { e.style.paddingLeft = '40px'; e.style.paddingRight = '40px'; });
  const rows = [...ph.querySelectorAll('#today-sessions .sx-r')].map((r) => [r.querySelector('.sx-t').textContent, Math.round(r.getBoundingClientRect().height * 10) / 10,
    r.querySelector('.sx-s') ? Math.round(r.querySelector('.sx-s').getBoundingClientRect().height / 20) : 0]);
  const y = (sel) => Math.round(at(ph, sel).y);
  // the Pro Max sheet starts 3 pt lower than the 393 one (62 vs 59)
  return { rows, sessH: Math.round(ph.querySelector('#today-sessions').getBoundingClientRect().height), mmTop: y('#today-mm') + 3, mmBottom: y('#today-mm') + 3 + 52 };
})()` });
console.log(JSON.stringify(res.result.result.value, null, 1));
ws.close(); chrome.kill(); process.exit(0);
