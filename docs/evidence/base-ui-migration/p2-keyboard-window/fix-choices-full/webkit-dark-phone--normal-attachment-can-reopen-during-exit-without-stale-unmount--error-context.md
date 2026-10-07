# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: choices-lifecycle.browser.mjs >> normal attachment can reopen during exit without stale unmount
- Location: ui-migration/choices-lifecycle.browser.mjs:132:67

# Error details

```
Error: expect(locator).toHaveAttribute(expected) failed

Locator: locator('.sample-surface')
Expected: ""
Timeout: 15000ms
Error: element(s) not found

Call log:
  - Expect "toHaveAttribute" locator('.sample-surface') with timeout 15000ms
  - waiting for locator('.sample-surface')

```

```yaml
- main:
  - status: dark
  - button "Switch theme"
  - region "Appearance sample":
    - button "Add attachment"
```

# Test source

```ts
  40  | 
  41  | async function closed(page, locator, motion) {
  42  |   await expect(locator).not.toBeVisible();
  43  |   const frames = await page.evaluate(() => { window.choiceExit.active = false; return window.choiceExit.frames; });
  44  |   if (motion === 'no-preference') {
  45  |     expect(frames.some((frame) => frame.connected && frame.visible && frame.opacity > 0 && frame.opacity < 1)).toBe(true);
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
> 140 |   await expect(popup).toHaveAttribute('data-closed', '');
      |                       ^ Error: expect(locator).toHaveAttribute(expected) failed
  141 |   await activate(trigger, info);
  142 |   await expect(popup).toHaveAttribute('data-open', '');
  143 |   await settle(popup);
  144 |   await expect(popup).toBeVisible();
  145 |   if (kind === 'attachment') await activate(page.getByRole('menuitem', { name: 'File', exact: true }), info);
  146 |   else if (['expiry', 'search'].includes(kind)) {
  147 |     await activate(page.getByRole('option', { name: '7 days', exact: true }), info);
  148 |     if (kind === 'expiry') await expect(trigger).toHaveText('7 days');
  149 |     else {
  150 |       await expect(trigger).toHaveAccessibleDescription('7 days');
  151 |       await expect(page.locator('.orbit-combobox-value')).toHaveText('7 days');
  152 |       await expect(trigger).toHaveValue('');
  153 |     }
  154 |   } else if (info.project.use.hasTouch) await page.touchscreen.tap(3, 60);
  155 |   else await page.mouse.click(3, 60);
  156 |   await expect(popup).not.toBeVisible();
  157 |   await info.attach('reopen', { body: JSON.stringify({ kind, input: info.project.use.hasTouch ? 'touch' : 'mouse', reopenedDuringExit: true, subsequentActionClosed: true }), contentType: 'application/json' });
  158 | });
  159 | 
```