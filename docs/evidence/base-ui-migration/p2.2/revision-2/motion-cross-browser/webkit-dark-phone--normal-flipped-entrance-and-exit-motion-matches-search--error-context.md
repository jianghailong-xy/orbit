# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: choices-motion.browser.mjs >> normal flipped entrance and exit motion matches search
- Location: ui-migration/choices-motion.browser.mjs:80:3

# Error details

```
Test timeout of 90000ms exceeded.
```

```
Error: page.waitForFunction: Test timeout of 90000ms exceeded.
```

# Page snapshot

```yaml
- generic [ref=f1e1]:
  - main [ref=f1e4]:
    - status [aria-hidden] [ref=f1e5]: dark
    - button [aria-hidden] [ref=f1e6] [cursor=pointer]:
      - generic [ref=f1e7]: Switch theme
    - region "Appearance sample" [ref=f1e8]:
      - generic [ref=f1e9]:
        - generic [ref=f1e10]:
          - generic [aria-hidden]: Never
          - button "Dismiss" [ref=f1e11]
          - combobox "Sample choice" [expanded] [active] [ref=f1e12]
          - button [aria-hidden] [ref=f1e13] [cursor=pointer]
        - textbox [aria-hidden] [ref=f1e17]: never
  - generic:
    - generic [ref=f1e18]:
      - status
      - listbox [ref=f1e19]:
        - option "Never" [selected] [ref=f1e20] [cursor=pointer]
        - option "7 days" [ref=f1e22] [cursor=pointer]
        - option "30 days" [disabled] [ref=f1e24]
    - button "Dismiss" [ref=f1e26]
```

# Test source

```ts
  1   | import { test, expect } from '@playwright/test';
  2   | 
  3   | const fixture = '/ui-migration/choices.html';
  4   | const surface = '.sample-surface';
  5   | const errors = new WeakMap();
  6   | test.beforeEach(async ({ page }) => {
  7   |   errors.set(page, []);
  8   |   page.on('pageerror', (error) => errors.get(page).push(error.message));
  9   | });
  10  | test.afterEach(async ({ page }) => { expect(errors.get(page)).toEqual([]); });
  11  | 
  12  | async function arm(page, selector = surface, midpoint = false) {
  13  |   await page.evaluate(({ selector, midpoint }) => {
  14  |     const state = { records: [], active: true, animations: new Set() };
  15  |     window.choiceMotion = state;
  16  |     const frame = () => {
  17  |       for (const animation of document.getAnimations()) {
  18  |         const node = animation.effect?.target;
  19  |         if (animation.constructor.name !== 'CSSAnimation' || animation.playState === 'finished'
  20  |           || !node || !(node.matches(selector) || node.querySelector(selector)) || state.animations.has(animation)) continue;
  21  |         state.animations.add(animation);
  22  |         const style = getComputedStyle(node);
  23  |         if (midpoint) {
  24  |           animation.pause();
  25  |           animation.currentTime = animation.effect.getTiming().duration / 2;
  26  |         }
  27  |         state.records.push({ name: animation.animationName, duration: animation.effect.getTiming().duration,
  28  |           frames: animation.effect.getKeyframes(), origin: style.transformOrigin, filter: style.filter,
  29  |           side: node.getAttribute('data-side'), opacity: style.opacity, samples: [] });
  30  |       }
  31  |       for (const [index, animation] of [...state.animations].entries()) {
  32  |         if (animation.playState === 'finished') continue;
  33  |         const node = animation.effect.target;
  34  |         const box = node.getBoundingClientRect();
  35  |         state.records[index].samples.push({ time: animation.currentTime, opacity: getComputedStyle(node).opacity,
  36  |           connected: node.isConnected, box: { x: box.x, y: box.y, right: box.right, bottom: box.bottom, width: box.width, height: box.height } });
  37  |       }
  38  |       if (state.active) requestAnimationFrame(frame);
  39  |     };
  40  |     requestAnimationFrame(frame);
  41  |   }, { selector, midpoint });
  42  | }
  43  | 
  44  | async function resumeAfterShot(page, info, name) {
  45  |   await page.waitForFunction(() => window.choiceMotion.records.length > 0);
  46  |   await info.attach(name, { body: await page.screenshot({ animations: 'allow' }), contentType: 'image/png' });
  47  |   await page.evaluate(() => { for (const animation of window.choiceMotion.animations) animation.play(); });
  48  | }
  49  | 
  50  | async function capture(page) {
> 51  |   await page.waitForFunction(() => window.choiceMotion.records.length > 0);
      |              ^ Error: page.waitForFunction: Test timeout of 90000ms exceeded.
  52  |   return page.evaluate(async () => {
  53  |     const state = window.choiceMotion;
  54  |     await Promise.all([...state.animations].map((animation) => animation.finished.catch(() => {})));
  55  |     state.active = false;
  56  |     return state.records;
  57  |   });
  58  | }
  59  | 
  60  | async function open(page, kind) {
  61  |   const region = page.getByRole('region', { name: 'Appearance sample' });
  62  |   if (['expiry', 'search', 'multiple'].includes(kind)) await region.getByRole('combobox').click();
  63  |   else if (kind === 'tooltip') await region.getByRole('button').hover();
  64  |   else await region.getByRole('button').click();
  65  | }
  66  | 
  67  | function compare(samples) {
  68  |   for (const phase of ['enter', 'exit']) {
  69  |     expect(samples.orbit[phase].map(({ duration, frames, origin, filter }) => ({ duration, frames, origin, filter })))
  70  |       .toEqual(samples.antd[phase].map(({ duration, frames, origin, filter }) => ({ duration, frames, origin, filter })));
  71  |   }
  72  | }
  73  | 
  74  | const directions = [
  75  |   { name: 'bottom', query: '', side: 'bottom' },
  76  |   { name: 'top', query: '&side=top&anchor=bottom', side: 'top' },
  77  |   { name: 'flipped', query: '&anchor=bottom', side: 'top' },
  78  | ];
  79  | for (const kind of ['attachment', 'expiry', 'search', 'multiple', 'popover', 'tooltip']) for (const direction of directions) {
  80  |   test(`normal ${direction.name} entrance and exit motion matches ${kind}`, async ({ page }, info) => {
  81  |     await page.emulateMedia({ reducedMotion: 'no-preference' });
  82  |     const samples = {};
  83  |     for (const system of ['antd', 'orbit']) {
  84  |       await page.goto(`${fixture}?sample=${kind}&system=${system}${direction.query}`);
  85  |       await page.evaluate(() => document.fonts.ready);
  86  |       await arm(page, surface, direction.name === 'bottom');
  87  |       await open(page, kind);
  88  |       await expect(page.locator(`${surface}:visible`)).toBeVisible();
  89  |       if (direction.name === 'bottom') await resumeAfterShot(page, info, `${system}-enter-midpoint`);
  90  |       samples[system] = { enter: await capture(page) };
  91  |       if (system === 'orbit') await expect(page.locator(surface)).toHaveAttribute('data-side', direction.side);
  92  |       await arm(page, surface, direction.name === 'bottom');
  93  |       if (kind === 'tooltip') await page.mouse.move(0, 0);
  94  |       else await page.mouse.click(3, 60);
  95  |       if (direction.name === 'bottom') await resumeAfterShot(page, info, `${system}-exit-midpoint`);
  96  |       samples[system].exit = await capture(page);
  97  |       await expect(page.locator(`${surface}:visible`)).toHaveCount(0);
  98  |     }
  99  |     await info.attach('motion', { body: JSON.stringify(samples, null, 2), contentType: 'application/json' });
  100 |     compare(samples);
  101 |     if (direction.name === 'bottom') for (const phase of ['enter', 'exit']) {
  102 |       const midpoint = ({ time, opacity, box }) => ({ time, opacity, box });
  103 |       expect(midpoint(samples.orbit[phase][0].samples[0])).toEqual(midpoint(samples.antd[phase][0].samples[0]));
  104 |     }
  105 |     const viewport = page.viewportSize();
  106 |     for (const phase of ['enter', 'exit']) for (const record of samples.orbit[phase]) for (const frame of record.samples) {
  107 |       expect(frame.connected).toBe(true);
  108 |       expect(frame.box.x).toBeGreaterThanOrEqual(0);
  109 |       expect(frame.box.y).toBeGreaterThanOrEqual(0);
  110 |       expect(frame.box.right).toBeLessThanOrEqual(viewport.width);
  111 |       expect(frame.box.bottom).toBeLessThanOrEqual(viewport.height);
  112 |     }
  113 |   });
  114 | }
  115 | 
  116 | for (const kind of ['popover', 'tooltip']) for (const align of ['center', 'end']) test(`${kind} ${align} zoom origin matches`, async ({ page }, info) => {
  117 |   await page.emulateMedia({ reducedMotion: 'no-preference' });
  118 |   const samples = {};
  119 |   for (const system of ['antd', 'orbit']) {
  120 |     await page.goto(`${fixture}?sample=${kind}&system=${system}&align=${align}&anchor=${align === 'end' ? 'right' : 'center'}`);
  121 |     await page.evaluate(() => document.fonts.ready);
  122 |     await arm(page);
  123 |     await open(page, kind);
  124 |     samples[system] = { enter: await capture(page) };
  125 |     await arm(page);
  126 |     if (kind === 'tooltip') await page.mouse.move(0, 0);
  127 |     else await page.mouse.click(3, 60);
  128 |     samples[system].exit = await capture(page);
  129 |     await expect(page.locator(`${surface}:visible`)).toHaveCount(0);
  130 |   }
  131 |   await info.attach('motion', { body: JSON.stringify(samples, null, 2), contentType: 'application/json' });
  132 |   compare(samples);
  133 | });
  134 | 
  135 | for (const anchor of ['left', 'right']) test(`submenu ${anchor} edge zoom matches and stays in view`, async ({ page }, info) => {
  136 |   await page.emulateMedia({ reducedMotion: 'no-preference' });
  137 |   const samples = {};
  138 |   for (const system of ['antd', 'orbit']) {
  139 |     await page.goto(`${fixture}?sample=submenu&system=${system}&anchor=${anchor}`);
  140 |     await page.evaluate(() => document.fonts.ready);
  141 |     await arm(page);
  142 |     await open(page, 'submenu');
  143 |     await capture(page);
  144 |     const selector = system === 'antd' ? '.sample-submenu' : '.orbit-menu[data-nested]';
  145 |     await arm(page, selector);
  146 |     await page.getByRole('menuitem', { name: 'Provider' }).hover();
  147 |     await expect(page.getByRole('menuitem', { name: 'Codex' })).toBeVisible();
  148 |     samples[system] = { enter: await capture(page) };
  149 |     if (system === 'orbit') {
  150 |       const box = await page.locator(selector).boundingBox();
  151 |       expect(box.x).toBeGreaterThanOrEqual(0);
```