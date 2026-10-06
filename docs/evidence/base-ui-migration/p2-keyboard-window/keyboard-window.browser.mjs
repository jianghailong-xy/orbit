import { test, expect } from '@playwright/test';

// Extends ../p2-select-keys/select-keys-burst.browser.mjs, which stays unchanged (read-only diagnostic, not a
// test entry). Same method: "burst" queues trusted key events through one CDP session without waiting, so the
// keys after the opener reach the page while the list is shown but focus has not yet entered it (one animation
// frame later), as input queued behind a busy main thread does; "paced" presses the same keys 300ms apart, the
// reference where focus has already moved. Same key observer (plus the element focused at each key) and waits.
// Added: Menu ↓/↑/Enter on the old AntD Dropdown sample and the Orbit Menu, and the Select keys the previous fix
// left to the trigger (Home/End, Space, PageUp/PageDown, typeahead) on the old AntD Select sample and the Orbit
// Select, each with the control sequence that lacks the key under test.
const sample = (page) => page.getByRole('region', { name: 'Appearance sample' }).innerText();
const choice = (page) => page.getByRole('combobox', { name: 'Sample choice', exact: true });
const attachment = (page) => page.getByRole('button', { name: 'Add attachment', exact: true }).first();
const TARGETS = {
  'orbit-field': { url: '/ui-migration/choices.html', field: (page) => page.getByRole('combobox', { name: 'Expires', exact: true }),
    read: (page) => page.getByRole('status', { name: 'Expiry value', exact: true }).textContent() },
  'orbit-sample': { url: '/ui-migration/choices.html?system=orbit&sample=expiry', field: choice, read: sample },
  'antd-sample': { url: '/ui-migration/choices.html?system=antd&sample=expiry', field: choice, read: sample },
  // The field page's attachment Menu reports its action; the samples (the pair the appearance tests compare)
  // report none, so every menu also gets an outcome from the DOM: still open, closed by an Enter on a menu item
  // (that item ran), or closed otherwise.
  'orbit-menu': { menu: true, url: '/ui-migration/choices.html', field: attachment,
    read: (page) => page.getByRole('status', { name: 'Action', exact: true }).textContent() },
  'orbit-menu-sample': { menu: true, url: '/ui-migration/choices.html?system=orbit&sample=attachment', field: attachment },
  'antd-menu': { menu: true, url: '/ui-migration/choices.html?system=antd&sample=attachment', field: attachment },
};
const MENUS = ['orbit-menu', 'orbit-menu-sample', 'antd-menu'];
const SELECTS = ['orbit-field', 'orbit-sample', 'antd-sample'];
// `from` is the value before the sequence: Never is the samples' own value, 7 days is selected first with
// paced keys, null uses the field's own Clear button. `control` names the same sequence without the key under
// test: a key that leaves the paced result equal to its control's has no function on that component.
const SEQUENCES = [
  { name: 'menu-enter', keys: ['Enter'], targets: MENUS },
  { name: 'menu-down-down-enter', keys: ['ArrowDown', 'ArrowDown', 'Enter'], targets: MENUS },
  { name: 'menu-down-up-enter', keys: ['ArrowDown', 'ArrowUp', 'Enter'], targets: MENUS },
  { name: 'menu-down-enter', keys: ['ArrowDown', 'Enter'], targets: MENUS },
  { name: 'menu-enter-down-enter', keys: ['Enter', 'ArrowDown', 'Enter'], targets: MENUS },
  { name: 'menu-enter-up-enter', keys: ['Enter', 'ArrowUp', 'Enter'], targets: MENUS },
  { name: 'menu-enter-enter', keys: ['Enter', 'Enter'], targets: MENUS },
  // Added after the first baseline: ↑ as the opener (Base UI opens on the last item), the other Menu ↑ case.
  { name: 'menu-up-enter', keys: ['ArrowUp', 'Enter'], targets: MENUS },
  { name: 'menu-up-up-enter', keys: ['ArrowUp', 'ArrowUp', 'Enter'], targets: MENUS },
  { name: 'menu-up-down-enter', keys: ['ArrowUp', 'ArrowDown', 'Enter'], targets: MENUS },
  // Reference beyond the task's keys: the old Dropdown's own way into its menu (Tab focuses it).
  { name: 'menu-enter-tab-down-enter', keys: ['Enter', 'Tab', 'ArrowDown', 'Enter'], targets: MENUS },
  { name: 'select-down', from: 'Never', keys: ['ArrowDown'], targets: SELECTS },
  { name: 'select-down-enter', from: 'Never', keys: ['ArrowDown', 'Enter'], targets: SELECTS },
  { name: 'select-down-enter-from-7', from: '7 days', keys: ['ArrowDown', 'Enter'], targets: SELECTS },
  { name: 'select-down-home-enter', from: '7 days', keys: ['ArrowDown', 'Home', 'Enter'], targets: SELECTS, control: 'select-down-enter-from-7' },
  { name: 'select-down-end-enter', from: 'Never', keys: ['ArrowDown', 'End', 'Enter'], targets: SELECTS, control: 'select-down-enter' },
  { name: 'select-down-pageup-enter', from: '7 days', keys: ['ArrowDown', 'PageUp', 'Enter'], targets: SELECTS, control: 'select-down-enter-from-7' },
  { name: 'select-down-pagedown-enter', from: 'Never', keys: ['ArrowDown', 'PageDown', 'Enter'], targets: SELECTS, control: 'select-down-enter' },
  { name: 'select-down-space', from: 'Never', keys: ['ArrowDown', 'Space'], targets: SELECTS, control: 'select-down' },
  { name: 'select-down-space-from-null', from: null, keys: ['ArrowDown', 'Space'], targets: ['orbit-field'] },
  { name: 'select-space-down-enter', from: 'Never', keys: ['Space', 'ArrowDown', 'Enter'], targets: SELECTS, control: 'select-down-enter' },
  { name: 'select-enter-down-enter', from: 'Never', keys: ['Enter', 'ArrowDown', 'Enter'], targets: SELECTS, control: 'select-down-enter' },
  { name: 'select-down-7-enter', from: 'Never', keys: ['ArrowDown', '7', 'Enter'], targets: SELECTS, control: 'select-down-enter' },
  { name: 'select-down-n-enter', from: '7 days', keys: ['ArrowDown', 'n', 'Enter'], targets: SELECTS, control: 'select-down-enter-from-7' },
];
const RUNS = { burst: 20, paced: 20 };
// What Playwright 1.63's Chromium keyboard sends for one press (rawKeyDown, or keyDown with text; then keyUp).
const KEYS = {
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
  Home: { key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 },
  End: { key: 'End', code: 'End', windowsVirtualKeyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 },
  Space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' },
  7: { key: '7', code: 'Digit7', windowsVirtualKeyCode: 55, text: '7' },
  n: { key: 'n', code: 'KeyN', windowsVirtualKeyCode: 78, text: 'n' },
};

function observeKeys() {
  const describe = (el) => el instanceof Element
    ? `${el.getAttribute('role') ?? el.tagName.toLowerCase()}:${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 24)}` : String(el);
  window.keyLog = [];
  const start = performance.now();
  document.addEventListener('keydown', (event) => {
    const listbox = [...document.querySelectorAll('[role="listbox"],[role="menu"]')].find((el) => el.getBoundingClientRect().height > 0);
    const active = document.activeElement;
    const descendant = active?.getAttribute('aria-activedescendant');
    window.keyLog.push({ key: event.key, t: Math.round((performance.now() - start) * 10) / 10, target: describe(event.target), trusted: event.isTrusted,
      focused: describe(active), listbox: !!listbox, highlighted: listbox?.querySelector('[data-highlighted]')?.textContent?.trim()
        ?? (descendant ? document.getElementById(descendant)?.textContent?.trim() : null) ?? null });
  }, true);
}

const read = async (page, target) => (await TARGETS[target].read(page)).trim().split('\n').map((line) => line.trim()).filter(Boolean).join(' | ');
// The old AntD sample text repeats the selected label (`7 days | 7 days`); the value is its first part.
const value = async (page, target) => (await read(page, target)).split(' | ')[0];
function menuOutcome(keyLog, listOpen) {
  if (listOpen) return 'open';
  const enter = keyLog.filter((key) => key.key === 'Enter').at(-1);
  return enter?.target.startsWith('menuitem:') ? `ran ${enter.target.slice('menuitem:'.length)}` : 'closed';
}

for (const sequence of SEQUENCES) for (const target of sequence.targets) for (const [mode, runs] of Object.entries(RUNS)) for (let run = 0; run < runs; run++) {
  test(`${target} ${sequence.name} ${mode} sample ${run}`, async ({ page }, info) => {
    test.skip(info.project.use.browserName !== 'chromium', 'the key queue is a Chromium DevTools protocol feature');
    const { menu } = TARGETS[target];
    await page.goto(TARGETS[target].url);
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
    const before = menu ? (TARGETS[target].read ? await read(page, target) : null) : await value(page, target);
    const cdp = await page.context().newCDPSession(page);
    await page.evaluate(observeKeys);
    await field.focus();
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    if (mode === 'burst') {
      await Promise.all(sequence.keys.flatMap((name) => {
        const { text, ...key } = KEYS[name];
        return [cdp.send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', ...key, text, unmodifiedText: text, location: 0 }),
          cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key, location: 0 })];
      }));
    } else {
      for (const key of sequence.keys) { await page.keyboard.press(key); await page.waitForTimeout(300); }
    }
    await page.waitForTimeout(500);
    const state = await page.evaluate(() => ({
      listOpen: [...document.querySelectorAll('[role="listbox"],[role="menu"]')].some((el) => el.getBoundingClientRect().height > 0),
      active: `${document.activeElement?.getAttribute('role') ?? document.activeElement?.tagName.toLowerCase()}:${(document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.textContent ?? '').trim().slice(0, 24)}`,
    }));
    const keyLog = await page.evaluate(() => window.keyLog);
    const after = menu ? (TARGETS[target].read ? await read(page, target) : null) : await value(page, target);
    // One comparable string per sample: a Select's value and whether its list is still open; a menu's outcome.
    const result = menu ? menuOutcome(keyLog, state.listOpen) : `${after} | list ${state.listOpen ? 'open' : 'closed'}`;
    const record = { target, sequence: sequence.name, control: sequence.control ?? null, mode, run, keys: sequence.keys,
      from: sequence.from === undefined ? null : sequence.from, before, after, result, ...state, keyLog };
    await cdp.detach();
    await info.attach('keyboard-window', { body: JSON.stringify(record, null, 2), contentType: 'application/json' });
  });
}
