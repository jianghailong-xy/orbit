// Screenshots and checks of /privacy and the login page's Privacy link, in real browsers against the built
// bundle that run.sh serves. Each scene opens a fresh context (no cookie, no stored session unless the
// scene signs in) and records where the address bar ends, every request the page made, and — on the
// policy — its blocks against the text the web test holds (App.privacy.test.tsx, the task's own words).
//
//   node shoot.mjs <base url> <out dir> <path of App.privacy.test.tsx>
import { chromium, webkit } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [BASE, OUT, TEST] = process.argv.slice(2);
const POLICY = /const POLICY = `([^`]*)`;/.exec(readFileSync(TEST, 'utf8'))[1];
const LINES = POLICY.split('\n').filter((line) => line !== '');

const SCENES = [
  { name: '01-privacy-signed-out', path: '/privacy', engine: 'chromium', width: 1280, height: 800, full: true },
  { name: '02-privacy-signed-out-phone', path: '/privacy', engine: 'webkit', width: 393, height: 852, phone: true, full: true },
  { name: '03-privacy-signed-out-dark', path: '/privacy', engine: 'chromium', width: 1280, height: 800, dark: true, full: true },
  // Signed in: the theme reads the account (answered here), as on every page.
  { name: 'privacy-signed-in', path: '/privacy', engine: 'chromium', width: 1280, height: 800, token: 'alive', shot: false },
  // A stored session that died: the account read and the refresh answer 401.
  { name: 'privacy-dead-session', path: '/privacy', engine: 'chromium', width: 1280, height: 800, token: 'dead', shot: false },
  // As orbitd.io draws it once Google is switched on: /api/auth/methods answered here, nginx has no apiserver.
  { name: '04-login-privacy-link', path: '/login', engine: 'chromium', width: 1280, height: 800, google: true, follow: true },
  // As it draws without Google (/api/auth/methods is nginx's 502): the password alone.
  { name: '05-login-privacy-link-phone', path: '/login', engine: 'webkit', width: 393, height: 852, phone: true, follow: true },
];

/** The policy as drawn: each of the article's blocks, a bullet as `- ` and its text. */
const readBlocks = () =>
  [...(document.querySelector('article')?.children ?? [])].flatMap((block) =>
    block.tagName === 'UL' ? [...block.children].map((item) => `- ${item.textContent}`) : [block.textContent ?? ''],
  );

async function policyState(page) {
  const blocks = await page.evaluate(readBlocks);
  return {
    address: new URL(page.url()).pathname + new URL(page.url()).search,
    title: await page.title(),
    h1: await page.locator('h1').first().textContent(),
    loginForm: (await page.locator('input[type="password"]').count()) > 0,
    blocks: blocks.length,
    textMatchesTask: JSON.stringify(blocks) === JSON.stringify(LINES),
    mailto: await page.$$eval('article a', (links) => links.map((a) => a.getAttribute('href'))),
  };
}

const browsers = { chromium: await chromium.launch(), webkit: await webkit.launch() };
const report = { base: BASE, expectedLines: LINES.length, scenes: [] };
let failed = false;

for (const scene of SCENES) {
  const context = await browsers[scene.engine].newContext({
    viewport: { width: scene.width, height: scene.height },
    deviceScaleFactor: 2,
    colorScheme: scene.dark ? 'dark' : 'light',
    isMobile: scene.engine === 'chromium' && !!scene.phone,
    hasTouch: !!scene.phone,
  });
  if (scene.token) {
    // Once, before the first load: the policy's own page load must not put the session back.
    await context.addInitScript(() => {
      if (sessionStorage.getItem('seeded')) return;
      sessionStorage.setItem('seeded', '1');
      localStorage.setItem('orbit_token', 'access-token');
      localStorage.setItem('orbit_refresh', 'refresh-token');
    });
  }
  const page = await context.newPage();
  const requests = [];
  page.on('request', (request) => requests.push(`${request.method()} ${new URL(request.url()).pathname}`));
  if (scene.token === 'alive') {
    await page.route('**/api/users/me', (route) =>
      route.fulfill({ json: { id: 'u1', email: 'ada@example.com', name: 'Ada', createdAt: '', preferences: {} } }),
    );
  }
  if (scene.token === 'dead') {
    await page.route(/\/api\/(users\/me|auth\/refresh)$/, (route) =>
      route.fulfill({ status: 401, json: { statusCode: 401, message: 'Unauthorized' } }),
    );
  }
  if (scene.google) {
    await page.route('**/api/auth/methods', (route) =>
      route.fulfill({ json: { password: true, google: true, googleSignup: false } }),
    );
  }
  const response = await page.goto(BASE + scene.path, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800); // past the splash's fade
  const record = {
    scene: scene.name,
    engine: scene.engine,
    viewport: `${scene.width}x${scene.height}`,
    storedSession: scene.token ?? 'none',
    document: { status: response.status(), cacheControl: response.headers()['cache-control'] },
  };

  if (scene.path === '/privacy') {
    Object.assign(record, await policyState(page));
    record.apiRequests = requests.filter((line) => line.split(' ')[1].startsWith('/api/'));
    // Signed out, nothing; signed in, only the theme's read of the account (and the refresh a dead one tries).
    const allowed = scene.token ? ['/api/users/me', '/api/auth/refresh'] : [];
    const unexpected = record.apiRequests.filter((line) => !allowed.includes(line.split(' ')[1]));
    record.storedSessionAfter = await page.evaluate(() => localStorage.getItem('orbit_token') !== null);
    failed ||=
      record.address !== '/privacy' ||
      !record.textMatchesTask ||
      record.loginForm ||
      unexpected.length > 0 ||
      record.storedSessionAfter !== (scene.token === 'alive');
  } else {
    const link = page.getByRole('link', { name: 'Privacy', exact: true });
    const box = await link.boundingBox();
    const form = await page.locator('form.login-form').boundingBox();
    record.link = {
      href: await link.getAttribute('href'),
      inFooter: await link.evaluate((a) => !!a.closest('footer')),
      // Inside the first screen, at its foot: the gap under it to the window's bottom edge.
      visible: await link.isVisible(),
      bottomGap: Math.round(scene.height - (box.y + box.height)),
    };
    // The form keeps the middle: its centre's distance from the window's.
    record.formCentreOffset = Math.round(form.y + form.height / 2 - scene.height / 2);
    record.googleButton = (await page.getByRole('button', { name: 'Continue with Google' }).count()) > 0;
    failed ||= record.link.href !== '/privacy' || !record.link.visible || record.link.bottomGap < 0;
  }

  if (scene.shot !== false) {
    if (scene.full) {
      // The page owns its scroll, so the window grows to the policy's height to hold all of it.
      const height = await page.evaluate(() => document.querySelector('.privacy-page').scrollHeight);
      await page.setViewportSize({ width: scene.width, height });
      await page.waitForTimeout(200);
    }
    await page.screenshot({ path: join(OUT, `${scene.name}.png`) });
    record.screenshot = `${scene.name}.png`;
  }

  if (scene.follow) {
    await page.getByRole('link', { name: 'Privacy', exact: true }).click();
    await page.waitForURL('**/privacy');
    await page.waitForLoadState('networkidle');
    record.followed = await policyState(page);
    failed ||= record.followed.address !== '/privacy' || !record.followed.textMatchesTask;
  }

  record.requests = requests;
  report.scenes.push(record);
  console.log(JSON.stringify(record));
  await context.close();
}

await Promise.all(Object.values(browsers).map((browser) => browser.close()));
writeFileSync(join(OUT, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(failed ? 'FAILED' : 'ALL CHECKS PASSED');
process.exit(failed ? 1 : 0);
