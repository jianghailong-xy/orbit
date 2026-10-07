# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: toasts-lifecycle.browser.mjs >> native hover deadline resumes after portal changes
- Location: ui-migration/toasts-lifecycle.browser.mjs:69:1

# Error details

```
Error: page.goto: Test ended.
Call log:
  - navigating to "http://127.0.0.1:14377/ui-migration/toasts.html", waiting until "load"

```

# Test source

```ts
  1   | import { test, expect } from '@playwright/test';
  2   | 
  3   | const button = (page, name) => page.getByRole('button', { name, exact: true });
  4   | test.beforeEach(async ({ page }) => {
> 5   |   await page.goto('/ui-migration/toasts.html');
      |              ^ Error: page.goto: Test ended.
  6   |   await page.evaluate(() => document.fonts.ready);
  7   | });
  8   | 
  9   | for (const kind of ['Dialog', 'Drawer', 'Bottom drawer']) {
  10  |   test(`existing notification stays at viewport origin during ${kind} entry`, async ({ page }, info) => {
  11  |     await page.emulateMedia({ reducedMotion: 'no-preference' });
  12  |     await button(page, 'Error notice').click();
  13  |     await page.mouse.move(0, 0);
  14  |     await page.evaluate(async () => {
  15  |       await Promise.all(document.getAnimations().filter(a => a.effect?.getComputedTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})));
  16  |     });
  17  |     const before = await page.locator('.toast-viewport').boundingBox();
  18  |     await page.evaluate(() => {
  19  |       window.motionSamples = [];
  20  |       window.motionDone = false;
  21  |       const start = performance.now();
  22  |       const frame = () => {
  23  |         const el = document.querySelector('.toast-viewport');
  24  |         if (el) {
  25  |           const r = el.getBoundingClientRect();
  26  |           const card = el.querySelector('.toast')?.getBoundingClientRect();
  27  |           const popup = el.closest('.orbit-overlay');
  28  |           const style = popup ? getComputedStyle(popup) : null;
  29  |           window.motionSamples.push({ t: performance.now() - start, x: r.x, y: r.y, width: r.width, height: r.height,
  30  |             card: card?.toJSON(), scale: style?.scale, translate: style?.translate,
  31  |             insideViewport: r.x >= 0 && r.right <= innerWidth && r.y >= 0 && r.bottom <= innerHeight });
  32  |         }
  33  |         if (performance.now() - start < 800) requestAnimationFrame(frame); else window.motionDone = true;
  34  |       };
  35  |       requestAnimationFrame(frame);
  36  |     });
  37  |     await button(page, `Open ${kind}`).click();
  38  |     await page.waitForFunction(() => window.motionDone);
  39  |     const samples = await page.evaluate(() => window.motionSamples);
  40  |     const shifted = samples.filter(s => Math.abs(s.x - before.x) > 1 || Math.abs(s.y - before.y) > 1);
  41  |     await info.attach('entry-geometry', { body: JSON.stringify({ kind, before, samples, shifted }, null, 2), contentType: 'application/json' });
  42  |     expect(shifted, 'an existing notification should not move with the newly opening modal').toHaveLength(0);
  43  |   });
  44  | }
  45  | 
  46  | test('hover pause releases after a keyboard opened and closed overlay changes portal', async ({ page }, info) => {
  47  |   await page.clock.install({ time: new Date('2026-10-04T00:00:00Z') });
  48  |   await page.clock.pauseAt(new Date('2026-10-04T00:00:01Z'));
  49  |   await button(page, 'Complete session').click();
  50  |   const region = page.locator('.toast-viewport');
  51  |   await region.locator('button[aria-label="Undo completing Fix login redirect"]').hover();
  52  |   await page.clock.runFor(10000);
  53  |   await expect(region).toBeVisible();
  54  |   await button(page, 'Open Dialog').focus();
  55  |   await page.keyboard.press('Enter');
  56  |   await page.clock.runFor(200);
  57  |   await expect(page.getByRole('dialog', { name: 'Workspace editor', exact: true })).toBeVisible();
  58  |   await page.keyboard.press('Escape');
  59  |   await page.clock.runFor(200);
  60  |   await expect(page.getByRole('dialog', { name: 'Workspace editor', exact: true })).not.toBeVisible();
  61  |   await page.mouse.move(0, 0);
  62  |   await page.clock.runFor(6001);
  63  |   const after = await region.count();
  64  |   await info.attach('timer-after-portal', { body: JSON.stringify({ after, releasedAfterMs: 6001 }), contentType: 'application/json' });
  65  |   expect(after).toBe(0);
  66  | });
  67  | 
  68  | 
  69  | test('native hover deadline resumes after portal changes', async ({ page }, info) => {
  70  |   await button(page, 'Complete session').click();
  71  |   const region = page.locator('.toast-viewport');
  72  |   await region.locator('button[aria-label="Undo completing Fix login redirect"]').hover();
  73  |   await button(page, 'Open Dialog').focus();
  74  |   await page.keyboard.press('Enter');
  75  |   await expect(page.getByRole('dialog', { name: 'Workspace editor', exact: true })).toBeVisible();
  76  |   await page.keyboard.press('Escape');
  77  |   await expect(page.getByRole('dialog', { name: 'Workspace editor', exact: true })).not.toBeVisible();
  78  |   await page.mouse.move(0, 0);
  79  |   const releasedAt = Date.now();
  80  |   try { await expect(region).toHaveCount(0, { timeout: 7500 }); }
  81  |   finally {
  82  |     await info.attach('native-timer', {body: JSON.stringify({ elapsedMs:Date.now()-releasedAt, count:await region.count() }), contentType:'application/json'});
  83  |   }
  84  | });
  85  | 
  86  | const region = (page) => page.getByRole('region', { name: 'Notifications', exact: true });
  87  | const attach = (info, name, value) => info.attach(name, { body: JSON.stringify(value, null, 2), contentType: 'application/json' });
  88  | const finishMotion = (page) => page.evaluate(async () => {
  89  |   await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  90  |   await Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity).map((a) => a.finished.catch(() => {})));
  91  | });
  92  | 
  93  | for (const kind of ['Dialog', 'Drawer', 'Bottom drawer']) {
  94  |   test(`notification card stays fixed through ${kind} entry, nested layers and exit`, async ({ page }, info) => {
  95  |     await page.emulateMedia({ reducedMotion: 'no-preference' });
  96  |     await button(page, 'Error notice').click();
  97  |     await page.mouse.move(0, 0);
  98  |     await finishMotion(page);
  99  |     await page.evaluate(() => {
  100 |       const card = document.querySelector('.toast');
  101 |       window.cardMotion = { before: card.getBoundingClientRect().toJSON(), samples: [], phase: 'before', running: true };
  102 |       const sample = () => {
  103 |         const current = document.querySelector('.toast');
  104 |         const r = current?.getBoundingClientRect();
  105 |         window.cardMotion.samples.push({ phase: window.cardMotion.phase, t: performance.now(), sameNode: current === card,
```