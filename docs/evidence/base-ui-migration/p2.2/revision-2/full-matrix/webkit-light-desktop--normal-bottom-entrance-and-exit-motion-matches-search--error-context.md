# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: choices-motion.browser.mjs >> normal bottom entrance and exit motion matches search
- Location: ui-migration/choices-motion.browser.mjs:100:3

# Error details

```
Test timeout of 90000ms exceeded.
```

```
Error: page.evaluate: Test timeout of 90000ms exceeded.
```

# Page snapshot

```yaml
- main [ref=f1e4]:
  - status [ref=f1e5]: light
  - button "Switch theme" [ref=f1e6] [cursor=pointer]
  - region "Appearance sample" [ref=f1e8]:
    - generic [ref=f1e9]:
      - generic [ref=f1e10]:
        - generic: Never
        - combobox "Sample choice" [ref=f1e11]
        - button "Show options" [ref=f1e12] [cursor=pointer]
        - button "Clear selection" [ref=f1e16] [cursor=pointer]
      - textbox [aria-hidden] [ref=f1e20]: never
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
  10  | test.afterEach(async ({ page }, info) => {
  11  |   if (info.status !== info.expectedStatus) await info.attach('motion-diagnostic', {
  12  |     body: JSON.stringify(await page.evaluate(() => ({ url: location.href, reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
  13  |       records: window.choiceMotion?.records, observations: window.choiceMotion?.observations })), null, 2), contentType: 'application/json',
  14  |   });
  15  |   expect(errors.get(page)).toEqual([]);
  16  | });
  17  | 
  18  | async function arm(page, selector = surface, midpoint = false) {
  19  |   await page.evaluate(({ selector, midpoint }) => {
  20  |     const state = { records: [], observations: [], active: true, animations: new Set() };
  21  |     window.choiceMotion = state;
  22  |     const sample = () => {
  23  |       if (state.observations.length < 32 && document.querySelector(selector)) state.observations.push({
  24  |         nodes: [...document.querySelectorAll(selector)].map((node) => ({ attributes: Object.fromEntries([...node.attributes].map((a) => [a.name, a.value])),
  25  |           animation: getComputedStyle(node).animationName, display: getComputedStyle(node).display, opacity: getComputedStyle(node).opacity })),
  26  |         animations: document.getAnimations().map((animation) => ({ name: animation.animationName, constructor: animation.constructor.name,
  27  |           target: animation.effect?.target?.className, state: animation.playState, time: animation.currentTime })),
  28  |       });
  29  |       for (const animation of document.getAnimations()) {
  30  |         const node = animation.effect?.target;
  31  |         if (animation.constructor.name !== 'CSSAnimation' || animation.playState === 'finished'
  32  |           || !node || !(node.matches(selector) || node.querySelector(selector)) || state.animations.has(animation)) continue;
  33  |         state.animations.add(animation);
  34  |         const style = getComputedStyle(node);
  35  |         if (midpoint) {
  36  |           animation.pause();
  37  |           animation.currentTime = animation.effect.getTiming().duration / 2;
  38  |         }
  39  |         state.records.push({ name: animation.animationName, duration: animation.effect.getTiming().duration,
  40  |           frames: animation.effect.getKeyframes(), origin: style.transformOrigin, filter: style.filter,
  41  |           side: node.getAttribute('data-side'), opacity: style.opacity, samples: [] });
  42  |       }
  43  |       for (const [index, animation] of [...state.animations].entries()) {
  44  |         if (animation.playState === 'finished') continue;
  45  |         const node = animation.effect.target;
  46  |         const box = node.getBoundingClientRect();
  47  |         state.records[index].samples.push({ time: animation.currentTime, opacity: getComputedStyle(node).opacity,
  48  |           connected: node.isConnected, box: { x: box.x, y: box.y, right: box.right, bottom: box.bottom, width: box.width, height: box.height } });
  49  |       }
  50  |     };
  51  |     // Capture registration as well as painted frames. A frame-only observer can
  52  |     // miss a short WebKit animation while a navigation/interaction is settling.
  53  |     state.started = sample;
  54  |     document.addEventListener('animationstart', state.started, true);
  55  |     const frame = () => {
  56  |       sample();
  57  |       if (state.active) requestAnimationFrame(frame);
  58  |     };
  59  |     requestAnimationFrame(frame);
  60  |   }, { selector, midpoint });
  61  | }
  62  | 
  63  | async function resumeAfterShot(page, info, name) {
  64  |   await page.waitForFunction(() => window.choiceMotion.records.length > 0);
  65  |   await info.attach(name, { body: await page.screenshot({ animations: 'allow' }), contentType: 'image/png' });
  66  |   await page.evaluate(() => { for (const animation of window.choiceMotion.animations) animation.play(); });
  67  | }
  68  | 
  69  | async function capture(page) {
  70  |   await page.waitForFunction(() => window.choiceMotion.records.length > 0);
> 71  |   return page.evaluate(async () => {
      |               ^ Error: page.evaluate: Test timeout of 90000ms exceeded.
  72  |     const state = window.choiceMotion;
  73  |     await Promise.all([...state.animations].map((animation) => animation.finished.catch(() => {})));
  74  |     state.active = false;
  75  |     document.removeEventListener('animationstart', state.started, true);
  76  |     return state.records;
  77  |   });
  78  | }
  79  | 
  80  | async function open(page, kind) {
  81  |   const region = page.getByRole('region', { name: 'Appearance sample' });
  82  |   if (['expiry', 'search', 'multiple'].includes(kind)) await region.getByRole('combobox').click();
  83  |   else if (kind === 'tooltip') await region.getByRole('button').hover();
  84  |   else await region.getByRole('button').click();
  85  | }
  86  | 
  87  | function compare(samples) {
  88  |   for (const phase of ['enter', 'exit']) {
  89  |     expect(samples.orbit[phase].map(({ duration, frames, origin, filter }) => ({ duration, frames, origin, filter })))
  90  |       .toEqual(samples.antd[phase].map(({ duration, frames, origin, filter }) => ({ duration, frames, origin, filter })));
  91  |   }
  92  | }
  93  | 
  94  | const directions = [
  95  |   { name: 'bottom', query: '', side: 'bottom' },
  96  |   { name: 'top', query: '&side=top&anchor=bottom', side: 'top' },
  97  |   { name: 'flipped', query: '&anchor=bottom', side: 'top' },
  98  | ];
  99  | for (const kind of ['attachment', 'expiry', 'search', 'multiple', 'popover', 'tooltip']) for (const direction of directions) {
  100 |   test(`normal ${direction.name} entrance and exit motion matches ${kind}`, async ({ page }, info) => {
  101 |     await page.emulateMedia({ reducedMotion: 'no-preference' });
  102 |     const samples = {};
  103 |     for (const system of ['antd', 'orbit']) {
  104 |       await page.goto(`${fixture}?sample=${kind}&system=${system}${direction.query}`);
  105 |       await page.evaluate(() => document.fonts.ready);
  106 |       await arm(page, surface, direction.name === 'bottom');
  107 |       await open(page, kind);
  108 |       await expect(page.locator(`${surface}:visible`)).toBeVisible();
  109 |       if (direction.name === 'bottom') await resumeAfterShot(page, info, `${system}-enter-midpoint`);
  110 |       samples[system] = { enter: await capture(page) };
  111 |       if (system === 'orbit') await expect(page.locator(surface)).toHaveAttribute('data-side', direction.side);
  112 |       await arm(page, surface, direction.name === 'bottom');
  113 |       if (kind === 'tooltip') await page.mouse.move(0, 0);
  114 |       else await page.mouse.click(3, 60);
  115 |       if (direction.name === 'bottom') await resumeAfterShot(page, info, `${system}-exit-midpoint`);
  116 |       samples[system].exit = await capture(page);
  117 |       await expect(page.locator(`${surface}:visible`)).toHaveCount(0);
  118 |     }
  119 |     await info.attach('motion', { body: JSON.stringify(samples, null, 2), contentType: 'application/json' });
  120 |     compare(samples);
  121 |     if (direction.name === 'bottom') for (const phase of ['enter', 'exit']) {
  122 |       const midpoint = ({ time, opacity, box }) => ({ time, opacity, box });
  123 |       expect(midpoint(samples.orbit[phase][0].samples[0])).toEqual(midpoint(samples.antd[phase][0].samples[0]));
  124 |     }
  125 |     const viewport = page.viewportSize();
  126 |     for (const phase of ['enter', 'exit']) for (const record of samples.orbit[phase]) for (const frame of record.samples) {
  127 |       expect(frame.connected).toBe(true);
  128 |       expect(frame.box.x).toBeGreaterThanOrEqual(0);
  129 |       expect(frame.box.y).toBeGreaterThanOrEqual(0);
  130 |       expect(frame.box.right).toBeLessThanOrEqual(viewport.width);
  131 |       expect(frame.box.bottom).toBeLessThanOrEqual(viewport.height);
  132 |     }
  133 |   });
  134 | }
  135 | 
  136 | for (const kind of ['popover', 'tooltip']) for (const align of ['center', 'end']) test(`${kind} ${align} zoom origin matches`, async ({ page }, info) => {
  137 |   await page.emulateMedia({ reducedMotion: 'no-preference' });
  138 |   const samples = {};
  139 |   for (const system of ['antd', 'orbit']) {
  140 |     await page.goto(`${fixture}?sample=${kind}&system=${system}&align=${align}&anchor=${align === 'end' ? 'right' : 'center'}`);
  141 |     await page.evaluate(() => document.fonts.ready);
  142 |     await arm(page);
  143 |     await open(page, kind);
  144 |     samples[system] = { enter: await capture(page) };
  145 |     await arm(page);
  146 |     if (kind === 'tooltip') await page.mouse.move(0, 0);
  147 |     else await page.mouse.click(3, 60);
  148 |     samples[system].exit = await capture(page);
  149 |     await expect(page.locator(`${surface}:visible`)).toHaveCount(0);
  150 |   }
  151 |   await info.attach('motion', { body: JSON.stringify(samples, null, 2), contentType: 'application/json' });
  152 |   compare(samples);
  153 | });
  154 | 
  155 | for (const anchor of ['left', 'right']) test(`submenu ${anchor} edge zoom matches and stays in view`, async ({ page }, info) => {
  156 |   await page.emulateMedia({ reducedMotion: 'no-preference' });
  157 |   const samples = {};
  158 |   for (const system of ['antd', 'orbit']) {
  159 |     await page.goto(`${fixture}?sample=submenu&system=${system}&anchor=${anchor}`);
  160 |     await page.evaluate(() => document.fonts.ready);
  161 |     await arm(page);
  162 |     await open(page, 'submenu');
  163 |     await capture(page);
  164 |     const selector = system === 'antd' ? '.sample-submenu' : '.orbit-menu[data-nested]';
  165 |     await arm(page, selector);
  166 |     await page.getByRole('menuitem', { name: 'Provider' }).hover();
  167 |     await expect(page.getByRole('menuitem', { name: 'Codex' })).toBeVisible();
  168 |     samples[system] = { enter: await capture(page) };
  169 |     if (system === 'orbit') {
  170 |       const box = await page.locator(selector).boundingBox();
  171 |       expect(box.x).toBeGreaterThanOrEqual(0);
```