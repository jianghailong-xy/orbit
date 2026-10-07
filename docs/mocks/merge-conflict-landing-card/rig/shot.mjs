// node shot.mjs <path> <out.png> [width] [height] [script.js|-] [mobile]
// env READY=<js expr> polls until truthy (30 s cap) before the script runs.
// Signs in with a fake token, opens <path> on the vite dev server (:5197), optionally runs a frame
// script in the page (with kit.js prepended), then screenshots the viewport (or the clip the script
// returns as { clip }) at 2x.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const [path = '/', out = '/tmp/oc-rig-out.png', w = '1440', h = '900', script, mobile] = process.argv.slice(2);
const READY = process.env.READY ?? `!!document.querySelector('.session-row')`;
const CHROME = '/root/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome';
const PORT = 9300 + Math.floor(Math.random() * 600);
const proc = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=/tmp/oc-rig-prof-${PORT}`, '--hide-scrollbars', '--lang=en-US', '--disable-features=BackForwardCache',
  ...(mobile ? [] : ['--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4']), 'about:blank'],
  { stdio: 'ignore', env: { ...process.env, FONTCONFIG_FILE: '/tmp/orbit-mock/fonts.conf' } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let target;
for (let i = 0; i < 80 && !target; i++) {
  await sleep(250);
  try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page'); } catch {}
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0;
const pending = new Map();
const loaded = [];
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
  if (msg.method === 'Page.loadEventFired') loaded.splice(0).forEach((f) => f());
  if (msg.method === 'Runtime.exceptionThrown') console.log('EXC', msg.params.exceptionDetails.exception?.description?.slice(0, 400) ?? msg.params.exceptionDetails.text);
  if (msg.method === 'Runtime.consoleAPICalled' && ['error'].includes(msg.params.type))
    console.log('CONSOLE', msg.params.type, msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 300));
});
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const nav = async (url) => { const p = new Promise((r) => loaded.push(r)); await send('Page.navigate', { url }); await Promise.race([p, sleep(15000)]); };
const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result;

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: +w, height: +h, deviceScaleFactor: 2, mobile: !!mobile });
if (mobile) await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
else await send('Emulation.setEmulatedMedia', { features: [{ name: 'hover', value: 'hover' }, { name: 'any-hover', value: 'hover' }, { name: 'pointer', value: 'fine' }, { name: 'prefers-reduced-motion', value: 'reduce' }] });
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: 'user', exp: Math.floor(Date.now() / 1000) + 86400 * 7 })}.sig`;
await nav('http://127.0.0.1:5197/login');
await evaluate(`localStorage.setItem('orbit_token', ${JSON.stringify(jwt)}); localStorage.setItem('orbit_refresh', 'r'); localStorage.setItem('orbit-theme', 'light');`);
await nav(`http://127.0.0.1:5197${path}`);
let ready = false;
for (let i = 0; i < 120 && !ready; i++) {
  await sleep(250);
  ready = (await evaluate(`(() => { try { return !!(${READY}); } catch { return false; } })()`))?.result?.value === true;
}
if (!ready) console.log('READY TIMEOUT', READY);
await sleep(1200);
let clipRect;
if (script && script !== '-') {
  const kit = readFileSync(new URL('./kit.js', import.meta.url), 'utf8');
  const body = readFileSync(script, 'utf8');
  const r = await evaluate(`(async () => {\n${kit}\n${body}\n})()`);
  if (r?.exceptionDetails) console.log('SCRIPT EXC', JSON.stringify(r.exceptionDetails).slice(0, 900));
  else if (r?.result?.value !== undefined) console.log('SCRIPT =>', JSON.stringify(r.result.value).slice(0, 4000));
  clipRect = r?.result?.value?.clip;
  await sleep(700);
}
const shot = await send('Page.captureScreenshot', clipRect ? { format: 'png', clip: { ...clipRect, scale: 1 } } : { format: 'png' });
writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
console.log('wrote', out);
ws.close();
proc.kill();
process.exit(0);
