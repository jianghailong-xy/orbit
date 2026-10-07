import { test, expect } from '@playwright/test';

// The windows ../p2-keyboard-window/keyboard-window.browser.mjs (unchanged) left without an old AntD baseline: a
// submenu trigger's, a Popconfirm's and a Dialog's (and ConfirmDialog's) opening, and Space, Tab, Home/End and
// typeahead in the Menu and Select trigger windows. Same method: "burst" queues trusted key events through one CDP
// session without waiting, so the keys after the opener reach the page while the popup is shown but before focus
// has moved into it, as input queued behind a busy main thread does; "paced" presses the same keys 300ms apart,
// the reference where focus has already moved. Same key observer, plus the shown popups at each key. Every sample
// is a new page.
const choices = '/ui-migration/choices.html';
const overlays = '/ui-migration/overlays.html';
const button = (name) => (page) => page.getByRole('button', { name, exact: true }).first();
const combobox = (name) => (page) => page.getByRole('combobox', { name, exact: true }).first();
const output = (name) => (page) => page.getByRole('status', { name, exact: true }).first().textContent();
const sample = (page) => page.getByRole('region', { name: 'Appearance sample' }).innerText();
const TARGETS = {
  // Menus: the field page's attachment Menu reports its action (its outputs); the samples are the pair the appearance
  // tests compare, so their outcome comes from the DOM (an Enter or Space on a menu item that closed the menu ran it).
  'orbit-menu': { kind: 'menu', url: choices, field: button('Add attachment'), outputs: true },
  'orbit-menu-sample': { kind: 'menu', url: `${choices}?system=orbit&sample=attachment`, field: button('Add attachment') },
  'antd-menu': { kind: 'menu', url: `${choices}?system=antd&sample=attachment`, field: button('Add attachment') },
  // Submenus: the parent menu is opened with paced keys, each system its own way, and the sequence starts once its
  // Provider item (the submenu trigger) has focus. The old Dropdown leaves focus on its trigger until Tab.
  'orbit-submenu': { kind: 'submenu', url: choices, field: button('Session actions'), open: ['ArrowDown', 'ArrowDown'], outputs: true },
  'orbit-submenu-sample': { kind: 'submenu', url: `${choices}?system=orbit&sample=submenu`, field: button('Add attachment'), open: ['Enter'] },
  'antd-submenu': { kind: 'submenu', url: `${choices}?system=antd&sample=submenu`, field: button('Add attachment'), open: ['Enter', 'Tab'] },
  // The same pair inside a menu with other items around the submenu (the shape of the workspace menus), reporting the
  // item picked. Provider is the second item.
  'orbit-session': { kind: 'submenu', url: `${choices}?system=orbit&sample=session`, field: button('Session actions'), open: ['Enter', 'ArrowDown'], outputs: true },
  'antd-session': { kind: 'submenu', url: `${choices}?system=antd&sample=session`, field: button('Session actions'), open: ['Enter', 'Tab', 'ArrowDown'], outputs: true },
  // Selects, as in the earlier probe.
  'orbit-field': { kind: 'select', url: choices, field: combobox('Expires'), read: output('Expiry value') },
  'orbit-sample': { kind: 'select', url: `${choices}?system=orbit&sample=expiry`, field: combobox('Sample choice'), read: sample },
  'antd-sample': { kind: 'select', url: `${choices}?system=antd&sample=expiry`, field: combobox('Sample choice'), read: sample },
  // The task panel's delete question on one trigger for both systems; the sample reports the answer.
  'orbit-popconfirm': { kind: 'popconfirm', url: `${choices}?system=orbit&sample=popconfirm`, field: button('Delete task'), outputs: true },
  'antd-popconfirm': { kind: 'popconfirm', url: `${choices}?system=antd&sample=popconfirm`, field: button('Delete task'), outputs: true },
  // The overlay fixture's appearance pairs: Dialog and Modal, ConfirmDialog and modal.confirm (cancel focused).
  'orbit-dialog': { kind: 'dialog', url: overlays, field: button('Orbit dialog') },
  'antd-dialog': { kind: 'dialog', url: overlays, field: button('AntD dialog') },
  'orbit-confirm': { kind: 'dialog', url: overlays, field: button('Orbit confirm') },
  'antd-confirm': { kind: 'dialog', url: overlays, field: button('AntD confirm') },
};
const MENUS = ['orbit-menu', 'orbit-menu-sample', 'antd-menu'];
const SUBMENUS = ['orbit-submenu', 'orbit-submenu-sample', 'antd-submenu', 'orbit-session', 'antd-session'];
const SELECTS = ['orbit-field', 'orbit-sample', 'antd-sample'];
const POPCONFIRMS = ['orbit-popconfirm', 'antd-popconfirm'];
const DIALOGS = ['orbit-dialog', 'antd-dialog', 'orbit-confirm', 'antd-confirm'];
// `control` names the same sequence without the key under test: a key that leaves the paced result equal to its
// control's has no function on that component. `from` is a Select's value before the sequence, as before.
const SEQUENCES = [
  { name: 'menu-enter', keys: ['Enter'], targets: MENUS },
  { name: 'menu-enter-enter', keys: ['Enter', 'Enter'], targets: MENUS },
  { name: 'menu-enter-space', keys: ['Enter', 'Space'], targets: MENUS, control: 'menu-enter' },
  { name: 'menu-enter-home-enter', keys: ['Enter', 'Home', 'Enter'], targets: MENUS, control: 'menu-enter-enter' },
  { name: 'menu-enter-end-enter', keys: ['Enter', 'End', 'Enter'], targets: MENUS, control: 'menu-enter-enter' },
  { name: 'menu-enter-s-enter', keys: ['Enter', 's', 'Enter'], targets: MENUS, control: 'menu-enter-enter' },
  { name: 'menu-enter-tab', keys: ['Enter', 'Tab'], targets: MENUS, control: 'menu-enter' },
  { name: 'menu-enter-tab-enter', keys: ['Enter', 'Tab', 'Enter'], targets: MENUS, control: 'menu-enter-enter' },
  { name: 'menu-enter-shift-tab', keys: ['Enter', 'Shift+Tab'], targets: MENUS, control: 'menu-enter' },
  { name: 'menu-enter-shift-tab-enter', keys: ['Enter', 'Shift+Tab', 'Enter'], targets: MENUS, control: 'menu-enter-enter' },
  { name: 'menu-space', keys: ['Space'], targets: MENUS },
  { name: 'menu-space-enter', keys: ['Space', 'Enter'], targets: MENUS, control: 'menu-space' },
  { name: 'menu-space-down-enter', keys: ['Space', 'ArrowDown', 'Enter'], targets: MENUS, control: 'menu-space-enter' },
  { name: 'sub-right', keys: ['ArrowRight'], targets: SUBMENUS },
  { name: 'sub-right-enter', keys: ['ArrowRight', 'Enter'], targets: SUBMENUS, control: 'sub-right' },
  { name: 'sub-right-down-enter', keys: ['ArrowRight', 'ArrowDown', 'Enter'], targets: SUBMENUS, control: 'sub-right-enter' },
  { name: 'sub-right-up-enter', keys: ['ArrowRight', 'ArrowUp', 'Enter'], targets: SUBMENUS, control: 'sub-right-enter' },
  { name: 'sub-right-left', keys: ['ArrowRight', 'ArrowLeft'], targets: SUBMENUS, control: 'sub-right' },
  { name: 'sub-right-escape', keys: ['ArrowRight', 'Escape'], targets: SUBMENUS, control: 'sub-right' },
  { name: 'sub-right-space', keys: ['ArrowRight', 'Space'], targets: SUBMENUS, control: 'sub-right' },
  { name: 'sub-right-home-enter', keys: ['ArrowRight', 'Home', 'Enter'], targets: SUBMENUS, control: 'sub-right-enter' },
  { name: 'sub-right-end-enter', keys: ['ArrowRight', 'End', 'Enter'], targets: SUBMENUS, control: 'sub-right-enter' },
  { name: 'sub-right-c-enter', keys: ['ArrowRight', 'c', 'Enter'], targets: SUBMENUS, control: 'sub-right-enter' },
  { name: 'sub-right-tab', keys: ['ArrowRight', 'Tab'], targets: SUBMENUS, control: 'sub-right' },
  // Added after the first baseline: Shift+Tab in the submenu window (its own baseline chunk).
  { name: 'sub-right-shift-tab', keys: ['ArrowRight', 'Shift+Tab'], targets: SUBMENUS, control: 'sub-right' },
  { name: 'sub-enter', keys: ['Enter'], targets: SUBMENUS },
  { name: 'sub-enter-enter', keys: ['Enter', 'Enter'], targets: SUBMENUS, control: 'sub-enter' },
  { name: 'sub-enter-down-enter', keys: ['Enter', 'ArrowDown', 'Enter'], targets: SUBMENUS, control: 'sub-enter-enter' },
  { name: 'select-down', from: 'Never', keys: ['ArrowDown'], targets: SELECTS },
  { name: 'select-down-enter', from: 'Never', keys: ['ArrowDown', 'Enter'], targets: SELECTS },
  { name: 'select-down-enter-from-7', from: '7 days', keys: ['ArrowDown', 'Enter'], targets: SELECTS },
  { name: 'select-down-home-enter', from: '7 days', keys: ['ArrowDown', 'Home', 'Enter'], targets: SELECTS, control: 'select-down-enter-from-7' },
  { name: 'select-down-end-enter', from: 'Never', keys: ['ArrowDown', 'End', 'Enter'], targets: SELECTS, control: 'select-down-enter' },
  { name: 'select-down-space', from: 'Never', keys: ['ArrowDown', 'Space'], targets: SELECTS, control: 'select-down' },
  { name: 'select-down-space-from-null', from: null, keys: ['ArrowDown', 'Space'], targets: ['orbit-field'] },
  { name: 'select-space-down-enter', from: 'Never', keys: ['Space', 'ArrowDown', 'Enter'], targets: SELECTS, control: 'select-down-enter' },
  { name: 'select-enter-down-enter', from: 'Never', keys: ['Enter', 'ArrowDown', 'Enter'], targets: SELECTS, control: 'select-down-enter' },
  { name: 'select-down-7-enter', from: 'Never', keys: ['ArrowDown', '7', 'Enter'], targets: SELECTS, control: 'select-down-enter' },
  { name: 'select-down-n-enter', from: '7 days', keys: ['ArrowDown', 'n', 'Enter'], targets: SELECTS, control: 'select-down-enter-from-7' },
  { name: 'select-enter', from: 'Never', keys: ['Enter'], targets: SELECTS },
  { name: 'select-down-down', from: 'Never', keys: ['ArrowDown', 'ArrowDown'], targets: SELECTS },
  { name: 'select-down-tab', from: 'Never', keys: ['ArrowDown', 'Tab'], targets: SELECTS, control: 'select-down' },
  { name: 'select-down-shift-tab', from: 'Never', keys: ['ArrowDown', 'Shift+Tab'], targets: SELECTS, control: 'select-down' },
  { name: 'select-down-down-tab', from: 'Never', keys: ['ArrowDown', 'ArrowDown', 'Tab'], targets: SELECTS, control: 'select-down-down' },
  { name: 'select-enter-tab', from: 'Never', keys: ['Enter', 'Tab'], targets: SELECTS, control: 'select-enter' },
  { name: 'pop-enter', keys: ['Enter'], targets: POPCONFIRMS },
  { name: 'pop-enter-enter', keys: ['Enter', 'Enter'], targets: POPCONFIRMS, control: 'pop-enter' },
  { name: 'pop-enter-space', keys: ['Enter', 'Space'], targets: POPCONFIRMS, control: 'pop-enter' },
  { name: 'pop-enter-escape', keys: ['Enter', 'Escape'], targets: POPCONFIRMS, control: 'pop-enter' },
  { name: 'pop-enter-tab', keys: ['Enter', 'Tab'], targets: POPCONFIRMS, control: 'pop-enter' },
  { name: 'pop-enter-tab-enter', keys: ['Enter', 'Tab', 'Enter'], targets: POPCONFIRMS, control: 'pop-enter-enter' },
  { name: 'pop-enter-shift-tab', keys: ['Enter', 'Shift+Tab'], targets: POPCONFIRMS, control: 'pop-enter' },
  { name: 'dlg-enter', keys: ['Enter'], targets: DIALOGS },
  { name: 'dlg-enter-enter', keys: ['Enter', 'Enter'], targets: DIALOGS, control: 'dlg-enter' },
  { name: 'dlg-enter-space', keys: ['Enter', 'Space'], targets: DIALOGS, control: 'dlg-enter' },
  { name: 'dlg-enter-escape', keys: ['Enter', 'Escape'], targets: DIALOGS, control: 'dlg-enter' },
  { name: 'dlg-enter-tab', keys: ['Enter', 'Tab'], targets: DIALOGS, control: 'dlg-enter' },
  { name: 'dlg-enter-tab-enter', keys: ['Enter', 'Tab', 'Enter'], targets: DIALOGS, control: 'dlg-enter-enter' },
  { name: 'dlg-enter-shift-tab', keys: ['Enter', 'Shift+Tab'], targets: DIALOGS, control: 'dlg-enter' },
];
const RUNS = { burst: Number(process.env.KW2_BURST ?? 20), paced: Number(process.env.KW2_PACED ?? 20) };
// What Playwright 1.63's Chromium keyboard sends for one press: rawKeyDown, or keyDown with text, then keyUp; Shift+Tab
// is Shift down, Tab down and up with the Shift modifier, Shift up.
const KEYS = {
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
  Home: { key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 },
  End: { key: 'End', code: 'End', windowsVirtualKeyCode: 35 },
  Space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' },
  7: { key: '7', code: 'Digit7', windowsVirtualKeyCode: 55, text: '7' },
  n: { key: 'n', code: 'KeyN', windowsVirtualKeyCode: 78, text: 'n' },
  s: { key: 's', code: 'KeyS', windowsVirtualKeyCode: 83, text: 's' },
  c: { key: 'c', code: 'KeyC', windowsVirtualKeyCode: 67, text: 'c' },
};
const SHIFT = { key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16, location: 1 };
function keyEvents(name) {
  if (name === 'Shift+Tab') {
    return [{ type: 'rawKeyDown', modifiers: 8, ...SHIFT }, { type: 'rawKeyDown', modifiers: 8, ...KEYS.Tab, location: 0 },
      { type: 'keyUp', modifiers: 8, ...KEYS.Tab, location: 0 }, { type: 'keyUp', modifiers: 0, ...SHIFT }];
  }
  const { text, ...key } = KEYS[name];
  return [{ type: text ? 'keyDown' : 'rawKeyDown', ...key, text, unmodifiedText: text, location: 0 }, { type: 'keyUp', ...key, location: 0 }];
}

// Runs in the page. A popup is shown when it has a box; menus and lists are counted, dialogs (Base UI's Popover
// popup is one) and tooltips (the old Popconfirm's) are named by their title.
function pageState() {
  const describe = (el) => el instanceof Element
    ? `${el.getAttribute('role') ?? el.tagName.toLowerCase()}:${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 24)}` : String(el);
  const shown = (el) => { const box = el.getBoundingClientRect(); return box.width > 0 && box.height > 0; };
  const named = (el) => {
    const ids = el.getAttribute('aria-labelledby');
    const title = ids ? ids.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' ') : el.getAttribute('aria-label') ?? el.textContent;
    return `${el.getAttribute('role')}:${(title ?? '').trim().slice(0, 20)}`;
  };
  const popups = [...document.querySelectorAll('[role="menu"],[role="listbox"],[role="dialog"],[role="alertdialog"],[role="tooltip"]')].filter(shown);
  const lists = popups.filter((el) => ['menu', 'listbox'].includes(el.getAttribute('role')));
  const others = popups.filter((el) => !lists.includes(el)).map(named);
  const summary = [...(lists.length ? [`${lists[0].getAttribute('role')}×${lists.length}`] : []), ...others].join('+') || 'none';
  const list = lists.at(-1);
  const active = document.activeElement;
  const descendant = active?.getAttribute('aria-activedescendant');
  const outputs = Object.fromEntries([...document.querySelectorAll('output[aria-label]')].map((el) => [el.getAttribute('aria-label'), el.textContent]));
  return { popups: summary, count: popups.length, active: describe(active), theme: document.querySelector('[data-testid="theme"]')?.textContent ?? null, outputs,
    highlighted: list?.querySelector('[data-highlighted]')?.textContent?.trim() ?? (descendant ? document.getElementById(descendant)?.textContent?.trim() : null) ?? null };
}

function observeKeys(stateSource) {
  const state = new Function(`return (${stateSource})`)();
  window.keyLog = [];
  const start = performance.now();
  document.addEventListener('keydown', (event) => {
    const { popups, count, active, highlighted } = state();
    const target = event.target instanceof Element
      ? `${event.target.getAttribute('role') ?? event.target.tagName.toLowerCase()}:${(event.target.getAttribute('aria-label') ?? event.target.textContent ?? '').trim().slice(0, 24)}` : String(event.target);
    const inPopup = event.target instanceof Element && !!event.target.closest('[role="menu"],[role="listbox"],[role="dialog"],[role="alertdialog"],[role="tooltip"]');
    window.keyLog.push({ key: event.key, shift: event.shiftKey, t: Math.round((performance.now() - start) * 10) / 10, target, inPopup, trusted: event.isTrusted,
      focused: active, popups, count, highlighted });
  }, true);
}

const read = async (page, target) => (await TARGETS[target].read(page)).trim().split('\n').map((line) => line.trim()).filter(Boolean).join(' | ');
// The old AntD sample text repeats the selected label (`7 days | 7 days`); the value is its first part.
const value = async (page, target) => (await read(page, target)).split(' | ')[0];
// Pages without outputs: the last Enter or Space whose target was a menu item or a button inside a popup, after which
// fewer popups were shown than at that key, activated it. A submenu trigger (Provider) only opens its submenu.
function activated(keyLog, after) {
  const press = keyLog.filter((key) => key.key === 'Enter' || key.key === ' ').at(-1);
  if (!press || !press.inPopup || after.count >= press.count) return null;
  const split = press.target.indexOf(':');
  const [role, label] = [press.target.slice(0, split), press.target.slice(split + 1)];
  return ['menuitem', 'menuitemcheckbox', 'menuitemradio', 'button'].includes(role) && label !== 'Provider' ? `ran ${label}` : null;
}

for (const sequence of SEQUENCES) for (const target of sequence.targets) for (const [mode, runs] of Object.entries(RUNS)) for (let run = 0; run < runs; run++) {
  test(`${target} ${sequence.name} ${mode} sample ${run}`, async ({ page }, info) => {
    test.skip(info.project.use.browserName !== 'chromium', 'the key queue is a Chromium DevTools protocol feature');
    const { kind, url, open } = TARGETS[target];
    await page.goto(url);
    await expect(page.getByTestId('theme')).toHaveText(info.project.use.colorScheme);
    await page.evaluate(() => document.fonts.ready);
    const field = TARGETS[target].field(page);
    if (sequence.from === null) {
      await page.getByRole('button', { name: 'Clear selection' }).first().click();
      await expect(page.getByRole('status', { name: 'Expiry value', exact: true })).toHaveText('null');
    } else if (sequence.from === '7 days') {
      await field.focus();
      for (const key of ['ArrowDown', 'ArrowDown', 'Enter']) { await page.keyboard.press(key); await page.waitForTimeout(300); }
      await page.waitForTimeout(300);
      expect(['7', '7 days']).toContain(await value(page, target));
    }
    await field.focus();
    if (open) {
      for (const key of open) { await page.keyboard.press(key); await page.waitForTimeout(300); }
      // The old submenu title also carries its arrow icon's name ("Provider right").
      await expect(page.getByRole('menuitem', { name: /^Provider/ })).toBeFocused();
      await page.waitForTimeout(300);
    }
    const before = { state: await page.evaluate(pageState), read: TARGETS[target].read ? await read(page, target) : null };
    const cdp = await page.context().newCDPSession(page);
    await page.evaluate(observeKeys, pageState.toString());
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    if (mode === 'burst') {
      await Promise.all(sequence.keys.flatMap(keyEvents).map((event) => cdp.send('Input.dispatchKeyEvent', event)));
    } else {
      for (const key of sequence.keys) { await page.keyboard.press(key); await page.waitForTimeout(300); }
    }
    await page.waitForTimeout(500);
    const after = { state: await page.evaluate(pageState), read: TARGETS[target].read ? await read(page, target) : null };
    const keyLog = await page.evaluate(() => window.keyLog);
    await cdp.detach();
    // One comparable string per sample: what ran, was answered or chosen, which popups are shown, and where focus is.
    const theme = after.state.theme === before.state.theme ? '' : ' | theme changed';
    const changed = Object.entries(after.state.outputs).filter(([name, text]) => before.state.outputs[name] !== text).map(([name, text]) => `${name}=${text}`).join(', ');
    let outcome;
    if (kind === 'select') outcome = `${(after.read ?? '').split(' | ')[0]} | list ${after.state.popups.includes('listbox') ? 'open' : 'closed'}`;
    else if (TARGETS[target].outputs) outcome = changed || 'none';
    else outcome = activated(keyLog, after.state) ?? 'none';
    const result = `${outcome} | ${after.state.popups} | @${after.state.active}${theme}`;
    const record = { target, kind, sequence: sequence.name, control: sequence.control ?? null, mode, run, keys: sequence.keys,
      from: sequence.from === undefined ? null : sequence.from, before, after, result, keyLog };
    await info.attach('keyboard-window-2', { body: JSON.stringify(record, null, 2), contentType: 'application/json' });
  });
}
