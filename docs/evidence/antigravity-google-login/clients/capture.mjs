import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { installFixtures } from '../../../../src/web/ui-migration/fixtures.mjs';
import { WORKSPACE, SESSION, SESSION_PATH } from '../../../../src/web/ui-migration/session-fixtures.mjs';

// Production routes/components and CSS; only the REST/SSE data are synthetic.
const fixtures = JSON.parse(readFileSync(new URL('./fixtures.json', import.meta.url), 'utf8'));
const output = fileURLToPath(new URL('./screenshots/', import.meta.url));
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const captures = [];
const base = process.env.ORBIT_EVIDENCE_WEB_URL ?? 'http://127.0.0.1:4178';

async function pageFor(width, state) {
  const context = await browser.newContext({ viewport: { width, height: 1000 }, deviceScaleFactor: 1, locale: 'en-US', timezoneId: 'UTC', reducedMotion: 'reduce' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await installFixtures(page);
  const runner = fixtures[state];
  const workspace = { ...WORKSPACE, name: 'Antigravity workspace', runnerId: runner.id, lastProvider: 'antigravity', provider: 'antigravity', model: 'gemini-3.8-flash', antigravityKeyAvailableByRunner: { [runner.id]: state === 'google' } };
  const session = { ...SESSION, title: 'Antigravity sign-in', provider: 'antigravity', workspaceId: workspace.id, workspace, agentId: workspace.id, agent: workspace, runnerId: runner.id, assignedRunnerId: runner.id, assignedRunner: runner };
  await page.addInitScript(({ id, now }) => {
    localStorage.setItem('orbit:providers-expanded-runners', JSON.stringify([id]));
    window.Date = new Proxy(Date, { construct: (D, args) => Reflect.construct(D, args.length ? args : [now]), get: (D, key) => key === 'now' ? () => now : Reflect.get(D, key) });
  }, { id: runner.id, now: Date.parse('2026-10-04T03:00:00Z') });
  await page.route('**/api/**', async route => {
    const { pathname } = new URL(route.request().url());
    const path = pathname.replace(/^\/api/, '');
    const json = body => route.fulfill({ status: 200, json: body });
    if (path === '/runners') return json([runner]);
    if (path === '/workspaces') return json([workspace]);
    if (path === `/workspaces/${workspace.id}`) return json(workspace);
    if (path === '/sessions') return json([session]);
    if (path === SESSION_PATH) return json(session);
    if (path === `${SESSION_PATH}/events/page`) return json({ events: [{ seq: 1, type: 'error', payload: { message: 'Failed to authenticate: Antigravity is not signed in on this runner — sign in with Google, or connect a Gemini API key in Providers.' } }], hasMore: false });
    if (path === `/runners/${runner.id}/login`) return json({ status: null });
    return route.fallback();
  });
  return { context, page, errors, runner, workspace };
}

async function capture(page, locator, name, errors) {
  await locator.waitFor({ state: 'visible' });
  await page.evaluate(() => document.fonts.ready);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  assert.equal(overflow, false, `${name}: page overflows its viewport`);
  assert.deepEqual(errors, [], `${name}: browser exceptions`);
  await locator.screenshot({ path: `${output}${name}.png`, animations: 'disabled' });
  captures.push({ name, viewport: page.viewportSize(), text: await locator.innerText() });
  console.log(`Captured ${name}`);
}

try {
  for (const width of [1280, 443]) {
    for (const state of ['signed-out', 'google', 'macos', 'old', 'env-key', 'unknown']) {
      const { context, page, errors, runner } = await pageFor(width, state);
      try {
        await page.goto(`${base}/providers?runner=${runner.id}&engine=antigravity`);
        const row = page.locator('[data-engine="antigravity"]');
        await row.waitFor({ state: 'visible' });
        const text = await row.innerText();
        const expected = {
          'signed-out': ['Signed out', 'Sign in with Google', 'personal account sign-in through third-party tools; your account may be suspended.'],
          google: ['Google account', '72% remaining', '18% remaining', 'resets'],
          macos: ['Google sign-in is not supported on macOS runners yet.'],
          old: ['Update this runner to sign in with Google.'],
          'env-key': ['env key · runs on your Gemini key'],
          unknown: ['Unknown'],
        }[state];
        for (const value of expected) assert.ok(text.includes(value), `${width}/${state}: missing ${value}`);
        if (state === 'signed-out') assert.equal(await row.locator('a').getAttribute('href'), 'https://antigravity.google/terms');
        if (state === 'google') {
          assert.equal(await row.locator('.re-reset').count(), 2);
          assert.equal(await row.getByRole('button', { name: 'More actions' }).count(), 1);
        }
        if (state === 'macos' || state === 'old') assert.equal(await row.getByRole('button').count(), 0);
        if (state === 'unknown') assert.ok(!text.includes('% remaining') && !text.includes('Google account'));
        await capture(page, row, `${width}-runner-${state}`, errors);
      } finally { await context.close(); }
    }
    {
      const { context, page, errors, workspace } = await pageFor(width, 'google');
      try {
        await page.goto(`${base}/workspaces/${workspace.id}/new`);
        const hero = page.locator('.np-hero');
        await hero.waitFor({ state: 'visible' });
        await hero.locator('button').first().click();
        await page.locator('.np-pop').waitFor({ state: 'visible' });
        await page.waitForTimeout(350); // Wait for the selector's entrance animation before capturing its text.
        assert.match(await page.locator('.np-pop').innerText(), /Antigravity[\s\S]*Google account/);
        await capture(page, page.locator('.np-pop'), `${width}-selector`, errors);
      } finally { await context.close(); }
    }
    {
      const { context, page, errors } = await pageFor(width, 'signed-out');
      try {
        await page.goto(`${base}${SESSION_PATH}`);
        await page.getByRole('button', { name: 'Sign in with Google' }).waitFor({ state: 'visible' });
        await capture(page, page.locator('.chat-authfix'), `${width}-auth-error`, errors);
      } finally { await context.close(); }
    }
  }
  writeFileSync(new URL('./capture-results.json', import.meta.url), JSON.stringify({ browser: browser.version(), captures }, null, 2) + '\n');
} finally { await browser.close(); }
