// node drive.mjs <step> [<step> ...]
// Walks the two admin-area hints of task 34bfJcxctbgThKlyWePPi on the isolated stack
// (http://localhost:2386) in headless Chromium through the real UI, one named step at a time,
// screenshotting each into shots/ and printing one JSON line per step. The administrator's tokens live
// in admin.json (0600) and are never printed. The Google client entered is a placeholder, not a Google
// credential: nothing here signs in with Google — the walkthrough is about what the admin area says,
// with and without a PROVIDER_SECRET_KEY that can read what is saved.
import { chromium } from '/var/tmp/google-sign-in-admin-hints/src/node_modules/playwright/index.mjs';
import { readFileSync, writeFileSync } from 'node:fs';

const S = '/var/tmp/google-sign-in-admin-hints';
const ORIGIN = 'http://localhost:2386';
const CHROME = '/root/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome';
const PLACEHOLDER_CLIENT_ID = '000000000000-orbit-admin-hints-placeholder.apps.googleusercontent.com';
const PLACEHOLDER_SECRET = 'placeholder-not-a-google-secret';
const ADMIN = { name: 'Owner', email: 'owner@orbit.test', password: 'owner-password-1' };

const log = (step, data) => console.log(JSON.stringify({ step, ...data }));

async function browserWith(args = []) {
  return chromium.launch({
    executablePath: CHROME,
    args: ['--lang=en-US', ...args],
    env: { ...process.env, FONTCONFIG_FILE: `${S}/fonts.conf` },
  });
}

async function newPage(browser, { admin = false, viewport = { width: 1280, height: 1000 } } = {}) {
  const ua = (await browser.newContext().then(async (c) => { const p = await c.newPage(); const u = await p.evaluate(() => navigator.userAgent); await c.close(); return u; }))
    .replace('HeadlessChrome', 'Chrome');
  const context = await browser.newContext({ viewport, deviceScaleFactor: 2, userAgent: ua, locale: 'en-US' });
  const page = await context.newPage();
  page.on('pageerror', (e) => log('pageerror', { message: String(e).slice(0, 300) }));
  if (admin) {
    const auth = JSON.parse(readFileSync(`${S}/admin.json`, 'utf8'));
    await page.goto(`${ORIGIN}/login`);
    await page.evaluate(([a, r]) => { localStorage.setItem('orbit_token', a); localStorage.setItem('orbit_refresh', r); },
      [auth.accessToken, auth.refreshToken]);
  }
  return page;
}

const shot = async (page, name, opts = {}) => {
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${S}/shots/${name}.png`, ...opts });
  return `${name}.png`;
};

/** Admin → Sign-in, reached the way a person does: the account menu's Admin, then the Sign-in tab. */
async function openSignInSettings(page) {
  await page.goto(`${ORIGIN}/`);
  await page.locator('[aria-label^="Account menu"]').first().click();
  await page.getByRole('menuitem', { name: 'Admin' }).click();
  await page.waitForURL(`${ORIGIN}/admin`);
  await page.getByRole('link', { name: 'Sign-in' }).click();
  await page.waitForURL(`${ORIGIN}/admin/sign-in`);
  await page.getByText('Authorized redirect URI', { exact: true }).waitFor();
}

/** The secret field's own hint line, the one that used to promise a saved secret would be kept. */
async function secretHint(page) {
  return page.locator('.admin-signin-field', { has: page.getByLabel('Client secret') }).locator('.admin-signin-hint').innerText();
}

async function signInSettingsState(page) {
  const warnings = page.locator('.admin-signin-warning');
  return {
    badge: (await page.locator('.admin-signin .orbit-card-head').innerText()).replace(/\s+/g, ' ').trim(),
    switchOn: await page.getByRole('switch', { name: 'Allow signing in with Google' }).getAttribute('aria-checked'),
    clientId: await page.getByLabel('Client ID').inputValue(),
    secretPlaceholder: await page.getByLabel('Client secret').getAttribute('placeholder'),
    secretHint: await secretHint(page),
    warnings: await warnings.count() === 0 ? [] : (await warnings.allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim()),
    redirectUri: await page.locator('.admin-signin-redirect code').innerText(),
  };
}

/** What GET /admin/sign-in/google answers right now, read from the page's own session. */
async function adminGet(page) {
  return page.evaluate(async () => (await fetch('/api/admin/sign-in/google', {
    headers: { authorization: `Bearer ${localStorage.getItem('orbit_token')}` },
  })).json());
}

async function saveSettings(page) {
  await page.getByRole('button', { name: 'Save' }).click();
  await page.getByText('Sign-in settings saved').first().waitFor();
}

const steps = {
  /** The fresh database's first visit: the administrator the rest of the walkthrough signs in as. */
  async setup(browser) {
    const page = await newPage(browser);
    await page.goto(`${ORIGIN}/`);
    await page.waitForURL(`${ORIGIN}/setup`);
    await page.getByLabel('Email').waitFor();
    await page.getByLabel('Name').fill(ADMIN.name);
    await page.getByLabel('Email').fill(ADMIN.email);
    await page.getByLabel('Password', { exact: true }).fill(ADMIN.password);
    await page.getByLabel('Confirm password').fill(ADMIN.password);
    await page.getByRole('button', { name: /create|set up|continue/i }).click();
    await page.waitForURL((u) => u.pathname !== '/setup', { timeout: 15000 });
    const tokens = await page.evaluate(() => ({ accessToken: localStorage.getItem('orbit_token'), refreshToken: localStorage.getItem('orbit_refresh') }));
    writeFileSync(`${S}/admin.json`, JSON.stringify(tokens), { mode: 0o600 });
    log('setup', { landedOn: page.url(), adminTokensSaved: !!tokens.accessToken });
  },

  /** A client saved and switched on: the answer the page reads, and what it draws with a readable key. */
  async 'signin-readable'(browser) {
    const page = await newPage(browser, { admin: true });
    await openSignInSettings(page);
    const before = await adminGet(page);
    await page.getByLabel('Client ID').fill(PLACEHOLDER_CLIENT_ID);
    await page.getByLabel('Client secret').fill(PLACEHOLDER_SECRET);
    await page.getByRole('switch', { name: 'Allow signing in with Google' }).click();
    await saveSettings(page);
    await page.waitForTimeout(600);
    const answer = await adminGet(page);
    log('signin-readable', {
      beforeSaving: before,
      adminGetAnswer: answer,
      secretInAnswer: JSON.stringify(answer).includes(PLACEHOLDER_SECRET),
      state: await signInSettingsState(page),
      shot: await shot(page, '00-signin-secret-readable'),
    });
  },

  /** Add user → Google sign-in only: the limit the dialog states where it is chosen. */
  async 'add-user-hint'(browser) {
    const page = await newPage(browser, { admin: true });
    await page.goto(`${ORIGIN}/admin`);
    await page.getByRole('button', { name: 'Add user' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add user' });
    await dialog.getByPlaceholder('Email').fill('new.member@gmail.com');
    await dialog.getByPlaceholder('Name (optional)').fill('New Member');
    await dialog.getByText('Google sign-in only').click();
    await page.waitForTimeout(300);
    const note = (await dialog.innerText()).split('\n').filter((l) => /password/i.test(l)).join(' ').replace(/\s+/g, ' ').trim();
    log('add-user-hint', { dialogNote: note, shot: await shot(page, '01-add-user-google-only') });
  },

  /** After the apiserver restarted with a new PROVIDER_SECRET_KEY: the same page, the same row. */
  async 'signin-unreadable'(browser) {
    const page = await newPage(browser, { admin: true });
    await openSignInSettings(page);
    const answer = await adminGet(page);
    log('signin-unreadable', {
      adminGetAnswer: answer,
      secretInAnswer: JSON.stringify(answer).includes(PLACEHOLDER_SECRET),
      state: await signInSettingsState(page),
      shot: await shot(page, '02-signin-secret-unreadable'),
    });
  },

  /** The fix the warning asks for: the secret entered again, and the page back to On. */
  async 'signin-secret-again'(browser) {
    const page = await newPage(browser, { admin: true });
    await openSignInSettings(page);
    await page.getByLabel('Client secret').fill(PLACEHOLDER_SECRET);
    await saveSettings(page);
    await page.waitForTimeout(600);
    const answer = await adminGet(page);
    log('signin-secret-again', {
      adminGetAnswer: answer,
      secretInAnswer: JSON.stringify(answer).includes(PLACEHOLDER_SECRET),
      state: await signInSettingsState(page),
      shot: await shot(page, '03-signin-secret-readable-again'),
    });
  },
};

const [, , ...requested] = process.argv;
const browser = await browserWith();
try {
  for (const spec of requested) {
    const [name, ...args] = spec.split(',');
    if (!steps[name]) throw new Error(`no step ${name}`);
    await steps[name](browser, ...args);
  }
} catch (e) {
  log('error', { message: String(e?.stack || e).slice(0, 1500) });
  process.exitCode = 1;
} finally {
  await browser.close();
}
