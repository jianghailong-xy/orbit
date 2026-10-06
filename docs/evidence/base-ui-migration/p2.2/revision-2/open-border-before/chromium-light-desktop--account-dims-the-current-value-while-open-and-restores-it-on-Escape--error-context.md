# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: choices-open-value.browser.mjs >> account dims the current value while open and restores it on Escape
- Location: ui-migration/choices-open-value.browser.mjs:26:53

# Error details

```
Error: expect(received).toEqual(expected) // deep equality

- Expected  - 4
+ Received  + 4

@@ -11,23 +11,23 @@
      },
    ],
    "open": Array [
      Object {
        "color": "rgb(31, 35, 41)",
-       "controlBorderColor": "rgb(51, 112, 255)",
-       "controlBoxShadow": "rgba(5, 122, 255, 0.06) 0px 0px 0px 2px",
+       "controlBorderColor": "rgb(92, 146, 255)",
+       "controlBoxShadow": "none",
        "fontSize": "14px",
        "fontWeight": "400",
        "opacity": 0.25,
        "text": "Automatic",
      },
    ],
    "restored": Array [
      Object {
        "color": "rgb(31, 35, 41)",
-       "controlBorderColor": "rgb(51, 112, 255)",
-       "controlBoxShadow": "rgba(5, 122, 255, 0.06) 0px 0px 0px 2px",
+       "controlBorderColor": "rgb(92, 146, 255)",
+       "controlBoxShadow": "rgba(0, 0, 0, 0) 0px 0px 0px 0px",
        "fontSize": "14px",
        "fontWeight": "400",
        "opacity": 1,
        "text": "Automatic",
      },
```

# Page snapshot

```yaml
- main [ref=f1e4]:
  - status [ref=f1e5]: light
  - button "Switch theme" [ref=f1e6] [cursor=pointer]
  - region "Appearance sample" [ref=f1e8]:
    - generic [ref=f1e9]:
      - combobox "Sample choice" [active] [ref=f1e11] [cursor=pointer]:
        - generic [ref=f1e12]: Automatic
      - textbox [aria-hidden] [ref=f1e16]
```

# Test source

```ts
  1  | import { test, expect } from '@playwright/test';
  2  | 
  3  | async function appearance(control) {
  4  |   return control.evaluate((element) => {
  5  |     const texts = [];
  6  |     const controlStyle = getComputedStyle(element);
  7  |     const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  8  |     while (walker.nextNode()) {
  9  |       const node = walker.currentNode;
  10 |       if (!node.textContent.trim()) continue;
  11 |       const style = getComputedStyle(node.parentElement);
  12 |       let opacity = 1;
  13 |       for (let parent = node.parentElement; parent; parent = parent.parentElement) {
  14 |         const ancestor = getComputedStyle(parent);
  15 |         opacity *= Number(ancestor.opacity);
  16 |         if (ancestor.display === 'none' || ancestor.visibility === 'hidden') opacity = 0;
  17 |       }
  18 |       if (!opacity) continue;
  19 |       texts.push({ text: node.textContent, color: style.color, fontSize: style.fontSize, fontWeight: style.fontWeight, opacity,
  20 |         controlBorderColor: controlStyle.borderColor, controlBoxShadow: controlStyle.boxShadow });
  21 |     }
  22 |     return texts;
  23 |   });
  24 | }
  25 | 
  26 | for (const kind of ['expiry', 'account', 'search']) test(`${kind} dims the current value while open and restores it on Escape`, async ({ page }, info) => {
  27 |   const samples = {};
  28 |   const errors = [];
  29 |   page.on('pageerror', (error) => errors.push(error.message));
  30 |   for (const system of ['antd', 'orbit']) {
  31 |     await page.goto(`/ui-migration/choices.html?sample=${kind}&system=${system}`);
  32 |     await expect(page.getByTestId('theme')).toHaveText(info.project.use.colorScheme);
  33 |     await page.evaluate(() => document.fonts.ready);
  34 |     const region = page.getByRole('region', { name: 'Appearance sample' });
  35 |     const choice = region.getByRole('combobox');
  36 |     const control = page.locator('.sample-choice');
  37 |     samples[system] = { closed: await appearance(control) };
  38 |     await choice.click();
  39 |     const popup = page.locator('.sample-surface:visible');
  40 |     await expect(popup).toBeVisible();
  41 |     await popup.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  42 |     await expect.poll(() => popup.evaluate((node) => {
  43 |       for (let parent = node; parent; parent = parent.parentElement) {
  44 |         const style = getComputedStyle(parent);
  45 |         const matrix = new DOMMatrixReadOnly(style.transform);
  46 |         if (Number(style.opacity) !== 1 || Math.hypot(matrix.a, matrix.b) !== 1 || Math.hypot(matrix.c, matrix.d) !== 1) return false;
  47 |       }
  48 |       return true;
  49 |     })).toBe(true);
  50 |     await control.evaluate(async (node) => Promise.all(node.getAnimations({ subtree: true }).map((animation) => animation.finished.catch(() => {}))));
  51 |     samples[system].open = await appearance(control);
  52 |     await info.attach(`${system}-${kind}-open-value`, { body: await page.screenshot({ animations: 'disabled' }), contentType: 'image/png' });
  53 |     await page.keyboard.press('Escape');
  54 |     await expect(choice).toHaveAttribute('aria-expanded', 'false');
  55 |     await expect(choice).toBeFocused();
  56 |     samples[system].restored = await appearance(control);
  57 |   }
  58 |   await info.attach('open-value', { body: JSON.stringify(samples, null, 2), contentType: 'application/json' });
> 59 |   expect(samples.orbit).toEqual(samples.antd);
     |                         ^ Error: expect(received).toEqual(expected) // deep equality
  60 |   expect(samples.orbit.closed).toHaveLength(1);
  61 |   expect(samples.orbit.open).toHaveLength(1);
  62 |   expect(samples.orbit.closed[0].opacity).toBe(1);
  63 |   expect(samples.orbit.open[0].opacity).toBe(.25);
  64 |   expect(samples.orbit.restored).toEqual(samples.orbit.closed);
  65 |   expect(errors).toEqual([]);
  66 | });
  67 | 
```