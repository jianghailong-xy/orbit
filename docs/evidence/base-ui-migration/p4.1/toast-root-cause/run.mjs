// node run.mjs <baseURL> <ui-migration dir of that tree> <probe> [light|dark]
// The P0 WebKit phone context and P0 fixtures (fixtures.mjs of the tree under test); prints the probe's JSON.
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const [baseURL, dir, probe, theme = 'light'] = process.argv.slice(2);
const require = createRequire(join(dir, 'x.js'));
const { webkit } = require('@playwright/test');
const { installFixtures, installFixedDate } = await import(pathToFileURL(join(dir, 'fixtures.mjs')));
const probes = await import(pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), 'probes.mjs')));
const browser = await webkit.launch();
const context = await browser.newContext({ baseURL, colorScheme: theme, reducedMotion: 'reduce', locale: 'en-US', timezoneId: 'UTC', deviceScaleFactor: 1,
  viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const page = await context.newPage();
await installFixedDate(page);
await installFixtures(page, { theme });
console.log(JSON.stringify(await probes[probe]({ page }), null, 1));
await browser.close();
