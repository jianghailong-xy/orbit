// node drive.mjs
// Disables an account and enables it again on the isolated stack (http://localhost:2396), in headless Chromium
// through the real UI: an administrator in Admin → Users, and the account's own browser tab beside it. Each
// step is screenshotted into shots/ and printed as one JSON line; the API answers each credential gets are read
// straight off the apiserver (127.0.0.1:3396). Passwords and tokens are kept in memory, never printed.
// Starts on an empty database (setup.sh db): the first administrator is made through POST /api/auth/bootstrap.
import { chromium } from '/var/tmp/x1-disable-e2e/src/node_modules/playwright/index.mjs';

const S = '/var/tmp/x1-disable-e2e';
const ORIGIN = 'http://localhost:2396';
const API = 'http://127.0.0.1:3396/api';
const CHROME = '/root/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome';
const OWNER = { name: 'Owner', email: 'owner@orbit.test', password: 'owner-password-1' };
const MALLORY = 'mallory@example.com';

const log = (step, data) => console.log(JSON.stringify({ step, ...data }));

async function call(method, path, { bearer, body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json };
}
/** What a refusal says of itself: the status, and the code and message when it has them. Never a token. */
const answer = ({ status, json }) => ({ status, ...(json?.code ? { code: json.code } : {}), ...(status >= 400 && json?.message ? { message: json.message } : {}) });
const must = (reply, status, what) => {
  if (reply.status !== status) throw new Error(`${what}: ${reply.status} ${JSON.stringify(reply.json)}`);
  return reply.json;
};

async function newPage(browser, session) {
  const ua = (await browser.newContext().then(async (c) => { const p = await c.newPage(); const u = await p.evaluate(() => navigator.userAgent); await c.close(); return u; }))
    .replace('HeadlessChrome', 'Chrome');
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, userAgent: ua, locale: 'en-US' });
  const page = await context.newPage();
  page.on('pageerror', (e) => log('pageerror', { message: String(e).slice(0, 300) }));
  if (session) {
    await page.goto(`${ORIGIN}/login`);
    await page.evaluate(([a, r]) => { localStorage.setItem('orbit_token', a); localStorage.setItem('orbit_refresh', r); },
      [session.accessToken, session.refreshToken]);
  }
  return page;
}

const shot = async (page, name) => {
  // Off every row and button, so nothing is shown hovered.
  await page.mouse.move(1270, 790);
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${S}/shots/${name}.png` });
  return `${name}.png`;
};

const rowOf = (page, email) => page.locator('.ant-table-row', { hasText: email });
/** Each account's row as the page shows it: its status, and which of Disable / Enable it offers. */
async function listed(page) {
  const rows = await page.locator('.ant-table-row').all();
  const out = {};
  for (const row of rows) {
    const email = (await row.locator('td').first().innerText()).trim();
    const has = async (label) => (await row.getByRole('button', { name: label, exact: true }).count()) > 0;
    out[email] = {
      status: (await row.locator('.orbit-badge', { hasText: /^(Active|Disabled)$/ }).innerText()).trim(),
      offers: [(await has('Disable')) && 'Disable', (await has('Enable')) && 'Enable'].filter(Boolean),
    };
  }
  return out;
}

async function signInWithPassword(page, email, password) {
  await page.goto(`${ORIGIN}/login`);
  await page.getByPlaceholder('you@example.com').fill(email);
  await page.getByPlaceholder('Enter your password').fill(password);
  await page.locator('button.login-submit').click();
}

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--lang=en-US'],
  env: { ...process.env, FONTCONFIG_FILE: `${S}/fonts.conf` },
});
try {
  // ── The deployment: the first administrator, a second one, two members. Mallory signs in on a laptop and
  //    issues a personal access token for a script.
  const owner = must(await call('POST', '/auth/bootstrap', { body: OWNER }), 201, 'bootstrap');
  const create = async (email, name) =>
    must(await call('POST', '/admin/users', { bearer: owner.accessToken, body: { email, name } }), 201, `create ${email}`);
  const dana = await create('dana@orbit.test', 'Dana');
  must(await call('PATCH', `/admin/users/${dana.id}/role`, { bearer: owner.accessToken, body: { role: 'ADMIN' } }), 200, 'make Dana admin');
  await create('dev@orbit.test', 'Dev');
  const mallory = await create(MALLORY, 'Mallory');
  const laptop = must(await call('POST', '/auth/login', { body: { email: MALLORY, password: mallory.generatedPassword } }), 201, 'Mallory signs in');
  const pat = must(await call('POST', '/access-tokens', { bearer: laptop.accessToken, body: { name: 'nightly script', scopes: ['tasks:read'], expiresInDays: 30 } }), 201, 'PAT').token;
  log('seeded', {
    accounts: ['owner@orbit.test (ADMIN, signed in below)', 'dana@orbit.test (ADMIN)', 'dev@orbit.test', MALLORY],
    malloryHolds: ['a signed-in browser tab', 'a personal access token'],
  });

  // ── Mallory's tab, signed in.
  const tab = await newPage(browser, laptop);
  await tab.goto(`${ORIGIN}/`);
  await tab.waitForLoadState('networkidle');
  log('mallory-signed-in', { url: new URL(tab.url()).pathname, picture: await shot(tab, '01-mallory-signed-in') });

  // ── The administrator opens Admin → Users from the account menu.
  const admin = await newPage(browser, owner);
  await admin.goto(`${ORIGIN}/`);
  await admin.locator('[aria-label^="Account menu"]').first().click();
  await admin.getByRole('menuitem', { name: 'Admin' }).click();
  await admin.waitForURL(`${ORIGIN}/admin`);
  await rowOf(admin, MALLORY).waitFor();
  log('users', { rows: await listed(admin), picture: await shot(admin, '02-users') });

  // ── Disable: asked first.
  await rowOf(admin, MALLORY).getByRole('button', { name: 'Disable', exact: true }).click();
  const dialog = admin.locator('.orbit-confirm[data-open]');
  await dialog.waitFor();
  log('disable-asked', {
    title: (await dialog.locator('.orbit-overlay-title').innerText()).trim(),
    says: (await dialog.locator('.orbit-overlay-description').innerText().catch(() => dialog.innerText())).replace(/\s+/g, ' ').trim(),
    picture: await shot(admin, '03-disable-confirm'),
  });
  await dialog.getByRole('button', { name: 'Disable', exact: true }).click();
  await admin.getByText('Account disabled').first().waitFor();
  await rowOf(admin, MALLORY).getByRole('button', { name: 'Enable', exact: true }).waitFor();
  log('disabled', { rows: await listed(admin), picture: await shot(admin, '04-disabled') });

  // ── What each of Mallory's credentials is answered now.
  log('disabled-credentials', {
    accessToken: answer(await call('GET', '/users/me', { bearer: laptop.accessToken })),
    refresh: answer(await call('POST', '/auth/refresh', { body: { refreshToken: laptop.refreshToken } })),
    personalAccessToken: answer(await call('GET', '/pat/self', { bearer: pat })),
    passwordLogin: answer(await call('POST', '/auth/login', { body: { email: MALLORY, password: mallory.generatedPassword } })),
  });

  // ── Mallory's tab: the next request is a 401, the refresh a 403, and the tab is back at the login page.
  await tab.reload();
  await tab.waitForURL(`${ORIGIN}/login`, { timeout: 30_000 });
  log('mallory-signed-out', {
    url: new URL(tab.url()).pathname,
    session: await tab.evaluate(() => ({ access: !!localStorage.getItem('orbit_token'), refresh: !!localStorage.getItem('orbit_refresh') })),
    picture: await shot(tab, '05-mallory-signed-out'),
  });
  await signInWithPassword(tab, MALLORY, mallory.generatedPassword);
  await tab.locator('.login-error').waitFor();
  log('mallory-login-refused', {
    says: (await tab.locator('.login-error').innerText()).trim(),
    picture: await shot(tab, '06-login-disabled'),
  });

  // ── Enable: at once, nothing asked.
  await rowOf(admin, MALLORY).getByRole('button', { name: 'Enable', exact: true }).click();
  await admin.getByText('Account enabled').first().waitFor();
  await rowOf(admin, MALLORY).getByRole('button', { name: 'Disable', exact: true }).waitFor();
  log('enabled', { rows: await listed(admin), picture: await shot(admin, '07-enabled') });
  log('enabled-credentials', {
    personalAccessToken: answer(await call('GET', '/pat/self', { bearer: pat })),
    refreshRevokedByTheDisable: answer(await call('POST', '/auth/refresh', { body: { refreshToken: laptop.refreshToken } })),
  });

  // ── Mallory signs in again.
  await signInWithPassword(tab, MALLORY, mallory.generatedPassword);
  await tab.waitForURL((url) => url.pathname !== '/login', { timeout: 30_000 });
  await tab.waitForLoadState('networkidle');
  log('mallory-back', { url: new URL(tab.url()).pathname, picture: await shot(tab, '08-mallory-signed-in-again') });
} finally {
  await browser.close();
}
