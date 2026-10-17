# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: choices-motion.browser.mjs >> normal flipped entrance and exit motion matches attachment
- Location: ui-migration/choices-motion.browser.mjs:104:3

# Error details

```
Test timeout of 90000ms exceeded.
```

```
Error: page.waitForFunction: Test timeout of 90000ms exceeded.
```

# Page snapshot

```yaml
- main [ref=f1e4]:
  - status [ref=f1e5]: dark
  - button "Switch theme" [ref=f1e6] [cursor=pointer]
  - region "Appearance sample" [ref=f1e8]:
    - generic [ref=f1e9]:
      - button "Add attachment" [expanded] [ref=f1e11] [cursor=pointer]
      - menu "Add attachment" [active] [ref=f1e16]:
        - menuitem "File" [ref=f1e17] [cursor=pointer]
        - menuitem "Image" [ref=f1e23] [cursor=pointer]
        - separator [ref=f1e29]
        - menuitem "Shell" [ref=f1e30] [cursor=pointer]
        - menuitem "Skill" [disabled] [ref=f1e36]
        - menuitem "Command" [ref=f1e42] [cursor=pointer]:
          - generic [ref=f1e44]: /
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
  44  |         if (animation.playState === 'finished' || animation.playState === 'idle') continue;
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
> 70  |   await page.waitForFunction(() => window.choiceMotion.records.length > 0);
      |              ^ Error: page.waitForFunction: Test timeout of 90000ms exceeded.
  71  |   // Unmount can cancel a CSSAnimation. Reading its newly replaced `finished`
  72  |   // promise afterward can wait indefinitely; observe its terminal state instead.
  73  |   await page.waitForFunction(() => [...window.choiceMotion.animations].every((animation) =>
  74  |     animation.playState === 'finished' || animation.playState === 'idle'));
  75  |   return page.evaluate(() => {
  76  |     const state = window.choiceMotion;
  77  |     state.active = false;
  78  |     document.removeEventListener('animationstart', state.started, true);
  79  |     [...state.animations].forEach((animation, index) => { state.records[index].endState = animation.playState; });
  80  |     return state.records;
  81  |   });
  82  | }
  83  | 
  84  | async function open(page, kind) {
  85  |   const region = page.getByRole('region', { name: 'Appearance sample' });
  86  |   if (['expiry', 'search', 'multiple'].includes(kind)) await region.getByRole('combobox').click();
  87  |   else if (kind === 'tooltip') await region.getByRole('button').hover();
  88  |   else await region.getByRole('button').click();
  89  | }
  90  | 
  91  | function compare(samples) {
  92  |   for (const phase of ['enter', 'exit']) {
  93  |     expect(samples.orbit[phase].map(({ duration, frames, origin, filter }) => ({ duration, frames, origin, filter })))
  94  |       .toEqual(samples.antd[phase].map(({ duration, frames, origin, filter }) => ({ duration, frames, origin, filter })));
  95  |   }
  96  | }
  97  | 
  98  | const directions = [
  99  |   { name: 'bottom', query: '', side: 'bottom' },
  100 |   { name: 'top', query: '&side=top&anchor=bottom', side: 'top' },
  101 |   { name: 'flipped', query: '&anchor=bottom', side: 'top' },
  102 | ];
  103 | for (const kind of ['attachment', 'expiry', 'search', 'multiple', 'popover', 'tooltip']) for (const direction of directions) {
  104 |   test(`normal ${direction.name} entrance and exit motion matches ${kind}`, async ({ page }, info) => {
  105 |     await page.emulateMedia({ reducedMotion: 'no-preference' });
  106 |     const samples = {};
  107 |     for (const system of ['antd', 'orbit']) {
  108 |       await page.goto(`${fixture}?sample=${kind}&system=${system}${direction.query}`);
  109 |       await page.evaluate(() => document.fonts.ready);
  110 |       await arm(page, surface, direction.name === 'bottom');
  111 |       await open(page, kind);
  112 |       await expect(page.locator(`${surface}:visible`)).toBeVisible();
  113 |       if (direction.name === 'bottom') await resumeAfterShot(page, info, `${system}-enter-midpoint`);
  114 |       samples[system] = { enter: await capture(page) };
  115 |       await expect(page.locator(`${surface}:visible`)).toBeVisible();
  116 |       if (system === 'orbit') await expect(page.locator(surface)).toHaveAttribute('data-side', direction.side);
  117 |       await arm(page, surface, direction.name === 'bottom');
  118 |       if (kind === 'tooltip') await page.mouse.move(0, 0);
  119 |       else await page.mouse.click(3, 60);
  120 |       if (direction.name === 'bottom') await resumeAfterShot(page, info, `${system}-exit-midpoint`);
  121 |       samples[system].exit = await capture(page);
  122 |       await expect(page.locator(`${surface}:visible`)).toHaveCount(0);
  123 |     }
  124 |     await info.attach('motion', { body: JSON.stringify(samples, null, 2), contentType: 'application/json' });
  125 |     compare(samples);
  126 |     if (direction.name === 'bottom') for (const phase of ['enter', 'exit']) {
  127 |       const midpoint = ({ time, opacity, box }) => ({ time, opacity, box });
  128 |       expect(midpoint(samples.orbit[phase][0].samples[0])).toEqual(midpoint(samples.antd[phase][0].samples[0]));
  129 |     }
  130 |     const viewport = page.viewportSize();
  131 |     for (const phase of ['enter', 'exit']) for (const record of samples.orbit[phase]) for (const frame of record.samples) {
  132 |       expect(frame.connected).toBe(true);
  133 |       expect(frame.box.x).toBeGreaterThanOrEqual(0);
  134 |       expect(frame.box.y).toBeGreaterThanOrEqual(0);
  135 |       expect(frame.box.right).toBeLessThanOrEqual(viewport.width);
  136 |       expect(frame.box.bottom).toBeLessThanOrEqual(viewport.height);
  137 |     }
  138 |   });
  139 | }
  140 | 
  141 | for (const kind of ['popover', 'tooltip']) for (const align of ['center', 'end']) test(`${kind} ${align} zoom origin matches`, async ({ page }, info) => {
  142 |   await page.emulateMedia({ reducedMotion: 'no-preference' });
  143 |   const samples = {};
  144 |   for (const system of ['antd', 'orbit']) {
  145 |     await page.goto(`${fixture}?sample=${kind}&system=${system}&align=${align}&anchor=${align === 'end' ? 'right' : 'center'}`);
  146 |     await page.evaluate(() => document.fonts.ready);
  147 |     await arm(page);
  148 |     await open(page, kind);
  149 |     samples[system] = { enter: await capture(page) };
  150 |     await arm(page);
  151 |     if (kind === 'tooltip') await page.mouse.move(0, 0);
  152 |     else await page.mouse.click(3, 60);
  153 |     samples[system].exit = await capture(page);
  154 |     await expect(page.locator(`${surface}:visible`)).toHaveCount(0);
  155 |   }
  156 |   await info.attach('motion', { body: JSON.stringify(samples, null, 2), contentType: 'application/json' });
  157 |   compare(samples);
  158 | });
  159 | 
  160 | for (const anchor of ['left', 'right']) test(`submenu ${anchor} edge zoom matches and stays in view`, async ({ page }, info) => {
  161 |   await page.emulateMedia({ reducedMotion: 'no-preference' });
  162 |   const samples = {};
  163 |   for (const system of ['antd', 'orbit']) {
  164 |     await page.goto(`${fixture}?sample=submenu&system=${system}&anchor=${anchor}`);
  165 |     await page.evaluate(() => document.fonts.ready);
  166 |     await arm(page);
  167 |     await open(page, 'submenu');
  168 |     await capture(page);
  169 |     const selector = system === 'antd' ? '.sample-submenu' : '.orbit-menu[data-nested]';
  170 |     await arm(page, selector);
```