# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: choices.browser.mjs >> email tags support controlled typing, separators, composition, Enter, blur and deletion
- Location: ui-migration/choices.browser.mjs:552:1

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
  3   | const fixture = '/ui-migration/choices.html';
  4   | const errors = new WeakMap();
  5   | test.beforeEach(async ({ page }, info) => {
  6   |   errors.set(page, []);
  7   |   page.on('pageerror', (error) => errors.get(page).push(error.message));
  8   |   await page.goto(fixture);
> 9   |   await expect(page.getByTestId('theme')).toHaveText(info.project.use.colorScheme);
      |                                           ^ Error: expect(locator).toHaveText(expected) failed
  10  |   await page.evaluate(() => document.fonts.ready);
  11  | });
  12  | test.afterEach(async ({ page }) => { expect(errors.get(page)).toEqual([]); });
  13  | const attach = (info, name, value) => info.attach(name, { body: JSON.stringify(value, null, 2), contentType: 'application/json' });
  14  | const shot = (info, name, locator) => locator.screenshot({ animations: 'disabled' }).then((body) => info.attach(name, { body, contentType: 'image/png' }));
  15  | async function settle(locator) {
  16  |   await expect(locator).toBeVisible();
  17  |   // Enter motion may be scheduled after mounting. Wait for the initial frames
  18  |   // and the surface's scale before measuring or asking Playwright to capture it.
  19  |   await locator.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  20  |   await expect.poll(() => locator.evaluate((el) => {
  21  |     for (let node = el; node; node = node.parentElement) {
  22  |       const matrix = new DOMMatrixReadOnly(getComputedStyle(node).transform);
  23  |       if (Math.hypot(matrix.a, matrix.b) !== 1 || Math.hypot(matrix.c, matrix.d) !== 1) return false;
  24  |     }
  25  |     return true;
  26  |   })).toBe(true);
  27  |   await locator.evaluate(async (el) => {
  28  |     const animations = new Set(el.getAnimations({ subtree: true }));
  29  |     for (let node = el.parentElement; node; node = node.parentElement) for (const animation of node.getAnimations()) animations.add(animation);
  30  |     await Promise.all([...animations].filter((a) => a.effect?.getComputedTiming().iterations !== Infinity).map((a) => a.finished.catch(() => {})));
  31  |     await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  32  |   });
  33  | }
  34  | async function tap(page, info, locator) {
  35  |   if (info.project.use.hasTouch) await locator.tap();
  36  |   else await locator.click();
  37  | }
  38  | async function outside(page, info) {
  39  |   if (info.project.use.hasTouch) await page.touchscreen.tap(3, 60);
  40  |   else await page.mouse.click(3, 60);
  41  | }
  42  | async function measure(locator, contents = false) {
  43  |   return locator.evaluate((el, contents) => {
  44  |     const root = el.getBoundingClientRect();
  45  |     const metrics = (node) => {
  46  |       const r = node.getBoundingClientRect(), s = getComputedStyle(node);
  47  |       const keys = ['fontFamily', 'fontSize', 'lineHeight', 'fontWeight', 'color', 'backgroundColor', 'borderRadius', 'borderColor', 'borderWidth', 'borderStyle', 'padding', 'boxShadow'];
  48  |       return { x: r.x - root.x, y: r.y - root.y, width: r.width, height: r.height, ...Object.fromEntries(keys.map((key) => [key, s[key]])) };
  49  |     };
  50  |     const visible = (node) => {
  51  |       for (let parent = node; parent; parent = parent.parentElement) {
  52  |         const style = getComputedStyle(parent);
  53  |         if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
  54  |       }
  55  |       return node.getBoundingClientRect().width > 0;
  56  |     };
  57  |     const result = { surface: metrics(el), rows: [...el.querySelectorAll('[role="menuitem"], [role="option"]')].map((row) => ({ label: row.textContent, ...metrics(row) })),
  58  |       separators: [...el.querySelectorAll('[role="separator"]')].map(metrics) };
  59  |     if (contents) {
  60  |       result.origin = { x: root.x, y: root.y };
  61  |       result.chips = [...el.querySelectorAll('.sample-chip, .orbit-multi-chip')].filter(visible).map(metrics);
  62  |       result.texts = [];
  63  |       const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  64  |       while (walker.nextNode()) {
  65  |         const node = walker.currentNode;
  66  |         if (!node.textContent.trim() || !visible(node.parentElement)) continue;
  67  |         const range = document.createRange(); range.selectNode(node);
  68  |         const r = range.getBoundingClientRect(), s = getComputedStyle(node.parentElement);
  69  |         if (!r.width || !r.height) continue;
  70  |         result.texts.push({ text: node.textContent, x: r.x - root.x, y: r.y - root.y, width: r.width, height: r.height,
  71  |           color: s.color, fontSize: s.fontSize, fontWeight: s.fontWeight });
  72  |       }
  73  |       result.icons = [...el.querySelectorAll('svg')].filter(visible).map((svg) => {
  74  |         const r = svg.getBoundingClientRect();
  75  |         return { x: r.x - root.x, y: r.y - root.y, width: r.width, height: r.height, color: getComputedStyle(svg).color, paths: [...svg.querySelectorAll('path')].map((path) => path.getAttribute('d')) };
  76  |       });
  77  |     }
  78  |     return result;
  79  |   }, contents);
  80  | }
  81  | 
  82  | for (const kind of ['attachment', 'access', 'expiry', 'account', 'search', 'popover', 'tooltip']) {
  83  |   test(`${kind} matches the current surface, density and option states`, async ({ page }, info) => {
  84  |     const measurements = {};
  85  |     const glyphs = {};
  86  |     for (const system of ['antd', 'orbit']) {
  87  |       await page.goto(`${fixture}?sample=${kind}&system=${system}`);
  88  |       await expect(page.getByTestId('theme')).toHaveText(info.project.use.colorScheme);
  89  |       const region = page.getByRole('region', { name: 'Appearance sample' });
  90  |       const choice = region.getByRole('combobox');
  91  |       if (['expiry', 'account', 'search'].includes(kind)) {
  92  |         await page.mouse.move(0, 0);
  93  |         await page.getByTestId('neutral').focus();
  94  |         await settle(page.locator('.sample-choice'));
  95  |         measurements[system] = { control: await measure(page.locator('.sample-choice'), true) };
  96  |         await shot(info, `${system}-${kind}-closed`, page.locator('.sample-choice'));
  97  |         await choice.click();
  98  |       } else if (kind === 'tooltip') {
  99  |         await region.getByRole('button').hover();
  100 |         await settle(region.getByRole('button'));
  101 |       }
  102 |       else await region.getByRole('button').click();
  103 |       const surface = page.locator('.sample-surface:visible');
  104 |       await settle(surface);
  105 |       if (kind !== 'tooltip') await page.mouse.move(0, 0);
  106 |       await settle(surface);
  107 |       measurements[system] = { ...measurements[system], popup: await measure(surface) };
  108 |       if (kind === 'attachment') {
  109 |         measurements[system].labelStarts = [];
```