// Ad-hoc probe of a served tree: node probe.mjs <baseURL> <ui-migration dir> <scenario> [light|dark] [desktop|phone] [chromium|webkit]
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const [baseURL, dir, scenario, theme = 'light', size = 'desktop', browserName = 'chromium'] = process.argv.slice(2);
const require = createRequire(join(dir, 'x.js'));
const pw = require('@playwright/test');
const { installFixtures, installFixedDate } = await import(pathToFileURL(join(dir, 'fixtures.mjs')));
const p41 = await import(pathToFileURL(join(dir, 'p41-fixtures.mjs')));
const scenarios = await import(pathToFileURL('/var/tmp/p4.1-293463/scripts/probe-scenarios.mjs'));
const browser = await pw[browserName].launch();
const context = await browser.newContext({ baseURL, colorScheme: theme, reducedMotion: 'reduce', locale: 'en-US', timezoneId: 'UTC', deviceScaleFactor: 1,
  viewport: size === 'phone' ? { width: 390, height: 844 } : { width: 1280, height: 900 }, isMobile: size === 'phone' && (browserName === 'chromium' || !!process.env.MOBILE_ALL), hasTouch: size === 'phone' });
const page = await context.newPage();
await installFixedDate(page);
const api = await installFixtures(page, { theme });
const fx = process.env.P0_ONLY ? null : await p41.installP41Fixtures(page, { theme, signedOut: scenario.startsWith('signedout') });
const out = await scenarios[scenario.replace(/^signedout-/, '')]({ page, fx, p41, theme, size, browserName });
console.log(JSON.stringify(out, null, 1));
if (api.unhandled.length) console.error('UNHANDLED', api.unhandled);
await browser.close();
