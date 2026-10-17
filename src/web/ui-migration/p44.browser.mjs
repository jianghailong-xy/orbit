import { test, expect } from './harness.mjs';
import { DECIDE_REFUSAL, P44_DOC, P44_PATHS, gate, installP44Fixtures } from './p44-fixtures.mjs';
import { P43A_PATHS, installP43aFixtures } from './p43a-fixtures.mjs';

// P4.4 states, which the P0 matrix reaches only in part (the Wiki home and its new entry dialog): the Wiki's head and
// home, the new entry form and the share dialog; a written document's marks, footnote cards and phone sheet; a topic
// article's footnote cards; the entry drawer's answers, menus and forms; Review's cards, edit form, refusal, challenge
// and phone pager; the plan's versions, compare, redraft, edit drawer and section form, and the plan before one
// exists; Wiki settings (modes, spot checks, maintenance set-up, maintenance on); Activity and a run with its revert;
// Settings → Shared links in every state; the public project and wiki pages; Following in every tab; the watch editor
// on a task and a conversation's watch chips; and the default landing while it reads. Locators are roles, accessible
// names, labels and the pages' own classes, so the same file drives the replaced controls (same-commit reference
// tree) and the Orbit ones; a painted box is named by both class names. Screenshots, computed styles and each step's
// observation (`trace`: address, focus, open dialogs and menus, alerts, notifications, the choices that are on and the
// requests a press sends) are compared between the two runs (p43a.browser.mjs's method).

const DIALOG = '.ant-modal-container, .orbit-dialog';
const CONFIRM = '.ant-modal-confirm .ant-modal-container, .orbit-confirm';
const DRAWER = '.ant-drawer-content-wrapper, .orbit-drawer';
const POPOVER = '.ant-popover:not(.ant-popover-hidden), .orbit-popover';
const TIP = '.ant-tooltip:not(.ant-tooltip-hidden), .orbit-tooltip';
const SELECT_OPTION = '[role="option"], .ant-select-item-option';
const CARD = '.ant-card, .orbit-card';

const frames = (page) => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
// A replaced button's icon names itself ("plus New entry"), and its loading icon can stay in the name ("loading
// Record"); Orbit buttons hide both from the name.
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const named = (name) => new RegExp(`^(?:loading |[a-z]+(?:-[a-z]+)* )?${escape(name)}(?: (?:down|right))?$`);
const button = (scope, name) => scope.getByRole('button', { name: named(name) });
const item = (page, name) => page.getByRole('menuitem', { name: typeof name === 'string' ? named(name) : name });
// The open menu: the replaced dropdown keeps closed ones in the page, hidden.
const openMenu = (page) => page.getByRole('menu').filter({ visible: true }).last();
// An anchored question (role=tooltip on the replaced popover, role=dialog on the Orbit one) or a modal one (role=dialog
// on the replaced confirm, role=alertdialog on the Orbit one), by its title.
const question = (page, title) => page.locator('[role="tooltip"], [role="dialog"], [role="alertdialog"]')
  .filter({ has: page.getByText(title, { exact: true }) }).filter({ visible: true }).last();
const dialog = (page, title) => page.locator('[role="dialog"], [role="alertdialog"]')
  .filter({ has: page.getByText(title, { exact: true }) }).filter({ visible: true }).last();
const notifications = (page) => page.getByRole('region', { name: 'Notifications', exact: true });
const option = (page, label) => page.locator(SELECT_OPTION).filter({ hasText: new RegExp(`^${escape(label)}`), visible: true }).first();
const visible = (page, selector) => page.locator(selector).filter({ visible: true }).last();
/** Wait until the notifications have gone, so a toast still up in one run is not in the next shot of the other. */
const toastsGone = (page) => expect(page.locator('.toast-viewport .toast-slot')).toHaveCount(0, { timeout: 20_000 });
const phone = (testInfo) => !!testInfo.project.use.isMobile;
const top = (locator) => locator.evaluate((el) => el.scrollIntoView({ block: 'start' }));

/** Wait until a layer is drawn in full: it and its ancestors opaque and untransformed. */
const still = (locator) => expect.poll(() => locator.evaluate((el) => {
  for (let node = el; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (Number(style.opacity) < 1 || style.transform !== 'none') return false;
  }
  return true;
}), { timeout: 15_000 }).toBe(true);

/** Wait until an open layer is drawn: sized, and it and its ancestors opaque. A replaced popup starts its enter at no
 *  size and no opacity, before any animation runs, whatever motion is asked for. */
const drawn = (locator) => expect.poll(() => locator.evaluate((el) => {
  const rect = el.getBoundingClientRect();
  if (!rect.width || !rect.height) return false;
  for (let node = el; node; node = node.parentElement) if (Number(getComputedStyle(node).opacity) < 1) return false;
  return true;
}), { timeout: 15_000 }).toBe(true);

/** Wait out enter and leave animations (the replaced controls run theirs whatever motion is asked for). */
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
      // The runtime census: AntD-classed elements drawn outside the sidebar (`aside.app-nav`, the session
      // phase's TasksSidePanel), by class; an icon's `anticon` is allowed and not counted.
      antd: [...new Set([...document.querySelectorAll('[class*="ant-"]')]
        .filter((el) => !el.closest('aside.app-nav') && visible(el))
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

/** Close an open footnote card the same way in both trees: a desktop's popover by pressing its number again (the
 *  replaced popover has no Escape), a phone's sheet by Escape. */
async function closeCard(page, testInfo, marker) {
  if (phone(testInfo)) await page.keyboard.press('Escape');
  else await marker.click();
  await expect(page.locator('.wk-fn2, .wk-fncard').filter({ visible: true })).toHaveCount(0);
  // The sheet gone and its leave done, focus given back, before the next step scrolls.
  if (phone(testInfo)) await expect(page.locator(DRAWER).filter({ visible: true })).toHaveCount(0);
  await settled(page);
}

/** Open a select or combobox by its trigger, in either tree. */
async function openChoice(trigger) {
  await trigger.click();
}

test.describe('P4.4 the Wiki home', () => {
  test('its head, the new entry form and the share dialog', async ({ evidence }, testInfo) => {
    const { page, capture } = evidence;
    const fixtures = await installP44Fixtures(page);
    const trace = [];
    await page.goto(P44_PATHS.home);
    await expect(page.getByRole('heading', { name: 'Wiki', exact: true })).toBeVisible();
    await expect(page.locator('.wk-pl-doc').first()).toBeVisible();
    await expect(page.locator('.wk-activity-btn .tp-rail-badge')).toBeVisible();
    trace.push(await observe(page, [fixtures], 'home'));
    await capture('p44-home', { head: '.wk-title-row', actions: '.wk-actions' });

    // New entry: the kind's own form, its select, a record and the notification.
    await button(page, 'New entry').click();
    const form = dialog(page, 'New entry');
    await expect(form).toBeVisible();
    await still(visible(page, DIALOG));
    await expect(button(form, 'Record')).toBeDisabled();
    trace.push(await observe(page, [fixtures], 'new entry'));
    await capture('p44-new-entry', { dialog: visible(page, DIALOG) });
    await openChoice(form.locator('.wk-form').getByRole('combobox').first());
    await expect(option(page, 'Convention')).toBeVisible();
    await settled(page);
    trace.push({ ...(await observe(page, [fixtures], 'kind list')),
      options: await page.locator(SELECT_OPTION).filter({ visible: true }).allTextContents() });
    await capture('p44-new-entry-kinds', { option: option(page, 'Convention') });
    await option(page, 'Convention').click();
    await expect(page.locator(SELECT_OPTION).filter({ visible: true })).toHaveCount(0);
    await fill(form.locator('label.k:text-is("Title") + input'), 'Keep one notification per toast');
    await fill(form.locator('label.k:text-is("One line") + textarea, label.k:text-is("One line") + * textarea'), 'A second toast replaces the first.');
    trace.push(await observe(page, [fixtures], 'new entry filled'));
    await capture('p44-new-entry-filled', { dialog: visible(page, DIALOG) });
    await button(form, 'Record').click();
    await expect(notifications(page).getByText('Entry recorded', { exact: true })).toBeVisible();
    await expect(form).toBeHidden();
    trace.push(await observe(page, [fixtures], 'recorded'));
    await toastsGone(page);

    // Share: the dialog the head opens, and the head once the space has a live link.
    await button(page, 'Share').click();
    const share = dialog(page, 'Share wiki');
    await expect(share).toBeVisible();
    await settled(page);
    trace.push(await observe(page, [fixtures], 'share dialog'));
    await page.keyboard.press('Escape');
    await expect(share).toBeHidden();
    fixtures.state.share = 'live';
    await page.reload();
    await expect(page.getByRole('button', { name: 'Shared · Live' })).toBeVisible();
    await expect(page.locator('.wk-pl-doc').first()).toBeVisible();
    trace.push(await observe(page, [fixtures], 'shared head'));
    await capture('p44-home-shared', { actions: '.wk-actions', pill: page.getByRole('button', { name: 'Shared · Live' }) });
    if (phone(testInfo)) {
      await button(page, 'Contents').click();
      await expect(page.getByRole('dialog', { name: 'Contents' })).toBeVisible();
      trace.push(await observe(page, [fixtures], 'contents'));
      await page.keyboard.press('Escape');
    }
    await attachTrace(testInfo, trace);
  });
});

test.describe('P4.4 a written document', () => {
  test('its marks, footnote cards and the phone sheet', async ({ evidence }, testInfo) => {
    const { page, capture } = evidence;
    const fixtures = await installP44Fixtures(page);
    const trace = [];
    await page.goto(P44_PATHS.doc);
    await expect(page.locator('.wk-dc-body [data-mark]').first()).toBeVisible();
    await expect(page.getByRole('heading', { name: P44_DOC.title, level: 1 })).toBeVisible();
    trace.push(await observe(page, [fixtures], 'document'));
    await capture('p44-doc', { title: '.wk-art-title', banner: '.wk-dc-banner' });

    // A mark's explanation: hover on a desktop, a tap on a phone; the one with a footnote to see.
    const marks = page.locator('.wk-dc-body [data-mark]');
    const count = await marks.count();
    let marked = null;
    for (let index = 0; index < count && !marked; index += 1) {
      const mark = marks.nth(index);
      await mark.scrollIntoViewIfNeeded();
      if (phone(testInfo)) await mark.click();
      else await mark.hover();
      const tip = visible(page, TIP);
      await expect(tip).toBeVisible();
      await drawn(tip);
      if (await tip.getByRole('button', { name: /^See footnote/ }).count()) marked = mark;
      else {
        await page.mouse.move(0, 0);
        if (phone(testInfo)) await page.locator('.wk-art-title').click();
        await expect(page.locator(TIP).filter({ visible: true })).toHaveCount(0);
      }
    }
    expect(marked, 'a mark whose explanation names a footnote').toBeTruthy();
    const tip = visible(page, TIP);
    await settled(page);
    trace.push({ ...(await observe(page, [fixtures], 'mark explained')), tip: (await tip.textContent())?.trim() });
    await capture('p44-doc-mark', { tip });
    await tip.getByRole('button', { name: /^See footnote/ }).click();
    const card = phone(testInfo) ? page.locator('.wk-fnsheet .wk-fn2') : visible(page, `${POPOVER} >> .wk-fn2`);
    await expect(card).toBeVisible();
    await page.mouse.move(0, 0);
    await settled(page);
    trace.push({ ...(await observe(page, [fixtures], 'footnote from the mark')), card: (await card.locator('.k').textContent())?.trim() });
    await capture('p44-doc-mark-footnote', { card });
    // On a desktop the card is closed by its own number, in the marked sentence's footnotes.
    const number = (await card.locator('.k .num').textContent())?.trim() ?? '';
    await closeCard(page, testInfo, marked.locator('xpath=following-sibling::sup[1]').getByRole('button').filter({ hasText: number }));

    // A footnote number: a session turn's quote, then code with its lines.
    for (const n of [44, 9]) {
      const marker = page.getByRole('button', { name: `Footnote ${n}`, exact: true }).first();
      await marker.scrollIntoViewIfNeeded();
      await marker.click();
      const opened = phone(testInfo) ? page.locator('.wk-fnsheet .wk-fn2') : visible(page, `${POPOVER} >> .wk-fn2`);
      await expect(opened).toBeVisible();
      // The press leaves the pointer where a phone's sheet then draws its button; off it, as the other steps do.
      await page.mouse.move(0, 0);
      await settled(page);
      trace.push({ ...(await observe(page, [fixtures], `footnote ${n}`)), card: (await opened.locator('.k').textContent())?.trim(),
        open: await opened.locator('.wk-fncard-open, .loc a').allTextContents() });
      await capture(`p44-doc-footnote-${n}`, phone(testInfo) ? { sheet: visible(page, DRAWER), card: opened } : { card: opened });
      if (phone(testInfo) && n === 44) {
        // The sheet's own button opens the original in the app.
        await page.locator('.wk-fnsheet .wk-fncard-open').click();
        await expect(page).toHaveURL(/\/sessions\//);
        await expect(page.locator('.wk-dc-page')).toHaveCount(0);
        trace.push(await observe(page, [fixtures], 'opened the turn'));
        await page.goBack();
        await expect(page.locator('.wk-dc-body [data-mark]').first()).toBeVisible();
      } else {
        await closeCard(page, testInfo, marker);
      }
    }
    // Next marked, under the banner.
    await page.locator('.wk-dc-banner .go').click();
    trace.push(await observe(page, [fixtures], 'next marked'));
    await attachTrace(testInfo, trace);
  });
});

test.describe('P4.4 a topic article', () => {
  test('its footnote cards and the way to an entry', async ({ evidence }, testInfo) => {
    const { page, capture } = evidence;
    const fixtures = await installP44Fixtures(page);
    const trace = [];
    await page.goto(P44_PATHS.article);
    await expect(page.locator('.wk-fn-n').first()).toBeVisible();
    trace.push(await observe(page, [fixtures], 'article'));
    await capture('p44-article', { title: '.wk-art-title', text: '.wk-art' });
    const marker = page.locator('.wk-fn-n').filter({ hasText: /^\[?2\]?$/ }).first();
    await marker.click();
    const card = phone(testInfo) ? page.locator('.wk-fnsheet .wk-fncard') : visible(page, `${POPOVER} >> .wk-fncard`);
    await expect(card).toBeVisible();
    await expect(card.locator('.f')).toContainText('sources');
    await settled(page);
    trace.push({ ...(await observe(page, [fixtures], 'footnote 2')), card: (await card.textContent())?.trim() });
    await capture('p44-article-footnote', phone(testInfo) ? { sheet: visible(page, DRAWER), card } : { card });
    await (phone(testInfo) ? card.locator('.wk-fncard-open') : card.locator('.go')).click();
    await expect(page).toHaveURL(new RegExp(`/wiki/orbit/e/`));
    await expect(page.locator('.wk-drawer .tdp-title')).toBeVisible();
    trace.push(await observe(page, [fixtures], 'opened the entry'));
    await attachTrace(testInfo, trace);
  });
});

test.describe('P4.4 an entry', () => {
  test('its answers, menus and forms', async ({ evidence }, testInfo) => {
    const { page, capture } = evidence;
    const fixtures = await installP44Fixtures(page);
    const trace = [];
    await page.goto(P44_PATHS.entry);
    const drawer = page.locator('.wk-drawer');
    await expect(drawer.locator('.tdp-title')).toHaveText('captureBeyondViewport shifts the screenshot');
    await expect(drawer.locator('.wk-markbar')).toBeVisible();
    trace.push(await observe(page, [fixtures], 'entry'));
    await capture('p44-entry', { head: '.wk-drawer .tdp-head', actions: '.wk-drawer .tdp-head-actions' });

    await button(drawer, 'Reject').click();
    await expect(openMenu(page)).toBeVisible();
    await drawn(openMenu(page));
    await settled(page);
    trace.push(await observe(page, [fixtures], 'reject reasons'));
    await capture('p44-entry-reject', { menu: openMenu(page) });
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu').filter({ visible: true })).toHaveCount(0);

    await drawer.getByRole('button', { name: 'More actions' }).click();
    await expect(openMenu(page)).toBeVisible();
    await drawn(openMenu(page));
    await settled(page);
    trace.push(await observe(page, [fixtures], 'more'));
    await capture('p44-entry-more', { menu: openMenu(page) });
    await item(page, 'Copy link').click();
    await expect(notifications(page).getByText('Copied', { exact: true })).toBeVisible();
    trace.push(await observe(page, [fixtures], 'copied'));
    await toastsGone(page);

    await drawer.getByRole('button', { name: phone(testInfo) ? 'Edit' : named('Edit') }).first().click();
    const edit = dialog(page, 'Edit');
    await expect(edit).toBeVisible();
    await still(visible(page, DIALOG));
    trace.push(await observe(page, [fixtures], 'edit'));
    await capture('p44-entry-edit', { dialog: visible(page, DIALOG) });
    await button(edit, 'Cancel').click();
    await expect(edit).toBeHidden();

    await drawer.getByRole('button', { name: 'More actions' }).click();
    await item(page, 'Retire…').click();
    const retire = dialog(page, 'Agents stop getting this entry. It stays in History, struck through, and the reason goes on the record.');
    await expect(retire).toBeVisible();
    await still(visible(page, DIALOG));
    await expect(button(retire, 'Retire')).toBeDisabled();
    trace.push(await observe(page, [fixtures], 'retire'));
    await capture('p44-entry-retire', { dialog: visible(page, DIALOG) });
    await fill(retire.locator('textarea'), 'The harness clips by the element now.');
    await button(retire, 'Retire').click();
    await expect(notifications(page).getByText('Retired', { exact: true })).toBeVisible();
    trace.push(await observe(page, [fixtures], 'retired'));
    await toastsGone(page);

    await button(drawer, 'Confirm').click();
    await expect(notifications(page).getByText('Confirmed', { exact: true })).toBeVisible();
    trace.push(await observe(page, [fixtures], 'confirmed'));
    await attachTrace(testInfo, trace);
  });
});

test.describe('P4.4 Review', () => {
  test('its answers, the edit form and its refusal, a challenge and the phone pager', async ({ evidence }, testInfo) => {
    const { page, capture } = evidence;
    const fixtures = await installP44Fixtures(page);
    const trace = [];
    await page.goto(P44_PATHS.review);
    const card = page.locator('.approval-card').first();
    await expect(card).toBeVisible();
    await expect(page.getByText('Secret redaction lets ENV_VAR=value secrets through').first()).toBeVisible();
    trace.push(await observe(page, [fixtures], 'review'));
    await capture('p44-review', { card });

    const add = page.locator('.approval-card').filter({ hasText: 'Secret redaction lets ENV_VAR=value secrets through' }).first();
    await button(add, 'Reject').click();
    await expect(openMenu(page)).toBeVisible();
    await drawn(openMenu(page));
    await settled(page);
    trace.push(await observe(page, [fixtures], 'reject reasons'));
    await capture('p44-review-reject', { menu: openMenu(page) });
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu').filter({ visible: true })).toHaveCount(0);

    await button(add, 'Edit').click();
    const edit = visible(page, '[role="dialog"]');
    await expect(edit.locator('input').first()).toBeVisible();
    await still(visible(page, DIALOG));
    await fill(edit.locator('input').first(), 'Secret redaction misses keys joined by an underscore');
    fixtures.state.decideRefusal = DECIDE_REFUSAL;
    await button(edit, 'Accept').click();
    await expect(edit.getByRole('alert')).toContainText(DECIDE_REFUSAL);
    await settled(page);
    trace.push(await observe(page, [fixtures], 'edit refused'));
    await capture('p44-review-refused', { dialog: visible(page, DIALOG), alert: edit.getByRole('alert') });
    await button(edit, 'Cancel').click();
    await expect(page.locator('[role="dialog"]').filter({ visible: true })).toHaveCount(0);
    fixtures.state.decideRefusal = null;

    const challenge = page.locator('.approval-card').filter({ hasText: 'wikiAnchorMark reads the anchor state' }).first();
    if (phone(testInfo)) {
      // A phone shows one card at a time: page on to the challenge.
      await expect(page.locator('.wk-pager')).toBeVisible();
      await capture('p44-review-pager', { pager: '.wk-pager' });
      // The challenge's amber line is drawn with the card; its title comes with the entry's read.
      const challengeCard = page.locator('.approval-card').filter({ has: page.locator('.wk-challenge-line') });
      for (let shown = 2; shown <= 5 && !(await challengeCard.count()); shown += 1) {
        await button(page.locator('.wk-pager'), 'Next').click();
        await expect(page.locator('.wk-pager')).toContainText(`${shown} of`);
      }
      await expect(challenge).toBeVisible();
      trace.push(await observe(page, [fixtures], 'next card'));
    }
    await challenge.scrollIntoViewIfNeeded();
    await button(challenge, 'Amend').click();
    const amend = visible(page, '[role="dialog"]');
    await expect(amend.locator('textarea')).toBeVisible();
    await still(visible(page, DIALOG));
    trace.push(await observe(page, [fixtures], 'amend'));
    await capture('p44-review-amend', { dialog: visible(page, DIALOG) });
    await button(amend, 'Cancel').click();
    await expect(page.locator('[role="dialog"]').filter({ visible: true })).toHaveCount(0);
    await attachTrace(testInfo, trace);
  });
});

test.describe('P4.4 the plan', () => {
  test('its versions, compare, redraft, the edit drawer and a section form', async ({ evidence }, testInfo) => {
    const { page, capture } = evidence;
    const fixtures = await installP44Fixtures(page);
    const trace = [];
    await page.goto(P44_PATHS.plan);
    await expect(page.locator('.wk-pl-ver')).toBeVisible();
    await expect(page.locator('.wk-pl-doc').first()).toBeVisible();
    trace.push(await observe(page, [fixtures], 'plan'));
    await capture('p44-plan', { head: '.wk-pl-head', acts: '.wk-pl-acts' });

    await page.locator('.wk-pl-ver').click();
    await expect(openMenu(page)).toBeVisible();
    await drawn(openMenu(page));
    await settled(page);
    trace.push(await observe(page, [fixtures], 'versions'));
    await capture('p44-plan-versions', { menu: openMenu(page) });
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu').filter({ visible: true })).toHaveCount(0);

    await page.locator('.wk-pl-acts').getByRole('button', { name: 'More' }).click();
    await expect(openMenu(page)).toBeVisible();
    await drawn(openMenu(page));
    await settled(page);
    trace.push(await observe(page, [fixtures], 'more'));
    await capture('p44-plan-more', { menu: openMenu(page) });
    await item(page, /^Compare with v/).click();
    await expect(page.getByRole('menu').filter({ visible: true })).toHaveCount(0);
    // Comparing: the meta line's own toggle says so on a desktop; a phone's is the menu item.
    if (phone(testInfo)) {
      await page.locator('.wk-pl-acts').getByRole('button', { name: 'More' }).click();
      await expect(item(page, 'Hide comparison')).toBeVisible();
      await drawn(openMenu(page));
      trace.push(await observe(page, [fixtures], 'compared'));
      await page.keyboard.press('Escape');
      await expect(page.getByRole('menu').filter({ visible: true })).toHaveCount(0);
    } else {
      await expect(page.locator('.wk-pl-meta .lk')).toHaveText('Hide comparison');
      trace.push(await observe(page, [fixtures], 'compared'));
    }
    await capture('p44-plan-compared', { head: '.wk-pl-head' });

    await button(page.locator('.wk-pl-acts'), 'Redraft…').click();
    const redraft = visible(page, '[role="dialog"]');
    await expect(redraft.locator('textarea')).toBeFocused();
    await still(visible(page, DIALOG));
    trace.push(await observe(page, [fixtures], 'redraft'));
    await capture('p44-plan-redraft', { dialog: visible(page, DIALOG) });
    await redraft.locator('textarea').pressSequentially('Split the runtime document in two.');
    await redraft.getByRole('button', { name: named('Redraft') }).last().click();
    await expect(page.locator('[role="dialog"]').filter({ visible: true })).toHaveCount(0);
    trace.push(await observe(page, [fixtures], 'redraft asked'));
    await toastsGone(page);

    // A document of the draft, opened, then its edit drawer. A phone's rows are links to the document's own page.
    if (phone(testInfo)) {
      await page.locator('a[href*="/plan/d/"]').first().click();
      await expect(page.locator('.wk-pl-docpage')).toBeVisible();
      trace.push(await observe(page, [fixtures], 'document page'));
      await capture('p44-plan-docpage', { title: '.wk-pl-docpage .wk-pl-titlerow' });
      await page.locator('.wk-pl-docpage .wk-pl-titlerow').getByRole('button', { name: 'Edit' }).click();
    } else {
      const doc = page.locator('.wk-pl-doc:has(button.caret)').first();
      await doc.locator('button.main').click();
      const editButton = page.locator('.wk-pl-doc.open').getByRole('button', { name: named('Edit') });
      await expect(editButton).toBeVisible();
      await editButton.click();
    }
    const drawer = visible(page, DRAWER);
    await expect(drawer).toBeVisible();
    await still(drawer);
    trace.push(await observe(page, [fixtures], 'edit drawer'));
    await capture('p44-plan-edit', { drawer });
    const lengths = drawer.locator('.len input');
    await fill(lengths.first(), '900');
    await drawer.getByRole('switch').click();
    await openChoice(drawer.locator('.wk-pl-esec').first().getByRole('combobox'));
    await expect(page.locator(SELECT_OPTION).filter({ visible: true }).first()).toBeVisible();
    await settled(page);
    trace.push({ ...(await observe(page, [fixtures], 'section kinds')), options: await page.locator(SELECT_OPTION).filter({ visible: true }).allTextContents() });
    await capture('p44-plan-edit-kinds', { option: page.locator(SELECT_OPTION).filter({ visible: true }).first() });
    await page.locator(SELECT_OPTION).filter({ visible: true }).nth(1).click();
    await expect(page.locator(SELECT_OPTION).filter({ visible: true })).toHaveCount(0);
    trace.push(await observe(page, [fixtures], 'edited'));
    await capture('p44-plan-edit-changed', { drawer });
    await drawer.getByRole('button', { name: named('Save draft') }).click();
    await expect(notifications(page).getByText(/^Draft v\d+ saved$/)).toBeVisible();
    trace.push(await observe(page, [fixtures], 'saved'));
    await toastsGone(page);

    // A section's own page of the draft, and its form.
    await page.goto(`${P44_PATHS.plan}/d/product/1?v=2`);
    const sectionPage = page.locator('.wk-pl-secpage');
    await expect(sectionPage).toBeVisible();
    await sectionPage.locator('.wk-pl-titlerow').getByRole('button', { name: named('Edit') }).click();
    const sectionForm = visible(page, '[role="dialog"]');
    await expect(sectionForm.locator('textarea')).toBeVisible();
    await still(visible(page, DIALOG));
    trace.push(await observe(page, [fixtures], 'section form'));
    await capture('p44-plan-section', { dialog: visible(page, DIALOG) });
    await fill(sectionForm.locator('input').first(), 'Overview');
    await button(sectionForm, 'Save draft').click();
    await expect(notifications(page).getByText(/^Draft v\d+ saved$/)).toBeVisible();
    trace.push(await observe(page, [fixtures], 'section saved'));
    await attachTrace(testInfo, trace);
  });

  test('before one exists', async ({ evidence }, testInfo) => {
    const { page, capture } = evidence;
    const fixtures = await installP44Fixtures(page);
    fixtures.state.plan = 'none';
    const trace = [];
    await page.goto(P44_PATHS.plan);
    const empty = page.locator('.wk-pl-empty');
    await expect(empty).toBeVisible();
    trace.push(await observe(page, [fixtures], 'no plan'));
    await capture('p44-plan-empty', { empty, draft: button(empty, 'Draft plan') });
    await button(empty, 'Draft plan').click();
    await expect(notifications(page).getByText(/./).first()).toBeVisible();
    trace.push(await observe(page, [fixtures], 'drafting'));
    await attachTrace(testInfo, trace);
  });
});

test.describe('P4.4 Wiki settings', () => {
  test('review modes, spot checks, setting maintenance up and maintenance on', async ({ evidence }, testInfo) => {
    const { page, capture } = evidence;
    const fixtures = await installP44Fixtures(page);
    const trace = [];
    await page.goto(P44_PATHS.settings);
    await expect(page.getByRole('heading', { name: 'Wiki settings' })).toBeVisible();
    await expect(page.locator('.wk-mode.on')).toBeVisible();
    trace.push(await observe(page, [fixtures], 'settings'));
    await capture('p44-settings', { card: visible(page, CARD), modes: '.wk-modes' });

    await page.locator('.wk-mode').filter({ hasText: 'Automatic' }).getByRole('radio').click();
    await expect(page.locator('.wk-mode.on')).toContainText('Automatic');
    await expect(page.getByRole('switch', { name: 'Spot-check Automatic' })).toBeEnabled();
    await toastsGone(page);
    trace.push(await observe(page, [fixtures], 'automatic'));
    await page.getByRole('switch', { name: 'Spot-check Automatic' }).click();
    await expect(page.getByRole('switch', { name: 'Spot-check Automatic' })).toHaveAttribute('aria-checked', 'true');
    trace.push(await observe(page, [fixtures], 'spot checks on'));
    await toastsGone(page);
    await capture('p44-settings-automatic', { modes: '.wk-modes' });

    await button(page, 'Set up…').click();
    const setUp = visible(page, '[role="dialog"]');
    await expect(setUp.getByText('Set up maintenance')).toBeVisible();
    await still(visible(page, DIALOG));
    trace.push(await observe(page, [fixtures], 'set up'));
    await capture('p44-settings-setup', { dialog: visible(page, DIALOG) });
    await expect(button(setUp, 'Turn on')).toBeDisabled();
    await openChoice(page.locator('#wk-setup-workspace').locator('xpath=ancestor-or-self::*[contains(@class,"ant-select") or contains(@class,"orbit-select")][1]'));
    await expect(option(page, 'Orbit baseline')).toBeVisible();
    await settled(page);
    trace.push({ ...(await observe(page, [fixtures], 'workspaces')), options: await page.locator(SELECT_OPTION).filter({ visible: true }).allTextContents() });
    await capture('p44-settings-workspaces', { option: option(page, 'Orbit baseline') });
    await option(page, 'Orbit baseline').click();
    await expect(button(setUp, 'Turn on')).toBeEnabled();
    await openChoice(page.locator('#wk-setup-lookback').locator('xpath=ancestor-or-self::*[contains(@class,"ant-select") or contains(@class,"orbit-select")][1]'));
    await expect(option(page, 'All history')).toBeVisible();
    await settled(page);
    trace.push({ ...(await observe(page, [fixtures], 'look back')), options: await page.locator(SELECT_OPTION).filter({ visible: true }).allTextContents() });
    await capture('p44-settings-lookback', { option: option(page, 'All history') });
    await option(page, 'All history').click();
    await expect(setUp.locator('input[aria-label="days"]')).toHaveCount(0);
    await fill(setUp.locator('#wk-setup-limit'), '12');
    trace.push(await observe(page, [fixtures], 'set up filled'));
    await button(setUp, 'Turn on').click();
    await expect(page.locator('[role="dialog"]').filter({ visible: true })).toHaveCount(0);
    await expect(button(page.locator('.wk-maint-foot'), 'Edit')).toBeVisible();
    trace.push(await observe(page, [fixtures], 'turned on'));
    await toastsGone(page);
    await top(page.locator('.wk-maint-rows'));
    await capture('p44-settings-on', { rows: '.wk-maint-rows', foot: '.wk-maint-foot' });
    await button(page.locator('.wk-maint-foot'), 'Turn off').click();
    await expect(button(page, 'Set up…')).toBeVisible();
    trace.push(await observe(page, [fixtures], 'turned off'));
    await attachTrace(testInfo, trace);
  });
});

test.describe('P4.4 Activity and a run', () => {
  test('the pressed Activity button, the revert question and the run drawer', async ({ evidence }, testInfo) => {
    const { page, capture } = evidence;
    const fixtures = await installP44Fixtures(page);
    const trace = [];
    await page.goto(P44_PATHS.activity);
    const run = page.locator('.wk-tl-run').first();
    await expect(run).toBeVisible();
    trace.push(await observe(page, [fixtures], 'activity'));
    await capture('p44-activity', { run });
    if (phone(testInfo)) {
      // A phone has no pointer for the row's actions: its title is the way in.
      await run.locator('.wk-tl-t a').click();
    } else {
      await run.locator('.wk-tl-acts .danger').click();
      const revert = question(page, 'Revert this run?');
      await expect(revert).toBeVisible();
      await still(visible(page, CONFIRM));
      trace.push(await observe(page, [fixtures], 'revert question'));
      await capture('p44-activity-revert', { confirm: visible(page, CONFIRM) });
      await button(revert, 'Cancel').click();
      await expect(page.locator('[role="dialog"], [role="alertdialog"]').filter({ visible: true })).toHaveCount(0);
      await run.locator('.wk-tl-acts').getByRole('link', { name: 'View run' }).click();
    }
    const drawer = page.locator('.wk-drawer.wk-run');
    await expect(drawer.locator('.tdp-title')).toBeVisible();
    trace.push(await observe(page, [fixtures], 'run'));
    await capture('p44-run', { drawer, actions: '.wk-run-actions' });
    // A row's Reject shows on hover; a phone has none (Reject is on the entry).
    const answerable = drawer.locator('.wk-run-row').filter({ has: page.locator('.wk-run-reject') }).first();
    if (!phone(testInfo) && (await answerable.count())) {
      await answerable.hover();
      await answerable.locator('.wk-run-reject').click();
      await expect(openMenu(page)).toBeVisible();
      await drawn(openMenu(page));
      await settled(page);
      trace.push(await observe(page, [fixtures], 'row reject'));
      await capture('p44-run-reject', { menu: openMenu(page) });
      await page.keyboard.press('Escape');
    }
    await button(drawer, 'Revert run…').click();
    const confirm = question(page, 'Revert this run?');
    await expect(confirm).toBeVisible();
    if (phone(testInfo)) {
      await still(visible(page, CONFIRM));
      trace.push(await observe(page, [fixtures], 'revert question'));
      await capture('p44-activity-revert', { confirm: visible(page, CONFIRM) });
    }
    await button(confirm, 'Revert run').click();
    await expect(page).toHaveURL(/\/wiki\/orbit$/);
    await expect(notifications(page).getByText('Reverted', { exact: true })).toBeVisible();
    trace.push(await observe(page, [fixtures], 'reverted'));
    await attachTrace(testInfo, trace);
  });
});

test.describe('P4.4 Settings → Shared links', () => {
  test('tabs, the turn-off questions, share again, loading and a failed read', async ({ evidence }, testInfo) => {
    const { page, capture } = evidence;
    const fixtures = await installP44Fixtures(page);
    const trace = [];
    const hold = gate();
    fixtures.state.holdLinks = hold;
    await page.goto(P44_PATHS.sharedLinks);
    const spinner = page.locator('.following-empty [aria-busy="true"], .following-empty .ant-spin, .following-empty .orbit-spinner').first();
    await expect(spinner).toBeVisible();
    trace.push(await observe(page, [fixtures], 'loading'));
    await capture('p44-links-loading', { spinner });
    fixtures.state.holdLinks = null;
    hold.release();
    await expect(page.locator('.shared-link-row:not(.is-head)').first()).toBeVisible();
    trace.push({ ...(await observe(page, [fixtures], 'active')), rows: await page.locator('.shared-link-row:not(.is-head) .shared-link-title').allTextContents() });
    await capture('p44-links', { banner: '.shared-links-banner', list: '.shared-links-list' });

    await button(page.locator('.shared-links-banner'), 'Turn off these 3').click();
    const batch = question(page, 'Turn off these 3 links?');
    await expect(batch).toBeVisible();
    await settled(page);
    trace.push(await observe(page, [fixtures], 'turn off three'));
    await capture('p44-links-turn-off-three', { question: batch });
    await button(batch, 'Turn off').click();
    await expect(notifications(page).getByText('3 links turned off', { exact: true })).toBeVisible();
    trace.push(await observe(page, [fixtures], 'three turned off'));
    await toastsGone(page);

    const row = page.locator('.shared-link-row').filter({ hasText: 'Summarize the latest commits' });
    await button(row, 'Turn off').click();
    const one = question(page, 'Turn off this link?');
    await expect(one).toBeVisible();
    await settled(page);
    trace.push(await observe(page, [fixtures], 'turn off one'));
    await capture('p44-links-turn-off', { question: one });
    await button(one, 'Cancel').click();
    await expect(page.locator('[role="tooltip"], [role="dialog"]').filter({ hasText: 'Turn off this link?' }).filter({ visible: true })).toHaveCount(0);

    await page.getByRole('tab', { name: /^Paused/ }).click();
    await expect(page.locator('.shared-link-paused')).toBeVisible();
    trace.push(await observe(page, [fixtures], 'paused'));
    await page.getByRole('tab', { name: /^Ended/ }).click();
    await expect(button(page, 'Share again')).toBeVisible();
    trace.push(await observe(page, [fixtures], 'ended'));
    await capture('p44-links-ended', { list: '.shared-links-list' });
    await button(page, 'Share again').click();
    await expect(notifications(page).getByText('Shared again — with a new link', { exact: true })).toBeVisible();
    trace.push(await observe(page, [fixtures], 'shared again'));
    await toastsGone(page);

    fixtures.state.linksError = 'Fixture share links read failed';
    await page.reload();
    await expect(page.getByText('Couldn’t load your links: Fixture share links read failed')).toBeVisible();
    trace.push(await observe(page, [fixtures], 'failed read'));
    await capture('p44-links-failed', { empty: '.following-empty' });
    fixtures.state.linksError = null;
    await button(page.locator('.following-empty'), 'Retry').click();
    await expect(page.locator('.shared-link-row:not(.is-head)').first()).toBeVisible();
    trace.push(await observe(page, [fixtures], 'retried'));
    await attachTrace(testInfo, trace);
  });
});

test.describe('P4.4 public pages', () => {
  test('a shared project and a shared wiki', async ({ evidence }, testInfo) => {
    const { page, capture } = evidence;
    const projectFixtures = await installP43aFixtures(page);
    const fixtures = await installP44Fixtures(page);
    const trace = [];
    await page.goto(P43A_PATHS.share);
    await expect(page.getByRole('heading', { name: 'Orbit UI migration' })).toBeVisible();
    const tasks = page.locator('.share-project-tasks');
    await expect(tasks.locator('.project-task-row').first()).toBeVisible();
    // The task graph (P4.3b's, the same code in both trees) loads on its own, and the page's height with it.
    await expect(page.locator('.react-flow').first()).toBeAttached();
    await top(tasks);
    await frames(page);
    trace.push({ ...(await observe(page, [fixtures, projectFixtures], 'shared project')),
      rows: await tasks.locator('.project-task-row').evaluateAll((rows) => rows.map((row) => row.textContent.trim().replace(/\s+/g, ' '))) });
    await capture('p44-shared-project', { tasks, row: tasks.locator('.project-task-row').first() });

    await page.goto(P44_PATHS.sharedWiki);
    await expect(page.locator('.share-wiki .wk-pl-doc').first()).toBeVisible();
    trace.push(await observe(page, [fixtures], 'shared wiki'));
    await capture('p44-shared-wiki', { home: '.share-wiki' });
    await page.goto(P44_PATHS.sharedWikiDoc);
    await expect(page.getByRole('heading', { name: 'Session runtime', level: 1 })).toBeVisible();
    const marker = page.locator('#wk-fnref-1');
    await marker.click();
    const card = phone(testInfo) ? page.locator('.wk-fnsheet .wk-fn2') : visible(page, `${POPOVER} >> .wk-fn2`);
    await expect(card).toBeVisible();
    await settled(page);
    trace.push({ ...(await observe(page, [fixtures], 'shared footnote')), card: (await card.locator('.k').textContent())?.trim() });
    await capture('p44-shared-wiki-footnote', phone(testInfo) ? { sheet: visible(page, DRAWER), card } : { card });
    await closeCard(page, testInfo, marker);
    trace.push(await observe(page, [fixtures], 'closed'));
    await attachTrace(testInfo, trace);
  });
});

test.describe('P4.4 Following', () => {
  test('its tabs, pause, resume and stop, loading and a failed read', async ({ evidence }, testInfo) => {
    const { page, capture } = evidence;
    const fixtures = await installP44Fixtures(page);
    const trace = [];
    const hold = gate();
    fixtures.state.holdWatches = hold;
    await page.goto(P44_PATHS.following);
    const spinner = page.locator('.following-empty [aria-busy="true"], .following-empty .ant-spin, .following-empty .orbit-spinner').first();
    await expect(spinner).toBeVisible();
    await capture('p44-following-loading', { spinner });
    fixtures.state.holdWatches = null;
    hold.release();
    await expect(page.locator('[data-watch-id]').first()).toBeVisible();
    trace.push({ ...(await observe(page, [fixtures], 'active')), cards: await page.locator('[data-watch-id]').count() });
    await capture('p44-following', { list: '.watch-list' });

    const first = page.locator('[data-watch-id]').first();
    await button(first, 'Stop').click();
    const stop = question(page, 'Stop this watch?');
    await expect(stop).toBeVisible();
    await settled(page);
    trace.push(await observe(page, [fixtures], 'stop question'));
    await capture('p44-following-stop', { question: stop });
    await button(stop, 'Keep watching').click();
    await expect(page.locator('[role="tooltip"], [role="dialog"]').filter({ hasText: 'Stop this watch?' }).filter({ visible: true })).toHaveCount(0);
    await button(first, 'Pause').click();
    await expect(notifications(page).getByText(/./).first()).toBeVisible();
    trace.push(await observe(page, [fixtures], 'paused'));
    await toastsGone(page);

    for (const tab of ['Needs attention', 'Triggered history']) {
      await page.getByRole('tab', { name: new RegExp(`^${tab}`) }).click();
      await expect(page.locator('[data-watch-id]').first()).toBeVisible();
      trace.push(await observe(page, [fixtures], tab));
      await capture(`p44-following-${tab.toLowerCase().replace(/ /g, '-')}`, { list: '.watch-list' });
    }
    fixtures.state.watchesError = 'Fixture watches read failed';
    await page.reload();
    await expect(page.locator('.following-empty')).toContainText('Couldn’t load watches');
    trace.push(await observe(page, [fixtures], 'failed read'));
    await capture('p44-following-failed', { empty: '.following-empty' });
    // The page also reads again once a minute, which a loaded host can reach before the press: the read fails until the
    // focus is on Retry. With no list read yet the page shows its spinner again as soon as a read starts, so the press
    // goes by the keyboard: a pointer click would look for the button after it has gone.
    await button(page.locator('.following-empty'), 'Retry').focus();
    fixtures.state.watchesError = null;
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-watch-id]').first()).toBeVisible();
    trace.push(await observe(page, [fixtures], 'retried'));
    await attachTrace(testInfo, trace);
  });
});

test.describe('P4.4 watches', () => {
  test('the editor on a task and a conversation’s chips', async ({ evidence }, testInfo) => {
    const { page, capture } = evidence;
    const fixtures = await installP44Fixtures(page);
    const trace = [];
    await page.goto(P44_PATHS.task);
    const relations = page.locator('.watch-relations');
    await relations.scrollIntoViewIfNeeded();
    await expect(relations).toContainText('Followed by');
    trace.push(await observe(page, [fixtures], 'task'));
    await capture('p44-task-followed-by', { relations });
    await button(relations, 'Follow task').click();
    const editor = dialog(page, 'Follow task');
    await expect(editor).toBeVisible();
    await still(visible(page, DIALOG));
    trace.push(await observe(page, [fixtures], 'editor'));
    await capture('p44-watch-editor', { dialog: visible(page, DIALOG) });
    await editor.locator('label').filter({ hasText: /^Is done/ }).click();
    await editor.locator('label').filter({ hasText: /^Resume a session/ }).click();
    await expect(button(editor, 'Follow')).toBeDisabled();
    const picker = editor.locator('.watch-editor-session');
    await picker.click();
    await expect(option(page, 'Coordinator · orbit')).toBeVisible();
    await settled(page);
    trace.push({ ...(await observe(page, [fixtures], 'session picker')), options: await page.locator(SELECT_OPTION).filter({ visible: true }).allTextContents() });
    await capture('p44-watch-editor-sessions', { option: option(page, 'Coordinator · orbit') });
    await option(page, 'Coordinator · orbit').click();
    await editor.locator('label').filter({ hasText: /^7 days/ }).click();
    trace.push(await observe(page, [fixtures], 'editor filled'));
    await capture('p44-watch-editor-filled', { dialog: visible(page, DIALOG) });
    await button(editor, 'Follow').click();
    await expect(notifications(page).getByText('Following', { exact: true })).toBeVisible();
    trace.push(await observe(page, [fixtures], 'following'));
    await toastsGone(page);

    await page.goto(P44_PATHS.session);
    const chips = page.locator('.watch-badges').first();
    // The session workspace is the heaviest page here; a loaded host needs longer than the default to draw it.
    await expect(chips.locator('.watch-chip').first()).toBeVisible({ timeout: 45_000 });
    trace.push(await observe(page, [fixtures], 'session'));
    await chips.locator('.watch-chip').first().click();
    const list = visible(page, `${POPOVER}`);
    await expect(list.locator('.watch-row').first()).toBeVisible();
    await drawn(list);
    await settled(page);
    trace.push({ ...(await observe(page, [fixtures], 'waiting on')), rows: await list.locator('.watch-row').count() });
    if (phone(testInfo)) {
      // On a phone the replaced popover ran past the right edge and widened the page, which the capture's viewport
      // check refuses: the record keeps how wide the page and the list are instead of a screenshot.
      trace.push({ step: 'waiting on, widths', page: await page.evaluate(() => document.documentElement.scrollWidth),
        list: await list.evaluate((el) => { const r = el.getBoundingClientRect(); return [r.left, r.right].map((v) => +v.toFixed(2)); }) });
    } else {
      await capture('p44-session-waiting-on', { popover: list });
    }
    await chips.locator('.watch-chip').first().click();
    await expect(page.locator('.watch-row').filter({ visible: true })).toHaveCount(0);
    trace.push(await observe(page, [fixtures], 'closed'));
    await attachTrace(testInfo, trace);
  });
});

test.describe('P4.4 the default landing', () => {
  test('its spinner while the workspaces read', async ({ evidence }, testInfo) => {
    const { page, capture } = evidence;
    const fixtures = await installP44Fixtures(page);
    const trace = [];
    const hold = gate();
    fixtures.state.holdWorkspaces = hold;
    await page.goto(P44_PATHS.landing);
    const spinner = page.locator('.app-view--doc [aria-busy="true"], .app-view--doc .ant-spin, .app-view--doc .orbit-spinner').first();
    await expect(spinner).toBeVisible();
    trace.push(await observe(page, [fixtures], 'landing'));
    await capture('p44-landing', { spinner });
    fixtures.state.holdWorkspaces = null;
    hold.release();
    await expect(page).toHaveURL(/\/workspaces\//);
    trace.push(await observe(page, [fixtures], 'landed'));
    await attachTrace(testInfo, trace);
  });
});

