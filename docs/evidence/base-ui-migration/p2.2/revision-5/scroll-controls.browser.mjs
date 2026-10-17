import { test, expect } from '@playwright/test';
import { armScrollUnlock, readScrollUnlock, scrollPage } from '../../../../../src/web/ui-migration/choices-scroll-observation.mjs';

// Controlled documents exercise the observation boundary, not Orbit's runtime.
for (const mode of ['lifecycle', 'late', 'retained']) test(`close lifecycle control: ${mode}`, async ({ page }, info) => {
  await page.setContent('<!doctype html><html style="overflow:hidden"><body style="overflow:hidden;margin:0"><button>Focus target</button><div role="dialog" tabindex="-1" style="transition:opacity .2s">Open dialog</div><div style="height:3000px">Scrollable content</div></body></html>');
  const dialog = page.getByRole('dialog');
  const trigger = page.getByRole('button', { name: 'Focus target' });
  await expect(dialog).toBeVisible();
  await dialog.focus();
  await armScrollUnlock(dialog);
  await page.evaluate((mode) => {
    const node = document.querySelector('[role="dialog"]');
    const state = { closedAt: null, releasedAt: null };
    let released;
    state.releaseComplete = new Promise((resolve) => { released = resolve; });
    const release = () => {
      document.documentElement.style.overflow = '';
      document.body.style.overflow = '';
      state.releasedAt = performance.now();
      released();
    };
    const close = () => {
      node.remove();
      state.closedAt = performance.now();
      document.querySelector('button').focus();
      if (mode === 'late') setTimeout(release, 150);
    };
    window.addEventListener('keydown', () => {
      if (mode !== 'lifecycle') return close();
      // A delayed render and a real 200ms CSS exit must not spend cleanup budget.
      setTimeout(() => {
        node.addEventListener('transitionend', close, { once: true });
        node.setAttribute('data-ending-style', '');
        node.style.opacity = '0';
        release();
      }, 150);
    }, { once: true });
    window.scrollControl = state;
  }, mode);
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(trigger).toBeFocused();
  const unlock = await readScrollUnlock(page);
  await info.attach('scroll-unlock', { body: JSON.stringify(unlock, null, 2), contentType: 'application/json' });
  expect(unlock.closedAfterMs).not.toBeNull();
  if (mode === 'late') {
    expect(unlock.readyAfterCloseMs).toBeNull();
    expect(unlock.samples.find((sample) => sample.phase === 'close-deadline').locked).toBe(true);
    const releaseAfterCloseMs = await page.evaluate(async () => {
      await window.scrollControl.releaseComplete;
      return window.scrollControl.releasedAt - window.scrollControl.closedAt;
    });
    await info.attach('late-release', { body: JSON.stringify({ releaseAfterCloseMs }), contentType: 'application/json' });
    expect(releaseAfterCloseMs).toBeGreaterThan(unlock.limitMs);
    return;
  }
  const scroll = await scrollPage(page, info);
  await info.attach('page-scroll', { body: JSON.stringify(scroll, null, 2), contentType: 'application/json' });
  expect(scroll.scrollHeight).toBeGreaterThan(scroll.viewportHeight);
  expect(scroll.input?.trusted).toBe(true);
  expect(scroll.input?.kind).toBe(info.project.use.isMobile ? 'PageDown' : 'wheel');
  if (mode === 'retained') {
    expect(unlock.readyAfterCloseMs).toBeNull();
    expect(unlock.finalRead.locked).toBe(true);
    expect(scroll.movedAfterMs).toBeNull();
    expect(scroll.after).toBe(scroll.before);
  } else {
    expect(unlock.unlockedAfterMs).toBeGreaterThan(100);
    expect(unlock.closedAfterMs).toBeGreaterThan(unlock.unlockedAfterMs);
    expect(unlock.exitTransitionDuration).toBe('0.2s');
    expect(unlock.readyAfterCloseMs).not.toBeNull();
    expect(unlock.readyAfterCloseMs).toBeLessThanOrEqual(unlock.limitMs);
    expect(unlock.finalRead.locked).toBe(false);
    expect(scroll.movedAfterMs).not.toBeNull();
    expect(scroll.movedAfterMs).toBeLessThanOrEqual(scroll.limitMs);
    expect(scroll.after).toBeGreaterThan(scroll.before);
  }
  await expect(trigger).toBeFocused();
});
