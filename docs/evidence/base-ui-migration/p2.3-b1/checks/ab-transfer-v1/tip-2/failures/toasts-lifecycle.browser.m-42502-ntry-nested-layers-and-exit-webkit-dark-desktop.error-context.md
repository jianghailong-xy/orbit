# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: toasts-lifecycle.browser.mjs >> notification card stays fixed through Bottom drawer entry, nested layers and exit
- Location: ui-migration/toasts-lifecycle.browser.mjs:96:3

# Error details

```
Error: page.evaluate: Test ended.
```

# Test source

```ts
  1   | import { test, expect } from '@playwright/test';
  2   | import { expectExpired } from './toasts-checks.mjs';
  3   | 
  4   | const button = (page, name) => page.getByRole('button', { name, exact: true });
  5   | test.beforeEach(async ({ page }) => {
  6   |   await page.goto('/ui-migration/toasts.html');
  7   |   await page.evaluate(() => document.fonts.ready);
  8   | });
  9   | 
  10  | for (const kind of ['Dialog', 'Drawer', 'Bottom drawer']) {
  11  |   test(`existing notification stays at viewport origin during ${kind} entry`, async ({ page }, info) => {
  12  |     await page.emulateMedia({ reducedMotion: 'no-preference' });
  13  |     await button(page, 'Error notice').click();
  14  |     await page.mouse.move(0, 0);
  15  |     await page.evaluate(async () => {
  16  |       await Promise.all(document.getAnimations().filter(a => a.effect?.getComputedTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})));
  17  |     });
  18  |     const before = await page.locator('.toast-viewport').boundingBox();
  19  |     await page.evaluate(() => {
  20  |       window.motionSamples = [];
  21  |       window.motionDone = false;
  22  |       const start = performance.now();
  23  |       const frame = () => {
  24  |         const el = document.querySelector('.toast-viewport');
  25  |         if (el) {
  26  |           const r = el.getBoundingClientRect();
  27  |           const card = el.querySelector('.toast')?.getBoundingClientRect();
  28  |           const popup = el.closest('.orbit-overlay');
  29  |           const style = popup ? getComputedStyle(popup) : null;
  30  |           window.motionSamples.push({ t: performance.now() - start, x: r.x, y: r.y, width: r.width, height: r.height,
  31  |             card: card?.toJSON(), scale: style?.scale, translate: style?.translate,
  32  |             insideViewport: r.x >= 0 && r.right <= innerWidth && r.y >= 0 && r.bottom <= innerHeight });
  33  |         }
  34  |         if (performance.now() - start < 800) requestAnimationFrame(frame); else window.motionDone = true;
  35  |       };
  36  |       requestAnimationFrame(frame);
  37  |     });
  38  |     await button(page, `Open ${kind}`).click();
  39  |     await page.waitForFunction(() => window.motionDone);
  40  |     const samples = await page.evaluate(() => window.motionSamples);
  41  |     const shifted = samples.filter(s => Math.abs(s.x - before.x) > 1 || Math.abs(s.y - before.y) > 1);
  42  |     await info.attach('entry-geometry', { body: JSON.stringify({ kind, before, samples, shifted }, null, 2), contentType: 'application/json' });
  43  |     expect(shifted, 'an existing notification should not move with the newly opening modal').toHaveLength(0);
  44  |   });
  45  | }
  46  | 
  47  | test('hover pause releases after a keyboard opened and closed overlay changes portal', async ({ page }, info) => {
  48  |   await page.clock.install({ time: new Date('2026-10-04T00:00:00Z') });
  49  |   await page.clock.pauseAt(new Date('2026-10-04T00:00:01Z'));
  50  |   await button(page, 'Complete session').click();
  51  |   const region = page.locator('.toast-viewport');
  52  |   await region.locator('button[aria-label="Undo completing Fix login redirect"]').hover();
  53  |   await page.clock.runFor(10000);
  54  |   await expect(region).toBeVisible();
  55  |   await button(page, 'Open Dialog').focus();
  56  |   await page.keyboard.press('Enter');
  57  |   await page.clock.runFor(200);
  58  |   await expect(page.getByRole('dialog', { name: 'Workspace editor', exact: true })).toBeVisible();
  59  |   await page.keyboard.press('Escape');
  60  |   await page.clock.runFor(200);
  61  |   await expect(page.getByRole('dialog', { name: 'Workspace editor', exact: true })).not.toBeVisible();
  62  |   await page.mouse.move(0, 0);
  63  |   await page.clock.runFor(6001);
  64  |   const after = await page.locator('.toast-slot:not(.toast-slot--leaving)').count();
  65  |   await info.attach('timer-after-portal', { body: JSON.stringify({ after, releasedAfterMs: 6001 }), contentType: 'application/json' });
  66  |   expect(after).toBe(0);
  67  |   await expectExpired(page, 1);
  68  | });
  69  | 
  70  | 
  71  | test('native hover deadline resumes after portal changes', async ({ page }, info) => {
  72  |   await button(page, 'Complete session').click();
  73  |   const region = page.locator('.toast-viewport');
  74  |   await region.locator('button[aria-label="Undo completing Fix login redirect"]').hover();
  75  |   await button(page, 'Open Dialog').focus();
  76  |   await page.keyboard.press('Enter');
  77  |   await expect(page.getByRole('dialog', { name: 'Workspace editor', exact: true })).toBeVisible();
  78  |   await page.keyboard.press('Escape');
  79  |   await expect(page.getByRole('dialog', { name: 'Workspace editor', exact: true })).not.toBeVisible();
  80  |   await page.mouse.move(0, 0);
  81  |   const releasedAt = Date.now();
  82  |   try { await expect(region).toHaveCount(0, { timeout: 7500 }); }
  83  |   finally {
  84  |     await info.attach('native-timer', {body: JSON.stringify({ elapsedMs:Date.now()-releasedAt, count:await region.count() }), contentType:'application/json'});
  85  |   }
  86  | });
  87  | 
  88  | const region = (page) => page.getByRole('region', { name: 'Notifications', exact: true });
  89  | const attach = (info, name, value) => info.attach(name, { body: JSON.stringify(value, null, 2), contentType: 'application/json' });
> 90  | const finishMotion = (page) => page.evaluate(async () => {
      |                                     ^ Error: page.evaluate: Test ended.
  91  |   await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  92  |   await Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity).map((a) => a.finished.catch(() => {})));
  93  | });
  94  | 
  95  | for (const kind of ['Dialog', 'Drawer', 'Bottom drawer']) {
  96  |   test(`notification card stays fixed through ${kind} entry, nested layers and exit`, async ({ page }, info) => {
  97  |     await page.emulateMedia({ reducedMotion: 'no-preference' });
  98  |     await button(page, 'Error notice').click();
  99  |     await page.mouse.move(0, 0);
  100 |     await finishMotion(page);
  101 |     await page.evaluate(() => {
  102 |       const card = document.querySelector('.toast');
  103 |       window.cardMotion = { before: card.getBoundingClientRect().toJSON(), samples: [], phase: 'before', running: true };
  104 |       const sample = () => {
  105 |         const current = document.querySelector('.toast');
  106 |         const r = current?.getBoundingClientRect();
  107 |         window.cardMotion.samples.push({ phase: window.cardMotion.phase, t: performance.now(), sameNode: current === card,
  108 |           card: r?.toJSON(), opacity: current ? getComputedStyle(current).opacity : null,
  109 |           overlays: [...document.querySelectorAll('.orbit-overlay')].map((el) => {
  110 |             const s = getComputedStyle(el);
  111 |             return { scale: s.scale, translate: s.translate, opacity: s.opacity, ending: el.hasAttribute('data-ending-style') };
  112 |           }) });
  113 |         if (window.cardMotion.running) requestAnimationFrame(sample);
  114 |       };
  115 |       requestAnimationFrame(sample);
  116 |     });
  117 |     const phase = (name) => page.evaluate((value) => { window.cardMotion.phase = value; }, name);
  118 |     await phase('open');
  119 |     await button(page, `Open ${kind}`).click();
  120 |     await finishMotion(page);
  121 |     for (let depth = 1; depth <= 2; depth++) {
  122 |       await phase(`nested-${depth}`);
  123 |       await button(page, 'Nested dialog').click();
  124 |       await finishMotion(page);
  125 |       await expect(region(page)).toBeVisible();
  126 |     }
  127 |     for (let depth = 2; depth >= 0; depth--) {
  128 |       await phase(`close-${depth}`);
  129 |       await page.keyboard.press('Escape');
  130 |       await finishMotion(page);
  131 |       await expect(region(page)).toBeVisible();
  132 |     }
  133 |     const motion = await page.evaluate(() => { window.cardMotion.running = false; return window.cardMotion; });
  134 |     await attach(info, 'continuous-card-motion', motion);
  135 |     expect(motion.samples.length).toBeGreaterThan(20);
  136 |     const shifted = motion.samples.filter((s) => !s.sameNode || !s.card || s.opacity !== '1' ||
  137 |       ['x', 'y', 'width', 'height'].some((key) => Math.abs(s.card[key] - motion.before[key]) > 0.1));
  138 |     expect(shifted, 'existing card DOM, opacity and geometry stay stable at every sampled frame').toEqual([]);
  139 |     // These checks also prove the original popup transitions still run in both directions.
  140 |     for (const name of ['open', 'nested-1', 'nested-2', 'close-2', 'close-1', 'close-0']) {
  141 |       expect(motion.samples.some((s) => s.phase === name && s.overlays.some((o) =>
  142 |         Number(o.opacity) < 1 || (o.translate !== 'none' && o.translate !== '0px') || (o.scale !== 'none' && o.scale !== '1'))), name).toBe(true);
  143 |     }
  144 |     await expect(button(page, `Open ${kind}`)).toBeFocused();
  145 |   });
  146 | }
  147 | 
  148 | test('stationary hover stays paused across nested modal owners then resumes for exactly six seconds', async ({ page }, info) => {
  149 |   await page.clock.install({ time: new Date('2026-10-04T00:00:00Z') });
  150 |   await page.clock.pauseAt(new Date('2026-10-04T00:00:01Z'));
  151 |   await button(page, 'Complete session').click();
  152 |   await region(page).getByRole('button', { name: 'Undo completing Fix login redirect', exact: true }).hover();
  153 |   await page.clock.runFor(10000);
  154 |   await expect(region(page)).toBeVisible();
  155 |   for (const name of ['Open Dialog', 'Nested dialog']) {
  156 |     await button(page, name).focus();
  157 |     await page.keyboard.press('Enter');
  158 |     await page.clock.runFor(10200);
  159 |     await expect(region(page)).toBeVisible();
  160 |   }
  161 |   for (let i = 0; i < 2; i++) {
  162 |     await page.keyboard.press('Escape');
  163 |     await page.clock.runFor(10200);
  164 |     await expect(region(page)).toBeVisible();
  165 |   }
  166 |   await page.mouse.move(0, 0);
  167 |   await page.clock.runFor(5999);
  168 |   await expect(region(page)).toBeVisible();
  169 |   await page.clock.runFor(1);
  170 |   await expectExpired(page);
  171 |   await attach(info, 'stationary-hover', { pausedAcrossFourTransfersMs: 40800, pausedBeforeTransfersMs: 10000, visibleAfterReleaseMs: 5999, expiredAfterReleaseMs: 6000 });
  172 | });
  173 | 
  174 | test('unhovered notifications retain their original deadline through modal owner changes', async ({ page }, info) => {
  175 |   await page.clock.install({ time: new Date('2026-10-04T00:00:00Z') });
  176 |   await page.clock.pauseAt(new Date('2026-10-04T00:00:01Z'));
  177 |   await button(page, 'Complete session').click();
  178 |   await page.mouse.move(0, 0);
  179 |   await page.clock.runFor(2000);
  180 |   await button(page, 'Open Drawer').focus();
  181 |   await page.keyboard.press('Enter');
  182 |   await page.clock.runFor(200);
  183 |   await page.keyboard.press('Escape');
  184 |   await page.clock.runFor(3799);
  185 |   await expect(region(page)).toBeVisible();
  186 |   await page.clock.runFor(1);
  187 |   await expectExpired(page);
  188 |   await attach(info, 'unchanged-deadline', { visibleAtTotalMs: 5999, expiredAtTotalMs: 6000 });
  189 | });
  190 | 
```