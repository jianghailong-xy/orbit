import { test, expect } from './harness.mjs';
import { PATHS } from './fixtures.mjs';
import { installPilotFixtures, PILOT_IDS, PILOT_PATHS, REOPEN_ERROR, UPLOAD_ERROR } from './pilot-fixtures.mjs';

// P3.2 pilot states the P0 matrix does not reach: every task-panel field and picker, dependencies,
// task inputs, the delete/remove questions, comments, the stopped task's Reopen question, the share
// dialog's other states, and the workspace account picker. Locators are roles, accessible names and
// the pages' own classes only, so the same file drives the replaced controls (same-commit reference
// tree) and the Orbit ones: screenshots, computed styles and the requests each press sends are then
// compared between the two runs. Each step's observation is attached as `trace`.

const frames = (page) => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const field = (page, label) => page.locator('.tdp-field').filter({ has: page.locator('.tdp-field-label', { hasText: new RegExp(`^${label}$`) }) });
const picker = (page, label) => field(page, label).getByRole('combobox');
// The replaced select also keeps an off-screen list of options for screen readers; the one a person
// picks from is the visible one.
const options = (page) => page.getByRole('option').filter({ visible: true });
const option = (page, name) => page.getByRole('option', { name, exact: typeof name === 'string' }).filter({ visible: true });
// A dialog's painted box for the style comparison: the replaced modal draws it on an inner
// container under its role=dialog wrapper, the Orbit dialog on the role=dialog element itself.
const DIALOG_SURFACE = '.ant-modal-container, .orbit-overlay';

/** Where focus is, what is open and which pilot requests were sent: one trace row per step. */
async function observe(page, pilot, step) {
  const state = await page.evaluate(() => {
    const active = document.activeElement;
    const named = (el) => el && (el.getAttribute('aria-label') || document.getElementById(el.getAttribute('aria-labelledby') ?? '')?.textContent || el.textContent?.trim().slice(0, 60));
    const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
    return {
      focus: active && active !== document.body ? { role: active.getAttribute('role') ?? active.tagName.toLowerCase(), name: named(active) } : 'body',
      dialogs: [...document.querySelectorAll('[role="dialog"]')].filter(visible).map(named),
      listbox: [...document.querySelectorAll('[role="listbox"] [role="option"]')].filter(visible).map((o) => ({ name: o.textContent, selected: o.getAttribute('aria-selected') === 'true' })),
      menu: [...document.querySelectorAll('[role="menuitem"]')].filter(visible).map((o) => o.textContent),
      alerts: [...document.querySelectorAll('[role="alert"]')].filter(visible).map((o) => o.textContent),
      panel: document.querySelectorAll('.task-detail-panel').length,
    };
  });
  return { step, ...state, requests: pilot.requests.splice(0).filter((r) => r.method !== 'GET').map(({ method, path, body }) => ({ method, path, body })) };
}

test.describe('task detail pilot', () => {
  test('fields, pickers and the panel header', async ({ evidence }, testInfo) => {
    const { page, capture } = evidence;
    const pilot = await installPilotFixtures(page, { theme: testInfo.project.use.colorScheme });
    const trace = [];
    await page.goto(PILOT_PATHS.task);
    const panel = page.locator('.task-detail-panel');
    await expect(page.getByText('Migrate the task detail pilot', { exact: true }).last()).toBeVisible();
    await expect(field(page, 'Suggested')).toContainText('M · Sonnet 5.5 · medium');
    await expect(panel.locator('.tdp-input-thumb[src]')).toHaveCount(1);
    await capture('pilot-detail', { panel, assignee: picker(page, 'Assignee'), suggested: field(page, 'Suggested') });
    trace.push(await observe(page, pilot, 'idle'));

    await field(page, 'Assignee').locator('.tdp-assignee-select').hover();
    await capture('pilot-field-hover', { assignee: field(page, 'Assignee') });
    await page.mouse.move(0, 0);

    // Each picker open, as a press opens it; then closed with Escape, which must leave the panel.
    for (const [label, state] of [['Assignee', 'assignee'], ['Suggested', 'suggested'], ['Provider', 'provider'], ['Model', 'model'], ['List', 'list']]) {
      await picker(page, label).click();
      await expect(page.getByRole('listbox').filter({ visible: true })).toBeVisible();
      await expect(options(page).first()).toBeVisible();
      await capture(`pilot-${state}-open`, { listbox: page.getByRole('listbox').filter({ visible: true }), field: field(page, label) });
      trace.push(await observe(page, pilot, `${state} open`));
      await page.keyboard.press('Escape');
      await expect(page.getByRole('listbox').filter({ visible: true })).toHaveCount(0);
      await frames(page);
      trace.push(await observe(page, pilot, `${state} Escape`));
      // The old picker also closed the panel on that Escape; the trace records which happened.
      if (!(await panel.count())) {
        await page.goto(PILOT_PATHS.task);
        await expect(panel.locator('.tdp-input-thumb[src]')).toHaveCount(1);
      }
    }

    // A search narrows the list; a pick writes the field; re-picking the value it has writes nothing.
    await picker(page, 'List').click();
    await page.keyboard.type('lat');
    await expect(options(page)).toHaveCount(1);
    await capture('pilot-list-search', { listbox: page.getByRole('listbox').filter({ visible: true }) });
    await option(page, 'Later').click();
    await expect(field(page, 'List')).toContainText('Later');
    trace.push(await observe(page, pilot, 'list pick Later'));
    await picker(page, 'List').click();
    await option(page, 'Later').click();
    await expect(page.getByRole('listbox').filter({ visible: true })).toHaveCount(0);
    trace.push(await observe(page, pilot, 'list re-pick Later'));
    await picker(page, 'Suggested').click();
    await option(page, /^L · Opus 5\.5 · high/).click();
    await expect(field(page, 'Suggested')).toContainText('L · Opus 5.5 · high');
    trace.push(await observe(page, pilot, 'suggested pick L'));
    await picker(page, 'Model').click();
    await option(page, 'Sonnet 5.5').click();
    trace.push(await observe(page, pilot, 'model pick Sonnet'));
    // Clearing: the field's clear control, shown on hover.
    await field(page, 'List').locator('.tdp-assignee-select').hover();
    await field(page, 'List').getByRole('button', { name: /clear/i }).click();
    await expect(field(page, 'List')).toContainText('No list');
    trace.push(await observe(page, pilot, 'list clear'));

    // Run now is blocked by an open prerequisite: its hint, on the pointer.
    await page.mouse.move(0, 0);
    await panel.locator('.tdp-head-actions span').first().hover();
    await expect(page.getByRole('tooltip')).toBeVisible();
    await expect(page.getByRole('tooltip')).toHaveText('Waiting for prerequisites');
    await capture('pilot-run-hint', { tooltip: page.getByRole('tooltip') });
    await page.mouse.move(0, 0);

    // Delete asks first; Cancel leaves everything as it was.
    await page.getByRole('button', { name: /Delete task/ }).click();
    await expect(page.getByText('Delete this task?', { exact: true })).toBeVisible();
    await capture('pilot-delete-confirm', { question: page.getByText('Delete this task?', { exact: true }) });
    trace.push(await observe(page, pilot, 'delete asked'));
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.getByText('Delete this task?', { exact: true })).toBeHidden();
    trace.push(await observe(page, pilot, 'delete cancelled'));
    await testInfo.attach('trace', { body: JSON.stringify(trace, null, 2), contentType: 'application/json' });
  });

  test('dependencies, inputs and comments', async ({ evidence }, testInfo) => {
    const { page, capture } = evidence;
    const pilot = await installPilotFixtures(page, { theme: testInfo.project.use.colorScheme });
    const trace = [];
    await page.goto(PILOT_PATHS.task);
    const panel = page.locator('.task-detail-panel');
    await expect(panel.locator('.tdp-input-thumb[src]')).toHaveCount(1);
    const dependencies = panel.locator('.tdp-section').filter({ has: page.getByText('Dependencies', { exact: true }) });
    // The graph is a lazy chunk: wait for it, then put the section at the top of the panel's scroll,
    // the same scroll position in both trees whatever was in view before.
    await expect(dependencies.locator('.react-flow__node')).toHaveCount(4);
    await dependencies.evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await capture('pilot-dependencies', { section: dependencies, view: dependencies.getByRole('radiogroup'), auto: page.getByRole('switch') });
    await dependencies.locator('.tdp-dependency-view').getByText('List', { exact: true }).hover();
    await capture('pilot-dependency-view-hover', { view: dependencies.getByRole('radiogroup') });
    await dependencies.locator('.tdp-dependency-view').getByText('List', { exact: true }).click();
    await expect(dependencies.getByRole('radio', { name: 'List' })).toBeChecked();
    await page.mouse.move(0, 0);
    await capture('pilot-dependency-list', { section: dependencies });
    trace.push(await observe(page, pilot, 'dependency list view'));

    await dependencies.getByRole('combobox').click();
    await expect(options(page)).toHaveCount(2);
    await capture('pilot-prerequisite-open', { listbox: page.getByRole('listbox').filter({ visible: true }) });
    await page.keyboard.type('record');
    await expect(options(page)).toHaveCount(1);
    await option(page, 'Record the bundle size').click();
    trace.push(await observe(page, pilot, 'prerequisite added'));
    await page.getByRole('switch').click();
    await expect(page.getByRole('switch')).not.toBeChecked();
    trace.push(await observe(page, pilot, 'auto-run off'));

    const inputs = panel.locator('.tdp-section').filter({ has: page.getByText(/^Inputs \(/) });
    await inputs.evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await capture('pilot-inputs', { section: inputs, add: inputs.getByRole('button', { name: /Add file/ }) });
    const chooser = page.waitForEvent('filechooser');
    await inputs.getByRole('button', { name: /Add file/ }).click();
    await (await chooser).setFiles([
      { name: 'flow.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgo=', 'base64') },
      { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('pilot notes') },
    ]);
    await expect.poll(() => pilot.requests.filter((r) => r.method === 'POST' && r.path === '/api/attachments').length).toBe(2);
    trace.push(await observe(page, pilot, 'two files chosen'));
    await inputs.getByRole('button', { name: /Remove input/ }).first().click();
    await expect(page.getByText('Remove this input?', { exact: true })).toBeVisible();
    await capture('pilot-remove-confirm', { question: page.getByText('Remove this input?', { exact: true }) });
    await page.getByRole('button', { name: 'Remove', exact: true }).click();
    await expect.poll(() => pilot.requests.some((r) => r.method === 'DELETE' && r.path === `/api/attachments/${PILOT_IDS.image}`)).toBe(true);
    trace.push(await observe(page, pilot, 'input removed'));

    const compose = panel.locator('.tdp-compose');
    await panel.locator('.tdp-body').evaluate((el) => { el.scrollTop = 0; });
    await compose.getByRole('textbox').click();
    await page.keyboard.type('Looks right in both themes.');
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('Asking @Orb');
    await expect(compose.locator('.tdp-mention-menu')).toBeVisible();
    await capture('pilot-comment-mention', { compose, menu: compose.locator('.tdp-mention-menu') });
    await page.keyboard.press('Enter');
    await expect(compose.getByRole('textbox')).toHaveValue('Looks right in both themes.\nAsking @Orbit baseline ');
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter');
    await expect(compose.getByRole('textbox')).toHaveValue('');
    trace.push(await observe(page, pilot, 'comment sent'));
    await testInfo.attach('trace', { body: JSON.stringify(trace, null, 2), contentType: 'application/json' });
  });

  test('a failed upload says so and leaves the list as it was', async ({ evidence }, testInfo) => {
    const { page } = evidence;
    const pilot = await installPilotFixtures(page, { theme: testInfo.project.use.colorScheme, upload: 'fail' });
    await page.goto(PILOT_PATHS.task);
    const inputs = page.locator('.task-detail-panel .tdp-section').filter({ has: page.getByText(/^Inputs \(/) });
    await expect(inputs.locator('.tdp-input')).toHaveCount(2);
    const chooser = page.waitForEvent('filechooser');
    await inputs.getByRole('button', { name: /Add file/ }).click();
    await (await chooser).setFiles([{ name: 'flow.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgo=', 'base64') }]);
    await expect(page.getByText("Couldn't upload the file", { exact: true })).toBeVisible();
    await expect(page.getByText(UPLOAD_ERROR, { exact: true })).toBeVisible();
    await expect(inputs.locator('.tdp-input')).toHaveCount(2);
    // Picking the same file again is a second attempt, not "no change".
    const again = page.waitForEvent('filechooser');
    await inputs.getByRole('button', { name: /Add file/ }).click();
    await (await again).setFiles([{ name: 'flow.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgo=', 'base64') }]);
    await expect.poll(() => pilot.requests.filter((r) => r.method === 'POST' && r.path === '/api/attachments').length).toBe(2);
    await testInfo.attach('trace', { body: JSON.stringify([await observe(page, pilot, 'upload refused twice')], null, 2), contentType: 'application/json' });
  });

  test('reopening a stopped task, refused and then backed out of', async ({ evidence }, testInfo) => {
    const { page, capture } = evidence;
    const pilot = await installPilotFixtures(page, { theme: testInfo.project.use.colorScheme });
    const trace = [];
    await page.goto(PILOT_PATHS.done);
    await page.getByRole('button', { name: 'Reopen task' }).click();
    const dialog = page.getByRole('dialog', { name: 'Reopen this task?' });
    await expect(dialog).toBeVisible();
    await capture('pilot-reopen', { surface: DIALOG_SURFACE });
    trace.push(await observe(page, pilot, 'reopen asked'));
    await dialog.getByRole('button', { name: 'Reopen', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText(REOPEN_ERROR);
    await capture('pilot-reopen-refused', { surface: DIALOG_SURFACE, alert: dialog.getByRole('alert') });
    trace.push(await observe(page, pilot, 'reopen refused'));
    await dialog.getByRole('button', { name: 'Back', exact: true }).click();
    await expect(dialog).toBeHidden();
    trace.push(await observe(page, pilot, 'reopen backed out'));
    await page.getByRole('button', { name: 'Reopen task' }).click();
    await expect(page.getByRole('dialog', { name: 'Reopen this task?' }).getByRole('alert')).toHaveCount(0);
    trace.push(await observe(page, pilot, 'reopen asked again'));
    await testInfo.attach('trace', { body: JSON.stringify(trace, null, 2), contentType: 'application/json' });
  });
});

test.describe('share dialog pilot', () => {
  test('from Only you to a public link and back', async ({ evidence }, testInfo) => {
    const { page, capture } = evidence;
    const pilot = await installPilotFixtures(page, { theme: testInfo.project.use.colorScheme });
    const trace = [];
    await page.goto(PILOT_PATHS.task);
    const more = page.getByRole('button', { name: 'More actions', exact: true });
    await more.click();
    await expect(page.getByRole('menuitem', { name: /Share/ })).toBeVisible();
    await page.getByRole('menuitem', { name: /Share/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Share task' });
    await expect(dialog.getByRole('button', { name: 'Access' })).toHaveText(/Only you/);
    await capture('pilot-share-private', { surface: DIALOG_SURFACE, access: dialog.getByRole('button', { name: 'Access' }) });
    trace.push(await observe(page, pilot, 'share opened unshared'));

    await dialog.getByRole('button', { name: 'Access' }).click();
    await expect(page.getByRole('menuitem', { name: /Anyone with the link/ })).toBeVisible();
    await capture('pilot-share-access-menu', { menu: page.getByRole('menu') });
    await page.getByRole('menuitem', { name: /Anyone with the link/ }).click();
    await expect(dialog.getByRole('textbox', { name: 'Public link' })).toBeVisible();
    await page.mouse.move(0, 0);
    await dialog.getByRole('button', { name: 'Access' }).focus();
    await capture('pilot-share-public', { surface: DIALOG_SURFACE, layers: dialog.locator('.share-layers') });
    trace.push(await observe(page, pilot, 'link turned on'));

    await dialog.locator('.share-layer').filter({ hasText: 'Conversations' }).getByRole('checkbox').click();
    await expect(dialog.locator('.share-layer').filter({ hasText: 'Conversations' }).getByRole('checkbox')).toBeChecked();
    await capture('pilot-share-conversations', { layers: dialog.locator('.share-layers') });
    trace.push(await observe(page, pilot, 'conversations on'));

    await dialog.getByRole('combobox', { name: 'Expires' }).click();
    await expect(option(page, '7 days')).toBeVisible();
    await capture('pilot-share-expiry-open', { listbox: page.getByRole('listbox').filter({ visible: true }) });
    await option(page, 'Never').click();
    await expect(page.getByRole('listbox').filter({ visible: true })).toHaveCount(0);
    trace.push(await observe(page, pilot, 'expiry re-picked Never'));
    await dialog.getByRole('combobox', { name: 'Expires' }).click();
    await option(page, '30 days').click();
    await expect(dialog).toContainText('Stops working');
    trace.push(await observe(page, pilot, 'expiry 30 days'));

    await dialog.getByRole('button', { name: 'Access' }).click();
    await page.getByRole('menuitem', { name: /Only you/ }).click();
    await expect(page.getByText('Turn off this link?', { exact: true })).toBeVisible();
    await capture('pilot-share-turn-off', { question: page.getByText('Turn off this link?', { exact: true }) });
    trace.push(await observe(page, pilot, 'turn off asked'));
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.getByText('Turn off this link?', { exact: true })).toBeHidden();
    await expect(dialog.getByRole('textbox', { name: 'Public link' })).toBeVisible();
    trace.push(await observe(page, pilot, 'turn off cancelled'));
    await dialog.getByRole('button', { name: 'Access' }).click();
    await page.getByRole('menuitem', { name: /Only you/ }).click();
    await page.getByRole('button', { name: 'Turn off', exact: true }).click();
    await expect(dialog.getByRole('button', { name: 'Access' })).toHaveText(/Only you/);
    trace.push(await observe(page, pilot, 'turned off'));

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await frames(page);
    trace.push(await observe(page, pilot, 'share Escape'));
    await testInfo.attach('trace', { body: JSON.stringify(trace, null, 2), contentType: 'application/json' });
  });

  test('loading and a read that failed', async ({ evidence }, testInfo) => {
    const { page, capture } = evidence;
    await installPilotFixtures(page, { theme: testInfo.project.use.colorScheme });
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    let reads = 0;
    // The first read of the link (the ⋯ menu's, shared with the dialog) is held, then refused, and so
    // is the app's one automatic retry; the dialog's Retry reads again and gets the answer.
    await page.route(`**/api/tasks/${PILOT_IDS.task}/share`, async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      reads += 1;
      if (reads === 1) await held;
      if (reads <= 2) return route.fulfill({ status: 503, json: { message: 'Fixture: the share link could not be read.' } });
      return route.fallback();
    });
    await page.goto(PILOT_PATHS.task);
    await page.getByRole('button', { name: 'More actions', exact: true }).click();
    await page.getByRole('menuitem', { name: /Share/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Share task' });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('.share-dialog-state')).toBeVisible();
    await capture('pilot-share-loading', { surface: DIALOG_SURFACE, state: dialog.locator('.share-dialog-state') });
    release();
    await expect(dialog.getByRole('button', { name: 'Retry' })).toBeVisible({ timeout: 10_000 });
    await capture('pilot-share-error', { surface: DIALOG_SURFACE, retry: dialog.getByRole('button', { name: 'Retry' }) });
    await dialog.getByRole('button', { name: 'Retry' }).click();
    await expect(dialog.getByRole('button', { name: 'Access' })).toBeVisible();
    await testInfo.attach('trace', { body: JSON.stringify([{ step: 'share reads', reads }], null, 2), contentType: 'application/json' });
  });
});

test.describe('P0 share dialog, focused alike', () => {
  test('same element focused before the shot', async ({ evidence }) => {
    // P0's own scenario presses Tab once; where that lands depends on the dialog's first focus
    // (see the evidence README). Here both trees focus the Access button before the shot.
    const { page, capture } = evidence;
    await page.goto(PATHS.task);
    await page.getByRole('button', { name: 'More actions', exact: true }).click();
    await page.getByRole('menuitem', { name: /Share/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Share task' });
    await expect(dialog.getByRole('textbox', { name: 'Public link' })).toBeVisible();
    await dialog.getByRole('button', { name: 'Access' }).focus();
    await capture('pilot-p0-share-focused', { surface: DIALOG_SURFACE });
  });
});

test.describe('workspace account pilot', () => {
  test('the Claude account picker of a new workspace', async ({ evidence }, testInfo) => {
    const { page, capture } = evidence;
    const pilot = await installPilotFixtures(page, { theme: testInfo.project.use.colorScheme });
    const trace = [];
    await page.goto(PILOT_PATHS.runner);
    await page.getByRole('button', { name: /Add workspace/ }).click();
    await page.locator('.rd-adv-toggle').click();
    const account = page.locator('.rd-form-field').filter({ has: page.locator('.rd-form-label', { hasText: /^Claude account$/ }) });
    // The value as drawn: the replaced picker keeps its combobox role on an empty input beside it.
    await expect(account.locator('.rd-codex-account')).toContainText('Automatic');
    await account.scrollIntoViewIfNeeded();
    await capture('pilot-account', { field: account });
    await account.getByRole('combobox').click();
    // The replaced picker draws a virtual list whose visible rows carry no option role (its screen
    // reader list is off-screen), so the rows are found by their visible text.
    const row = (text) => page.getByText(text, { exact: true }).filter({ visible: true }).last();
    for (const text of ['Automatic', 'Default (~/.claude)', 'Work']) await expect(row(text)).toBeVisible();
    await capture('pilot-account-open', { work: row('Work') });
    trace.push(await observe(page, pilot, 'account open'));
    await row('Work').click();
    await expect(account.locator('.rd-codex-account')).toContainText('Work');
    await expect(account).toContainText('Only applies to sessions that run Claude on this machine.');
    trace.push(await observe(page, pilot, 'account Work'));
    await testInfo.attach('trace', { body: JSON.stringify(trace, null, 2), contentType: 'application/json' });
  });
});
