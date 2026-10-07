# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: toasts-lifecycle.browser.mjs >> notification pixels stay intact through Dialog opening and closing
- Location: ui-migration/toasts-lifecycle.browser.mjs:192:3

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
    - heading "Notification integration" [level=1] [ref=e5]
    - status [ref=e6]: dark
    - status "Location" [ref=e7]: /ui-migration/toasts.html
    - generic [ref=e8]:
      - button "Short notice" [ref=e9] [cursor=pointer]
      - button "Error notice" [ref=e11] [cursor=pointer]
      - button "Warning notice" [ref=e13] [cursor=pointer]
      - button "Complete session" [ref=e15] [cursor=pointer]
      - button "Session result" [ref=e17] [cursor=pointer]
      - button "Session failure" [ref=e19] [cursor=pointer]
      - button "Clear notifications" [ref=e21] [cursor=pointer]
      - button "Switch theme" [ref=e23] [cursor=pointer]
      - button "Nested dialog" [ref=e25] [cursor=pointer]
      - button "Confirm save" [ref=e27] [cursor=pointer]
    - status "Undo count" [ref=e29]: "0"
    - button "Open Dialog" [active] [ref=e30] [cursor=pointer]
    - button "Open Drawer" [ref=e32] [cursor=pointer]
    - button "Open Bottom drawer" [ref=e34] [cursor=pointer]
    - button "Open Retained dialog" [ref=e36] [cursor=pointer]
    - button "Legacy confirm" [ref=e38] [cursor=pointer]
  - generic [ref=e40]: Couldn't save the schedule. revision 12 is stale
  - generic:
    - region "Notifications":
      - generic [ref=e41]:
        - generic [ref=e42]:
          - generic [ref=e46]: Couldn't save the schedule
          - button "Dismiss" [ref=e48] [cursor=pointer]:
            - img "close" [ref=e49]
        - generic [ref=e52]: revision 12 is stale
        - button "Copy error" [ref=e54] [cursor=pointer]
```

# Test source

```ts
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
  191 | for (const [kind, trigger] of [['Dialog', 'Open Dialog'], ['Drawer', 'Open Drawer'], ['Bottom drawer', 'Open Bottom drawer'], ['Confirmation', 'Confirm save']]) {
  192 |   test(`notification pixels stay intact through ${kind} opening and closing`, async ({ page }, info) => {
  193 |     await page.emulateMedia({ reducedMotion: 'no-preference' });
  194 |     await button(page, 'Error notice').click();
  195 |     await page.mouse.move(0, 0);
  196 |     await finishMotion(page);
  197 |     await info.attach('before-motion', { body: await region(page).screenshot({ animations: 'allow' }), contentType: 'image/png' });
  198 |     await button(page, trigger).click();
  199 |     for (const phase of ['opening', 'closing']) {
  200 |       if (phase === 'closing') await page.keyboard.press('Escape');
  201 |       const frozen = await page.evaluate(async () => {
  202 |         await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  203 |         const popup = [...document.querySelectorAll('.orbit-overlay')].find((el) => el.getClientRects().length);
  204 |         const popupAnimationCount = popup?.getAnimations().length ?? 0;
  205 |         window.frozenPopupAnimations = document.getAnimations().filter((a) =>
  206 |           a.effect?.target?.matches?.('.orbit-overlay, .orbit-overlay-backdrop'));
  207 |         for (const animation of window.frozenPopupAnimations) {
  208 |           animation.pause();
  209 |           animation.currentTime = Number(animation.effect.getTiming().duration) / 2;
  210 |         }
  211 |         const s = popup && getComputedStyle(popup);
  212 |         return { count: popupAnimationCount, scale: s?.scale, translate: s?.translate, opacity: s?.opacity };
  213 |       });
  214 |       if (kind === 'Confirmation') {
  215 |         // The original holder mounts already open, then unmounts on resolution:
  216 |         // it has no popup entry/exit transition in either baseline browser.
  217 |         await expect(page.locator('.orbit-confirm')).toHaveCount(phase === 'opening' ? 1 : 0);
  218 |         expect(frozen.count).toBe(0);
  219 |       } else {
> 220 |         expect(frozen.count, 'the real popup animation must exist; it is paused only for the screenshot').toBeGreaterThan(0);
      |                                                                                                           ^ Error: the real popup animation must exist; it is paused only for the screenshot
  221 |       }
  222 |       await page.mouse.move(0, 0);
  223 |       // Only the popup/backdrop are frozen. Let button hover colors settle so
  224 |       // screenshots compare the same moment instead of an unrelated hover fade.
  225 |       await page.evaluate(async () => {
  226 |         const frozen = new Set(window.frozenPopupAnimations);
  227 |         await Promise.all(document.getAnimations().filter((a) => !frozen.has(a) &&
  228 |           a.effect?.getComputedTiming().iterations !== Infinity).map((a) => a.finished.catch(() => {})));
  229 |       });
  230 |       await info.attach(`${phase}-page`, { body: await page.screenshot({ animations: 'allow' }), contentType: 'image/png' });
  231 |       await info.attach(`${phase}-notification`, { body: await region(page).screenshot({ animations: 'allow' }), contentType: 'image/png' });
  232 |       await attach(info, `${phase}-animation`, frozen);
  233 |       await page.evaluate(() => window.frozenPopupAnimations.forEach((a) => a.play()));
  234 |       await finishMotion(page);
  235 |     }
  236 |     await expect(region(page)).toBeVisible();
  237 |   });
  238 | }
  239 | 
  240 | test('a newly posted notification still plays its original entrance animation once', async ({ page }, info) => {
  241 |   await page.emulateMedia({ reducedMotion: 'no-preference' });
  242 |   // Start on the first animation frame so an intermediate frame cannot be missed by an actionability wait.
  243 |   await page.evaluate(() => {
  244 |     window.freshToastFrames = [];
  245 |     const start = performance.now();
  246 |     let firstCardAt;
  247 |     const frame = () => {
  248 |       const card = document.querySelector('.toast-slot');
  249 |       if (card) {
  250 |         firstCardAt ??= performance.now();
  251 |         const s = getComputedStyle(card);
  252 |         window.freshToastFrames.push({ t: performance.now() - start, opacity: Number(s.opacity), transform: s.transform });
  253 |       }
  254 |       if (firstCardAt === undefined || performance.now() - firstCardAt < 700) requestAnimationFrame(frame);
  255 |       else window.freshToastDone = true;
  256 |     };
  257 |     requestAnimationFrame(frame);
  258 |   });
  259 |   await button(page, 'Error notice').click();
  260 |   await page.waitForFunction(() => window.freshToastDone);
  261 |   const frames = await page.evaluate(() => window.freshToastFrames);
  262 |   await attach(info, 'fresh-notification-animation', frames);
  263 |   expect(frames.some((f) => f.opacity > 0 && f.opacity < 1 && f.transform !== 'none')).toBe(true);
  264 |   expect(frames.at(-1).opacity).toBe(1);
  265 |   expect(frames.at(-1).transform).toBe('none');
  266 | });
  267 | 
```