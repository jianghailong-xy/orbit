import { test, expect } from '@playwright/test';
import { armScrollUnlock, readScrollUnlock, scrollPage } from '../../../../../src/web/ui-migration/choices-scroll-observation.mjs';

// Controlled documents check that the observation rejects a residual or late lock.
// They do not modify the fixture, component, dependency, or application runtime.
for (const mode of ['retained', 'late']) test(`observer rejects ${mode} scroll lock`, async ({ page }, info) => {
  await page.setContent('<!doctype html><html style="overflow:hidden"><body style="overflow:hidden;margin:0"><button>Focus target</button><div style="height:3000px">Scrollable content</div></body></html>');
  expect(await page.evaluate(() => document.compatMode)).toBe('CSS1Compat');
  await page.getByRole('button', { name: 'Focus target' }).focus();
  await armScrollUnlock(page);
  if (mode === 'late') await page.evaluate(() => {
    window.delayedUnlock = new Promise((resolve) => {
      window.addEventListener('keydown', () => setTimeout(() => {
        document.documentElement.style.overflow = '';
        document.body.style.overflow = '';
        resolve(performance.now() - window.choiceScrollUnlock.startedAt);
      }, 150), { once: true });
    });
  });
  await page.keyboard.press('Escape');
  const unlock = await readScrollUnlock(page);
  await info.attach('rejected-unlock', { body: JSON.stringify(unlock, null, 2), contentType: 'application/json' });
  expect(unlock.unlockedAfterMs).toBeNull();
  expect(unlock.firstRead.locked).toBe(true);
  expect(unlock.finalRead.locked).toBe(true);
  expect(unlock.samples.find((sample) => sample.phase === 'deadline').locked).toBe(true);
  if (mode === 'retained') {
    const scroll = await scrollPage(page, info);
    await info.attach('blocked-scroll', { body: JSON.stringify(scroll, null, 2), contentType: 'application/json' });
    expect(scroll.scrollHeight).toBeGreaterThan(scroll.viewportHeight);
    expect(scroll.input?.trusted).toBe(true);
    expect(scroll.movedAfterMs).toBeNull();
    expect(scroll.after).toBe(scroll.before);
  } else {
    const actualReleaseAfterMs = await page.evaluate(() => window.delayedUnlock);
    await info.attach('late-release', { body: JSON.stringify({ actualReleaseAfterMs }), contentType: 'application/json' });
    expect(actualReleaseAfterMs).toBeGreaterThan(unlock.limitMs);
    expect(await page.evaluate(() => [document.documentElement, document.body].some((node) => /hidden|clip/.test(getComputedStyle(node).overflowY)))).toBe(false);
  }
});
