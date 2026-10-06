// node drive.mjs <plan.json-module> — drive the real web console in headless Chrome over CDP.
// A plan is { theme, width, height, steps: [...] }; each step is one of:
//   { go: '/path' }                 navigate (signed in with a fake token)
//   { wait: 'text', ms }            wait until the page body contains text
//   { click: 'text', within?: 'css', exact?: true }  click the innermost element whose text matches
//   { clickSel: 'css' }             click the first element matching a selector
//   { type: 'text', sel: 'css' }    set a textarea/input's value as React sees it
//   { key: 'Enter', sel }           press a key in an element
//   { sleep: ms }
//   { shot: 'name' }                screenshot the viewport at 2x to out/<name>.png
//   { api: '/__reset' }             call the fake API directly
//   { dump: 'name' }                write the body text to out/<name>.txt
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const plan = (await import(process.argv[2])).default;
const OUT = '/var/tmp/p5-web/out';
const CHROME = '/root/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome';
const PORT = 9300 + Math.floor(Math.random() * 600);
const proc = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=/var/tmp/p5-web/prof-${PORT}`, '--hide-scrollbars', '--lang=en-US', 'about:blank'],
  { stdio: 'ignore', env: { ...process.env, FONTCONFIG_FILE: '/var/tmp/p5-web/fonts.conf' } });
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
  if (msg.method === 'Runtime.exceptionThrown') console.log('EXC', msg.params.exceptionDetails.exception?.description?.slice(0, 300));
});
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400));
  return r.result?.result?.value;
};
const nav = async (url) => { const p = new Promise((r) => loaded.push(r)); await send('Page.navigate', { url }); await Promise.race([p, sleep(15000)]); };

await send('Page.enable');
await send('Runtime.enable');
const mobile = (plan.width ?? 1440) < 600;
await send('Emulation.setDeviceMetricsOverride', { width: plan.width ?? 1440, height: plan.height ?? 900, deviceScaleFactor: 2, mobile });
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: plan.theme ?? 'light' }, ...(mobile ? [] : [{ name: 'hover', value: 'hover' }, { name: 'pointer', value: 'fine' }])] });
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: 'user', exp: Math.floor(Date.now() / 1000) + 86400 * 7 })}.sig`;
await nav('http://127.0.0.1:5195/login');
await evaluate(`localStorage.setItem('orbit_token', ${JSON.stringify(jwt)}); localStorage.setItem('orbit_refresh', 'r'); localStorage.setItem('orbit-theme', ${JSON.stringify(plan.theme ?? 'light')}); true`);

const CLICK = (text, within, exact) => `(() => {
  const root = ${within ? `document.querySelector(${JSON.stringify(within)})` : 'document'} || document;
  const all = [...root.querySelectorAll('button, a, [role=menuitem], [role=option], [role=button], .ant-select-item, li, span, div')]
    .filter((el) => el.offsetParent !== null || el.getClientRects().length);
  const hit = all.filter((el) => ${exact ? `el.textContent.trim() === ${JSON.stringify(text)}` : `el.textContent.includes(${JSON.stringify(text)})`})
    .sort((a, b) => a.textContent.length - b.textContent.length)[0];
  if (!hit) return 'MISSING';
  const target = hit.closest('button, a, [role=menuitem], [role=option], [role=button], .ant-select-item, .ant-select-selector, .ant-dropdown-trigger') || hit;
  target.scrollIntoView({ block: 'center' });
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
  return target.tagName + ':' + target.textContent.trim().slice(0, 60);
})()`;

for (const step of plan.steps) {
  try {
    if (step.go) { await nav(`http://127.0.0.1:5195${step.go}`); await sleep(step.ms ?? 3500); }
    else if (step.api) { await fetch(`http://127.0.0.1:3995${step.api}`); }
    else if (step.wait) {
      let ok = false;
      for (let i = 0; i < (step.ms ?? 12000) / 300 && !ok; i++) { ok = await evaluate(`document.body.innerText.includes(${JSON.stringify(step.wait)})`); if (!ok) await sleep(300); }
      console.log(ok ? 'seen' : 'NOT SEEN', step.wait);
    }
    else if (step.click) { console.log('click', step.click, '=>', await evaluate(CLICK(step.click, step.within, step.exact))); await sleep(step.ms ?? 900); }
    else if (step.clickSel) { console.log('clickSel', step.clickSel, '=>', await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(step.clickSel)}); if (!el) return 'MISSING'; for (const t of ['pointerdown','mousedown','pointerup','mouseup','click']) el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window })); return el.tagName; })()`)); await sleep(step.ms ?? 900); }
    else if (step.type !== undefined) {
      console.log('type =>', await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(step.sel ?? 'textarea')}); if (!el) return 'MISSING'; el.focus();
        const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(step.type)});
        el.dispatchEvent(new Event('input', { bubbles: true })); return 'ok'; })()`));
      await sleep(600);
    }
    else if (step.key) {
      await evaluate(`document.querySelector(${JSON.stringify(step.sel ?? 'textarea')})?.focus(); true`);
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: step.key, code: step.key, windowsVirtualKeyCode: step.key === 'Enter' ? 13 : 27, text: step.key === 'Enter' ? '\r' : undefined });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: step.key, code: step.key, windowsVirtualKeyCode: step.key === 'Enter' ? 13 : 27 });
      await sleep(step.ms ?? 1500);
    }
    else if (step.hover) {
      const r = await evaluate(`(() => { const all = [...document.querySelectorAll(${JSON.stringify(step.within ?? 'body')} + ' *')].filter((el) => el.textContent.includes(${JSON.stringify(step.hover)}) && el.getClientRects().length).sort((a, b) => a.textContent.length - b.textContent.length); const el = all[0]; if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
      console.log('hover', step.hover, '=>', JSON.stringify(r));
      if (r) { await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x - 30, y: r.y }); await sleep(150); await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x, y: r.y }); }
      await sleep(step.ms ?? 1200);
    }
    else if (step.evalOut) writeFileSync(`${OUT}/${step.evalOut}.txt`, String(await evaluate(step.js)));
    else if (step.realClick) {
      const r = await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(step.realClick)}); if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
      console.log('realClick', step.realClick, '=>', JSON.stringify(r));
      if (r) for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: 'left', clickCount: 1 });
      await sleep(step.ms ?? 1200);
    }
    else if (step.realClickText) {
      const r = await evaluate(`(() => { const roots = [...document.querySelectorAll(${JSON.stringify(step.within ?? 'body')})].filter((el) => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
        const all = roots.flatMap((root) => [...root.querySelectorAll('*')]).filter((el) => el.textContent.trim() === ${JSON.stringify(step.realClickText)} && el.getClientRects().length);
        const el = all.sort((a, b) => a.querySelectorAll('*').length - b.querySelectorAll('*').length)[0]; if (!el) return null;
        const b = el.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
      console.log('realClickText', step.realClickText, '=>', JSON.stringify(r));
      if (r) for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: 'left', clickCount: 1 });
      await sleep(step.ms ?? 1000);
    }
    else if (step.sleep) await sleep(step.sleep);
    else if (step.dump) writeFileSync(`${OUT}/${step.dump}.txt`, await evaluate('document.body.innerText'));
    else if (step.shot) {
      await sleep(400);
      const shot = await send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(`${OUT}/${step.shot}.png`, Buffer.from(shot.result.data, 'base64'));
      console.log('wrote', step.shot);
    }
  } catch (e) { console.log('STEP FAILED', JSON.stringify(step), String(e).slice(0, 300)); }
}
ws.close();
proc.kill();
process.exit(0);
