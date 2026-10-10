import { test, expect } from './harness.mjs';
import { P51_IDS, P51_PATHS, gate, installP51Fixtures, resetSucceeded } from './p51-fixtures.mjs';

// P5.1 states, which the P0 matrix reaches only in part (the sidebar as every page draws it, the session page's
// composer): the sidebar's rows, its account menu, Appearance and the photo; the collapsed rail and its tips; the ⌘K
// palette's recents, results, keys, loading and empty states; the worktree bar's merge targets with their search, the
// failure and divergence tips and the diff drawer (full screen, side panel, Unified/Split); the Move panel, its new
// folder, another workspace and the confirmation; the Plan usage popover by hover and by press, the reset credit's
// confirmation and what it starts; and the New Session engine picker. Locators are roles, accessible names, labels and
// the pages' own classes, so the same file drives the replaced controls (same-commit reference tree) and the Orbit
// ones; a painted box is named by both class names. Screenshots, computed styles and each step's observation (`trace`:
// address, focus, open dialogs and menus, alerts, notifications and the requests a press sends) are compared between
// the two runs (p44.browser.mjs's method).

const DIALOG = '.ant-modal-container, .orbit-dialog';
const CONFIRM = '.ant-modal-confirm .ant-modal-container, .orbit-confirm';
const DRAWER = '.ant-drawer-content-wrapper, .orbit-drawer';
const POPOVER = '.ant-popover:not(.ant-popover-hidden), .orbit-popover';
const TIP = '.ant-tooltip:not(.ant-tooltip-hidden), .orbit-tooltip';
const PALETTE = '.ssearch-modal .ant-modal-container, .orbit-dialog.ssearch-modal';
const MERGE_MENU = '.wt-merge-menu-panel, .orbit-menu.wt-merge-menu';

const frames = (page) => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// A replaced control's icon names itself ("setting Settings"); Orbit's hide their icons from the name.
const named = (name) => new RegExp(`^(?:[a-z]+(?:-[a-z]+)* )?${escape(name)}$`);
const item = (page, name) => page.getByRole('menuitem', { name: typeof name === 'string' ? named(name) : name }).filter({ visible: true });
const visible = (page, selector) => page.locator(selector).filter({ visible: true }).last();
const dialog = (page, title) => page.locator('[role="dialog"], [role="alertdialog"]')
  .filter({ has: page.getByText(title, { exact: true }) }).filter({ visible: true }).last();
const notifications = (page) => page.getByRole('region', { name: 'Notifications', exact: true });
const toastsGone = (page) => expect(page.locator('.toast-viewport .toast-slot')).toHaveCount(0, { timeout: 20_000 });
const phone = (testInfo) => !!testInfo.project.use.isMobile;
// A closed replaced popup stays in the page, hidden; an Orbit one leaves it. Gone is checked as hidden, which holds for both.

/** Wait until an open layer is drawn: sized, and it and its ancestors opaque. A replaced popup starts its enter at no
 *  size and no opacity, before any animation runs, whatever motion is asked for. */
const drawn = (locator) => expect.poll(() => locator.evaluate((el) => {
  const rect = el.getBoundingClientRect();
  if (!rect.width || !rect.height) return false;
  for (let node = el; node; node = node.parentElement) if (Number(getComputedStyle(node).opacity) < 1) return false;
  return true;
}), { timeout: 15_000 }).toBe(true);

/** Wait until a layer is drawn in full: it and its ancestors opaque and untransformed. */
const still = (locator) => expect.poll(() => locator.evaluate((el) => {
  for (let node = el; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (Number(style.opacity) < 1 || style.transform !== 'none') return false;
  }
  return true;
}), { timeout: 15_000 }).toBe(true);

/** Wait out enter and leave animations (the replaced controls run theirs whatever motion is asked for), two frames
 *  on: a replaced popup starts its leave a frame after it is told to close, when there is nothing running yet to wait for. */
const settled = async (page) => {
  await frames(page);
  await page.waitForFunction(
    () => document.getAnimations().every((animation) => animation.playState !== 'running' || animation.effect?.getTiming().iterations === Infinity),
    null, { timeout: 3000 },
  ).catch(() => {});
};

/** Every menu has closed (a closed replaced menu stays in the page, hidden). */
const menusGone = (page) => expect(page.locator('[role="menu"]').filter({ visible: true })).toHaveCount(0);

async function observe(page, sources, step) {
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
      theme: document.documentElement.dataset.theme,
      // The sidebar row the page belongs to (a deep link to a session lights its workspace).
      lit: [...document.querySelectorAll('aside.app-nav .tp-item.active, aside.app-nav .tp-rail-item.active')].map((el) => el.textContent.trim().replace(/\s+/g, ' ')),
      focus: active && active !== document.body ? { role: active.getAttribute('role') ?? active.tagName.toLowerCase(), name: name(active) } : 'body',
      dialogs: [...document.querySelectorAll('[role="dialog"],[role="alertdialog"]')].filter(visible).map((el) => el.textContent.trim().replace(/\s+/g, ' ').slice(0, 160)),
      menus: [...document.querySelectorAll('[role="menu"]')].filter(visible).map((el) => [...el.querySelectorAll('[role="menuitem"]')].map((entry) => ({
        text: entry.textContent.trim(), disabled: entry.getAttribute('aria-disabled') === 'true' || entry.hasAttribute('data-disabled') }))),
      // A replaced popover's box carries role=tooltip where an Orbit popover is a dialog (the convention accepted in
      // P2–P4, counted with the dialogs): the tips are the tooltips alone, and an open popover's words are kept apart.
      tips: [...document.querySelectorAll('[role="tooltip"]')].filter((el) => !el.closest('.ant-popover') && visible(el))
        .map((el) => el.textContent.trim().replace(/\s+/g, ' ')).filter(Boolean),
      popovers: [...document.querySelectorAll('.ant-popover, .orbit-popover')].filter(visible).map((el) => el.textContent.trim().replace(/\s+/g, ' ')).filter(Boolean),
      alerts: [...document.querySelectorAll('[role="alert"]')].filter(visible).map((el) => el.textContent.trim().replace(/\s+/g, ' ')).filter(Boolean),
      notifications: notifications ? notifications.innerText.trim().replace(/\s+/g, ' ') : '',
      // The runtime census: AntD-classed elements drawn anywhere (the sidebar included, P5.1's own), by class; an
      // icon's `anticon` is allowed and not counted.
      antd: [...new Set([...document.querySelectorAll('[class*="ant-"]')]
        .filter((el) => visible(el))
        .flatMap((el) => [...el.classList].filter((token) => token.startsWith('ant-') && !token.startsWith('anticon'))
          .map((token) => token.replace(/-(?:css-var|hash)-.*$/, ''))))].sort().slice(0, 40),
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

/** The sidebar: on a phone, the drawer the top bar's menu button opens. */
async function sidebar(page, testInfo) {
  const nav = page.locator('aside.app-nav');
  if (phone(testInfo)) {
    await page.getByRole('button', { name: 'Open menu', exact: true }).click();
    await expect(nav).toHaveClass(/\bopen\b/);
  }
  await expect(nav.locator('.tp-user-trigger')).toBeVisible();
  await settled(page);
  return nav;
}

/** The session workspace has drawn: its composer, or the bar it is waiting for. */
async function sessionPage(page, path, ready) {
  await page.goto(path);
  // The session workspace is the heaviest page here; a loaded host needs longer than the default to draw it.
  await expect(ready(page)).toBeVisible({ timeout: 45_000 });
  await settled(page);
}

test.describe('P5.1 the sidebar', () => {
  test('its rows, the account menu, Appearance and the photo', async ({ evidence }, testInfo) => {
    const { page, capture } = evidence;
    const theme = testInfo.project.use.colorScheme;
    const fixtures = await installP51Fixtures(page, { theme });
    const trace = [];
    await page.goto(P51_PATHS.projects);
    await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();
    const nav = await sidebar(page, testInfo);
    await expect(nav.locator('.tp-item').filter({ hasText: 'docs-site' })).toBeVisible();
    trace.push(await observe(page, [fixtures], 'sidebar'));
    await capture('p51-sidebar', { nav, user: nav.locator('.tp-user-trigger') });

    // The account menu: profile, Appearance, Settings, Admin (an admin's), Log out.
    const trigger = nav.locator('.tp-user-trigger');
    await trigger.click();
    const menu = page.locator('[role="menu"].tp-account-menu').filter({ visible: true });
    await expect(item(page, 'Settings')).toBeVisible();
    await drawn(menu);
    await settled(page);
    trace.push(await observe(page, [fixtures], 'account menu'));
    await capture('p51-account-menu', { menu, profile: menu.locator('.tp-account-profile-content') });

    // Appearance opens its submenu on hover; the current mode is checked.
    await item(page, /Appearance/).hover();
    await expect(item(page, 'Dark')).toBeVisible();
    await drawn(item(page, 'Dark'));
    await settled(page);
    trace.push(await observe(page, [fixtures], 'appearance'));
    await capture('p51-appearance', { dark: item(page, 'Dark'), system: item(page, 'System') });
    // Pick the other mode: the page follows and the account is told; then back, so later shots keep the project's.
    // The pointer moves on after a pick, as a person's does: the replaced submenu stays drawn under the closed menu
    // while the pointer rests on the row it pressed.
    const away = async () => {
      const heading = await page.getByRole('heading', { name: 'Projects', exact: true }).boundingBox();
      await page.mouse.move(...(phone(testInfo) ? [370, 400] : [heading.x + 20, heading.y + heading.height / 2]));
      await menusGone(page);
    };
    const other = theme === 'dark' ? 'Light' : 'Dark';
    await item(page, other).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', other.toLowerCase());
    await away();
    trace.push(await observe(page, [fixtures], `picked ${other}`));
    await trigger.click();
    await item(page, /Appearance/).hover();
    await item(page, theme === 'dark' ? 'Dark' : 'Light').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await away();
    trace.push(await observe(page, [fixtures], 'picked back'));

    // Escape closes the menu where it opened.
    await trigger.click();
    await expect(item(page, 'Settings')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(item(page, 'Settings')).toHaveCount(0);
    trace.push(await observe(page, [fixtures], 'escape'));

    // Settings goes to its page (and a phone's drawer closes).
    await trigger.click();
    await item(page, 'Settings').click();
    await expect(page).toHaveURL(/\/settings$/);
    await expect(page.locator('h1.page-title').filter({ hasText: /^Settings$/ })).toBeVisible();
    await menusGone(page);
    if (phone(testInfo)) await expect(nav).not.toHaveClass(/\bopen\b/);
    trace.push(await observe(page, [fixtures], 'settings'));
    // Back returns to the page the menu was opened on.
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`${P51_PATHS.projects}$`));
    await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();
    trace.push(await observe(page, [fixtures], 'back'));
    if (phone(testInfo)) {
      // A press on the backdrop closes the drawer too.
      await sidebar(page, testInfo);
      await page.locator('.app-nav-backdrop').click({ position: { x: 370, y: 400 } });
      await expect(nav).not.toHaveClass(/\bopen\b/);
      trace.push(await observe(page, [fixtures], 'backdrop'));
    }

    // With a photo, the avatars draw it in place of the person.
    fixtures.state.avatar = true;
    await page.goto(P51_PATHS.projects);
    const navAgain = await sidebar(page, testInfo);
    await expect(navAgain.locator('.tp-user-trigger img')).toBeVisible();
    trace.push(await observe(page, [fixtures], 'photo'));
    await capture('p51-sidebar-photo', { user: navAgain.locator('.tp-user-trigger') });
    await navAgain.locator('.tp-user-trigger').click();
    await expect(page.locator('[role="menu"].tp-account-menu img').filter({ visible: true })).toBeVisible();
    await drawn(page.locator('[role="menu"].tp-account-menu').filter({ visible: true }));
    await settled(page);
    await capture('p51-account-menu-photo', { profile: page.locator('.tp-account-profile-content').filter({ visible: true }) });
    await attachTrace(testInfo, trace);
  });

  test('the collapsed rail and its tips', async ({ evidence }, testInfo) => {
    test.skip(phone(testInfo), 'The rail is the desktop sidebar collapsed; a phone has the drawer.');
    const { page, capture } = evidence;
    const fixtures = await installP51Fixtures(page, { theme: testInfo.project.use.colorScheme });
    const trace = [];
    await page.goto(P51_PATHS.projects);
    const nav = await sidebar(page, testInfo);

    // A row's offline mark explains itself.
    const offline = nav.locator('.tp-item').filter({ hasText: 'docs-site' }).locator('.tp-workspace-icon-offline');
    await offline.hover();
    const tip = visible(page, TIP);
    await expect(tip).toHaveText('Studio Mac is offline');
    await drawn(tip);
    await settled(page);
    trace.push(await observe(page, [fixtures], 'row offline tip'));
    await capture('p51-row-offline-tip', { tip });
    await page.mouse.move(640, 600);
    await expect(page.locator(TIP).filter({ visible: true })).toHaveCount(0);

    await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click();
    await expect(nav).toHaveClass(/\bcollapsed\b/);
    await settled(page);
    trace.push(await observe(page, [fixtures], 'rail'));
    await capture('p51-rail', { nav });
    for (const [mark, words, shot] of [
      ['.tp-rail-offline', 'Studio Mac is offline', 'p51-rail-offline-tip'],
      ['.tp-rail-running', 'Running', 'p51-rail-running-tip'],
      ['.tp-rail-jobs', '2 background jobs running', 'p51-rail-jobs-tip'],
    ]) {
      await nav.locator(mark).hover();
      const railTip = visible(page, TIP);
      await expect(railTip).toHaveText(words);
      await drawn(railTip);
      await settled(page);
      trace.push(await observe(page, [fixtures], `rail tip ${words}`));
      await capture(shot, { tip: railTip });
      await page.mouse.move(640, 600);
      await expect(page.locator(TIP).filter({ visible: true })).toHaveCount(0);
    }
    // The account menu opens from the rail's avatar too, its rows the same.
    await nav.locator('.tp-user-trigger').click();
    await expect(item(page, 'Admin')).toBeVisible();
    await drawn(page.locator('[role="menu"].tp-account-menu').filter({ visible: true }));
    await settled(page);
    trace.push(await observe(page, [fixtures], 'rail account menu'));
    await capture('p51-rail-account-menu', { menu: page.locator('[role="menu"].tp-account-menu').filter({ visible: true }) });
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Expand sidebar', exact: true }).click();
    await expect(nav).not.toHaveClass(/\bcollapsed\b/);
    await attachTrace(testInfo, trace);
  });
});

test.describe('P5.1 ⌘K', () => {
  test('recents, results, keys, loading and the empty answer', async ({ evidence }, testInfo) => {
    const { page, capture } = evidence;
    const fixtures = await installP51Fixtures(page, { theme: testInfo.project.use.colorScheme });
    const trace = [];
    await sessionPage(page, P51_PATHS.session, (p) => p.locator('.composer-field textarea'));
    const input = page.getByPlaceholder('Search sessions and the wiki…');
    const palette = visible(page, PALETTE);

    await page.keyboard.press('ControlOrMeta+k');
    await expect(input).toBeFocused();
    await expect(page.locator('.ssearch-row')).toHaveCount(3);
    await still(palette);
    trace.push(await observe(page, [fixtures], 'recents'));
    await capture('p51-search-recents', { palette, input });

    await input.pressSequentially('merge');
    await expect(page.locator('.wk-pal-group').first()).toBeVisible();
    await expect(page.locator('.ssearch-row')).toHaveCount(4);
    await settled(page);
    trace.push({ ...(await observe(page, [fixtures], 'results')), rows: await page.locator('.ssearch-row').allInnerTexts() });
    await capture('p51-search-results', { palette, active: page.locator('.ssearch-row.active') });
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('.ssearch-row').nth(2)).toHaveClass(/\bactive\b/);
    trace.push({ ...(await observe(page, [fixtures], 'arrows')), active: await page.locator('.ssearch-row.active').innerText() });
    await capture('p51-search-arrows', { palette, active: page.locator('.ssearch-row.active') });

    // Escape closes it, wherever focus is.
    await page.keyboard.press('Escape');
    await expect(input).toBeHidden();
    trace.push(await observe(page, [fixtures], 'escape'));

    // A query with nothing to find, and one too short for the messages.
    await page.keyboard.press('ControlOrMeta+k');
    await expect(input).toBeFocused();
    await input.pressSequentially('nothing');
    await expect(page.getByText('No sessions match “nothing”.', { exact: true })).toBeVisible();
    await settled(page);
    trace.push(await observe(page, [fixtures], 'empty'));
    await capture('p51-search-empty', { palette });
    await fill(input, 'me');
    await expect(page.locator('.ssearch-hint-warn')).toBeVisible();
    await settled(page);
    trace.push(await observe(page, [fixtures], 'short'));
    await capture('p51-search-short', { palette, hint: page.locator('.ssearch-hint-warn') });

    // While a search is in flight the head shows its spinner, the old answer still listed.
    const hold = gate();
    fixtures.state.searchHold = hold;
    await fill(input, 'review');
    await expect(visible(page, '.ssearch-head [aria-busy="true"], .ssearch-head .ant-spin, .ssearch-head .orbit-spinner')).toBeVisible();
    trace.push(await observe(page, [fixtures], 'loading'));
    await capture('p51-search-loading', { palette, spinner: visible(page, '.ssearch-head .ant-spin, .ssearch-head .orbit-spinner') });
    fixtures.state.searchHold = null;
    hold.release();
    await expect(page.locator('.ssearch-head .ant-spin, .ssearch-head .orbit-spinner')).toBeHidden();
    await expect(page.locator('.ssearch-row')).toHaveCount(3);

    // Enter opens the highlighted session; the palette closes.
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`/sessions/${P51_IDS.codexSession}$`));
    await expect(input).toBeHidden();
    trace.push(await observe(page, [fixtures], 'opened'));
    // Back returns to the conversation the palette was opened over.
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`${P51_PATHS.session}$`));
    await expect(page.locator('.composer-field textarea')).toBeVisible({ timeout: 45_000 });
    trace.push(await observe(page, [fixtures], 'back'));

    // A press outside the palette closes it.
    await page.keyboard.press('ControlOrMeta+k');
    await expect(input).toBeFocused();
    await settled(page);
    await page.mouse.click(10, testInfo.project.use.viewport.height - 10);
    await expect(input).toBeHidden();
    trace.push(await observe(page, [fixtures], 'outside'));
    await attachTrace(testInfo, trace);
  });
});

test.describe('P5.1 the worktree bar', () => {
  test('merge targets, the branch search and the failure and divergence tips', async ({ evidence }, testInfo) => {
    const { page, capture } = evidence;
    const fixtures = await installP51Fixtures(page, { theme: testInfo.project.use.colorScheme });
    const trace = [];
    const bar = page.locator('.wt-bar').first();
    await sessionPage(page, P51_PATHS.codex, () => bar);
    await expect(bar.getByRole('button', { name: 'Merge to main', exact: true })).toBeVisible();
    trace.push(await observe(page, [fixtures], 'bar'));
    await capture('p51-wt-bar', { bar });

    // Twelve branches: the menu scrolls and its search sits under it.
    const caret = page.getByRole('button', { name: 'Choose a branch to merge into', exact: true });
    await caret.click();
    const menu = visible(page, MERGE_MENU);
    await expect(item(page, 'release/1.1')).toBeVisible();
    await drawn(menu);
    await settled(page);
    trace.push(await observe(page, [fixtures], 'targets'));
    await capture('p51-merge-menu', { menu, search: page.getByPlaceholder('Search branches…') });
    const search = page.getByPlaceholder('Search branches…');
    await fill(search, 'rel');
    await expect(item(page, /^release\//)).toHaveCount(3);
    await settled(page);
    trace.push(await observe(page, [fixtures], 'filtered'));
    await capture('p51-merge-menu-filtered', { menu });
    await fill(search, 'zzz');
    await expect(page.getByText('No matching branches', { exact: true })).toBeVisible();
    await settled(page);
    trace.push(await observe(page, [fixtures], 'nothing matches'));
    await capture('p51-merge-menu-empty', { menu });
    await page.keyboard.press('Escape');
    await expect(page.getByPlaceholder('Search branches…')).toBeHidden();
    trace.push(await observe(page, [fixtures], 'escape'));

    // A pick only re-points the button; the merge waits for its press.
    await caret.click();
    await item(page, 'release/1.1').click();
    await expect(bar.getByRole('button', { name: 'Merge to release/1.1', exact: true })).toBeVisible();
    await menusGone(page);
    trace.push(await observe(page, [fixtures], 'picked'));
    await bar.getByRole('button', { name: 'Merge to release/1.1', exact: true }).click();
    await expect.poll(() => fixtures.requests.some((r) => r.path.endsWith('/merge'))).toBe(true);
    trace.push(await observe(page, [fixtures], 'merge pressed'));
    await toastsGone(page);

    // Three branches: a plain menu.
    fixtures.state.targets = 'short';
    await sessionPage(page, P51_PATHS.codex, () => bar);
    await caret.click();
    await expect(item(page, 'develop')).toBeVisible();
    await drawn(visible(page, MERGE_MENU));
    await settled(page);
    trace.push(await observe(page, [fixtures], 'short targets'));
    await capture('p51-merge-menu-short', { menu: visible(page, MERGE_MENU) });
    await page.keyboard.press('Escape');

    // What a failed merge and a moved branch say on hover.
    for (const [merge, label, words, shot] of [
      ['conflict', 'Resolve in session', 'Merge conflict', 'p51-merge-conflict-tip'],
      ['error', 'Retry merge to main', 'uncommitted changes', 'p51-merge-error-tip'],
      ['diverged', null, 'which Orbit isn\'t tracking', 'p51-diverged-tip'],
    ]) {
      fixtures.state.merge = merge;
      await sessionPage(page, P51_PATHS.codex, () => bar);
      const target = label ? bar.getByRole('button', { name: label, exact: true }) : bar.locator('.wt-diverged-label');
      await expect(target).toBeVisible();
      if (phone(testInfo)) {
        trace.push({ ...(await observe(page, [fixtures], `${merge} bar`)), label: await target.innerText() });
        continue;
      }
      await target.hover();
      const tip = visible(page, TIP);
      await expect(tip).toContainText(words);
      await drawn(tip);
      await settled(page);
      trace.push(await observe(page, [fixtures], `${merge} tip`));
      await capture(shot, { tip, bar });
      await page.mouse.move(640, 80);
    }
    await attachTrace(testInfo, trace);
  });

  test('the diff drawer: full screen, side panel and the two views', async ({ evidence }, testInfo) => {
    const { page, capture } = evidence;
    const fixtures = await installP51Fixtures(page, { theme: testInfo.project.use.colorScheme });
    const trace = [];
    const bar = page.locator('.wt-bar').first();
    await sessionPage(page, P51_PATHS.codex, () => bar);
    await bar.locator('.wt-stat').click();
    const drawer = visible(page, DRAWER);
    await expect(page.locator('.wt-diff-pane-path')).toHaveText('docs/evidence/p5.1/README.md');
    await still(drawer);
    await expect(page.locator('.wt-diff-view').first()).toBeVisible();
    trace.push(await observe(page, [fixtures], 'full screen'));
    await capture('p51-diff-max', { drawer, head: page.locator('.wt-diff-head') });

    // Pressed by its words, as a person does: the replaced control's radio input is hidden under its label.
    await page.locator('.wt-diff-pane-head').getByText('Unified', { exact: true }).click();
    await expect(page.getByRole('radio', { name: 'Unified', exact: true })).toBeChecked();
    await expect(page.locator('.wt-diff-split')).toBeHidden();
    trace.push(await observe(page, [fixtures], 'unified'));
    await capture('p51-diff-unified', { drawer });
    await page.getByRole('button', { name: 'Next file', exact: true }).click();
    // In the tree's order: a folder's subfolders before its files.
    await expect(page.locator('.wt-diff-pane-path')).toHaveText('src/web/src/components/ui/Menu.tsx');
    trace.push(await observe(page, [fixtures], 'next file'));

    await page.getByRole('button', { name: /^(?:[a-z-]+ )?Restore$/ }).click();
    await expect(page.getByRole('button', { name: /^(?:[a-z-]+ )?Maximize$/ })).toBeVisible();
    await still(visible(page, DRAWER));
    await settled(page);
    trace.push(await observe(page, [fixtures], 'side panel'));
    await capture('p51-diff-panel', { drawer: visible(page, DRAWER) });
    await page.locator('.wt-diff-pane-head').getByText('Split', { exact: true }).click();
    await expect(page.getByRole('radio', { name: 'Split', exact: true })).toBeChecked();
    await expect(page.locator('.wt-diff-split')).toBeVisible();
    trace.push(await observe(page, [fixtures], 'split'));

    await page.keyboard.press('Escape');
    await expect(page.locator('.wt-diff-pane-path')).toBeHidden();
    await expect(page.locator(DRAWER).filter({ visible: true })).toHaveCount(0);
    trace.push(await observe(page, [fixtures], 'closed'));
    await attachTrace(testInfo, trace);
  });
});

test.describe('P5.1 Move', () => {
  test('the panel, a new folder, another workspace and the confirmation', async ({ evidence }, testInfo) => {
    const { page, capture } = evidence;
    const fixtures = await installP51Fixtures(page, { theme: testInfo.project.use.colorScheme });
    const trace = [];
    await sessionPage(page, P51_PATHS.session, (p) => p.locator('.composer-field textarea'));
    await page.locator('.workspace-header button[title="More actions"]').click();
    await item(page, 'Move…').click();
    // By its own class: its title becomes the workspace's name on a workspace's step.
    const panel = visible(page, '.move-dialog');
    await expect(panel.getByRole('button', { name: /wikova-develop/ })).toBeVisible();
    await still(visible(page, DIALOG));
    await menusGone(page);
    trace.push(await observe(page, [fixtures], 'move'));
    await capture('p51-move', { dialog: visible(page, DIALOG) });

    // New Folder…: an inline name; Escape cancels the name, not the panel.
    await panel.getByRole('button', { name: /New Folder/ }).click();
    const name = panel.getByRole('textbox', { name: 'New folder name' });
    await expect(name).toBeFocused();
    await name.pressSequentially('Drafts');
    trace.push(await observe(page, [fixtures], 'naming'));
    await capture('p51-move-naming', { dialog: visible(page, DIALOG) });
    await page.keyboard.press('Escape');
    await expect(name).toHaveCount(0);
    await expect(panel).toBeVisible();
    trace.push(await observe(page, [fixtures], 'name cancelled'));

    // Another workspace: its folders, then the question.
    await panel.getByRole('button', { name: /wikova-develop/ }).click();
    await expect(panel.getByRole('button', { name: /Reviews/ })).toBeVisible();
    await settled(page);
    trace.push(await observe(page, [fixtures], 'workspace step'));
    await capture('p51-move-step', { dialog: visible(page, DIALOG) });
    await panel.getByRole('button', { name: /Reviews/ }).click();
    const question = dialog(page, 'Move to wikova-develop?');
    await expect(question).toBeVisible();
    await still(visible(page, CONFIRM));
    await settled(page);
    trace.push(await observe(page, [fixtures], 'question'));
    await capture('p51-move-confirm', { confirm: visible(page, CONFIRM) });
    await question.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(question).toHaveCount(0);
    trace.push(await observe(page, [fixtures], 'question cancelled'));

    // End and Move: the panel shows each step while it runs, then says where the session went. The end is held, so
    // the step is drawn over the page as it was (the session not yet re-read as ended).
    await panel.getByRole('button', { name: /Reviews/ }).click();
    await expect(dialog(page, 'Move to wikova-develop?')).toBeVisible();
    const hold = gate();
    fixtures.state.endHold = hold;
    await dialog(page, 'Move to wikova-develop?').getByRole('button', { name: 'End and Move', exact: true }).click();
    const progress = panel.locator('.move-dialog-progress');
    await expect(progress).toHaveText('Ending the session…');
    await expect(dialog(page, 'Move to wikova-develop?')).toHaveCount(0);
    await settled(page);
    trace.push(await observe(page, [fixtures], 'ending'));
    await capture('p51-move-progress', { dialog: visible(page, DIALOG), progress });
    fixtures.state.endHold = null;
    hold.release();
    await expect(notifications(page).getByText('Moved to wikova-develop', { exact: false })).toBeVisible();
    await expect(panel).toHaveCount(0);
    trace.push(await observe(page, [fixtures], 'moved'));
    await toastsGone(page);
    await attachTrace(testInfo, trace);
  });
});

test.describe('P5.1 Plan usage', () => {
  test('the popover by hover and by press, the reset credit and its confirmation', async ({ evidence }, testInfo) => {
    const { page, capture } = evidence;
    const fixtures = await installP51Fixtures(page, { theme: testInfo.project.use.colorScheme });
    const trace = [];
    const pill = page.getByRole('button', { name: /^Plan usage 92%/ });
    await sessionPage(page, P51_PATHS.codex, () => pill);
    const popover = visible(page, POPOVER);

    if (!phone(testInfo)) {
      // A hover shows it and leaves focus where it was.
      await page.locator('.composer-field textarea').focus();
      await pill.hover();
      await expect(page.getByText('Reset credit', { exact: true })).toBeVisible();
      await drawn(popover);
      await settled(page);
      trace.push(await observe(page, [fixtures], 'hover'));
      await capture('p51-usage-hover', { popover });
      await page.mouse.move(640, 80);
      await expect(page.getByText('Reset credit', { exact: true })).toBeHidden();
      await settled(page);
    }

    // A press opens it with focus inside.
    await pill.click();
    await expect(page.getByText('Reset credit', { exact: true })).toBeVisible();
    await drawn(popover);
    await settled(page);
    trace.push(await observe(page, [fixtures], 'pressed'));
    await capture('p51-usage', { popover, use: page.getByRole('button', { name: 'Use reset credit', exact: true }) });
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Use reset credit', exact: true })).toBeFocused();
    trace.push(await observe(page, [fixtures], 'tab'));

    // The second confirmation, with focus on Cancel; cancelling puts focus back on the entry.
    await page.getByRole('button', { name: 'Use reset credit', exact: true }).click();
    const confirm = dialog(page, 'Use reset credit?');
    await expect(confirm).toBeVisible();
    await expect(confirm.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
    await still(visible(page, DIALOG));
    await settled(page);
    trace.push(await observe(page, [fixtures], 'confirmation'));
    await capture('p51-reset-confirm', { dialog: visible(page, DIALOG), usage: confirm.locator('.cu-rc-confirm-usage') });
    await confirm.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(confirm).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Use reset credit', exact: true })).toBeFocused();
    trace.push(await observe(page, [fixtures], 'cancelled'));

    // A create nobody answers: after the automatic re-sends, Retry is the user's; Dismiss brings the entry back.
    fixtures.state.resetUnanswered = true;
    await page.getByRole('button', { name: 'Use reset credit', exact: true }).click();
    await dialog(page, 'Use reset credit?').getByRole('button', { name: 'Use reset', exact: true }).click();
    await expect(page.getByText('Couldn’t confirm the reset request', { exact: true })).toBeVisible({ timeout: 30_000 });
    await settled(page);
    trace.push(await observe(page, [fixtures], 'unanswered'));
    await capture('p51-reset-unanswered', { popover: visible(page, POPOVER), retry: page.getByRole('button', { name: 'Retry', exact: true }) });
    await page.getByRole('button', { name: 'Dismiss', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Use reset credit', exact: true })).toBeFocused();
    trace.push(await observe(page, [fixtures], 'unanswered dismissed'));

    // Use reset sends one create; the status line takes focus.
    fixtures.state.resetUnanswered = false;
    await page.getByRole('button', { name: 'Use reset credit', exact: true }).click();
    await dialog(page, 'Use reset credit?').getByRole('button', { name: 'Use reset', exact: true }).click();
    await expect(page.getByText('Starting reset…', { exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('role'))).toBe('status');
    await settled(page);
    trace.push(await observe(page, [fixtures], 'started'));
    await capture('p51-reset-started', { popover: visible(page, POPOVER) });

    // The operation settles: the line says so, and Dismiss brings the entry back with focus on it.
    resetSucceeded(fixtures.state);
    await expect(page.getByText('Usage limits reset', { exact: true }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Dismiss', exact: true })).toBeVisible();
    await toastsGone(page);
    await settled(page);
    trace.push(await observe(page, [fixtures], 'settled'));
    await capture('p51-reset-done', { popover: visible(page, POPOVER), dismiss: page.getByRole('button', { name: 'Dismiss', exact: true }) });
    await page.getByRole('button', { name: 'Dismiss', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Use reset credit', exact: true })).toBeFocused();
    trace.push(await observe(page, [fixtures], 'dismissed'));

    // Escape closes the popover onto the pill.
    await page.keyboard.press('Escape');
    await expect(page.getByText('Reset credit', { exact: true })).toBeHidden();
    await expect(pill).toBeFocused();
    trace.push(await observe(page, [fixtures], 'escape'));
    await attachTrace(testInfo, trace);
  });
});

test.describe('P5.1 New Session', () => {
  test('the engine picker', async ({ evidence }, testInfo) => {
    const { page, capture } = evidence;
    const fixtures = await installP51Fixtures(page, { theme: testInfo.project.use.colorScheme });
    const trace = [];
    const card = page.getByRole('button', { name: /^Engine: / });
    await sessionPage(page, P51_PATHS.newSession, () => card);
    trace.push({ ...(await observe(page, [fixtures], 'new session')), card: await card.getAttribute('aria-label') });
    await capture('p51-new-session', { card });
    await card.click();
    const list = visible(page, POPOVER);
    await expect(list.locator('.np-row').first()).toBeVisible();
    await drawn(list);
    await settled(page);
    trace.push({ ...(await observe(page, [fixtures], 'engines')), rows: await list.locator('.np-row').allInnerTexts() });
    await capture('p51-engines', { list, card });
    await page.keyboard.press('Escape');
    await expect(page.locator('.np-row').filter({ visible: true })).toHaveCount(0);
    trace.push(await observe(page, [fixtures], 'escape'));
    await card.click();
    await expect(page.locator('.np-row').filter({ hasText: 'Codex' }).first()).toBeVisible();
    await page.locator('.np-row').filter({ hasText: 'Codex' }).first().click();
    await expect(card).toHaveAttribute('aria-label', 'Engine: Codex');
    trace.push(await observe(page, [fixtures], 'picked Codex'));
    await attachTrace(testInfo, trace);
  });
});

