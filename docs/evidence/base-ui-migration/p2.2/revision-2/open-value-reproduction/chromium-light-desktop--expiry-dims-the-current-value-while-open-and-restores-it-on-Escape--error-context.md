# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: choices-open-value.browser.mjs >> expiry dims the current value while open and restores it on Escape
- Location: ui-migration/choices-open-value.browser.mjs:24:53

# Error details

```
Error: expect(received).toEqual(expected) // deep equality

- Expected  - 1
+ Received  + 1

@@ -11,11 +11,11 @@
    "open": Array [
      Object {
        "color": "rgb(31, 35, 41)",
        "fontSize": "14px",
        "fontWeight": "400",
-       "opacity": 0.25,
+       "opacity": 1,
        "text": "Never",
      },
    ],
    "restored": Array [
      Object {
```

# Page snapshot

```yaml
- main [ref=f1e4]:
  - status [ref=f1e5]: light
  - button "Switch theme" [ref=f1e6] [cursor=pointer]
  - region "Appearance sample" [ref=f1e8]:
    - generic [ref=f1e9]:
      - combobox "Sample choice" [active] [ref=f1e11] [cursor=pointer]:
        - generic [ref=f1e12]: Never
      - textbox [aria-hidden] [ref=f1e16]: never
```

# Test source

```ts
  1  | import { test, expect } from '@playwright/test';
  2  | 
  3  | async function appearance(control) {
  4  |   return control.evaluate((element) => {
  5  |     const texts = [];
  6  |     const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  7  |     while (walker.nextNode()) {
  8  |       const node = walker.currentNode;
  9  |       if (!node.textContent.trim()) continue;
  10 |       const style = getComputedStyle(node.parentElement);
  11 |       let opacity = 1;
  12 |       for (let parent = node.parentElement; parent; parent = parent.parentElement) {
  13 |         const ancestor = getComputedStyle(parent);
  14 |         opacity *= Number(ancestor.opacity);
  15 |         if (ancestor.display === 'none' || ancestor.visibility === 'hidden') opacity = 0;
  16 |       }
  17 |       if (!opacity) continue;
  18 |       texts.push({ text: node.textContent, color: style.color, fontSize: style.fontSize, fontWeight: style.fontWeight, opacity });
  19 |     }
  20 |     return texts;
  21 |   });
  22 | }
  23 | 
  24 | for (const kind of ['expiry', 'account', 'search']) test(`${kind} dims the current value while open and restores it on Escape`, async ({ page }, info) => {
  25 |   const samples = {};
  26 |   const errors = [];
  27 |   page.on('pageerror', (error) => errors.push(error.message));
  28 |   for (const system of ['antd', 'orbit']) {
  29 |     await page.goto(`/ui-migration/choices.html?sample=${kind}&system=${system}`);
  30 |     await expect(page.getByTestId('theme')).toHaveText(info.project.use.colorScheme);
  31 |     await page.evaluate(() => document.fonts.ready);
  32 |     const region = page.getByRole('region', { name: 'Appearance sample' });
  33 |     const choice = region.getByRole('combobox');
  34 |     const control = page.locator('.sample-choice');
  35 |     samples[system] = { closed: await appearance(control) };
  36 |     await choice.click();
  37 |     await expect(page.locator('.sample-surface:visible')).toBeVisible();
  38 |     samples[system].open = await appearance(control);
  39 |     await info.attach(`${system}-${kind}-open-value`, { body: await page.screenshot({ animations: 'disabled' }), contentType: 'image/png' });
  40 |     await page.keyboard.press('Escape');
  41 |     await expect(choice).toHaveAttribute('aria-expanded', 'false');
  42 |     await expect(choice).toBeFocused();
  43 |     samples[system].restored = await appearance(control);
  44 |   }
  45 |   await info.attach('open-value', { body: JSON.stringify(samples, null, 2), contentType: 'application/json' });
> 46 |   expect(samples.orbit).toEqual(samples.antd);
     |                         ^ Error: expect(received).toEqual(expected) // deep equality
  47 |   expect(samples.orbit.closed).toHaveLength(1);
  48 |   expect(samples.orbit.open).toHaveLength(1);
  49 |   expect(samples.orbit.closed[0].opacity).toBe(1);
  50 |   expect(samples.orbit.open[0].opacity).toBe(.25);
  51 |   expect(samples.orbit.restored).toEqual(samples.orbit.closed);
  52 |   expect(errors).toEqual([]);
  53 | });
  54 | 
```