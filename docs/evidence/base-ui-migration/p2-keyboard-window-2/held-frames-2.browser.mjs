import { test, expect } from '@playwright/test';

// The windows this task fixes, without CDP, so on all eight projects (WebKit included); method as
// ../p2-keyboard-window/menu-held-frames.browser.mjs (unchanged). The page's animation frames are held while the
// keys are pressed: Base UI moves focus into an opened popup on the next frame, so with no frame every key after the
// opener arrives before that move, whatever the host load. The keys are ordinary Playwright presses (trusted, with the
// browser's own Enter/Space activation and Tab navigation); the frames are released after the last key. Each case
// must end as the same keys end with focus already in the popup (keyboard-window-2.browser.mjs, paced).
// Popconfirm is recorded, not fixed: its cases assert only that the answer is the paced one (never confirmed, and
// cancelled only where Tab, Enter on Cancel cancels).
const choices = '/ui-migration/choices.html';
const overlays = '/ui-migration/overlays.html';
const submenu = (url, trigger, open, extra = {}) => ({ url, trigger, open, window: true, ...extra });
const SESSION = submenu(`${choices}?system=orbit&sample=session`, 'Session actions', ['Enter', 'ArrowDown']);
const FIELD = submenu(choices, 'Session actions', ['ArrowDown', 'ArrowDown']);
// [name, page, keys, expected]: `output` is [output label, its text after the keys] (unchanged when null), `popups`
// the shown popups, `focus` a prefix of the focused element's role:name.
const CASES = [
  ...[['session', SESSION, 'Picked'], ['field', FIELD, 'Action']].flatMap(([name, page, output]) => [
    [`${name} submenu → ⏎`, page, ['ArrowRight', 'Enter'], { output: [output, 'codex'], popups: 'none', focus: 'button:Session actions' }],
    [`${name} submenu → ↓ ⏎`, page, ['ArrowRight', 'ArrowDown', 'Enter'], { output: [output, 'claude'], popups: 'none', focus: 'button:Session actions' }],
    [`${name} submenu → ↑ ⏎`, page, ['ArrowRight', 'ArrowUp', 'Enter'], { output: [output, 'claude'], popups: 'none', focus: 'button:Session actions' }],
    [`${name} submenu → Home ⏎`, page, ['ArrowRight', 'Home', 'Enter'], { output: [output, 'codex'], popups: 'none', focus: 'button:Session actions' }],
    [`${name} submenu → End ⏎`, page, ['ArrowRight', 'End', 'Enter'], { output: [output, 'claude'], popups: 'none', focus: 'button:Session actions' }],
    [`${name} submenu → Space`, page, ['ArrowRight', 'Space'], { output: [output, 'codex'], popups: 'none', focus: 'button:Session actions' }],
    [`${name} submenu → ←`, page, ['ArrowRight', 'ArrowLeft'], { output: null, popups: 'menu×1', focus: 'menuitem:Provider' }],
    [`${name} submenu ⏎ ⏎`, page, ['Enter', 'Enter'], { output: [output, 'codex'], popups: 'none', focus: 'button:Session actions' }],
    [`${name} submenu ⏎ ↓ ⏎`, page, ['Enter', 'ArrowDown', 'Enter'], { output: [output, 'claude'], popups: 'none', focus: 'button:Session actions' }],
    [`${name} submenu → Tab`, page, ['ArrowRight', 'Tab'], { output: null, popups: 'none' }],
    [`${name} submenu → Shift+Tab`, page, ['ArrowRight', 'Shift+Tab'], { output: null, popups: 'menu×1', focus: 'menuitem:Provider' }],
  ]),
  ['menu ⏎ Tab', { url: choices, trigger: 'Add attachment', window: true }, ['Enter', 'Tab'], { output: null, popups: 'none', focus: 'button:Open context' }],
  ['menu ⏎ Tab ⏎', { url: choices, trigger: 'Add attachment', window: true }, ['Enter', 'Tab', 'Enter'], { output: null, popups: 'dialog:Context', focus: 'dialog:Context' }],
  ['menu ⏎ Shift+Tab', { url: choices, trigger: 'Add attachment', window: true }, ['Enter', 'Shift+Tab'], { output: null, popups: 'none', focus: 'button:Add attachment' }],
  ['menu ↓ Tab', { url: choices, trigger: 'Add attachment', window: true }, ['ArrowDown', 'Tab'], { output: null, popups: 'none', focus: 'button:Open context' }],
  ['select ↓ Tab', { url: choices, trigger: 'Expires', role: 'combobox', window: true }, ['ArrowDown', 'Tab'], { output: null, popups: 'none', focus: 'combobox:Workspace' }],
  ['select ⏎ Tab', { url: choices, trigger: 'Expires', role: 'combobox', window: true }, ['Enter', 'Tab'], { output: null, popups: 'none', focus: 'combobox:Workspace' }],
  ['select ↓ Shift+Tab', { url: choices, trigger: 'Expires', role: 'combobox', window: true }, ['ArrowDown', 'Shift+Tab'], { output: null, popups: 'none', focus: 'combobox:Expires' }],
  ['sample select ↓ Tab', { url: `${choices}?system=orbit&sample=expiry`, trigger: 'Sample choice', role: 'combobox', window: true }, ['ArrowDown', 'Tab'], { output: null, popups: 'none', focus: 'combobox:Sample choice' }],
  ['dialog ⏎ ⏎', { url: overlays, trigger: 'Orbit dialog' }, ['Enter', 'Enter'], { popups: 'dialog:Edit workspace', focus: 'dialog:' }],
  ['dialog ⏎ Tab', { url: overlays, trigger: 'Orbit dialog' }, ['Enter', 'Tab'], { popups: 'dialog:Edit workspace', focus: 'button:Close' }],
  ['dialog ⏎ Tab ⏎', { url: overlays, trigger: 'Orbit dialog' }, ['Enter', 'Tab', 'Enter'], { popups: 'none', focus: 'button:Orbit dialog' }],
  ['dialog ⏎ Shift+Tab', { url: overlays, trigger: 'Orbit dialog' }, ['Enter', 'Shift+Tab'], { popups: 'dialog:Edit workspace', focus: 'button:Save' }],
  ['dialog ⏎ Escape', { url: overlays, trigger: 'Orbit dialog' }, ['Enter', 'Escape'], { popups: 'none', focus: 'button:Orbit dialog' }],
  ['confirm ⏎ ⏎', { url: overlays, trigger: 'Orbit confirm' }, ['Enter', 'Enter'], { popups: 'none', focus: 'button:Orbit confirm', ran: 'Cancel' }],
  ['confirm ⏎ Space', { url: overlays, trigger: 'Orbit confirm' }, ['Enter', 'Space'], { popups: 'none', focus: 'button:Orbit confirm', ran: 'Cancel' }],
  ['confirm ⏎ Tab', { url: overlays, trigger: 'Orbit confirm' }, ['Enter', 'Tab'], { popups: 'alertdialog:Delete runner?', focus: 'button:Delete' }],
  ['confirm ⏎ Tab ⏎', { url: overlays, trigger: 'Orbit confirm' }, ['Enter', 'Tab', 'Enter'], { popups: 'none', focus: 'button:Orbit confirm', ran: 'Delete' }],
  ['confirm ⏎ Escape', { url: overlays, trigger: 'Orbit confirm' }, ['Enter', 'Escape'], { popups: 'none', focus: 'button:Orbit confirm' }],
  ...[['⏎ ⏎', ['Enter', 'Enter'], 'none'], ['⏎ Space', ['Enter', 'Space'], 'none'], ['⏎ Escape', ['Enter', 'Escape'], 'none'],
    ['⏎ Tab', ['Enter', 'Tab'], 'none'], ['⏎ Tab ⏎', ['Enter', 'Tab', 'Enter'], 'cancelled'], ['⏎ Shift+Tab', ['Enter', 'Shift+Tab'], 'none']]
    .map(([name, keys, answer]) => [`popconfirm ${name} (recorded)`, { url: `${choices}?system=orbit&sample=popconfirm`, trigger: 'Delete task' }, keys,
      { answer }]),
];

function pageState() {
  const describe = (el) => el instanceof Element
    ? `${el.getAttribute('role') ?? el.tagName.toLowerCase()}:${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 24)}` : String(el);
  const shown = (el) => { const box = el.getBoundingClientRect(); return box.width > 0 && box.height > 0; };
  const named = (el) => {
    const ids = el.getAttribute('aria-labelledby');
    const title = ids ? ids.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' ') : el.getAttribute('aria-label') ?? el.textContent;
    return `${el.getAttribute('role')}:${(title ?? '').trim().slice(0, 20)}`;
  };
  const popups = [...document.querySelectorAll('[role="menu"],[role="listbox"],[role="dialog"],[role="alertdialog"],[role="tooltip"]')].filter(shown);
  const lists = popups.filter((el) => ['menu', 'listbox'].includes(el.getAttribute('role')));
  const others = popups.filter((el) => !lists.includes(el)).map(named);
  const summary = [...(lists.length ? [`${lists[0].getAttribute('role')}×${lists.length}`] : []), ...others].join('+') || 'none';
  const outputs = Object.fromEntries([...document.querySelectorAll('output[aria-label]')].map((el) => [el.getAttribute('aria-label'), el.textContent]));
  return { popups: summary, count: popups.length, active: describe(document.activeElement), outputs };
}

function observeKeys(stateSource) {
  const state = new Function(`return (${stateSource})`)();
  window.keyLog = [];
  document.addEventListener('keydown', (event) => {
    const { popups, count, active } = state();
    const target = event.target instanceof Element
      ? `${event.target.getAttribute('role') ?? event.target.tagName.toLowerCase()}:${(event.target.getAttribute('aria-label') ?? event.target.textContent ?? '').trim().slice(0, 24)}` : String(event.target);
    window.keyLog.push({ key: event.key, shift: event.shiftKey, target, trusted: event.isTrusted, focused: active, popups, count });
  }, true);
}

// Held frames get ids far above the browser's own, so a cancel of a frame requested before the hold still reaches
// the browser and a cancel of a sentinel id (floating-ui's autoUpdate cancels -1) stays a no-op.
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

for (const [name, setup, keys, expected] of CASES) {
  test(`${name} with frames held`, async ({ page }, info) => {
    await page.goto(setup.url);
    await expect(page.getByTestId('theme')).toHaveText(info.project.use.colorScheme);
    await page.evaluate(() => document.fonts.ready);
    await page.getByRole(setup.role ?? 'button', { name: setup.trigger, exact: true }).first().focus();
    if (setup.open) {
      for (const key of setup.open) { await page.keyboard.press(key); await page.waitForTimeout(300); }
      await expect(page.getByRole('menuitem', { name: /^Provider/ })).toBeFocused();
      await page.waitForTimeout(300);
    }
    const before = await page.evaluate(pageState);
    await page.evaluate(observeKeys, pageState.toString());
    await hold(page);
    for (const key of keys) await page.keyboard.press(key);
    const held = await page.evaluate(() => window.keyLog);
    const heldFrames = await release(page);
    await page.waitForTimeout(500);
    const after = await page.evaluate(pageState);
    const keyLog = await page.evaluate(() => window.keyLog);
    const record = { name, keys, heldFrames, before, after, keyLog };
    await info.attach('held-frames-2', { body: JSON.stringify(record, null, 2), contentType: 'application/json' });
    const [opener, next] = held.filter((key) => key.trusted && key.key !== 'Shift');
    expect(heldFrames).toBeGreaterThan(0);
    // Menus and selects: the key after the opener reached the opener's target while the popup it opened was shown.
    if (setup.window) {
      expect(next.target).toBe(opener.target);
      expect(next.count).toBeGreaterThan(opener.count);
    }
    if ('output' in expected) {
      const [label, text] = expected.output ?? [];
      if (label) expect(after.outputs[label]).toBe(text);
      else expect(after.outputs).toEqual(before.outputs);
    }
    if (expected.answer) expect(after.outputs.Answer).toBe(expected.answer);
    if (expected.ran) {
      const press = keyLog.filter((key) => key.key === 'Enter' || key.key === ' ').at(-1);
      expect(press.target).toBe(`button:${expected.ran}`);
    }
    if (expected.popups) expect(after.popups).toBe(expected.popups);
    if (expected.focus) expect(after.active.startsWith(expected.focus)).toBe(true);
  });
}
