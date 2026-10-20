// Shared bits for the P7a captures: the real web app (the worktree's src/web + src/shared on vite, see
// run-ns.sh), fed by the repo's own ui-migration fixtures, with the routes a scene needs answered first
// (registered after the fixtures, so they win; anything else falls through to them).
import { chromium } from '/root/.orbit/worktrees/50304226-c921-5ee2-89b9-8ddbb5247705/node_modules/playwright/index.mjs';
import { installFixtures, installFixedDate } from '/root/.orbit/worktrees/50304226-c921-5ee2-89b9-8ddbb5247705/src/web/ui-migration/fixtures.mjs';

export const BASE = process.env.BASE ?? 'http://127.0.0.1:5791';

export async function launch() {
  return chromium.launch({
    executablePath: '/root/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome',
    // The board's own fonts (docs/mocks/cursor-engine was rendered with them), so the two compare.
    env: { ...process.env, FONTCONFIG_FILE: '/var/tmp/cursor-engine-mock/fonts.conf' },
  });
}

/** routes: { 'GET /api/x': body | (req, url) => body | {__status, json} } answered before the fixtures. */
export async function open(browser, { path, theme = 'light', width, height, routes = {}, init } = {}) {
  const context = await browser.newContext({
    viewport: { width: width ?? 1280, height: height ?? 900 },
    deviceScaleFactor: 2, colorScheme: theme,
    locale: 'en-US', timezoneId: 'Asia/Shanghai', reducedMotion: 'reduce', serviceWorkers: 'block',
  });
  const page = await context.newPage();
  page.setDefaultNavigationTimeout(180_000);
  page.setDefaultTimeout(60_000);
  await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'MacIntel' }));
  await installFixedDate(page);
  const api = await installFixtures(page, { theme });
  // After the fixtures' own init script, which clears localStorage.
  if (init) await page.addInitScript(init.fn ?? init, init.arg);
  const posted = [];
  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const key = `${req.method()} ${url.pathname}`;
    if (req.method() !== 'GET') posted.push({ key, body: req.postData() });
    const hit = routes[key];
    if (hit === undefined) return route.fallback();
    const body = typeof hit === 'function' ? await hit(req, url) : hit;
    if (body && body.__status) return route.fulfill({ status: body.__status, json: body.json });
    return route.fulfill({ status: 200, json: body });
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  if (path) {
    await page.goto(BASE + path);
    await page.evaluate(() => document.fonts.ready);
    await settle(page);
  }
  return { context, page, api, errors, posted };
}

export const settle = (page) =>
  page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
