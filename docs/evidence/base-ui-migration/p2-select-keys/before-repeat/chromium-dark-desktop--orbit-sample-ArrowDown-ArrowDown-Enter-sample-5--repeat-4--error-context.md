# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: select-keys-repeat.browser.mjs >> orbit-sample ArrowDown ArrowDown Enter sample 5
- Location: docs/evidence/base-ui-migration/p2.2/revision-8/select-keys-repeat.browser.mjs:34:3

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
  1  | import { test, expect } from '@playwright/test';
  2  | 
  3  | // Repetition study following select-keys.browser.mjs: the same unthrottled ArrowDown, ArrowDown,
  4  | // Enter sequence (no waits, as in choices.browser.mjs:263) 40 times per target, one test per
  5  | // sample, recording whether the second ArrowDown reached the trigger while the listbox was already
  6  | // shown and whether Enter then left the value unchanged. The first version of this file looped all
  7  | // 40 samples inside one test and exceeded the 90s test budget before attaching anything.
  8  | const TARGETS = [
  9  |   { name: 'orbit-field', url: '/ui-migration/choices.html', label: 'Expires',
  10 |     read: (page) => page.getByRole('status', { name: 'Expiry value', exact: true }).textContent() },
  11 |   { name: 'orbit-sample', url: '/ui-migration/choices.html?system=orbit&sample=expiry', label: 'Sample choice',
  12 |     read: (page) => page.getByRole('region', { name: 'Appearance sample' }).innerText() },
  13 |   { name: 'antd-sample', url: '/ui-migration/choices.html?system=antd&sample=expiry', label: 'Sample choice',
  14 |     read: (page) => page.getByRole('region', { name: 'Appearance sample' }).innerText() },
  15 | ];
  16 | const RUNS = 40;
  17 | 
  18 | function observeKeys() {
  19 |   const describe = (el) => el instanceof Element
  20 |     ? `${el.getAttribute('role') ?? el.tagName.toLowerCase()}:${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 24)}` : String(el);
  21 |   window.keyLog = [];
  22 |   const start = performance.now();
  23 |   document.addEventListener('keydown', (event) => {
  24 |     const listbox = [...document.querySelectorAll('[role="listbox"]')].find((el) => el.getBoundingClientRect().height > 0);
  25 |     const active = document.activeElement;
  26 |     const descendant = active?.getAttribute('aria-activedescendant');
  27 |     window.keyLog.push({ key: event.key, t: Math.round((performance.now() - start) * 10) / 10, target: describe(event.target),
  28 |       listbox: !!listbox, highlighted: listbox?.querySelector('[data-highlighted]')?.textContent?.trim()
  29 |         ?? (descendant ? document.getElementById(descendant)?.textContent?.trim() : null) ?? null });
  30 |   }, true);
  31 | }
  32 | 
  33 | for (const target of TARGETS) for (let run = 0; run < RUNS; run++) {
  34 |   test(`${target.name} ArrowDown ArrowDown Enter sample ${run}`, async ({ page }, info) => {
  35 |     test.skip(info.project.use.browserName !== 'chromium', 'paired with the Chromium-only throttled probe');
  36 |     await page.goto(target.url);
> 37 |     await expect(page.getByTestId('theme')).toHaveText(info.project.use.colorScheme);
     |                                             ^ Error: expect(locator).toHaveText(expected) failed
  38 |     await page.evaluate(() => document.fonts.ready);
  39 |     const before = (await target.read(page)).trim();
  40 |     await page.evaluate(observeKeys);
  41 |     await page.getByRole('combobox', { name: target.label, exact: true }).focus();
  42 |     await page.keyboard.press('ArrowDown');
  43 |     await page.keyboard.press('ArrowDown');
  44 |     await page.keyboard.press('Enter');
  45 |     await page.waitForTimeout(500);
  46 |     const listboxOpen = await page.evaluate(() => [...document.querySelectorAll('[role="listbox"]')].some((el) => el.getBoundingClientRect().height > 0));
  47 |     const record = { target: target.name, run, before, after: (await target.read(page)).trim(), listboxOpen, keys: await page.evaluate(() => window.keyLog) };
  48 |     await info.attach('select-keys', { body: JSON.stringify(record, null, 2), contentType: 'application/json' });
  49 |   });
  50 | }
  51 | 
```