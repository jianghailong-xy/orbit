# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: choices.browser.mjs >> multiple choices in Dialog keep their owner and menus do not activate a clickable row
- Location: ui-migration/choices.browser.mjs:592:1

# Error details

```
Error: expect(locator).toHaveText(expected) failed

Locator:  getByRole('status', { name: 'Row actions', exact: true })
Expected: "2"
Received: "1"
Timeout:  15000ms

Call log:
  - Expect "toHaveText" getByRole('status', { name: 'Row actions', exact: true }) with timeout 15000ms
  - waiting for getByRole('status', { name: 'Row actions', exact: true })
    34 × locator resolved to <output aria-label="Row actions">1</output>
       - unexpected value "1"

```

```yaml
- status "Row actions": "1"
```

# Test source

```ts
  524 |   await expect(page.getByRole('option', { name: 'Docs', exact: true })).toHaveAttribute('aria-selected', 'true');
  525 |   await tap(page, info, page.getByRole('option', { name: 'Ops', exact: true }));
  526 |   await expect(value).toHaveText('["bug","docs","ops"]');
  527 |   await expect(region.getByLabel('1 more selected', { exact: true })).toBeVisible();
  528 |   await expect(page.getByRole('option', { name: 'Archived', exact: true })).toHaveAttribute('aria-disabled', 'true');
  529 |   await input.focus();
  530 |   await page.keyboard.press('Backspace');
  531 |   await expect(value).toHaveText('["bug","docs"]');
  532 |   await page.keyboard.press('Escape');
  533 |   await expect(input).toBeFocused();
  534 |   await region.getByRole('button', { name: 'Remove Bug', exact: true }).click();
  535 |   await expect(value).toHaveText('["docs"]');
  536 |   await expect(input).toBeFocused();
  537 |   await input.click();
  538 |   await page.getByRole('option', { name: 'Docs', exact: true }).click();
  539 |   await expect(value).toHaveText('[]');
  540 |   await page.getByRole('option', { name: 'Bug', exact: true }).click();
  541 |   await page.keyboard.press('Escape');
  542 |   await input.focus();
  543 |   await page.keyboard.press('Tab');
  544 |   await expect(region.getByRole('button', { name: 'Clear selection' }).first()).toBeFocused();
  545 |   await page.keyboard.press('Enter');
  546 |   await expect(value).toHaveText('[]');
  547 |   await expect(input).toBeFocused();
  548 |   await expect(region.getByRole('combobox', { name: 'Disabled labels', exact: true })).toBeDisabled();
  549 |   await attach(info, 'multiple-labels', { search: true, toggle: true, staysOpen: true, collapsedCount: true, removesHiddenLastValue: true, removeFocus: true, keyboardClear: true });
  550 | });
  551 | 
  552 | test('email tags support controlled typing, separators, composition, Enter, blur and deletion', async ({ page }, info) => {
  553 |   const region = page.getByRole('region', { name: 'Multiple choices', exact: true });
  554 |   const input = region.getByRole('combobox', { name: 'People to add', exact: true });
  555 |   const value = region.getByRole('status', { name: 'People value', exact: true });
  556 |   const query = region.getByRole('status', { name: 'People query', exact: true });
  557 |   await input.fill('first@orbit.test, second@orbit.test ');
  558 |   await expect(value).toHaveText('["owner@orbit.test","first@orbit.test","second@orbit.test"]');
  559 |   await expect(query).toHaveText('');
  560 |   await expect(input).toHaveAttribute('aria-expanded', 'false');
  561 |   await input.fill('draft@orbit.test');
  562 |   await expect(query).toHaveText('draft@orbit.test');
  563 |   await page.keyboard.press('Enter');
  564 |   await expect(value).toContainText('draft@orbit.test');
  565 |   await input.dispatchEvent('compositionstart');
  566 |   await input.fill('中文@orbit.test');
  567 |   await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229, isComposing: true, bubbles: true });
  568 |   await expect(value).not.toContainText('中文@orbit.test');
  569 |   await input.dispatchEvent('compositionend');
  570 |   await page.keyboard.press('Enter');
  571 |   await expect(value).toContainText('中文@orbit.test');
  572 |   await input.fill('blur@orbit.test');
  573 |   await region.getByRole('button', { name: 'After tags' }).click();
  574 |   await expect(value).toContainText('blur@orbit.test');
  575 |   await expect(query).toHaveText('');
  576 |   await input.focus();
  577 |   await page.keyboard.press('Backspace');
  578 |   await expect(value).not.toContainText('blur@orbit.test');
  579 |   await region.getByRole('button', { name: 'Remove first@orbit.test', exact: true }).click();
  580 |   await expect(value).not.toContainText('first@orbit.test');
  581 |   await expect(input).toBeFocused();
  582 |   await input.fill('owner@orbit.test ');
  583 |   const emails = JSON.parse(await value.textContent());
  584 |   expect(emails.filter((email) => email === 'owner@orbit.test')).toHaveLength(1);
  585 |   await input.focus();
  586 |   await page.keyboard.press('Tab');
  587 |   await page.keyboard.press('Enter');
  588 |   await expect(value).toHaveText('[]');
  589 |   await attach(info, 'email-tags', { controlledQuery: true, commaSpace: true, enter: true, blurCommits: true, syntheticComposition: true, backspace: true, remove: true, deduplicated: true, keyboardClear: true });
  590 | });
  591 | 
  592 | test('multiple choices in Dialog keep their owner and menus do not activate a clickable row', async ({ page }, info) => {
  593 |   const trigger = page.getByRole('button', { name: 'Open multi Dialog', exact: true });
  594 |   await tap(page, info, trigger);
  595 |   const dialog = page.getByRole('dialog', { name: 'Multiple choices', exact: true });
  596 |   const input = dialog.getByRole('combobox', { name: 'Labels', exact: true });
  597 |   await tap(page, info, input);
  598 |   const list = page.getByRole('listbox');
  599 |   await expect(list).toBeVisible();
  600 |   expect(await list.evaluate((el) => !!el.closest('[role="dialog"]'))).toBe(true);
  601 |   await tap(page, info, page.getByRole('option', { name: 'Docs', exact: true }));
  602 |   await expect(dialog.locator('output[aria-label="Labels value"]')).toHaveText('["bug","docs"]');
  603 |   await expect(dialog).toBeVisible();
  604 |   await page.keyboard.press('Escape');
  605 |   await expect(list).not.toBeVisible();
  606 |   await expect(input).toBeFocused();
  607 |   const tags = dialog.getByRole('combobox', { name: 'People to add', exact: true });
  608 |   await tags.focus();
  609 |   await tags.dispatchEvent('compositionstart');
  610 |   await tags.dispatchEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 229, isComposing: true, bubbles: true });
  611 |   await expect(dialog).toBeVisible();
  612 |   await tags.dispatchEvent('compositionend');
  613 |   await tags.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  614 |   await page.keyboard.press('Escape');
  615 |   await expect(trigger).toBeFocused();
  616 |   const menu = page.getByRole('button', { name: 'Row actions', exact: true });
  617 |   await tap(page, info, menu);
  618 |   await tap(page, info, page.getByRole('menuitem', { name: 'Run action', exact: true }));
  619 |   await expect(page.getByRole('status', { name: 'Row actions', exact: true })).toHaveText('1');
  620 |   await expect(page.getByRole('status', { name: 'Row clicks', exact: true })).toHaveText('0');
  621 |   await menu.focus();
  622 |   await page.keyboard.press('ArrowDown');
  623 |   await page.keyboard.press('Enter');
> 624 |   await expect(page.getByRole('status', { name: 'Row actions', exact: true })).toHaveText('2');
      |                                                                                ^ Error: expect(locator).toHaveText(expected) failed
  625 |   await expect(page.getByRole('status', { name: 'Row clicks', exact: true })).toHaveText('0');
  626 |   await page.getByRole('button', { name: 'Open row', exact: true }).click();
  627 |   await expect(page.getByRole('status', { name: 'Row clicks', exact: true })).toHaveText('1');
  628 |   await attach(info, 'multi-dialog-and-row', { portalInsideOwner: true, sequentialEscape: true, compositionIgnored: true, focusReturn: true, pointerAndKeyboardStopRowClick: true });
  629 | });
  630 | 
  631 | test('search option touch selects once and preserves input focus', async ({ page }, info) => {
  632 |   const region = page.getByRole('region', { name: 'Standalone choices', exact: true });
  633 |   const input = region.getByRole('combobox', { name: 'Workspace', exact: true });
  634 |   await input.fill('Docs');
  635 |   await tap(page, info, page.getByRole('option', { name: '文档 Docs', exact: true }));
  636 |   await expect(region.getByRole('status', { name: 'Workspace value', exact: true })).toHaveText('docs');
  637 |   await expect(input).toBeFocused();
  638 |   await expect(input).toHaveAttribute('aria-expanded', 'false');
  639 |   await attach(info, 'search-touch', { selected: 'docs', focusKept: true, input: info.project.use.hasTouch ? 'touch' : 'mouse' });
  640 | });
  641 | 
  642 | test('disabled-button and long tooltips remain accessible; a plan-usage-sized popover fits the screen', async ({ page }, info) => {
  643 |   await page.keyboard.press('Tab');
  644 |   const disabledWrapper = page.getByRole('button', { name: 'Unavailable action', exact: true }).locator('..');
  645 |   await disabledWrapper.focus();
  646 |   await expect(page.getByRole('tooltip')).toHaveText('Runner is offline');
  647 |   await expect(disabledWrapper).toHaveAttribute('aria-describedby', /.+/);
  648 |   await page.keyboard.press('Escape');
  649 |   await expect(page.getByRole('tooltip')).not.toBeVisible();
  650 |   const longHelp = page.getByRole('button', { name: 'Long help', exact: true });
  651 |   await longHelp.focus();
  652 |   const tooltip = page.getByRole('tooltip');
  653 |   await settle(tooltip);
  654 |   const tipBox = await tooltip.boundingBox();
  655 |   expect(tipBox.width).toBeLessThanOrEqual(250);
  656 |   expect(tipBox.height).toBeGreaterThan(34);
  657 |   expect(tipBox.x).toBeGreaterThanOrEqual(8);
  658 |   expect(tipBox.x + tipBox.width).toBeLessThanOrEqual(info.project.use.viewport.width - 8);
  659 |   await shot(info, 'long-tooltip', tooltip);
  660 |   await page.keyboard.press('Escape');
  661 |   const trigger = page.getByRole('button', { name: 'Plan usage panel', exact: true });
  662 |   await tap(page, info, trigger);
  663 |   const popover = page.getByRole('dialog', { name: 'Plan usage', exact: true });
  664 |   await settle(popover);
  665 |   const box = await popover.boundingBox();
  666 |   expect(box.x).toBeGreaterThanOrEqual(8);
  667 |   expect(box.x + box.width).toBeLessThanOrEqual(info.project.use.viewport.width - 8);
  668 |   expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(info.project.use.viewport.width);
  669 |   await shot(info, 'plan-usage-sized-popover', popover);
  670 |   await page.keyboard.press('Escape');
  671 |   await expect(trigger).toBeFocused();
  672 |   await attach(info, 'tooltip-and-popover-edges', { disabledButtonDescription: true, tooltip: tipBox, popover: box, horizontalOverflow: false });
  673 | });
  674 | 
```