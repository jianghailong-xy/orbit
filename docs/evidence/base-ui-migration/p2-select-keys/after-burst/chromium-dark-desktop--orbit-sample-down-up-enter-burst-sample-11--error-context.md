# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: select-keys-burst.browser.mjs >> orbit-sample down-up-enter burst sample 11
- Location: docs/evidence/base-ui-migration/p2-select-keys/select-keys-burst.browser.mjs:60:3

# Error details

```
Error: expect(locator).toHaveText(expected) failed

Locator: getByTestId('theme')
Expected: "dark"
Timeout: 15000ms
Error: element(s) not found

Call log:
  - Expect "toHaveText" getByTestId('theme') with timeout 15000ms
  - waiting for getByTestId('theme')

```

# Test source

```ts
  1   | import { test, expect } from '@playwright/test';
  2   | 
  3   | // Deterministic companion to ../p2.2/revision-8/select-keys-repeat.browser.mjs (read-only diagnostic,
  4   | // not a test entry). The r8 probe awaits every page.keyboard.press(), so its keys arrive ~15ms apart
  5   | // and only rarely fall between the list opening and focus entering it one animation frame later.
  6   | // "burst" queues the same trusted key events through one CDP session without waiting in between, so
  7   | // the keys after the opening ArrowDown reach the page inside that window. "paced" presses the same
  8   | // keys 300ms apart: the reference where focus has already moved. The key log is the r8 observer plus
  9   | // `trusted` (tells keys re-dispatched by the page apart from the input) and menus as lists.
  10  | // orbit-menu is informational only: this task does not change Menu.
  11  | const sample = (page) => page.getByRole('region', { name: 'Appearance sample' }).innerText();
  12  | const choice = (page) => page.getByRole('combobox', { name: 'Sample choice', exact: true });
  13  | const TARGETS = {
  14  |   'orbit-field': { url: '/ui-migration/choices.html', field: (page) => page.getByRole('combobox', { name: 'Expires', exact: true }),
  15  |     read: (page) => page.getByRole('status', { name: 'Expiry value', exact: true }).textContent() },
  16  |   'orbit-sample': { url: '/ui-migration/choices.html?system=orbit&sample=expiry', field: choice, read: sample },
  17  |   'antd-sample': { url: '/ui-migration/choices.html?system=antd&sample=expiry', field: choice, read: sample },
  18  |   'orbit-combobox': { url: '/ui-migration/choices.html?system=orbit&sample=search', field: choice, read: sample },
  19  |   'antd-search': { url: '/ui-migration/choices.html?system=antd&sample=search', field: choice, read: sample },
  20  |   'orbit-multiselect': { url: '/ui-migration/choices.html?system=orbit&sample=multiple', field: choice, read: sample },
  21  |   'antd-multiple': { url: '/ui-migration/choices.html?system=antd&sample=multiple', field: choice, read: sample },
  22  |   'orbit-menu': { url: '/ui-migration/choices.html', field: (page) => page.getByRole('button', { name: 'Add attachment', exact: true }).first(),
  23  |     read: (page) => page.getByRole('status', { name: 'Action', exact: true }).textContent() },
  24  | };
  25  | // `from` selects 7 days with paced keys first (null: the field's own Clear button). `expected` is the
  26  | // value after the sequence when focus is already in the list; null leaves it to the paced samples.
  27  | const SEQUENCES = [
  28  |   { name: 'down-down-enter', keys: ['ArrowDown', 'ArrowDown', 'Enter'],
  29  |     targets: Object.keys(TARGETS), expected: { 'orbit-field': '7', 'orbit-sample': '7 days', 'antd-sample': '7 days' } },
  30  |   { name: 'down-up-enter', from: '7 days', keys: ['ArrowDown', 'ArrowUp', 'Enter'],
  31  |     targets: ['orbit-field', 'orbit-sample', 'antd-sample'], expected: { 'orbit-field': 'never', 'orbit-sample': 'Never', 'antd-sample': 'Never' } },
  32  |   { name: 'down-enter', from: null, keys: ['ArrowDown', 'Enter'], targets: ['orbit-field'], expected: { 'orbit-field': 'never' } },
  33  | ];
  34  | const RUNS = { burst: 20, paced: 3 };
  35  | // What Playwright's Chromium keyboard sends for one press (rawKeyDown/keyDown, then keyUp).
  36  | const KEYS = {
  37  |   ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  38  |   ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  39  |   Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  40  | };
  41  | 
  42  | function observeKeys() {
  43  |   const describe = (el) => el instanceof Element
  44  |     ? `${el.getAttribute('role') ?? el.tagName.toLowerCase()}:${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 24)}` : String(el);
  45  |   window.keyLog = [];
  46  |   const start = performance.now();
  47  |   document.addEventListener('keydown', (event) => {
  48  |     const listbox = [...document.querySelectorAll('[role="listbox"],[role="menu"]')].find((el) => el.getBoundingClientRect().height > 0);
  49  |     const active = document.activeElement;
  50  |     const descendant = active?.getAttribute('aria-activedescendant');
  51  |     window.keyLog.push({ key: event.key, t: Math.round((performance.now() - start) * 10) / 10, target: describe(event.target), trusted: event.isTrusted,
  52  |       listbox: !!listbox, highlighted: listbox?.querySelector('[data-highlighted]')?.textContent?.trim()
  53  |         ?? (descendant ? document.getElementById(descendant)?.textContent?.trim() : null) ?? null });
  54  |   }, true);
  55  | }
  56  | 
  57  | const read = async (page, target) => (await TARGETS[target].read(page)).trim().split('\n').map((line) => line.trim()).filter(Boolean).join(' | ');
  58  | 
  59  | for (const sequence of SEQUENCES) for (const target of sequence.targets) for (const [mode, runs] of Object.entries(RUNS)) for (let run = 0; run < runs; run++) {
  60  |   test(`${target} ${sequence.name} ${mode} sample ${run}`, async ({ page }, info) => {
  61  |     test.skip(info.project.use.browserName !== 'chromium', 'the key queue is a Chromium DevTools protocol feature');
  62  |     await page.goto(TARGETS[target].url);
> 63  |     await expect(page.getByTestId('theme')).toHaveText(info.project.use.colorScheme);
      |                                             ^ Error: expect(locator).toHaveText(expected) failed
  64  |     await page.evaluate(() => document.fonts.ready);
  65  |     const field = TARGETS[target].field(page);
  66  |     if (sequence.from === null) {
  67  |       await page.getByRole('button', { name: 'Clear selection' }).first().click();
  68  |       await expect(page.getByRole('status', { name: 'Expiry value', exact: true })).toHaveText('null');
  69  |     } else if (sequence.from) {
  70  |       await field.focus();
  71  |       for (const key of ['ArrowDown', 'ArrowDown', 'Enter']) { await page.keyboard.press(key); await page.waitForTimeout(300); }
  72  |       await page.waitForTimeout(300);
  73  |       expect(['7', '7 days']).toContain((await read(page, target)).split(' | ')[0]);
  74  |     }
  75  |     const before = await read(page, target);
  76  |     const cdp = await page.context().newCDPSession(page);
  77  |     await page.evaluate(observeKeys);
  78  |     await field.focus();
  79  |     await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  80  |     if (mode === 'burst') {
  81  |       await Promise.all(sequence.keys.flatMap((name) => {
  82  |         const { text, ...key } = KEYS[name];
  83  |         return [cdp.send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', ...key, text, unmodifiedText: text, location: 0 }),
  84  |           cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key, location: 0 })];
  85  |       }));
  86  |     } else {
  87  |       for (const key of sequence.keys) { await page.keyboard.press(key); await page.waitForTimeout(300); }
  88  |     }
  89  |     await page.waitForTimeout(500);
  90  |     const state = await page.evaluate(() => ({
  91  |       listboxOpen: [...document.querySelectorAll('[role="listbox"],[role="menu"]')].some((el) => el.getBoundingClientRect().height > 0),
  92  |       active: `${document.activeElement?.getAttribute('role') ?? document.activeElement?.tagName.toLowerCase()}:${(document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.textContent ?? '').trim().slice(0, 24)}`,
  93  |     }));
  94  |     const record = { target, sequence: sequence.name, mode, run, keys: sequence.keys, before, after: await read(page, target),
  95  |       expected: sequence.expected[target] ?? null, ...state, keyLog: await page.evaluate(() => window.keyLog) };
  96  |     await cdp.detach();
  97  |     await info.attach('select-keys', { body: JSON.stringify(record, null, 2), contentType: 'application/json' });
  98  |   });
  99  | }
  100 | 
```