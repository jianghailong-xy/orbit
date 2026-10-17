import { expect } from '@playwright/test';

// Dwell still ends at the original deadline. main retains only an inert visual
// for another 250ms; prove both boundaries instead of treating it as live DOM.
export async function expectExpired(page, exitElapsed = 0) {
  await expect(page.locator('.toast-slot:not(.toast-slot--leaving)')).toHaveCount(0);
  const leaving = page.locator('.toast-slot--leaving');
  const count = await leaving.count();
  expect(count).toBeGreaterThan(0);
  for (const slot of await leaving.all()) {
    await expect(slot).toHaveAttribute('inert', '');
    await expect(slot).toHaveAttribute('aria-hidden', 'true');
  }
  await page.clock.runFor(249 - exitElapsed);
  await expect(leaving).toHaveCount(count);
  await page.clock.runFor(1);
  await expect(page.getByRole('region', { name: 'Notifications', exact: true })).toHaveCount(0);
}
