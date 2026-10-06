import { test, expect } from '@playwright/test';
import { observeEntry } from './entry-observer.mjs';

test.beforeEach(async ({ page }) => { await page.addInitScript(observeEntry); });
test.afterEach(async ({ page }, info) => {
  const entries = await page.evaluate(() => window.stopLegacyEntry());
  await info.attach('native-entry', { body: JSON.stringify(entries, null, 2), contentType: 'application/json' });
  const clicks = entries.filter((entry) => entry.kind === 'click' && entry.event.targetOK);
  expect(clicks).toHaveLength(1);
  expect(clicks[0].event.trusted).toBe(true);
  expect(clicks[0].hitOK).toBe(true);
  expect(clicks[0].dialog.opacity).toBe('1');
  expect(clicks[0].dialog.transform).toBe('none');
  expect(clicks[0].animations).toEqual([]);
  expect(entries.some((entry) => entry.confirmed)).toBe(true);
});

// Exercise the actual checked-in test, without copying its synchronization/actions.
await import('../../../../../src/web/ui-migration/toasts.browser.mjs');
