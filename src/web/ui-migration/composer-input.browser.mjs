import { test, expect } from '@playwright/test';
import { IMPLS, FIELD, attachJson, open, settle } from './composer-checks.mjs';

// P3.1 input behavior: the WorkspaceView composer's and TaskDetailPanel comment box's own key,
// menu, paste and caret logic (copied into the fixture unchanged) running over the AntD field and
// over the Orbit Textarea. Each step records what a user would see; both runs must record the same.

/** Install a capture-phase log of the events an IME and the keyboard produce on the field. */
async function logEvents(page) {
  await page.evaluate((selector) => {
    const field = document.querySelector(selector);
    window.__events = [];
    for (const type of ['keydown', 'compositionstart', 'compositionupdate', 'compositionend', 'input', 'paste']) {
      field.addEventListener(type, (event) => window.__events.push([type, event.key ?? event.inputType ?? null,
        'isComposing' in event ? event.isComposing : null, event.defaultPrevented]), true);
    }
  }, FIELD);
}

async function snapshot(page, field) {
  await settle(page);
  return page.evaluate((selector) => {
    const element = document.querySelector(selector);
    const menu = document.querySelector('.composer-slash-menu, .tdp-mention-menu');
    return {
      value: element.value,
      caret: [element.selectionStart, element.selectionEnd],
      focused: document.activeElement === element,
      height: element.getBoundingClientRect().height,
      menu: menu ? [...menu.children].map((option) => ({ text: option.textContent,
        active: option.getAttribute('aria-selected') === 'true' || option.classList.contains('active') })) : null,
      chips: [...document.querySelectorAll('.composer-chip')].map((chip) => [chip.className, chip.textContent]),
      staged: [...document.querySelectorAll('.composer-file-name, .composer-attach')].map((node) => node.textContent || 'image'),
      sent: document.querySelector('[aria-label="Sent messages"], [aria-label="Posted comments"]').textContent,
      events: window.__events?.splice(0) ?? [],
    };
  }, FIELD);
}

/** Run one script on both pages and require identical recordings. */
async function compareInput(page, info, scenario, name, script, query = '') {
  const runs = {};
  for (const impl of IMPLS) {
    const field = await open(page, info, impl, scenario, query);
    await logEvents(page);
    const steps = [];
    const step = async (label) => steps.push({ label, ...(await snapshot(page, field)) });
    await script({ page, field, step, impl });
    runs[impl] = steps;
  }
  await attachJson(info, name, runs);
  expect(runs.orbit).toEqual(runs.ant);
  return runs.orbit;
}

/** Compose `preedit` candidates, confirm with Enter while composing, then commit `commit`. */
async function compose(page, field, info, preedits, commit) {
  if (info.project.use.browserName === 'chromium') {
    // Chromium: real IME composition through DevTools; the browser marks the confirming Enter.
    const cdp = await page.context().newCDPSession(page);
    for (const text of preedits) await cdp.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length });
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    await cdp.send('Input.insertText', { text: commit });
    await cdp.detach();
    return;
  }
  // WebKit has no IME automation: replay an IME's events. Text goes in through trusted
  // insertText; the composition markers and the confirming Enter (keyCode 229) are synthetic.
  const start = await field.evaluate((element) => element.selectionStart);
  await field.dispatchEvent('compositionstart', { data: '' });
  let previous = '';
  for (const text of preedits) {
    await field.evaluate((element, [from, length]) => element.setSelectionRange(from, from + length), [start, previous.length]);
    await field.dispatchEvent('compositionupdate', { data: text });
    await page.keyboard.insertText(text);
    previous = text;
  }
  await field.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229, isComposing: true, bubbles: true, cancelable: true });
  await field.evaluate((element, [from, length]) => element.setSelectionRange(from, from + length), [start, previous.length]);
  await page.keyboard.insertText(commit);
  await field.dispatchEvent('compositionend', { data: commit });
}

test('session: Enter sends, Shift+Enter breaks the line, Chinese composition never sends', async ({ page }, info) => {
  const steps = await compareInput(page, info, 'session', 'session-keys-and-ime', async ({ page, field, step }) => {
    await field.click();
    await field.pressSequentially('hello');
    await field.press('Shift+Enter');
    await field.pressSequentially('world');
    await step('shift-enter-newline');
    await field.press('Enter');
    await step('enter-sent');
    await field.pressSequentially('hi ');
    // A long preedit wraps: the field grows while the composition is still open.
    await compose(page, field, info, ['zhong', 'zhongwen', 'zhongwenshurufa '.repeat(5).trim()], '中文输入法');
    await step('composition-committed');
    await field.press('Enter');
    await step('enter-after-composition-sent');
    await field.pressSequentially('@orb');
    await compose(page, field, info, ['da'], '大');
    await step('composition-inside-mention-token');
  });
  const byLabel = Object.fromEntries(steps.map((entry) => [entry.label, entry]));
  expect(byLabel['shift-enter-newline']).toMatchObject({ value: 'hello\nworld', sent: '[]', focused: true, height: 62 });
  expect(byLabel['enter-sent']).toMatchObject({ value: '', sent: '["hello\\nworld"]', focused: true, height: 38 });
  expect(byLabel['composition-committed']).toMatchObject({ value: 'hi 中文输入法', sent: '["hello\\nworld"]' });
  // The Enter that confirmed the candidate arrived while composing and was not a send.
  expect(byLabel['composition-committed'].events.some(([type, key, composing]) => type === 'keydown' && key === 'Enter' && composing)).toBe(true);
  expect(byLabel['enter-after-composition-sent']).toMatchObject({ value: '', sent: '["hello\\nworld","hi 中文输入法"]' });
  expect(byLabel['composition-inside-mention-token']).toMatchObject({ value: '@orb大', menu: null });
});

test('comment: Ctrl/Meta+Enter posts, plain Enter and composition keep editing', async ({ page }, info) => {
  const steps = await compareInput(page, info, 'comment', 'comment-keys-and-ime', async ({ page, field, step }) => {
    await field.click();
    await field.pressSequentially('First');
    await field.press('Enter');
    await field.pressSequentially('second');
    await field.press('Shift+Enter');
    await step('enter-and-shift-enter-newlines');
    await compose(page, field, info, ['pinglun'], '评论');
    await step('composition-committed');
    await field.press('ControlOrMeta+Enter');
    await step('posted');
  });
  const byLabel = Object.fromEntries(steps.map((entry) => [entry.label, entry]));
  expect(byLabel['enter-and-shift-enter-newlines']).toMatchObject({ value: 'First\nsecond\n', sent: '[]' });
  expect(byLabel['composition-committed']).toMatchObject({ value: 'First\nsecond\n评论', sent: '[]' });
  expect(byLabel.posted).toMatchObject({ value: '', sent: '[{"body":"First\\nsecond\\n评论","mentions":[]}]' });
});

test('session menus: arrows, Enter, Tab, Escape and pointer keep the field focused with the caret at the end', async ({ page }, info) => {
  const steps = await compareInput(page, info, 'session', 'session-menus', async ({ page, field, step }) => {
    await field.click();
    await field.pressSequentially('/re');
    await step('slash-open');
    await field.press('ArrowDown');
    await field.press('ArrowDown');
    await field.press('ArrowDown');
    await step('slash-arrow-wraps-to-first');
    await field.press('ArrowUp');
    await step('slash-arrow-up-wraps-to-last');
    await field.press('Enter');
    await step('slash-enter-picked');
    await field.pressSequentially('/rel');
    await field.press('Tab');
    await step('slash-tab-picked');
    await field.pressSequentially('/');
    await field.press('Escape');
    await step('slash-escape-dismissed');
    // While composing, the menu keys belong to the IME, not the menu.
    await field.dispatchEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown', keyCode: 229, isComposing: true, bubbles: true, cancelable: true });
    await field.press('Backspace');
    await field.pressSequentially('@or');
    await field.dispatchEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown', keyCode: 229, isComposing: true, bubbles: true, cancelable: true });
    await field.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229, isComposing: true, bubbles: true, cancelable: true });
    await step('mention-ignores-composing-keys');
    await field.press('ArrowDown');
    await field.press('Enter');
    await step('mention-picked');
    await field.pressSequentially('#rel');
    await step('reference-open');
    await field.press('Enter');
    await step('reference-picked');
    await field.pressSequentially('@web');
    await page.getByRole('option').filter({ hasText: '@web-pilot' }).click();
    await step('mention-picked-with-pointer');
    await field.press('Enter');
    await step('sent-with-materialized-reference');
  });
  const byLabel = Object.fromEntries(steps.map((entry) => [entry.label, entry]));
  expect(byLabel['slash-open'].menu.map((option) => option.text)).toEqual(['/refactorcmdRestructure without changing behavior', '/releaseskillCut a release', '/reviewcmdReview the current diff']);
  expect(byLabel['slash-arrow-wraps-to-first'].menu.findIndex((option) => option.active)).toBe(0);
  expect(byLabel['slash-arrow-up-wraps-to-last'].menu.findIndex((option) => option.active)).toBe(2);
  expect(byLabel['slash-enter-picked']).toMatchObject({ value: '/review ', caret: [8, 8], focused: true, menu: null });
  expect(byLabel['slash-tab-picked']).toMatchObject({ value: '/review /release ', caret: [17, 17], focused: true, menu: null });
  expect(byLabel['slash-escape-dismissed']).toMatchObject({ value: '/review /release /', menu: null, focused: true });
  expect(byLabel['mention-ignores-composing-keys'].menu.findIndex((option) => option.active)).toBe(0);
  expect(byLabel['mention-picked']).toMatchObject({ value: '/review /release @orbit-docs ', focused: true, menu: null });
  expect(byLabel['reference-picked']).toMatchObject({ value: '/review /release @orbit-docs #Release checklist ', focused: true });
  expect(byLabel['reference-picked'].chips).toEqual([['composer-chip composer-chip--mention', '@orbit-docs'], ['composer-chip composer-chip--list', '#Release checklist']]);
  expect(byLabel['mention-picked-with-pointer']).toMatchObject({ value: '/review /release @orbit-docs #Release checklist @web-pilot ', focused: true });
  expect(byLabel['sent-with-materialized-reference'].sent).toBe('["/review /release @orbit-docs [Release checklist](orbit-list:list-2) @web-pilot "]');
});

test('comment @-mention restores focus and the caret through the native ref', async ({ page }, info) => {
  const steps = await compareInput(page, info, 'comment', 'comment-mention-caret', async ({ page, field, step }) => {
    await field.click();
    await field.pressSequentially('Hello world');
    await field.press('Home');
    for (let index = 0; index < 6; index++) await field.press('ArrowRight');
    await field.pressSequentially('@or');
    await step('mention-open-mid-text');
    await field.press('ArrowDown');
    await field.press('Enter');
    await step('mention-picked-caret-restored');
    await field.pressSequentially('@web');
    await page.locator('.tdp-mention-item', { hasText: 'web-pilot' }).click();
    await step('mention-picked-with-pointer');
    await field.pressSequentially('@');
    await field.press('Escape');
    await step('mention-escape-dismissed');
    await field.press('Backspace');
    await field.press('ControlOrMeta+Enter');
    await step('posted-with-mentions');
  });
  const byLabel = Object.fromEntries(steps.map((entry) => [entry.label, entry]));
  expect(byLabel['mention-open-mid-text'].menu.map((option) => option.text)).toEqual(['Oorbit-develop', 'Oorbit-docs']);
  expect(byLabel['mention-picked-caret-restored']).toMatchObject({ value: 'Hello @orbit-docs world', caret: [18, 18], focused: true, menu: null });
  expect(byLabel['mention-picked-with-pointer']).toMatchObject({ value: 'Hello @orbit-docs @web-pilot world', caret: [29, 29], focused: true, menu: null });
  expect(byLabel['mention-escape-dismissed']).toMatchObject({ value: 'Hello @orbit-docs @web-pilot @world', menu: null });
  expect(byLabel['posted-with-mentions'].sent).toBe('[{"body":"Hello @orbit-docs @web-pilot world","mentions":["w2","w3"]}]');
});

test('paste text and files, the 50,000-character cap and history recall', async ({ page, context }, info) => {
  if (info.project.use.browserName === 'chromium') await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const steps = await compareInput(page, info, 'session', 'session-paste-history', async ({ page, field, step }) => {
    await field.click();
    await page.evaluate(() => navigator.clipboard.writeText('pasted line one\npasted line two\npasted line three'));
    await page.keyboard.press('ControlOrMeta+V');
    await step('text-pasted');
    // A file on the clipboard is staged instead of typed (the composer's own onPaste).
    for (const [name, type, bytes] of [['pasted.txt', 'text/plain', [104, 105]], ['pixel.png', 'image/png', null]]) {
      const prevented = await field.evaluate(async (element, [name, type, bytes]) => {
        const data = bytes ? new Uint8Array(bytes) : await (await fetch('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==')).arrayBuffer();
        const transfer = new DataTransfer();
        transfer.items.add(new File([data], name, { type }));
        return !element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
      }, [name, type, bytes]);
      expect(prevented).toBe(true);
    }
    await step('files-staged');
    await field.fill('');
    await page.evaluate(() => navigator.clipboard.writeText('x'.repeat(50_010)));
    await page.keyboard.press('ControlOrMeta+V');
    const length = await field.evaluate((element) => element.value.length);
    await field.fill('');
    await step(`length-after-oversized-paste-${length}`);
    await field.press('ArrowUp');
    await step('history-up-newest');
    await field.press('ArrowUp');
    await step('history-up-older');
    await field.press('ArrowDown');
    await step('history-down');
    await field.press('ArrowDown');
    await step('history-down-restores-draft');
    await page.getByRole('button', { name: 'Focus field' }).click();
    await step('focused-through-ref');
  });
  const byLabel = Object.fromEntries(steps.map((entry) => [entry.label, entry]));
  expect(byLabel['text-pasted']).toMatchObject({ value: 'pasted line one\npasted line two\npasted line three', height: 86, sent: '[]' });
  expect(byLabel['files-staged']).toMatchObject({ value: 'pasted line one\npasted line two\npasted line three', staged: ['pasted.txt', 'image'] });
  expect(byLabel).toHaveProperty('length-after-oversized-paste-50000');
  expect(byLabel['history-up-newest']).toMatchObject({ value: 'Earlier prompt\nwith a second line', caret: [0, 0] });
  expect(byLabel['history-up-older']).toMatchObject({ value: 'Earlier prompt', caret: [0, 0] });
  expect(byLabel['history-down']).toMatchObject({ value: 'Earlier prompt\nwith a second line', caret: [33, 33] });
  expect(byLabel['history-down-restores-draft']).toMatchObject({ value: '', caret: [0, 0] });
  expect(byLabel['focused-through-ref'].focused).toBe(true);
});
