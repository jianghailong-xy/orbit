# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: toasts-promotion.browser.mjs >> exit keeps its own native progress through modal transfers with reduce motion
- Location: ui-migration/toasts-promotion.browser.mjs:18:3

# Error details

```
Error: expect(received).toBe(expected) // Object.is equality

Expected: true
Received: false
```

# Page snapshot

```yaml
- generic [ref=e1]:
  - main [ref=e4]:
    - heading [level=1] [ref=e5]: Notification integration
    - status [ref=e6]: dark
    - status [ref=e7]: /ui-migration/toasts.html
    - generic [ref=e8]:
      - button [ref=e9] [cursor=pointer]:
        - generic [ref=e10]: Short notice
      - button [ref=e11] [cursor=pointer]:
        - generic [ref=e12]: Error notice
      - button [ref=e13] [cursor=pointer]:
        - generic [ref=e14]: Warning notice
      - button [ref=e15] [cursor=pointer]:
        - generic [ref=e16]: Complete session
      - button [ref=e17] [cursor=pointer]:
        - generic [ref=e18]: Session result
      - button [ref=e19] [cursor=pointer]:
        - generic [ref=e20]: Session failure
      - button [ref=e21] [cursor=pointer]:
        - generic [ref=e22]: Clear notifications
      - button [ref=e23] [cursor=pointer]:
        - generic [ref=e24]: Switch theme
      - button [ref=e25] [cursor=pointer]:
        - generic [ref=e26]: Nested dialog
      - button [ref=e27] [cursor=pointer]:
        - generic [ref=e28]: Confirm save
    - status [ref=e29]: "0"
    - button [ref=e30] [cursor=pointer]:
      - generic [ref=e31]: Open Dialog
    - button [ref=e32] [cursor=pointer]:
      - generic [ref=e33]: Open Drawer
    - button [ref=e34] [cursor=pointer]:
      - generic [ref=e35]: Open Bottom drawer
    - button [ref=e36] [cursor=pointer]:
      - generic [ref=e37]: Open Retained dialog
    - button [ref=e38] [cursor=pointer]:
      - generic [ref=e39]: Legacy confirm
  - generic [ref=e40]: Couldn't save the schedule. revision 12 is stale
  - dialog [active] [ref=e44]:
    - generic [ref=e45]:
      - button [ref=e46] [cursor=pointer]
      - heading [level=2] [ref=e50]: Workspace drawer
    - generic [ref=e51]:
      - generic [ref=e52]:
        - button [ref=e53] [cursor=pointer]:
          - generic [ref=e54]: Short notice
        - button [ref=e55] [cursor=pointer]:
          - generic [ref=e56]: Error notice
        - button [ref=e57] [cursor=pointer]:
          - generic [ref=e58]: Warning notice
        - button [ref=e59] [cursor=pointer]:
          - generic [ref=e60]: Complete session
        - button [ref=e61] [cursor=pointer]:
          - generic [ref=e62]: Session result
        - button [ref=e63] [cursor=pointer]:
          - generic [ref=e64]: Session failure
        - button [ref=e65] [cursor=pointer]:
          - generic [ref=e66]: Clear notifications
        - button [ref=e67] [cursor=pointer]:
          - generic [ref=e68]: Switch theme
        - button [ref=e69] [cursor=pointer]:
          - generic [ref=e70]: Nested dialog
        - button [ref=e71] [cursor=pointer]:
          - generic [ref=e72]: Confirm save
      - status [ref=e73]: "0"
```

# Test source

```ts
  1   | import { test, expect } from '@playwright/test';
  2   | 
  3   | const button = (page, name) => page.getByRole('button', { name, exact: true });
  4   | const region = (page) => page.getByRole('region', { name: 'Notifications', exact: true });
  5   | const keyActivate = async (page, name) => { await button(page, name).focus(); await page.keyboard.press('Enter'); };
  6   | const attach = (info, name, value) => info.attach(name, { body: JSON.stringify(value, null, 2), contentType: 'application/json' });
  7   | const finishMotion = (page) => page.evaluate(async () => {
  8   |   await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  9   |   await Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity).map((a) => a.finished.catch(() => {})));
  10  | });
  11  | 
  12  | test.beforeEach(async ({ page }) => {
  13  |   await page.goto('/ui-migration/toasts.html');
  14  |   await page.evaluate(() => document.fonts.ready);
  15  | });
  16  | 
  17  | for (const motion of ['no-preference', 'reduce']) {
  18  |   test(`exit keeps its own native progress through modal transfers with ${motion} motion`, async ({ page }, info) => {
  19  |     await page.emulateMedia({ reducedMotion: motion });
  20  |     await button(page, 'Error notice').click();
  21  |     await page.mouse.move(0, 0);
  22  |     await finishMotion(page);
  23  |     await button(page, 'Open Drawer').click();
  24  |     await finishMotion(page);
  25  |     await info.attach('before-exit', { body: await page.screenshot({ animations: 'allow' }), contentType: 'image/png' });
  26  |     // Schedule the nested modal inside the real 250ms exit, without replacing
  27  |     // requestAnimationFrame, CSS animations or the native removal timer.
  28  |     await page.evaluate(() => {
  29  |       const slot = document.querySelector('.toast-slot');
  30  |       const card = slot.querySelector('.toast');
  31  |       const start = performance.now();
  32  |       window.exitSamples = [];
  33  |       window.exitDone = false;
  34  |       let transferred = false;
  35  |       const frame = () => {
  36  |         const t = performance.now() - start;
  37  |         if (!transferred && t >= 80) {
  38  |           transferred = true;
  39  |           [...document.querySelectorAll('.orbit-overlay button')].find((b) => b.textContent === 'Nested dialog').click();
  40  |         }
  41  |         const style = getComputedStyle(slot);
  42  |         const animation = slot.getAnimations().find((a) => a instanceof CSSAnimation);
  43  |         window.exitSamples.push({ t, connected: slot.isConnected, sameCard: slot.querySelector('.toast') === card,
  44  |           opacity: Number(style.opacity), animation: animation?.animationName, delay: style.animationDelay,
  45  |           progress: animation?.effect.getComputedTiming().progress, inert: slot.inert, hidden: slot.getAttribute('aria-hidden'),
  46  |           owner: slot.closest('.orbit-overlay')?.getAttribute('aria-labelledby') });
  47  |         if (t < 400) requestAnimationFrame(frame); else window.exitDone = true;
  48  |       };
  49  |       slot.querySelector('[aria-label="Dismiss"]').click();
  50  |       requestAnimationFrame(frame);
  51  |     });
  52  |     await page.waitForFunction(() => window.exitDone);
  53  |     const samples = await page.evaluate(() => window.exitSamples);
  54  |     await attach(info, 'native-exit', { motion, samples });
  55  |     const connected = samples.filter((s) => s.connected);
  56  |     expect(connected.length).toBeGreaterThan(3);
  57  |     expect(connected[0].t).toBeLessThan(80);
  58  |     expect(connected[0].opacity, 'entry delay must not skip the new exit').toBeGreaterThan(0.6);
  59  |     expect(connected.every((s) => s.inert && s.hidden === 'true' && s.sameCard)).toBe(true);
> 60  |     expect(connected.every((s) => s.animation === (motion === 'reduce' ? 'orbit-toast-fade' : 'orbit-toast-exit'))).toBe(true);
      |                                                                                                                     ^ Error: expect(received).toBe(expected) // Object.is equality
  61  |     expect(new Set(connected.map((s) => s.owner)).size).toBe(2);
  62  |     for (let i = 1; i < connected.length; i++) {
  63  |       expect(connected[i].progress, 'reparenting must not restart exit').toBeGreaterThanOrEqual(connected[i - 1].progress);
  64  |     }
  65  |     expect(samples.at(-1).connected).toBe(false);
  66  |     await expect(region(page)).toHaveCount(0);
  67  |   });
  68  | }
  69  | 
  70  | test('clear retains the last shape for exactly 250ms but immediately blocks focus and actions', async ({ page }, info) => {
  71  |   await button(page, 'Open Dialog').click();
  72  |   await button(page, 'Nested dialog').click();
  73  |   await button(page, 'Complete session').click();
  74  |   await page.clock.install({ time: new Date('2026-10-04T00:00:00Z') });
  75  |   await page.clock.pauseAt(new Date('2026-10-04T00:00:01Z'));
  76  |   const undo = button(page, 'Undo completing Fix login redirect');
  77  |   await undo.hover();
  78  |   await undo.focus();
  79  |   const rect = await undo.boundingBox();
  80  |   await page.evaluate(async () => {
  81  |     window.departingSlot = document.querySelector('.toast-slot');
  82  |     window.departingAction = window.departingSlot.querySelector('.toast-action');
  83  |     const { clearToasts } = await import('/src/lib/toastStore.ts');
  84  |     clearToasts();
  85  |   });
  86  |   await expect(page.locator('.toast-slot--leaving')).toHaveCount(1);
  87  |   await expect(undo).toHaveCount(0);
  88  |   const snapshot = await page.evaluate(() => {
  89  |     window.departingAction.focus();
  90  |     return { inert: window.departingSlot.inert, hidden: window.departingSlot.getAttribute('aria-hidden'),
  91  |       focused: window.departingSlot.contains(document.activeElement), shape: window.departingSlot.firstElementChild.className };
  92  |   });
  93  |   expect(snapshot).toMatchObject({ inert: true, hidden: 'true', focused: false });
  94  |   expect(snapshot.shape).toContain('toast--card');
  95  |   await page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2);
  96  |   await page.keyboard.press('Enter');
  97  |   expect(await page.getByLabel('Undo count', { exact: true }).allTextContents()).not.toContain('1');
  98  |   await page.clock.runFor(249);
  99  |   expect(await page.evaluate(() => window.departingSlot.isConnected)).toBe(true);
  100 |   await page.clock.runFor(1);
  101 |   expect(await page.evaluate(() => window.departingSlot.isConnected)).toBe(false);
  102 |   // A new non-interactive pill must not inherit the departing result's hold.
  103 |   await page.evaluate(async () => (await import('/src/lib/toastStore.ts')).showToast({ message: 'After clear', tone: 'success' }));
  104 |   await page.clock.runFor(2999);
  105 |   await expect(region(page).getByText('After clear', { exact: true })).toBeVisible();
  106 |   await page.clock.runFor(1);
  107 |   await expect(page.locator('.toast-slot--leaving')).toHaveCount(1);
  108 |   await attach(info, 'clear-lifecycle', { ...snapshot, retainedUntilMs: 249, removedAtMs: 250, successorDwellMs: 3000, undoCalls: 0 });
  109 | });
  110 | 
  111 | test('keyed transient and pinned transitions retain one slot without replaying entrance inside nested modals', async ({ page }, info) => {
  112 |   await page.emulateMedia({ reducedMotion: 'no-preference' });
  113 |   await button(page, 'Open Bottom drawer').click();
  114 |   await button(page, 'Nested dialog').click();
  115 |   const post = (stage) => page.evaluate(async (stage) => {
  116 |     const { showToast } = await import('/src/lib/toastStore.ts');
  117 |     showToast({ key: 'promotion-merge', sessionId: '0196b000-0000-7000-8000-000000000001',
  118 |       message: `Promotion ${stage}`, subtitle: 'Workspace', detail: stage === 'progress' ? undefined : 'Original diagnostic',
  119 |       tone: stage === 'failure' ? 'error' : 'success', inProgress: stage === 'progress',
  120 |       action: stage === 'failure' ? { label: 'Retry merge', onClick: () => { window.retryCalls = (window.retryCalls ?? 0) + 1; } } : undefined });
  121 |   }, stage);
  122 |   await post('progress');
  123 |   await finishMotion(page);
  124 |   await page.evaluate(() => { window.originalSlot = document.querySelector('.toast-slot'); });
  125 |   const stages = [];
  126 |   for (const stage of ['failure', 'result', 'failure']) {
  127 |     await post(stage);
  128 |     await expect(region(page).getByText(`Promotion ${stage}`, { exact: true })).toBeVisible();
  129 |     const state = await page.evaluate(() => {
  130 |       const slots = [...document.querySelectorAll('.toast-slot')];
  131 |       return { count: slots.length, sameSlot: slots[0] === window.originalSlot,
  132 |         leaving: slots[0].classList.contains('toast-slot--leaving'), opacity: getComputedStyle(slots[0]).opacity,
  133 |         running: slots[0].getAnimations().filter((a) => a.playState === 'running').length };
  134 |     });
  135 |     expect(state).toEqual({ count: 1, sameSlot: true, leaving: false, opacity: '1', running: 0 });
  136 |     stages.push({ stage, ...state });
  137 |     if (stage === 'failure') {
  138 |       await expect(region(page).getByRole('button', { name: 'Retry merge', exact: true })).toBeVisible();
  139 |       await expect(region(page).getByRole('button', { name: 'Open session', exact: true })).toHaveCount(0);
  140 |       await expect(region(page).getByRole('button', { name: 'Copy error', exact: true })).toBeVisible();
  141 |     }
  142 |   }
  143 |   await info.attach('keyed-attention', { body: await page.screenshot({ animations: 'allow' }), contentType: 'image/png' });
  144 |   await keyActivate(page, 'Retry merge');
  145 |   expect(await page.evaluate(() => window.retryCalls)).toBe(1);
  146 |   await attach(info, 'keyed-stages', stages);
  147 | });
  148 | 
  149 | test('entrance progress survives a modal transfer before its first 180ms completes', async ({ page }, info) => {
  150 |   await page.emulateMedia({ reducedMotion: 'no-preference' });
  151 |   await page.evaluate(() => {
  152 |     window.entryFrames = [];
  153 |     window.entryDone = false;
  154 |     let transferred = false;
  155 |     const start = performance.now();
  156 |     const frame = () => {
  157 |       const slot = document.querySelector('.toast-slot');
  158 |       const t = performance.now() - start;
  159 |       if (slot) {
  160 |         const animation = slot.getAnimations().find((a) => a instanceof CSSAnimation);
```