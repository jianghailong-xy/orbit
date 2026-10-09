import { test, expect } from '@playwright/test';

// Deterministic companion to ../p2.2/revision-8/select-keys-repeat.browser.mjs (read-only diagnostic,
// not a test entry). The r8 probe awaits every page.keyboard.press(), so its keys arrive ~15ms apart
// and only rarely fall between the list opening and focus entering it one animation frame later.
// "burst" queues the same trusted key events through one CDP session without waiting in between, so
// the keys after the opening ArrowDown reach the page inside that window. "paced" presses the same
// keys 300ms apart: the reference where focus has already moved. The key log is the r8 observer plus
// `trusted` (tells keys re-dispatched by the page apart from the input) and menus as lists.
// orbit-menu is informational only: this task does not change Menu.
const sample = (page) => page.getByRole('region', { name: 'Appearance sample' }).innerText();
const choice = (page) => page.getByRole('combobox', { name: 'Sample choice', exact: true });
const TARGETS = {
  'orbit-field': { url: '/ui-migration/choices.html', field: (page) => page.getByRole('combobox', { name: 'Expires', exact: true }),
    read: (page) => page.getByRole('status', { name: 'Expiry value', exact: true }).textContent() },
  'orbit-sample': { url: '/ui-migration/choices.html?system=orbit&sample=expiry', field: choice, read: sample },
  'antd-sample': { url: '/ui-migration/choices.html?system=antd&sample=expiry', field: choice, read: sample },
  'orbit-combobox': { url: '/ui-migration/choices.html?system=orbit&sample=search', field: choice, read: sample },
  'antd-search': { url: '/ui-migration/choices.html?system=antd&sample=search', field: choice, read: sample },
  'orbit-multiselect': { url: '/ui-migration/choices.html?system=orbit&sample=multiple', field: choice, read: sample },
  'antd-multiple': { url: '/ui-migration/choices.html?system=antd&sample=multiple', field: choice, read: sample },
  'orbit-menu': { url: '/ui-migration/choices.html', field: (page) => page.getByRole('button', { name: 'Add attachment', exact: true }).first(),
    read: (page) => page.getByRole('status', { name: 'Action', exact: true }).textContent() },
};
// `from` selects 7 days with paced keys first (null: the field's own Clear button). `expected` is the
// value after the sequence when focus is already in the list; null leaves it to the paced samples.
const SEQUENCES = [
  { name: 'down-down-enter', keys: ['ArrowDown', 'ArrowDown', 'Enter'],
    targets: Object.keys(TARGETS), expected: { 'orbit-field': '7', 'orbit-sample': '7 days', 'antd-sample': '7 days' } },
  { name: 'down-up-enter', from: '7 days', keys: ['ArrowDown', 'ArrowUp', 'Enter'],
    targets: ['orbit-field', 'orbit-sample', 'antd-sample'], expected: { 'orbit-field': 'never', 'orbit-sample': 'Never', 'antd-sample': 'Never' } },
  { name: 'down-enter', from: null, keys: ['ArrowDown', 'Enter'], targets: ['orbit-field'], expected: { 'orbit-field': 'never' } },
];
const RUNS = { burst: 20, paced: 3 };
// What Playwright's Chromium keyboard sends for one press (rawKeyDown/keyDown, then keyUp).
const KEYS = {
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
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
      listbox: !!listbox, highlighted: listbox?.querySelector('[data-highlighted]')?.textContent?.trim()
        ?? (descendant ? document.getElementById(descendant)?.textContent?.trim() : null) ?? null });
  }, true);
}

const read = async (page, target) => (await TARGETS[target].read(page)).trim().split('\n').map((line) => line.trim()).filter(Boolean).join(' | ');

for (const sequence of SEQUENCES) for (const target of sequence.targets) for (const [mode, runs] of Object.entries(RUNS)) for (let run = 0; run < runs; run++) {
  test(`${target} ${sequence.name} ${mode} sample ${run}`, async ({ page }, info) => {
    test.skip(info.project.use.browserName !== 'chromium', 'the key queue is a Chromium DevTools protocol feature');
    await page.goto(TARGETS[target].url);
    await expect(page.getByTestId('theme')).toHaveText(info.project.use.colorScheme);
    await page.evaluate(() => document.fonts.ready);
    const field = TARGETS[target].field(page);
    if (sequence.from === null) {
      await page.getByRole('button', { name: 'Clear selection' }).first().click();
      await expect(page.getByRole('status', { name: 'Expiry value', exact: true })).toHaveText('null');
    } else if (sequence.from) {
      await field.focus();
      for (const key of ['ArrowDown', 'ArrowDown', 'Enter']) { await page.keyboard.press(key); await page.waitForTimeout(300); }
      await page.waitForTimeout(300);
      expect(['7', '7 days']).toContain((await read(page, target)).split(' | ')[0]);
    }
    const before = await read(page, target);
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
      listboxOpen: [...document.querySelectorAll('[role="listbox"],[role="menu"]')].some((el) => el.getBoundingClientRect().height > 0),
      active: `${document.activeElement?.getAttribute('role') ?? document.activeElement?.tagName.toLowerCase()}:${(document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.textContent ?? '').trim().slice(0, 24)}`,
    }));
    const record = { target, sequence: sequence.name, mode, run, keys: sequence.keys, before, after: await read(page, target),
      expected: sequence.expected[target] ?? null, ...state, keyLog: await page.evaluate(() => window.keyLog) };
    await cdp.detach();
    await info.attach('select-keys', { body: JSON.stringify(record, null, 2), contentType: 'application/json' });
  });
}
