# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: toasts-lifecycle.browser.mjs >> notification pixels stay intact through Confirmation opening and closing
- Location: ui-migration/toasts-lifecycle.browser.mjs:190:3

# Error details

```
Error: the real popup animation must exist; it is paused only for the screenshot

expect(received).toBeGreaterThan(expected)

Expected: > 0
Received:   0
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
  - alertdialog [ref=e44]:
    - heading "Save schedule?" [level=2] [ref=e46]
    - generic [ref=e50]: Save this workspace schedule.
    - generic [ref=e52]:
      - button "Cancel" [active] [ref=e53] [cursor=pointer]
      - button "Save" [ref=e55] [cursor=pointer]
    - generic:
      - region "Notifications":
        - generic [ref=e57]:
          - generic [ref=e58]:
            - generic [ref=e62]: Couldn't save the schedule
            - button "Dismiss" [ref=e64] [cursor=pointer]:
              - img "close" [ref=e65]
          - generic [ref=e68]: revision 12 is stale
          - button "Copy error" [ref=e70] [cursor=pointer]
```

# Test source

```ts
  117 |     await button(page, `Open ${kind}`).click();
  118 |     await finishMotion(page);
  119 |     for (let depth = 1; depth <= 2; depth++) {
  120 |       await phase(`nested-${depth}`);
  121 |       await button(page, 'Nested dialog').click();
  122 |       await finishMotion(page);
  123 |       await expect(region(page)).toBeVisible();
  124 |     }
  125 |     for (let depth = 2; depth >= 0; depth--) {
  126 |       await phase(`close-${depth}`);
  127 |       await page.keyboard.press('Escape');
  128 |       await finishMotion(page);
  129 |       await expect(region(page)).toBeVisible();
  130 |     }
  131 |     const motion = await page.evaluate(() => { window.cardMotion.running = false; return window.cardMotion; });
  132 |     await attach(info, 'continuous-card-motion', motion);
  133 |     expect(motion.samples.length).toBeGreaterThan(20);
  134 |     const shifted = motion.samples.filter((s) => !s.sameNode || !s.card || s.opacity !== '1' ||
  135 |       ['x', 'y', 'width', 'height'].some((key) => Math.abs(s.card[key] - motion.before[key]) > 0.1));
  136 |     expect(shifted, 'existing card DOM, opacity and geometry stay stable at every sampled frame').toEqual([]);
  137 |     // These checks also prove the original popup transitions still run in both directions.
  138 |     for (const name of ['open', 'nested-1', 'nested-2', 'close-2', 'close-1', 'close-0']) {
  139 |       expect(motion.samples.some((s) => s.phase === name && s.overlays.some((o) =>
  140 |         Number(o.opacity) < 1 || (o.translate !== 'none' && o.translate !== '0px') || (o.scale !== 'none' && o.scale !== '1'))), name).toBe(true);
  141 |     }
  142 |     await expect(button(page, `Open ${kind}`)).toBeFocused();
  143 |   });
  144 | }
  145 | 
  146 | test('stationary hover stays paused across nested modal owners then resumes for exactly six seconds', async ({ page }, info) => {
  147 |   await page.clock.install({ time: new Date('2026-10-04T00:00:00Z') });
  148 |   await page.clock.pauseAt(new Date('2026-10-04T00:00:01Z'));
  149 |   await button(page, 'Complete session').click();
  150 |   await region(page).getByRole('button', { name: 'Undo completing Fix login redirect', exact: true }).hover();
  151 |   await page.clock.runFor(10000);
  152 |   await expect(region(page)).toBeVisible();
  153 |   for (const name of ['Open Dialog', 'Nested dialog']) {
  154 |     await button(page, name).focus();
  155 |     await page.keyboard.press('Enter');
  156 |     await page.clock.runFor(10200);
  157 |     await expect(region(page)).toBeVisible();
  158 |   }
  159 |   for (let i = 0; i < 2; i++) {
  160 |     await page.keyboard.press('Escape');
  161 |     await page.clock.runFor(10200);
  162 |     await expect(region(page)).toBeVisible();
  163 |   }
  164 |   await page.mouse.move(0, 0);
  165 |   await page.clock.runFor(5999);
  166 |   await expect(region(page)).toBeVisible();
  167 |   await page.clock.runFor(1);
  168 |   await expect(region(page)).toHaveCount(0);
  169 |   await attach(info, 'stationary-hover', { pausedAcrossFourTransfersMs: 40800, pausedBeforeTransfersMs: 10000, visibleAfterReleaseMs: 5999, expiredAfterReleaseMs: 6000 });
  170 | });
  171 | 
  172 | test('unhovered notifications retain their original deadline through modal owner changes', async ({ page }, info) => {
  173 |   await page.clock.install({ time: new Date('2026-10-04T00:00:00Z') });
  174 |   await page.clock.pauseAt(new Date('2026-10-04T00:00:01Z'));
  175 |   await button(page, 'Complete session').click();
  176 |   await page.mouse.move(0, 0);
  177 |   await page.clock.runFor(2000);
  178 |   await button(page, 'Open Drawer').focus();
  179 |   await page.keyboard.press('Enter');
  180 |   await page.clock.runFor(200);
  181 |   await page.keyboard.press('Escape');
  182 |   await page.clock.runFor(3799);
  183 |   await expect(region(page)).toBeVisible();
  184 |   await page.clock.runFor(1);
  185 |   await expect(region(page)).toHaveCount(0);
  186 |   await attach(info, 'unchanged-deadline', { visibleAtTotalMs: 5999, expiredAtTotalMs: 6000 });
  187 | });
  188 | 
  189 | for (const [kind, trigger] of [['Dialog', 'Open Dialog'], ['Drawer', 'Open Drawer'], ['Bottom drawer', 'Open Bottom drawer'], ['Confirmation', 'Confirm save']]) {
  190 |   test(`notification pixels stay intact through ${kind} opening and closing`, async ({ page }, info) => {
  191 |     await page.emulateMedia({ reducedMotion: 'no-preference' });
  192 |     await button(page, 'Error notice').click();
  193 |     await page.mouse.move(0, 0);
  194 |     await finishMotion(page);
  195 |     await info.attach('before-motion', { body: await region(page).screenshot({ animations: 'allow' }), contentType: 'image/png' });
  196 |     await button(page, trigger).click();
  197 |     for (const phase of ['opening', 'closing']) {
  198 |       if (phase === 'closing') await page.keyboard.press('Escape');
  199 |       const frozen = await page.evaluate(async () => {
  200 |         await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  201 |         const popup = [...document.querySelectorAll('.orbit-overlay')].find((el) => el.getAnimations().length);
  202 |         const popupAnimationCount = popup?.getAnimations().length ?? 0;
  203 |         window.frozenPopupAnimations = document.getAnimations().filter((a) =>
  204 |           a.effect?.target?.matches?.('.orbit-overlay, .orbit-overlay-backdrop'));
  205 |         for (const animation of window.frozenPopupAnimations) {
  206 |           animation.pause();
  207 |           animation.currentTime = Number(animation.effect.getTiming().duration) / 2;
  208 |         }
  209 |         const s = popup && getComputedStyle(popup);
  210 |         return { count: popupAnimationCount, scale: s?.scale, translate: s?.translate, opacity: s?.opacity };
  211 |       });
  212 |       if (kind === 'Confirmation' && phase === 'closing') {
  213 |         // The original useConfirm holder unmounts immediately on resolution.
  214 |         await expect(page.locator('.orbit-confirm')).toHaveCount(0);
  215 |         expect(frozen.count).toBe(0);
  216 |       } else {
> 217 |         expect(frozen.count, 'the real popup animation must exist; it is paused only for the screenshot').toBeGreaterThan(0);
      |                                                                                                           ^ Error: the real popup animation must exist; it is paused only for the screenshot
  218 |       }
  219 |       await page.mouse.move(0, 0);
  220 |       await info.attach(`${phase}-page`, { body: await page.screenshot({ animations: 'allow' }), contentType: 'image/png' });
  221 |       await info.attach(`${phase}-notification`, { body: await region(page).screenshot({ animations: 'allow' }), contentType: 'image/png' });
  222 |       await attach(info, `${phase}-animation`, frozen);
  223 |       await page.evaluate(() => window.frozenPopupAnimations.forEach((a) => a.play()));
  224 |       await finishMotion(page);
  225 |     }
  226 |     await expect(region(page)).toBeVisible();
  227 |   });
  228 | }
  229 | 
  230 | test('a newly posted notification still plays its original entrance animation once', async ({ page }, info) => {
  231 |   await page.emulateMedia({ reducedMotion: 'no-preference' });
  232 |   // Start on the first animation frame so an intermediate frame cannot be missed by an actionability wait.
  233 |   await page.evaluate(() => {
  234 |     window.freshToastFrames = [];
  235 |     const start = performance.now();
  236 |     let firstCardAt;
  237 |     const frame = () => {
  238 |       const card = document.querySelector('.toast');
  239 |       if (card) {
  240 |         firstCardAt ??= performance.now();
  241 |         const s = getComputedStyle(card);
  242 |         window.freshToastFrames.push({ t: performance.now() - start, opacity: Number(s.opacity), transform: s.transform });
  243 |       }
  244 |       if (firstCardAt === undefined || performance.now() - firstCardAt < 700) requestAnimationFrame(frame);
  245 |       else window.freshToastDone = true;
  246 |     };
  247 |     requestAnimationFrame(frame);
  248 |   });
  249 |   await button(page, 'Error notice').click();
  250 |   await page.waitForFunction(() => window.freshToastDone);
  251 |   const frames = await page.evaluate(() => window.freshToastFrames);
  252 |   await attach(info, 'fresh-notification-animation', frames);
  253 |   expect(frames.some((f) => f.opacity > 0 && f.opacity < 1 && f.transform !== 'none')).toBe(true);
  254 |   expect(frames.at(-1).opacity).toBe(1);
  255 |   expect(frames.at(-1).transform).toBe('none');
  256 | });
  257 | 
```