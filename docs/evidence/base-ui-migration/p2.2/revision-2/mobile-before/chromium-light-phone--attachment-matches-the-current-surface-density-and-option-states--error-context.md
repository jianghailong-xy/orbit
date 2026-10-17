# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: choices.browser.mjs >> attachment matches the current surface, density and option states
- Location: ui-migration/choices.browser.mjs:83:3

# Error details

```
Error: expect(received).toEqual(expected) // deep equality

- Expected  - 8
+ Received  + 8

@@ -5,51 +5,51 @@
      "kind": "svg",
      "paths": Array [
        "M779.3 196.6c-94.2-94.2-247.6-94.2-341.7 0l-261 260.8c-1.7 1.7-2.6 4-2.6 6.4s.9 4.7 2.6 6.4l36.9 36.9a9 9 0 0012.7 0l261-260.8c32.4-32.4 75.5-50.2 121.3-50.2s88.9 17.8 121.2 50.2c32.4 32.4 50.2 75.5 50.2 121.2 0 45.8-17.8 88.8-50.2 121.2l-266 265.9-43.1 43.1c-40.3 40.3-105.8 40.3-146.1 0-19.5-19.5-30.2-45.4-30.2-73s10.7-53.5 30.2-73l263.9-263.8c6.7-6.6 15.5-10.3 24.9-10.3h.1c9.4 0 18.1 3.7 24.7 10.3 6.7 6.7 10.3 15.5 10.3 24.9 0 9.3-3.7 18.1-10.3 24.7L372.4 653c-1.7 1.7-2.6 4-2.6 6.4s.9 4.7 2.6 6.4l36.9 36.9a9 9 0 0012.7 0l215.6-215.6c19.9-19.9 30.8-46.3 30.8-74.4s-11-54.6-30.8-74.4c-41.1-41.1-107.9-41-149 0L463 364 224.8 602.1A172.22 172.22 0 00174 724.8c0 46.3 18.1 89.8 50.8 122.5 33.9 33.8 78.3 50.7 122.7 50.7 44.4 0 88.8-16.9 122.6-50.7l309.2-309C824.8 492.7 850 432 850 367.5c.1-64.6-25.1-125.3-70.7-170.9z",
      ],
      "width": 19,
-     "x": 12,
+     "x": 31,
      "y": 21.6875,
    },
    Object {
      "color": "rgb(138, 138, 142)",
      "height": 19,
      "kind": "svg",
      "paths": Array [
        "M928 160H96c-17.7 0-32 14.3-32 32v640c0 17.7 14.3 32 32 32h832c17.7 0 32-14.3 32-32V192c0-17.7-14.3-32-32-32zm-40 632H136v-39.9l138.5-164.3 150.1 178L658.1 489 888 761.6V792zm0-129.8L664.2 396.8c-3.2-3.8-9-3.8-12.2 0L424.6 666.4l-144-170.7c-3.2-3.8-9-3.8-12.2 0L136 652.7V232h752v430.2zM304 456a88 88 0 100-176 88 88 0 000 176zm0-116c15.5 0 28 12.5 28 28s-12.5 28-28 28-28-12.5-28-28 12.5-28 28-28z",
      ],
      "width": 19,
-     "x": 12,
+     "x": 31,
      "y": 64.078125,
    },
    Object {
      "color": "rgb(138, 138, 142)",
      "height": 19,
      "kind": "svg",
      "paths": Array [
        "M516 673c0 4.4 3.4 8 7.5 8h185c4.1 0 7.5-3.6 7.5-8v-48c0-4.4-3.4-8-7.5-8h-185c-4.1 0-7.5 3.6-7.5 8v48zm-194.9 6.1l192-161c3.8-3.2 3.8-9.1 0-12.3l-192-160.9A7.95 7.95 0 00308 351v62.7c0 2.4 1 4.6 2.9 6.1L420.7 512l-109.8 92.2a8.1 8.1 0 00-2.9 6.1V673c0 6.8 7.9 10.5 13.1 6.1zM880 112H144c-17.7 0-32 14.3-32 32v736c0 17.7 14.3 32 32 32h736c17.7 0 32-14.3 32-32V144c0-17.7-14.3-32-32-32zm-40 728H184V184h656v656z",
      ],
      "width": 19,
-     "x": 12,
-     "y": 115.46875,
+     "x": 31,
+     "y": 126.46875,
    },
    Object {
      "color": "rgba(0, 0, 0, 0.25)",
      "height": 19,
      "kind": "svg",
      "paths": Array [
        "M848 359.3H627.7L825.8 109c4.1-5.3.4-13-6.3-13H436c-2.8 0-5.5 1.5-6.9 4L170 547.5c-3.1 5.3.7 12 6.9 12h174.4l-89.4 357.6c-1.9 7.8 7.5 13.3 13.3 7.7L853.5 373c5.2-4.9 1.7-13.7-5.5-13.7zM378.2 732.5l60.3-241H281.1l189.6-327.4h224.6L487 427.4h211L378.2 732.5z",
      ],
      "width": 19,
-     "x": 12,
-     "y": 157.859375,
+     "x": 31,
+     "y": 168.859375,
    },
    Object {
      "color": "rgb(138, 138, 142)",
      "height": 29.84375,
      "kind": "SPAN",
      "paths": Array [],
      "width": 19,
-     "x": 12,
-     "y": 194.828125,
+     "x": 31,
+     "y": 205.828125,
    },
  ]
```

# Page snapshot

```yaml
- main [ref=f2e4]:
  - status [ref=f2e5]: light
  - button "Switch theme" [ref=f2e6] [cursor=pointer]
  - region "Appearance sample" [ref=f2e8]:
    - generic [ref=f2e9]:
      - button "Add attachment" [expanded] [ref=f2e11] [cursor=pointer]
      - menu "Add attachment" [active] [ref=f2e16]:
        - menuitem "File" [ref=f2e17] [cursor=pointer]
        - menuitem "Image" [ref=f2e23] [cursor=pointer]
        - separator [ref=f2e29]
        - menuitem "Shell" [ref=f2e30] [cursor=pointer]
        - menuitem "Skill" [disabled] [ref=f2e36]
        - menuitem "Command" [ref=f2e42] [cursor=pointer]:
          - generic [ref=f2e44]: /
```

# Test source

```ts
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
  108 |       await shot(info, `${system}-${kind}-open`, surface);
  109 |       if (['attachment', 'access'].includes(kind)) {
  110 |         glyphs[system] = await surface.evaluate((el) => {
  111 |           const root = el.getBoundingClientRect();
  112 |           return [...el.querySelectorAll('svg, .fixture-command-icon')].map((icon) => {
  113 |             const r = icon.getBoundingClientRect();
  114 |             return { kind: icon.tagName, x: r.x - root.x, y: r.y - root.y, width: r.width, height: r.height, color: getComputedStyle(icon).color, paths: [...icon.querySelectorAll('path')].map((path) => path.getAttribute('d')) };
  115 |           });
  116 |         });
  117 |       }
  118 |       if (['popover', 'tooltip'].includes(kind)) {
  119 |         const arrow = page.locator(system === 'antd' ? '.sample-arrow:visible' : '.orbit-floating-arrow:visible');
  120 |         const box = await surface.boundingBox();
  121 |         const arrowBox = await arrow.boundingBox();
  122 |         const triggerBox = await region.getByRole('button').boundingBox();
  123 |         measurements[system].callout = {
  124 |           triggerOffset: { x: box.x - triggerBox.x, y: box.y - triggerBox.y - triggerBox.height },
  125 |           arrow: { x: arrowBox.x - box.x, y: arrowBox.y - box.y, width: arrowBox.width, height: arrowBox.height },
  126 |           shape: await arrow.evaluate((el) => ({ fill: getComputedStyle(el, '::before').backgroundColor, clipPath: getComputedStyle(el, '::before').clipPath })),
  127 |           filter: await page.locator(system === 'antd' ? '.sample-floating-root:visible' : '.orbit-callout-positioner:visible').evaluate((el) => getComputedStyle(el).filter),
  128 |         };
  129 |         const x = Math.max(0, box.x - 40), y = Math.max(0, box.y - 40);
  130 |         await info.attach(`${system}-${kind}-context`, { body: await page.screenshot({ animations: 'disabled', clip: { x, y, width: Math.min(box.width + 80, info.project.use.viewport.width - x), height: box.height + 80 } }), contentType: 'image/png' });
  131 |       }
  132 |     }
  133 |     await attach(info, 'appearance', measurements);
  134 |     if (Object.keys(glyphs).length) {
  135 |       await attach(info, 'menu-glyphs', glyphs);
> 136 |       expect(glyphs.orbit).toEqual(glyphs.antd);
      |                            ^ Error: expect(received).toEqual(expected) // deep equality
  137 |     }
  138 |     if (kind === 'attachment' && info.project.use.hasTouch) {
  139 |       // Only the task's explicit 17px text differs from the measured 14px.
  140 |       // Padding, row radii, separators, icon geometry and total height stay equal.
  141 |       const expected = structuredClone(measurements.antd);
  142 |       expected.popup.rows.forEach((row) => Object.assign(row, {
  143 |         fontSize: '17px',
  144 |         lineHeight: info.project.use.browserName === 'webkit' ? '26.714285px' : '26.7143px',
  145 |       }));
  146 |       expect(measurements.orbit).toEqual(expected);
  147 |     } else expect(measurements.orbit).toEqual(measurements.antd);
  148 |   });
  149 | }
  150 | 
  151 | test('empty, disabled, hover and focus choice surfaces match the existing states', async ({ page }, info) => {
  152 |   const measurements = {};
  153 |   for (const kind of ['expiry', 'search']) for (const state of ['disabled', 'empty', 'default']) {
  154 |     const values = {};
  155 |     for (const system of ['antd', 'orbit']) {
  156 |       await page.goto(`${fixture}?sample=${kind}&system=${system}&state=${state}`);
  157 |       await expect(page.getByTestId('theme')).toHaveText(info.project.use.colorScheme);
  158 |       const control = page.locator('.sample-choice');
  159 |       const input = page.getByRole('combobox', { name: 'Sample choice' });
  160 |       await page.mouse.move(0, 0);
  161 |       await page.getByTestId('neutral').focus();
  162 |       await settle(control);
  163 |       values[system] = { control: await measure(control, true) };
  164 |       if (state === 'disabled') {
  165 |         await expect(input).toBeDisabled();
  166 |         await shot(info, `${system}-${kind}-disabled`, control);
  167 |       } else if (state === 'empty') {
  168 |         await input.click();
  169 |         const surface = page.locator('.sample-surface:visible');
  170 |         await settle(surface);
  171 |         await expect(surface.getByText('No data', { exact: true }).and(surface.locator('div'))).toBeVisible();
  172 |         values[system].popup = await measure(surface);
  173 |         await shot(info, `${system}-${kind}-empty`, surface);
  174 |       } else {
  175 |         await control.hover();
  176 |         await settle(control);
  177 |         values[system].hover = await measure(control, true);
  178 |         await input.focus();
  179 |         await page.mouse.move(0, 0);
  180 |         await settle(control);
  181 |         values[system].focus = await measure(control, true);
  182 |         await shot(info, `${system}-${kind}-focus`, control);
  183 |       }
  184 |     }
  185 |     measurements[`${kind}-${state}`] = values;
  186 |   }
  187 |   await attach(info, 'choice-states', measurements);
  188 |   for (const values of Object.values(measurements)) expect(values.orbit).toEqual(values.antd);
  189 | });
  190 | 
  191 | test('menu arrows, disabled items, submenu, checkbox and focus return work', async ({ page }, info) => {
  192 |   const trigger = page.getByRole('button', { name: 'Session actions', exact: true });
  193 |   await trigger.focus();
  194 |   await page.keyboard.press('ArrowDown');
  195 |   const first = page.getByRole('menuitem', { name: 'Default model', exact: true });
  196 |   await expect(first).toBeFocused();
  197 |   await page.keyboard.press('ArrowDown');
  198 |   const provider = page.getByRole('menuitem', { name: 'Provider', exact: true });
  199 |   await expect(provider).toBeFocused();
  200 |   await page.keyboard.press('ArrowRight');
  201 |   await expect(page.getByRole('menuitem', { name: 'Codex', exact: true })).toBeFocused();
  202 |   await page.keyboard.press('Escape');
  203 |   await expect(provider).toBeFocused();
  204 |   await expect(page.getByRole('menu')).toHaveCount(1);
  205 |   await page.keyboard.press('ArrowRight');
  206 |   await expect(page.getByRole('menuitem', { name: 'Codex', exact: true })).toBeFocused();
  207 |   await page.keyboard.press('ArrowDown');
  208 |   await expect(page.getByRole('menuitem', { name: 'Claude', exact: true })).toBeFocused();
  209 |   await page.keyboard.press('Enter');
  210 |   await expect(page.getByRole('status', { name: 'Action', exact: true })).toHaveText('claude');
  211 |   await expect(trigger).toBeFocused();
  212 |   await trigger.click();
  213 |   const tag = page.getByRole('menuitemcheckbox', { name: 'Important tag' });
  214 |   await tag.click();
  215 |   await expect(tag).toHaveAttribute('aria-checked', 'true');
  216 |   await expect(page.getByRole('status', { name: 'Tag', exact: true })).toHaveText('true');
  217 |   await tag.press('Space');
  218 |   await expect(tag).toHaveAttribute('aria-checked', 'false');
  219 |   await page.keyboard.press('Escape');
  220 |   await expect(trigger).toBeFocused();
  221 |   await attach(info, 'keyboard-menu', { disabledSkipped: true, submenuOnlyEscape: true, selection: 'claude', checkboxStaysOpen: true, focusReturned: true });
  222 | });
  223 | 
  224 | test('touch or pointer menus dismiss outside, fit viewport and open a dialog with stable return focus', async ({ page }, info) => {
  225 |   const trigger = page.getByRole('button', { name: 'Add attachment', exact: true });
  226 |   await tap(page, info, trigger);
  227 |   const menu = page.getByRole('menu');
  228 |   const box = await menu.boundingBox();
  229 |   expect(box.x).toBeGreaterThanOrEqual(0);
  230 |   expect(box.x + box.width).toBeLessThanOrEqual(info.project.use.viewport.width);
  231 |   await tap(page, info, page.getByRole('menuitem', { name: 'Image', exact: true }));
  232 |   await expect(menu).not.toBeVisible();
  233 |   await expect(page.getByRole('status', { name: 'Action', exact: true })).toHaveText('image');
  234 |   await tap(page, info, trigger);
  235 |   await settle(menu);
  236 |   await outside(page, info);
```