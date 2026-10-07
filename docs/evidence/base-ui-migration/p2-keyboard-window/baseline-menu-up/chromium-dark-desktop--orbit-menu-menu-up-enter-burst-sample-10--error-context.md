# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: keyboard-window.browser.mjs >> orbit-menu menu-up-enter burst sample 10
- Location: docs/evidence/base-ui-migration/p2-keyboard-window/keyboard-window.browser.mjs:101:3

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
  40  |   // Added after the first baseline: ↑ as the opener (Base UI opens on the last item), the other Menu ↑ case.
  41  |   { name: 'menu-up-enter', keys: ['ArrowUp', 'Enter'], targets: MENUS },
  42  |   { name: 'menu-up-up-enter', keys: ['ArrowUp', 'ArrowUp', 'Enter'], targets: MENUS },
  43  |   { name: 'menu-up-down-enter', keys: ['ArrowUp', 'ArrowDown', 'Enter'], targets: MENUS },
  44  |   // Reference beyond the task's keys: the old Dropdown's own way into its menu (Tab focuses it).
  45  |   { name: 'menu-enter-tab-down-enter', keys: ['Enter', 'Tab', 'ArrowDown', 'Enter'], targets: MENUS },
  46  |   { name: 'select-down', from: 'Never', keys: ['ArrowDown'], targets: SELECTS },
  47  |   { name: 'select-down-enter', from: 'Never', keys: ['ArrowDown', 'Enter'], targets: SELECTS },
  48  |   { name: 'select-down-enter-from-7', from: '7 days', keys: ['ArrowDown', 'Enter'], targets: SELECTS },
  49  |   { name: 'select-down-home-enter', from: '7 days', keys: ['ArrowDown', 'Home', 'Enter'], targets: SELECTS, control: 'select-down-enter-from-7' },
  50  |   { name: 'select-down-end-enter', from: 'Never', keys: ['ArrowDown', 'End', 'Enter'], targets: SELECTS, control: 'select-down-enter' },
  51  |   { name: 'select-down-pageup-enter', from: '7 days', keys: ['ArrowDown', 'PageUp', 'Enter'], targets: SELECTS, control: 'select-down-enter-from-7' },
  52  |   { name: 'select-down-pagedown-enter', from: 'Never', keys: ['ArrowDown', 'PageDown', 'Enter'], targets: SELECTS, control: 'select-down-enter' },
  53  |   { name: 'select-down-space', from: 'Never', keys: ['ArrowDown', 'Space'], targets: SELECTS, control: 'select-down' },
  54  |   { name: 'select-down-space-from-null', from: null, keys: ['ArrowDown', 'Space'], targets: ['orbit-field'] },
  55  |   { name: 'select-space-down-enter', from: 'Never', keys: ['Space', 'ArrowDown', 'Enter'], targets: SELECTS, control: 'select-down-enter' },
  56  |   { name: 'select-enter-down-enter', from: 'Never', keys: ['Enter', 'ArrowDown', 'Enter'], targets: SELECTS, control: 'select-down-enter' },
  57  |   { name: 'select-down-7-enter', from: 'Never', keys: ['ArrowDown', '7', 'Enter'], targets: SELECTS, control: 'select-down-enter' },
  58  |   { name: 'select-down-n-enter', from: '7 days', keys: ['ArrowDown', 'n', 'Enter'], targets: SELECTS, control: 'select-down-enter-from-7' },
  59  | ];
  60  | const RUNS = { burst: 20, paced: 20 };
  61  | // What Playwright 1.63's Chromium keyboard sends for one press (rawKeyDown, or keyDown with text; then keyUp).
  62  | const KEYS = {
  63  |   ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  64  |   ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  65  |   Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  66  |   Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
  67  |   Home: { key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 },
  68  |   End: { key: 'End', code: 'End', windowsVirtualKeyCode: 35 },
  69  |   PageUp: { key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 },
  70  |   PageDown: { key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 },
  71  |   Space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' },
  72  |   7: { key: '7', code: 'Digit7', windowsVirtualKeyCode: 55, text: '7' },
  73  |   n: { key: 'n', code: 'KeyN', windowsVirtualKeyCode: 78, text: 'n' },
  74  | };
  75  | 
  76  | function observeKeys() {
  77  |   const describe = (el) => el instanceof Element
  78  |     ? `${el.getAttribute('role') ?? el.tagName.toLowerCase()}:${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 24)}` : String(el);
  79  |   window.keyLog = [];
  80  |   const start = performance.now();
  81  |   document.addEventListener('keydown', (event) => {
  82  |     const listbox = [...document.querySelectorAll('[role="listbox"],[role="menu"]')].find((el) => el.getBoundingClientRect().height > 0);
  83  |     const active = document.activeElement;
  84  |     const descendant = active?.getAttribute('aria-activedescendant');
  85  |     window.keyLog.push({ key: event.key, t: Math.round((performance.now() - start) * 10) / 10, target: describe(event.target), trusted: event.isTrusted,
  86  |       focused: describe(active), listbox: !!listbox, highlighted: listbox?.querySelector('[data-highlighted]')?.textContent?.trim()
  87  |         ?? (descendant ? document.getElementById(descendant)?.textContent?.trim() : null) ?? null });
  88  |   }, true);
  89  | }
  90  | 
  91  | const read = async (page, target) => (await TARGETS[target].read(page)).trim().split('\n').map((line) => line.trim()).filter(Boolean).join(' | ');
  92  | // The old AntD sample text repeats the selected label (`7 days | 7 days`); the value is its first part.
  93  | const value = async (page, target) => (await read(page, target)).split(' | ')[0];
  94  | function menuOutcome(keyLog, listOpen) {
  95  |   if (listOpen) return 'open';
  96  |   const enter = keyLog.filter((key) => key.key === 'Enter').at(-1);
  97  |   return enter?.target.startsWith('menuitem:') ? `ran ${enter.target.slice('menuitem:'.length)}` : 'closed';
  98  | }
  99  | 
  100 | for (const sequence of SEQUENCES) for (const target of sequence.targets) for (const [mode, runs] of Object.entries(RUNS)) for (let run = 0; run < runs; run++) {
  101 |   test(`${target} ${sequence.name} ${mode} sample ${run}`, async ({ page }, info) => {
  102 |     test.skip(info.project.use.browserName !== 'chromium', 'the key queue is a Chromium DevTools protocol feature');
  103 |     const { menu } = TARGETS[target];
  104 |     await page.goto(TARGETS[target].url);
> 105 |     await expect(page.getByTestId('theme')).toHaveText(info.project.use.colorScheme);
      |                                             ^ Error: expect(locator).toHaveText(expected) failed
  106 |     await page.evaluate(() => document.fonts.ready);
  107 |     const field = TARGETS[target].field(page);
  108 |     if (sequence.from === null) {
  109 |       await page.getByRole('button', { name: 'Clear selection' }).first().click();
  110 |       await expect(page.getByRole('status', { name: 'Expiry value', exact: true })).toHaveText('null');
  111 |     } else if (sequence.from === '7 days') {
  112 |       await field.focus();
  113 |       for (const key of ['ArrowDown', 'ArrowDown', 'Enter']) { await page.keyboard.press(key); await page.waitForTimeout(300); }
  114 |       await page.waitForTimeout(300);
  115 |       expect(['7', '7 days']).toContain(await value(page, target));
  116 |     }
  117 |     const before = menu ? (TARGETS[target].read ? await read(page, target) : null) : await value(page, target);
  118 |     const cdp = await page.context().newCDPSession(page);
  119 |     await page.evaluate(observeKeys);
  120 |     await field.focus();
  121 |     await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  122 |     if (mode === 'burst') {
  123 |       await Promise.all(sequence.keys.flatMap((name) => {
  124 |         const { text, ...key } = KEYS[name];
  125 |         return [cdp.send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', ...key, text, unmodifiedText: text, location: 0 }),
  126 |           cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key, location: 0 })];
  127 |       }));
  128 |     } else {
  129 |       for (const key of sequence.keys) { await page.keyboard.press(key); await page.waitForTimeout(300); }
  130 |     }
  131 |     await page.waitForTimeout(500);
  132 |     const state = await page.evaluate(() => ({
  133 |       listOpen: [...document.querySelectorAll('[role="listbox"],[role="menu"]')].some((el) => el.getBoundingClientRect().height > 0),
  134 |       active: `${document.activeElement?.getAttribute('role') ?? document.activeElement?.tagName.toLowerCase()}:${(document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.textContent ?? '').trim().slice(0, 24)}`,
  135 |     }));
  136 |     const keyLog = await page.evaluate(() => window.keyLog);
  137 |     const after = menu ? (TARGETS[target].read ? await read(page, target) : null) : await value(page, target);
  138 |     // One comparable string per sample: a Select's value and whether its list is still open; a menu's outcome.
  139 |     const result = menu ? menuOutcome(keyLog, state.listOpen) : `${after} | list ${state.listOpen ? 'open' : 'closed'}`;
  140 |     const record = { target, sequence: sequence.name, control: sequence.control ?? null, mode, run, keys: sequence.keys,
  141 |       from: sequence.from === undefined ? null : sequence.from, before, after, result, ...state, keyLog };
  142 |     await cdp.detach();
  143 |     await info.attach('keyboard-window', { body: JSON.stringify(record, null, 2), contentType: 'application/json' });
  144 |   });
  145 | }
  146 | 
```