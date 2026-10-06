import { test, expect } from '@playwright/test';

const button = (page, name) => page.getByRole('button', { name, exact: true });
test.beforeEach(async ({ page }) => {
  await page.goto('/ui-migration/toasts.html');
  await page.evaluate(() => document.fonts.ready);
});

for (const kind of ['Dialog', 'Drawer', 'Bottom drawer']) {
  test(`existing notification stays at viewport origin during ${kind} entry`, async ({ page }, info) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await button(page, 'Error notice').click();
    await page.mouse.move(0, 0);
    await page.evaluate(async () => {
      await Promise.all(document.getAnimations().filter(a => a.effect?.getComputedTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})));
    });
    const before = await page.locator('.toast-viewport').boundingBox();
    await page.evaluate(() => {
      window.motionSamples = [];
      window.motionDone = false;
      const start = performance.now();
      const frame = () => {
        const el = document.querySelector('.toast-viewport');
        if (el) {
          const r = el.getBoundingClientRect();
          const card = el.querySelector('.toast')?.getBoundingClientRect();
          const popup = el.closest('.orbit-overlay');
          const style = popup ? getComputedStyle(popup) : null;
          window.motionSamples.push({ t: performance.now() - start, x: r.x, y: r.y, width: r.width, height: r.height,
            card: card?.toJSON(), scale: style?.scale, translate: style?.translate,
            insideViewport: r.x >= 0 && r.right <= innerWidth && r.y >= 0 && r.bottom <= innerHeight });
        }
        if (performance.now() - start < 800) requestAnimationFrame(frame); else window.motionDone = true;
      };
      requestAnimationFrame(frame);
    });
    await button(page, `Open ${kind}`).click();
    await page.waitForFunction(() => window.motionDone);
    const samples = await page.evaluate(() => window.motionSamples);
    const shifted = samples.filter(s => Math.abs(s.x - before.x) > 1 || Math.abs(s.y - before.y) > 1);
    await info.attach('entry-geometry', { body: JSON.stringify({ kind, before, samples, shifted }, null, 2), contentType: 'application/json' });
    expect(shifted, 'an existing notification should not move with the newly opening modal').toHaveLength(0);
  });
}

test('hover pause releases after a keyboard opened and closed overlay changes portal', async ({ page }, info) => {
  await page.clock.install({ time: new Date('2026-10-04T00:00:00Z') });
  await page.clock.pauseAt(new Date('2026-10-04T00:00:01Z'));
  await button(page, 'Complete session').click();
  const region = page.locator('.toast-viewport');
  await region.locator('button[aria-label="Undo completing Fix login redirect"]').hover();
  await page.clock.runFor(10000);
  await expect(region).toBeVisible();
  await button(page, 'Open Dialog').focus();
  await page.keyboard.press('Enter');
  await page.clock.runFor(200);
  await expect(page.getByRole('dialog', { name: 'Workspace editor', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.clock.runFor(200);
  await expect(page.getByRole('dialog', { name: 'Workspace editor', exact: true })).not.toBeVisible();
  await page.mouse.move(0, 0);
  await page.clock.runFor(6001);
  const after = await region.count();
  await info.attach('timer-after-portal', { body: JSON.stringify({ after, releasedAfterMs: 6001 }), contentType: 'application/json' });
  expect(after).toBe(0);
});


test('native hover deadline resumes after portal changes', async ({ page }, info) => {
  await button(page, 'Complete session').click();
  const region = page.locator('.toast-viewport');
  await region.locator('button[aria-label="Undo completing Fix login redirect"]').hover();
  await button(page, 'Open Dialog').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'Workspace editor', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Workspace editor', exact: true })).not.toBeVisible();
  await page.mouse.move(0, 0);
  const releasedAt = Date.now();
  try { await expect(region).toHaveCount(0, { timeout: 7500 }); }
  finally {
    await info.attach('native-timer', {body: JSON.stringify({ elapsedMs:Date.now()-releasedAt, count:await region.count() }), contentType:'application/json'});
  }
});
