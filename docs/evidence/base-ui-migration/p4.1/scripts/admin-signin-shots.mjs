// Admin → Sign-in on a served tree, in the 8 P0 environments: node admin-signin-shots.mjs <baseURL> <ui-migration dir> <out dir>
// P0 fixtures plus a fixed GET /admin/sign-in/google; one full-viewport screenshot per environment.
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
const [baseURL, dir, out] = process.argv.slice(2);
const require = createRequire(join(dir, 'x.js'));
const pw = require('@playwright/test');
const { installFixtures, installFixedDate } = await import(pathToFileURL(join(dir, 'fixtures.mjs')));
const SETTINGS = { enabled: true, clientId: '1234567890-abc.apps.googleusercontent.com', hasSecret: true, signupPolicy: 'EXISTING_ACCOUNTS', redirectUri: 'https://orbit.example.test/api/auth/google/callback' };
for (const browserName of ['chromium', 'webkit']) {
  const browser = await pw[browserName].launch();
  for (const theme of ['light', 'dark']) for (const size of ['desktop', 'phone']) {
    const context = await browser.newContext({ baseURL, colorScheme: theme, reducedMotion: 'reduce', locale: 'en-US', timezoneId: 'UTC', deviceScaleFactor: 1,
      viewport: size === 'phone' ? { width: 390, height: 844 } : { width: 1280, height: 900 }, isMobile: size === 'phone', hasTouch: size === 'phone' });
    const page = await context.newPage();
    await installFixedDate(page);
    await installFixtures(page, { theme });
    await page.route('**/api/admin/sign-in/google', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SETTINGS) }));
    await page.goto('/admin/sign-in');
    await page.getByRole('heading', { name: 'Google sign-in' }).waitFor();
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(400);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const card = await page.locator('.admin-signin').evaluate((el) => { const r = el.getBoundingClientRect(); const head = el.querySelector('.orbit-card-head').getBoundingClientRect(); const title = el.querySelector('.orbit-card-title').getBoundingClientRect(); const body = el.querySelector('.orbit-card-body').getBoundingClientRect(); return { card: [r.x, r.y, r.width, r.height], head: [head.y, head.height], title: [title.y, title.height], body: [body.y, body.height] }; });
    mkdirSync(join(out, `${browserName}-${theme}-${size}`), { recursive: true });
    writeFileSync(join(out, `${browserName}-${theme}-${size}`, 'admin-signin.png'), await page.screenshot({ animations: 'disabled', caret: 'hide' }));
    writeFileSync(join(out, `${browserName}-${theme}-${size}`, 'admin-signin.json'), JSON.stringify(card));
    console.log(browserName, theme, size, JSON.stringify(card));
    await context.close();
  }
  await browser.close();
}
