import { test, expect } from './harness.mjs';
import { PATHS } from './fixtures.mjs';

// Existing defects at the migration starting point. These keep the desired assertion;
// an eventual repair becomes an unexpected pass and requires retiring the known failure.
for (const [key, action, reason] of [
  ['P0.2-FOCUS-1', 'Escape', 'Escape also closes the underlying task panel and returns focus to BODY.'],
  ['P0.2-FOCUS-2', 'Done', 'Done keeps the task panel open but returns focus to BODY instead of its trigger.'],
]) {
  test(`${key}: task share ${action} restores focus`, async ({ evidence }, testInfo) => {
    const { page, api } = evidence;
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(PATHS.task);
    const more = page.getByRole('button', { name: 'More actions', exact: true });
    await more.click();
    await page.getByRole('menuitem', { name: /Share/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Share task' });
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(dialog.locator(':focus')).toHaveCount(1);
    if (action === 'Escape') await page.keyboard.press('Escape');
    else await dialog.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    api.assertHandled();
    expect(errors, 'Known focus failures must not hide application exceptions').toEqual([]);
    const observed = await page.evaluate(() => ({
      url: location.href,
      taskPanelCount: document.querySelectorAll('.task-detail-panel').length,
      activeElement: { tag: document.activeElement?.tagName, label: document.activeElement?.getAttribute('aria-label') },
    }));
    await testInfo.attach('known-focus-failure', { body: JSON.stringify({ key, reason, observed }, null, 2), contentType: 'application/json' });
    test.fail(true, `${key}: ${reason}`);
    await expect(more).toBeFocused({ timeout: 1000 });
  });
}
