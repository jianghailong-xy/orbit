// Real built web + branch apiserver, with the isolated heartbeat fixtures from seed.mjs.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Page } from '../../../scripts/codex-reset-e2e/browser.mjs';
import { WebFront, freePort, eventually } from '../../../scripts/codex-reset-e2e/harness.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const output = process.env.EVIDENCE_DIR;
assert(output, 'EVIDENCE_DIR must name this session uploads directory');
const fixture = JSON.parse(readFileSync(path.join(output, 'gemini-entry-fixture.json'), 'utf8'));
assert(new URL(fixture.apiOrigin).hostname === '127.0.0.1');
const port = await freePort();
const front = new WebFront({ dist: path.join(repo, 'src/web/dist'), upstream: fixture.apiOrigin });
const origin = await front.listen();
const browser = spawn(process.env.CHROMIUM || '/root/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome', [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-background-networking', '--disable-component-update', '--disable-sync',
  '--window-size=1440,1000',
  '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${port}`,
  `--user-data-dir=${path.join(output, 'gemini-entry-chromium')}`, 'about:blank',
], { detached: true, stdio: 'ignore' });
writeFileSync(path.join(output, 'gemini-entry-browser-pid.json'), JSON.stringify({ pid: browser.pid }));
let page;
const checks = [];
const images = [];
let readyInstalled = true;
const record = (text) => { checks.push(text); console.log(text); };
const byText = (selector, text) => [...document.querySelectorAll(selector)].find((el) => el.textContent?.trim() === text);
const get = (selector) => document.querySelector(selector);
const visibleText = (selector) => document.querySelector(selector)?.textContent ?? '';
async function heartbeat() {
  await Promise.all(Object.entries(fixture.runners).map(async ([state, runner]) => {
    const response = await fetch(fixture.apiOrigin + '/api/runner/heartbeat', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + runner.token, 'content-type': 'application/json',
        'X-Orbit-Supported-Providers': state === 'upgrade' ? 'claude,codex,kimi,opencode' : 'claude,codex,kimi,opencode,antigravity' },
      body: JSON.stringify({ status: 'ONLINE', idleCapacity: 16, version: state === 'upgrade' ? '0.1.208' : '0.1.209',
        engines: [
          ...['claude', 'codex', 'kimi'].map((engine) => ({ engine, installed: true, auth: 'yes', version: 'test' })),
          { engine: 'antigravity', installed: state !== 'uninstalled' && readyInstalled, auth: 'no', ...(state !== 'uninstalled' && readyInstalled ? { version: '1.2.16' } : {}) },
        ] }),
    });
    assert(response.ok, 'test runner heartbeat ' + state + ': ' + response.status);
  }));
}
async function waitFor(selector) {
  await eventually(selector, () => page.call((s) => !!document.querySelector(s), selector), 30_000);
}
async function shot(name, selector) {
  await page.point(get, selector);
  await page.call((s) => document.querySelector(s)?.scrollIntoView({ block: 'center', behavior: 'instant' }), selector);
  // Wait for font/layout and the scroll before measuring the screenshot clip.
  const box = await page.call(async (s) => {
    await document.fonts.ready;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const r = document.querySelector(s).getBoundingClientRect();
    return { x: Math.max(0, r.x - 12), y: Math.max(0, r.y - 12), width: r.width + 24, height: r.height + 24 };
  }, selector);
  const result = await page.send('Page.captureScreenshot', { format: 'png', clip: { ...box, scale: 1 }, captureBeyondViewport: false });
  writeFileSync(path.join(output, name + '.png'), Buffer.from(result.data, 'base64'));
  images.push({ name, selector });
}
async function goto(route) {
  await heartbeat();
  await page.goto(origin + route);
  await waitFor('.app-main');
}
try {
  await eventually('Chromium DevTools', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`);
    return response.ok;
  });
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  page = await Page.connect(target.webSocketDebuggerUrl);
  await page.goto(origin);
  await page.call((access, refresh) => {
    localStorage.setItem('orbit_token', access);
    localStorage.setItem('orbit_refresh', refresh);
    localStorage.setItem('orbit_theme', 'light');
  }, fixture.accessToken, fixture.refreshToken);

  for (const [state, workspace] of Object.entries(fixture.workspaces)) {
    await goto(`/workspaces/${workspace}/new`);
    await waitFor('.np-card');
    await page.click(get, '.np-card');
    await waitFor('.np-list');
    const text = await page.call(visibleText, '.np-list');
    assert(text.includes('Gemini') && text.includes('Antigravity CLI'), state + ': Gemini runtime label');
    assert.equal(text.includes('env key'), state === 'envKey', state + ': server key visibility');
    assert(!text.includes('Managed by the provider'));
    if (state === 'upgrade') assert(text.includes('Update runner'));
    if (state === 'uninstalled') assert(text.includes('Not installed'));
    await shot('picker-' + state, '.np-list');
    assert(await page.call(() => [...document.querySelectorAll('.np-list .np-label-detail')].every((detail) => detail.getBoundingClientRect().right <= detail.parentElement.getBoundingClientRect().right + 1)), state + ': runtime detail must be visible without truncation');
    if (state === 'upgrade' || state === 'uninstalled') {
      await page.click((label) => [...document.querySelectorAll('.np-unavailable')].find((e) => e.textContent.includes(label)), 'Gemini');
      await waitFor('[data-engine="antigravity"].focused');
      const query = new URL(await page.call(() => location.href)).searchParams;
      assert.equal(query.get('engine'), 'antigravity');
      assert.equal(query.get('runner'), fixture.runners[state === 'upgrade' ? 'upgrade' : 'uninstalled'].id);
      assert.equal(await page.call((s) => document.querySelector(s).closest('.re-runner-card').classList.contains('collapsed'), '[data-engine="antigravity"].focused'), false);
      record('Picker ' + state + ' opens the intended expanded Antigravity runner row');
    }
    record('Picker ' + state + ' visibility, model and readiness labels verified');
  }

  await goto('/providers');
  await waitFor('[data-engine="antigravity"]');
  // Expand every runner to show the new row after Kimi in the same card structure.
  await page.call(() => document.querySelectorAll('.re-toggle[aria-expanded="false"]').forEach((b) => b.click()));
  for (const [state, runner] of Object.entries(fixture.runners)) {
    await goto(`/providers?runner=${runner.id}&engine=antigravity`);
    await waitFor('[data-engine="antigravity"].focused');
    const text = await page.call(visibleText, '[data-engine="antigravity"].focused');
    assert(text.includes('No sign-in · runs on your Gemini key'));
    if (state === 'ready') assert(text.includes('1.2.16') && text.includes('Ready'));
    if (state === 'upgrade') assert(text.includes('Update runner') && text.includes('0.1.209+') && !text.includes('Install'));
    if (state === 'uninstalled') assert(text.includes('Not installed') && text.includes('Install'));
    await shot('provider-runner-' + state, '.re-runner-card:has([data-engine="antigravity"].focused)');
    record('Provider runner ' + state + ' status and actions verified');
  }
  await waitFor('.prov-runtime');
  assert((await page.call(visibleText, '.prov-runtime')).includes('Ready on 1 runner'));
  await shot('provider-gemini-ready', '.ant-table-row:has(.prov-runtime)');
  await page.click(byText, '.prov-runtime a', 'See runners ↑');
  assert(await page.call(() => document.querySelector('#provider-runners').getBoundingClientRect().top < innerHeight));
  record('Gemini counts only the supported installed online runner; See runners scrolls to cards');
  readyInstalled = false;
  await goto('/providers');
  await waitFor('.prov-runtime');
  assert((await page.call(visibleText, '.prov-runtime')).includes('Not ready on any runner'));
  await shot('provider-gemini-notReady', '.ant-table-row:has(.prov-runtime)');
  record('Gemini shows Not ready on any runner when no online runner can run agy');
  readyInstalled = true;

  for (const [state, session] of Object.entries(fixture.sessions)) {
    await goto(`/sessions/${session}`);
    await waitFor('.chat-authfix');
    const text = await page.call(visibleText, '.chat-authfix');
    if (state === 'needsKey') {
      assert(text.includes('Antigravity needs a Gemini API key'));
      assert(text.includes('Orbit stores the key encrypted') && text.includes('Switch to Gemini'));
      assert(!text.includes('environment variables'));
    } else if (state === 'updateRunner') {
      assert(text.includes('HPC runs Orbit runner 0.1.208; Antigravity needs 0.1.209 or newer.'));
      assert(text.includes('no session is running on it') && text.includes('Open in Providers'));
    } else {
      assert(text.includes("Antigravity CLI isn't installed on workstation"));
      assert(text.includes('Install') && text.includes('Open in Providers'));
    }
    await shot('session-' + state, '.chat-authfix');
    record('Session repair ' + state + ' title, body and actions verified');
    if (state === 'needsKey') {
      await page.click(byText, '.chat-authfix button', 'Connect Gemini');
      await eventually('configured Gemini edit route', () => page.call((id) => location.pathname === '/providers/' + id, fixture.provider.id));
      record('Connect Gemini opens the existing encrypted-key edit page');
      await goto(`/sessions/${session}`);
      await waitFor('.chat-authfix');
      await page.click(byText, '.chat-authfix button', 'Switch to Gemini');
      // A failed conversation keeps its current run immutable; the established picker
      // applies the same-runtime override to the next message when it resumes.
      await eventually('next-message Gemini override', () => page.call(() => document.body.textContent.includes('Gemini') && document.body.textContent.includes('Your next message')));
      await page.call(() => {
        const el = document.querySelector('.composer-field textarea');
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, 'Continue using connected Gemini.');
        el.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await eventually('resume message enabled', () => page.call(() => !document.querySelector('.composer-send').disabled));
      await page.click(get, '.composer-send');
      await eventually('same-runtime Gemini session switch', async () => {
        const s = await page.call(async (id, token) => (await fetch('/api/sessions/' + id, { headers: { authorization: 'Bearer ' + token } })).json(), session, fixture.accessToken);
        return s.provider === fixture.provider.slug;
      });
      record('Switch to Gemini resumes this conversation on the encrypted-key provider through the existing same-runtime switch');
    }
  }
  // Verify Install really enters the existing relay and names agy, without installing anything.
  await goto(`/sessions/${fixture.sessions.notInstalled}`);
  await waitFor('.chat-authfix');
  await page.click(byText, '.chat-authfix button', 'Install');
  await eventually('Antigravity install relay', async () => {
    const rows = await page.call(async (token) => (await fetch('/api/runners', { headers: { authorization: 'Bearer ' + token } })).json(), fixture.accessToken);
    const row = rows.find((r) => r.id === fixture.runners.uninstalled.id);
    return row?.install?.engine === 'antigravity' && row.install.status === 'pending';
  });
  record('Session Install posts antigravity to the runner install relay');

  writeFileSync(path.join(output, 'gemini-entry-browser-checks.json'), JSON.stringify({ checks, images, exceptions: page.exceptions }, null, 2));
  console.log('Saved ' + images.length + ' real UI screenshots');
} finally {
  page?.close();
  front.close();
  // Only the process group launched above, whose PID is recorded in this session's uploads.
  if (browser.exitCode === null) process.kill(-browser.pid, 'SIGTERM');
}
// The local proxy may still have an upstream SSE socket after the page closes. All
// assertions and artifacts are complete; terminate this disposable harness cleanly.
process.exit(0);
