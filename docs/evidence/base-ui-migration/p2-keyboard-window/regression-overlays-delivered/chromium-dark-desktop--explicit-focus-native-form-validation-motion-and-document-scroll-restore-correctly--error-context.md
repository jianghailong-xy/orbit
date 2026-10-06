# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: overlays.browser.mjs >> explicit focus, native form validation, motion and document scroll restore correctly
- Location: ui-migration/overlays.browser.mjs:437:1

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
  3   | const fixture = '/ui-migration/overlays.html';
  4   | const errors = new WeakMap();
  5   | test.beforeEach(async ({ page }, info) => {
  6   |   errors.set(page, []);
  7   |   page.on('pageerror', (error) => errors.get(page).push(error.message));
  8   |   await page.goto(fixture);
> 9   |   await expect(page.getByTestId('theme')).toHaveText(info.project.use.colorScheme);
      |                                           ^ Error: expect(locator).toHaveText(expected) failed
  10  |   await page.evaluate(() => document.fonts.ready);
  11  |   expect(await page.evaluate(() => ({ width: innerWidth, dpr: devicePixelRatio, scale: visualViewport.scale })))
  12  |     .toEqual({ width: info.project.use.viewport.width, dpr: 1, scale: 1 });
  13  | });
  14  | test.afterEach(async ({ page }) => { expect(errors.get(page)).toEqual([]); });
  15  | 
  16  | async function settled(dialog) {
  17  |   await expect(dialog).toBeVisible();
  18  |   await expect.poll(() => dialog.evaluate((el) => {
  19  |     for (let node = el; node; node = node.parentElement) {
  20  |       const s = getComputedStyle(node);
  21  |       if (s.opacity !== '1' || s.transform !== 'none' || (s.scale !== 'none' && s.scale !== '1')) return false;
  22  |     }
  23  |     return true;
  24  |   })).toBe(true);
  25  |   await dialog.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  26  | }
  27  | async function trapped(page, dialog, count = 8) {
  28  |   const contains = () => dialog.evaluate((el) => el.contains(document.activeElement));
  29  |   await expect.poll(contains).toBe(true);
  30  |   for (const key of ['Tab', 'Shift+Tab']) for (let i = 0; i < count; i++) {
  31  |     await page.keyboard.press(key);
  32  |     await expect.poll(contains, { message: `${key} remains in the active overlay` }).toBe(true);
  33  |   }
  34  | }
  35  | async function topmost(dialog) {
  36  |   expect(await dialog.evaluate((el) => {
  37  |     const r = el.getBoundingClientRect();
  38  |     return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + Math.min(r.height / 2, 100)));
  39  |   })).toBe(true);
  40  | }
  41  | async function outside(page, info) {
  42  |   if (info.project.use.hasTouch) await page.touchscreen.tap(4, 60);
  43  |   else await page.mouse.click(4, 60);
  44  | }
  45  | async function attach(info, name, value) {
  46  |   await info.attach(name, { body: JSON.stringify(value, null, 2), contentType: 'application/json' });
  47  | }
  48  | async function shot(page, info, name, locator) {
  49  |   await info.attach(name, { body: await (locator ?? page).screenshot({ animations: 'disabled' }), contentType: 'image/png' });
  50  | }
  51  | const pageScroll = (page) => page.evaluate(() => ({ x: scrollX, y: scrollY,
  52  |   html: document.documentElement.style.cssText, body: document.body.style.cssText }));
  53  | async function locked(page) {
  54  |   expect(await page.evaluate(() => [document.documentElement, document.body].some((el) => /hidden|clip/.test(getComputedStyle(el).overflowY)))).toBe(true);
  55  | }
  56  | 
  57  | test('dialog and drawers match current surfaces, geometry, typography and actions', async ({ page }, info) => {
  58  |   const measurements = {};
  59  |   const settleState = (locator) => locator.evaluate(async (el) => {
  60  |     await Promise.all(el.getAnimations({ subtree: true })
  61  |       .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
  62  |       .map((animation) => animation.finished.catch(() => {})));
  63  |   });
  64  |   const inputState = (input) => input.evaluate((el) => {
  65  |     const style = getComputedStyle(el);
  66  |     return { hovered: el.matches(':hover'), focused: el.matches(':focus'), focusVisible: el.matches(':focus-visible'),
  67  |       borderColor: style.borderColor, borderWidth: style.borderWidth, borderStyle: style.borderStyle, boxShadow: style.boxShadow };
  68  |   });
  69  |   const measure = async (system, kind) => {
  70  |     await page.getByRole('button', { name: `${system} ${kind}`, exact: true }).click();
  71  |     const overlay = page.getByRole(system === 'Orbit' && kind === 'confirm' ? 'alertdialog' : 'dialog');
  72  |     await settled(overlay);
  73  |     // Sample the same neutral state. Opening buttons can leave the pointer over
  74  |     // a newly positioned input, and the two libraries choose different autofocus.
  75  |     await page.mouse.move(0, 0);
  76  |     const focusRoot = system === 'AntD' && kind.includes('drawer') ? page.locator('.reference-drawer-root').filter({ has: overlay }) : overlay;
  77  |     await focusRoot.focus();
  78  |     await expect(focusRoot).toBeFocused();
  79  |     await settleState(overlay);
  80  |     const root = system === 'Orbit' ? overlay : page.locator('.reference-surface:visible');
  81  |     const result = await root.evaluate((el) => {
  82  |       const s = getComputedStyle(el), r = el.getBoundingClientRect();
  83  |       const keys = ['fontFamily', 'fontSize', 'lineHeight', 'color', 'backgroundColor', 'borderRadius', 'padding', 'boxShadow'];
  84  |       const text = [...el.querySelectorAll('button, input')].map((node) => {
  85  |         const rect = node.getBoundingClientRect();
  86  |         const style = getComputedStyle(node);
  87  |         return { name: node.getAttribute('aria-label') ?? node.textContent, x: rect.x - r.x, y: rect.y - r.y, width: rect.width, height: rect.height,
  88  |           hovered: node.matches(':hover'), focused: node.matches(':focus'), focusVisible: node.matches(':focus-visible'),
  89  |           ...(node.tagName === 'INPUT' ? { borderColor: style.borderColor, borderWidth: style.borderWidth, borderStyle: style.borderStyle, boxShadow: style.boxShadow } : {}) };
  90  |       });
  91  |       return { x: r.x, y: r.y, width: r.width, height: r.height, ...Object.fromEntries(keys.map((key) => [key, s[key]])), controls: text };
  92  |     });
  93  |     if (system === 'AntD' && kind.includes('drawer')) {
  94  |       result.boxShadow = await page.locator('.reference-drawer-wrapper:visible').evaluate((el) => getComputedStyle(el).boxShadow);
  95  |     }
  96  |     if (kind.includes('drawer')) {
  97  |       result.separators = {};
  98  |       for (const [part, edge] of [['header', 'Bottom'], ['footer', 'Top']]) {
  99  |         const region = root.locator(system === 'AntD' ? `.reference-${part}` : `:scope > .orbit-overlay-${part}`);
  100 |         result.separators[part] = await region.evaluate((el, edge) => {
  101 |           const style = getComputedStyle(el);
  102 |           return { color: style[`border${edge}Color`], width: style[`border${edge}Width`], style: style[`border${edge}Style`] };
  103 |         }, edge);
  104 |       }
  105 |     }
  106 |     for (const control of result.controls) {
  107 |       expect(control.hovered, `${system} ${kind}: ${control.name} is not hovered`).toBe(false);
  108 |       expect(control.focused, `${system} ${kind}: ${control.name} is not focused`).toBe(false);
  109 |       expect(control.focusVisible, `${system} ${kind}: ${control.name} has no focus ring`).toBe(false);
```