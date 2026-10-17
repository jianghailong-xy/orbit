# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: toasts-promotion.browser.mjs >> entrance progress survives a modal transfer before its first 180ms completes
- Location: ui-migration/toasts-promotion.browser.mjs:152:1

# Error details

```
Error: expect(received).toBe(expected) // Object.is equality

Expected: true
Received: false
```

# Page snapshot

```yaml
- generic [active] [ref=e1]:
  - main [ref=e4]:
    - heading "Notification integration" [level=1] [ref=e5]
    - status [ref=e6]: light
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
    - button "Open Dialog" [ref=e30] [cursor=pointer]
    - button "Open Drawer" [ref=e32] [cursor=pointer]
    - button "Open Bottom drawer" [ref=e34] [cursor=pointer]
    - button "Open Retained dialog" [ref=e36] [cursor=pointer]
    - button "Legacy confirm" [ref=e38] [cursor=pointer]
  - generic:
    - region "Notifications":
      - generic [ref=e40]:
        - generic [ref=e41]:
          - generic [ref=e45]: Couldn't save the schedule
          - button "Dismiss" [ref=e47] [cursor=pointer]:
            - img "close" [ref=e48]
        - generic [ref=e51]: revision 12 is stale
        - button "Copy error" [ref=e53] [cursor=pointer]
  - generic [ref=e54]: Couldn't save the schedule. revision 12 is stale
```

# Test source

```ts
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
  158 |     const start = performance.now();
  159 |     const frame = () => {
  160 |       const slot = document.querySelector('.toast-slot');
  161 |       const t = performance.now() - start;
  162 |       if (slot) {
  163 |         const animation = slot.getAnimations().find((a) => a instanceof CSSAnimation);
  164 |         const style = getComputedStyle(slot);
  165 |         window.entryFrames.push({ t, opacity: Number(style.opacity), progress: animation?.effect.getComputedTiming().progress,
  166 |           owner: !!slot.closest('.orbit-overlay'), delay: style.animationDelay });
  167 |         if (!transferred && t >= 50 && animation) {
  168 |           transferred = true;
  169 |           [...document.querySelectorAll('button')].find((b) => b.textContent === 'Open Dialog').click();
  170 |         }
  171 |       }
  172 |       if (t < 400) requestAnimationFrame(frame); else window.entryDone = true;
  173 |     };
  174 |     [...document.querySelectorAll('button')].find((b) => b.textContent === 'Error notice').click();
  175 |     requestAnimationFrame(frame);
  176 |   });
  177 |   await page.waitForFunction(() => window.entryDone);
  178 |   const frames = await page.evaluate(() => window.entryFrames);
  179 |   await attach(info, 'native-entrance-transfer', frames);
> 180 |   expect(frames.some((s) => s.opacity > 0 && s.opacity < 1)).toBe(true);
      |                                                              ^ Error: expect(received).toBe(expected) // Object.is equality
  181 |   expect(frames.some((s) => s.owner && s.opacity > 0 && s.opacity < 1)).toBe(true);
  182 |   for (let i = 1; i < frames.length; i++) expect(frames[i].opacity).toBeGreaterThanOrEqual(frames[i - 1].opacity);
  183 |   expect(frames.at(-1).opacity).toBe(1);
  184 | });
  185 | 
```