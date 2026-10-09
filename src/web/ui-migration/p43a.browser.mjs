import { test, expect } from './harness.mjs';
import { PILOT_IDS, installPilotFixtures } from './pilot-fixtures.mjs';
import {
  DELETE_REFUSAL, HANDLED_REFUSAL, P43A_IDS, P43A_PATHS, RESOLVE_REFUSAL, SAVE_REFUSAL, STATUS_REFUSAL, gate, installP43aFixtures, listTasks,
  liveShare, mentionComment, openProjects, pilotRow,
} from './p43a-fixtures.mjs';

// P4.3a states, which the P0 matrix reaches only in part (one project row, the project overview and its
// graph, one task row with its panel): the Projects list in each lane, its open views, search, history
// and empty states, and a row opening its project; a project page's header questions and share menu, its
// coordinator in three states, How it runs, the work overview, goal, chain, blockers, open items, the run
// queue, acceptance criteria and the task plan with subtasks; the public page of a shared project; the
// Tasks page's scope menu, filters, column sort, labels, selection, batch dialogs and its keys with a task
// open; and a task's schedule, acceptance editor, attribution, dependencies and mention deliveries.
// Locators are roles, accessible names, labels and the pages' own classes, so the same file drives the
// replaced controls (same-commit reference tree) and the Orbit ones; a painted box is named by both
// class names. Screenshots, computed styles and each step's observation (`trace`: address, focus, open
// dialogs and menus, alerts, notifications, the choices that are on and the requests a press sends) are
// compared between the two runs.

const DIALOG_SURFACE = '.ant-modal-container, .orbit-overlay';
const CARD = '.ant-card, .orbit-card';
const EMPTY = '.ant-empty, .orbit-empty';
const SEGMENTED = '.ant-segmented, .orbit-segmented';
const SEGMENT = '.ant-segmented-item, .orbit-segmented-item';
const SELECT_OPTION = '[role="option"], .ant-select-item-option';
const INPUT_CLEAR = '.ant-input-clear-icon, .orbit-input-clear';

const frames = (page) => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
// A replaced button's icon names itself ("plus New project"), and its loading icon can stay in the
// name ("loading Save"); Orbit buttons hide both from the name.
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const named = (name) => new RegExp(`^(?:loading |[a-z]+(?:-[a-z]+)* )?${escape(name)}$`);
const button = (scope, name) => scope.getByRole('button', { name: named(name) });
// A section's fold button: the replaced button carried its caret after the text, so its name ends
// with the icon's ("Collapse up").
const fold = (scope, name) => scope.getByRole('button', { name: new RegExp(`^${name}(?: (?:up|down))?$`) });
const item = (page, name) => page.getByRole('menuitem', { name: typeof name === 'string' ? named(name) : name });
// The open menu: the replaced dropdown keeps closed ones in the page, hidden.
const openMenu = (page) => page.getByRole('menu').filter({ visible: true }).last();
// An anchored question (role=tooltip on the replaced popover, role=dialog on the Orbit one) or a modal
// one (role=dialog on the replaced confirm, role=alertdialog on the Orbit one), by its title.
const question = (page, title) => page.locator('[role="tooltip"], [role="dialog"], [role="alertdialog"]')
  .filter({ has: page.getByText(title, { exact: true }) }).filter({ visible: true }).last();
const dialog = (page, title) => page.locator('[role="dialog"], [role="alertdialog"]')
  .filter({ has: page.getByText(title, { exact: true }) }).filter({ visible: true }).last();
const notifications = (page) => page.getByRole('region', { name: 'Notifications', exact: true });
const tooltip = (page) => page.getByRole('tooltip').filter({ visible: true }).last();
/** Wait until the notifications have gone: the two trees take different times to get from one step
 *  to the next (the replaced controls animate), so a toast still up in one run has expired in the
 *  other unless both wait it out before the next shot. */
const toastsGone = (page) => expect(page.locator('.toast-viewport .toast-slot')).toHaveCount(0, { timeout: 20_000 });
/** A segment of a segmented control, by the text it starts with. */
const segment = (scope, text) => scope.locator(SEGMENT).filter({ hasText: new RegExp(`^${escape(text)}`) }).first();

/** Wait until a layer is drawn in full: it and its ancestors opaque and untransformed (the replaced
 *  dialog zooms in from a later frame; a list opened before then measures the field mid-zoom). */
const still = (locator) => expect.poll(() => locator.evaluate((el) => {
  for (let node = el; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (Number(style.opacity) < 1 || style.transform !== 'none') return false;
  }
  return true;
}), { timeout: 5000 }).toBe(true);

/** Wait out enter and leave animations (the replaced controls run theirs whatever motion is asked for),
 *  so an observation reads where a step ended up, not a frame of its transition. */
const settled = (page) => page.waitForFunction(
  () => document.getAnimations().every((animation) => animation.playState !== 'running' || animation.effect?.getTiming().iterations === Infinity),
  null, { timeout: 3000 },
).catch(() => {});

async function observe(page, sources, step) {
  await settled(page);
  const state = await page.evaluate(() => {
    const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden' && Number(getComputedStyle(el).opacity) > 0; };
    const text = (ids) => (ids ?? '').split(/\s+/).filter(Boolean).map((id) => document.getElementById(id)?.textContent?.trim() ?? '').filter(Boolean).join(' | ');
    const name = (el) => el && (el.getAttribute('aria-label') || text(el.getAttribute('aria-labelledby')) || el.labels?.[0]?.textContent?.trim()
      || el.getAttribute('placeholder') || el.textContent?.trim().replace(/\s+/g, ' ').slice(0, 80) || el.tagName.toLowerCase());
    const active = document.activeElement;
    const notifications = document.querySelector('[role="region"][aria-label="Notifications"]');
    // The choices that are on (segments, radios, checkboxes, switches), by the text they carry: a
    // native input by its label, an Orbit control by its own text or name.
    const on = [...document.querySelectorAll('input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"], [role="switch"]')]
      .filter((el) => (el.matches('input') ? el.checked : el.getAttribute('aria-checked') === 'true'))
      .filter((el) => visible(el.closest('label') ?? el) || visible(el))
      .map((el) => (el.closest('label')?.textContent || el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60));
    return {
      url: location.pathname + location.search,
      focus: active && active !== document.body ? { role: active.getAttribute('role') ?? active.tagName.toLowerCase(), name: name(active) } : 'body',
      dialogs: [...document.querySelectorAll('[role="dialog"],[role="alertdialog"]')].filter(visible).map((el) => el.textContent.trim().replace(/\s+/g, ' ').slice(0, 120)),
      menus: [...document.querySelectorAll('[role="menu"]')].filter(visible).map((el) => [...el.querySelectorAll('[role="menuitem"]')].map((entry) => ({
        text: entry.textContent.trim(), disabled: entry.getAttribute('aria-disabled') === 'true' || entry.hasAttribute('data-disabled') }))),
      alerts: [...document.querySelectorAll('[role="alert"]')].filter(visible).map((el) => el.textContent.trim().replace(/\s+/g, ' ')).filter(Boolean),
      notifications: notifications ? notifications.innerText.trim().replace(/\s+/g, ' ') : '',
      on,
    };
  });
  const requests = sources.flatMap((source) => source.requests.splice(0))
    .map(({ method, path, query, body }) => ({ method, path: query ? `${path}?${query}` : path, body }));
  return { step, ...state, requests };
}

/** Type into a field the way a person does: focus, select what is there, type. */
async function fill(locator, value) {
  await locator.click();
  await locator.press('ControlOrMeta+a');
  if (value) await locator.pressSequentially(value);
  else await locator.press('Backspace');
}

const attachTrace = (testInfo, trace) => testInfo.attach('trace', { body: JSON.stringify(trace, null, 2), contentType: 'application/json' });
/** Bring a part of the page to the top of the view, the same way on both trees. */
const top = (locator) => locator.evaluate((el) => el.scrollIntoView({ block: 'start' }));
const phone = (testInfo) => !!testInfo.project.use.isMobile;
const block = (page, name) => page.locator(`[data-project-block="${name}"]`);
const projectRow = (page, title) => page.locator('.project-row').filter({ has: page.locator('.project-row-title', { hasText: new RegExp(`^${escape(title)}$`) }) });
const taskRow = (page, title) => page.locator('.task-row').filter({ has: page.locator('.task-title', { hasText: new RegExp(`^${escape(title)}`) }) }).first();

test.describe('P4.3a the Projects list', () => {
  test('lanes, a folded lane, the open views, search and its clear', async ({ evidence }, testInfo) => {
    const { page, capture } = evidence;
    const fixtures = await installP43aFixtures(page);
    const trace = [];
    await page.goto(P43A_PATHS.projects);
    await expect(projectRow(page, 'Accessibility sweep')).toBeVisible();
    await expect(projectRow(page, 'Mobile onboarding')).toBeVisible();
    trace.push({ ...(await observe(page, [fixtures], 'open')), sections: await page.locator('section[data-section]').evaluateAll((all) => all.map((s) => s.dataset.section)) });
    await capture('p43a-projects', { toolbar: '.projects-toolbar', filter: SEGMENTED, row: projectRow(page, 'Accessibility sweep') });

    // A lane folds into pills and opens again.
    const attentionLane = page.locator('section[data-section="attention"]');
    await fold(attentionLane, 'Collapse').click();
    await expect(fold(attentionLane, 'Expand')).toBeVisible();
    await frames(page);
    trace.push(await observe(page, [fixtures], 'attention folded'));
    await capture('p43a-projects-folded', { lane: attentionLane });
    await fold(attentionLane, 'Expand').click();
    await expect(projectRow(page, 'Accessibility sweep')).toBeVisible();
    trace.push(await observe(page, [fixtures], 'attention opened'));

    // The open views narrow the one Open read: Running, then Ready.
    await segment(page.locator(SEGMENTED), 'Running').click();
    await expect(projectRow(page, 'Search indexing')).toBeVisible();
    await expect(projectRow(page, 'Accessibility sweep')).toHaveCount(0);
    await frames(page);
    trace.push(await observe(page, [fixtures], 'running view'));
    await capture('p43a-projects-running', { filter: SEGMENTED, row: projectRow(page, 'Search indexing') });
    await segment(page.locator(SEGMENTED), 'Ready').click();
    await expect(projectRow(page, 'Orbit UI migration')).toBeVisible();
    await expect(projectRow(page, 'Search indexing')).toHaveCount(0);
    trace.push(await observe(page, [fixtures], 'ready view'));
    await segment(page.locator(SEGMENTED), 'All').click();
    await expect(projectRow(page, 'Search indexing')).toBeVisible();
    trace.push(await observe(page, [fixtures], 'all open'));

    // Search titles and goals; a search with no match, its way out, and the field's own clear.
    const search = page.getByRole('textbox', { name: 'Search projects', exact: true });
    await fill(search, 'keyboard');
    await expect(projectRow(page, 'Accessibility sweep')).toBeVisible();
    await expect(projectRow(page, 'Search indexing')).toHaveCount(0);
    await frames(page);
    trace.push(await observe(page, [fixtures], 'search: keyboard'));
    await capture('p43a-projects-search', { search: page.locator('.projects-toolbar-search'), clear: page.locator('.projects-toolbar-search').locator(INPUT_CLEAR) });
    await fill(search, 'zzz');
    const nothing = page.locator(EMPTY);
    await expect(nothing).toBeVisible();
    await frames(page);
    trace.push(await observe(page, [fixtures], 'search: no match'));
    await capture('p43a-projects-no-match', { empty: nothing, action: button(nothing, 'Clear search') });
    await button(nothing, 'Clear search').click();
    await expect(search).toHaveValue('');
    await expect(projectRow(page, 'Search indexing')).toBeVisible();
    trace.push(await observe(page, [fixtures], 'search cleared by its way out'));
    await fill(search, 'zzz');
    await expect(nothing).toBeVisible();
    await page.locator('.projects-toolbar-search').locator(INPUT_CLEAR).click();
    await expect(search).toHaveValue('');
    await expect(search).toBeFocused();
    await expect(projectRow(page, 'Search indexing')).toBeVisible();
    trace.push(await observe(page, [fixtures], 'search cleared by the field'));

    // A row opens its project, and the browser's Back returns to the list.
    await projectRow(page, 'Orbit UI migration').getByRole('link').click();
    await expect(page).toHaveURL(new RegExp(`/projects/${P43A_IDS.project}$`));
    await expect(page.locator('.project-detail-identity').getByRole('heading', { name: 'Orbit UI migration' })).toBeVisible();
    trace.push(await observe(page, [fixtures], 'a row opened its project'));
    await page.goBack();
    await expect(page).toHaveURL(/\/projects$/);
    await expect(projectRow(page, 'Search indexing')).toBeVisible();
    trace.push(await observe(page, [fixtures], 'back to the list'));
    await attachTrace(testInfo, trace);
  });

  test('history, an empty view, no open projects, loading and a failed read', async ({ evidence }, testInfo) => {
    const { page, capture } = evidence;
    const fixtures = await installP43aFixtures(page);
    const trace = [];
    await page.goto(P43A_PATHS.projects);
    await expect(projectRow(page, 'Accessibility sweep')).toBeVisible();
    await button(page, 'History').click();
    await expect(projectRow(page, 'Theme tokens')).toBeVisible();
    await expect(page).toHaveURL(/status=DONE/);
    await frames(page);
    trace.push(await observe(page, [fixtures], 'history: completed'));
    await capture('p43a-projects-history', { filter: SEGMENTED, row: projectRow(page, 'Theme tokens') });
    await segment(page.locator(SEGMENTED), 'Cancelled').click();
    const nothing = page.locator(EMPTY);
    await expect(nothing).toBeVisible();
    await frames(page);
    trace.push(await observe(page, [fixtures], 'history: none cancelled'));
    await capture('p43a-projects-none-cancelled', { empty: nothing, action: button(nothing, 'Show open projects') });
    await button(nothing, 'Show open projects').click();
    await expect(projectRow(page, 'Accessibility sweep')).toBeVisible();
    trace.push(await observe(page, [fixtures], 'back to open'));

    // No open project at all: the empty list offers New project.
    fixtures.state.open = [];
    await page.reload();
    await expect(page.getByText('No open projects', { exact: true })).toBeVisible();
    await frames(page);
    trace.push(await observe(page, [fixtures], 'no open projects'));
    await capture('p43a-projects-none', { empty: page.locator(EMPTY), action: button(page.locator(EMPTY), 'New project') });

    // Loading, then a read that failed twice, and Retry.
    fixtures.state.open = openProjects();
    fixtures.state.holdProjects = gate();
    await page.reload();
    const loading = page.locator('main [aria-busy="true"]');
    await expect(loading).toBeVisible();
    await frames(page);
    trace.push(await observe(page, [fixtures], 'loading'));
    await capture('p43a-projects-loading', { loading });
    fixtures.state.projectsError = 'The projects service is restarting.';
    fixtures.state.holdProjects.open();
    fixtures.state.holdProjects = null;
    const failed = page.getByRole('alert').filter({ hasText: 'Projects could not be loaded' });
    await expect(failed).toBeVisible();
    await frames(page);
    trace.push(await observe(page, [fixtures], 'failed'));
    await capture('p43a-projects-failed', { alert: failed, retry: button(failed, 'Retry') });
    fixtures.state.projectsError = null;
    await button(failed, 'Retry').click();
    await expect(projectRow(page, 'Accessibility sweep')).toBeVisible();
    trace.push(await observe(page, [fixtures], 'retried'));
    await attachTrace(testInfo, trace);
  });
});

test.describe('P4.3a a project page', () => {
  test('the header: status questions, a refusal, the share menu and the delete question', async ({ evidence }, testInfo) => {
    const { page, capture } = evidence;
    const fixtures = await installP43aFixtures(page);
    const trace = [];
    await page.goto(P43A_PATHS.project);
    const header = page.locator('.project-detail-identity');
    await expect(header.getByRole('heading', { name: 'Orbit UI migration' })).toBeVisible();
    await expect(page.locator('.project-command-center')).toBeVisible();
    trace.push(await observe(page, [fixtures], 'open'));
    await capture('p43a-header', { header, more: page.getByRole('button', { name: 'More project actions' }) });

    // The ⋯ menu, and Share… from it.
    await page.getByRole('button', { name: 'More project actions' }).click();
    await expect(item(page, 'Copy as Markdown')).toBeVisible();
    await frames(page);
    // The shot waits for the menu to be fully drawn (the replaced one fades in), then the step is read.
    await capture('p43a-header-menu', { menu: openMenu(page) });
    trace.push(await observe(page, [fixtures], '⋯ menu'));
    await item(page, 'Share…').click();
    const share = dialog(page, 'Share project');
    await expect(share).toBeVisible();
    await expect(page.getByRole('menu').filter({ visible: true })).toHaveCount(0);
    trace.push(await observe(page, [fixtures], 'share from the menu'));
    await page.keyboard.press('Escape');
    await expect(share).toHaveCount(0);
    trace.push(await observe(page, [fixtures], 'share closed'));

    // Record as cancelled: the question, Back.
    await page.getByRole('button', { name: 'Record Orbit UI migration as cancelled' }).click();
    const cancelled = dialog(page, 'Stop pursuing “Orbit UI migration”?');
    await expect(cancelled).toBeVisible();
    await frames(page);
    trace.push(await observe(page, [fixtures], 'record as cancelled asked'));
    await capture('p43a-status-cancel', { surface: cancelled.locator(DIALOG_SURFACE).or(cancelled).first() });
    await button(cancelled, 'Back').click();
    await expect(cancelled).toHaveCount(0);

    // Record as done: the evidence beside the claim; refused, the server's sentence inside the question.
    fixtures.state.statusRefusal = STATUS_REFUSAL;
    await page.getByRole('button', { name: 'Record Orbit UI migration as done' }).click();
    const done = dialog(page, 'Record “Orbit UI migration” as done?');
    await expect(done).toBeVisible();
    await frames(page);
    trace.push(await observe(page, [fixtures], 'record as done asked'));
    await capture('p43a-status-done', { surface: done.locator(DIALOG_SURFACE).or(done).first() });
    await button(done, 'Record as done').click();
    await expect(done.getByText(STATUS_REFUSAL)).toBeVisible();
    await frames(page);
    trace.push(await observe(page, [fixtures], 'record as done refused'));
    await capture('p43a-status-refused', { alert: done.getByRole('alert') });
    await button(done, 'Back').click();
    await expect(done).toHaveCount(0);

    // Recorded as done: the tag and the way back to Open.
    fixtures.state.statusRefusal = null;
    await page.getByRole('button', { name: 'Record Orbit UI migration as done' }).click();
    await button(dialog(page, 'Record “Orbit UI migration” as done?'), 'Record as done').click();
    await expect(notifications(page).getByText('Recorded as done', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reopen Orbit UI migration' })).toBeVisible();
    trace.push(await observe(page, [fixtures], 'recorded as done'));
    await toastsGone(page);
    await page.getByRole('button', { name: 'Reopen Orbit UI migration' }).click();
    const reopen = dialog(page, 'Reopen “Orbit UI migration”?');
    await expect(reopen).toBeVisible();
    await frames(page);
    trace.push(await observe(page, [fixtures], 'reopen asked'));
    await capture('p43a-status-reopen', { header, surface: reopen.locator(DIALOG_SURFACE).or(reopen).first() });
    await button(reopen, 'Reopen').click();
    await expect(notifications(page).getByText('Project reopened', { exact: true })).toBeVisible();
    trace.push(await observe(page, [fixtures], 'reopened'));
    await toastsGone(page);

    // Delete: the question, cancelled; then refused, in the server's words under the header.
    await page.getByRole('button', { name: 'Delete Orbit UI migration' }).click();
    const remove = question(page, 'Delete “Orbit UI migration”?');
    await expect(remove).toBeVisible();
    await frames(page);
    trace.push(await observe(page, [fixtures], 'delete asked'));
    await capture('p43a-delete', { question: remove });
    await button(remove, 'Cancel').click();
    await expect(remove).toHaveCount(0);
    fixtures.state.deleteRefusal = DELETE_REFUSAL;
    await page.getByRole('button', { name: 'Delete Orbit UI migration' }).click();
    await button(question(page, 'Delete “Orbit UI migration”?'), 'Delete').click();
    const refused = page.getByRole('alert').filter({ hasText: 'Project could not be deleted' });
    await expect(refused).toBeVisible();
    await top(header);
    await frames(page);
    trace.push(await observe(page, [fixtures], 'delete refused'));
    await capture('p43a-delete-refused', { alert: refused });

    // A link that is open: the header says Shared · Live, and the menu's Share… carries it too.
    fixtures.state.share = liveShare();
    await page.reload();
    await expect(page.getByRole('button', { name: /Shared · Live/ })).toBeVisible();
    await page.getByRole('button', { name: 'More project actions' }).click();
    await expect(item(page, /Share…\s*Live link/)).toBeVisible();
    await frames(page);
    trace.push(await observe(page, [fixtures], 'shared · live'));
    await capture('p43a-header-live', { header, menu: openMenu(page) });
    await page.keyboard.press('Escape');
    await attachTrace(testInfo, trace);
  });

  test('the coordinator: its menu and replace question, rebinding, choosing where it opens', async ({ evidence }, testInfo) => {
    const { page, capture } = evidence;
    const fixtures = await installP43aFixtures(page);
    const trace = [];
    await page.goto(P43A_PATHS.project);
    const card = page.getByRole('region', { name: 'Coordinator' });
    await expect(button(card, 'Reply to coordinator')).toBeVisible();
    await top(page.locator('.project-command-center'));
    await frames(page);
    trace.push(await observe(page, [fixtures], 'live coordinator'));
    await capture('p43a-coordinator', { card, split: button(card, 'Reply to coordinator') });

    await button(card, 'More coordinator actions').click();
    const newOne = item(page, /^Start a new coordinator/);
    await expect(newOne).toBeVisible();
    await frames(page);
    await capture('p43a-coordinator-menu', { menu: openMenu(page) });
    trace.push(await observe(page, [fixtures], 'split menu'));
    await newOne.click();
    const replace = dialog(page, 'Complete this conversation and start a new coordinator?');
    await expect(replace).toBeVisible();
    await frames(page);
    trace.push(await observe(page, [fixtures], 'replace asked'));
    await capture('p43a-coordinator-replace', { surface: replace.locator(DIALOG_SURFACE).or(replace).first() });
    await button(replace, 'Keep this coordinator').click();
    await expect(replace).toHaveCount(0);
    trace.push(await observe(page, [fixtures], 'kept'));

    // Its workspace disabled: the card offers the fix and rebinding; rebind to another workspace.
    fixtures.state.coordinator = 'unavailable';
    await page.reload();
    await expect(button(card, 'Rebind workspace…')).toBeVisible();
    await top(page.locator('.project-command-center'));
    await frames(page);
    trace.push(await observe(page, [fixtures], 'unavailable'));
    await capture('p43a-coordinator-unavailable', { card, fix: button(card, 'Enable Orbit baseline') });
    await button(card, 'Rebind workspace…').click();
    const rebind = dialog(page, 'Rebind coordination workspace');
    await expect(rebind).toBeVisible();
    await still(rebind);
    await expect(button(rebind, 'Rebind')).toBeDisabled();
    await rebind.getByRole('combobox').click();
    const docs = page.locator(SELECT_OPTION).filter({ visible: true }).filter({ hasText: /^Docs site$/ });
    await expect(docs).toBeVisible();
    await frames(page);
    trace.push({ ...(await observe(page, [fixtures], 'rebind: workspaces')), options: await page.locator(SELECT_OPTION).filter({ visible: true }).allTextContents() });
    await capture('p43a-coordinator-rebind', { surface: rebind.locator(DIALOG_SURFACE).or(rebind).first() });
    await docs.click();
    await expect(button(rebind, 'Rebind')).toBeEnabled();
    await button(rebind, 'Rebind').click();
    await expect(rebind).toHaveCount(0);
    await expect(button(card, 'Reply to coordinator')).toBeVisible();
    trace.push(await observe(page, [fixtures], 'rebound'));

    // Never opened, with nowhere to open: choosing the workspace it opens in (cancelled).
    fixtures.state.coordinator = 'never';
    await page.reload();
    await expect(button(card, 'Choose a workspace…')).toBeVisible();
    await button(card, 'Choose a workspace…').click();
    const choose = dialog(page, 'Choose the coordination workspace');
    await expect(choose).toBeVisible();
    await frames(page);
    trace.push(await observe(page, [fixtures], 'choose a workspace'));
    await capture('p43a-coordinator-landing', { surface: choose.locator(DIALOG_SURFACE).or(choose).first() });
    await button(choose, 'Cancel').click();
    await expect(choose).toHaveCount(0);
    trace.push(await observe(page, [fixtures], 'not chosen'));
    await attachTrace(testInfo, trace);
  });

  test('How it runs: the merge check warning, a refused save, pausing and a locked line', async ({ evidence }, testInfo) => {
    const { page, capture } = evidence;
    const fixtures = await installP43aFixtures(page);
    const trace = [];
    await page.goto(P43A_PATHS.project);
    const settings = page.getByRole('region', { name: 'How it runs' });
    await expect(settings.getByRole('switch', { name: 'Automatic' })).toBeVisible();
    await top(settings);
    await frames(page);
    trace.push(await observe(page, [fixtures], 'how it runs'));
    await capture('p43a-run-settings', { settings, check: settings.getByRole('textbox', { name: 'Merge check' }), save: button(settings, 'Save') });

    // Edit: the line, the limit, the merge check and the escalation window; Save refused.
    await settings.getByText('Directly into main').click();
    await fill(settings.getByRole('spinbutton', { name: 'At most' }), '5');
    await fill(settings.getByRole('textbox', { name: 'Merge check' }), 'npm test');
    await settings.getByRole('combobox', { name: 'Escalate after' }).click();
    const twoHours = page.locator(SELECT_OPTION).filter({ visible: true }).filter({ hasText: /^2 hours$/ });
    await expect(twoHours).toBeVisible();
    await frames(page);
    trace.push({ ...(await observe(page, [fixtures], 'escalation choices')), options: await page.locator(SELECT_OPTION).filter({ visible: true }).allTextContents() });
    await capture('p43a-run-settings-escalation', { settings });
    await twoHours.click();
    await expect(button(settings, 'Save')).toBeEnabled();
    trace.push({ ...(await observe(page, [fixtures], 'edited')), limit: await settings.getByRole('spinbutton', { name: 'At most' }).inputValue() });
    await capture('p43a-run-settings-edited', { settings });
    fixtures.state.saveRefusal = SAVE_REFUSAL;
    await button(settings, 'Save').click();
    const notSaved = settings.getByRole('alert').filter({ hasText: 'These settings were not saved' });
    await expect(notSaved).toBeVisible();
    await frames(page);
    trace.push(await observe(page, [fixtures], 'save refused'));
    await capture('p43a-run-settings-refused', { alert: notSaved });

    // Pause, then resume.
    await button(settings, 'Pause project').click();
    await expect(button(settings, 'Resume project')).toBeVisible();
    await frames(page);
    trace.push(await observe(page, [fixtures], 'paused'));
    await capture('p43a-run-settings-paused', { settings, resume: button(settings, 'Resume project') });
    await button(settings, 'Resume project').click();
    await expect(button(settings, 'Pause project')).toBeVisible();
    trace.push(await observe(page, [fixtures], 'resumed'));

    // A line that has started integrating is locked.
    fixtures.state.locked = true;
    fixtures.state.saveRefusal = null;
    await page.reload();
    await expect(settings.getByText(/so the line it lands on can no longer change/)).toBeVisible();
    await top(settings);
    await frames(page);
    trace.push(await observe(page, [fixtures], 'locked'));
    await capture('p43a-run-settings-locked', { settings });
    await attachTrace(testInfo, trace);
  });

  test('the work overview, goal, chain, blockers and resolving one', async ({ evidence }, testInfo) => {
    const { page, capture } = evidence;
    const fixtures = await installP43aFixtures(page);
    const trace = [];
    fixtures.state.holdPanorama = gate();
    await page.goto(P43A_PATHS.project);
    const overview = page.getByRole('region', { name: 'Work overview' });
    await expect(overview).toBeVisible();
    await top(page.locator('.project-command-center'));
    await frames(page);
    trace.push(await observe(page, [fixtures], 'overview loading'));
    await capture('p43a-overview-loading', { overview });
    fixtures.state.holdPanorama.open();
    fixtures.state.holdPanorama = null;
    await expect(overview.getByText('Ready to start')).toBeVisible();
    await frames(page);
    trace.push(await observe(page, [fixtures], 'overview'));
    await capture('p43a-overview', { overview });

    const goal = page.getByRole('region', { name: 'Goal' });
    await top(goal);
    await expect(page.getByRole('region', { name: 'Chain progress' })).toBeVisible();
    await frames(page);
    trace.push(await observe(page, [fixtures], 'goal and chain'));
    await capture('p43a-goal-chain', { goal, chain: page.getByRole('region', { name: 'Chain progress' }) });

    const blockers = page.getByRole('region', { name: 'Blockers' });
    await top(blockers);
    await frames(page);
    trace.push(await observe(page, [fixtures], 'blockers'));
    await capture('p43a-blockers', { blockers, files: blockers.locator('.project-blockers-files').first() });
    await blockers.locator('.project-blockers-files summary').first().click();
    await frames(page);
    trace.push(await observe(page, [fixtures], 'files open'));

    // Review the scope blocker: the question, its files, a note; refused, then accepted.
    await button(blockers, 'Review…').first().click();
    const review = dialog(page, 'Review this blocker');
    await expect(review).toBeVisible();
    await expect(button(review, 'Accept these files')).toBeDisabled();
    await frames(page);
    trace.push(await observe(page, [fixtures], 'review asked'));
    await capture('p43a-blocker-review', { surface: review.locator(DIALOG_SURFACE).or(review).first() });
    await fill(review.getByRole('textbox'), 'Checked the three files: only token renames.');
    fixtures.state.resolveRefusal = RESOLVE_REFUSAL;
    await button(review, 'Accept these files').click();
    await expect(review.getByText(RESOLVE_REFUSAL)).toBeVisible();
    await frames(page);
    trace.push(await observe(page, [fixtures], 'resolve refused'));
    await capture('p43a-blocker-refused', { surface: review.locator(DIALOG_SURFACE).or(review).first(), alert: review.getByRole('alert') });
    fixtures.state.resolveRefusal = null;
    await button(review, 'Accept these files').click();
    await expect(review).toHaveCount(0);
    await expect(blockers.getByText('2 open')).toBeVisible();
    trace.push(await observe(page, [fixtures], 'resolved'));

    // The system blocker's own question (Resolve…), left open.
    await button(blockers, 'Resolve…').last().click();
    const resolve = dialog(page, 'Resolve this blocker');
    await expect(resolve).toBeVisible();
    await frames(page);
    trace.push(await observe(page, [fixtures], 'resolve asked'));
    await capture('p43a-blocker-resolve', { surface: resolve.locator(DIALOG_SURFACE).or(resolve).first() });
    await button(resolve, 'Cancel').click();
    await expect(resolve).toHaveCount(0);
    trace.push(await observe(page, [fixtures], 'left open'));
    await attachTrace(testInfo, trace);
  });

  test('open items and the run queue: run, and resuming a paused list', async ({ evidence }, testInfo) => {
    const { page, capture } = evidence;
    const fixtures = await installP43aFixtures(page);
    const trace = [];
    await page.goto(P43A_PATHS.project);
    const items = page.getByRole('region', { name: 'Open items' });
    await expect(items).toBeVisible();
    await top(items);
    await frames(page);
    trace.push(await observe(page, [fixtures], 'open items'));
    await capture('p43a-open-items', { items });

    const queue = block(page, 'run-queue');
    await expect(queue.locator('[data-testid="ready-task-row"]')).toHaveCount(4);
    await top(queue);
    await frames(page);
    trace.push(await observe(page, [fixtures], 'run queue'));
    await capture('p43a-run-queue', { queue, run: button(queue, 'Run Restyle the toast stack') });
    await button(queue, 'Run Restyle the toast stack').click();
    await expect(notifications(page).getByText('Run started', { exact: true })).toBeVisible();
    trace.push(await observe(page, [fixtures], 'run started'));
    await toastsGone(page);

    await button(queue, 'Resume list Accessibility for Record keyboard focus').click();
    const resume = question(page, 'Resume “Accessibility”?');
    await expect(resume).toBeVisible();
    await frames(page);
    trace.push(await observe(page, [fixtures], 'resume list asked'));
    await capture('p43a-run-queue-resume', { question: resume });
    await button(resume, 'Resume list').click();
    await expect(resume).toHaveCount(0);
    trace.push(await observe(page, [fixtures], 'list resumed'));
    await attachTrace(testInfo, trace);
  });

  test('acceptance criteria and the task plan with its subtasks', async ({ evidence }, testInfo) => {
    const { page, capture } = evidence;
    const fixtures = await installP43aFixtures(page);
    const trace = [];
    await page.goto(P43A_PATHS.project);
    const acceptance = block(page, 'acceptance-criteria');
    await expect(acceptance.getByText('Every control is keyboard reachable.')).toBeVisible();
    await top(acceptance);
    await frames(page);
    trace.push(await observe(page, [fixtures], 'acceptance'));
    await capture('p43a-acceptance', { card: acceptance.locator(CARD).first(), held: acceptance.locator('.acceptance-held-up').first() });
    await button(acceptance, "How it's checked").first().click();
    await expect(acceptance.getByText(/Run the Playwright suite/)).toBeVisible();
    await frames(page);
    trace.push(await observe(page, [fixtures], 'how it is checked'));
    await capture('p43a-acceptance-method', { card: acceptance.locator(CARD).first() });
    if (phone(testInfo)) {
      // Above four criteria a phone shows the first four and a way to the rest.
      await button(acceptance, 'View all 5 criteria').click();
      await expect(button(acceptance, 'Show first 4 criteria')).toBeVisible();
      await frames(page);
      trace.push(await observe(page, [fixtures], 'all criteria'));
      await capture('p43a-acceptance-all', { card: acceptance.locator(CARD).first(), more: button(acceptance, 'Show first 4 criteria') });
    }

    const tasks = block(page, 'tasks');
    await top(tasks);
    await expect(tasks.locator('.project-task-row')).toHaveCount(11);
    await frames(page);
    trace.push(await observe(page, [fixtures], 'task plan'));
    await capture('p43a-tasks', { tasks, row: tasks.locator('.project-task-row').first() });
    await button(tasks, 'Show subtasks for Port the dialog primitives').click();
    await expect(tasks.getByText('Port Popconfirm')).toBeVisible();
    await frames(page);
    trace.push(await observe(page, [fixtures], 'subtasks'));
    await capture('p43a-tasks-subtasks', { children: tasks.locator('.project-task-children').first() });
    await button(tasks, 'Show subtasks for Migrate settings forms').click();
    const stale = tasks.getByText('No subtasks — the count on this row is out of date');
    await expect(stale).toBeVisible();
    await stale.evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await frames(page);
    trace.push(await observe(page, [fixtures], 'no subtasks'));
    await capture('p43a-tasks-stale', { empty: tasks.locator(EMPTY).first() });
    await button(tasks, 'Hide subtasks for Port the dialog primitives').click();
    await expect(tasks.getByText('Port Popconfirm')).toHaveCount(0);
    trace.push(await observe(page, [fixtures], 'subtasks hidden'));
    await attachTrace(testInfo, trace);
  });
});

test.describe('P4.3a open items in the coordinator conversation', () => {
  // The exception cards (ItemAsCard, ProjectProgressStatus.tsx) are drawn only into the coordinator's
  // conversation, at the moment each item became the reader's: the P0 conversation, as this
  // project's coordinator.
  test('an exception card: the cancel question and marking it handled, refused', async ({ evidence }, testInfo) => {
    const { page, capture } = evidence;
    const fixtures = await installP43aFixtures(page);
    fixtures.state.coordinatorSession = true;
    fixtures.state.doneRequest = false;
    const trace = [];
    await page.goto(P43A_PATHS.coordinator);
    // The escalated item's card: the one the reader can mark handled.
    const card = page.locator('.project-open-item-card').filter({ has: page.getByRole('button', { name: 'Mark as handled' }) });
    await expect(card).toBeVisible();
    // Centred once the conversation has finished laying out (it settles its own scroll as it loads).
    await settled(page);
    await card.evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await settled(page);
    await card.evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await frames(page);
    trace.push(await observe(page, [fixtures], 'exception card'));
    await capture('p43a-session-exception', { card });

    await button(card, 'Cancel task').click();
    const cancel = dialog(page, 'Cancel this task?');
    await expect(cancel).toBeVisible();
    await frames(page);
    trace.push(await observe(page, [fixtures], 'cancel asked'));
    await capture('p43a-session-cancel', { surface: cancel.locator(DIALOG_SURFACE).or(cancel).first() });
    await button(cancel, 'Back').click();
    await expect(cancel).toHaveCount(0);
    trace.push(await observe(page, [fixtures], 'not cancelled'));

    await button(card, 'Mark as handled').click();
    const handled = dialog(page, 'Mark this item as handled?');
    await expect(handled).toBeVisible();
    await expect(button(handled, 'Mark as handled')).toBeDisabled();
    await fill(handled.getByRole('textbox'), 'Fixed the acceptance command on the task branch myself.');
    await frames(page);
    trace.push(await observe(page, [fixtures], 'mark handled asked'));
    await capture('p43a-session-handled', { surface: handled.locator(DIALOG_SURFACE).or(handled).first() });
    fixtures.state.handledRefusal = HANDLED_REFUSAL;
    await button(handled, 'Mark as handled').click();
    await expect(handled.getByText(HANDLED_REFUSAL)).toBeVisible();
    await frames(page);
    trace.push(await observe(page, [fixtures], 'mark handled refused'));
    await capture('p43a-session-handled-refused', { surface: handled.locator(DIALOG_SURFACE).or(handled).first(), alert: handled.getByRole('alert') });
    await button(handled, 'Back').click();
    await expect(handled).toHaveCount(0);
    trace.push(await observe(page, [fixtures], 'left open'));
    await attachTrace(testInfo, trace);
  });
});

test.describe('P4.3a a shared project', () => {
  test('its public page', async ({ evidence }, testInfo) => {
    const { page, capture } = evidence;
    const fixtures = await installP43aFixtures(page);
    const trace = [];
    await page.goto(P43A_PATHS.share);
    await expect(page.getByRole('heading', { name: 'Orbit UI migration' })).toBeVisible();
    await expect(page.locator('.share-project-tasks .project-task-row')).toHaveCount(3);
    trace.push(await observe(page, [fixtures], 'shared project'));
    await capture('p43a-shared', { header: '.project-detail-identity', overview: '.share-project-overview' });
    const acceptance = block(page, 'acceptance-criteria');
    await top(acceptance);
    await frames(page);
    trace.push(await observe(page, [fixtures], 'its criteria'));
    await capture('p43a-shared-criteria', { card: acceptance.locator(CARD).first() });
    const tasks = page.locator('.share-project-tasks');
    await top(tasks);
    await frames(page);
    trace.push(await observe(page, [fixtures], 'its tasks'));
    await capture('p43a-shared-tasks', { tasks });
    await attachTrace(testInfo, trace);
  });
});

test.describe('P4.3a the Tasks page', () => {
  test('the scope menu, status tabs, search, labels and the created-in chip', async ({ evidence }, testInfo) => {
    const { page, capture } = evidence;
    const fixtures = await installP43aFixtures(page);
    const trace = [];
    await page.goto(P43A_PATHS.tasks);
    await expect(taskRow(page, 'Migrate the task list toolbar')).toBeVisible();
    trace.push(await observe(page, [fixtures], 'all tasks'));
    await capture('p43a-tasks-page', { toolbar: '.tasks-toolbar', row: taskRow(page, 'Review keyboard focus order') });

    if (!phone(testInfo)) {
      // The row's own controls and their tooltips.
      await taskRow(page, 'Review keyboard focus order').hover();
      await button(taskRow(page, 'Review keyboard focus order'), 'Run').hover();
      await expect(tooltip(page)).toBeVisible();
      await frames(page);
      trace.push({ ...(await observe(page, [fixtures], 'run tooltip')), tooltip: await tooltip(page).textContent() });
      await capture('p43a-tasks-row-tooltip', { tip: tooltip(page) });
      await page.mouse.move(0, 0);
    }

    await page.locator('.tasks-scope-trigger').click();
    await expect(item(page, /^All tasks/)).toBeVisible();
    await expect(item(page, /^UI migration wave 1/)).toBeVisible();
    await frames(page);
    await capture('p43a-tasks-scope', { menu: openMenu(page) });
    trace.push(await observe(page, [fixtures], 'scope menu'));
    await item(page, /^UI migration wave 1/).click();
    await expect(page).toHaveURL(new RegExp(`/lists/${P43A_IDS.uiWave}`));
    await expect(taskRow(page, 'Capture dark-theme baselines')).toBeVisible();
    await expect(taskRow(page, 'Review keyboard focus order')).toHaveCount(0);
    trace.push(await observe(page, [fixtures], 'a list'));
    await page.locator('.tasks-scope-trigger').click();
    await item(page, /^All tasks/).click();
    await expect(taskRow(page, 'Review keyboard focus order')).toBeVisible();
    trace.push(await observe(page, [fixtures], 'all tasks again'));

    // Status tabs and the title search, with its clear.
    const tabs = page.locator('.tasks-toolbar').locator(SEGMENTED).first();
    await segment(tabs, 'Failed').click();
    await expect(taskRow(page, 'Publish the release notes')).toBeVisible();
    await expect(taskRow(page, 'Review keyboard focus order')).toHaveCount(0);
    await frames(page);
    trace.push(await observe(page, [fixtures], 'failed tab'));
    await capture('p43a-tasks-failed', { tabs, row: taskRow(page, 'Publish the release notes') });
    await segment(tabs, 'All').click();
    // Each of these controls rewrites the address from the one it last read, so the next press waits
    // for the page to show this one. The field writes every keystroke (?q=…), and keys typed faster
    // than that round trip are lost on either tree (a different few on each run): one edit instead.
    await expect(taskRow(page, 'Review keyboard focus order')).toBeVisible();
    const search = page.getByPlaceholder('Search tasks');
    await search.fill('keyboard');
    await expect(taskRow(page, 'Migrate the task list toolbar')).toHaveCount(0);
    await frames(page);
    trace.push(await observe(page, [fixtures], 'search'));
    await capture('p43a-tasks-search', { search: page.locator('.tasks-search') });
    await page.locator('.tasks-search').locator(INPUT_CLEAR).click();
    await expect(search).toHaveValue('');
    await expect(taskRow(page, 'Migrate the task list toolbar')).toBeVisible();
    trace.push(await observe(page, [fixtures], 'search cleared'));

    // A column heading sorts the rows: by title up, then down, then back to the order they came in.
    const byTitle = page.locator('.col-head.sortable').filter({ hasText: /^Task$/ });
    const firstRow = page.locator('.task-row .task-title').first();
    const rows = () => page.locator('.task-row .task-title').allTextContents();
    await byTitle.click();
    await expect(page).toHaveURL(/[?&]sort=title&dir=asc(&|$)/);
    await expect(firstRow).toHaveText('Capture dark-theme baselines');
    await frames(page);
    trace.push({ ...(await observe(page, [fixtures], 'sorted by title')), rows: await rows() });
    await capture('p43a-tasks-sorted', { heading: byTitle, row: taskRow(page, 'Capture dark-theme baselines') });
    await byTitle.click();
    await expect(page).toHaveURL(/[?&]sort=title&dir=desc(&|$)/);
    await expect(firstRow).toHaveText('Review keyboard focus order');
    trace.push({ ...(await observe(page, [fixtures], 'sorted by title, down')), rows: await rows() });
    await byTitle.click();
    await expect(page).not.toHaveURL(/[?&](sort|dir)=/);
    await expect(firstRow).toHaveText('Migrate the task list toolbar');
    trace.push({ ...(await observe(page, [fixtures], 'arrival order')), rows: await rows() });

    // Labels: the picker's options, one picked.
    const labels = page.locator('.tasks-labelfilter');
    await labels.click();
    const migration = page.locator(SELECT_OPTION).filter({ visible: true }).filter({ hasText: /^ui-migration/ });
    await expect(migration).toBeVisible();
    await frames(page);
    trace.push({ ...(await observe(page, [fixtures], 'labels')), options: await page.locator(SELECT_OPTION).filter({ visible: true }).allTextContents() });
    await capture('p43a-tasks-labels', { picker: labels });
    await migration.click();
    await expect(page).toHaveURL(/labels=ui-migration/);
    await frames(page);
    trace.push(await observe(page, [fixtures], 'label picked'));
    await capture('p43a-tasks-labels-picked', { option: page.locator(SELECT_OPTION).filter({ visible: true }).filter({ hasText: /^ui-migration/ }) });
    await page.keyboard.press('Escape');
    await expect(page).toHaveURL(/labels=ui-migration/);
    await expect(taskRow(page, 'Review keyboard focus order')).toHaveCount(0);
    await frames(page);
    trace.push(await observe(page, [fixtures], 'labelled'));
    await capture('p43a-tasks-labelled', { toolbar: '.tasks-toolbar', picker: labels });

    // Tasks created in one session: the chip, and taking it off.
    await page.goto(P43A_PATHS.createdIn);
    const chip = page.locator('.tasks-createdin');
    await expect(chip).toBeVisible();
    await frames(page);
    trace.push(await observe(page, [fixtures], 'created in'));
    await capture('p43a-tasks-created-in', { chip });
    await chip.getByRole('button', { name: 'Remove this filter' }).click();
    await expect(chip).toHaveCount(0);
    await expect(page).not.toHaveURL(/createdIn/);
    trace.push(await observe(page, [fixtures], 'filter removed'));
    await attachTrace(testInfo, trace);
  });

  test('selection, the bulk bar, the run and assign dialogs, and the stop and delete questions', async ({ evidence }, testInfo) => {
    const { page, capture } = evidence;
    const fixtures = await installP43aFixtures(page);
    const trace = [];
    fixtures.state.holdTasks = gate();
    await page.goto(P43A_PATHS.tasks);
    const loading = page.locator('.tasks-body [aria-busy="true"]');
    await expect(loading).toBeVisible();
    await frames(page);
    trace.push(await observe(page, [fixtures], 'loading'));
    await capture('p43a-tasks-loading', { loading });
    fixtures.state.holdTasks.open();
    fixtures.state.holdTasks = null;
    await expect(taskRow(page, 'Review keyboard focus order')).toBeVisible();

    // Three rows: one, then Shift for the range down to it. A batch action that went through clears
    // the selection, so the next one selects them again.
    const bar = page.locator('.tasks-bulkbar');
    const selectThree = async () => {
      await taskRow(page, 'Review keyboard focus order').getByRole('checkbox').click();
      await taskRow(page, 'Publish the release notes').getByRole('checkbox').click({ modifiers: ['Shift'] });
      await expect(bar.getByText('3 selected')).toBeVisible();
    };
    await selectThree();
    await frames(page);
    trace.push(await observe(page, [fixtures], 'three selected'));
    await capture('p43a-tasks-selected', { bar, row: taskRow(page, 'Replace legacy select popups') });

    await button(bar, 'Run').click();
    const run = dialog(page, 'Run tasks');
    await expect(run).toBeVisible();
    await still(run);
    await frames(page);
    trace.push({ ...(await observe(page, [fixtures], 'run dialog')), concurrency: await run.getByRole('spinbutton').inputValue() });
    await capture('p43a-tasks-run', { surface: run.locator(DIALOG_SURFACE).or(run).first(), number: run.getByRole('spinbutton') });
    await fill(run.getByRole('spinbutton'), '1');
    await button(run, 'Run').click();
    await expect(notifications(page).getByText(/^Triggered 2 task/)).toBeVisible();
    trace.push(await observe(page, [fixtures], 'run'));
    await toastsGone(page);
    if (!(await bar.isVisible())) await selectThree();

    await button(bar, 'Set assignee').click();
    const assign = dialog(page, 'Set assignee');
    await expect(assign).toBeVisible();
    await still(assign);
    await assign.getByRole('combobox').click();
    const docs = page.locator(SELECT_OPTION).filter({ visible: true }).filter({ hasText: /^Docs site$/ });
    await expect(docs).toBeVisible();
    await frames(page);
    trace.push({ ...(await observe(page, [fixtures], 'assign choices')), options: await page.locator(SELECT_OPTION).filter({ visible: true }).allTextContents() });
    await capture('p43a-tasks-assign', { surface: assign.locator(DIALOG_SURFACE).or(assign).first() });
    await docs.click();
    await button(assign, 'OK').click();
    await expect(notifications(page).getByText(/^Set assignee on 3 task/)).toBeVisible();
    trace.push(await observe(page, [fixtures], 'assigned'));
    await toastsGone(page);
    if (!(await bar.isVisible())) await selectThree();

    await button(bar, 'Stop').click();
    const stop = question(page, 'Stop selected tasks?');
    await expect(stop).toBeVisible();
    await frames(page);
    trace.push(await observe(page, [fixtures], 'stop asked'));
    await capture('p43a-tasks-stop', { question: stop });
    await button(stop, 'Cancel').click();
    await expect(stop).toHaveCount(0);

    await button(bar, 'Delete').click();
    const remove = question(page, 'Delete 3 selected tasks?');
    await expect(remove).toBeVisible();
    await frames(page);
    trace.push(await observe(page, [fixtures], 'delete asked'));
    await capture('p43a-tasks-delete', { question: remove });
    await button(remove, 'Delete').click();
    await expect(notifications(page).getByText(/^Deleted 3 tasks/)).toBeVisible();
    trace.push(await observe(page, [fixtures], 'deleted'));
    await attachTrace(testInfo, trace);
  });

  test('keys with a task open: Space checks it whichever checkbox has focus, and the title passes the arrows on', async ({ evidence }, testInfo) => {
    const { page, capture } = evidence;
    const pilot = await installPilotFixtures(page, { theme: testInfo.project.use.colorScheme });
    const fixtures = await installP43aFixtures(page);
    fixtures.state.pilot = true;
    // The pilot task, whose page every read is answered for, is the first row and the one open.
    fixtures.state.tasks = [pilotRow(), ...listTasks()];
    const sources = [fixtures, pilot];
    const trace = [];
    const checked = () => page.locator('.task-row.checked .task-title').allTextContents();
    // A step of this test is what the keys did: the rows checked, the menus and the address, and any write they
    // sent. The page's own reads meanwhile (the panel's, the list's polls) are the task page test's subject.
    const keyStep = async (name, extra = {}) => {
      const step = await observe(page, sources, name);
      return { ...step, requests: step.requests.filter((request) => request.method !== 'GET'), ...extra };
    };
    await page.goto(P43A_PATHS.task);
    await expect(page.locator('.task-detail-panel').getByText('Migrate the task detail pilot').first()).toBeVisible();
    await expect(taskRow(page, 'Review keyboard focus order')).toBeVisible();

    // Space checks the open task's row, though another row's checkbox has focus: the list takes the key,
    // and the focused checkbox does not act on it as well.
    const bar = page.locator('.tasks-bulkbar');
    await taskRow(page, 'Review keyboard focus order').getByRole('checkbox').focus();
    await page.keyboard.press('Space');
    await expect(bar.getByText('1 selected')).toBeVisible();
    await frames(page);
    trace.push(await keyStep('space with a task open', { checked: await checked() }));
    await capture('p43a-tasks-keys-space', { bar, row: taskRow(page, 'Migrate the task detail pilot') });
    await page.keyboard.press('Space');
    await expect(bar).toHaveCount(0);
    trace.push(await keyStep('space again', { checked: await checked() }));

    // The title keeps focus after a list is picked from its menu; ↑ and ↓ there step through the tasks, as
    // they did with the replaced dropdown, which had no arrow keys. ↑ on the first row stays put; ↓ opens the
    // next task (its first read held, so its page waits).
    await page.locator('.tasks-scope-trigger').focus();
    await page.keyboard.press('ArrowUp');
    await frames(page);
    trace.push(await keyStep('up on the title'));
    fixtures.state.holdRead = { id: P43A_IDS.runTask, gate: gate() };
    await page.keyboard.press('ArrowDown');
    await expect(page).toHaveURL(new RegExp(`/tasks/${P43A_IDS.runTask}(\\?|$)`));
    await frames(page);
    trace.push(await keyStep('down on the title'));
    await attachTrace(testInfo, trace);
  });
});

test.describe('P4.3a a task page', () => {
  test('loading, the schedule, the acceptance editor, attribution, a prerequisite question and mention deliveries', async ({ evidence }, testInfo) => {
    const { page, capture } = evidence;
    const pilot = await installPilotFixtures(page, { theme: testInfo.project.use.colorScheme });
    const fixtures = await installP43aFixtures(page);
    fixtures.state.pilot = true;
    Object.assign(pilot.state.task, { runAt: '2026-10-01T09:30:00.000Z', acceptanceCommand: 'npm test -w @orbit/web', acceptanceExpectedExitCode: 0 });
    pilot.state.task.comments = [pilot.state.task.comments[0], mentionComment()];
    const sources = [fixtures, pilot];
    const trace = [];
    // A fresh load of a task's address reads the task before anything is drawn.
    fixtures.state.holdTask = gate();
    fixtures.state.holdAttribution = gate();
    await page.goto(P43A_PATHS.task);
    const arriving = page.locator('main [aria-busy="true"]');
    await expect(arriving).toBeVisible();
    await frames(page);
    trace.push(await observe(page, sources, 'task loading'));
    await capture('p43a-task-loading', { loading: arriving });
    fixtures.state.holdTask.open();
    fixtures.state.holdTask = null;
    const panel = page.locator('.task-detail-panel');
    await expect(panel.getByText('Migrate the task detail pilot').first()).toBeVisible();
    const attribution = panel.locator(CARD).filter({ has: page.getByText('Attribution', { exact: true }) });
    await top(attribution);
    await frames(page);
    trace.push(await observe(page, sources, 'attribution loading'));
    await capture('p43a-task-attribution-loading', { card: attribution });
    fixtures.state.holdAttribution.open();
    fixtures.state.holdAttribution = null;
    await expect(attribution.getByText('Waiting for your answer')).toBeVisible();
    await top(attribution);
    await frames(page);
    trace.push(await observe(page, sources, 'attribution'));
    await capture('p43a-task-attribution', { card: attribution, copy: attribution.getByRole('button', { name: 'Copy' }).first() });
    if (!phone(testInfo)) {
      await attribution.getByRole('button', { name: 'Copy' }).first().hover();
      await expect(tooltip(page)).toBeVisible();
      await frames(page);
      trace.push({ ...(await observe(page, sources, 'copy tooltip')), tooltip: await tooltip(page).textContent() });
      await capture('p43a-task-attribution-copy', { tip: tooltip(page) });
      await page.mouse.move(0, 0);
    }

    // The schedule: a scheduled start, and an impossible time.
    const startAt = panel.getByLabel('Start at');
    await top(panel.locator('.tdp-schedule'));
    await frames(page);
    trace.push(await observe(page, sources, 'scheduled'));
    await capture('p43a-task-schedule', { schedule: panel.locator('.tdp-schedule'), cancel: button(panel, 'Cancel schedule') });
    await startAt.fill('0099-06-15T10:00');
    await expect(panel.locator('.tdp-schedule-error')).toBeVisible();
    await frames(page);
    trace.push(await observe(page, sources, 'impossible time'));
    await capture('p43a-task-schedule-invalid', { schedule: panel.locator('.tdp-schedule'), field: startAt });

    // The acceptance editor: a command without its exit code is refused before it is sent.
    const acceptance = panel.locator('section.tdp-section').filter({ has: page.getByText('Acceptance', { exact: true }) }).first();
    await top(acceptance);
    await button(acceptance, 'Edit').click();
    await expect(acceptance.getByRole('textbox', { name: 'Command' })).toBeVisible();
    await frames(page);
    trace.push(await observe(page, sources, 'acceptance editor'));
    await capture('p43a-task-acceptance-edit', { section: acceptance, criteria: acceptance.getByRole('textbox', { name: 'Acceptance criteria' }) });
    await fill(acceptance.getByRole('textbox', { name: 'done when it exits' }), '');
    await expect(acceptance.getByRole('alert')).toBeVisible();
    await frames(page);
    trace.push(await observe(page, sources, 'acceptance refused'));
    await capture('p43a-task-acceptance-invalid', { section: acceptance, alert: acceptance.getByRole('alert') });
    await button(acceptance, 'Cancel').click();
    await expect(button(acceptance, 'Edit')).toBeVisible();
    trace.push(await observe(page, sources, 'acceptance kept'));

    // A prerequisite's remove question, from the list view of the dependencies.
    const dependencies = panel.locator('section.tdp-section').filter({ has: page.getByText(/^Dependencies/) }).first();
    await top(dependencies);
    await dependencies.getByRole('radio', { name: 'List' }).click();
    await dependencies.getByRole('button', { name: 'Remove Capture browser baselines as a prerequisite' }).click();
    const remove = question(page, 'Remove prerequisite?');
    await expect(remove).toBeVisible();
    await frames(page);
    trace.push(await observe(page, sources, 'remove prerequisite asked'));
    await capture('p43a-task-prerequisite', { question: remove });
    await button(remove, 'Cancel').click();
    await expect(remove).toHaveCount(0);

    // Mention deliveries under a comment, and why one was not delivered.
    const deliveries = panel.locator('.tdp-mention-deliveries');
    await top(deliveries);
    await frames(page);
    trace.push(await observe(page, sources, 'mention deliveries'));
    await capture('p43a-task-mentions', { deliveries });
    if (!phone(testInfo)) {
      await deliveries.locator('.tdp-mention-delivery-blocked').hover();
      await expect(tooltip(page)).toBeVisible();
      await frames(page);
      trace.push({ ...(await observe(page, sources, 'held delivery')), tooltip: await tooltip(page).textContent() });
      await capture('p43a-task-mentions-tooltip', { tip: tooltip(page) });
      await page.mouse.move(0, 0);
    }
    await attachTrace(testInfo, trace);
  });
});
