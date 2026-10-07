# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: keyboard-window.browser.mjs >> orbit-menu-sample menu-enter-enter burst sample 1
- Location: docs/evidence/base-ui-migration/p2-keyboard-window/keyboard-window.browser.mjs:97:3

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
  3   | // Extends ../p2-select-keys/select-keys-burst.browser.mjs, which stays unchanged (read-only diagnostic, not a
  4   | // test entry). Same method: "burst" queues trusted key events through one CDP session without waiting, so the
  5   | // keys after the opener reach the page while the list is shown but focus has not yet entered it (one animation
  6   | // frame later), as input queued behind a busy main thread does; "paced" presses the same keys 300ms apart, the
  7   | // reference where focus has already moved. Same key observer (plus the element focused at each key) and waits.
  8   | // Added: Menu ↓/↑/Enter on the old AntD Dropdown sample and the Orbit Menu, and the Select keys the previous fix
  9   | // left to the trigger (Home/End, Space, PageUp/PageDown, typeahead) on the old AntD Select sample and the Orbit
  10  | // Select, each with the control sequence that lacks the key under test.
  11  | const sample = (page) => page.getByRole('region', { name: 'Appearance sample' }).innerText();
  12  | const choice = (page) => page.getByRole('combobox', { name: 'Sample choice', exact: true });
  13  | const attachment = (page) => page.getByRole('button', { name: 'Add attachment', exact: true }).first();
  14  | const TARGETS = {
  15  |   'orbit-field': { url: '/ui-migration/choices.html', field: (page) => page.getByRole('combobox', { name: 'Expires', exact: true }),
  16  |     read: (page) => page.getByRole('status', { name: 'Expiry value', exact: true }).textContent() },
  17  |   'orbit-sample': { url: '/ui-migration/choices.html?system=orbit&sample=expiry', field: choice, read: sample },
  18  |   'antd-sample': { url: '/ui-migration/choices.html?system=antd&sample=expiry', field: choice, read: sample },
  19  |   // The field page's attachment Menu reports its action; the samples (the pair the appearance tests compare)
  20  |   // report none, so every menu also gets an outcome from the DOM: still open, closed by an Enter on a menu item
  21  |   // (that item ran), or closed otherwise.
  22  |   'orbit-menu': { menu: true, url: '/ui-migration/choices.html', field: attachment,
  23  |     read: (page) => page.getByRole('status', { name: 'Action', exact: true }).textContent() },
  24  |   'orbit-menu-sample': { menu: true, url: '/ui-migration/choices.html?system=orbit&sample=attachment', field: attachment },
  25  |   'antd-menu': { menu: true, url: '/ui-migration/choices.html?system=antd&sample=attachment', field: attachment },
  26  | };
  27  | const MENUS = ['orbit-menu', 'orbit-menu-sample', 'antd-menu'];
  28  | const SELECTS = ['orbit-field', 'orbit-sample', 'antd-sample'];
  29  | // `from` is the value before the sequence: Never is the samples' own value, 7 days is selected first with
  30  | // paced keys, null uses the field's own Clear button. `control` names the same sequence without the key under
  31  | // test: a key that leaves the paced result equal to its control's has no function on that component.
  32  | const SEQUENCES = [
  33  |   { name: 'menu-enter', keys: ['Enter'], targets: MENUS },
  34  |   { name: 'menu-down-down-enter', keys: ['ArrowDown', 'ArrowDown', 'Enter'], targets: MENUS },
  35  |   { name: 'menu-down-up-enter', keys: ['ArrowDown', 'ArrowUp', 'Enter'], targets: MENUS },
  36  |   { name: 'menu-down-enter', keys: ['ArrowDown', 'Enter'], targets: MENUS },
  37  |   { name: 'menu-enter-down-enter', keys: ['Enter', 'ArrowDown', 'Enter'], targets: MENUS },
  38  |   { name: 'menu-enter-up-enter', keys: ['Enter', 'ArrowUp', 'Enter'], targets: MENUS },
  39  |   { name: 'menu-enter-enter', keys: ['Enter', 'Enter'], targets: MENUS },
  40  |   // Reference beyond the task's keys: the old Dropdown's own way into its menu (Tab focuses it).
  41  |   { name: 'menu-enter-tab-down-enter', keys: ['Enter', 'Tab', 'ArrowDown', 'Enter'], targets: MENUS },
  42  |   { name: 'select-down', from: 'Never', keys: ['ArrowDown'], targets: SELECTS },
  43  |   { name: 'select-down-enter', from: 'Never', keys: ['ArrowDown', 'Enter'], targets: SELECTS },
  44  |   { name: 'select-down-enter-from-7', from: '7 days', keys: ['ArrowDown', 'Enter'], targets: SELECTS },
  45  |   { name: 'select-down-home-enter', from: '7 days', keys: ['ArrowDown', 'Home', 'Enter'], targets: SELECTS, control: 'select-down-enter-from-7' },
  46  |   { name: 'select-down-end-enter', from: 'Never', keys: ['ArrowDown', 'End', 'Enter'], targets: SELECTS, control: 'select-down-enter' },
  47  |   { name: 'select-down-pageup-enter', from: '7 days', keys: ['ArrowDown', 'PageUp', 'Enter'], targets: SELECTS, control: 'select-down-enter-from-7' },
  48  |   { name: 'select-down-pagedown-enter', from: 'Never', keys: ['ArrowDown', 'PageDown', 'Enter'], targets: SELECTS, control: 'select-down-enter' },
  49  |   { name: 'select-down-space', from: 'Never', keys: ['ArrowDown', 'Space'], targets: SELECTS, control: 'select-down' },
  50  |   { name: 'select-down-space-from-null', from: null, keys: ['ArrowDown', 'Space'], targets: ['orbit-field'] },
  51  |   { name: 'select-space-down-enter', from: 'Never', keys: ['Space', 'ArrowDown', 'Enter'], targets: SELECTS, control: 'select-down-enter' },
  52  |   { name: 'select-enter-down-enter', from: 'Never', keys: ['Enter', 'ArrowDown', 'Enter'], targets: SELECTS, control: 'select-down-enter' },
  53  |   { name: 'select-down-7-enter', from: 'Never', keys: ['ArrowDown', '7', 'Enter'], targets: SELECTS, control: 'select-down-enter' },
  54  |   { name: 'select-down-n-enter', from: '7 days', keys: ['ArrowDown', 'n', 'Enter'], targets: SELECTS, control: 'select-down-enter-from-7' },
  55  | ];
  56  | const RUNS = { burst: 20, paced: 20 };
  57  | // What Playwright 1.63's Chromium keyboard sends for one press (rawKeyDown, or keyDown with text; then keyUp).
  58  | const KEYS = {
  59  |   ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  60  |   ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  61  |   Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  62  |   Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
  63  |   Home: { key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 },
  64  |   End: { key: 'End', code: 'End', windowsVirtualKeyCode: 35 },
  65  |   PageUp: { key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 },
  66  |   PageDown: { key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 },
  67  |   Space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' },
  68  |   7: { key: '7', code: 'Digit7', windowsVirtualKeyCode: 55, text: '7' },
  69  |   n: { key: 'n', code: 'KeyN', windowsVirtualKeyCode: 78, text: 'n' },
  70  | };
  71  | 
  72  | function observeKeys() {
  73  |   const describe = (el) => el instanceof Element
  74  |     ? `${el.getAttribute('role') ?? el.tagName.toLowerCase()}:${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 24)}` : String(el);
  75  |   window.keyLog = [];
  76  |   const start = performance.now();
  77  |   document.addEventListener('keydown', (event) => {
  78  |     const listbox = [...document.querySelectorAll('[role="listbox"],[role="menu"]')].find((el) => el.getBoundingClientRect().height > 0);
  79  |     const active = document.activeElement;
  80  |     const descendant = active?.getAttribute('aria-activedescendant');
  81  |     window.keyLog.push({ key: event.key, t: Math.round((performance.now() - start) * 10) / 10, target: describe(event.target), trusted: event.isTrusted,
  82  |       focused: describe(active), listbox: !!listbox, highlighted: listbox?.querySelector('[data-highlighted]')?.textContent?.trim()
  83  |         ?? (descendant ? document.getElementById(descendant)?.textContent?.trim() : null) ?? null });
  84  |   }, true);
  85  | }
  86  | 
  87  | const read = async (page, target) => (await TARGETS[target].read(page)).trim().split('\n').map((line) => line.trim()).filter(Boolean).join(' | ');
  88  | // The old AntD sample text repeats the selected label (`7 days | 7 days`); the value is its first part.
  89  | const value = async (page, target) => (await read(page, target)).split(' | ')[0];
  90  | function menuOutcome(keyLog, listOpen) {
  91  |   if (listOpen) return 'open';
  92  |   const enter = keyLog.filter((key) => key.key === 'Enter').at(-1);
  93  |   return enter?.target.startsWith('menuitem:') ? `ran ${enter.target.slice('menuitem:'.length)}` : 'closed';
  94  | }
  95  | 
  96  | for (const sequence of SEQUENCES) for (const target of sequence.targets) for (const [mode, runs] of Object.entries(RUNS)) for (let run = 0; run < runs; run++) {
  97  |   test(`${target} ${sequence.name} ${mode} sample ${run}`, async ({ page }, info) => {
  98  |     test.skip(info.project.use.browserName !== 'chromium', 'the key queue is a Chromium DevTools protocol feature');
  99  |     const { menu } = TARGETS[target];
  100 |     await page.goto(TARGETS[target].url);
> 101 |     await expect(page.getByTestId('theme')).toHaveText(info.project.use.colorScheme);
      |                                             ^ Error: expect(locator).toHaveText(expected) failed
  102 |     await page.evaluate(() => document.fonts.ready);
  103 |     const field = TARGETS[target].field(page);
  104 |     if (sequence.from === null) {
  105 |       await page.getByRole('button', { name: 'Clear selection' }).first().click();
  106 |       await expect(page.getByRole('status', { name: 'Expiry value', exact: true })).toHaveText('null');
  107 |     } else if (sequence.from === '7 days') {
  108 |       await field.focus();
  109 |       for (const key of ['ArrowDown', 'ArrowDown', 'Enter']) { await page.keyboard.press(key); await page.waitForTimeout(300); }
  110 |       await page.waitForTimeout(300);
  111 |       expect(['7', '7 days']).toContain(await value(page, target));
  112 |     }
  113 |     const before = menu ? (TARGETS[target].read ? await read(page, target) : null) : await value(page, target);
  114 |     const cdp = await page.context().newCDPSession(page);
  115 |     await page.evaluate(observeKeys);
  116 |     await field.focus();
  117 |     await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  118 |     if (mode === 'burst') {
  119 |       await Promise.all(sequence.keys.flatMap((name) => {
  120 |         const { text, ...key } = KEYS[name];
  121 |         return [cdp.send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', ...key, text, unmodifiedText: text, location: 0 }),
  122 |           cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key, location: 0 })];
  123 |       }));
  124 |     } else {
  125 |       for (const key of sequence.keys) { await page.keyboard.press(key); await page.waitForTimeout(300); }
  126 |     }
  127 |     await page.waitForTimeout(500);
  128 |     const state = await page.evaluate(() => ({
  129 |       listOpen: [...document.querySelectorAll('[role="listbox"],[role="menu"]')].some((el) => el.getBoundingClientRect().height > 0),
  130 |       active: `${document.activeElement?.getAttribute('role') ?? document.activeElement?.tagName.toLowerCase()}:${(document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.textContent ?? '').trim().slice(0, 24)}`,
  131 |     }));
  132 |     const keyLog = await page.evaluate(() => window.keyLog);
  133 |     const after = menu ? (TARGETS[target].read ? await read(page, target) : null) : await value(page, target);
  134 |     // One comparable string per sample: a Select's value and whether its list is still open; a menu's outcome.
  135 |     const result = menu ? menuOutcome(keyLog, state.listOpen) : `${after} | list ${state.listOpen ? 'open' : 'closed'}`;
  136 |     const record = { target, sequence: sequence.name, control: sequence.control ?? null, mode, run, keys: sequence.keys,
  137 |       from: sequence.from === undefined ? null : sequence.from, before, after, result, ...state, keyLog };
  138 |     await cdp.detach();
  139 |     await info.attach('keyboard-window', { body: JSON.stringify(record, null, 2), contentType: 'application/json' });
  140 |   });
  141 | }
  142 | 
```