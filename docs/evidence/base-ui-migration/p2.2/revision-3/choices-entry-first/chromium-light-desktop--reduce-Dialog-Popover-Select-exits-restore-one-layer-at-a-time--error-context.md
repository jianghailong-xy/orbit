# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: choices-lifecycle.browser.mjs >> reduce Dialog Popover Select exits restore one layer at a time
- Location: ui-migration/choices-lifecycle.browser.mjs:50:51

# Error details

```
Error: expect(received).toBe(expected) // Object.is equality

Expected: false
Received: true
```

# Page snapshot

```yaml
- main [ref=e4]:
  - status [ref=e5]: light
  - button "Switch theme" [ref=e6] [cursor=pointer]
  - button "Open Dialog" [active] [ref=e8] [cursor=pointer]
  - button "Open legacy Modal" [ref=e10] [cursor=pointer]
  - region "Standalone choices" [ref=e12]:
    - generic [ref=e13]:
      - generic [ref=e14]:
        - combobox "Expires" [ref=e15] [cursor=pointer]:
          - generic [ref=e16]: Never
        - button "Clear selection" [ref=e20] [cursor=pointer]
      - textbox [aria-hidden] [ref=e24]: never
      - generic [ref=e25]:
        - generic: Orbit workspace
        - combobox "Workspace" [ref=e26]
        - button "Show options" [ref=e27] [cursor=pointer]
        - button "Clear selection" [ref=e31] [cursor=pointer]
      - textbox [aria-hidden] [ref=e35]: orbit
      - combobox "Disabled select" [disabled] [ref=e37]:
        - generic [ref=e38]: Never
      - textbox [disabled] [aria-hidden] [ref=e42]: never
      - generic [ref=e43]:
        - generic: Never
        - combobox "Disabled search" [disabled] [ref=e44]
        - button "Show options" [disabled] [ref=e45] [cursor=pointer]
      - textbox [disabled] [aria-hidden] [ref=e49]: never
      - combobox "Empty select" [ref=e51] [cursor=pointer]:
        - generic [ref=e52]: No accounts
      - textbox [aria-hidden] [ref=e56]
      - combobox "Automatic account" [ref=e58] [cursor=pointer]:
        - generic [ref=e59]: Automatic
      - textbox [aria-hidden] [ref=e63]
      - button "Session actions" [ref=e64] [cursor=pointer]
      - button "Add attachment" [ref=e66] [cursor=pointer]
      - button "Open context" [ref=e68] [cursor=pointer]
      - button "Account usage" [ref=e70] [cursor=pointer]
      - button "Unavailable action" [disabled] [ref=e73]
      - button "After choices" [ref=e75] [cursor=pointer]
      - status "Expiry value" [ref=e77]: never
      - status "Workspace value" [ref=e78]: orbit
      - status "Action" [ref=e79]: none
      - status "Tag" [ref=e80]: "false"
    - generic [ref=e81]:
      - combobox "Add prerequisite" [ref=e82]
      - button "Show options" [ref=e83] [cursor=pointer]
    - textbox [aria-hidden] [ref=e87]
    - status "Prerequisite" [ref=e88]: none
  - region "Multiple choices" [ref=e89]:
    - generic [ref=e90]:
      - generic [ref=e91]:
        - toolbar [ref=e92]:
          - generic [ref=e93]:
            - generic [ref=e94]: Bug
            - button "Remove Bug" [ref=e95] [cursor=pointer]
          - combobox "Labels" [ref=e100]
        - button "Show options" [ref=e101] [cursor=pointer]
        - button "Clear selection" [ref=e105] [cursor=pointer]
      - textbox [aria-hidden] [ref=e109]
      - generic [ref=e110]:
        - toolbar [ref=e111]:
          - generic [ref=e112]: Bug
          - combobox "Disabled labels" [disabled] [ref=e115]
        - button "Show options" [disabled] [ref=e116] [cursor=pointer]
      - textbox [disabled] [aria-hidden] [ref=e120]
      - generic [ref=e121]:
        - toolbar [ref=e122]:
          - generic [ref=e123]:
            - generic [ref=e124]: owner@orbit.test
            - button "Remove owner@orbit.test" [ref=e125] [cursor=pointer]
          - combobox "People to add" [ref=e130]
        - button "Show options" [ref=e131] [cursor=pointer]
        - button "Clear selection" [ref=e135] [cursor=pointer]
      - textbox [aria-hidden] [ref=e139]
      - button "After tags" [ref=e140] [cursor=pointer]
      - status "Labels value" [ref=e142]: "[\"bug\"]"
      - status "People value" [ref=e143]: "[\"owner@orbit.test\"]"
      - status "People query"
    - button "Open multi Dialog" [ref=e144] [cursor=pointer]
    - group "Clickable row" [ref=e146]:
      - button "Open row" [ref=e147] [cursor=pointer]
      - button "Row actions" [ref=e149] [cursor=pointer]
    - status "Row clicks" [ref=e151]: "0"
    - status "Row actions" [ref=e152]: "0"
    - button "Long help" [ref=e153] [cursor=pointer]
    - button "Plan usage panel" [ref=e156] [cursor=pointer]
```

# Test source

```ts
  1   | import { test, expect } from '@playwright/test';
  2   | 
  3   | const fixture = '/ui-migration/choices.html';
  4   | const errors = new WeakMap();
  5   | test.beforeEach(async ({ page }) => {
  6   |   errors.set(page, []);
  7   |   page.on('pageerror', (error) => errors.get(page).push(error.message));
  8   | });
  9   | test.afterEach(async ({ page }) => { expect(errors.get(page)).toEqual([]); });
  10  | 
  11  | async function settle(locator) {
  12  |   await expect(locator).toBeVisible();
  13  |   await locator.evaluate(async (element) => {
  14  |     await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  15  |     await Promise.all(element.getAnimations().map((animation) => animation.finished.catch(() => {})));
  16  |   });
  17  | }
  18  | 
  19  | async function activate(locator, info) {
  20  |   if (info.project.use.hasTouch) await locator.tap();
  21  |   else await locator.click();
  22  | }
  23  | 
  24  | async function watchExit(locator) {
  25  |   await locator.evaluate((node) => {
  26  |     const record = { frames: [], active: true };
  27  |     window.choiceExit = record;
  28  |     const frame = () => {
  29  |       if (node.hasAttribute('data-closed')) {
  30  |         const style = getComputedStyle(node);
  31  |         record.frames.push({ connected: node.isConnected, opacity: Number(style.opacity), pointerEvents: style.pointerEvents,
  32  |           visible: !!node.getClientRects().length && style.visibility !== 'hidden' });
  33  |       }
  34  |       if (record.active) requestAnimationFrame(frame);
  35  |     };
  36  |     requestAnimationFrame(frame);
  37  |   });
  38  | }
  39  | 
  40  | async function closed(page, locator, motion) {
  41  |   await expect(locator).not.toBeVisible();
  42  |   const frames = await page.evaluate(() => { window.choiceExit.active = false; return window.choiceExit.frames; });
  43  |   if (motion === 'no-preference') {
  44  |     expect(frames.some((frame) => frame.connected && frame.visible && frame.opacity > 0 && frame.opacity < 1)).toBe(true);
  45  |     expect(frames.filter((frame) => frame.visible).every((frame) => frame.pointerEvents === 'none')).toBe(true);
  46  |   }
  47  |   return frames;
  48  | }
  49  | 
  50  | for (const motion of ['no-preference', 'reduce']) test(`${motion} Dialog Popover Select exits restore one layer at a time`, async ({ page }, info) => {
  51  |   await page.emulateMedia({ reducedMotion: motion });
  52  |   await page.goto(fixture);
  53  |   const trigger = page.getByRole('button', { name: 'Open Dialog', exact: true });
  54  |   await activate(trigger, info);
  55  |   const dialog = page.getByRole('dialog', { name: 'Share workspace', exact: true });
  56  |   await settle(dialog);
  57  |   const context = dialog.getByRole('button', { name: 'Open context', exact: true });
  58  |   await activate(context, info);
  59  |   const popover = page.getByRole('dialog', { name: 'Context', exact: true });
  60  |   await settle(popover);
  61  |   const select = popover.getByRole('combobox', { name: 'Context expiry', exact: true });
  62  |   await activate(select, info);
  63  |   const popup = page.locator('.orbit-select-popup:visible');
  64  |   await settle(popup);
  65  |   const geometry = await popup.evaluate((node) => {
  66  |     const box = node.getBoundingClientRect();
  67  |     const points = [[box.x + 8, box.y + 8], [box.right - 8, box.bottom - 8]];
  68  |     return { box: box.toJSON(), inPopover: !!node.closest('.orbit-popover'), inDialog: !!node.closest('.orbit-dialog'),
  69  |       cornersHitPopup: points.every(([x, y]) => node.contains(document.elementFromPoint(x, y))),
  70  |       animationName: getComputedStyle(node).animationName };
  71  |   });
  72  |   expect(geometry.inPopover).toBe(true);
  73  |   expect(geometry.inDialog).toBe(true);
  74  |   expect(geometry.cornersHitPopup).toBe(true);
  75  |   if (motion === 'reduce') expect(geometry.animationName).toBe('none');
  76  |   await info.attach('nested-open', { body: await page.screenshot(), contentType: 'image/png' });
  77  |   // Select may retain its hidden positioner after exit; assert visibility as well as focus.
  78  |   const selectPopup = page.locator('.orbit-select-popup');
  79  |   await watchExit(selectPopup);
  80  |   await page.keyboard.press('Escape');
  81  |   const selectExit = await closed(page, selectPopup, motion);
  82  |   await expect(select).toBeFocused();
  83  |   await expect(popover).toBeVisible();
  84  |   await expect(dialog).toBeVisible();
  85  |   await watchExit(popover);
  86  |   await page.keyboard.press('Escape');
  87  |   const popoverExit = await closed(page, popover, motion);
  88  |   await expect(context).toBeFocused();
  89  |   await expect(dialog).toBeVisible();
  90  |   expect(await page.evaluate(() => [document.body, document.documentElement].some((node) => /hidden|clip/.test(getComputedStyle(node).overflowY)))).toBe(true);
  91  |   await page.keyboard.press('Escape');
  92  |   await expect(dialog).not.toBeVisible();
  93  |   await expect(trigger).toBeFocused();
> 94  |   expect(await page.evaluate(() => [document.body, document.documentElement].some((node) => /hidden|clip/.test(getComputedStyle(node).overflowY)))).toBe(false);
      |                                                                                                                                                     ^ Error: expect(received).toBe(expected) // Object.is equality
  95  |   await info.attach('nested-lifecycle', { body: JSON.stringify({ motion, geometry, selectExit, popoverExit, focusReturned: true, scrollUnlocked: true }, null, 2), contentType: 'application/json' });
  96  | });
  97  | 
  98  | for (const kind of ['attachment', 'expiry', 'search', 'multiple', 'popover', 'tooltip']) test(`reduced motion ${kind} has no transition and dismisses cleanly`, async ({ page }, info) => {
  99  |   await page.emulateMedia({ reducedMotion: 'reduce' });
  100 |   await page.goto(`${fixture}?sample=${kind}&system=orbit`);
  101 |   const trigger = page.getByRole('region', { name: 'Appearance sample' }).getByRole(['expiry', 'search', 'multiple'].includes(kind) ? 'combobox' : 'button');
  102 |   if (kind === 'tooltip') await trigger.focus();
  103 |   else await activate(trigger, info);
  104 |   const popup = page.locator('.sample-surface');
  105 |   await settle(popup);
  106 |   const styles = await popup.evaluate((node) => ({ animation: getComputedStyle(node).animationName,
  107 |     transitionDuration: getComputedStyle(node).transitionDuration, running: node.getAnimations().length }));
  108 |   expect(styles).toEqual({ animation: 'none', transitionDuration: '0s', running: 0 });
  109 |   await page.keyboard.press('Escape');
  110 |   await expect(popup).not.toBeVisible();
  111 |   await expect(trigger).toBeFocused();
  112 |   await info.attach('reduced-motion', { body: JSON.stringify({ kind, styles, dismissed: true, focusReturned: true }), contentType: 'application/json' });
  113 | });
  114 | 
  115 | for (const kind of ['attachment', 'expiry', 'search', 'popover']) test(`normal ${kind} can reopen during exit without stale unmount`, async ({ page }, info) => {
  116 |   await page.emulateMedia({ reducedMotion: 'no-preference' });
  117 |   await page.goto(`${fixture}?sample=${kind}&system=orbit`);
  118 |   const trigger = page.getByRole('region', { name: 'Appearance sample' }).getByRole(['expiry', 'search'].includes(kind) ? 'combobox' : 'button');
  119 |   await activate(trigger, info);
  120 |   const popup = page.locator('.sample-surface');
  121 |   await settle(popup);
  122 |   await page.keyboard.press('Escape');
  123 |   await expect(popup).toHaveAttribute('data-closed', '');
  124 |   await activate(trigger, info);
  125 |   await expect(popup).toHaveAttribute('data-open', '');
  126 |   await settle(popup);
  127 |   await expect(popup).toBeVisible();
  128 |   if (kind === 'attachment') await activate(page.getByRole('menuitem', { name: 'File', exact: true }), info);
  129 |   else if (['expiry', 'search'].includes(kind)) {
  130 |     await activate(page.getByRole('option', { name: '7 days', exact: true }), info);
  131 |     if (kind === 'expiry') await expect(trigger).toHaveText('7 days');
  132 |     else {
  133 |       await expect(trigger).toHaveAccessibleDescription('7 days');
  134 |       await expect(page.locator('.orbit-combobox-value')).toHaveText('7 days');
  135 |       await expect(trigger).toHaveValue('');
  136 |     }
  137 |   } else if (info.project.use.hasTouch) await page.touchscreen.tap(3, 60);
  138 |   else await page.mouse.click(3, 60);
  139 |   await expect(popup).not.toBeVisible();
  140 |   await info.attach('reopen', { body: JSON.stringify({ kind, input: info.project.use.hasTouch ? 'touch' : 'mouse', reopenedDuringExit: true, subsequentActionClosed: true }), contentType: 'application/json' });
  141 | });
  142 | 
```