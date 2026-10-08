import { test, expect } from './harness.mjs';
import {
  DEEPSEEK_LOW, DEVICE_CODE, HISTORY_DIR, ONE_TIME_PASSWORD, P42_IDS, P42_PATHS, PROBE_ERROR, ROTATED_TOKEN, STORED_KEY,
  deepseekBalances, deepseekRows, gate, installP42Fixtures,
} from './p42-fixtures.mjs';

// P4.2 states, none of which the P0 matrix reaches: the Providers page (engines on three runners with
// an account menu, its remove question and the pause dialog; account pools of each kind; the API keys
// table with its delete question, its loading and its empty state; New pool), connecting and editing a
// provider, a DeepSeek key's account balance (its line in the keys table; on its page read, refreshing,
// too low, refused and loading), a pool's own page (Who can use it, adding an account or a key,
// sharing, signing ChatGPT in), the Runners list (its menu, rename, token rotation and delete questions, loading and empty), a
// runner's page (its menus, the workspace form, capacity, and an offline machine's attention cards), the
// runner register guide, approving `orbit register`, and the administrator's Users table (with disabling
// and enabling an account).
// Locators are roles, accessible names, labels and the pages' own classes, so the same file drives the
// replaced controls (same-commit reference tree) and the Orbit ones; a painted box is named by both
// class names. Screenshots, computed styles and each step's observation (`trace`: address, focus, open
// dialogs and menus, alerts, notifications and the requests a press sends) are compared between the
// two runs.

const DIALOG_SURFACE = '.ant-modal-container, .ant-modal-confirm .ant-modal-container, .orbit-overlay';
const SELECT_OPTION = '[role="option"], .ant-select-item-option';
const SELECT = '.ant-select, .orbit-select';
const NUMBER = '.ant-input-number, .orbit-number-input';
const TABLE = '.ant-table-wrapper, .orbit-table-frame';
const CARD = '.ant-card, .orbit-card';

const frames = (page) => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
// A replaced button's icon names itself ("plus Add workspace"), and its loading icon can stay in the
// name ("loading Save"); Orbit buttons hide both from the name.
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const named = (name) => new RegExp(`^(?:loading |[a-z]+(?:-[a-z]+)* )?${escape(name)}$`);
const button = (scope, name) => scope.getByRole('button', { name: named(name) });
const item = (page, name) => page.getByRole('menuitem', { name: named(name) });
// The open menu: the replaced dropdown keeps closed ones in the page, hidden.
const openMenu = (page) => page.getByRole('menu').filter({ visible: true }).last();
// An anchored question (role=tooltip on the replaced popover, role=dialog on the Orbit one) or a modal
// one (role=dialog on the replaced confirm, role=alertdialog on the Orbit one), by its title.
const question = (page, title) => page.locator('[role="tooltip"], [role="dialog"], [role="alertdialog"]')
  .filter({ has: page.getByText(title, { exact: true }) }).filter({ visible: true }).last();
const dialog = (page, title) => page.locator('[role="dialog"], [role="alertdialog"]')
  .filter({ has: page.getByText(title, { exact: true }) }).filter({ visible: true }).last();
const notifications = (page) => page.getByRole('region', { name: 'Notifications', exact: true });

/** Wait out enter and leave animations (the replaced controls run theirs whatever motion is asked for),
 *  so an observation reads where a step ended up, not a frame of its transition. */
const settled = (page) => page.waitForFunction(
  () => document.getAnimations().every((animation) => animation.playState !== 'running' || animation.effect?.getTiming().iterations === Infinity),
  null, { timeout: 3000 },
).catch(() => {});

async function observe(page, fixtures, step) {
  await settled(page);
  const state = await page.evaluate(() => {
    const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden' && Number(getComputedStyle(el).opacity) > 0; };
    const text = (ids) => (ids ?? '').split(/\s+/).filter(Boolean).map((id) => document.getElementById(id)?.textContent?.trim() ?? '').filter(Boolean).join(' | ');
    const name = (el) => el && (el.getAttribute('aria-label') || text(el.getAttribute('aria-labelledby')) || el.labels?.[0]?.textContent?.trim()
      || el.getAttribute('placeholder') || el.textContent?.trim().replace(/\s+/g, ' ').slice(0, 80) || el.tagName.toLowerCase());
    const active = document.activeElement;
    const notifications = document.querySelector('[role="region"][aria-label="Notifications"]');
    return {
      url: location.pathname + location.search,
      focus: active && active !== document.body ? { role: active.getAttribute('role') ?? active.tagName.toLowerCase(), name: name(active) } : 'body',
      dialogs: [...document.querySelectorAll('[role="dialog"],[role="alertdialog"]')].filter(visible).map((el) => el.textContent.trim().replace(/\s+/g, ' ').slice(0, 120)),
      menus: [...document.querySelectorAll('[role="menu"]')].filter(visible).map((el) => [...el.querySelectorAll('[role="menuitem"]')].map((entry) => ({
        text: entry.textContent.trim(), disabled: entry.getAttribute('aria-disabled') === 'true' || entry.hasAttribute('data-disabled') }))),
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

// The enrollment card is fixed-width (460px), wider than a phone: Chromium's mobile layout viewport
// grows to fit it, so the harness's viewport check cannot hold there and only the screenshot is taken.
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

const attachTrace = (testInfo, trace) => testInfo.attach('trace', { body: JSON.stringify(trace, null, 2), contentType: 'application/json' });
/** Bring a part of the page to the top of the view, the same way on both trees. */
const top = (locator) => locator.evaluate((el) => el.scrollIntoView({ block: 'start' }));
const phone = (testInfo) => !!testInfo.project.use.isMobile;
/** A row of the Providers page's engine cards or pool cards, by the name it shows. */
const engineRow = (page, label) => page.locator('.re-row').filter({ has: page.locator('.re-name', { hasText: new RegExp(`^${escape(label)}`) }) }).first();
const poolRow = (page, label) => page.locator('.pool-row').filter({ has: page.locator('.pool-member-label', { hasText: new RegExp(`^${escape(label)}$`) }) }).first();
const keyRow = (page, label) => page.locator('tr').filter({ has: page.locator('.prov-cell-name', { hasText: new RegExp(`^${escape(label)}$`) }) }).first();

test.describe('P4.2 providers', () => {
  test('engines: an account menu, its remove question and the pause dialog', async ({ evidence }, testInfo) => {
    const { page, capture } = evidence;
    const fixtures = await installP42Fixtures(page, { theme: testInfo.project.use.colorScheme });
    const trace = [];
    await page.goto(P42_PATHS.providers);
    const work = engineRow(page, 'Work');
    await expect(work).toBeVisible();
    await expect(page.locator('.pool-card').first()).toBeVisible();
    trace.push(await observe(page, fixtures, 'open'));
    await capture('p42-providers', { card: page.locator('.re-runner-card').first(), action: button(engineRow(page, 'Kimi'), 'Install') });

    await button(work, 'More actions').click();
    await expect(item(page, 'Remove account')).toBeVisible();
    await frames(page);
    trace.push(await observe(page, fixtures, 'account menu open'));
    await capture('p42-engine-menu', { menu: openMenu(page), more: button(work, 'More actions') });

    await item(page, 'Remove account').click();
    const remove = question(page, 'Remove Work?');
    await expect(remove).toBeVisible();
    await frames(page);
    trace.push(await observe(page, fixtures, 'remove asked'));
    await capture('p42-engine-remove', { question: remove });
    await button(remove, 'Cancel').click();
    await expect(remove).toHaveCount(0);
    trace.push(await observe(page, fixtures, 'remove cancelled'));

    // Rename from the menu: the name becomes its own editor, focused with the name selected.
    await button(work, 'More actions').click();
    await item(page, 'Rename').click();
    const name = page.getByRole('textbox', { name: 'Rename Work' });
    await expect(name).toBeFocused();
    await frames(page);
    trace.push({ ...(await observe(page, fixtures, 'rename from the menu')), selected: await name.evaluate((input) => [input.selectionStart, input.selectionEnd]) });
    await name.pressSequentially('Personal');
    await name.press('Enter');
    await expect(engineRow(page, 'Personal')).toHaveCount(0);
    trace.push(await observe(page, fixtures, 'renamed'));

    await button(work, 'More actions').click();
    await item(page, 'Pause account…').click();
    const pause = dialog(page, 'Pause account');
    await expect(pause).toBeVisible();
    await frames(page);
    trace.push(await observe(page, fixtures, 'pause dialog'));
    await capture('p42-account-pause', { surface: pause, hours: pause.getByText('2h', { exact: true }) });
    // Where a person clicks it: on its text (the Orbit button-style radio lies over its whole button).
    await pause.getByText('Custom', { exact: true }).click({ force: true });
    const hours = pause.getByRole('spinbutton', { name: 'Pause hours' });
    await expect(hours).toBeVisible();
    await fill(hours, '2.5');
    await expect(pause.getByText(/Automatically resumes at/)).toBeVisible();
    await frames(page);
    trace.push({ ...(await observe(page, fixtures, 'custom 2.5 hours')), hours: await hours.inputValue() });
    await capture('p42-account-pause-custom', { surface: pause, number: pause.locator(NUMBER) });
    await fill(hours, '0');
    await hours.press('Tab');
    await frames(page);
    trace.push({ ...(await observe(page, fixtures, 'custom 0 hours, then Tab')), hours: await hours.inputValue() });
    await fill(hours, '3');
    await button(pause, 'Pause Account').click();
    await expect(notifications(page).getByText('Work paused', { exact: true })).toBeVisible();
    trace.push(await observe(page, fixtures, 'paused'));
    await attachTrace(testInfo, trace);
  });

  test('pools: each kind', async ({ evidence }, testInfo) => {
    const { page, capture } = evidence;
    const fixtures = await installP42Fixtures(page, { theme: testInfo.project.use.colorScheme });
    const trace = [];
    await page.goto(P42_PATHS.providers);
    const pools = page.locator('.pool-sec');
    await expect(pools.locator('.pool-card')).toHaveCount(3);
    // A phone starts every pool folded; open the first so its members show.
    if (phone(testInfo)) await pools.locator('.pool-card').filter({ hasText: 'Claude accounts' }).locator('.re-toggle').click();
    await top(pools);
    await frames(page);
    trace.push(await observe(page, fixtures, 'pools'));
    await capture('p42-pools', { head: pools.locator('.pool-sec-head'), card: pools.locator('.pool-card').first() });

    await attachTrace(testInfo, trace);
  });

  test('keys: the table, its delete question, loading and empty', async ({ evidence }, testInfo) => {
    const { page, capture } = evidence;
    const fixtures = await installP42Fixtures(page, { theme: testInfo.project.use.colorScheme });
    const trace = [];
    fixtures.state.holdProviders = gate();
    await page.goto(P42_PATHS.providers);
    const keys = page.locator('.provider-keys');
    const heading = page.getByRole('heading', { name: 'Your API keys', exact: true });
    await expect(heading).toBeVisible();
    await expect(keys).toBeVisible();
    await top(heading);
    await frames(page);
    trace.push(await observe(page, fixtures, 'keys loading'));
    await capture('p42-keys-loading', { table: keys });
    fixtures.state.holdProviders.open();
    fixtures.state.holdProviders = null;

    const lab = keyRow(page, 'Lab gateway');
    await expect(lab).toBeVisible();
    await top(heading);
    await frames(page);
    trace.push({ ...(await observe(page, fixtures, 'keys')), rows: await keys.locator('tbody tr').allInnerTexts() });
    await capture('p42-keys', { table: keys, row: lab });

    await lab.getByRole('button', { name: named(phone(testInfo) ? 'Delete Lab gateway' : 'Delete') }).click();
    const ask = question(page, 'Delete Lab gateway?');
    await expect(ask).toBeVisible();
    await frames(page);
    trace.push(await observe(page, fixtures, 'delete asked'));
    await capture('p42-keys-delete', { question: ask });
    await button(ask, 'OK').click();
    await expect(notifications(page).getByText('Provider deleted', { exact: true })).toBeVisible();
    await expect(keyRow(page, 'Lab gateway')).toHaveCount(0);
    trace.push(await observe(page, fixtures, 'deleted'));

    // No keys at all: the page offers the vendors instead of an empty table.
    fixtures.state.providers = [];
    await page.reload();
    await expect(page.getByRole('heading', { name: 'No keys yet', exact: true })).toBeVisible();
    await top(heading);
    await frames(page);
    trace.push(await observe(page, fixtures, 'no keys'));
    await capture('p42-keys-empty', { empty: page.locator('.provider-empty') });
    await attachTrace(testInfo, trace);
  });

  test('New pool: each engine and who can use it', async ({ evidence }, testInfo) => {
    const { page, capture } = evidence;
    const fixtures = await installP42Fixtures(page, { theme: testInfo.project.use.colorScheme });
    const trace = [];
    await page.goto(P42_PATHS.providers);
    await button(page, 'New pool').click();
    const create = dialog(page, 'New account pool');
    await expect(create).toBeVisible();
    await frames(page);
    trace.push(await observe(page, fixtures, 'new pool'));
    await capture('p42-new-pool', { surface: create });

    await create.getByText('Me and people I add', { exact: true }).click();
    const emails = create.getByRole('combobox', { name: 'People to add' });
    await expect(emails).toBeVisible();
    await emails.click();
    await emails.pressSequentially('lin@example.test zhang@example.test');
    await frames(page);
    trace.push(await observe(page, fixtures, 'people typed'));
    await capture('p42-new-pool-people', { surface: create, emails: create.locator(SELECT) });

    await create.getByText('Claude', { exact: true }).click();
    await expect(create.getByText('Accounts', { exact: true })).toBeVisible();
    await frames(page);
    trace.push(await observe(page, fixtures, 'claude'));
    await capture('p42-new-pool-claude', { surface: create });
    await button(create, 'Create pool').click();
    await expect(notifications(page).getByText('Pool created', { exact: true })).toBeVisible();
    trace.push(await observe(page, fixtures, 'created'));
    await attachTrace(testInfo, trace);
  });
});

test.describe('P4.2 connecting a provider', () => {
  test('a vendor: the key, a failed probe and Save anyway', async ({ evidence }, testInfo) => {
    const { page, capture } = evidence;
    const fixtures = await installP42Fixtures(page, { theme: testInfo.project.use.colorScheme });
    const trace = [];
    await page.goto(P42_PATHS.connectAnthropic);
    const key = page.getByPlaceholder('Provider API key', { exact: true });
    await expect(key).toBeVisible();
    trace.push(await observe(page, fixtures, 'open'));
    await capture('p42-connect', { key, connect: button(page, 'Connect') });
    await fill(key, 'sk-ant-fixture-0123456789');
    await button(page, 'Connect').click();
    await expect(page.getByText(PROBE_ERROR, { exact: true })).toBeVisible();
    await frames(page);
    trace.push(await observe(page, fixtures, 'probe refused'));
    await capture('p42-connect-probe-error', { saveAnyway: button(page, 'Save anyway') });
    await page.getByText('Advanced', { exact: true }).click();
    await expect(page.getByText('Endpoint', { exact: true })).toBeVisible();
    await frames(page);
    trace.push(await observe(page, fixtures, 'advanced'));
    await capture('p42-connect-advanced', { advanced: page.locator('.provider-adv') });
    await button(page, 'Save anyway').click();
    await page.waitForURL('**/providers');
    await expect(notifications(page).getByText('Provider created', { exact: true })).toBeVisible();
    trace.push(await observe(page, fixtures, 'saved anyway'));
    await attachTrace(testInfo, trace);
  });

  test('a custom endpoint: its dialect, models and context windows', async ({ evidence }, testInfo) => {
    const { page, capture } = evidence;
    const fixtures = await installP42Fixtures(page, { theme: testInfo.project.use.colorScheme });
    const trace = [];
    await page.goto(P42_PATHS.connectCustom);
    const dialect = page.getByRole('combobox').first();
    await expect(dialect).toBeVisible();
    trace.push(await observe(page, fixtures, 'open'));
    await capture('p42-connect-custom', { select: page.locator(SELECT).first() });
    await dialect.click();
    const codex = page.locator(SELECT_OPTION).filter({ visible: true }).filter({ hasText: /^OpenAI-compatible \(Codex\)$/ });
    await expect(codex).toBeVisible();
    await frames(page);
    trace.push({ ...(await observe(page, fixtures, 'dialects open')), options: await page.locator(SELECT_OPTION).filter({ visible: true }).allTextContents() });
    await capture('p42-connect-dialect-open', { select: page.locator(SELECT).first(), option: codex });
    await codex.click();
    await expect(page.locator(SELECT).first()).toContainText('OpenAI-compatible (Codex)');
    await fill(page.getByPlaceholder('e.g. My provider', { exact: true }), 'Lab proxy');
    await fill(page.getByPlaceholder('https://api.example.com/anthropic', { exact: true }), 'https://proxy.example.test/v1');
    await button(page, 'Add model').click();
    await fill(page.getByPlaceholder('e.g. claude-opus-4-8', { exact: true }), 'lab-large');
    await fill(page.getByPlaceholder('e.g. Claude Opus 4.8', { exact: true }), 'Lab large');
    const context = page.getByRole('spinbutton').first();
    await fill(context, '128000');
    await context.press('Tab');
    await button(page, 'Add model').click();
    await expect(page.getByRole('spinbutton')).toHaveCount(2);
    const models = page.locator('.provider-adv');
    await top(models);
    await frames(page);
    trace.push({ ...(await observe(page, fixtures, 'two model rows')), context: await page.getByRole('spinbutton').evaluateAll((all) => all.map((input) => input.value)) });
    await capture('p42-connect-models', { number: page.locator(NUMBER).first(), add: button(page, 'Add model') });
    await attachTrace(testInfo, trace);
  });

  test('editing: the stored key shown, the switch, and Save', async ({ evidence }, testInfo) => {
    const { page, capture } = evidence;
    const fixtures = await installP42Fixtures(page, { theme: testInfo.project.use.colorScheme });
    const trace = [];
    await page.goto(P42_PATHS.editOpenai);
    const key = page.getByPlaceholder('Leave blank to keep the current key', { exact: true });
    await expect(key).toBeVisible();
    const enabled = page.getByRole('switch').first();
    await expect(enabled).toBeVisible();
    trace.push(await observe(page, fixtures, 'open'));
    await capture('p42-connect-edit', { key, enabled });
    // The eye on an empty field asks for the key the provider holds, and shows it.
    await page.locator('.ant-input-password-icon, .orbit-password-toggle').first().click();
    await expect(page.locator(`input[value="${STORED_KEY}"]`)).toBeVisible();
    await frames(page);
    trace.push({ ...(await observe(page, fixtures, 'stored key shown')), type: await page.locator(`input[value="${STORED_KEY}"]`).getAttribute('type') });
    await capture('p42-connect-edit-shown', { key: page.locator(`input[value="${STORED_KEY}"]`) });
    await enabled.click();
    await expect(enabled).toHaveAttribute('aria-checked', 'false');
    await button(page, 'Save').click();
    await page.waitForURL('**/providers');
    await expect(notifications(page).getByText('Provider updated', { exact: true })).toBeVisible();
    trace.push(await observe(page, fixtures, 'saved'));
    await attachTrace(testInfo, trace);
  });
});

test.describe('P4.2 a DeepSeek key’s balance', () => {
  test('its line in the keys table, and on its page: read, refreshing, too low, refused and loading', async ({ evidence }, testInfo) => {
    const { page, capture } = evidence;
    const fixtures = await installP42Fixtures(page, { theme: testInfo.project.use.colorScheme });
    const { state } = fixtures;
    state.providers = [...state.providers, ...deepseekRows()];
    state.balances = deepseekBalances();
    const trace = [];
    await page.goto(P42_PATHS.providers);
    const lines = page.getByTestId('deepseek-balance-line');
    await expect(lines).toHaveCount(3);
    await expect(keyRow(page, 'DeepSeek')).toContainText('Account balance ¥110.00');
    await expect(keyRow(page, 'DeepSeek (team)')).toContainText('too low');
    await expect(keyRow(page, 'My DeepSeek')).toContainText('Balance unavailable: API key rejected');
    await top(keyRow(page, 'DeepSeek'));
    trace.push(await observe(page, fixtures, 'list'));
    await capture('p42-deepseek-lines', { line: lines.first() });

    // Its page: the balance under the key, and Refresh.
    await page.goto(P42_PATHS.editDeepseek);
    const section = page.getByTestId('deepseek-balance');
    await expect(section).toContainText('Updated 2 min ago');
    const refresh = button(section, 'Refresh');
    await top(section);
    trace.push(await observe(page, fixtures, 'read'));
    await capture('p42-deepseek-read', { refresh });
    // Refresh asks DeepSeek again: held, the button spins in place, drawn faded (so the section, not the
    // button, is what the capture waits on); the answer is an account too low to pay.
    const held = gate();
    state.holdBalance = held;
    state.balances[P42_IDS.deepseek] = DEEPSEEK_LOW;
    await refresh.click();
    await expect(section.locator('.ant-btn-loading, .orbit-button[data-loading]')).toBeVisible();
    trace.push(await observe(page, fixtures, 'refreshing'));
    await capture('p42-deepseek-refreshing', { section });
    state.holdBalance = null;
    held.open();
    await expect(section).toContainText('Balance too low — DeepSeek calls will fail');
    const topUp = section.getByRole('link', { name: named('Top up on DeepSeek') });
    await top(section);
    trace.push({
      ...(await observe(page, fixtures, 'too low')),
      topUp: await topUp.evaluate((el) => ({ tag: el.tagName, href: el.getAttribute('href'), target: el.getAttribute('target'), rel: el.getAttribute('rel') })),
    });
    await capture('p42-deepseek-low', { topUp });

    // A key DeepSeek refused: what happened, no amount, and Retry.
    await page.goto(P42_PATHS.editDeepseekCustom);
    await expect(section).toContainText('Couldn\'t get the balance');
    await top(section);
    trace.push(await observe(page, fixtures, 'refused'));
    await capture('p42-deepseek-refused', { retry: button(section, 'Retry') });

    // While the first read is out: the card's shape, with Refresh off.
    const loading = gate();
    state.holdBalance = loading;
    await page.goto(P42_PATHS.editDeepseekTeam);
    await expect(section).toContainText('Checking balance…');
    await top(section);
    trace.push(await observe(page, fixtures, 'loading'));
    await capture('p42-deepseek-loading', { refresh: button(section, 'Refresh') });
    state.holdBalance = null;
    loading.open();
    await expect(section).toContainText('Balance too low — DeepSeek calls will fail');
    await attachTrace(testInfo, trace);
  });
});

test.describe('P4.2 a pool on its own page', () => {
  test('a Claude pool: its tooltip, delete question and Add account', async ({ evidence }, testInfo) => {
    const { page, capture } = evidence;
    const fixtures = await installP42Fixtures(page, { theme: testInfo.project.use.colorScheme });
    const trace = [];
    await page.goto(P42_PATHS.claudePool);
    const remove = page.getByRole('button', { name: /Remove Claude Max \(work\) from this pool/ });
    await expect(remove).toBeVisible();
    trace.push(await observe(page, fixtures, 'open'));
    await capture('p42-pool-claude', { card: page.locator('.pool-detail'), remove });
    if (!phone(testInfo)) {
      await remove.hover();
      const tip = page.getByRole('tooltip').filter({ hasText: 'Remove from this pool' }).filter({ visible: true });
      await expect(tip).toBeVisible();
      await frames(page);
      trace.push(await observe(page, fixtures, 'remove tooltip'));
      await capture('p42-pool-tooltip', { tooltip: tip });
      await page.mouse.move(0, 0);
      await expect(tip).toHaveCount(0);
    }
    await remove.click();
    const left = notifications(page).getByText('Claude Max (work) left the pool', { exact: true });
    await expect(left).toBeVisible();
    trace.push(await observe(page, fixtures, 'member removed'));
    // The notice goes before the next capture, which holds only its own state.
    await expect(left).toHaveCount(0);

    await button(page, 'Delete pool').click();
    const ask = question(page, 'Delete Claude accounts?');
    await expect(ask).toBeVisible();
    await frames(page);
    trace.push(await observe(page, fixtures, 'delete asked'));
    await capture('p42-pool-delete', { question: ask });
    await button(ask, 'Cancel').click();
    await expect(ask).toHaveCount(0);

    await button(page, 'Add account').click();
    const add = dialog(page, 'Add account to Claude accounts');
    await expect(add).toBeVisible();
    await frames(page);
    trace.push(await observe(page, fixtures, 'add account'));
    await capture('p42-pool-add-account', { surface: add });
    await button(add, 'Cancel').click();
    await expect(add).toHaveCount(0);
    trace.push(await observe(page, fixtures, 'add account closed'));
    await attachTrace(testInfo, trace);
  });

  test('a Codex pool of one’s own: who can use it, its menus and questions', async ({ evidence }, testInfo) => {
    const { page, capture } = evidence;
    const fixtures = await installP42Fixtures(page, { theme: testInfo.project.use.colorScheme });
    const trace = [];
    await page.goto(P42_PATHS.codexPool);
    const who = page.locator('.who-card');
    await expect(who).toBeVisible();
    trace.push(await observe(page, fixtures, 'open'));
    await capture('p42-pool-codex', { card: page.locator('.pool-detail'), replace: button(page, 'Replace key') });
    await top(who);
    await frames(page);
    await capture('p42-pool-who', { card: who, switch: who.getByRole('switch').first() });

    await who.getByRole('button', { name: named('Manage Lin Wei') }).click();
    await expect(item(page, 'Remove from pool')).toBeVisible();
    await frames(page);
    trace.push(await observe(page, fixtures, 'person menu'));
    await capture('p42-pool-person-menu', { menu: openMenu(page) });
    await page.keyboard.press('Escape');
    await expect(item(page, 'Remove from pool')).toHaveCount(0);

    await who.getByText('Just me', { exact: true }).click();
    const justMine = question(page, 'Make My Codex just yours?');
    await expect(justMine).toBeVisible();
    await frames(page);
    trace.push(await observe(page, fixtures, 'just mine asked'));
    await capture('p42-pool-just-mine', { surface: justMine });
    await button(justMine, 'Cancel').click();
    await expect(justMine).toHaveCount(0);
    trace.push(await observe(page, fixtures, 'just mine cancelled'));

    await who.getByRole('switch', { name: 'They can add their own API keys' }).click();
    await expect.poll(() => fixtures.requests.some((r) => r.method === 'PATCH' && r.body?.membersCanAdd === false)).toBe(true);
    trace.push(await observe(page, fixtures, 'rule switched'));

    await button(who, 'Add people').click();
    const share = dialog(page, 'Share My Codex');
    await expect(share).toBeVisible();
    await share.getByRole('combobox', { name: 'People to add' }).click();
    await share.getByRole('combobox', { name: 'People to add' }).pressSequentially('zhang@example.test,');
    await frames(page);
    trace.push(await observe(page, fixtures, 'share'));
    await capture('p42-pool-share', { surface: share, emails: share.locator(SELECT) });
    await button(share, 'Share').click();
    const added = notifications(page).getByText('Added to My Codex', { exact: true });
    await expect(added).toBeVisible();
    trace.push(await observe(page, fixtures, 'shared'));
    await expect(added).toHaveCount(0);

    await button(page, 'Replace key').click();
    const replace = dialog(page, 'Replace lin-proj');
    await expect(replace).toBeVisible();
    await frames(page);
    trace.push(await observe(page, fixtures, 'replace key'));
    await capture('p42-pool-replace-key', { surface: replace });
    await button(replace, 'Cancel').click();
    await expect(replace).toHaveCount(0);

    await page.getByRole('button', { name: /Sign out reviewer@example\.test/ }).click();
    const signOut = question(page, 'Sign out reviewer@example.test?');
    await expect(signOut).toBeVisible();
    await frames(page);
    trace.push(await observe(page, fixtures, 'sign-out asked'));
    await capture('p42-pool-signout', { question: signOut });
    await page.keyboard.press('Escape');
    await expect(signOut).toHaveCount(0);
    trace.push(await observe(page, fixtures, 'sign-out dismissed'));
    await attachTrace(testInfo, trace);
  });

  test('adding to a Codex pool: the kind, a key, and signing ChatGPT in', async ({ evidence }, testInfo) => {
    const { page, capture } = evidence;
    const fixtures = await installP42Fixtures(page, { theme: testInfo.project.use.colorScheme });
    const trace = [];
    await page.goto(P42_PATHS.codexPool);
    await button(page, 'Add account').click();
    const kind = dialog(page, 'Add an account to My Codex');
    await expect(kind).toBeVisible();
    await frames(page);
    trace.push(await observe(page, fixtures, 'which kind'));
    await capture('p42-pool-add-kind', { surface: kind });
    await kind.getByText('Paste an OpenAI API key', { exact: true }).click();
    await button(kind, 'Continue').click();
    const addKey = dialog(page, 'Add a key to My Codex');
    await expect(addKey).toBeVisible();
    await frames(page);
    trace.push(await observe(page, fixtures, 'add a key: consent'));
    await capture('p42-pool-add-key', { surface: addKey });
    await button(addKey, 'Continue').click();
    await expect(addKey.getByRole('textbox', { name: 'Limit' })).toBeVisible();
    await fill(addKey.getByRole('textbox', { name: 'Name' }), 'review-key');
    await fill(addKey.getByLabel('Key', { exact: true }), 'sk-proj-fixture-AB12');
    await fill(addKey.getByRole('textbox', { name: 'Limit' }), '25');
    await frames(page);
    trace.push(await observe(page, fixtures, 'add a key: form'));
    await capture('p42-pool-add-key-form', { surface: addKey, limit: addKey.locator('.ant-input-affix-wrapper, .orbit-input-affix').last() });
    await button(addKey, 'Cancel').click();
    await expect(addKey).toHaveCount(0);

    await button(page, 'Add account').click();
    await button(dialog(page, 'Add an account to My Codex'), 'Continue').click();
    const signIn = dialog(page, 'Sign in with ChatGPT');
    await expect(signIn).toBeVisible();
    await frames(page);
    trace.push(await observe(page, fixtures, 'sign in: consent'));
    await capture('p42-codex-signin', { surface: signIn });
    await button(signIn, 'Get a code').click();
    await expect(signIn.getByText(DEVICE_CODE.code, { exact: true })).toBeVisible();
    await frames(page);
    trace.push(await observe(page, fixtures, 'sign in: code'));
    await capture('p42-codex-signin-code', { surface: signIn, code: signIn.getByText(DEVICE_CODE.code, { exact: true }) });
    await button(signIn, 'Cancel').click();
    await expect(signIn).toHaveCount(0);
    await expect.poll(() => fixtures.requests.some((r) => r.method === 'DELETE' && r.path.endsWith('/codex-login'))).toBe(true);
    trace.push(await observe(page, fixtures, 'sign in given up'));
    await attachTrace(testInfo, trace);
  });

  test('a pool somebody added the reader to: leaving it', async ({ evidence }, testInfo) => {
    const { page, capture } = evidence;
    const fixtures = await installP42Fixtures(page, { theme: testInfo.project.use.colorScheme });
    const trace = [];
    await page.goto(P42_PATHS.teamPool);
    const leave = button(page, 'Leave pool');
    await expect(leave).toBeVisible();
    trace.push(await observe(page, fixtures, 'open'));
    await capture('p42-pool-member', { card: page.locator('.pool-detail') });
    await leave.click();
    const ask = question(page, 'Leave Team keys?');
    await expect(ask).toBeVisible();
    await frames(page);
    trace.push(await observe(page, fixtures, 'leave asked'));
    await capture('p42-pool-leave', { question: ask });
    await button(ask, 'Leave').click();
    await page.waitForURL('**/providers');
    await expect(notifications(page).getByText('You left Team keys', { exact: true })).toBeVisible();
    trace.push(await observe(page, fixtures, 'left'));
    await attachTrace(testInfo, trace);
  });
});

/** A runner card on the Runners list, by the name it shows. */
const runnerCard = (page, name) => page.locator('.runner-card').filter({ has: page.locator('.runner-name', { hasText: new RegExp(`^${escape(name)}$`) }) });

test.describe('P4.2 runners', () => {
  test('the list: loading, its menu, rename, token rotation and delete', async ({ evidence }, testInfo) => {
    const { page, capture } = evidence;
    const fixtures = await installP42Fixtures(page, { theme: testInfo.project.use.colorScheme });
    const trace = [];
    fixtures.state.holdRunners = gate();
    await page.goto(P42_PATHS.runners);
    await expect(page.getByRole('heading', { name: 'Runners', exact: true })).toBeVisible();
    await expect(page.locator('.ant-spin, .orbit-spinner').first()).toBeVisible();
    await frames(page);
    trace.push(await observe(page, fixtures, 'loading'));
    await capture('p42-runners-loading', { spinner: page.locator('.ant-spin, .orbit-spinner').first() });
    fixtures.state.holdRunners.open();
    fixtures.state.holdRunners = null;

    const studio = runnerCard(page, 'Studio Mac');
    await expect(studio).toBeVisible();
    trace.push(await observe(page, fixtures, 'list'));
    await capture('p42-runners', { card: studio, register: button(page, 'Register Runner') });

    await studio.hover();
    await studio.locator('.runner-kebab').click();
    await expect(item(page, 'Rotate token')).toBeVisible();
    await frames(page);
    trace.push(await observe(page, fixtures, 'menu'));
    await capture('p42-runner-menu', { menu: openMenu(page) });
    await item(page, 'Rename').click();
    const rename = dialog(page, 'Rename runner');
    await expect(rename).toBeVisible();
    await frames(page);
    trace.push(await observe(page, fixtures, 'rename'));
    await capture('p42-runner-rename', { surface: rename });
    await fill(rename.getByRole('textbox'), 'Studio');
    await rename.getByRole('textbox').press('Enter');
    await expect(rename).toHaveCount(0);
    await expect(runnerCard(page, 'Studio')).toBeVisible();
    trace.push(await observe(page, fixtures, 'renamed'));

    await runnerCard(page, 'Studio').hover();
    await runnerCard(page, 'Studio').locator('.runner-kebab').click();
    await item(page, 'Rotate token').click();
    const rotate = question(page, 'Rotate token for “Studio”?');
    await expect(rotate).toBeVisible();
    await frames(page);
    trace.push(await observe(page, fixtures, 'rotate asked'));
    await capture('p42-runner-rotate', { surface: rotate });
    await button(rotate, 'Rotate token').click();
    const token = dialog(page, 'New runner token');
    await expect(token.getByText(ROTATED_TOKEN, { exact: true })).toBeVisible();
    await frames(page);
    trace.push(await observe(page, fixtures, 'token shown'));
    await capture('p42-runner-token', { surface: token });
    await button(token, 'Done').click();
    await expect(token).toHaveCount(0);

    await runnerCard(page, 'old-laptop').hover();
    await runnerCard(page, 'old-laptop').locator('.runner-kebab').click();
    await item(page, 'Delete').click();
    const remove = question(page, 'Delete “old-laptop”?');
    await expect(remove).toBeVisible();
    await frames(page);
    trace.push(await observe(page, fixtures, 'delete asked'));
    await capture('p42-runner-delete', { surface: remove });
    await button(remove, 'Delete').click();
    await expect(runnerCard(page, 'old-laptop')).toHaveCount(0);
    trace.push(await observe(page, fixtures, 'deleted'));

    fixtures.state.runners = [];
    await page.reload();
    await expect(page.getByText('No runners yet — register a machine to get started.', { exact: true })).toBeVisible();
    await frames(page);
    trace.push(await observe(page, fixtures, 'no runners'));
    await capture('p42-runners-empty', { register: button(page, 'Register Runner') });
    await attachTrace(testInfo, trace);
  });

  test('the register guide: each system', async ({ evidence }, testInfo) => {
    const { page, capture } = evidence;
    const fixtures = await installP42Fixtures(page, { theme: testInfo.project.use.colorScheme });
    const trace = [];
    await page.goto(P42_PATHS.register);
    await expect(page.getByRole('heading', { name: 'Add a runner', exact: true })).toBeVisible();
    trace.push(await observe(page, fixtures, 'open'));
    await capture('p42-register', { os: page.locator('.runner-os') });
    await page.locator('.runner-os').getByText('Windows', { exact: true }).click();
    await expect(page.locator('.runner-cmd-text')).toContainText('install.ps1');
    await frames(page);
    trace.push(await observe(page, fixtures, 'windows'));
    await capture('p42-register-windows', { os: page.locator('.runner-os') });
    await attachTrace(testInfo, trace);
  });
});

/** A workspace row on a runner's page, by its name. */
const workspaceRow = (page, name) => page.locator('.rd-workspace-row').filter({ has: page.locator('.rd-workspace-name', { hasText: new RegExp(`^${escape(name)}`) }) });

test.describe('P4.2 a runner’s page', () => {
  test('its menus, a workspace’s settings and the discard question', async ({ evidence }, testInfo) => {
    const { page, capture } = evidence;
    const fixtures = await installP42Fixtures(page, { theme: testInfo.project.use.colorScheme });
    const trace = [];
    await page.goto(P42_PATHS.studio);
    const web = workspaceRow(page, 'orbit-web');
    await expect(web).toBeVisible();
    trace.push(await observe(page, fixtures, 'open'));
    const actions = button(page.locator('.rd-title-row'), 'Actions');
    await capture('p42-runner-detail', { actions, docs: workspaceRow(page, 'docs-site') });

    await actions.click();
    await expect(item(page, 'Rotate token')).toBeVisible();
    await frames(page);
    trace.push(await observe(page, fixtures, 'actions menu'));
    await capture('p42-runner-actions', { menu: openMenu(page) });
    await page.keyboard.press('Escape');
    await expect(item(page, 'Rotate token')).toHaveCount(0);

    await web.locator('button[title="Actions"]').click();
    await expect(item(page, 'Open console')).toBeVisible();
    await frames(page);
    trace.push(await observe(page, fixtures, 'workspace menu'));
    await capture('p42-workspace-menu', { menu: openMenu(page) });
    await item(page, 'Configure').click();
    const form = page.locator('.rd-workspace-form');
    await expect(form).toBeVisible();
    await top(web);
    await frames(page);
    trace.push(await observe(page, fixtures, 'editing'));
    await capture('p42-workspace-edit', { form });

    await form.locator('.rd-adv-toggle').click();
    await expect(form.getByPlaceholder('KEY', { exact: true })).toBeVisible();
    // Advanced asks for its Always allowed list as it opens: the answer is in before the page scrolls.
    await expect(form.getByText(/^Nothing yet\./)).toBeVisible();
    await top(form.locator('.rd-adv-toggle'));
    await frames(page);
    trace.push(await observe(page, fixtures, 'advanced'));
    await capture('p42-workspace-advanced', { env: form.locator('.rd-env-row').first(), add: button(form, 'Add variable') });

    await fill(form.getByPlaceholder('e.g. tea-cli builder', { exact: true }), 'orbit-web-2');
    await button(form, 'Cancel').click();
    const discard = question(page, 'Discard unsaved changes?');
    await expect(discard).toBeVisible();
    await frames(page);
    trace.push(await observe(page, fixtures, 'discard asked'));
    await capture('p42-workspace-discard', { surface: discard });
    await button(discard, 'Keep editing').click();
    await expect(discard).toHaveCount(0);
    await expect(form).toBeVisible();
    trace.push(await observe(page, fixtures, 'kept editing'));
    await button(form, 'Save').click();
    await expect(form).toHaveCount(0);
    trace.push(await observe(page, fixtures, 'saved'));
    await attachTrace(testInfo, trace);
  });

  test('a new workspace with the directory’s Claude history', async ({ evidence }, testInfo) => {
    const { page, capture } = evidence;
    const fixtures = await installP42Fixtures(page, { theme: testInfo.project.use.colorScheme });
    const trace = [];
    await page.goto(P42_PATHS.studio);
    await button(page, 'Add workspace').click();
    const form = page.locator('.rd-workspace-form-new');
    await expect(form).toBeVisible();
    await fill(form.getByPlaceholder('e.g. tea-cli builder', { exact: true }), 'notes');
    await fill(form.getByPlaceholder('/path/to/project on the runner (optional)', { exact: true }), HISTORY_DIR);
    const offer = form.locator('.rd-history-panel');
    await expect(offer).toBeVisible({ timeout: 15_000 });
    await form.getByText('All 2', { exact: true }).click();
    await top(form.locator('.rd-form-section').filter({ hasText: 'Local Claude Code history' }));
    await frames(page);
    trace.push(await observe(page, fixtures, 'history offered, all picked'));
    await capture('p42-workspace-history', { offer, choices: offer.locator('.rd-history-choices') });
    await button(form, 'Create').click();
    await expect(notifications(page).getByText('Importing 2 conversations — they appear as they land.', { exact: true })).toBeVisible();
    trace.push(await observe(page, fixtures, 'created and importing'));
    await attachTrace(testInfo, trace);
  });

  test('capacity: max concurrent, keep free and rename', async ({ evidence }, testInfo) => {
    const { page, capture } = evidence;
    const fixtures = await installP42Fixtures(page, { theme: testInfo.project.use.colorScheme });
    const trace = [];
    await page.goto(P42_PATHS.studio);
    const capacity = page.locator('.rd-capacity');
    const max = capacity.getByRole('spinbutton');
    await expect(max).toHaveValue('4');
    await top(capacity);
    await max.hover();
    await frames(page);
    trace.push(await observe(page, fixtures, 'capacity'));
    await capture('p42-capacity', { number: capacity.locator(NUMBER), keepFree: capacity.locator(SELECT) });
    await fill(max, '99');
    await max.press('Enter');
    await expect(max).toHaveValue('64');
    await expect.poll(() => fixtures.requests.some((r) => r.method === 'PATCH' && r.body?.maxConcurrent === 64)).toBe(true);
    trace.push({ ...(await observe(page, fixtures, '99 then Enter')), value: await max.inputValue() });
    await fill(max, '2.6');
    await max.press('Tab');
    await expect(max).toHaveValue('3');
    trace.push({ ...(await observe(page, fixtures, '2.6 then Tab')), value: await max.inputValue() });

    await capacity.getByRole('combobox').click();
    const tier = page.locator(SELECT_OPTION).filter({ visible: true }).filter({ hasText: /^20 GB$/ });
    await expect(tier).toBeVisible();
    await frames(page);
    trace.push({ ...(await observe(page, fixtures, 'keep free open')), options: await page.locator(SELECT_OPTION).filter({ visible: true }).allTextContents() });
    await capture('p42-keep-free-open', { select: capacity.locator(SELECT), option: tier });
    await tier.click();
    await expect(capacity.locator(SELECT)).toContainText('20 GB');
    trace.push(await observe(page, fixtures, 'keep free 20 GB'));

    await page.locator('.rd-about').getByRole('button', { name: 'Rename', exact: true }).click();
    const rename = dialog(page, 'Rename runner');
    await expect(rename).toBeVisible();
    await fill(rename.getByRole('textbox'), '');
    await button(rename, 'Save').click();
    await expect(rename).toHaveCount(0);
    trace.push(await observe(page, fixtures, 'renamed to the machine name'));
    await attachTrace(testInfo, trace);
  });

  test('an offline runner: what needs attention', async ({ evidence }, testInfo) => {
    const { page, capture } = evidence;
    const fixtures = await installP42Fixtures(page, { theme: testInfo.project.use.colorScheme });
    await page.goto(P42_PATHS.laptop);
    const attention = page.locator('.rd-attention');
    await expect(attention).toBeVisible();
    await capture('p42-runner-offline', { attention });
    await attachTrace(testInfo, [await observe(page, fixtures, 'open')]);
  });
});

test.describe('P4.2 approving orbit register', () => {
  test('loading, the machine, a name already registered, approved and a dead code', async ({ evidence }, testInfo) => {
    const { page } = evidence;
    const capture = captureOf(evidence, testInfo);
    const press = pressOf(testInfo);
    const fixtures = await installP42Fixtures(page, { theme: testInfo.project.use.colorScheme });
    const trace = [];
    fixtures.state.holdDevice = gate();
    await page.goto(P42_PATHS.enroll);
    await expect(page.locator('.ant-spin, .orbit-spinner').first()).toBeVisible();
    await frames(page);
    trace.push(await observe(page, fixtures, 'loading'));
    await capture('p42-enroll-loading', { card: page.locator(CARD) });
    fixtures.state.holdDevice.open();
    fixtures.state.holdDevice = null;
    const approve = button(page, 'Approve');
    await expect(approve).toBeVisible();
    trace.push(await observe(page, fixtures, 'the machine'));
    await capture('p42-enroll', { card: page.locator(CARD), approve });
    await press(approve);
    await expect(page.getByText('Machine approved', { exact: true })).toBeVisible();
    await frames(page);
    trace.push(await observe(page, fixtures, 'approved'));
    await capture('p42-enroll-approved', { card: page.locator(CARD) });

    fixtures.state.device = { ...fixtures.state.device, status: 'PENDING', nameConflict: true };
    await page.reload();
    const again = button(page, 'Re-register machine');
    await expect(again).toBeVisible();
    trace.push(await observe(page, fixtures, 'name already registered'));
    await capture('p42-enroll-conflict', { card: page.locator(CARD), again });

    fixtures.state.deviceError = 'enrollment code not found or expired — run `orbit register` again';
    await page.reload();
    await expect(page.getByText('Cannot register', { exact: true })).toBeVisible();
    await frames(page);
    trace.push(await observe(page, fixtures, 'dead code'));
    await capture('p42-enroll-error', { card: page.locator(CARD) });
    await attachTrace(testInfo, trace);
  });
});

/** A user's row in the Users table, by email. */
const userRow = (page, email) => page.locator('tr').filter({ has: page.getByText(email, { exact: true }) });

test.describe('P4.2 users', () => {
  test('the table: loading, reset password, a one-time password and delete', async ({ evidence }, testInfo) => {
    const { page, capture } = evidence;
    const fixtures = await installP42Fixtures(page, { theme: testInfo.project.use.colorScheme });
    const trace = [];
    fixtures.state.holdUsers = gate();
    await page.goto(P42_PATHS.admin);
    await expect(page.getByRole('heading', { name: 'Users', exact: true })).toBeVisible();
    await expect(page.locator('.ant-spin, .orbit-spinner').first()).toBeVisible();
    await frames(page);
    trace.push(await observe(page, fixtures, 'loading'));
    await capture('p42-users-loading', { table: page.locator(TABLE) });
    fixtures.state.holdUsers.open();
    fixtures.state.holdUsers = null;

    const dev = userRow(page, 'dev@example.test');
    await expect(dev).toBeVisible();
    await frames(page);
    trace.push({ ...(await observe(page, fixtures, 'users')), rows: await page.locator('tbody tr').allInnerTexts() });
    await capture('p42-users', { table: page.locator(TABLE), row: dev });

    await button(dev, 'Reset password').click();
    const reset = question(page, 'Reset dev@example.test\'s password?');
    await expect(reset).toBeVisible();
    await frames(page);
    trace.push(await observe(page, fixtures, 'reset asked'));
    await capture('p42-users-reset', { question: reset });
    await button(reset, 'OK').click();
    const issued = question(page, 'Password reset for dev@example.test');
    await expect(issued.getByText(ONE_TIME_PASSWORD, { exact: true })).toBeVisible();
    await frames(page);
    trace.push(await observe(page, fixtures, 'one-time password'));
    await capture('p42-users-password', { surface: issued });
    await button(issued, 'OK').click();
    await expect(issued).toHaveCount(0);
    trace.push(await observe(page, fixtures, 'password dismissed'));

    await button(dev, 'Make admin').click();
    const updated = notifications(page).getByText('Role updated', { exact: true });
    await expect(updated).toBeVisible();
    trace.push(await observe(page, fixtures, 'role updated'));
    await expect(updated).toHaveCount(0);

    const ops = userRow(page, 'ops@example.test');
    await button(ops, 'Delete').click();
    const remove = question(page, 'Delete ops@example.test?');
    await expect(remove).toBeVisible();
    await frames(page);
    trace.push(await observe(page, fixtures, 'delete asked'));
    await capture('p42-users-delete', { question: remove });
    await button(remove, 'OK').click();
    await expect(notifications(page).getByText('User deleted', { exact: true })).toBeVisible();
    trace.push(await observe(page, fixtures, 'deleted'));

    fixtures.state.users = [];
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Users', exact: true })).toBeVisible();
    await expect(page.locator('tbody tr')).toHaveCount(1);
    await frames(page);
    trace.push(await observe(page, fixtures, 'no users'));
    await capture('p42-users-empty', { table: page.locator(TABLE) });
    await attachTrace(testInfo, trace);
  });

  test('adding a user: with a password, and Google only', async ({ evidence }, testInfo) => {
    const { page, capture } = evidence;
    const fixtures = await installP42Fixtures(page, { theme: testInfo.project.use.colorScheme });
    const trace = [];
    await page.goto(P42_PATHS.admin);
    await expect(userRow(page, 'dev@example.test')).toBeVisible();
    await button(page, 'Add user').click();
    const add = dialog(page, 'Add user');
    await expect(add).toBeVisible();
    await frames(page);
    trace.push(await observe(page, fixtures, 'add user'));
    await capture('p42-users-add', { surface: add, email: add.getByPlaceholder('Email', { exact: true }) });
    await fill(add.getByPlaceholder('Email', { exact: true }), 'new@example.test');
    await fill(add.getByPlaceholder('Name (optional)', { exact: true }), 'New Person');
    await add.getByRole('checkbox', { name: 'Google sign-in only' }).click();
    await expect(add.getByText('No password is set: they sign in with the Google account of this email address. That address must be a '
      + 'Gmail or Google Workspace address — Google has to vouch for it. Any other address leaves this account with no way to sign in: '
      + 'give them a password instead.', { exact: true })).toBeVisible();
    await frames(page);
    trace.push(await observe(page, fixtures, 'google only'));
    await capture('p42-users-add-google', { surface: add });
    await button(add, 'Create').click();
    await expect(notifications(page).getByText('Created new@example.test', { exact: true })).toBeVisible();
    await expect(add).toHaveCount(0);
    trace.push(await observe(page, fixtures, 'created'));

    await button(page, 'Add user').click();
    await fill(dialog(page, 'Add user').getByPlaceholder('Email', { exact: true }), 'second@example.test');
    await dialog(page, 'Add user').getByPlaceholder('Email', { exact: true }).press('Enter');
    trace.push(await observe(page, fixtures, 'enter in the email field'));
    await button(dialog(page, 'Add user'), 'Create').click();
    const issued = question(page, 'Created second@example.test');
    await expect(issued.getByText(ONE_TIME_PASSWORD, { exact: true })).toBeVisible();
    trace.push(await observe(page, fixtures, 'created with a one-time password'));
    await button(issued, 'OK').click();
    await attachTrace(testInfo, trace);
  });

  test('disabling an account and enabling it again: who is offered what, a refusal, the question, disabled and enabled', async ({ evidence }, testInfo) => {
    const { page, capture } = evidence;
    const fixtures = await installP42Fixtures(page, { theme: testInfo.project.use.colorScheme });
    const trace = [];
    await page.goto(P42_PATHS.admin);
    const dev = userRow(page, 'dev@example.test');
    await expect(dev).toBeVisible();
    // The signed-in administrator's own row offers neither; a disabled account offers Enable.
    await expect(button(userRow(page, 'reviewer@example.test'), 'Disable')).toHaveCount(0);
    await expect(button(userRow(page, 'former@example.test'), 'Enable')).toBeVisible();
    trace.push({ ...(await observe(page, fixtures, 'status')), rows: await page.locator('tbody tr').allInnerTexts() });

    // A refusal (the account was deleted meanwhile) is said in the question itself, and nothing changes.
    fixtures.state.disableRefusals = { [P42_IDS.ops]: 'user not found' };
    await button(userRow(page, 'ops@example.test'), 'Disable').click();
    const askOps = question(page, 'Disable ops@example.test?');
    await expect(askOps).toBeVisible();
    await button(askOps, 'Disable').click();
    await expect(askOps.getByRole('alert')).toHaveText('user not found');
    await frames(page);
    trace.push(await observe(page, fixtures, 'disable refused'));
    await capture('p42-users-disable-refused', { question: askOps });
    await button(askOps, 'Cancel').click();
    await expect(askOps).toHaveCount(0);

    // Disable asks first and says what stops working; then the row reads Disabled and offers Enable.
    await button(dev, 'Disable').click();
    const ask = question(page, 'Disable dev@example.test?');
    await expect(ask).toBeVisible();
    await frames(page);
    trace.push(await observe(page, fixtures, 'disable asked'));
    await capture('p42-users-disable', { question: ask });
    await button(ask, 'Disable').click();
    await expect(notifications(page).getByText('Account disabled', { exact: true })).toBeVisible();
    await expect(button(dev, 'Enable')).toBeVisible();
    await expect(ask).toHaveCount(0);
    await frames(page);
    trace.push(await observe(page, fixtures, 'disabled'));
    await capture('p42-users-disabled', { row: dev });

    // Enable lets the account back in at once, without asking.
    await button(dev, 'Enable').click();
    await expect(notifications(page).getByText('Account enabled', { exact: true })).toBeVisible();
    await expect(button(dev, 'Disable')).toBeVisible();
    trace.push(await observe(page, fixtures, 'enabled'));
    await attachTrace(testInfo, trace);
  });
});

test.describe('P4.2 the pages’ own button styles', () => {
  // Buttons whose look the pages set themselves (index.css): what they are at rest, under the pointer
  // and pressed, as computed values. Pressing releases elsewhere, so nothing is sent.
  test('at rest, under the pointer and pressed', async ({ evidence }, testInfo) => {
    test.skip(phone(testInfo), 'A pointer state: desktop only.');
    const { page } = evidence;
    const fixtures = await installP42Fixtures(page, { theme: testInfo.project.use.colorScheme });
    const states = [];
    const read = (locator) => locator.evaluate((el) => {
      const s = getComputedStyle(el);
      return { color: s.color, background: s.backgroundColor, border: s.borderColor, shadow: s.boxShadow, opacity: s.opacity, width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height };
    });
    // The replaced controls ease their colours over 0.2–0.3s even with reduced motion asked for.
    const settle = () => page.waitForTimeout(450);
    async function sample(name, locator) {
      await locator.scrollIntoViewIfNeeded();
      await page.mouse.move(0, 0);
      await settle();
      const rest = await read(locator);
      await locator.hover();
      await settle();
      const hover = await read(locator);
      await page.mouse.down();
      await settle();
      const active = await read(locator);
      await page.mouse.move(0, 0);
      await page.mouse.up();
      await settle();
      states.push({ name, rest, hover, active });
    }
    await page.goto(P42_PATHS.providers);
    const claude = engineRow(page, 'Claude Code');
    await expect(claude).toBeVisible();
    await sample('engines: Add account', button(claude, 'Add account'));
    await sample('engines: Install', button(engineRow(page, 'Kimi Code'), 'Install'));
    await sample('engines: More actions', button(engineRow(page, 'Work'), 'More actions'));
    await button(engineRow(page, 'Work'), 'More actions').click();
    await expect(item(page, 'Rename')).toBeVisible();
    await settle();
    states.push({ name: 'engines: More actions, its menu open', rest: await read(button(engineRow(page, 'Work'), 'More actions')) });
    await item(page, 'Rename').hover();
    await settle();
    states.push({ name: 'engines: menu item under the pointer', rest: await read(item(page, 'Rename')) });
    await page.keyboard.press('Escape');
    await page.goto(P42_PATHS.codexPool);
    await sample('pool: Sign out', page.getByRole('button', { name: /Sign out reviewer@example\.test/ }));
    await page.goto(P42_PATHS.studio);
    await workspaceRow(page, 'orbit-web').click();
    await sample('workspace: Disable workspace', button(page.locator('.rd-workspace-form'), 'Disable workspace'));
    await attachTrace(testInfo, [{ step: 'button states', states, requests: fixtures.requests.splice(0) }]);
  });
});
