// Real-page shots of a wiki document's diagrams, before (HEAD) and after (the worktree), light and dark, desktop and phone.
//   node capture.mjs <worktree>
// Serves the two static builds on port 0, feeds the ui-migration fixtures plus one document (the shared docs fixture's
// session-runtime) whose sections carry three diagrams as the server stores them, and shoots each section with a diagram.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const tree = process.argv[2];
const K = '/mnt/data/tmp/wiki-diagram-look';
const OUT = `${K}/web/shots`;
const require = createRequire(import.meta.url);
const { chromium } = require('/var/tmp/t1-main-baseline/node_modules/playwright-core');
const { installFixtures, FIXTURE_IDS } = await import(`${tree}/src/web/ui-migration/fixtures.mjs`);
const SHARED = JSON.parse(fs.readFileSync(`${tree}/src/shared/src/wiki-docs.fixture.json`, 'utf8'));
const DIAGRAMS = JSON.parse(fs.readFileSync(`${K}/diagrams.json`, 'utf8'));

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2' };
function serve(dist) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      let file = path.join(dist, p);
      if (!file.startsWith(dist) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(dist, 'index.html');
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}
const builds = { before: await serve(`${K}/web/before`), after: await serve(`${K}/web/after`) };

// The document: three sections with a diagram after their first block — a short left-to-right one (s1), the top-to-bottom
// flow with a group, a decision and labelled links (s3), and the wide architecture picture (s7).
const doc = structuredClone(SHARED.docs.doc.read);
doc.spaceId = FIXTURE_IDS.space;
const put = (key, source) => {
  const section = doc.sections.find((one) => one.key === key);
  section.blocks.splice(1, 0, { kind: 'diagram', text: source, sentences: [] });
};
put('s1', DIAGRAMS.small);
put('s3', DIAGRAMS.flow);
put('s7', DIAGRAMS.architecture);
const directory = { ...structuredClone(SHARED.docs.directory.read), spaceId: FIXTURE_IDS.space };
const index = SHARED.docs.index ? { ...structuredClone(SHARED.docs.index.read ?? SHARED.docs.index), spaceId: FIXTURE_IDS.space } : null;

const browser = await chromium.launch({ env: { ...process.env, FONTCONFIG_FILE: '/var/tmp/kimi-accounts-mock/fonts.conf' } });
const VIEWS = { desktop: { width: 1440, height: 2600, scale: 2 }, phone: { width: 393, height: 3200, scale: 3 } };
const meta = {};
for (const build of Object.keys(builds)) for (const theme of ['light', 'dark']) for (const [view, v] of Object.entries(VIEWS)) {
  const context = await browser.newContext({ viewport: { width: v.width, height: v.height }, deviceScaleFactor: v.scale, colorScheme: theme });
  const page = await context.newPage();
  const fixtures = await installFixtures(page, { theme });
  const json = (body) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  await page.route(`**/api/wiki/spaces/${FIXTURE_IDS.space}/docs`, (route) => route.fulfill(json(directory)));
  await page.route(`**/api/wiki/spaces/${FIXTURE_IDS.space}/docs/session-runtime`, (route) => route.fulfill(json(doc)));
  if (index) await page.route(`**/api/wiki/spaces/${FIXTURE_IDS.space}/doc-index`, (route) => route.fulfill(json(index)));
  await page.goto(`${builds[build].base}/wiki/orbit/d/session-runtime`);
  await page.waitForFunction(() => document.querySelectorAll('figure.wk-dc-diagram svg').length === 3
    && !document.querySelector('figure.wk-dc-diagram[aria-busy="true"]'), null, { timeout: 30_000 });
  await page.waitForTimeout(300);
  for (const key of ['s1', 's3', 's7']) {
    const section = page.locator(`[data-section="${key}"]`);
    const name = `${build}-${theme}-${view}-${key}`;
    await section.screenshot({ path: `${OUT}/${name}.png` });
    meta[name] = await section.locator('figure.wk-dc-diagram > svg').evaluate((svg) => ({ id: svg.id, viewBox: svg.getAttribute('viewBox'),
      figure: Math.round(svg.parentElement.clientWidth), scrolls: svg.parentElement.scrollWidth > svg.parentElement.clientWidth }));
  }
  meta[`${build}-${theme}-${view}-unhandled`] = fixtures.unhandled;
  await context.close();
}
await browser.close();
for (const b of Object.values(builds)) b.server.close();
fs.writeFileSync(`${OUT}/meta.json`, JSON.stringify(meta, null, 1));
console.log(JSON.stringify(meta, null, 1));
