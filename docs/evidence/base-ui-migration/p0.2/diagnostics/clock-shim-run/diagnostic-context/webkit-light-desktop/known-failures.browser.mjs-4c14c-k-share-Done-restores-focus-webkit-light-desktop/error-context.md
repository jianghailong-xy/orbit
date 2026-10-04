# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: known-failures.browser.mjs >> P0.2-FOCUS-2: task share Done restores focus
- Location: ui-migration/known-failures.browser.mjs:10:3

# Error details

```
Error: expect(locator).toBeFocused() failed

Locator:  getByRole('button', { name: 'More actions', exact: true })
Expected: focused
Received: inactive
Timeout:  1000ms

Call log:
  - Expect "toBeFocused" getByRole('button', { name: 'More actions', exact: true }) with timeout 1000ms
  - waiting for getByRole('button', { name: 'More actions', exact: true })
    11 × locator resolved to <button type="button" aria-label="More actions" class="ant-btn css-oc1rc0 css-var-_r_0_ ant-btn-text ant-btn-color-default ant-btn-variant-text ant-btn-icon-only ant-dropdown-trigger">…</button>
       - unexpected value "inactive"

```

```yaml
- button "More actions":
  - img "more"
```

# Test source

```ts
  1  | import { test, expect } from './harness.mjs';
  2  | import { PATHS } from './fixtures.mjs';
  3  | 
  4  | // Existing defects at the migration starting point. These keep the desired assertion;
  5  | // an eventual repair becomes an unexpected pass and requires retiring the known failure.
  6  | for (const [key, action, reason] of [
  7  |   ['P0.2-FOCUS-1', 'Escape', 'Escape also closes the underlying task panel and returns focus to BODY.'],
  8  |   ['P0.2-FOCUS-2', 'Done', 'Done keeps the task panel open but returns focus to BODY instead of its trigger.'],
  9  | ]) {
  10 |   test(`${key}: task share ${action} restores focus`, async ({ evidence }, testInfo) => {
  11 |     const { page, api } = evidence;
  12 |     const errors = [];
  13 |     page.on('pageerror', (error) => errors.push(error.message));
  14 |     await page.goto(PATHS.task);
  15 |     const more = page.getByRole('button', { name: 'More actions', exact: true });
  16 |     await more.click();
  17 |     await page.getByRole('menuitem', { name: /Share/ }).click();
  18 |     const dialog = page.getByRole('dialog', { name: 'Share task' });
  19 |     await expect(dialog).toBeVisible();
  20 |     await page.keyboard.press('Tab');
  21 |     await expect(dialog.locator(':focus')).toHaveCount(1);
  22 |     if (action === 'Escape') await page.keyboard.press('Escape');
  23 |     else await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  24 |     await expect(dialog).not.toBeVisible();
  25 |     await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  26 |     api.assertHandled();
  27 |     expect(errors, 'Known focus failures must not hide application exceptions').toEqual([]);
  28 |     const observed = await page.evaluate(() => ({
  29 |       url: location.href,
  30 |       taskPanelCount: document.querySelectorAll('.task-detail-panel').length,
  31 |       activeElement: { tag: document.activeElement?.tagName, label: document.activeElement?.getAttribute('aria-label') },
  32 |     }));
  33 |     await testInfo.attach('known-focus-failure', { body: JSON.stringify({ key, reason, observed }, null, 2), contentType: 'application/json' });
  34 |     test.fail(true, `${key}: ${reason}`);
> 35 |     await expect(more).toBeFocused({ timeout: 1000 });
     |                        ^ Error: expect(locator).toBeFocused() failed
  36 |   });
  37 | }
  38 | 
```