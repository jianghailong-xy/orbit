import { test, expect } from '@playwright/test';

// The Menu window without CDP, so it runs on all eight projects (WebKit included). The page's animation frames are
// held while the keys are pressed: Base UI moves focus into an opened menu on the next frame, so with no frame every
// key after the opener reaches the trigger while the menu is shown, whatever the host load. The keys are ordinary
// Playwright presses (trusted, with the browser's own Enter activation of a button); the frames are released after
// the last key. Each sequence must run the item it runs with focus in the menu (keyboard-window.browser.mjs, paced).
const SEQUENCES = [
  [['ArrowDown', 'ArrowDown', 'Enter'], 'image'],
  [['ArrowDown', 'Enter'], 'file'],
  [['ArrowDown', 'ArrowUp', 'Enter'], 'command'],
  [['Enter', 'ArrowDown', 'Enter'], 'image'],
  [['Enter', 'ArrowUp', 'Enter'], 'command'],
  [['Enter', 'Enter'], 'file'],
  [['ArrowUp', 'Enter'], 'command'],
  [['ArrowUp', 'ArrowUp', 'Enter'], 'shell'],
  [['ArrowUp', 'ArrowDown', 'Enter'], 'file'],
];

function observeKeys() {
  const describe = (el) => el instanceof Element
    ? `${el.getAttribute('role') ?? el.tagName.toLowerCase()}:${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 24)}` : String(el);
  window.keyLog = [];
  document.addEventListener('keydown', (event) => {
    const menu = [...document.querySelectorAll('[role="menu"]')].find((el) => el.getBoundingClientRect().height > 0);
    window.keyLog.push({ key: event.key, target: describe(event.target), trusted: event.isTrusted, focused: describe(document.activeElement),
      menu: !!menu, highlighted: menu?.querySelector('[data-highlighted]')?.textContent?.trim() ?? null });
  }, true);
}

// Held frames get ids far above the browser's own (which count up from 1), so a cancel of a frame requested before
// the hold still reaches the browser, and a cancel of a sentinel id (floating-ui's autoUpdate cancels -1) stays a no-op.
const hold = (page) => page.evaluate(() => {
  const frames = { request: window.requestAnimationFrame.bind(window), cancel: window.cancelAnimationFrame.bind(window), held: new Map(), next: 2 ** 30 };
  window.heldFrames = frames;
  window.requestAnimationFrame = (callback) => { frames.held.set(frames.next, callback); return frames.next++; };
  window.cancelAnimationFrame = (id) => (frames.held.has(id) ? frames.held.delete(id) : frames.cancel(id));
});
const release = (page) => page.evaluate(() => {
  const frames = window.heldFrames;
  window.requestAnimationFrame = frames.request;
  window.cancelAnimationFrame = frames.cancel;
  const count = frames.held.size;
  for (const callback of frames.held.values()) frames.request(callback);
  frames.held.clear();
  return count;
});

async function play(page, info, trigger, keys) {
  await page.goto('/ui-migration/choices.html');
  await expect(page.getByTestId('theme')).toHaveText(info.project.use.colorScheme);
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(observeKeys);
  await trigger.focus();
  await hold(page);
  for (const key of keys) await page.keyboard.press(key);
  const window = await page.evaluate(() => ({ keyLog: window.keyLog, focused: document.activeElement?.textContent?.trim() }));
  const heldFrames = await release(page);
  const [opener, next] = window.keyLog.filter((key) => key.trusted);
  // The window was exercised: the key after the opener reached the opener's target while the menu was shown.
  expect(next.target).toBe(opener.target);
  expect(next.menu).toBe(true);
  return { keys, heldFrames, ...window };
}

for (const [keys, runs] of SEQUENCES) {
  test(`attachment menu ${keys.join(' ')} with frames held runs ${runs}`, async ({ page }, info) => {
    const action = page.getByRole('status', { name: 'Action', exact: true });
    const record = await play(page, info, page.getByRole('button', { name: 'Add attachment', exact: true }).first(), keys);
    await info.attach('menu-held-frames', { body: JSON.stringify(record, null, 2), contentType: 'application/json' });
    await expect(action).toHaveText(runs);
    await expect(page.getByRole('menu')).toHaveCount(0);
  });
}

// The P2.2 case choices.browser.mjs:592 presses ArrowDown, Enter on this menu without waiting in between.
test('row actions menu ArrowDown Enter with frames held runs its action and not the row', async ({ page }, info) => {
  const record = await play(page, info, page.getByRole('button', { name: 'Row actions', exact: true }), ['ArrowDown', 'Enter']);
  await info.attach('menu-held-frames', { body: JSON.stringify(record, null, 2), contentType: 'application/json' });
  await expect(page.getByRole('status', { name: 'Row actions', exact: true })).toHaveText('1');
  await expect(page.getByRole('status', { name: 'Row clicks', exact: true })).toHaveText('0');
  await expect(page.getByRole('menu')).toHaveCount(0);
});
