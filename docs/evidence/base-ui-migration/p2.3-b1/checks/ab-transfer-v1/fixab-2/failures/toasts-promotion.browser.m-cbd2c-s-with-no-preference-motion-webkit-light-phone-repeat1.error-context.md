# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: toasts-promotion.browser.mjs >> exit keeps its own native progress through modal transfers with no-preference motion
- Location: ui-migration/toasts-promotion.browser.mjs:18:3

# Error details

```
Error: expect(received).toBeGreaterThan(expected)

Expected: > 3
Received:   2
```

# Page snapshot

```yaml
- generic [ref=e1]:
  - main [ref=e4]:
    - heading [level=1] [ref=e5]: Notification integration
    - status [ref=e6]: light
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
  - dialog [ref=e44]:
    - generic [aria-hidden] [ref=e45]:
      - button [ref=e46] [cursor=pointer]
      - heading [level=2] [ref=e50]: Workspace drawer
    - generic [aria-hidden] [ref=e51]:
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
    - dialog [active] [ref=e77]:
      - generic [ref=e78]:
        - button "Close" [ref=e79] [cursor=pointer]
        - heading "Nested editor" [level=2] [ref=e83]
      - generic [ref=e84]:
        - generic [ref=e85]:
          - button "Short notice" [ref=e86] [cursor=pointer]
          - button "Error notice" [ref=e88] [cursor=pointer]
          - button "Warning notice" [ref=e90] [cursor=pointer]
          - button "Complete session" [ref=e92] [cursor=pointer]
          - button "Session result" [ref=e94] [cursor=pointer]
          - button "Session failure" [ref=e96] [cursor=pointer]
          - button "Clear notifications" [ref=e98] [cursor=pointer]
          - button "Switch theme" [ref=e100] [cursor=pointer]
          - button "Nested dialog" [ref=e102] [cursor=pointer]
          - button "Confirm save" [ref=e104] [cursor=pointer]
        - status "Undo count" [ref=e106]: "0"
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
  39  |           [...document.querySelectorAll('.orbit-overlay button')].find((b) => b.textContent === 'Nested dialog' && b.getClientRects().length).click();
  40  |         }
  41  |         const style = getComputedStyle(slot);
  42  |         const animation = slot.getAnimations().find((a) => a instanceof CSSAnimation);
  43  |         window.exitSamples.push({ t, connected: slot.isConnected, sameCard: slot.querySelector('.toast') === card,
  44  |           opacity: Number(style.opacity), animation: animation?.animationName, cssAnimation: style.animationName, inline: slot.getAttribute("style"), display: style.display, delay: style.animationDelay,
  45  |           progress: animation?.effect.getComputedTiming().progress, inert: slot.inert, hidden: slot.getAttribute('aria-hidden'),
  46  |           rect: slot.getBoundingClientRect().toJSON(),
  47  |           owner: slot.closest('.orbit-overlay')?.getAttribute('aria-labelledby') });
  48  |         if (t < 400) requestAnimationFrame(frame); else window.exitDone = true;
  49  |       };
  50  |       slot.querySelector('[aria-label="Dismiss"]').click();
  51  |       requestAnimationFrame(frame);
  52  |     });
  53  |     await page.waitForFunction(() => window.exitDone);
  54  |     const samples = await page.evaluate(() => window.exitSamples);
  55  |     await attach(info, 'native-exit', { motion, samples });
  56  |     const connected = samples.filter((s) => s.connected);
> 57  |     expect(connected.length).toBeGreaterThan(3);
      |                              ^ Error: expect(received).toBeGreaterThan(expected)
  58  |     expect(connected[0].t).toBeLessThan(80);
  59  |     expect(connected[0].opacity, 'entry delay must not skip the new exit').toBeGreaterThan(0.6);
  60  |     expect(connected.every((s) => s.inert && s.hidden === 'true' && s.sameCard)).toBe(true);
  61  |     expect(connected.every((s) => s.animation === (motion === 'reduce' ? 'orbit-toast-fade' : 'orbit-toast-exit'))).toBe(true);
  62  |     expect(new Set(connected.map((s) => s.owner)).size).toBe(2);
  63  |     for (let i = 1; i < connected.length; i++) {
  64  |       // CSS serializes the visible opacity; raw effect progress can differ by
  65  |       // sub-ULP rounding when a delay replaces elapsed animation time.
  66  |       expect(connected[i].opacity, 'reparenting must not restart exit').toBeLessThanOrEqual(connected[i - 1].opacity);
  67  |     }
  68  |     expect(samples.at(-1).connected).toBe(false);
  69  |     await expect(region(page)).toHaveCount(0);
  70  |   });
  71  | }
  72  | 
  73  | test('clear retains the last shape for exactly 250ms but immediately blocks focus and actions', async ({ page }, info) => {
  74  |   await button(page, 'Open Dialog').click();
  75  |   await button(page, 'Nested dialog').click();
  76  |   await button(page, 'Complete session').click();
  77  |   await page.clock.install({ time: new Date('2026-10-04T00:00:00Z') });
  78  |   await page.clock.pauseAt(new Date('2026-10-04T00:00:01Z'));
  79  |   const undo = button(page, 'Undo completing Fix login redirect');
  80  |   await undo.hover();
  81  |   await undo.focus();
  82  |   const rect = await undo.boundingBox();
  83  |   await page.evaluate(async () => {
  84  |     window.departingSlot = document.querySelector('.toast-slot');
  85  |     window.departingAction = window.departingSlot.querySelector('.toast-action');
  86  |     const { clearToasts } = await import('/src/lib/toastStore.ts');
  87  |     clearToasts();
  88  |   });
  89  |   await expect(page.locator('.toast-slot--leaving')).toHaveCount(1);
  90  |   await expect(undo).toHaveCount(0);
  91  |   const snapshot = await page.evaluate(() => {
  92  |     window.departingAction.focus();
  93  |     return { inert: window.departingSlot.inert, hidden: window.departingSlot.getAttribute('aria-hidden'),
  94  |       focused: window.departingSlot.contains(document.activeElement), shape: window.departingSlot.firstElementChild.className };
  95  |   });
  96  |   expect(snapshot).toMatchObject({ inert: true, hidden: 'true', focused: false });
  97  |   expect(snapshot.shape).toContain('toast--card');
  98  |   await page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2);
  99  |   await page.keyboard.press('Enter');
  100 |   expect(await page.getByLabel('Undo count', { exact: true }).allTextContents()).not.toContain('1');
  101 |   await page.clock.runFor(249);
  102 |   expect(await page.evaluate(() => window.departingSlot.isConnected)).toBe(true);
  103 |   await page.clock.runFor(1);
  104 |   expect(await page.evaluate(() => window.departingSlot.isConnected)).toBe(false);
  105 |   // A new non-interactive pill must not inherit the departing result's hold.
  106 |   await page.evaluate(async () => (await import('/src/lib/toastStore.ts')).showToast({ message: 'After clear', tone: 'success' }));
  107 |   await page.clock.runFor(2999);
  108 |   await expect(region(page).getByText('After clear', { exact: true })).toBeVisible();
  109 |   await page.clock.runFor(1);
  110 |   await expect(page.locator('.toast-slot--leaving')).toHaveCount(1);
  111 |   await attach(info, 'clear-lifecycle', { ...snapshot, retainedUntilMs: 249, removedAtMs: 250, successorDwellMs: 3000, undoCalls: 0 });
  112 | });
  113 | 
  114 | test('keyed transient and pinned transitions retain one slot without replaying entrance inside nested modals', async ({ page }, info) => {
  115 |   await page.emulateMedia({ reducedMotion: 'no-preference' });
  116 |   await button(page, 'Open Bottom drawer').click();
  117 |   await button(page, 'Nested dialog').click();
  118 |   const post = (stage) => page.evaluate(async (stage) => {
  119 |     const { showToast } = await import('/src/lib/toastStore.ts');
  120 |     showToast({ key: 'promotion-merge', sessionId: '0196b000-0000-7000-8000-000000000001',
  121 |       message: `Promotion ${stage}`, subtitle: 'Workspace', detail: stage === 'progress' ? undefined : 'Original diagnostic',
  122 |       tone: stage === 'failure' ? 'error' : 'success', inProgress: stage === 'progress',
  123 |       action: stage === 'failure' ? { label: 'Retry merge', onClick: () => { window.retryCalls = (window.retryCalls ?? 0) + 1; } } : undefined });
  124 |   }, stage);
  125 |   await post('progress');
  126 |   await finishMotion(page);
  127 |   await page.evaluate(() => { window.originalSlot = document.querySelector('.toast-slot'); });
  128 |   const stages = [];
  129 |   for (const stage of ['failure', 'result', 'failure']) {
  130 |     await post(stage);
  131 |     await expect(region(page).getByText(`Promotion ${stage}`, { exact: true })).toBeVisible();
  132 |     const state = await page.evaluate(() => {
  133 |       const slots = [...document.querySelectorAll('.toast-slot')];
  134 |       return { count: slots.length, sameSlot: slots[0] === window.originalSlot,
  135 |         leaving: slots[0].classList.contains('toast-slot--leaving'), opacity: getComputedStyle(slots[0]).opacity,
  136 |         running: slots[0].getAnimations().filter((a) => a.playState === 'running').length };
  137 |     });
  138 |     expect(state).toEqual({ count: 1, sameSlot: true, leaving: false, opacity: '1', running: 0 });
  139 |     stages.push({ stage, ...state });
  140 |     if (stage === 'failure') {
  141 |       await expect(region(page).getByRole('button', { name: 'Retry merge', exact: true })).toBeVisible();
  142 |       await expect(region(page).getByRole('button', { name: 'Open session', exact: true })).toHaveCount(0);
  143 |       await expect(region(page).getByRole('button', { name: 'Copy error', exact: true })).toBeVisible();
  144 |     }
  145 |   }
  146 |   await info.attach('keyed-attention', { body: await page.screenshot({ animations: 'allow' }), contentType: 'image/png' });
  147 |   await keyActivate(page, 'Retry merge');
  148 |   expect(await page.evaluate(() => window.retryCalls)).toBe(1);
  149 |   await attach(info, 'keyed-stages', stages);
  150 | });
  151 | 
  152 | test('entrance progress survives a modal transfer before its first 180ms completes', async ({ page }, info) => {
  153 |   await page.emulateMedia({ reducedMotion: 'no-preference' });
  154 |   await page.evaluate(() => {
  155 |     window.entryFrames = [];
  156 |     window.entryDone = false;
  157 |     let transferred = false;
```