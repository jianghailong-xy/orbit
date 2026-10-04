import { test, expect } from '@playwright/test';
import { installFixtures } from './fixtures.mjs';

const opposite = (theme) => theme === 'dark' ? 'light' : 'dark';
const color = (theme) => theme === 'dark' ? '#202023' : '#ffffff';

async function observeTheme(page) {
  await page.addInitScript(() => {
    window.__foundationThemeMutations = [];
    new MutationObserver((records) => {
      for (const record of records) {
        if (record.target !== document.documentElement) continue;
        window.__foundationThemeMutations.push({
          old: record.oldValue, current: document.documentElement.dataset.theme,
        });
      }
    }).observe(document, { subtree: true, attributes: true, attributeOldValue: true, attributeFilter: ['data-theme'] });
  });
}

async function holdAppEntry(page) {
  let held = false;
  await page.route(/\/src\/main\.tsx(?:\?.*)?$/, async (route) => {
    if (new URL(route.request().url()).searchParams.has('foundation-boot-release')) {
      await route.continue();
      return;
    }
    held = true;
    // Finish the request without running application code: a pending module download
    // blocks WebKit's document.fonts.ready. The real HTML and inline boot stay intact.
    await route.fulfill({ contentType: 'application/javascript', body:
      'window.__foundationReleaseEntry = () => import("/src/main.tsx?foundation-boot-release");',
    });
  });
  await page.goto('/settings', { waitUntil: 'load' });
  await expect.poll(() => held, { message: 'The production app entry is held before execution' }).toBe(true);
  let released;
  return () => released ??= page.evaluate(() => window.__foundationReleaseEntry());
}

async function expectResolved(page, resolved) {
  await expect(page.locator('html')).toHaveAttribute('data-theme', resolved);
  await expect(page.locator('#theme-color')).toHaveAttribute('content', color(resolved));
}

async function expectBoot(page, resolved, testInfo) {
  await expect(page.locator('#root')).toBeEmpty();
  await expect(page.locator('#boot')).toBeVisible();
  await expectResolved(page, resolved);
  await expect(page.locator('#boot')).toHaveCSS('background-color', resolved === 'dark' ? 'rgb(22, 23, 26)' : 'rgb(255, 255, 255)');
  await testInfo.attach('production-boot-before-app', { body: await page.screenshot(), contentType: 'image/png' });
}

async function attachRecord(testInfo, page, api, pageErrors, extra = {}) {
  await testInfo.attach('theme-browser-evidence', {
    body: JSON.stringify({ ...extra, requests: api.requests, pageErrors,
      mutations: await page.evaluate(() => window.__foundationThemeMutations),
    }, null, 2), contentType: 'application/json',
  });
}

for (const mode of ['system', 'light', 'dark']) {
  test(`production boot and hydration preserve cached ${mode}`, async ({ page }, testInfo) => {
    const resolved = mode === 'system' ? testInfo.project.use.colorScheme : mode;
    const api = await installFixtures(page, { theme: mode });
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await observeTheme(page);
    const release = await holdAppEntry(page);
    try {
      await expectBoot(page, resolved, testInfo);
      await release();
      await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
      await expect(page.locator('#boot')).toHaveCount(0);
      await expectResolved(page, resolved);
      const mutations = await page.evaluate(() => window.__foundationThemeMutations);
      expect(mutations.length).toBeGreaterThan(0);
      expect(mutations.flatMap(({ old, current }) => [old, current]).filter(Boolean)).not.toContain(opposite(resolved));
      expect(await page.evaluate(() => localStorage.getItem('orbit-theme'))).toBe(mode);
      api.assertHandled();
      expect(pageErrors).toEqual([]);
    } finally {
      await release();
      await attachRecord(testInfo, page, api, pageErrors, { cachedMode: mode, resolved });
    }
  });
}

test('account adoption, preference writes and live system changes share the foundation theme', async ({ page }, testInfo) => {
  const cached = testInfo.project.use.colorScheme;
  const account = opposite(cached);
  const api = await installFixtures(page, { theme: cached });
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await observeTheme(page);
  const release = await holdAppEntry(page);
  let adoption;
  try {
    await expectBoot(page, cached, testInfo);
    // Prepare a different synthetic account preference while the real app is paused.
    // This tests the browser's REST contract and adoption, not a real server/account.
    expect(await page.evaluate(async (theme) => (await fetch('/api/users/me/preferences', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ theme }),
    })).ok, account)).toBe(true);
    await release();
    await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
    await expectResolved(page, account);
    await expect.poll(() => page.evaluate(() => localStorage.getItem('orbit-theme'))).toBe(account);
    adoption = await page.evaluate(() => window.__foundationThemeMutations);
    await page.goto('/ui-migration/foundation.html');
    const status = page.getByRole('status').filter({ hasText: /^Theme: / });
    await expect(status).toHaveText(`Theme: ${account} / ${account}`);
    await expectResolved(page, account);
    const setupCount = api.requests.length;
    const written = [];
    for (const mode of ['light', 'dark', 'system']) {
      await page.getByRole('button', { name: mode[0].toUpperCase() + mode.slice(1), exact: true }).click();
      written.push(mode);
      await expect.poll(() => api.requests.slice(setupCount)
        .filter((request) => request.method === 'PATCH' && request.path === '/api/users/me/preferences')
        .map((request) => JSON.parse(request.body).theme)).toEqual(written);
      await expect.poll(() => page.evaluate(() => localStorage.getItem('orbit-theme'))).toBe(mode);
      // Explicit modes ignore the OS; system follows both transitions live.
      for (const os of ['light', 'dark']) {
        await page.emulateMedia({ colorScheme: os });
        const resolved = mode === 'system' ? os : mode;
        await expect(status).toHaveText(`Theme: ${mode} / ${resolved}`);
        await expectResolved(page, resolved);
      }
    }
    api.assertHandled();
    expect(pageErrors).toEqual([]);
  } finally {
    await release();
    await attachRecord(testInfo, page, api, pageErrors, { cached, account, adoption, setupPatch: 'synthetic account preparation before app execution' });
  }
});
