import { test, expect } from '@playwright/test';

// Diagnosis, not part of the matrix: the entrance-replay race seen once under machine load.
// ToastViewport records an entrance's start in onAnimationStart only while getAnimations() still lists
// that animation. A main thread blocked past the 180ms entrance makes animationstart arrive after the
// animation finished; then nothing is recorded and the next modal transfer replays the entrance.
// The page blocks its own main thread for 400ms right after posting the notice (no other change),
// then opens the Drawer and samples the card at every frame, exactly as the matrix does.
const button = (page, name) => page.getByRole('button', { name, exact: true });
for (const block of [0, 400]) {
  test(`card after a modal transfer, main thread blocked ${block}ms after the notice`, async ({ page }, info) => {
    await page.goto('/ui-migration/toasts.html');
    await page.evaluate(() => document.fonts.ready);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.evaluate((ms) => {
      [...document.querySelectorAll('button')].find((b) => b.textContent === 'Error notice').click();
      // React has committed the notice in this click; resolve its style so the entrance animation exists,
      // then keep the main thread busy past the 180ms entrance before the next frame.
      const slot = document.querySelector('.toast-slot');
      if (slot) void getComputedStyle(slot).opacity;
      const until = performance.now() + ms;
      while (performance.now() < until) { /* block */ }
    }, block);
    await page.mouse.move(0, 0);
    await page.evaluate(async () => {
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      await Promise.all(document.getAnimations().map((a) => a.finished.catch(() => {})));
    });
    const recorded = await page.evaluate(() => document.querySelector('.toast-slot')?.dataset.toastAnimationStart ?? null);
    await page.evaluate(() => {
      const card = document.querySelector('.toast');
      window.cardMotion = { before: card.getBoundingClientRect().toJSON(), samples: [], running: true };
      const sample = () => {
        const r = document.querySelector('.toast')?.getBoundingClientRect();
        window.cardMotion.samples.push({ t: performance.now(), x: r?.x, width: r?.width });
        if (window.cardMotion.running) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    await button(page, 'Open Drawer').click();
    await page.evaluate(async () => {
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      await Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity).map((a) => a.finished.catch(() => {})));
    });
    const motion = await page.evaluate(() => { window.cardMotion.running = false; return window.cardMotion; });
    const shifted = motion.samples.filter((s) => Math.abs(s.x - motion.before.x) > 0.1 || Math.abs(s.width - motion.before.width) > 0.1);
    await info.attach('race', { body: JSON.stringify({ block, recordedStart: recorded, frames: motion.samples.length, shifted: shifted.map((s) => ({ dx: s.x - motion.before.x, dw: s.width - motion.before.width })) }, null, 1), contentType: 'application/json' });
    expect(true).toBe(true);
  });
}
