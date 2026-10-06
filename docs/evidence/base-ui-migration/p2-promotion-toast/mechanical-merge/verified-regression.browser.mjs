import { test, expect } from '@playwright/test';

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

for (const motion of ['no-preference', 'reduce']) {
  test(`exit keeps its own native progress through modal transfers with ${motion} motion`, async ({ page }, info) => {
    await page.emulateMedia({ reducedMotion: motion });
    await button(page, 'Error notice').click();
    await page.mouse.move(0, 0);
    await finishMotion(page);
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
      expect(connected[i].progress, 'reparenting must not restart exit').toBeGreaterThanOrEqual(connected[i - 1].progress);
    }
    expect(samples.at(-1).connected).toBe(false);
    await expect(region(page)).toHaveCount(0);
  });
}

test('clear retains the last shape for exactly 250ms but immediately blocks focus and actions', async ({ page }, info) => {
  await button(page, 'Open Dialog').click();
  await button(page, 'Nested dialog').click();
  await button(page, 'Complete session').click();
  await page.clock.install({ time: new Date('2026-10-04T00:00:00Z') });
  await page.clock.pauseAt(new Date('2026-10-04T00:00:01Z'));
  const undo = button(page, 'Undo completing Fix login redirect');
  await undo.hover();
  await undo.focus();
  const rect = await undo.boundingBox();
  await page.evaluate(async () => {
    window.departingSlot = document.querySelector('.toast-slot');
    window.departingAction = window.departingSlot.querySelector('.toast-action');
    const { clearToasts } = await import('/src/lib/toastStore.ts');
    clearToasts();
  });
  await expect(page.locator('.toast-slot--leaving')).toHaveCount(1);
  await expect(undo).toHaveCount(0);
  const snapshot = await page.evaluate(() => {
    window.departingAction.focus();
    return { inert: window.departingSlot.inert, hidden: window.departingSlot.getAttribute('aria-hidden'),
      focused: window.departingSlot.contains(document.activeElement), shape: window.departingSlot.firstElementChild.className };
  });
  expect(snapshot).toMatchObject({ inert: true, hidden: 'true', focused: false });
  expect(snapshot.shape).toContain('toast--card');
  await page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2);
  await page.keyboard.press('Enter');
  expect(await page.getByLabel('Undo count', { exact: true }).allTextContents()).not.toContain('1');
  await page.clock.runFor(249);
  expect(await page.evaluate(() => window.departingSlot.isConnected)).toBe(true);
  await page.clock.runFor(1);
  expect(await page.evaluate(() => window.departingSlot.isConnected)).toBe(false);
  // A new non-interactive pill must not inherit the departing result's hold.
  await page.evaluate(async () => (await import('/src/lib/toastStore.ts')).showToast({ message: 'After clear', tone: 'success' }));
  await page.clock.runFor(2999);
  await expect(region(page).getByText('After clear', { exact: true })).toBeVisible();
  await page.clock.runFor(1);
  await expect(page.locator('.toast-slot--leaving')).toHaveCount(1);
  await attach(info, 'clear-lifecycle', { ...snapshot, retainedUntilMs: 249, removedAtMs: 250, successorDwellMs: 3000, undoCalls: 0 });
});

test('keyed transient and pinned transitions retain one slot without replaying entrance inside nested modals', async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await button(page, 'Open Bottom drawer').click();
  await button(page, 'Nested dialog').click();
  const post = (stage) => page.evaluate(async (stage) => {
    const { showToast } = await import('/src/lib/toastStore.ts');
    showToast({ key: 'promotion-merge', sessionId: '0196b000-0000-7000-8000-000000000001',
      message: `Promotion ${stage}`, subtitle: 'Workspace', detail: stage === 'progress' ? undefined : 'Original diagnostic',
      tone: stage === 'failure' ? 'error' : 'success', inProgress: stage === 'progress',
      action: stage === 'failure' ? { label: 'Retry merge', onClick: () => { window.retryCalls = (window.retryCalls ?? 0) + 1; } } : undefined });
  }, stage);
  await post('progress');
  await finishMotion(page);
  await page.evaluate(() => { window.originalSlot = document.querySelector('.toast-slot'); });
  const stages = [];
  for (const stage of ['failure', 'result', 'failure']) {
    await post(stage);
    await expect(region(page).getByText(`Promotion ${stage}`, { exact: true })).toBeVisible();
    const state = await page.evaluate(() => {
      const slots = [...document.querySelectorAll('.toast-slot')];
      return { count: slots.length, sameSlot: slots[0] === window.originalSlot,
        leaving: slots[0].classList.contains('toast-slot--leaving'), opacity: getComputedStyle(slots[0]).opacity,
        running: slots[0].getAnimations().filter((a) => a.playState === 'running').length };
    });
    expect(state).toEqual({ count: 1, sameSlot: true, leaving: false, opacity: '1', running: 0 });
    stages.push({ stage, ...state });
    if (stage === 'failure') {
      await expect(region(page).getByRole('button', { name: 'Retry merge', exact: true })).toBeVisible();
      await expect(region(page).getByRole('button', { name: 'Open session', exact: true })).toHaveCount(0);
      await expect(region(page).getByRole('button', { name: 'Copy error', exact: true })).toBeVisible();
    }
  }
  await info.attach('keyed-attention', { body: await page.screenshot({ animations: 'allow' }), contentType: 'image/png' });
  await keyActivate(page, 'Retry merge');
  expect(await page.evaluate(() => window.retryCalls)).toBe(1);
  await attach(info, 'keyed-stages', stages);
});

test('entrance progress survives a modal transfer before its first 180ms completes', async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.evaluate(() => {
    window.entryFrames = [];
    window.entryDone = false;
    let transferred = false;
    const start = performance.now();
    const frame = () => {
      const slot = document.querySelector('.toast-slot');
      const t = performance.now() - start;
      if (slot) {
        const animation = slot.getAnimations().find((a) => a instanceof CSSAnimation);
        const style = getComputedStyle(slot);
        window.entryFrames.push({ t, opacity: Number(style.opacity), progress: animation?.effect.getComputedTiming().progress,
          owner: !!slot.closest('.orbit-overlay'), delay: style.animationDelay });
        if (!transferred && t >= 50 && animation) {
          transferred = true;
          [...document.querySelectorAll('button')].find((b) => b.textContent === 'Open Dialog').click();
        }
      }
      if (t < 400) requestAnimationFrame(frame); else window.entryDone = true;
    };
    [...document.querySelectorAll('button')].find((b) => b.textContent === 'Error notice').click();
    requestAnimationFrame(frame);
  });
  await page.waitForFunction(() => window.entryDone);
  const frames = await page.evaluate(() => window.entryFrames);
  await attach(info, 'native-entrance-transfer', frames);
  expect(frames.some((s) => s.opacity > 0 && s.opacity < 1)).toBe(true);
  expect(frames.some((s) => s.owner && s.opacity > 0 && s.opacity < 1)).toBe(true);
  for (let i = 1; i < frames.length; i++) expect(frames[i].opacity).toBeGreaterThanOrEqual(frames[i - 1].opacity);
  expect(frames.at(-1).opacity).toBe(1);
});
