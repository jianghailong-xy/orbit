import { test, expect } from './harness.mjs';
import {
  ADMIN_USER, BOOTSTRAP_ERROR, ISSUED_TOKEN, LOGIN_ERROR, P41_PATHS, PASSWORD, TOKENS, TOKENS_ERROR, UPLOAD_PNG,
  installP41Fixtures, stubLanding,
} from './p41-fixtures.mjs';

// P4.1 states the P0 matrix does not reach: first-run setup and sign-in with their field checks,
// the profile's password form (each check, the linked confirmation, the reset after a change), its
// photo and sign-in methods, every Settings control, Settings → Access tokens with its dialog and
// revoke question, the browser half of `orbit login`, and an administrator's view of a user's tokens.
// Locators are roles, accessible names, labels and the pages' own classes, so the same file drives the
// replaced controls (same-commit reference tree) and the Orbit ones; a card's or a table's painted box
// is named by both class names. Screenshots, computed styles and each step's observation (`trace`:
// address, focus, open dialogs, fields marked invalid with what describes them, alerts, notifications
// and the requests a press sends) are compared between the two runs.

const CARD = '.ant-card, .orbit-card';
const DIALOG_SURFACE = '.ant-modal-container, .orbit-overlay';
const TABLE = '.ant-table, .access-token-table';
const SELECT_OPTION = '[role="option"], .ant-select-item-option';
// A select's painted box: the replaced one's combobox is a transparent input inside it.
const SELECT = '.ant-select, .orbit-select';

const frames = (page) => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const card = (page, title) => page.locator(CARD).filter({ has: page.getByText(title, { exact: true }) }).first();
// A replaced button's icon names itself ("copy Copy"), and its loading icon can stay in the name
// after loading ("loading Approve"); Orbit buttons hide both from the name.
const named = (name) => new RegExp(`^(?:loading |[a-z]+(?:-[a-z]+)* )?${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
const button = (scope, name) => scope.getByRole('button', { name: named(name) });
// The anchored revoke question: role=tooltip on the replaced popover, role=dialog on the Orbit one.
const question = (page, title) => page.locator('[role="tooltip"], [role="dialog"]').filter({ has: page.getByText(title, { exact: true }) }).last();
const field = (scope, label) => scope.getByLabel(label, { exact: true });

async function observe(page, fixtures, step) {
  const state = await page.evaluate(() => {
    const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
    const text = (ids) => (ids ?? '').split(/\s+/).filter(Boolean).map((id) => document.getElementById(id)?.textContent?.trim() ?? '').filter(Boolean).join(' | ');
    const name = (el) => el && (el.getAttribute('aria-label') || text(el.getAttribute('aria-labelledby')) || el.labels?.[0]?.textContent?.trim()
      || el.getAttribute('placeholder') || el.textContent?.trim().replace(/\s+/g, ' ').slice(0, 80) || el.tagName.toLowerCase());
    const active = document.activeElement;
    const notifications = document.querySelector('[role="region"][aria-label="Notifications"]');
    return {
      url: location.pathname + location.search,
      focus: active && active !== document.body ? { role: active.getAttribute('role') ?? active.tagName.toLowerCase(), name: name(active) } : 'body',
      dialogs: [...document.querySelectorAll('[role="dialog"],[role="alertdialog"]')].filter(visible).map(name),
      invalid: [...document.querySelectorAll('[aria-invalid="true"]')].filter(visible).map((el) => ({ name: name(el), describedBy: text(el.getAttribute('aria-describedby')) })),
      alerts: [...document.querySelectorAll('[role="alert"]')].filter(visible).map((el) => el.textContent.trim().replace(/\s+/g, ' ')).filter(Boolean),
      notifications: notifications ? notifications.innerText.trim().replace(/\s+/g, ' ') : '',
    };
  });
  return { step, ...state, requests: fixtures.requests.splice(0).map(({ method, path, body }) => ({ method, path, body })) };
}

/** Type into a field the way a person does: focus, select what is there, type. */
async function fill(locator, value) {
  await locator.click();
  await locator.press('ControlOrMeta+a');
  if (value) await locator.pressSequentially(value);
  else await locator.press('Backspace');
}

// The setup and approval cards are fixed-width (440px, 500px), wider than a phone: Chromium's mobile
// layout viewport grows to fit them, so the harness's viewport check cannot hold there and only the
// screenshot is taken.
const wideCard = (testInfo) => testInfo.project.use.isMobile && testInfo.project.use.browserName === 'chromium';
function captureOf(evidence, testInfo) {
  if (!wideCard(testInfo)) return evidence.capture;
  return async (name) => {
    await evidence.page.evaluate(() => document.fonts.ready);
    await frames(evidence.page);
    await expect(evidence.page).toHaveScreenshot(`${name}.png`);
  };
}

// There the zoomed-out page also misplaces pointer clicks, so a button is pressed from the keyboard.
const pressOf = (testInfo) => (wideCard(testInfo)
  ? async (locator) => { await locator.focus(); await locator.press('Enter'); }
  : (locator) => locator.click());

function attachTrace(testInfo, trace) {
  return testInfo.attach('trace', { body: JSON.stringify(trace, null, 2), contentType: 'application/json' });
}

test.describe('P4.1 sign-in and first-run setup', () => {
  test('setup: checks, linked confirmation, submit and refusal', async ({ evidence }, testInfo) => {
    const { page } = evidence;
    const capture = captureOf(evidence, testInfo);
    const fixtures = await installP41Fixtures(page, { theme: testInfo.project.use.colorScheme, signedOut: true });
    fixtures.state.setupNeeded = true;
    await stubLanding(page, '/runners/register');
    const trace = [];
    await page.goto(P41_PATHS.setup);
    const setup = card(page, '🛰 Orbit · First-run setup');
    const submit = button(page, 'Create account & sign in');
    await expect(submit).toBeVisible();
    trace.push(await observe(page, fixtures, 'open'));
    await capture('p41-setup', { card: setup, email: field(page, 'Email'), password: field(page, 'Password'), submit });

    await submit.click();
    await expect(field(page, 'Confirm password')).toHaveAttribute('aria-invalid', 'true');
    await frames(page);
    trace.push(await observe(page, fixtures, 'submit empty'));
    await capture('p41-setup-required', { card: setup, email: field(page, 'Email') });

    await fill(field(page, 'Email'), 'not-an-email');
    await fill(field(page, 'Password'), 'abc');
    await fill(field(page, 'Confirm password'), 'abd');
    await frames(page);
    trace.push(await observe(page, fixtures, 'invalid email, short password, confirmation differs'));
    await capture('p41-setup-invalid', { card: setup, password: field(page, 'Password') });

    await fill(field(page, 'Email'), 'owner@example.test');
    await fill(field(page, 'Password'), PASSWORD);
    await frames(page);
    trace.push(await observe(page, fixtures, 'password fixed, confirmation still differs'));
    await fill(field(page, 'Confirm password'), PASSWORD);
    // Every check passes: the messages leave (a short fade on the replaced form).
    await expect(setup.getByText(/do not match|at least 6|not a valid/)).toHaveCount(0);
    await frames(page);
    trace.push(await observe(page, fixtures, 'confirmation matches'));
    await capture('p41-setup-valid', { card: setup, confirm: field(page, 'Confirm password') });

    // The confirmation follows the password it confirms.
    await fill(field(page, 'Password'), `${PASSWORD}!`);
    await frames(page);
    trace.push(await observe(page, fixtures, 'password changed after the confirmation'));
    await fill(field(page, 'Password'), PASSWORD);
    await frames(page);
    trace.push(await observe(page, fixtures, 'password changed back'));

    // Showing the password is a toggle beside it, reachable from the keyboard.
    await field(page, 'Password').focus();
    await page.keyboard.press('Tab');
    trace.push(await observe(page, fixtures, 'tab from the password'));
    await page.keyboard.press('Enter');
    await frames(page);
    trace.push({ ...(await observe(page, fixtures, 'toggle shown')), passwordType: await field(page, 'Password').getAttribute('type') });
    await page.keyboard.press('Enter');
    trace.push({ ...(await observe(page, fixtures, 'toggle hidden')), passwordType: await field(page, 'Password').getAttribute('type') });

    await fill(field(page, 'Name'), 'First Admin');
    await submit.click();
    await page.waitForURL('**/runners/register');
    await expect(page.locator('#landed')).toBeVisible();
    trace.push(await observe(page, fixtures, 'created and sent to the runner guide'));

    // A refusal says why and keeps the form; Enter in the last field submits.
    fixtures.state.bootstrapError = true;
    await page.goto(P41_PATHS.setup);
    await expect(submit).toBeVisible();
    await fill(field(page, 'Email'), 'owner@example.test');
    await fill(field(page, 'Password'), PASSWORD);
    await fill(field(page, 'Confirm password'), PASSWORD);
    await field(page, 'Confirm password').press('Enter');
    const notifications = page.getByRole('region', { name: 'Notifications', exact: true });
    await expect(notifications.getByText(BOOTSTRAP_ERROR, { exact: true })).toBeVisible();
    trace.push(await observe(page, fixtures, 'refused by the server'));
    await attachTrace(testInfo, trace);
  });

  test('login: a signed-out link, a wrong password, then where it was going', async ({ evidence }, testInfo) => {
    const { page, capture } = evidence;
    const fixtures = await installP41Fixtures(page, { theme: testInfo.project.use.colorScheme, signedOut: true });
    const trace = [];
    await page.goto(P41_PATHS.cli);
    await page.waitForURL(/\/login\?next=/);
    const signIn = button(page, 'Sign In');
    await expect(signIn).toBeVisible();
    trace.push(await observe(page, fixtures, 'sent to sign in'));
    // Sign In stays dimmed (opacity .38) until both fields are filled.
    await capture('p41-login', { email: field(page, 'Email') });
    await fill(field(page, 'Email'), 'reviewer@example.test');
    await fill(field(page, 'Password'), 'wrong password');
    await signIn.click();
    await expect(page.getByText(LOGIN_ERROR, { exact: true })).toBeVisible();
    trace.push(await observe(page, fixtures, 'wrong password'));
    await capture('p41-login-error', { error: page.getByText(LOGIN_ERROR, { exact: true }) });
    await page.evaluate(() => sessionStorage.setItem('p41-signed-in', '1'));
    await fill(field(page, 'Password'), PASSWORD);
    await signIn.click();
    await page.waitForURL(`**${P41_PATHS.cli}`);
    await expect(page.getByText('Approve orbit login', { exact: false }).first()).toBeVisible();
    await expect(button(page, 'Approve')).toBeEnabled();
    trace.push(await observe(page, fixtures, 'signed in and back at the login request'));
    await attachTrace(testInfo, trace);
  });
});

test.describe('P4.1 profile', () => {
  test('password form: each check, the linked confirmation and the reset', async ({ evidence }, testInfo) => {
    const { page, capture } = evidence;
    const fixtures = await installP41Fixtures(page, { theme: testInfo.project.use.colorScheme });
    const trace = [];
    await page.goto(P41_PATHS.profile);
    await expect(page.getByRole('heading', { name: 'Profile', exact: true })).toBeVisible();
    const form = card(page, 'Change password');
    const change = button(form, 'Change password');
    await change.scrollIntoViewIfNeeded();
    trace.push(await observe(page, fixtures, 'open'));

    await field(page, 'Current password').fill('old password');
    await field(page, 'Current password').press('Enter');
    await expect(field(page, 'New password')).toHaveAttribute('aria-invalid', 'true');
    await frames(page);
    trace.push(await observe(page, fixtures, 'enter in the first field'));

    await fill(field(page, 'New password'), 'abc');
    await fill(field(page, 'Confirm new password'), 'abcdef');
    await change.scrollIntoViewIfNeeded();
    await frames(page);
    trace.push(await observe(page, fixtures, 'short new password, confirmation differs'));
    await capture('p41-profile-mismatch', { card: form, newPassword: field(page, 'New password') });

    await fill(field(page, 'New password'), 'abcdef');
    await expect(form.getByText(/do not match|At least 6/)).toHaveCount(0);
    await change.scrollIntoViewIfNeeded();
    await frames(page);
    trace.push(await observe(page, fixtures, 'new password long enough and now matching'));
    await capture('p41-profile-ready', { card: form, confirm: field(page, 'Confirm new password') });

    const revokeBox = form.getByRole('checkbox', { name: 'Also revoke all my access tokens' });
    await revokeBox.click();
    await expect(revokeBox).toBeChecked();
    await change.click();
    const notifications = page.getByRole('region', { name: 'Notifications', exact: true });
    await expect(notifications.getByText('Password changed', { exact: true })).toBeVisible();
    await expect(field(page, 'New password')).toHaveValue('');
    await expect(revokeBox).not.toBeChecked();
    await change.scrollIntoViewIfNeeded();
    await frames(page);
    trace.push(await observe(page, fixtures, 'changed, tokens revoked, form reset'));
    await capture('p41-profile-reset', { card: form, current: field(page, 'Current password') });
    await attachTrace(testInfo, trace);
  });

  test('photo: choose, show and remove', async ({ evidence }, testInfo) => {
    const { page, capture } = evidence;
    const fixtures = await installP41Fixtures(page, { theme: testInfo.project.use.colorScheme });
    const trace = [];
    await page.goto(P41_PATHS.profile);
    const basic = card(page, 'Basic information');
    await expect(button(basic, 'Choose photo')).toBeVisible();
    const chooser = page.waitForEvent('filechooser');
    await button(basic, 'Choose photo').click();
    await (await chooser).setFiles({ name: 'photo.png', mimeType: 'image/png', buffer: UPLOAD_PNG });
    await expect(button(basic, 'Remove photo')).toBeVisible();
    const photo = basic.locator('img');
    await expect(photo).toBeVisible();
    await expect.poll(() => photo.evaluate((img) => img.complete && img.naturalWidth)).toBeGreaterThan(0);
    trace.push({ ...(await observe(page, fixtures, 'photo chosen')), photo: await photo.evaluate((img) => ({ width: img.getBoundingClientRect().width, height: img.getBoundingClientRect().height, alt: img.getAttribute('alt') })) });
    await capture('p41-profile-photo', { card: basic, photo });
    await button(basic, 'Remove photo').click();
    await expect(button(basic, 'Remove photo')).toHaveCount(0);
    await expect(photo).toHaveCount(0);
    trace.push(await observe(page, fixtures, 'photo removed'));
    await attachTrace(testInfo, trace);
  });

  test('sign-in methods card beside the replaced ones', async ({ evidence }, testInfo) => {
    const { page, capture } = evidence;
    const fixtures = await installP41Fixtures(page, { theme: testInfo.project.use.colorScheme });
    fixtures.state.google = true;
    fixtures.state.account.signInMethods = { password: true, google: null };
    await page.goto(P41_PATHS.profile);
    const methods = card(page, 'Sign-in methods');
    await expect(button(methods, 'Connect Google')).toBeVisible();
    await methods.scrollIntoViewIfNeeded();
    await capture('p41-profile-signin', { card: methods, basic: card(page, 'Basic information') });
    await attachTrace(testInfo, [await observe(page, fixtures, 'open')]);
  });
});

test.describe('P4.1 settings', () => {
  test('every control: mode, switches while saving, theme and the way to tokens', async ({ evidence }, testInfo) => {
    const { page, capture } = evidence;
    const fixtures = await installP41Fixtures(page, { theme: testInfo.project.use.colorScheme });
    const trace = [];
    const dark = testInfo.project.use.colorScheme === 'dark';
    await page.goto(P41_PATHS.settings);
    await expect(page.getByText('Default permission mode', { exact: true })).toBeVisible();
    const notifications = page.getByRole('region', { name: 'Notifications', exact: true });

    const mode = page.getByRole('combobox').first();
    await mode.click();
    // The replaced select's visible rows carry no role (its role=option list is off screen).
    const options = page.locator(SELECT_OPTION).filter({ visible: true });
    const plan = options.filter({ hasText: /^Plan$/ });
    await expect(plan).toBeVisible();
    await frames(page);
    trace.push({ ...(await observe(page, fixtures, 'mode list open')), options: await options.allTextContents() });
    await capture('p41-settings-mode-open', { select: card(page, 'Session defaults').locator(SELECT).first(), option: plan });
    await plan.click();
    await expect(notifications.getByText('Setting saved', { exact: true }).first()).toBeVisible();
    await expect(card(page, 'Session defaults').locator(SELECT).first()).toContainText('Plan');
    trace.push(await observe(page, fixtures, 'mode chosen'));

    const smart = card(page, 'Session defaults').getByRole('switch', { name: 'Smart model selection' });
    await smart.click();
    await expect(smart).toHaveAttribute('aria-checked', 'true');
    trace.push(await observe(page, fixtures, 'smart model selection on'));

    // While a save is on its way every switch shows it. The earlier saves' notices go first, so the
    // capture holds only this state.
    await expect(notifications.getByText('Setting saved', { exact: true })).toHaveCount(0);
    fixtures.state.holdPreferences = fixtures.gate();
    const finished = card(page, 'Notifications').getByRole('switch').first();
    await finished.click();
    await expect.poll(() => fixtures.requests.some((r) => r.method === 'PATCH' && r.body?.notifySessionFinished === false)).toBe(true);
    await frames(page);
    trace.push({ ...(await observe(page, fixtures, 'saving')), switches: await page.getByRole('switch').evaluateAll((all) => all.map((s) => ({ checked: s.getAttribute('aria-checked'), disabled: s.matches(':disabled') || s.getAttribute('aria-disabled') === 'true' || s.hasAttribute('data-disabled') }))) });
    // A busy switch is dimmed (opacity .65) on purpose, so only its card is waited on.
    await capture('p41-settings-saving', { card: card(page, 'Notifications') });
    fixtures.state.holdPreferences.open();
    fixtures.state.holdPreferences = null;
    await expect(finished).toHaveAttribute('aria-checked', 'false');
    trace.push(await observe(page, fixtures, 'saved'));

    // The theme. System resolves to the project's scheme, so the page keeps the theme the capture
    // checks; the other scheme and the arrow keys are observed without a capture.
    const theme = card(page, 'Appearance');
    await expect(notifications.getByText('Setting saved', { exact: true })).toHaveCount(0);
    await theme.getByText('System', { exact: true }).click();
    await expect.poll(() => fixtures.state.account.preferences.theme).toBe('system');
    await frames(page);
    trace.push({ ...(await observe(page, fixtures, 'theme: system')), theme: await page.locator('html').getAttribute('data-theme') });
    await capture('p41-settings-theme', { card: theme, choice: theme.getByText('System', { exact: true }) });
    await theme.getByText(dark ? 'Light' : 'Dark', { exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', dark ? 'light' : 'dark');
    trace.push({ ...(await observe(page, fixtures, 'theme: the other scheme')), theme: await page.locator('html').getAttribute('data-theme') });
    await page.keyboard.press('ArrowLeft');
    await frames(page);
    trace.push({ ...(await observe(page, fixtures, 'arrow left')), theme: await page.locator('html').getAttribute('data-theme'), saved: fixtures.state.account.preferences.theme });

    await button(card(page, 'Access tokens'), 'Manage').click();
    await page.waitForURL('**/settings/access-tokens');
    await expect(page.getByRole('heading', { name: 'Access tokens', exact: true })).toBeVisible();
    trace.push(await observe(page, fixtures, 'manage access tokens'));
    await attachTrace(testInfo, trace);
  });
});

test.describe('P4.1 access tokens', () => {
  test('list, tabs and the revoke question', async ({ evidence }, testInfo) => {
    const { page, capture } = evidence;
    const fixtures = await installP41Fixtures(page, { theme: testInfo.project.use.colorScheme });
    const trace = [];
    await page.goto(P41_PATHS.tokens);
    const table = page.locator(TABLE).first();
    const ci = page.getByRole('row').filter({ hasText: 'CI pipeline' });
    await expect(ci).toBeVisible();
    trace.push({ ...(await observe(page, fixtures, 'open')), rows: await page.getByRole('row').allInnerTexts() });
    await capture('p41-tokens', { table, revoke: button(ci, 'Revoke'), header: page.getByRole('columnheader', { name: 'Access', exact: true }) });

    await ci.hover();
    await frames(page);
    await capture('p41-tokens-hover', { row: ci });

    await page.getByRole('tab', { name: /Revoked & expired/ }).click();
    await expect(page.getByRole('row').filter({ hasText: 'Old cron' })).toBeVisible();
    await page.mouse.move(0, 0);
    trace.push({ ...(await observe(page, fixtures, 'ended tab')), rows: await page.getByRole('row').allInnerTexts() });
    await capture('p41-tokens-ended', { table });
    await page.getByRole('tab', { name: /^Active/ }).click();

    await button(ci, 'Revoke').click();
    const asked = page.getByText('Revoke “CI pipeline”?', { exact: true });
    await expect(asked).toBeVisible();
    await frames(page);
    trace.push(await observe(page, fixtures, 'asked'));
    await capture('p41-tokens-revoke', { question: asked });
    await page.keyboard.press('Escape');
    await expect(asked).toBeHidden();
    trace.push(await observe(page, fixtures, 'escape'));
    await button(ci, 'Revoke').click();
    await expect(asked).toBeVisible();
    await button(question(page, 'Revoke “CI pipeline”?'), 'Revoke').click();
    const notifications = page.getByRole('region', { name: 'Notifications', exact: true });
    await expect(notifications.getByText('Token revoked', { exact: true })).toBeVisible();
    await expect(page.getByRole('row').filter({ hasText: 'CI pipeline' })).toHaveCount(0);
    trace.push({ ...(await observe(page, fixtures, 'revoked')), rows: await page.getByRole('row').allInnerTexts() });
    await attachTrace(testInfo, trace);
  });

  test('a new token: presets, scopes, workspaces, never, issued once', async ({ evidence }, testInfo) => {
    const { page, capture } = evidence;
    const fixtures = await installP41Fixtures(page, { theme: testInfo.project.use.colorScheme });
    const trace = [];
    await page.goto(P41_PATHS.tokens);
    await expect(page.getByRole('row').filter({ hasText: 'CI pipeline' })).toBeVisible();
    await button(page, 'New token').click();
    const dialog = page.getByRole('dialog', { name: 'New access token' });
    await expect(dialog).toBeVisible();
    await frames(page);
    trace.push(await observe(page, fixtures, 'dialog open'));
    await capture('p41-tokens-new', { dialog, surface: page.locator(DIALOG_SURFACE).first(), name: dialog.getByPlaceholder('What it’s for, e.g. Nightly report script'), access: dialog.getByText('Read-only', { exact: true }) });

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    trace.push(await observe(page, fixtures, 'escape closes'));
    await button(page, 'New token').click();
    await expect(dialog).toBeVisible();

    // A preset is chosen by pressing its label: the replaced buttons' radio inputs have no size, and an
    // Orbit button's radio covers its text.
    const preset = (name) => dialog.locator('label').filter({ hasText: new RegExp(`^${name}$`) });
    await preset('Custom').click();
    const scopes = dialog.getByRole('group', { name: 'Scopes' });
    await expect(scopes).toBeVisible();
    await scopes.getByRole('checkbox').nth(1).click();
    await scopes.getByRole('checkbox').nth(0).click();
    await frames(page);
    trace.push({ ...(await observe(page, fixtures, 'custom scopes')), boxes: await scopes.getByRole('checkbox').evaluateAll((all) => all.map((b) => b.getAttribute('aria-checked') ?? String(b.checked))) });
    await capture('p41-tokens-new-custom', { dialog, scopes });

    const workspaces = dialog.getByRole('combobox');
    await workspaces.click();
    const option = page.locator(SELECT_OPTION).filter({ visible: true }).filter({ hasText: /^Orbit baseline$/ });
    await expect(option).toBeVisible();
    await frames(page);
    trace.push(await observe(page, fixtures, 'workspaces open'));
    await capture('p41-tokens-new-workspaces', { select: dialog.locator(SELECT).first(), option });
    await option.click();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();
    trace.push(await observe(page, fixtures, 'workspace picked, list closed'));

    await preset('Never').click();
    await expect(dialog.getByText('This token never expires. If it leaks, it keeps working until you revoke it.', { exact: true })).toBeVisible();
    await dialog.getByPlaceholder('What it’s for, e.g. Nightly report script').fill('Nightly report');
    await frames(page);
    trace.push(await observe(page, fixtures, 'never chosen, named'));
    await capture('p41-tokens-new-never', { dialog, warning: dialog.getByText('This token never expires. If it leaks, it keeps working until you revoke it.', { exact: true }) });

    await button(dialog, 'Create token').click();
    await expect(dialog).toBeHidden();
    const issued = page.getByRole('region', { name: 'New access token' });
    await expect(issued.getByText(ISSUED_TOKEN, { exact: true })).toBeVisible();
    await frames(page);
    trace.push(await observe(page, fixtures, 'issued'));
    await capture('p41-tokens-issued', { issued, copy: button(issued, 'Copy') });
    await button(issued, 'Done').click();
    await expect(issued).toHaveCount(0);
    trace.push(await observe(page, fixtures, 'done'));
    await attachTrace(testInfo, trace);
  });

  test('loading, empty and a failed read', async ({ evidence }, testInfo) => {
    const { page, capture } = evidence;
    const fixtures = await installP41Fixtures(page, { theme: testInfo.project.use.colorScheme });
    const trace = [];
    fixtures.state.holdTokens = fixtures.gate();
    await page.goto(P41_PATHS.tokens);
    await expect(page.getByRole('heading', { name: 'Access tokens', exact: true })).toBeVisible();
    await frames(page);
    trace.push(await observe(page, fixtures, 'loading'));
    await capture('p41-tokens-loading', { tabs: page.getByRole('tablist') });
    fixtures.state.holdTokens.open();
    fixtures.state.holdTokens = null;
    await expect(page.getByRole('row').filter({ hasText: 'CI pipeline' })).toBeVisible();

    fixtures.state.tokens = [];
    await page.goto(P41_PATHS.tokens);
    await expect(page.getByText('No active tokens. Create one to use the API or the orbit CLI as yourself.', { exact: true })).toBeVisible();
    trace.push(await observe(page, fixtures, 'empty'));
    await capture('p41-tokens-empty', { table: page.locator(TABLE).first() });

    fixtures.state.tokensError = true;
    await page.goto(P41_PATHS.tokens);
    await expect(page.getByText(`Couldn’t load your tokens: ${TOKENS_ERROR}`, { exact: false })).toBeVisible({ timeout: 20_000 });
    trace.push(await observe(page, fixtures, 'failed'));
    await capture('p41-tokens-error', { retry: button(page, 'Retry') });
    fixtures.state.tokensError = false;
    fixtures.state.tokens = TOKENS.map((token) => structuredClone(token));
    await button(page, 'Retry').click();
    await expect(page.getByRole('row').filter({ hasText: 'Laptop script' })).toBeVisible();
    trace.push(await observe(page, fixtures, 'retried'));
    await attachTrace(testInfo, trace);
  });

  test('an administrator: a user\'s tokens in the users page dialog', async ({ evidence }, testInfo) => {
    const { page, capture } = evidence;
    const fixtures = await installP41Fixtures(page, { theme: testInfo.project.use.colorScheme });
    const trace = [];
    await page.goto(P41_PATHS.admin);
    const user = page.getByRole('row').filter({ hasText: ADMIN_USER.email });
    await expect(user).toBeVisible();
    await button(user, 'Access tokens').click();
    const dialog = page.getByRole('dialog', { name: `Access tokens — ${ADMIN_USER.email}` });
    await expect(dialog.getByRole('row').filter({ hasText: 'CI pipeline' })).toBeVisible();
    await frames(page);
    trace.push({ ...(await observe(page, fixtures, 'dialog open')), rows: await dialog.getByRole('row').allInnerTexts() });
    await capture('p41-admin-tokens', { dialog, table: dialog.locator(TABLE).first() });

    const ci = dialog.getByRole('row').filter({ hasText: 'CI pipeline' });
    await button(ci, 'Revoke').click();
    const asked = page.getByText('Revoke “CI pipeline”?', { exact: true });
    await expect(asked).toBeVisible();
    await frames(page);
    trace.push(await observe(page, fixtures, 'asked inside the dialog'));
    await capture('p41-admin-revoke', { question: asked });
    await page.keyboard.press('Escape');
    await expect(asked).toBeHidden();
    await expect(dialog).toBeVisible();
    trace.push(await observe(page, fixtures, 'escape closes the question only'));
    await button(ci, 'Revoke').click();
    await expect(asked).toBeVisible();
    await button(question(page, 'Revoke “CI pipeline”?'), 'Revoke').click();
    const notifications = page.getByRole('region', { name: 'Notifications', exact: true });
    await expect(notifications.getByText('Token revoked', { exact: true })).toBeVisible();
    await expect(dialog.getByRole('row').filter({ hasText: 'CI pipeline' }).getByRole('button')).toHaveCount(0);
    trace.push({ ...(await observe(page, fixtures, 'revoked')), rows: await dialog.getByRole('row').allInnerTexts() });
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    trace.push(await observe(page, fixtures, 'escape closes the dialog'));
    await attachTrace(testInfo, trace);
  });
});

test.describe('P4.1 orbit login approval', () => {
  test('approve', async ({ evidence }, testInfo) => {
    const { page } = evidence;
    const capture = captureOf(evidence, testInfo);
    const press = pressOf(testInfo);
    const fixtures = await installP41Fixtures(page, { theme: testInfo.project.use.colorScheme });
    const trace = [];
    fixtures.state.holdCli = fixtures.gate();
    await page.goto(P41_PATHS.cli);
    await expect(page.getByText('🔑 Approve orbit login', { exact: true })).toBeVisible();
    await frames(page);
    trace.push(await observe(page, fixtures, 'loading'));
    await capture('p41-cli-loading', { card: card(page, '🔑 Approve orbit login') });
    fixtures.state.holdCli.open();
    fixtures.state.holdCli = null;
    const approve = button(page, 'Approve');
    await expect(approve).toBeEnabled();
    trace.push(await observe(page, fixtures, 'asked'));
    await capture('p41-cli', { card: card(page, '🔑 Approve orbit login'), approve, details: page.getByRole('rowheader', { name: 'Token name' }).or(page.locator('th').filter({ hasText: /^Token name$/ })).first() });
    await press(approve);
    await expect(page.getByText('Login approved', { exact: true })).toBeVisible();
    trace.push(await observe(page, fixtures, 'approved'));
    await capture('p41-cli-approved', { card: card(page, '🔑 Approve orbit login') });
    await attachTrace(testInfo, trace);
  });

  test('warnings, a refused approval, deny and a dead code', async ({ evidence }, testInfo) => {
    const { page } = evidence;
    const capture = captureOf(evidence, testInfo);
    const press = pressOf(testInfo);
    const fixtures = await installP41Fixtures(page, { theme: testInfo.project.use.colorScheme });
    const trace = [];
    fixtures.state.cli = { ...fixtures.state.cli, expiresInDays: null, nameInUse: true };
    await page.goto(P41_PATHS.cli);
    await expect(page.getByText('You already have an access token named "orbit CLI on devbox".', { exact: true })).toBeVisible();
    await expect(button(page, 'Approve')).toBeDisabled();
    trace.push(await observe(page, fixtures, 'never expires, name in use'));
    await capture('p41-cli-warnings', { card: card(page, '🔑 Approve orbit login'), deny: button(page, 'Deny') });

    fixtures.state.cli = { ...fixtures.state.cli, expiresInDays: 90, nameInUse: false };
    fixtures.state.cliDecisionError = true;
    await page.goto(P41_PATHS.cli);
    await press(button(page, 'Approve'));
    const notifications = page.getByRole('region', { name: 'Notifications', exact: true });
    await expect(notifications.getByText("Couldn't approve this login", { exact: true })).toBeVisible();
    await expect(button(page, 'Approve')).toBeEnabled();
    trace.push(await observe(page, fixtures, 'approval refused'));
    fixtures.state.cliDecisionError = false;
    await press(button(page, 'Deny'));
    await expect(page.getByText('Login denied', { exact: true })).toBeVisible();
    trace.push(await observe(page, fixtures, 'denied'));
    await capture('p41-cli-denied', { card: card(page, '🔑 Approve orbit login') });

    fixtures.state.cliError = true;
    await page.goto(P41_PATHS.cli);
    await expect(page.getByText('Cannot approve this login', { exact: true })).toBeVisible({ timeout: 20_000 });
    trace.push(await observe(page, fixtures, 'code not found'));
    await capture('p41-cli-error', { card: card(page, '🔑 Approve orbit login') });
    await attachTrace(testInfo, trace);
  });
});
