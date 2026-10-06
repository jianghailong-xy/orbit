import { test, expect } from '@playwright/test';
import { installFixedDate } from '../../../../../src/web/ui-migration/fixtures.mjs';
import { observeEntry } from './entry-observer.mjs';

// The six original interaction/assertion steps are retained from ea9191d81:242-248.
test('observe original legacy confirmation entry without synchronization', async ({ page }, info) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await installFixedDate(page);
  await page.goto('/ui-migration/toasts.html');
  await expect(page.getByTestId('theme')).toHaveText(info.project.use.colorScheme);
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(observeEntry);
  try {
    await page.getByRole('button', { name: 'Legacy confirm', exact: true }).click();
    const legacy = page.getByRole('dialog', { name: 'Legacy confirmation', exact: true });
    await expect(legacy).toBeVisible();
    await legacy.getByRole('button', { name: 'OK', exact: true }).click();
    await expect(legacy).not.toBeVisible();
    await expect(page.getByRole('region', { name: 'Notifications', exact: true }).getByText('Legacy confirmed', { exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await info.attach('native-entry', { body: JSON.stringify(await page.evaluate(() => window.stopLegacyEntry()), null, 2), contentType: 'application/json' });
  }
});
