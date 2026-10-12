# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: choices-lifecycle.browser.mjs >> normal search can reopen during exit without stale unmount
- Location: ui-migration/choices-lifecycle.browser.mjs:109:67

# Error details

```
Error: expect(locator).toHaveValue(expected) failed

Locator:  getByRole('region', { name: 'Appearance sample' }).getByRole('combobox')
Expected: "7 days"
Received: ""
Timeout:  15000ms

Call log:
  - Expect "toHaveValue" getByRole('region', { name: 'Appearance sample' }).getByRole('combobox') with timeout 15000ms
  - waiting for getByRole('region', { name: 'Appearance sample' }).getByRole('combobox')
    4 × locator resolved to <input value="" role="combobox" autocorrect="off" autocomplete="off" spellcheck="false" id="base-ui-_r_2_" autocapitalize="none" aria-expanded="false" aria-haspopup="listbox" aria-autocomplete="list" aria-describedby="_r_1_" data-popup-side="bottom" aria-label="Sample choice" class="orbit-combobox-input"/>
      - unexpected value ""
    30 × locator resolved to <input value="" role="combobox" autocorrect="off" autocomplete="off" spellcheck="false" id="base-ui-_r_2_" autocapitalize="none" aria-expanded="false" aria-haspopup="listbox" aria-autocomplete="list" aria-describedby="_r_1_" aria-label="Sample choice" class="orbit-combobox-input"/>
       - unexpected value ""

```

```yaml
- combobox "Sample choice"
```

# Test source

```ts
  26  |           visible: !!node.getClientRects().length && style.visibility !== 'hidden' });
  27  |       }
  28  |       if (record.active) requestAnimationFrame(frame);
  29  |     };
  30  |     requestAnimationFrame(frame);
  31  |   });
  32  | }
  33  | 
  34  | async function closed(page, locator, motion) {
  35  |   await expect(locator).not.toBeVisible();
  36  |   const frames = await page.evaluate(() => { window.choiceExit.active = false; return window.choiceExit.frames; });
  37  |   if (motion === 'no-preference') {
  38  |     expect(frames.some((frame) => frame.connected && frame.visible && frame.opacity > 0 && frame.opacity < 1)).toBe(true);
  39  |     expect(frames.filter((frame) => frame.visible).every((frame) => frame.pointerEvents === 'none')).toBe(true);
  40  |   }
  41  |   return frames;
  42  | }
  43  | 
  44  | for (const motion of ['no-preference', 'reduce']) test(`${motion} Dialog Popover Select exits restore one layer at a time`, async ({ page }, info) => {
  45  |   await page.emulateMedia({ reducedMotion: motion });
  46  |   await page.goto(fixture);
  47  |   const trigger = page.getByRole('button', { name: 'Open Dialog', exact: true });
  48  |   await activate(trigger, info);
  49  |   const dialog = page.getByRole('dialog', { name: 'Share workspace', exact: true });
  50  |   await settle(dialog);
  51  |   const context = dialog.getByRole('button', { name: 'Open context', exact: true });
  52  |   await activate(context, info);
  53  |   const popover = page.getByRole('dialog', { name: 'Context', exact: true });
  54  |   await settle(popover);
  55  |   const select = popover.getByRole('combobox', { name: 'Context expiry', exact: true });
  56  |   await activate(select, info);
  57  |   const popup = page.locator('.orbit-select-popup:visible');
  58  |   await settle(popup);
  59  |   const geometry = await popup.evaluate((node) => {
  60  |     const box = node.getBoundingClientRect();
  61  |     const points = [[box.x + 8, box.y + 8], [box.right - 8, box.bottom - 8]];
  62  |     return { box: box.toJSON(), inPopover: !!node.closest('.orbit-popover'), inDialog: !!node.closest('.orbit-dialog'),
  63  |       cornersHitPopup: points.every(([x, y]) => node.contains(document.elementFromPoint(x, y))),
  64  |       animationName: getComputedStyle(node).animationName };
  65  |   });
  66  |   expect(geometry.inPopover).toBe(true);
  67  |   expect(geometry.inDialog).toBe(true);
  68  |   expect(geometry.cornersHitPopup).toBe(true);
  69  |   if (motion === 'reduce') expect(geometry.animationName).toBe('none');
  70  |   await info.attach('nested-open', { body: await page.screenshot(), contentType: 'image/png' });
  71  |   // Keep an element handle because Select may retain a hidden positioner after exit.
  72  |   const selectPopup = page.locator('.orbit-select-popup');
  73  |   await watchExit(selectPopup);
  74  |   await page.keyboard.press('Escape');
  75  |   const selectExit = await closed(page, selectPopup, motion);
  76  |   await expect(select).toBeFocused();
  77  |   await expect(popover).toBeVisible();
  78  |   await expect(dialog).toBeVisible();
  79  |   await watchExit(popover);
  80  |   await page.keyboard.press('Escape');
  81  |   const popoverExit = await closed(page, popover, motion);
  82  |   await expect(context).toBeFocused();
  83  |   await expect(dialog).toBeVisible();
  84  |   expect(await page.evaluate(() => [document.body, document.documentElement].some((node) => /hidden|clip/.test(getComputedStyle(node).overflowY)))).toBe(true);
  85  |   await page.keyboard.press('Escape');
  86  |   await expect(dialog).not.toBeVisible();
  87  |   await expect(trigger).toBeFocused();
  88  |   expect(await page.evaluate(() => [document.body, document.documentElement].some((node) => /hidden|clip/.test(getComputedStyle(node).overflowY)))).toBe(false);
  89  |   await info.attach('nested-lifecycle', { body: JSON.stringify({ motion, geometry, selectExit, popoverExit, focusReturned: true, scrollUnlocked: true }, null, 2), contentType: 'application/json' });
  90  | });
  91  | 
  92  | for (const kind of ['attachment', 'expiry', 'search', 'multiple', 'popover', 'tooltip']) test(`reduced motion ${kind} has no transition and dismisses cleanly`, async ({ page }, info) => {
  93  |   await page.emulateMedia({ reducedMotion: 'reduce' });
  94  |   await page.goto(`${fixture}?sample=${kind}&system=orbit`);
  95  |   const trigger = page.getByRole('region', { name: 'Appearance sample' }).getByRole(['expiry', 'search', 'multiple'].includes(kind) ? 'combobox' : 'button');
  96  |   if (kind === 'tooltip') await trigger.focus();
  97  |   else await activate(trigger, info);
  98  |   const popup = page.locator('.sample-surface');
  99  |   await settle(popup);
  100 |   const styles = await popup.evaluate((node) => ({ animation: getComputedStyle(node).animationName,
  101 |     transitionDuration: getComputedStyle(node).transitionDuration, running: node.getAnimations().length }));
  102 |   expect(styles).toEqual({ animation: 'none', transitionDuration: '0s', running: 0 });
  103 |   await page.keyboard.press('Escape');
  104 |   await expect(popup).not.toBeVisible();
  105 |   await expect(trigger).toBeFocused();
  106 |   await info.attach('reduced-motion', { body: JSON.stringify({ kind, styles, dismissed: true, focusReturned: true }), contentType: 'application/json' });
  107 | });
  108 | 
  109 | for (const kind of ['attachment', 'expiry', 'search', 'popover']) test(`normal ${kind} can reopen during exit without stale unmount`, async ({ page }, info) => {
  110 |   await page.emulateMedia({ reducedMotion: 'no-preference' });
  111 |   await page.goto(`${fixture}?sample=${kind}&system=orbit`);
  112 |   const trigger = page.getByRole('region', { name: 'Appearance sample' }).getByRole(['expiry', 'search'].includes(kind) ? 'combobox' : 'button');
  113 |   await activate(trigger, info);
  114 |   const popup = page.locator('.sample-surface');
  115 |   await settle(popup);
  116 |   await page.keyboard.press('Escape');
  117 |   await expect(popup).toHaveAttribute('data-closed', '');
  118 |   await activate(trigger, info);
  119 |   await expect(popup).toHaveAttribute('data-open', '');
  120 |   await settle(popup);
  121 |   await expect(popup).toBeVisible();
  122 |   if (kind === 'attachment') await activate(page.getByRole('menuitem', { name: 'File', exact: true }), info);
  123 |   else if (['expiry', 'search'].includes(kind)) {
  124 |     await activate(page.getByRole('option', { name: '7 days', exact: true }), info);
  125 |     if (kind === 'expiry') await expect(trigger).toHaveText('7 days');
> 126 |     else await expect(trigger).toHaveValue('7 days');
      |                                ^ Error: expect(locator).toHaveValue(expected) failed
  127 |   } else if (info.project.use.hasTouch) await page.touchscreen.tap(3, 60);
  128 |   else await page.mouse.click(3, 60);
  129 |   await expect(popup).not.toBeVisible();
  130 |   await info.attach('reopen', { body: JSON.stringify({ kind, input: info.project.use.hasTouch ? 'touch' : 'mouse', reopenedDuringExit: true, subsequentActionClosed: true }), contentType: 'application/json' });
  131 | });
  132 | 
```