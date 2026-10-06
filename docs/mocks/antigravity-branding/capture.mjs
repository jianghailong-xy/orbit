import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { installFixedDate, installFixtures } from '../../../src/web/ui-migration/fixtures.mjs';
import { RUNNER, WORKSPACE } from '../../../src/web/ui-migration/session-fixtures.mjs';

// Capture the real application. Only transport responses use synthetic display data.
// Start the web Vite server, then run: node docs/mocks/antigravity-branding/capture.mjs
// Set ORBIT_PREVIEW_OUTPUT_DIR to preserve an earlier set of screenshots.
const origin = process.env.ORBIT_PREVIEW_ORIGIN ?? 'http://127.0.0.1:5177';
const directory = process.env.ORBIT_PREVIEW_OUTPUT_DIR
  ? resolve(process.env.ORBIT_PREVIEW_OUTPUT_DIR)
  : fileURLToPath(new URL('./', import.meta.url));
await mkdir(directory, { recursive: true });
const runner = {
  ...RUNNER, name: 'HPC', activeSessions: 0,
  engines: [
    { engine: 'claude', installed: true, auth: 'yes', version: '2.1.287' },
    { engine: 'codex', installed: true, auth: 'yes', version: '0.123.0' },
    { engine: 'kimi', installed: false, auth: 'no' },
    { engine: 'antigravity', installed: true, auth: 'no', version: 'agy 1.2.16' },
  ],
  antigravity: { supported: true, installed: true, version: 'agy 1.2.16', envKeyAvailable: false },
};
const provider = {
  id: WORKSPACE.id, slug: 'gemini', label: 'Gemini', presetSlug: 'gemini',
  runtime: 'antigravity', baseUrl: 'https://generativelanguage.googleapis.com',
  models: [{ value: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', contextWindow: 1048576 }],
  defaultModel: 'gemini-3.8-flash', followsPreset: true, modelsFromRuntime: true,
  enabled: true, hasApiKey: true,
};
const workspace = { ...WORKSPACE, name: 'Orbit', lastProvider: 'gemini', provider: 'gemini' };
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({
  viewport: { width: 1440, height: 1080 }, deviceScaleFactor: 2,
  colorScheme: 'light', reducedMotion: 'reduce', locale: 'en-US', timezoneId: 'UTC',
});
const errors = [];
let sessionRequest;
page.on('pageerror', (error) => errors.push(error.message));
await installFixedDate(page);
const fixtures = await installFixtures(page, { theme: 'light' });
await page.addInitScript((id) => {
  localStorage.setItem('orbit:providers-expanded-runners', JSON.stringify([id]));
}, RUNNER.id);
await page.route('**/api/**', async (route) => {
  const path = new URL(route.request().url()).pathname;
  if (route.request().method() === 'POST' && path === '/api/sessions') {
    sessionRequest = route.request().postDataJSON();
    return route.fulfill({ status: 503, json: { message: 'Preview only: request recorded, no session created.' } });
  }
  if (route.request().method() === 'GET') {
    const overrides = {
      '/api/runners': [runner],
      '/api/workspaces': [workspace],
      '/api/providers': [provider],
      '/api/providers/mine': [provider],
      '/api/providers/pools': [],
      '/api/providers/shared-pools': [],
      '/api/sessions': [],
      '/api/sessions/counts': [{ workspaceId: WORKSPACE.id, active: 0, running: 0, jobs: 0, needsYou: 0 }],
    };
    if (Object.hasOwn(overrides, path)) return route.fulfill({ json: overrides[path] });
    if (path.startsWith(`/api/runners/${RUNNER.id}/`) || path.startsWith(`/api/workspaces/${WORKSPACE.id}/`)) {
      if (path.endsWith('/files')) return route.fulfill({ json: { entries: [], path: '.' } });
      if (path.endsWith('/git-status')) return route.fulfill({ json: { branch: 'main', clean: true, files: [] } });
    }
  }
  await route.fallback();
});

try {
  await page.goto(`${origin}/providers`);
  await page.locator('[data-engine="antigravity"]').waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: `${directory}/01-providers.png`, animations: 'disabled', fullPage: true });
  const engines = await page.locator('.re-runner-card .re-name').allTextContents();
  assert(engines.indexOf('Antigravity') < engines.indexOf('Kimi Code'), 'Antigravity must precede Kimi');
  await page.locator('.re-runner-card').screenshot({ path: `${directory}/02-provider-engines.png`, animations: 'disabled' });

  await page.goto(`${origin}/workspaces/${WORKSPACE.id}/new`);
  await page.locator('.np-card').waitFor();
  await page.locator('.np-card').click();
  await page.locator('.np-list').waitFor();
  await page.waitForFunction(() => {
    const list = document.querySelector('.np-list');
    if (!list) return false;
    for (let node = list; node; node = node.parentElement) {
      if (Number(getComputedStyle(node).opacity) < 1) return false;
    }
    return true;
  });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: `${directory}/03-new-session.png`, animations: 'disabled', fullPage: true });
  const cardBox = await page.locator('.np-card').boundingBox();
  const listBox = await page.locator('.np-list').boundingBox();
  const top = Math.min(cardBox.y, listBox.y) - 56;
  const bottom = Math.max(cardBox.y + cardBox.height, listBox.y + listBox.height) + 56;
  await page.screenshot({
    path: `${directory}/04-new-session-picker.png`, animations: 'disabled',
    clip: { x: cardBox.x + cardBox.width / 2 - 330, y: top, width: 660, height: bottom - top },
  });
  const pickerLabels = await page.locator('.np-row-name').allTextContents();
  assert(pickerLabels.some((label) => label.startsWith('Antigravity')), 'Picker must show Antigravity');
  assert(!pickerLabels.some((label) => label.startsWith('Gemini')), 'Picker must not show Gemini as a provider');
  await page.locator('.np-row').filter({ has: page.locator('.np-row-name', { hasText: /^Claude$/ }) }).click();
  await page.locator('.np-card').click();
  await page.locator('.np-row').filter({ has: page.locator('.np-row-name', { hasText: /^Antigravity/ }) }).click();
  await page.locator('.composer-field textarea').fill('Verify Antigravity branding.');
  const submitted = page.waitForRequest((request) => request.method() === 'POST' && new URL(request.url()).pathname === '/api/sessions');
  await page.locator('.composer-field textarea').press('Enter');
  assert.equal((await submitted).postDataJSON().provider, 'gemini', 'Antigravity display must retain the configured provider dispatch slug');
  assert.deepEqual(errors, [], 'The real application must render without unhandled errors');
  fixtures.assertHandled();
  await writeFile(`${directory}/capture.json`, JSON.stringify({
    viewport: page.viewportSize(), browser: browser.version(), engines, pickerLabels, sessionRequest, errors,
    captures: ['01-providers.png', '02-provider-engines.png', '03-new-session.png', '04-new-session-picker.png'],
    fixtureData: 'Synthetic API responses; production routes, components, styles, and logos.',
  }, null, 2) + '\n');
  console.log(JSON.stringify({ directory, engines, pickerLabels, submittedProvider: sessionRequest?.provider, errors }));
} finally {
  await browser.close();
}
