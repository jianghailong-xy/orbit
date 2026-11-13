const K = '/mnt/data/tmp/pdf-mock';
const T = '/root/.orbit/worktrees/67abea98-cec7-5593-80f0-8a0ef57346a7';
const { chromium } = await import(`${T}/node_modules/playwright/index.mjs`);
const { installFixtures, installFixedDate, PATHS } = await import(`${T}/src/web/ui-migration/fixtures.mjs`);
const D = await import(`${K}/data.mjs`);
const BASE = 'http://127.0.0.1:5941';
const browser = await chromium.launch({ env: { ...process.env, FONTCONFIG_FILE: `${K}/fonts.conf` } });
export async function open({ width = 1440, height = 2600, projectOver = {}, phone = false, wait } = {}) {
  const context = await browser.newContext({ viewport: phone ? { width: 390, height: 844 } : { width, height }, deviceScaleFactor: 2,
    colorScheme: 'light', locale: 'en-US', timezoneId: 'Asia/Shanghai', reducedMotion: 'reduce', serviceWorkers: 'block' });
  const page = await context.newPage();
  page.setDefaultTimeout(180_000); page.setDefaultNavigationTimeout(240_000);
  await installFixedDate(page);
  const fx = await installFixtures(page, {});
  const p = D.project(projectOver);
  await page.route('**/api/**', async (route) => {
    const req = route.request(); const path = new URL(req.url()).pathname;
    if (req.method() !== 'GET') return route.fallback();
    if (path === `/api/projects/${D.PID}`) return route.fulfill({ json: p });
    if (path === '/api/projects/sidebar') return route.fulfill({ json: [p] });
    if (path === '/api/projects') return route.fulfill({ json: [p] });
    if (path === `/api/projects/${D.PID}/integration`) return route.fulfill({ json: D.integration });
    return route.fallback();
  });
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(BASE + PATHS.project);
  await page.locator('.acceptance-card').first().waitFor({ timeout: 200000 });
  await page.evaluate(() => document.fonts.ready); await page.waitForTimeout(800);
  return { context, page, errors, fx };
}
const scene = process.argv[2] ?? 'probe';
const mod = await import(`${K}/scenes.mjs`);
await mod[scene]({ open, K });
await browser.close();
