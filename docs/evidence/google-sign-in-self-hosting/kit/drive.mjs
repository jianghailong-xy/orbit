// node drive.mjs <step> [<step> ...]
// Walks docs/self-hosting.md "Google sign-in" on the isolated stack (http://localhost:2376) in headless
// Chromium through the real UI, one named step at a time, screenshotting each into shots/ and printing one
// JSON line per step. The administrator's tokens live in admin.json (0600) and are never printed. The Google
// client entered is a placeholder, not a Google credential: Google answers it with invalid_client, which is
// as far as any step can go without the owner's test client.
import { chromium } from '/var/tmp/google-doc-e2e/src/node_modules/playwright/index.mjs';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const S = '/var/tmp/google-doc-e2e';
const ORIGIN = 'http://localhost:2376';
const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const CHROME = '/root/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome';
const PLACEHOLDER_CLIENT_ID = '000000000000-orbit-doc-walkthrough-placeholder.apps.googleusercontent.com';
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

async function newPage(browser, { admin = false, origin = ORIGIN, viewport = { width: 1280, height: 800 } } = {}) {
  const ua = (await browser.newContext().then(async (c) => { const p = await c.newPage(); const u = await p.evaluate(() => navigator.userAgent); await c.close(); return u; }))
    .replace('HeadlessChrome', 'Chrome');
  const context = await browser.newContext({ viewport, deviceScaleFactor: 2, userAgent: ua, locale: 'en-US' });
  const page = await context.newPage();
  page.on('pageerror', (e) => log('pageerror', { message: String(e).slice(0, 300) }));
  if (admin) {
    const auth = JSON.parse(readFileSync(`${S}/admin.json`, 'utf8'));
    await page.goto(`${origin}/login`);
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

async function methods(page, origin = ORIGIN) {
  return page.evaluate(async (o) => (await fetch(`${o}/api/auth/methods`)).json(), origin);
}

/** Admin → Sign-in, reached the way the doc says: the account menu's Admin, then the Sign-in tab. */
async function openSignInSettings(page) {
  await page.goto(`${ORIGIN}/`);
  await page.locator('[aria-label^="Account menu"]').first().click();
  await page.getByRole('menuitem', { name: 'Admin' }).click();
  await page.waitForURL(`${ORIGIN}/admin`);
  await page.getByRole('link', { name: 'Sign-in' }).click();
  await page.waitForURL(`${ORIGIN}/admin/sign-in`);
  await page.getByText('Authorized redirect URI', { exact: true }).waitFor();
}

async function signInSettingsState(page) {
  return {
    badge: (await page.locator('.admin-signin .orbit-card-head').innerText()).replace(/\s+/g, ' ').trim(),
    redirectUri: await page.locator('.admin-signin-redirect code').innerText(),
    switchOn: await page.getByRole('switch', { name: 'Allow signing in with Google' }).getAttribute('aria-checked'),
    clientId: await page.getByLabel('Client ID').inputValue(),
    secretPlaceholder: await page.getByLabel('Client secret').getAttribute('placeholder'),
  };
}

async function saveSettings(page) {
  await page.getByRole('button', { name: 'Save' }).click();
  await page.getByText('Sign-in settings saved').first().waitFor();
}

/**
 * Leave for Google from `startPath` signed out, as a person would: the login page's Continue with Google.
 * Returns the authorization request Orbit sent the browser with, read off the request itself.
 */
async function continueWithGoogle(page, startPath, origin = ORIGIN) {
  let authRequest = null;
  page.on('request', (r) => { if (r.url().startsWith(GOOGLE_AUTH) && !authRequest) authRequest = r.url(); });
  await page.goto(`${origin}${startPath}`);
  await page.getByRole('button', { name: 'Continue with Google' }).waitFor();
  const loginUrl = page.url();
  const stored = () => page.evaluate(() => sessionStorage.getItem('orbit_google_sign_in'));
  await page.getByRole('button', { name: 'Continue with Google' }).click();
  await page.waitForURL((u) => u.hostname === 'accounts.google.com', { timeout: 30000 });
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(2500);
  const q = new URL(authRequest).searchParams;
  return {
    loginUrl,
    googleUrlNow: page.url().split('?')[0],
    googleTitle: await page.title(),
    googleText: (await page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 400),
    authorizationRequest: {
      endpoint: authRequest.split('?')[0],
      response_type: q.get('response_type'),
      client_id: q.get('client_id'),
      redirect_uri: q.get('redirect_uri'),
      scope: q.get('scope'),
      prompt: q.get('prompt'),
      code_challenge_method: q.get('code_challenge_method'),
      state: `<${q.get('state')?.length} chars>`,
      nonce: `<${q.get('nonce')?.length} chars>`,
      code_challenge: `<${q.get('code_challenge')?.length} chars>`,
    },
    state: q.get('state'),
    storedBeforeLeaving: stored,
  };
}

/**
 * Stand in for Google sending the browser back with an authorization code. The code is made up, so this is
 * not a Google sign-in: it exercises what Orbit does with the callback when Google refuses the code.
 */
async function simulateCallback(page, state, callbackOrigin = ORIGIN) {
  await page.goto(`${callbackOrigin}/api/auth/google/callback?state=${encodeURIComponent(state)}&code=made-up-code-doc-walkthrough`);
  await page.waitForURL((u) => u.pathname === '/login' && !u.searchParams.has('google_error'), { timeout: 15000 }).catch(() => {});
  const error = page.locator('.login-error');
  await error.waitFor({ timeout: 15000 });
  return { finalUrl: page.url(), message: await error.innerText() };
}

const steps = {
  async setup(browser) {
    const page = await newPage(browser);
    await page.goto(`${ORIGIN}/`);
    await page.waitForURL(`${ORIGIN}/setup`);
    await page.getByLabel('Email').waitFor();
    const before = await shot(page, '00-setup');
    await page.getByLabel('Name').fill(ADMIN.name);
    await page.getByLabel('Email').fill(ADMIN.email);
    await page.getByLabel('Password', { exact: true }).fill(ADMIN.password);
    await page.getByLabel('Confirm password').fill(ADMIN.password);
    await page.getByRole('button', { name: /create|set up|continue/i }).click();
    await page.waitForURL((u) => u.pathname !== '/setup', { timeout: 15000 });
    const tokens = await page.evaluate(() => ({ accessToken: localStorage.getItem('orbit_token'), refreshToken: localStorage.getItem('orbit_refresh') }));
    writeFileSync(`${S}/admin.json`, JSON.stringify(tokens), { mode: 0o600 });
    log('setup', { landedOn: page.url(), adminTokensSaved: !!tokens.accessToken, shot: before });
  },

  async 'login-before'(browser) {
    const page = await newPage(browser);
    await page.goto(`${ORIGIN}/login`);
    await page.getByRole('button', { name: 'Sign In' }).waitFor();
    await page.waitForTimeout(1500);
    log('login-before', {
      methods: await methods(page),
      continueWithGoogleButtons: await page.getByRole('button', { name: 'Continue with Google' }).count(),
      shot: await shot(page, '01-login-before'),
    });
  },

  async 'signin-empty'(browser) {
    const page = await newPage(browser, { admin: true });
    await openSignInSettings(page);
    log('signin-empty', { state: await signInSettingsState(page), shot: await shot(page, '02-admin-signin-empty') });
  },

  async 'signin-fill'(browser) {
    const page = await newPage(browser, { admin: true });
    await openSignInSettings(page);
    await page.getByLabel('Client ID').fill(PLACEHOLDER_CLIENT_ID);
    await page.getByLabel('Client secret').fill(PLACEHOLDER_SECRET);
    await page.getByRole('switch', { name: 'Allow signing in with Google' }).click();
    const policy = await page.getByRole('radio', { name: /Existing accounts only/ }).getAttribute('aria-checked');
    await saveSettings(page);
    await page.waitForTimeout(600);
    const settings = await page.evaluate(async () => (await fetch('/api/admin/sign-in/google', { headers: { authorization: `Bearer ${localStorage.getItem('orbit_token')}` } })).json());
    log('signin-fill', {
      existingAccountsOnlyChecked: policy,
      state: await signInSettingsState(page),
      adminGetAnswer: settings,
      secretInAnswer: JSON.stringify(settings).includes(PLACEHOLDER_SECRET),
      shot: await shot(page, '03-admin-signin-on'),
    });
  },

  async 'login-google'(browser) {
    const page = await newPage(browser);
    await page.goto(`${ORIGIN}/login`);
    await page.getByRole('button', { name: 'Continue with Google' }).waitFor();
    log('login-google', {
      methods: await methods(page),
      signupHint: await page.locator('.login-signup').count(),
      shot: await shot(page, '04-login-google'),
    });
  },

  async 'policy-open'(browser) {
    const page = await newPage(browser, { admin: true });
    await openSignInSettings(page);
    await page.getByRole('radio', { name: /Anyone with a Google account/ }).click();
    const warning = await page.locator('.admin-signin-warning').innerText();
    const shotName = await shot(page, '05-admin-open-warning');
    await saveSettings(page);
    const signedOut = await newPage(browser);
    await signedOut.goto(`${ORIGIN}/login`);
    await signedOut.locator('.login-signup').waitFor();
    log('policy-open', {
      warning,
      shot: shotName,
      methods: await methods(signedOut),
      loginHint: await signedOut.locator('.login-signup').innerText(),
      loginShot: await shot(signedOut, '06-login-signup-hint'),
    });
  },

  async 'policy-existing'(browser) {
    const page = await newPage(browser, { admin: true });
    await openSignInSettings(page);
    await page.getByRole('radio', { name: /Existing accounts only/ }).click();
    await saveSettings(page);
    log('policy-existing', { methods: await methods(page), state: await signInSettingsState(page) });
  },

  async 'users-google-only'(browser) {
    const page = await newPage(browser, { admin: true });
    await page.goto(`${ORIGIN}/admin`);
    await page.getByRole('button', { name: 'Add user' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add user' });
    await dialog.getByPlaceholder('Email').fill('new.member@gmail.com');
    await dialog.getByPlaceholder('Name (optional)').fill('New Member');
    await dialog.getByText('Google sign-in only').click();
    await page.waitForTimeout(300);
    const note = (await dialog.innerText()).split('\n').filter((l) => /password/i.test(l));
    const dialogShot = await shot(page, '07-add-user-google-only');
    await dialog.getByRole('button', { name: 'Create' }).click();
    await page.getByRole('cell', { name: 'new.member@gmail.com' }).waitFor();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(800);
    const rows = await page.locator('.ant-table-row').evaluateAll((rs) => rs.map((r) => r.innerText.replace(/\s+/g, ' ').trim()));
    log('users-google-only', { dialogNote: note, dialogShot, rows, usersShot: await shot(page, '08-users-badges') });
  },

  async 'google-roundtrip'(browser, startPath = '/login', label = 'login') {
    const page = await newPage(browser);
    const left = await continueWithGoogle(page, startPath);
    const googleShot = await shot(page, `09-google-${label}`);
    const back = await simulateCallback(page, left.state);
    const { state, storedBeforeLeaving, ...rest } = left;
    log('google-roundtrip', { startPath, ...rest, googleShot, callback: back, shot: await shot(page, `10-callback-${label}`) });
  },

  async 'other-address'(browser) {
    const page = await newPage(browser);
    const left = await continueWithGoogle(page, '/login', 'http://127.0.0.1:2376');
    const back = await simulateCallback(page, left.state, ORIGIN);
    log('other-address', {
      startedAt: left.loginUrl,
      redirect_uri: left.authorizationRequest.redirect_uri,
      callback: back,
      shot: await shot(page, '11-other-address'),
    });
  },

  async insecure() {
    const browser = await browserWith(['--host-resolver-rules=MAP orbit-doc.test 127.0.0.1']);
    const page = await newPage(browser);
    await page.goto('http://orbit-doc.test:2376/login');
    await page.getByRole('button', { name: 'Continue with Google' }).waitFor();
    const secure = await page.evaluate(() => window.isSecureContext);
    await page.getByRole('button', { name: 'Continue with Google' }).click();
    const error = page.locator('.login-error');
    await error.waitFor();
    log('insecure', { url: page.url(), isSecureContext: secure, message: await error.innerText(), shot: await shot(page, '12-insecure-context') });
    await browser.close();
  },

  async off(browser) {
    const page = await newPage(browser, { admin: true });
    await openSignInSettings(page);
    await page.getByRole('switch', { name: 'Allow signing in with Google' }).click();
    await saveSettings(page);
    const state = await signInSettingsState(page);
    const signedOut = await newPage(browser);
    await signedOut.goto(`${ORIGIN}/api/auth/google/start?client=web&code_challenge=${'A'.repeat(43)}`);
    const error = signedOut.locator('.login-error');
    await error.waitFor();
    log('off', {
      state,
      methods: await methods(signedOut),
      startLandedOn: signedOut.url(),
      message: await error.innerText(),
      continueWithGoogleButtons: await signedOut.getByRole('button', { name: 'Continue with Google' }).count(),
      shot: await shot(signedOut, '13-off'),
    });
  },

  async 'secret-again'(browser) {
    const page = await newPage(browser, { admin: true });
    await openSignInSettings(page);
    await page.getByLabel('Client secret').fill(PLACEHOLDER_SECRET);
    await saveSettings(page);
    log('secret-again', { state: await signInSettingsState(page) });
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
