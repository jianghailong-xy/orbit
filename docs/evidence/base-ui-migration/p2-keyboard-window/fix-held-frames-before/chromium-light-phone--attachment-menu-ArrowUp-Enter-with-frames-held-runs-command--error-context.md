# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: menu-held-frames.browser.mjs >> attachment menu ArrowUp Enter with frames held runs command
- Location: docs/evidence/base-ui-migration/p2-keyboard-window/menu-held-frames.browser.mjs:67:3

# Error details

```
Error: expect(locator).toHaveText(expected) failed

Locator:  getByRole('status', { name: 'Action', exact: true })
Expected: "command"
Received: "none"
Timeout:  15000ms

Call log:
  - Expect "toHaveText" getByRole('status', { name: 'Action', exact: true }) with timeout 15000ms
  - waiting for getByRole('status', { name: 'Action', exact: true })
    34 × locator resolved to <output aria-label="Action">none</output>
       - unexpected value "none"

```

```yaml
- status "Action": none
```

# Test source

```ts
  1  | import { test, expect } from '@playwright/test';
  2  | 
  3  | // The Menu window without CDP, so it runs on all eight projects (WebKit included). The page's animation frames are
  4  | // held while the keys are pressed: Base UI moves focus into an opened menu on the next frame, so with no frame every
  5  | // key after the opener reaches the trigger while the menu is shown, whatever the host load. The keys are ordinary
  6  | // Playwright presses (trusted, with the browser's own Enter activation of a button); the frames are released after
  7  | // the last key. Each sequence must run the item it runs with focus in the menu (keyboard-window.browser.mjs, paced).
  8  | const SEQUENCES = [
  9  |   [['ArrowDown', 'ArrowDown', 'Enter'], 'image'],
  10 |   [['ArrowDown', 'Enter'], 'file'],
  11 |   [['ArrowDown', 'ArrowUp', 'Enter'], 'command'],
  12 |   [['Enter', 'ArrowDown', 'Enter'], 'image'],
  13 |   [['Enter', 'ArrowUp', 'Enter'], 'command'],
  14 |   [['Enter', 'Enter'], 'file'],
  15 |   [['ArrowUp', 'Enter'], 'command'],
  16 |   [['ArrowUp', 'ArrowUp', 'Enter'], 'shell'],
  17 |   [['ArrowUp', 'ArrowDown', 'Enter'], 'file'],
  18 | ];
  19 | 
  20 | function observeKeys() {
  21 |   const describe = (el) => el instanceof Element
  22 |     ? `${el.getAttribute('role') ?? el.tagName.toLowerCase()}:${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 24)}` : String(el);
  23 |   window.keyLog = [];
  24 |   document.addEventListener('keydown', (event) => {
  25 |     const menu = [...document.querySelectorAll('[role="menu"]')].find((el) => el.getBoundingClientRect().height > 0);
  26 |     window.keyLog.push({ key: event.key, target: describe(event.target), trusted: event.isTrusted, focused: describe(document.activeElement),
  27 |       menu: !!menu, highlighted: menu?.querySelector('[data-highlighted]')?.textContent?.trim() ?? null });
  28 |   }, true);
  29 | }
  30 | 
  31 | // Held frames get ids far above the browser's own (which count up from 1), so a cancel of a frame requested before
  32 | // the hold still reaches the browser, and a cancel of a sentinel id (floating-ui's autoUpdate cancels -1) stays a no-op.
  33 | const hold = (page) => page.evaluate(() => {
  34 |   const frames = { request: window.requestAnimationFrame.bind(window), cancel: window.cancelAnimationFrame.bind(window), held: new Map(), next: 2 ** 30 };
  35 |   window.heldFrames = frames;
  36 |   window.requestAnimationFrame = (callback) => { frames.held.set(frames.next, callback); return frames.next++; };
  37 |   window.cancelAnimationFrame = (id) => (frames.held.has(id) ? frames.held.delete(id) : frames.cancel(id));
  38 | });
  39 | const release = (page) => page.evaluate(() => {
  40 |   const frames = window.heldFrames;
  41 |   window.requestAnimationFrame = frames.request;
  42 |   window.cancelAnimationFrame = frames.cancel;
  43 |   const count = frames.held.size;
  44 |   for (const callback of frames.held.values()) frames.request(callback);
  45 |   frames.held.clear();
  46 |   return count;
  47 | });
  48 | 
  49 | async function play(page, info, trigger, keys) {
  50 |   await page.goto('/ui-migration/choices.html');
  51 |   await expect(page.getByTestId('theme')).toHaveText(info.project.use.colorScheme);
  52 |   await page.evaluate(() => document.fonts.ready);
  53 |   await page.evaluate(observeKeys);
  54 |   await trigger.focus();
  55 |   await hold(page);
  56 |   for (const key of keys) await page.keyboard.press(key);
  57 |   const window = await page.evaluate(() => ({ keyLog: window.keyLog, focused: document.activeElement?.textContent?.trim() }));
  58 |   const heldFrames = await release(page);
  59 |   const [opener, next] = window.keyLog.filter((key) => key.trusted);
  60 |   // The window was exercised: the key after the opener reached the opener's target while the menu was shown.
  61 |   expect(next.target).toBe(opener.target);
  62 |   expect(next.menu).toBe(true);
  63 |   return { keys, heldFrames, ...window };
  64 | }
  65 | 
  66 | for (const [keys, runs] of SEQUENCES) {
  67 |   test(`attachment menu ${keys.join(' ')} with frames held runs ${runs}`, async ({ page }, info) => {
  68 |     const action = page.getByRole('status', { name: 'Action', exact: true });
  69 |     const record = await play(page, info, page.getByRole('button', { name: 'Add attachment', exact: true }).first(), keys);
  70 |     await info.attach('menu-held-frames', { body: JSON.stringify(record, null, 2), contentType: 'application/json' });
> 71 |     await expect(action).toHaveText(runs);
     |                          ^ Error: expect(locator).toHaveText(expected) failed
  72 |     await expect(page.getByRole('menu')).toHaveCount(0);
  73 |   });
  74 | }
  75 | 
  76 | // The P2.2 case choices.browser.mjs:592 presses ArrowDown, Enter on this menu without waiting in between.
  77 | test('row actions menu ArrowDown Enter with frames held runs its action and not the row', async ({ page }, info) => {
  78 |   const record = await play(page, info, page.getByRole('button', { name: 'Row actions', exact: true }), ['ArrowDown', 'Enter']);
  79 |   await info.attach('menu-held-frames', { body: JSON.stringify(record, null, 2), contentType: 'application/json' });
  80 |   await expect(page.getByRole('status', { name: 'Row actions', exact: true })).toHaveText('1');
  81 |   await expect(page.getByRole('status', { name: 'Row clicks', exact: true })).toHaveText('0');
  82 |   await expect(page.getByRole('menu')).toHaveCount(0);
  83 | });
  84 | 
```