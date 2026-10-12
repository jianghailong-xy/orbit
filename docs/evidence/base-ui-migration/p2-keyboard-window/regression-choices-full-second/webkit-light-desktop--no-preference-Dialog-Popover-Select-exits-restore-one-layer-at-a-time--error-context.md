# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: choices-lifecycle.browser.mjs >> no-preference Dialog Popover Select exits restore one layer at a time
- Location: ui-migration/choices-lifecycle.browser.mjs:51:51

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
    - status [ref=e5]: light
    - button [ref=e6] [cursor=pointer]:
      - generic [ref=e7]: Switch theme
    - button [ref=e8] [cursor=pointer]:
      - generic [ref=e9]: Open Dialog
    - button [ref=e10] [cursor=pointer]:
      - generic [ref=e11]: Open legacy Modal
    - region [ref=e12]:
      - generic [ref=e13]:
        - generic [ref=e14]:
          - combobox [ref=e15] [cursor=pointer]:
            - generic [ref=e16]: Never
          - button [ref=e20] [cursor=pointer]
        - textbox [aria-hidden] [ref=e24]: never
        - generic [ref=e25]:
          - generic: Orbit workspace
          - combobox [ref=e26]
          - button [ref=e27] [cursor=pointer]
          - button [ref=e31] [cursor=pointer]
        - textbox [aria-hidden] [ref=e35]: orbit
        - combobox [disabled] [ref=e37]:
          - generic [ref=e38]: Never
        - textbox [disabled] [aria-hidden] [ref=e42]: never
        - generic [ref=e43]:
          - generic: Never
          - combobox [disabled] [ref=e44]
          - button [disabled] [ref=e45] [cursor=pointer]
        - textbox [disabled] [aria-hidden] [ref=e49]: never
        - combobox [ref=e51] [cursor=pointer]:
          - generic [ref=e52]: No accounts
        - textbox [aria-hidden] [ref=e56]
        - combobox [ref=e58] [cursor=pointer]:
          - generic [ref=e59]: Automatic
        - textbox [aria-hidden] [ref=e63]
        - button [ref=e64] [cursor=pointer]:
          - generic [ref=e65]: Session actions
        - button [ref=e66] [cursor=pointer]:
          - generic [ref=e67]: Add attachment
        - button [ref=e68] [cursor=pointer]:
          - generic [ref=e69]: Open context
        - button [ref=e70] [cursor=pointer]:
          - generic [ref=e71]: Account usage
        - button [disabled] [ref=e73]:
          - generic [ref=e74]: Unavailable action
        - button [ref=e75] [cursor=pointer]:
          - generic [ref=e76]: After choices
        - status [ref=e77]: never
        - status [ref=e78]: orbit
        - status [ref=e79]: none
        - status [ref=e80]: "false"
      - generic [ref=e81]:
        - combobox [ref=e82]
        - button [ref=e83] [cursor=pointer]
      - textbox [aria-hidden] [ref=e87]
      - status [ref=e88]: none
    - region [ref=e89]:
      - generic [ref=e90]:
        - generic [ref=e91]:
          - toolbar [ref=e92]:
            - generic [ref=e93]:
              - generic [ref=e94]: Bug
              - button [ref=e95] [cursor=pointer]
            - combobox [ref=e100]
          - button [ref=e101] [cursor=pointer]
          - button [ref=e105] [cursor=pointer]
        - textbox [aria-hidden] [ref=e109]
        - generic [ref=e110]:
          - toolbar [ref=e111]:
            - generic [ref=e112]: Bug
            - combobox [disabled] [ref=e115]
          - button [disabled] [ref=e116] [cursor=pointer]
        - textbox [disabled] [aria-hidden] [ref=e120]
        - generic [ref=e121]:
          - toolbar [ref=e122]:
            - generic [ref=e123]:
              - generic [ref=e124]: owner@orbit.test
              - button [ref=e125] [cursor=pointer]
            - combobox [ref=e130]
          - button [ref=e131] [cursor=pointer]
          - button [ref=e135] [cursor=pointer]
        - textbox [aria-hidden] [ref=e139]
        - button [ref=e140] [cursor=pointer]:
          - generic [ref=e141]: After tags
        - status [ref=e142]: "[\"bug\"]"
        - status [ref=e143]: "[\"owner@orbit.test\"]"
      - button [ref=e144] [cursor=pointer]:
        - generic [ref=e145]: Open multi Dialog
      - group [ref=e146]:
        - button [ref=e147] [cursor=pointer]:
          - generic [ref=e148]: Open row
        - button [ref=e149] [cursor=pointer]:
          - generic [ref=e150]: Row actions
      - status [ref=e151]: "0"
      - status [ref=e152]: "0"
      - button [ref=e153] [cursor=pointer]:
        - generic [ref=e154]: Long help
      - button [ref=e156] [cursor=pointer]:
        - generic [ref=e157]: Plan usage panel
  - dialog [ref=e161]:
    - generic [ref=e162]:
      - button "Close" [ref=e163] [cursor=pointer]
      - heading "Share workspace" [level=2] [ref=e167]
    - generic [ref=e169]:
      - generic [ref=e170]:
        - combobox "Expires" [ref=e171] [cursor=pointer]:
          - generic [ref=e172]: Never
        - button "Clear selection" [ref=e176] [cursor=pointer]
      - textbox [aria-hidden] [ref=e180]: never
      - generic [ref=e181]:
        - generic: Orbit workspace
        - combobox "Workspace" [ref=e182]
        - button "Show options" [ref=e183] [cursor=pointer]
        - button "Clear selection" [ref=e187] [cursor=pointer]
      - textbox [aria-hidden] [ref=e191]: orbit
      - combobox "Disabled select" [disabled] [ref=e193]:
        - generic [ref=e194]: Never
      - textbox [disabled] [aria-hidden] [ref=e198]: never
      - generic [ref=e199]:
        - generic: Never
        - combobox "Disabled search" [disabled] [ref=e200]
        - button "Show options" [disabled] [ref=e201] [cursor=pointer]
      - textbox [disabled] [aria-hidden] [ref=e205]: never
      - combobox "Empty select" [ref=e207] [cursor=pointer]:
        - generic [ref=e208]: No accounts
      - textbox [aria-hidden] [ref=e212]
      - combobox "Automatic account" [ref=e214] [cursor=pointer]:
        - generic [ref=e215]: Automatic
      - textbox [aria-hidden] [ref=e219]
      - button "Session actions" [ref=e220] [cursor=pointer]
      - button "Add attachment" [ref=e222] [cursor=pointer]
      - button "Open context" [expanded] [ref=e225] [cursor=pointer]
      - dialog [ref=e230]:
        - heading "Context" [level=2] [ref=e231]
        - generic [ref=e232]:
          - generic [ref=e233]: 12,800 of 128,000 tokens
          - combobox "Context expiry" [active] [ref=e235] [cursor=pointer]:
            - generic [ref=e236]: Never
          - textbox [aria-hidden] [ref=e240]: never
          - textbox "Context note" [ref=e241]
      - button "Account usage" [ref=e244] [cursor=pointer]
      - button "Unavailable action" [disabled] [ref=e247]
      - button "After choices" [ref=e249] [cursor=pointer]
      - status "Expiry value" [ref=e251]: never
      - status "Workspace value" [ref=e252]: orbit
      - status "Action" [ref=e253]: none
      - status "Tag" [ref=e254]: "false"
```

# Test source

```ts
  1   | import { test, expect } from '@playwright/test';
  2   | import { armScrollUnlock, readScrollUnlock, scrollPage } from './choices-scroll-observation.mjs';
  3   | 
  4   | const fixture = '/ui-migration/choices.html';
  5   | const errors = new WeakMap();
  6   | test.beforeEach(async ({ page }) => {
  7   |   errors.set(page, []);
  8   |   page.on('pageerror', (error) => errors.get(page).push(error.message));
  9   | });
  10  | test.afterEach(async ({ page }) => { expect(errors.get(page)).toEqual([]); });
  11  | 
  12  | async function settle(locator) {
  13  |   await expect(locator).toBeVisible();
  14  |   await locator.evaluate(async (element) => {
  15  |     await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  16  |     await Promise.all(element.getAnimations().map((animation) => animation.finished.catch(() => {})));
  17  |   });
  18  | }
  19  | 
  20  | async function activate(locator, info) {
  21  |   if (info.project.use.hasTouch) await locator.tap();
  22  |   else await locator.click();
  23  | }
  24  | 
  25  | async function watchExit(locator) {
  26  |   await locator.evaluate((node) => {
  27  |     const record = { frames: [], active: true };
  28  |     window.choiceExit = record;
  29  |     const frame = () => {
  30  |       if (node.hasAttribute('data-closed')) {
  31  |         const style = getComputedStyle(node);
  32  |         record.frames.push({ connected: node.isConnected, opacity: Number(style.opacity), pointerEvents: style.pointerEvents,
  33  |           visible: !!node.getClientRects().length && style.visibility !== 'hidden' });
  34  |       }
  35  |       if (record.active) requestAnimationFrame(frame);
  36  |     };
  37  |     requestAnimationFrame(frame);
  38  |   });
  39  | }
  40  | 
  41  | async function closed(page, locator, motion) {
  42  |   await expect(locator).not.toBeVisible();
  43  |   const frames = await page.evaluate(() => { window.choiceExit.active = false; return window.choiceExit.frames; });
  44  |   if (motion === 'no-preference') {
> 45  |     expect(frames.some((frame) => frame.connected && frame.visible && frame.opacity > 0 && frame.opacity < 1)).toBe(true);
      |                                                                                                                ^ Error: expect(received).toBe(expected) // Object.is equality
  46  |     expect(frames.filter((frame) => frame.visible).every((frame) => frame.pointerEvents === 'none')).toBe(true);
  47  |   }
  48  |   return frames;
  49  | }
  50  | 
  51  | for (const motion of ['no-preference', 'reduce']) test(`${motion} Dialog Popover Select exits restore one layer at a time`, async ({ page }, info) => {
  52  |   await page.emulateMedia({ reducedMotion: motion });
  53  |   await page.goto(fixture);
  54  |   const trigger = page.getByRole('button', { name: 'Open Dialog', exact: true });
  55  |   await activate(trigger, info);
  56  |   const dialog = page.getByRole('dialog', { name: 'Share workspace', exact: true });
  57  |   await settle(dialog);
  58  |   const context = dialog.getByRole('button', { name: 'Open context', exact: true });
  59  |   await activate(context, info);
  60  |   const popover = page.getByRole('dialog', { name: 'Context', exact: true });
  61  |   await settle(popover);
  62  |   const select = popover.getByRole('combobox', { name: 'Context expiry', exact: true });
  63  |   await activate(select, info);
  64  |   const popup = page.locator('.orbit-select-popup:visible');
  65  |   await settle(popup);
  66  |   const geometry = await popup.evaluate((node) => {
  67  |     const box = node.getBoundingClientRect();
  68  |     const points = [[box.x + 8, box.y + 8], [box.right - 8, box.bottom - 8]];
  69  |     return { box: box.toJSON(), inPopover: !!node.closest('.orbit-popover'), inDialog: !!node.closest('.orbit-dialog'),
  70  |       cornersHitPopup: points.every(([x, y]) => node.contains(document.elementFromPoint(x, y))),
  71  |       animationName: getComputedStyle(node).animationName };
  72  |   });
  73  |   expect(geometry.inPopover).toBe(true);
  74  |   expect(geometry.inDialog).toBe(true);
  75  |   expect(geometry.cornersHitPopup).toBe(true);
  76  |   if (motion === 'reduce') expect(geometry.animationName).toBe('none');
  77  |   await info.attach('nested-open', { body: await page.screenshot(), contentType: 'image/png' });
  78  |   // Select may retain its hidden positioner after exit; assert visibility as well as focus.
  79  |   const selectPopup = page.locator('.orbit-select-popup');
  80  |   await watchExit(selectPopup);
  81  |   await page.keyboard.press('Escape');
  82  |   const selectExit = await closed(page, selectPopup, motion);
  83  |   await expect(select).toBeFocused();
  84  |   await expect(popover).toBeVisible();
  85  |   await expect(dialog).toBeVisible();
  86  |   await watchExit(popover);
  87  |   await page.keyboard.press('Escape');
  88  |   const popoverExit = await closed(page, popover, motion);
  89  |   await expect(context).toBeFocused();
  90  |   await expect(dialog).toBeVisible();
  91  |   expect(await page.evaluate(() => [document.body, document.documentElement].some((node) => /hidden|clip/.test(getComputedStyle(node).overflowY)))).toBe(true);
  92  |   await armScrollUnlock(dialog);
  93  |   await page.keyboard.press('Escape');
  94  |   await expect(dialog).not.toBeVisible();
  95  |   await expect(trigger).toBeFocused();
  96  |   const unlock = await readScrollUnlock(page);
  97  |   await info.attach('scroll-unlock', { body: JSON.stringify(unlock, null, 2), contentType: 'application/json' });
  98  |   const scroll = await scrollPage(page, info);
  99  |   await info.attach('page-scroll', { body: JSON.stringify(scroll, null, 2), contentType: 'application/json' });
  100 |   expect(unlock.closedAfterMs).not.toBeNull();
  101 |   expect(unlock.unlockedAfterMs).not.toBeNull();
  102 |   expect(unlock.readyAfterCloseMs).not.toBeNull();
  103 |   expect(unlock.readyAfterCloseMs).toBeLessThanOrEqual(unlock.limitMs);
  104 |   expect(unlock.finalRead.locked).toBe(false);
  105 |   expect(scroll.scrollHeight).toBeGreaterThan(scroll.viewportHeight);
  106 |   expect(scroll.input?.trusted).toBe(true);
  107 |   expect(scroll.input?.kind).toBe(info.project.use.isMobile ? 'PageDown' : 'wheel');
  108 |   expect(scroll.movedAfterMs).not.toBeNull();
  109 |   expect(scroll.movedAfterMs).toBeLessThanOrEqual(scroll.limitMs);
  110 |   expect(scroll.after).toBeGreaterThan(scroll.before);
  111 |   await expect(trigger).toBeFocused();
  112 |   await info.attach('nested-lifecycle', { body: JSON.stringify({ motion, geometry, selectExit, popoverExit, focusReturned: true, scrollUnlocked: true }, null, 2), contentType: 'application/json' });
  113 | });
  114 | 
  115 | for (const kind of ['attachment', 'expiry', 'search', 'multiple', 'popover', 'tooltip']) test(`reduced motion ${kind} has no transition and dismisses cleanly`, async ({ page }, info) => {
  116 |   await page.emulateMedia({ reducedMotion: 'reduce' });
  117 |   await page.goto(`${fixture}?sample=${kind}&system=orbit`);
  118 |   const trigger = page.getByRole('region', { name: 'Appearance sample' }).getByRole(['expiry', 'search', 'multiple'].includes(kind) ? 'combobox' : 'button');
  119 |   if (kind === 'tooltip') await trigger.focus();
  120 |   else await activate(trigger, info);
  121 |   const popup = page.locator('.sample-surface');
  122 |   await settle(popup);
  123 |   const styles = await popup.evaluate((node) => ({ animation: getComputedStyle(node).animationName,
  124 |     transitionDuration: getComputedStyle(node).transitionDuration, running: node.getAnimations().length }));
  125 |   expect(styles).toEqual({ animation: 'none', transitionDuration: '0s', running: 0 });
  126 |   await page.keyboard.press('Escape');
  127 |   await expect(popup).not.toBeVisible();
  128 |   await expect(trigger).toBeFocused();
  129 |   await info.attach('reduced-motion', { body: JSON.stringify({ kind, styles, dismissed: true, focusReturned: true }), contentType: 'application/json' });
  130 | });
  131 | 
  132 | for (const kind of ['attachment', 'expiry', 'search', 'popover']) test(`normal ${kind} can reopen during exit without stale unmount`, async ({ page }, info) => {
  133 |   await page.emulateMedia({ reducedMotion: 'no-preference' });
  134 |   await page.goto(`${fixture}?sample=${kind}&system=orbit`);
  135 |   const trigger = page.getByRole('region', { name: 'Appearance sample' }).getByRole(['expiry', 'search'].includes(kind) ? 'combobox' : 'button');
  136 |   await activate(trigger, info);
  137 |   const popup = page.locator('.sample-surface');
  138 |   await settle(popup);
  139 |   await page.keyboard.press('Escape');
  140 |   await expect(popup).toHaveAttribute('data-closed', '');
  141 |   await activate(trigger, info);
  142 |   await expect(popup).toHaveAttribute('data-open', '');
  143 |   await settle(popup);
  144 |   await expect(popup).toBeVisible();
  145 |   if (kind === 'attachment') await activate(page.getByRole('menuitem', { name: 'File', exact: true }), info);
```