import { test, expect } from '@playwright/test';
import { expectExpired } from './toasts-checks.mjs';

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
  const after = await page.locator('.toast-slot:not(.toast-slot--leaving)').count();
  await info.attach('timer-after-portal', { body: JSON.stringify({ after, releasedAfterMs: 6001 }), contentType: 'application/json' });
  expect(after).toBe(0);
  await expectExpired(page, 1);
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

const region = (page) => page.getByRole('region', { name: 'Notifications', exact: true });
const attach = (info, name, value) => info.attach(name, { body: JSON.stringify(value, null, 2), contentType: 'application/json' });
const finishMotion = (page) => page.evaluate(async () => {
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  await Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity).map((a) => a.finished.catch(() => {})));
});

for (const kind of ['Dialog', 'Drawer', 'Bottom drawer']) {
  test(`notification card stays fixed through ${kind} entry, nested layers and exit`, async ({ page }, info) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await button(page, 'Error notice').click();
    await page.mouse.move(0, 0);
    await finishMotion(page);
    await page.evaluate(() => {
      const card = document.querySelector('.toast');
      window.cardMotion = { before: card.getBoundingClientRect().toJSON(), samples: [], phase: 'before', running: true };
      const sample = () => {
        const current = document.querySelector('.toast');
        const r = current?.getBoundingClientRect();
        window.cardMotion.samples.push({ phase: window.cardMotion.phase, t: performance.now(), sameNode: current === card,
          card: r?.toJSON(), opacity: current ? getComputedStyle(current).opacity : null,
          overlays: [...document.querySelectorAll('.orbit-overlay')].map((el) => {
            const s = getComputedStyle(el);
            return { scale: s.scale, translate: s.translate, opacity: s.opacity, ending: el.hasAttribute('data-ending-style') };
          }) });
        if (window.cardMotion.running) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    const phase = (name) => page.evaluate((value) => { window.cardMotion.phase = value; }, name);
    await phase('open');
    await button(page, `Open ${kind}`).click();
    await finishMotion(page);
    for (let depth = 1; depth <= 2; depth++) {
      await phase(`nested-${depth}`);
      await button(page, 'Nested dialog').click();
      await finishMotion(page);
      await expect(region(page)).toBeVisible();
    }
    for (let depth = 2; depth >= 0; depth--) {
      await phase(`close-${depth}`);
      await page.keyboard.press('Escape');
      await finishMotion(page);
      await expect(region(page)).toBeVisible();
    }
    const motion = await page.evaluate(() => { window.cardMotion.running = false; return window.cardMotion; });
    await attach(info, 'continuous-card-motion', motion);
    expect(motion.samples.length).toBeGreaterThan(20);
    const shifted = motion.samples.filter((s) => !s.sameNode || !s.card || s.opacity !== '1' ||
      ['x', 'y', 'width', 'height'].some((key) => Math.abs(s.card[key] - motion.before[key]) > 0.1));
    expect(shifted, 'existing card DOM, opacity and geometry stay stable at every sampled frame').toEqual([]);
    // These checks also prove the original popup transitions still run in both directions.
    for (const name of ['open', 'nested-1', 'nested-2', 'close-2', 'close-1', 'close-0']) {
      expect(motion.samples.some((s) => s.phase === name && s.overlays.some((o) =>
        Number(o.opacity) < 1 || (o.translate !== 'none' && o.translate !== '0px') || (o.scale !== 'none' && o.scale !== '1'))), name).toBe(true);
    }
    await expect(button(page, `Open ${kind}`)).toBeFocused();
  });
}

test('stationary hover stays paused across nested modal owners then resumes for exactly six seconds', async ({ page }, info) => {
  await page.clock.install({ time: new Date('2026-10-04T00:00:00Z') });
  await page.clock.pauseAt(new Date('2026-10-04T00:00:01Z'));
  await button(page, 'Complete session').click();
  await region(page).getByRole('button', { name: 'Undo completing Fix login redirect', exact: true }).hover();
  await page.clock.runFor(10000);
  await expect(region(page)).toBeVisible();
  for (const name of ['Open Dialog', 'Nested dialog']) {
    await button(page, name).focus();
    await page.keyboard.press('Enter');
    await page.clock.runFor(10200);
    await expect(region(page)).toBeVisible();
  }
  for (let i = 0; i < 2; i++) {
    await page.keyboard.press('Escape');
    await page.clock.runFor(10200);
    await expect(region(page)).toBeVisible();
  }
  await page.mouse.move(0, 0);
  await page.clock.runFor(5999);
  await expect(region(page)).toBeVisible();
  await page.clock.runFor(1);
  await expectExpired(page);
  await attach(info, 'stationary-hover', { pausedAcrossFourTransfersMs: 40800, pausedBeforeTransfersMs: 10000, visibleAfterReleaseMs: 5999, expiredAfterReleaseMs: 6000 });
});

test('unhovered notifications retain their original deadline through modal owner changes', async ({ page }, info) => {
  await page.clock.install({ time: new Date('2026-10-04T00:00:00Z') });
  await page.clock.pauseAt(new Date('2026-10-04T00:00:01Z'));
  await button(page, 'Complete session').click();
  await page.mouse.move(0, 0);
  await page.clock.runFor(2000);
  await button(page, 'Open Drawer').focus();
  await page.keyboard.press('Enter');
  await page.clock.runFor(200);
  await page.keyboard.press('Escape');
  await page.clock.runFor(3799);
  await expect(region(page)).toBeVisible();
  await page.clock.runFor(1);
  await expectExpired(page);
  await attach(info, 'unchanged-deadline', { visibleAtTotalMs: 5999, expiredAtTotalMs: 6000 });
});

for (const [kind, trigger] of [['Dialog', 'Open Dialog'], ['Drawer', 'Open Drawer'], ['Bottom drawer', 'Open Bottom drawer'], ['Confirmation', 'Confirm save']]) {
  test(`notification pixels stay intact through ${kind} opening and closing`, async ({ page }, info) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await button(page, 'Error notice').click();
    await page.mouse.move(0, 0);
    await finishMotion(page);
    await info.attach('before-motion', { body: await region(page).screenshot({ animations: 'allow' }), contentType: 'image/png' });
    await button(page, trigger).click();
    for (const phase of ['opening', 'closing']) {
      if (phase === 'closing') await page.keyboard.press('Escape');
      const frozen = await page.evaluate(async () => {
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const popup = [...document.querySelectorAll('.orbit-overlay')].find((el) => el.getClientRects().length);
        const popupAnimationCount = popup?.getAnimations().length ?? 0;
        window.frozenPopupAnimations = document.getAnimations().filter((a) =>
          a.effect?.target?.matches?.('.orbit-overlay, .orbit-overlay-backdrop'));
        for (const animation of window.frozenPopupAnimations) {
          animation.pause();
          animation.currentTime = Number(animation.effect.getTiming().duration) / 2;
        }
        const s = popup && getComputedStyle(popup);
        return { count: popupAnimationCount, scale: s?.scale, translate: s?.translate, opacity: s?.opacity };
      });
      if (kind === 'Confirmation') {
        // The original holder mounts already open, then unmounts on resolution:
        // it has no popup entry/exit transition in either baseline browser.
        await expect(page.locator('.orbit-confirm')).toHaveCount(phase === 'opening' ? 1 : 0);
        expect(frozen.count).toBe(0);
      } else {
        expect(frozen.count, 'the real popup animation must exist; it is paused only for the screenshot').toBeGreaterThan(0);
      }
      await page.mouse.move(0, 0);
      // Only the popup/backdrop are frozen. Let button hover colors settle so
      // screenshots compare the same moment instead of an unrelated hover fade.
      await page.evaluate(async () => {
        const frozen = new Set(window.frozenPopupAnimations);
        await Promise.all(document.getAnimations().filter((a) => !frozen.has(a) &&
          a.effect?.getComputedTiming().iterations !== Infinity).map((a) => a.finished.catch(() => {})));
      });
      await info.attach(`${phase}-page`, { body: await page.screenshot({ animations: 'allow' }), contentType: 'image/png' });
      await info.attach(`${phase}-notification`, { body: await region(page).screenshot({ animations: 'allow' }), contentType: 'image/png' });
      await attach(info, `${phase}-animation`, frozen);
      await page.evaluate(() => window.frozenPopupAnimations.forEach((a) => a.play()));
      await finishMotion(page);
    }
    await expect(region(page)).toBeVisible();
  });
}

test('a newly posted notification still plays its original entrance animation once', async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  // Start on the first animation frame so an intermediate frame cannot be missed by an actionability wait.
  await page.evaluate(() => {
    window.freshToastFrames = [];
    const start = performance.now();
    let firstCardAt;
    const frame = () => {
      const card = document.querySelector('.toast-slot');
      if (card) {
        firstCardAt ??= performance.now();
        const s = getComputedStyle(card);
        window.freshToastFrames.push({ t: performance.now() - start, opacity: Number(s.opacity), transform: s.transform });
      }
      if (firstCardAt === undefined || performance.now() - firstCardAt < 700) requestAnimationFrame(frame);
      else window.freshToastDone = true;
    };
    requestAnimationFrame(frame);
  });
  await button(page, 'Error notice').click();
  await page.waitForFunction(() => window.freshToastDone);
  const frames = await page.evaluate(() => window.freshToastFrames);
  await attach(info, 'fresh-notification-animation', frames);
  expect(frames.some((f) => f.opacity > 0 && f.opacity < 1 && f.transform !== 'none')).toBe(true);
  expect(frames.at(-1).opacity).toBe(1);
  expect(frames.at(-1).transform).toBe('none');
});
