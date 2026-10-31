// The real web app (a tree's src/web + src/shared on vite, see run-ns.sh), fed by the repo's own
// ui-migration fixtures, with the routes a scene needs answered first (registered after the fixtures,
// so they win; anything else falls through to them).
import { chromium } from '/var/tmp/wt-preview-mock/today/node_modules/playwright/index.mjs';
import { installFixtures, installFixedDate } from '/var/tmp/wt-preview-mock/today/src/web/ui-migration/fixtures.mjs';

export const BASE = process.env.BASE ?? 'http://127.0.0.1:5873';
export const K = '/var/tmp/wt-preview-mock';

export async function launch() {
  return chromium.launch({
    executablePath: '/root/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome',
    env: { ...process.env, FONTCONFIG_FILE: `${K}/fonts.conf` },
  });
}

/** routes: { 'GET /api/x': body | (req, url) => body | {__status, json} } answered before the fixtures. */
export async function open(browser, { path, theme = 'light', size = 'desktop', width, height, routes = {}, handler, init } = {}) {
  const phone = size === 'phone';
  const context = await browser.newContext({
    viewport: phone ? { width: 390, height: height ?? 844 } : { width: width ?? 1280, height: height ?? 900 },
    deviceScaleFactor: 2, isMobile: phone, hasTouch: phone, colorScheme: theme,
    locale: 'en-US', timezoneId: 'Asia/Shanghai', reducedMotion: 'reduce', serviceWorkers: 'block',
  });
  const page = await context.newPage();
  page.setDefaultNavigationTimeout(180_000);
  page.setDefaultTimeout(60_000);
  await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'MacIntel' }));
  await installFixedDate(page);
  const api = await installFixtures(page, { theme });
  if (init) await page.addInitScript(init.fn ?? init, init.arg);
  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const key = `${req.method()} ${url.pathname}`;
    if (handler) {
      const out = await handler(req, url);
      if (out !== undefined) {
        if (out && out.__raw) return route.fulfill({ status: 200, body: out.__raw, contentType: out.__type });
        if (out && out.__status) return route.fulfill({ status: out.__status, json: out.json });
        return route.fulfill({ status: 200, json: out });
      }
    }
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
  return { context, page, api, errors };
}

export const settle = (page) =>
  page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
