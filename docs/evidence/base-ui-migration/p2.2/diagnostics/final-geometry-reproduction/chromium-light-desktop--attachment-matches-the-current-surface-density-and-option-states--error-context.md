# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: choices.browser.mjs >> attachment matches the current surface, density and option states
- Location: ui-migration/choices.browser.mjs:82:3

# Error details

```
Error: expect(received).toEqual(expected) // deep equality

- Expected  - 1
+ Received  + 1

@@ -46,10 +46,10 @@
    Object {
      "color": "rgb(31, 35, 41)",
      "height": 18.84375,
      "kind": "SPAN",
      "paths": Array [],
-     "width": 14,
+     "width": 12,
      "x": 16,
      "y": 147.578125,
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
  57  |     const result = { surface: metrics(el), rows: [...el.querySelectorAll('[role="menuitem"], [role="option"]')].map((row) => ({ label: row.textContent, ...metrics(row) })) };
  58  |     if (contents) {
  59  |       result.origin = { x: root.x, y: root.y };
  60  |       result.chips = [...el.querySelectorAll('.sample-chip, .orbit-multi-chip')].filter(visible).map(metrics);
  61  |       result.texts = [];
  62  |       const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  63  |       while (walker.nextNode()) {
  64  |         const node = walker.currentNode;
  65  |         if (!node.textContent.trim() || !visible(node.parentElement)) continue;
  66  |         const range = document.createRange(); range.selectNode(node);
  67  |         const r = range.getBoundingClientRect(), s = getComputedStyle(node.parentElement);
  68  |         if (!r.width || !r.height) continue;
  69  |         result.texts.push({ text: node.textContent, x: r.x - root.x, y: r.y - root.y, width: r.width, height: r.height,
  70  |           color: s.color, fontSize: s.fontSize, fontWeight: s.fontWeight });
  71  |       }
  72  |       result.icons = [...el.querySelectorAll('svg')].filter(visible).map((svg) => {
  73  |         const r = svg.getBoundingClientRect();
  74  |         return { x: r.x - root.x, y: r.y - root.y, width: r.width, height: r.height, color: getComputedStyle(svg).color, paths: [...svg.querySelectorAll('path')].map((path) => path.getAttribute('d')) };
  75  |       });
  76  |     }
  77  |     return result;
  78  |   }, contents);
  79  | }
  80  | 
  81  | for (const kind of ['attachment', 'access', 'expiry', 'account', 'search', 'popover', 'tooltip']) {
  82  |   test(`${kind} matches the current surface, density and option states`, async ({ page }, info) => {
  83  |     const measurements = {};
  84  |     const glyphs = {};
  85  |     for (const system of ['antd', 'orbit']) {
  86  |       await page.goto(`${fixture}?sample=${kind}&system=${system}`);
  87  |       await expect(page.getByTestId('theme')).toHaveText(info.project.use.colorScheme);
  88  |       const region = page.getByRole('region', { name: 'Appearance sample' });
  89  |       const choice = region.getByRole('combobox');
  90  |       if (['expiry', 'account', 'search'].includes(kind)) {
  91  |         await page.mouse.move(0, 0);
  92  |         await page.getByTestId('neutral').focus();
  93  |         await settle(page.locator('.sample-choice'));
  94  |         measurements[system] = { control: await measure(page.locator('.sample-choice'), true) };
  95  |         await shot(info, `${system}-${kind}-closed`, page.locator('.sample-choice'));
  96  |         await choice.click();
  97  |       } else if (kind === 'tooltip') {
  98  |         await region.getByRole('button').hover();
  99  |         await settle(region.getByRole('button'));
  100 |       }
  101 |       else await region.getByRole('button').click();
  102 |       const surface = page.locator('.sample-surface:visible');
  103 |       await settle(surface);
  104 |       if (kind !== 'tooltip') await page.mouse.move(0, 0);
  105 |       await settle(surface);
  106 |       measurements[system] = { ...measurements[system], popup: await measure(surface) };
  107 |       await shot(info, `${system}-${kind}-open`, surface);
  108 |       if (['attachment', 'access'].includes(kind)) {
  109 |         glyphs[system] = await surface.evaluate((el) => {
  110 |           const root = el.getBoundingClientRect();
  111 |           return [...el.querySelectorAll('svg, .fixture-command-icon')].map((icon) => {
  112 |             const r = icon.getBoundingClientRect();
  113 |             return { kind: icon.tagName, x: r.x - root.x, y: r.y - root.y, width: r.width, height: r.height, color: getComputedStyle(icon).color, paths: [...icon.querySelectorAll('path')].map((path) => path.getAttribute('d')) };
  114 |           });
  115 |         });
  116 |         if (kind === 'attachment' && system === 'orbit' && info.project.use.hasTouch) {
  117 |           expect(await surface.locator('.orbit-menu-label').first().evaluate((el) => el.getBoundingClientRect().x - el.closest('.orbit-menu').getBoundingClientRect().x)).toBe(66);
  118 |         }
  119 |       }
  120 |       if (['popover', 'tooltip'].includes(kind)) {
  121 |         const arrow = page.locator(system === 'antd' ? '.sample-arrow:visible' : '.orbit-floating-arrow:visible');
  122 |         const box = await surface.boundingBox();
  123 |         const arrowBox = await arrow.boundingBox();
  124 |         const triggerBox = await region.getByRole('button').boundingBox();
  125 |         measurements[system].callout = {
  126 |           triggerOffset: { x: box.x - triggerBox.x, y: box.y - triggerBox.y - triggerBox.height },
  127 |           arrow: { x: arrowBox.x - box.x, y: arrowBox.y - box.y, width: arrowBox.width, height: arrowBox.height },
  128 |           shape: await arrow.evaluate((el) => ({ fill: getComputedStyle(el, '::before').backgroundColor, clipPath: getComputedStyle(el, '::before').clipPath })),
  129 |           filter: await page.locator(system === 'antd' ? '.sample-floating-root:visible' : '.orbit-callout-positioner:visible').evaluate((el) => getComputedStyle(el).filter),
  130 |         };
  131 |         const x = Math.max(0, box.x - 40), y = Math.max(0, box.y - 40);
  132 |         await info.attach(`${system}-${kind}-context`, { body: await page.screenshot({ animations: 'disabled', clip: { x, y, width: Math.min(box.width + 80, info.project.use.viewport.width - x), height: box.height + 80 } }), contentType: 'image/png' });
  133 |       }
  134 |     }
  135 |     await attach(info, 'appearance', measurements);
  136 |     if (Object.keys(glyphs).length) {
  137 |       await attach(info, 'menu-glyphs', glyphs);
  138 |       if (kind === 'attachment' && info.project.use.hasTouch) {
  139 |         expect(glyphs.orbit.filter(({ kind }) => kind === 'svg').map(({ x, width, height }) => ({ x, width, height }))).toEqual(Array(4).fill({ x: 31, width: 19, height: 19 }));
  140 |         expect(glyphs.orbit.find(({ kind }) => kind === 'SPAN')).toMatchObject({ x: 31, width: 19 });
> 141 |       } else expect(glyphs.orbit).toEqual(glyphs.antd);
      |                                   ^ Error: expect(received).toEqual(expected) // deep equality
  142 |     }
  143 |     if (kind === 'attachment' && info.project.use.hasTouch) {
  144 |       // P0's original phone sample also measured 14px items: AntD's generated
  145 |       // selector overrides the existing 17px rule. The task explicitly requires
  146 |       // the confirmed 17px/42.4px/26px design. Retain both raw samples; assert the
  147 |       // requested differences exactly, and every other measured property unchanged.
  148 |       const expected = structuredClone(measurements.antd);
  149 |       expected.popup.surface.height = 40 + 5 * 42.390625;
  150 |       expected.popup.rows.forEach((row, i) => Object.assign(row, {
  151 |         fontSize: '17px', borderRadius: '0px', padding: '0px 0px 0px 31px',
  152 |         lineHeight: info.project.use.browserName === 'webkit' ? '26.714285px' : '26.7143px',
  153 |         y: 10 + i * 42.390625 + (i >= 2 ? 20 : 0),
  154 |       }));
  155 |       expect(measurements.orbit).toEqual(expected);
  156 |     } else expect(measurements.orbit).toEqual(measurements.antd);
  157 |   });
  158 | }
  159 | 
  160 | test('empty, disabled, hover and focus choice surfaces match the existing states', async ({ page }, info) => {
  161 |   const measurements = {};
  162 |   for (const kind of ['expiry', 'search']) for (const state of ['disabled', 'empty', 'default']) {
  163 |     const values = {};
  164 |     for (const system of ['antd', 'orbit']) {
  165 |       await page.goto(`${fixture}?sample=${kind}&system=${system}&state=${state}`);
  166 |       await expect(page.getByTestId('theme')).toHaveText(info.project.use.colorScheme);
  167 |       const control = page.locator('.sample-choice');
  168 |       const input = page.getByRole('combobox', { name: 'Sample choice' });
  169 |       await page.mouse.move(0, 0);
  170 |       await page.getByTestId('neutral').focus();
  171 |       await settle(control);
  172 |       values[system] = { control: await measure(control, true) };
  173 |       if (state === 'disabled') {
  174 |         await expect(input).toBeDisabled();
  175 |         await shot(info, `${system}-${kind}-disabled`, control);
  176 |       } else if (state === 'empty') {
  177 |         await input.click();
  178 |         const surface = page.locator('.sample-surface:visible');
  179 |         await settle(surface);
  180 |         await expect(surface.getByText('No data', { exact: true }).and(surface.locator('div'))).toBeVisible();
  181 |         values[system].popup = await measure(surface);
  182 |         await shot(info, `${system}-${kind}-empty`, surface);
  183 |       } else {
  184 |         await control.hover();
  185 |         await settle(control);
  186 |         values[system].hover = await measure(control, true);
  187 |         await input.focus();
  188 |         await page.mouse.move(0, 0);
  189 |         await settle(control);
  190 |         values[system].focus = await measure(control, true);
  191 |         await shot(info, `${system}-${kind}-focus`, control);
  192 |       }
  193 |     }
  194 |     measurements[`${kind}-${state}`] = values;
  195 |   }
  196 |   await attach(info, 'choice-states', measurements);
  197 |   for (const values of Object.values(measurements)) expect(values.orbit).toEqual(values.antd);
  198 | });
  199 | 
  200 | test('menu arrows, disabled items, submenu, checkbox and focus return work', async ({ page }, info) => {
  201 |   const trigger = page.getByRole('button', { name: 'Session actions', exact: true });
  202 |   await trigger.focus();
  203 |   await page.keyboard.press('ArrowDown');
  204 |   const first = page.getByRole('menuitem', { name: 'Default model', exact: true });
  205 |   await expect(first).toBeFocused();
  206 |   await page.keyboard.press('ArrowDown');
  207 |   const provider = page.getByRole('menuitem', { name: 'Provider', exact: true });
  208 |   await expect(provider).toBeFocused();
  209 |   await page.keyboard.press('ArrowRight');
  210 |   await expect(page.getByRole('menuitem', { name: 'Codex', exact: true })).toBeFocused();
  211 |   await page.keyboard.press('Escape');
  212 |   await expect(provider).toBeFocused();
  213 |   await expect(page.getByRole('menu')).toHaveCount(1);
  214 |   await page.keyboard.press('ArrowRight');
  215 |   await page.keyboard.press('ArrowDown');
  216 |   await page.keyboard.press('Enter');
  217 |   await expect(page.getByRole('status', { name: 'Action', exact: true })).toHaveText('claude');
  218 |   await expect(trigger).toBeFocused();
  219 |   await trigger.click();
  220 |   const tag = page.getByRole('menuitemcheckbox', { name: 'Important tag' });
  221 |   await tag.click();
  222 |   await expect(tag).toHaveAttribute('aria-checked', 'true');
  223 |   await expect(page.getByRole('status', { name: 'Tag', exact: true })).toHaveText('true');
  224 |   await tag.press('Space');
  225 |   await expect(tag).toHaveAttribute('aria-checked', 'false');
  226 |   await page.keyboard.press('Escape');
  227 |   await expect(trigger).toBeFocused();
  228 |   await attach(info, 'keyboard-menu', { disabledSkipped: true, submenuOnlyEscape: true, selection: 'claude', checkboxStaysOpen: true, focusReturned: true });
  229 | });
  230 | 
  231 | test('touch or pointer menus dismiss outside, fit viewport and open a dialog with stable return focus', async ({ page }, info) => {
  232 |   const trigger = page.getByRole('button', { name: 'Add attachment', exact: true });
  233 |   await tap(page, info, trigger);
  234 |   const menu = page.getByRole('menu');
  235 |   const box = await menu.boundingBox();
  236 |   expect(box.x).toBeGreaterThanOrEqual(0);
  237 |   expect(box.x + box.width).toBeLessThanOrEqual(info.project.use.viewport.width);
  238 |   await tap(page, info, page.getByRole('menuitem', { name: 'Image', exact: true }));
  239 |   await expect(menu).not.toBeVisible();
  240 |   await expect(page.getByRole('status', { name: 'Action', exact: true })).toHaveText('image');
  241 |   await tap(page, info, trigger);
```