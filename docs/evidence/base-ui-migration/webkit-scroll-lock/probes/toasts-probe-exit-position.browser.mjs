import { test, expect } from '@playwright/test';

// Probe (dev-only, not committed): toasts-promotion.browser.mjs's exit-transfer test copied verbatim, run on one tree
// and dev server with only the toast live region's position changed after the first notice: the class's absolute
// (as before the fix) or fixed (as after it), to see whether the position alone changes the test's failure rate.
const button = (page, name) => page.getByRole('button', { name, exact: true });
const region = (page) => page.getByRole('region', { name: 'Notifications', exact: true });
const keyActivate = async (page, name) => { await button(page, name).focus(); await page.keyboard.press('Enter'); };
const attach = (info, name, value) => info.attach(name, { body: JSON.stringify(value, null, 2), contentType: 'application/json' });
const finishMotion = (page) => page.evaluate(async () => {
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  await Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity).map((a) => a.finished.catch(() => {})));
});

test.beforeEach(async ({ page }) => {
  await page.goto('/ui-migration/toasts.html');
  await page.evaluate(() => document.fonts.ready);
});

for (const position of ['absolute', 'fixed']) for (const motion of ['no-preference', 'reduce']) {
  test(`live region ${position}: exit keeps its own native progress through modal transfers with ${motion} motion`, async ({ page }, info) => {
    await page.emulateMedia({ reducedMotion: motion });
    await button(page, 'Error notice').click();
    await page.mouse.move(0, 0);
    await finishMotion(page);
    await page.evaluate((position) => { document.querySelector('body > .sr-only[aria-live]').style.position = position; }, position);
    await button(page, 'Open Drawer').click();
    await finishMotion(page);
    await info.attach('before-exit', { body: await page.screenshot({ animations: 'allow' }), contentType: 'image/png' });
    // Schedule the nested modal inside the real 250ms exit, without replacing
    // requestAnimationFrame, CSS animations or the native removal timer.
    await page.evaluate(() => {
      const slot = document.querySelector('.toast-slot');
      const card = slot.querySelector('.toast');
      const start = performance.now();
      window.exitSamples = [];
      window.exitDone = false;
      let transferred = false;
      const frame = () => {
        const t = performance.now() - start;
        if (!transferred && t >= 80) {
          transferred = true;
          [...document.querySelectorAll('.orbit-overlay button')].find((b) => b.textContent === 'Nested dialog' && b.getClientRects().length).click();
        }
        const style = getComputedStyle(slot);
        const animation = slot.getAnimations().find((a) => a instanceof CSSAnimation);
        window.exitSamples.push({ t, connected: slot.isConnected, sameCard: slot.querySelector('.toast') === card,
          opacity: Number(style.opacity), animation: animation?.animationName, cssAnimation: style.animationName, inline: slot.getAttribute("style"), display: style.display, delay: style.animationDelay,
          progress: animation?.effect.getComputedTiming().progress, inert: slot.inert, hidden: slot.getAttribute('aria-hidden'),
          rect: slot.getBoundingClientRect().toJSON(),
          owner: slot.closest('.orbit-overlay')?.getAttribute('aria-labelledby') });
        if (t < 400) requestAnimationFrame(frame); else window.exitDone = true;
      };
      slot.querySelector('[aria-label="Dismiss"]').click();
      requestAnimationFrame(frame);
    });
    await page.waitForFunction(() => window.exitDone);
    const samples = await page.evaluate(() => window.exitSamples);
    await attach(info, 'native-exit', { motion, samples });
    const connected = samples.filter((s) => s.connected);
    expect(connected.length).toBeGreaterThan(3);
    expect(connected[0].t).toBeLessThan(80);
    expect(connected[0].opacity, 'entry delay must not skip the new exit').toBeGreaterThan(0.6);
    expect(connected.every((s) => s.inert && s.hidden === 'true' && s.sameCard)).toBe(true);
    expect(connected.every((s) => s.animation === (motion === 'reduce' ? 'orbit-toast-fade' : 'orbit-toast-exit'))).toBe(true);
    expect(new Set(connected.map((s) => s.owner)).size).toBe(2);
    for (let i = 1; i < connected.length; i++) {
      // CSS serializes the visible opacity; raw effect progress can differ by
      // sub-ULP rounding when a delay replaces elapsed animation time.
      expect(connected[i].opacity, 'reparenting must not restart exit').toBeLessThanOrEqual(connected[i - 1].opacity);
    }
    expect(samples.at(-1).connected).toBe(false);
    await expect(region(page)).toHaveCount(0);
  });
}

