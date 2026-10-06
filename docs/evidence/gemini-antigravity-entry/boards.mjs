// Arrange original, verified screenshots into three evidence boards; no UI is redrawn.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { Page } from '../../../scripts/codex-reset-e2e/browser.mjs';
import { freePort, eventually } from '../../../scripts/codex-reset-e2e/harness.mjs';

const dir = process.env.EVIDENCE_DIR;
assert(dir);
const boards = [
  { name: 'picker-states', title: 'Gemini / Antigravity picker', width: 824, height: 592, cols: 2, items: [
    ['Default: Gemini only', 'picker-default'], ['Update runner', 'picker-upgrade'],
    ['Not installed', 'picker-uninstalled'], ['Workspace environment key', 'picker-envKey'],
  ] },
  { name: 'providers-states', title: 'Providers: Antigravity CLI and Gemini key', width: 980, height: 1460, cols: 1, items: [
    ['Installed: agy version', 'provider-runner-ready'], ['Update runner: no install button', 'provider-runner-upgrade'],
    ['Not installed: Install', 'provider-runner-uninstalled'], ['Gemini: one ready runner', 'provider-gemini-ready'],
    ['Gemini: no ready runner', 'provider-gemini-notReady'],
  ] },
  { name: 'session-remedies', title: 'Conversation repair hints', width: 880, height: 615, cols: 1, items: [
    ['No key: Connect / Switch to Gemini', 'session-needsKey'],
    ['Update runner: name, version and idle update', 'session-updateRunner'],
    ['Missing CLI: Install / Open in Providers', 'session-notInstalled'],
  ] },
];
const port = await freePort();
const browser = spawn(process.env.CHROMIUM || '/root/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome', [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-background-networking',
  '--window-size=1440,1800', `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1',
  `--user-data-dir=${dir}/gemini-entry-boards`, 'about:blank',
], { detached: true, stdio: 'ignore' });
writeFileSync(`${dir}/boards-browser-pid.json`, JSON.stringify({ pid: browser.pid }));
let page;
try {
  await eventually('board browser', async () => (await fetch(`http://127.0.0.1:${port}/json/version`)).ok);
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  page = await Page.connect(target.webSocketDebuggerUrl);
  for (const board of boards) {
    const html = `<!doctype html><meta charset="utf-8"><style>*{box-sizing:border-box}body{margin:0;padding:20px;background:#f3f5f8;color:#1f2937;font:14px system-ui}h1{font-size:20px;margin:0 0 14px}.grid{display:grid;grid-template-columns:repeat(${board.cols},minmax(0,1fr));gap:14px}section{min-width:0}h2{margin:0 0 5px;font-size:13px;font-weight:600}img{display:block;max-width:100%;height:auto;border-radius:8px}</style><h1>${board.title}</h1><div class="grid">${board.items.map(([label, name]) => `<section><h2>${label}</h2><img src="data:image/png;base64,${readFileSync(`${dir}/${name}.png`).toString('base64')}"></section>`).join('')}</div>`;
    writeFileSync(`${dir}/${board.name}.html`, html);
    await page.send('Emulation.setDeviceMetricsOverride', { width: board.width, height: board.height, deviceScaleFactor: 1, mobile: false });
    await page.goto(`file://${dir}/${board.name}.html`);
    await page.call(async () => {
      await Promise.all([...document.images].map((image) => image.decode()));
      await document.fonts.ready;
    });
    await page.screenshot(`${dir}/${board.name}.png`);
    console.log(`${board.name}.png: assembled from the original UI screenshots`);
  }
} finally {
  page?.close();
  if (browser.exitCode === null) process.kill(-browser.pid, 'SIGTERM');
}
process.exit(0);
