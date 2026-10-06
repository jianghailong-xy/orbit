# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: known-failures.browser.mjs >> P0.2-FOCUS-1: task share Escape restores focus
- Location: ui-migration/known-failures.browser.mjs:10:3

# Error details

```
Error: expect(locator).toBeFocused() failed

Locator: getByRole('button', { name: 'More actions', exact: true })
Expected: focused
Timeout: 1000ms
Error: element(s) not found

Call log:
  - Expect "toBeFocused" getByRole('button', { name: 'More actions', exact: true }) with timeout 1000ms
  - waiting for getByRole('button', { name: 'More actions', exact: true })

```

```yaml
- complementary:
  - img
  - text: Orbit
  - button "Collapse sidebar":
    - img "menu-fold"
  - link "Projects Ctrl P"
  - link "Tasks"
  - link "Wiki"
  - link "Runners"
  - link "Providers"
  - text: Workspaces 1
  - img "caret-down"
  - button "Edit"
  - text: Orbit baseline Baseline runner Ctrl 1
  - status
  - text: Projects 1
  - img "caret-down"
  - text: Orbit UI migration
  - button "Account menu, Baseline Reviewer":
    - img "user"
    - text: Baseline Reviewer
  - separator
- main:
  - heading "All tasks caret-down" [level=1]:
    - button "All tasks caret-down":
      - text: All tasks
      - img "caret-down"
  - text: Done 0 / 1·Open 1
  - radiogroup "segmented control":
    - radio "All 1" [checked]
    - text: All 1
    - radio "Open 1"
    - text: Open 1
    - radio "Ready 1"
    - text: Ready 1
    - radio "Running 0"
    - text: Running 0
    - radio "Failed 0"
    - text: Failed 0
    - radio "Done 0"
    - text: Done 0
  - img "search"
  - textbox "Search tasks"
  - text: O Orbit baseline
  - checkbox
  - text: Status Task
  - checkbox
  - text: Open Review the visual baseline
  - button "Delete Review the visual baseline":
    - img "delete"
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