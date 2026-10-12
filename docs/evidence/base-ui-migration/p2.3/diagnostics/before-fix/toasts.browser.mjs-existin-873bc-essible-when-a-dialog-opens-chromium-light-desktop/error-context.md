# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: toasts.browser.mjs >> existing notifications remain accessible when a dialog opens
- Location: ui-migration/toasts.browser.mjs:9:1

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: getByRole('region', { name: 'Notifications', exact: true })
Expected: visible
Timeout: 15000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" getByRole('region', { name: 'Notifications', exact: true }) with timeout 15000ms
  - waiting for getByRole('region', { name: 'Notifications', exact: true })

```

```yaml
- text: Couldn't save the schedule. revision 12 is stale
- dialog "Workspace editor":
  - button "Close"
  - heading "Workspace editor" [level=2]
  - button "Short notice"
  - button "Error notice"
  - button "Warning notice"
  - button "Complete session"
  - button "Session result"
  - button "Session failure"
  - button "Clear notifications"
  - button "Switch theme"
  - button "Nested dialog"
  - button "Confirm save"
  - status "Undo count": "0"
```

# Test source

```ts
  1  | import { test, expect } from '@playwright/test';
  2  | 
  3  | test.beforeEach(async ({ page }, info) => {
  4  |   await page.goto('/ui-migration/toasts.html');
  5  |   await expect(page.getByTestId('theme')).toHaveText(info.project.use.colorScheme);
  6  |   await page.evaluate(() => document.fonts.ready);
  7  | });
  8  | 
  9  | test('existing notifications remain accessible when a dialog opens', async ({ page }, info) => {
  10 |   await page.getByRole('button', { name: 'Error notice', exact: true }).click();
  11 |   await page.getByRole('button', { name: 'Open Dialog', exact: true }).click();
  12 |   const dialog = page.getByRole('dialog', { name: 'Workspace editor', exact: true });
  13 |   await expect(dialog).toBeVisible();
  14 |   await info.attach('notification-with-dialog', { body: await page.screenshot(), contentType: 'image/png' });
> 15 |   await expect(page.getByRole('region', { name: 'Notifications', exact: true })).toBeVisible();
     |                                                                                  ^ Error: expect(locator).toBeVisible() failed
  16 |   await page.getByRole('button', { name: 'Dismiss', exact: true }).click();
  17 |   await expect(dialog).toBeVisible();
  18 | });
  19 | 
```