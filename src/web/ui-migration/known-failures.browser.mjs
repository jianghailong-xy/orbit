import { test, expect } from './harness.mjs';
import { PATHS } from './fixtures.mjs';

// Defects recorded at the migration starting point, with the desired assertion kept. P3.2 moved the
// share dialog onto the Orbit Dialog (Escape stays in the dialog; focus returns to the ⋯ trigger),
// both now pass in every project, and their expected-failure marks are retired. The observation of
// where focus landed is still attached. The original behaviour is recorded in the P0.2 evidence.
for (const [key, action, reason] of [
  ['P0.2-FOCUS-1', 'Escape', 'At the P0.2 baseline, Escape also closed the underlying task panel and returned focus to BODY.'],
  ['P0.2-FOCUS-2', 'Done', 'At the P0.2 baseline, Done kept the task panel open but returned focus to BODY instead of its trigger.'],
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
    await expect(more).toBeFocused({ timeout: 1000 });
  });
}
