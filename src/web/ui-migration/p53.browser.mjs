import { test, expect } from './harness.mjs';
import { MODELS, P53_IDS, P53_PATHS, PNG, emit, gate, installP53Fixtures, streamFrames } from './p53-fixtures.mjs';

// P5.3 states: the session workspace's own controls, on the production build with the P0 conversation in a fuller list
// (p53-fixtures.mjs). The composer — typing, growing to its cap, a dragged height and its reset, Chinese input, the `/`,
// `@` and `#` menus, Enter and Shift+Enter, sending, a turn streaming in while the conversation follows its tail, a
// message queued behind it and withdrawn, Stop — its attachments (pasted, dropped, a picked picture's preview), the `+`
// menu and shell mode, the workspace and mode pickers, the model menu and its levels, the context popover; the session
// list's row menu, a held press's menu, the scope menu, a folder's menu, the tips on a row's glyph and tags; the
// conversation header's menu with its tags, Find, Rename… and the confirmations it opens; a link to one record, a
// phone's Back, and a session link that leads nowhere. Locators are roles, accessible names and the pages' own
// classes, so the same file drives the replaced AntD controls (same-commit reference tree) and the Orbit ones; a box
// only one of them draws is named by both class names. Screenshots, computed styles and each step's observation
// (`trace`) are compared between the two runs (p52.browser.mjs's method).

const COMPOSER = '.composer-field textarea';
// An open popup of either kind: AntD keeps a closed dropdown in the page, hidden; Orbit unmounts it.
const MENU = '[role="menu"]';
const DIALOG = '[role="dialog"], [role="alertdialog"]';
const POPOVER = '.ant-popover, .orbit-popover';
const SELECT_POPUP = '.ant-select-dropdown, .orbit-select-popup';
const CONVERSATION = '.workspace-scroll-wrap > .workspace-sessions';
const phone = (testInfo) => !!testInfo.project.use.isMobile;
const chromium = (testInfo) => testInfo.project.use.browserName === 'chromium';
const visibleMenu = (page) => page.locator(MENU).filter({ visible: true });
const menuItem = (page, name) => visibleMenu(page).getByRole('menuitem', { name, exact: false }).filter({ visible: true }).first();
/** A menu is open (with a level below it, two are). */
const opened = (page) => expect(visibleMenu(page).first()).toBeVisible();
/** Every menu has gone, its leave motion included: the replaced menus fade out whatever motion is asked for. */
const closed = (page) => expect(visibleMenu(page)).toHaveCount(0);
const dialog = (page) => page.locator(DIALOG).filter({ visible: true });

const frames = (page) => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
/** Wait out enter and leave animations (an endless spinner is not one). */
const settled = (page) => page.waitForFunction(
  () => document.getAnimations().every((animation) => animation.playState !== 'running' || animation.effect?.getTiming().iterations === Infinity),
  null, { timeout: 5000 },
).catch(() => {});
/** Wait until the conversation's scroller has stopped: a follow to the tail may be a smooth scroll still under way. */
const scrolled = (page) => expect.poll(() => page.evaluate(async (CONVERSATION) => {
  const scroller = document.querySelector(CONVERSATION);
  if (!scroller) return 'still';
  const before = scroller.scrollTop;
  for (let frame = 0; frame < 3; frame += 1) await new Promise((resolve) => requestAnimationFrame(resolve));
  await new Promise((resolve) => setTimeout(resolve, 100));
  return scroller.scrollTop === before ? 'still' : 'scrolling';
}, CONVERSATION), { timeout: 10_000 }).toBe('still');
/** Two frames in which no popup moves: a menu, a list or a popover placed where it stays. */
const steady = (page) => expect.poll(() => page.evaluate(async ({ MENU, DIALOG, POPOVER, SELECT_POPUP }) => {
  const boxes = () => JSON.stringify([...document.querySelectorAll(`${MENU}, ${DIALOG}, ${POPOVER}, ${SELECT_POPUP}, [role="tooltip"]`)]
    .map((el) => el.getBoundingClientRect().toJSON()));
  const before = boxes();
  for (let frame = 0; frame < 3; frame += 1) await new Promise((resolve) => requestAnimationFrame(resolve));
  await new Promise((resolve) => setTimeout(resolve, 80));
  return boxes() === before ? 'steady' : 'moving';
}, { MENU, DIALOG, POPOVER, SELECT_POPUP }), { timeout: 10_000 }).toBe('steady');

async function observe(page, fixtures, step) {
  await settled(page);
  await steady(page);
  await scrolled(page);
  await frames(page);
  const state = await page.evaluate(({ COMPOSER, MENU, DIALOG, POPOVER, SELECT_POPUP, CONVERSATION }) => {
    const shown = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
    const words = (el) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
    const label = (el) => el.getAttribute('aria-label') || el.getAttribute('title') || words(el).slice(0, 60) || el.querySelector('[role="img"][aria-label]')?.getAttribute('aria-label') || '';
    const box = (el) => { const r = el.getBoundingClientRect(); return [r.x, r.y, r.width, r.height].map((v) => Math.round(v * 100) / 100); };
    const active = document.activeElement;
    const field = document.querySelector(COMPOSER);
    const scroller = document.querySelector(CONVERSATION);
    const item = (el) => {
      const role = el.getAttribute('role');
      if (role === 'separator') return '─';
      const flags = [
        el.getAttribute('aria-disabled') === 'true' || el.hasAttribute('data-disabled') || el.classList.contains('ant-dropdown-menu-item-disabled') ? 'disabled' : null,
        el.hasAttribute('data-selected') || el.classList.contains('ant-dropdown-menu-item-selected') ? 'selected' : null,
        el.getAttribute('aria-haspopup') ? 'submenu' : null,
        el.querySelector('.scope-menu-check svg') ? '✓' : null,
        el.getAttribute('title') ? `title=${el.getAttribute('title')}` : null,
      ].filter(Boolean);
      const copy = el.cloneNode(true);
      copy.querySelectorAll('kbd').forEach((kbd) => kbd.remove());
      return `${words(copy)}${flags.length ? ` [${flags.join(', ')}]` : ''}`;
    };
    // Group headings, in AntD's and Orbit's class names.
    const heading = (el) => (el.matches('.ant-dropdown-menu-item-group-title, .orbit-menu-group-label') ? `# ${words(el)}` : null);
    const menus = [...document.querySelectorAll(MENU)].filter(shown).map((menu) => [...menu.querySelectorAll('[role="menuitem"], [role="menuitemcheckbox"], [role="separator"], .ant-dropdown-menu-item-group-title, .orbit-menu-group-label')]
      .filter((el) => shown(el) && el.closest(MENU) === menu).map((el) => heading(el) ?? item(el)));
    const options = [...document.querySelectorAll(SELECT_POPUP)].filter(shown).map((list) => [...list.querySelectorAll('[role="option"], .ant-select-item-option')]
      .filter(shown).map((el) => `${words(el)}${el.getAttribute('aria-disabled') === 'true' || el.classList.contains('ant-select-item-option-disabled') ? ' [disabled]' : ''}${el.getAttribute('aria-selected') === 'true' || el.classList.contains('ant-select-item-option-selected') ? ' [selected]' : ''}`));
    const dialogs = [...document.querySelectorAll(DIALOG)].filter(shown).map((el) => ({
      role: el.getAttribute('role'),
      title: words(el.querySelector('.ant-modal-confirm-title, .ant-modal-title, .orbit-overlay-title, [id] h2')),
      text: words(el).slice(0, 200),
      buttons: [...el.querySelectorAll('button')].filter(shown).map((button) => `${label(button)}${button.disabled ? ' (disabled)' : ''}`),
    }));
    const popovers = [...document.querySelectorAll(POPOVER)].filter(shown).map((el) => words(el));
    const tips = [...document.querySelectorAll('[role="tooltip"]')].filter(shown).map((el) => words(el));
    const census = [...new Set([...document.querySelectorAll('[class*="ant-"]')].filter(shown)
      .flatMap((el) => [...el.classList].filter((token) => token.startsWith('ant-') && !token.startsWith('anticon'))
        .map((token) => token.replace(/-(?:css-var|hash)-.*$/, ''))))].sort();
    return {
      url: `${location.pathname}${location.search}`,
      focus: active && active !== document.body ? { role: active.getAttribute('role') ?? active.tagName.toLowerCase(), name: label(active) } : 'body',
      composer: field ? {
        value: field.value, selection: [field.selectionStart, field.selectionEnd], placeholder: field.placeholder, disabled: field.disabled,
        height: Math.round(field.getBoundingClientRect().height * 100) / 100, scrolls: field.scrollHeight > field.clientHeight + 1,
        shell: !!document.querySelector('.composer-box-shell'),
        mirror: [...document.querySelectorAll('.composer-mirror .composer-chip')].map(words),
        attachments: [...document.querySelectorAll('.composer-attachments > *')].map((el) => `${el.className.replace(/\s+/g, ' ')}:${label(el)}`),
        menu: [...document.querySelectorAll('.composer-slash-menu [role="option"]')].map((el) => `${words(el)}${el.getAttribute('aria-selected') === 'true' ? ' *' : ''}`),
        send: [...document.querySelectorAll('.composer-send')].map((button) => `${label(button)}${button.disabled ? ' (disabled)' : ''}${button.getAttribute('aria-busy') === 'true' || button.classList.contains('ant-btn-loading') ? ' (busy)' : ''}`),
        plus: [...document.querySelectorAll('.composer-attach-btn')].map((button) => `${label(button)}${button.disabled ? ' (disabled)' : ''}`),
        chip: words(document.querySelector('.composer-model-chip')),
        pickers: [...document.querySelectorAll('.composer-toolbar .ant-select, .composer-toolbar .orbit-select')].map(words),
      } : null,
      rows: scroller ? [...scroller.querySelectorAll('[data-seq]')].filter((el) => el.parentElement?.closest('[data-seq]') === null).map((el) => el.getAttribute('data-seq')) : null,
      queued: [...document.querySelectorAll('.chat-queued')].filter(shown).map(words),
      scroll: scroller ? { gap: Math.round(scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight) } : null,
      list: [...document.querySelectorAll('.session-col .session-row, .session-col .session-folder-row')].filter(shown).map((el) =>
        `${words(el.querySelector('.session-title, .session-folder-name, .folder-name-input'))}${el.classList.contains('active') ? ' (active)' : ''}${el.classList.contains('menu-open') ? ' (menu)' : ''}${el.querySelector('input') ? ` [${el.querySelector('input').value}]` : ''}`),
      header: words(document.querySelector('.workspace-name')) || document.querySelector('.workspace-name-input')?.value || null,
      menus, options, dialogs, popovers, tips,
      find: document.querySelector('.find-bar input') ? document.querySelector('.find-bar input').value : null,
      lock: { html: getComputedStyle(document.documentElement).overflowY, body: getComputedStyle(document.body).overflowY },
      antd: census,
    };
  }, { COMPOSER, MENU, DIALOG, POPOVER, SELECT_POPUP, CONVERSATION });
  // A turn's clientTurnId is a fresh random id on every send: recorded as present, not by its value.
  const requests = fixtures.requests.splice(0).map(({ method, path, query, body }) => ({ method, path: query ? `${path}?${query}` : path,
    body: body && typeof body === 'object' && 'clientTurnId' in body ? { ...body, clientTurnId: '(a fresh id)' } : body }));
  return { step, ...state, requests };
}

const attachJson = (testInfo, name, body) => testInfo.attach(name, { body: JSON.stringify(body, null, 2), contentType: 'application/json' });

/** The pointer moved off what it picked, to the page's corner: the replaced menu keeps a level open while a pointer
 *  rests on it, after the pick as before (on a phone nothing rests). */
async function rest(page, testInfo) {
  if (!phone(testInfo)) await page.mouse.move(1, 1);
}

/** Press as the environment's reader does: a tap on a phone, a click elsewhere — the mouse brought there the way a hand
 *  moves it, over the way rather than in one jump, since a menu reads where the pointer is heading (it keeps a level
 *  open while the pointer makes for it, and lets it go when the pointer turns away). */
async function press(locator, testInfo) {
  if (phone(testInfo)) {
    await locator.tap();
    return;
  }
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  if (box) await locator.page().mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 });
  await locator.click();
}

/** After a tap on an item a level down (a tag in the scope menu's Filter by Tag): on a WebKit phone the replaced menu
 *  leaves that level on the screen, the pick itself made. What is still open is returned for the next step's trace, and
 *  a tap where nothing is (the list's empty foot) closes it for the rest of the case. Anywhere else a menu left open
 *  fails the case. */
async function leftOpen(page, testInfo) {
  try {
    await expect(visibleMenu(page)).toHaveCount(0, { timeout: 3000 });
    return [];
  } catch (error) {
    if (!phone(testInfo)) throw error;
    const left = await visibleMenu(page).allTextContents();
    await page.touchscreen.tap(30, 830);
    await closed(page);
    return left;
  }
}

/** Pick a menu's item that closes it, and wait until every menu has gone. */
async function pick(page, name, testInfo) {
  await press(menuItem(page, name), testInfo);
  await rest(page, testInfo);
  await closed(page);
}

async function openSession(page, path = P53_PATHS.session) {
  await page.goto(path);
  await expect(page.locator(COMPOSER)).toBeVisible();
  await expect(page.locator(`${CONVERSATION} [data-seq="2"]`)).toBeVisible();
  await settled(page);
}

/** Type as a keyboard does, one key at a time (Shift+Enter between lines). */
async function typeLines(page, lines) {
  for (const [index, line] of lines.entries()) {
    if (index) await page.keyboard.press('Shift+Enter');
    await page.keyboard.type(line);
  }
}

/** Chinese composed through the input method: Chromium's own IME events, WebKit's insertText plus the composition
 *  events and the 229 Enter a composition makes (as P3.1's composer fixture did). */
async function compose(page, testInfo, preedit, committed) {
  if (chromium(testInfo)) {
    const cdp = await page.context().newCDPSession(page);
    for (let length = 1; length <= preedit.length; length += 1) {
      await cdp.send('Input.imeSetComposition', { text: preedit.slice(0, length), selectionStart: length, selectionEnd: length });
    }
    return {
      enter: async () => {
        // An Enter while composing is the IME's: keyCode 229 and isComposing, as the browser sends it.
        await page.locator(COMPOSER).evaluate((field) => {
          field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229, isComposing: true, bubbles: true, cancelable: true }));
        });
      },
      commit: async () => { await cdp.send('Input.insertText', { text: committed }); await cdp.detach(); },
    };
  }
  const field = page.locator(COMPOSER);
  await field.evaluate((el, preedit) => {
    el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
    el.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, data: preedit }));
  }, preedit);
  return {
    enter: async () => field.evaluate((el) => {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229, isComposing: true, bubbles: true, cancelable: true }));
    }),
    commit: async () => {
      await page.keyboard.insertText(committed);
      await field.evaluate((el, committed) => el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: committed })), committed);
    },
  };
}

/** A file in the composer, the ways a reader brings one: a paste, or a drop on the conversation. */
async function bring(page, how, files) {
  await page.evaluate(({ how, files }) => {
    const data = new DataTransfer();
    for (const { name, type, base64 } of files) {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      data.items.add(new File([bytes], name, { type }));
    }
    if (how === 'paste') {
      document.querySelector('.composer-field textarea').dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
      return;
    }
    const target = document.querySelector('.workspace-scroll-wrap > .workspace-sessions');
    for (const type of ['dragenter', 'dragover']) target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: data }));
    window.__p53Drop = data;
  }, { how, files });
}
async function drop(page) {
  await page.evaluate(() => {
    const target = document.querySelector('.workspace-scroll-wrap > .workspace-sessions');
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: window.__p53Drop }));
  });
}
const pngFile = (name) => ({ name, type: 'image/png', base64: PNG.toString('base64') });

test.describe('P5.3 the session workspace', () => {
  test('composer: types and grows, holds a dragged height, sends, streams in order, queues and stops', async ({ evidence }, testInfo) => {
    const { page, capture } = evidence;
    const fixtures = await installP53Fixtures(page);
    const trace = [];
    await openSession(page);
    const field = page.locator(COMPOSER);
    trace.push(await observe(page, fixtures, 'opened'));
    await capture('p53-composer-idle', { composer: '.composer-box', send: '.composer-send' });

    await press(field, testInfo);
    await typeLines(page, ['Keep the composer as it is.', 'A second line, after Shift+Enter.']);
    trace.push(await observe(page, fixtures, 'two lines'));
    await capture('p53-composer-two-lines', { composer: '.composer-box', field: COMPOSER, send: '.composer-send' });
    // Thirteen lines: past the twelve it grows to, so it scrolls.
    await typeLines(page, ['', ...Array.from({ length: 11 }, (_, i) => `Line ${i + 3}`)]);
    trace.push(await observe(page, fixtures, 'thirteen lines: at its cap, scrolling'));
    await capture('p53-composer-capped', { composer: '.composer-box', field: COMPOSER });
    if (!phone(testInfo)) {
      // The handle over the box: dragged up 100px it holds that height; a double-click hands it back to the content.
      const handle = page.locator('.composer-resize-handle');
      await expect(handle).toBeVisible();
      const grip = await handle.boundingBox();
      await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
      await page.mouse.down();
      await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2 - 100, { steps: 5 });
      await page.mouse.up();
      trace.push(await observe(page, fixtures, 'dragged 100px taller'));
      await capture('p53-composer-dragged', { composer: '.composer-box', field: COMPOSER });
      await handle.dblclick();
      trace.push(await observe(page, fixtures, 'height handed back to the content'));
    }
    await field.fill('');
    trace.push(await observe(page, fixtures, 'emptied'));

    // Enter sends; the turn streams in, in order, and the conversation follows its tail.
    await press(field, testInfo);
    await page.keyboard.type('Check the composer next.');
    await page.keyboard.press('Enter');
    await expect(field).toHaveValue('');
    trace.push(await observe(page, fixtures, 'sent with Enter'));
    await emit(page, streamFrames('start'));
    await expect(page.locator(`${CONVERSATION} [data-seq="4"]`)).toBeVisible();
    trace.push(await observe(page, fixtures, 'the turn streaming'));
    await capture('p53-streaming', { conversation: CONVERSATION });
    await emit(page, streamFrames('end'));
    await expect(page.locator(`${CONVERSATION} [data-seq="7"]`)).toBeVisible();
    trace.push(await observe(page, fixtures, 'the turn ended'));

    // At work again, with nothing typed: Send is Stop. A message typed now is queued behind the turn, and withdrawn.
    fixtures.state.running = true;
    await emit(page, [{ seq: 9, type: 'status', payload: { status: 'RUNNING' }, ts: '2026-09-28T12:00:00.000Z' }]);
    await page.reload();
    await expect(page.locator('[aria-label="Stop"]')).toBeVisible();
    trace.push(await observe(page, fixtures, 'at work: Stop'));
    await capture('p53-stop', { composer: '.composer-box', stop: '[aria-label="Stop"]' });
    await press(field, testInfo);
    await page.keyboard.type('Queue this one.');
    await page.keyboard.press('Enter');
    await expect(page.locator('.chat-queued')).toBeVisible();
    trace.push(await observe(page, fixtures, 'queued behind the turn'));
    // The queued bubble is drawn dimmed, so it is in the page's picture rather than a selected box of its own.
    await capture('p53-queued', { composer: '.composer-box' });
    await press(page.locator('.chat-queued a', { hasText: 'Cancel' }), testInfo);
    await expect(field).toHaveValue('Queue this one.');
    trace.push(await observe(page, fixtures, 'withdrawn into the composer'));
    await field.fill('');
    await press(page.locator('[aria-label="Stop"]'), testInfo);
    trace.push(await observe(page, fixtures, 'stopped'));
    await attachJson(testInfo, 'trace', trace);
  });

  test('composer menus: slash, mention and reference, and Chinese input', async ({ evidence }, testInfo) => {
    const { page, capture } = evidence;
    const fixtures = await installP53Fixtures(page);
    const trace = [];
    await openSession(page);
    const field = page.locator(COMPOSER);
    await press(field, testInfo);
    await page.keyboard.type('/');
    await expect(page.locator('.composer-slash-menu')).toBeVisible();
    trace.push(await observe(page, fixtures, '/ opens the commands'));
    await capture('p53-slash-menu', { menu: '.composer-slash-menu', composer: '.composer-box' });
    await page.keyboard.press('ArrowDown');
    trace.push(await observe(page, fixtures, 'ArrowDown moves the highlight'));
    await page.keyboard.press('Enter');
    trace.push(await observe(page, fixtures, 'Enter picks it'));
    await field.fill('');
    await page.keyboard.type('Ask @');
    await expect(page.locator('.composer-slash-menu')).toBeVisible();
    trace.push(await observe(page, fixtures, '@ opens the workspaces'));
    await capture('p53-mention-menu', { menu: '.composer-slash-menu' });
    await page.keyboard.press('Tab');
    trace.push(await observe(page, fixtures, 'Tab picks it, drawn as a chip'));
    await capture('p53-mention-chip', { composer: '.composer-box', mirror: '.composer-mirror' });
    await page.keyboard.press('Escape');
    await field.fill('');

    // Chinese through the input method: the composition holds Enter; the committed text is the field's.
    await press(field, testInfo);
    const ime = await compose(page, testInfo, 'zhong wen', '中文输入');
    trace.push(await observe(page, fixtures, 'composing'));
    await ime.enter();
    trace.push(await observe(page, fixtures, 'Enter while composing sends nothing'));
    await ime.commit();
    trace.push(await observe(page, fixtures, 'committed'));
    await capture('p53-chinese', { composer: '.composer-box', field: COMPOSER });
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('第二行');
    trace.push(await observe(page, fixtures, 'a second line'));
    await page.keyboard.press('Enter');
    await expect(field).toHaveValue('');
    trace.push(await observe(page, fixtures, 'sent'));
    await attachJson(testInfo, 'trace', trace);
  });

  test('attachments: pasted, dropped, a picked picture previewed, removed', async ({ evidence }, testInfo) => {
    const { page, capture } = evidence;
    const fixtures = await installP53Fixtures(page);
    const upload = gate();
    fixtures.state.uploadHold = upload;
    const trace = [];
    await openSession(page);
    await press(page.locator(COMPOSER), testInfo);
    await bring(page, 'paste', [pngFile('screenshot.png')]);
    await expect(page.locator('.composer-attach')).toHaveCount(1);
    trace.push(await observe(page, fixtures, 'pasted: uploading'));
    await capture('p53-attach-uploading', { chip: '.composer-attach', composer: '.composer-box' });
    upload.release();
    await expect(page.locator('.composer-attach-spin')).toHaveCount(0);
    trace.push(await observe(page, fixtures, 'uploaded'));
    await capture('p53-attach-chip', { chip: '.composer-attach', composer: '.composer-box' });
    const thumbnail = page.locator('.composer-attach .ant-image, .composer-attach .orbit-image').first();
    if (!phone(testInfo)) {
      await thumbnail.hover();
      await settled(page);
      trace.push(await observe(page, fixtures, 'hover over the thumbnail'));
      await capture('p53-attach-hover', { chip: '.composer-attach' });
    }
    await press(thumbnail, testInfo);
    await expect(page.locator('.ant-image-preview, .orbit-image-preview').filter({ visible: true })).toBeVisible();
    await settled(page);
    trace.push(await observe(page, fixtures, 'the picture opened'));
    await capture('p53-attach-preview', { viewer: '.ant-image-preview-img, .orbit-image-preview-img' });
    await page.keyboard.press('Escape');
    await expect(page.locator('.ant-image-preview, .orbit-image-preview').filter({ visible: true })).toHaveCount(0);
    trace.push(await observe(page, fixtures, 'closed with Esc'));

    await bring(page, 'drop', [{ name: 'notes.pdf', type: 'application/pdf', base64: Buffer.from('%PDF-1.4 fixture').toString('base64') }]);
    await expect(page.locator('.workspace-dropzone')).toBeVisible();
    trace.push(await observe(page, fixtures, 'a file dragged over the conversation'));
    await capture('p53-drop-hint', { pane: CONVERSATION });
    await drop(page);
    await expect(page.locator('.composer-file')).toHaveCount(1);
    trace.push(await observe(page, fixtures, 'dropped'));
    await capture('p53-attach-file', { file: '.composer-file', composer: '.composer-box' });
    await press(page.getByRole('button', { name: 'Remove image' }), testInfo);
    await press(page.getByRole('button', { name: 'Remove file' }), testInfo);
    await expect(page.locator('.composer-attachments')).toHaveCount(0);
    trace.push(await observe(page, fixtures, 'removed'));
    await attachJson(testInfo, 'trace', trace);
  });

  test('the + menu, shell mode, and the pickers on the toolbar', async ({ evidence }, testInfo) => {
    const { page, capture } = evidence;
    const fixtures = await installP53Fixtures(page);
    const trace = [];
    await openSession(page);
    const plus = page.getByRole('button', { name: 'Add attachment' });
    await press(plus, testInfo);
    await opened(page);
    trace.push(await observe(page, fixtures, 'the + menu'));
    await capture('p53-plus-menu', { menu: '.composer-attach-menu', plus: '.composer-attach-btn' });
    await pick(page, 'Shell', testInfo);
    await expect(page.locator('.composer-box-shell')).toBeVisible();
    trace.push(await observe(page, fixtures, 'shell mode'));
    await page.keyboard.type('ls -la');
    await capture('p53-shell', { composer: '.composer-box', prompt: '.composer-shell-btn' });
    await press(page.getByRole('button', { name: 'Leave shell mode' }), testInfo);
    await expect(page.locator('.composer-box-shell')).toHaveCount(0);
    trace.push(await observe(page, fixtures, 'left shell mode'));
    await page.locator(COMPOSER).fill('');
    await press(plus, testInfo);
    await pick(page, 'Command', testInfo);
    await expect(page.locator('.composer-slash-menu')).toBeVisible();
    trace.push(await observe(page, fixtures, 'Command opens the commands'));
    await page.keyboard.press('Escape');
    await page.locator(COMPOSER).fill('');

    // Mode, on a running session's toolbar: its list, a pick that reaches the server.
    const mode = page.locator('.composer-toolbar .ant-select, .composer-toolbar .orbit-select').last();
    await press(mode, testInfo);
    await expect(page.locator(SELECT_POPUP).filter({ visible: true })).toBeVisible();
    trace.push(await observe(page, fixtures, 'the mode list'));
    await capture('p53-mode-list', { list: `${SELECT_POPUP} >> visible=true`, picker: '.composer-toolbar .composer-pill:not(.composer-model-pill)' });
    await press(page.locator(SELECT_POPUP).filter({ visible: true }).getByText('Plan', { exact: false }).first(), testInfo);
    trace.push(await observe(page, fixtures, 'Plan picked'));

    // The model control: its menu, the Provider and Effort levels, a pick.
    await press(page.locator('.composer-model-chip'), testInfo);
    await opened(page);
    trace.push(await observe(page, fixtures, 'the model menu'));
    await capture('p53-model-menu', { menu: '.composer-model-menu', chip: '.composer-model-chip' });
    await press(menuItem(page, 'Provider'), testInfo);
    await expect(menuItem(page, 'DeepSeek')).toBeVisible();
    await settled(page);
    trace.push(await observe(page, fixtures, 'the Provider level'));
    await capture('p53-model-provider', { menu: '.composer-model-menu' });
    if (phone(testInfo)) {
      // On a phone the level slides over its menu, Effort's row under it: a tap beside the menus closes them all first.
      await page.locator(CONVERSATION).tap({ position: { x: 300, y: 12 } });
      await closed(page);
      await press(page.locator('.composer-model-chip'), testInfo);
      await opened(page);
    }
    await press(menuItem(page, 'Effort'), testInfo);
    await expect(menuItem(page, 'High')).toBeVisible();
    await settled(page);
    trace.push(await observe(page, fixtures, 'the Effort level'));
    await capture('p53-model-effort', { menu: '.composer-model-menu' });
    await pick(page, 'High', testInfo);
    trace.push(await observe(page, fixtures, 'High picked'));
    await press(page.locator('.composer-model-chip'), testInfo);
    await pick(page, MODELS[1].label, testInfo);
    trace.push(await observe(page, fixtures, `${MODELS[1].label} picked`));

    // The context ring: its popover on a hover, or on a press where nothing hovers.
    const ring = page.locator('.composer-usage[aria-label^="Context"]');
    if (phone(testInfo)) await ring.tap();
    else await ring.hover();
    await expect(page.locator(POPOVER).filter({ visible: true }).filter({ hasText: 'Context window' })).toBeVisible();
    await settled(page);
    trace.push(await observe(page, fixtures, 'the context popover'));
    // A tap on a phone: the replaced popover, opened by both a hover and a click, comes and goes with the touch's emulated
    // mouse events afterwards, so only its words are traced there.
    if (!phone(testInfo)) await capture('p53-context-popover', { popover: '.cu-pop', ring: '.composer-usage' });
    await attachJson(testInfo, 'trace', trace);
  });

  test('the session list: a row’s menu, a held press, the scope menu, a folder', async ({ evidence }, testInfo) => {
    const { page, capture } = evidence;
    const fixtures = await installP53Fixtures(page);
    const trace = [];
    await openSession(page);
    if (phone(testInfo)) await press(page.locator('.workspace-back, .session-pane-back, button[aria-label^="Back"]').first(), testInfo);
    const listRow = (title) => page.locator('.session-col .session-row').filter({ hasText: title }).first();
    await expect(listRow('Demo for the design review')).toBeVisible();
    await settled(page);
    trace.push(await observe(page, fixtures, 'the list'));
    await capture('p53-list', { list: '.session-col' });

    if (!phone(testInfo)) {
      // The tips on a row: a session at work, one that failed, and its tags. The spinner's tip is placed where the
      // spinner's turning box is when it opens, in either tree, so its words are traced and the failed one is pictured.
      await listRow('Ship the release notes').locator('.session-icon').hover();
      await expect(page.locator('[role="tooltip"]').filter({ visible: true }).filter({ hasText: 'Running' })).toBeVisible();
      await settled(page);
      trace.push(await observe(page, fixtures, 'tip: at work'));
      await listRow('Fix the flaky upload test').locator('.session-icon').hover();
      await expect(page.locator('[role="tooltip"]').filter({ visible: true }).filter({ hasText: 'Import failed' })).toBeVisible();
      await settled(page);
      trace.push(await observe(page, fixtures, 'tip: failed'));
      await capture('p53-tip-failed', { row: listRow('Fix the flaky upload test') });
      await listRow('Demo for the design review').locator('.session-tag-chips').hover();
      await expect(page.locator('[role="tooltip"]').filter({ visible: true }).filter({ hasText: 'Design, Ops' })).toBeVisible();
      await settled(page);
      trace.push(await observe(page, fixtures, 'tip: the tags'));
      await page.mouse.move(0, 0);

      // A row's ⋯: its menu, Rename… in place.
      const demo = listRow('Demo for the design review');
      await demo.hover();
      await demo.getByRole('button', { name: 'More actions' }).click();
      await opened(page);
      trace.push(await observe(page, fixtures, 'a row’s menu'));
      await capture('p53-row-menu', { menu: `${MENU} >> visible=true`, row: demo });
      await page.keyboard.press('Escape');
      await closed(page);
      trace.push(await observe(page, fixtures, 'Esc closes it'));
      await demo.hover();
      await demo.getByRole('button', { name: 'More actions' }).click();
      await pick(page, 'Rename', testInfo);
      await expect(page.locator('.session-row.renaming input')).toBeFocused();
      trace.push(await observe(page, fixtures, 'Rename… in place'));
      await page.keyboard.press('Control+a');
      await page.keyboard.type('Demo for the review');
      await page.keyboard.press('Enter');
      await expect(listRow('Demo for the review')).toBeVisible();
      trace.push(await observe(page, fixtures, 'renamed'));
      // Delete on a shared session asks first.
      const renamed = listRow('Demo for the review');
      await renamed.hover();
      await renamed.getByRole('button', { name: 'More actions' }).click();
      await pick(page, 'Delete', testInfo);
      await expect(dialog(page)).toBeVisible();
      await settled(page);
      trace.push(await observe(page, fixtures, 'Delete asks first'));
      await capture('p53-confirm-trash', { dialog: `${DIALOG} >> visible=true` });
      await dialog(page).getByRole('button', { name: 'Cancel' }).click();
      await expect(dialog(page)).toHaveCount(0);
      trace.push(await observe(page, fixtures, 'Cancel'));
    } else {
      // A held press opens the row's menu where the finger is.
      const demo = listRow('Demo for the design review');
      const box = await demo.boundingBox();
      await page.evaluate(({ x, y }) => {
        const target = document.elementFromPoint(x, y);
        const touch = new Touch({ identifier: 1, target, clientX: x, clientY: y, pageX: x, pageY: y });
        target.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, cancelable: true, touches: [touch], targetTouches: [touch], changedTouches: [touch] }));
        window.__p53Held = { target, touch };
      }, { x: box.x + 120, y: box.y + box.height / 2 }).catch(() => {});
      const held = await page.evaluate(() => !!window.__p53Held);
      if (held) {
        await page.waitForTimeout(700);
        await page.evaluate(() => {
          const { target, touch } = window.__p53Held;
          target.dispatchEvent(new TouchEvent('touchend', { bubbles: true, cancelable: true, touches: [], targetTouches: [], changedTouches: [touch] }));
        });
        await opened(page);
        await settled(page);
        trace.push(await observe(page, fixtures, 'a held press: the row’s menu'));
        await capture('p53-press-menu', { menu: `${MENU} >> visible=true` });
        await pick(page, 'Pin', testInfo);
        await closed(page);
        trace.push(await observe(page, fixtures, 'Pin from the held menu'));
      } else {
        trace.push({ step: 'a held press: not run (this browser cannot make touches from a script)' });
      }
    }

    // The scope menu: views, a tag a level down, a new folder named in place.
    await press(page.locator('.session-scope-menu'), testInfo);
    await opened(page);
    trace.push(await observe(page, fixtures, 'the scope menu'));
    await capture('p53-scope-menu', { menu: `${MENU} >> visible=true`, trigger: '.session-scope-menu' });
    await press(menuItem(page, 'Filter by Tag'), testInfo);
    await expect(menuItem(page, 'Ops')).toBeVisible();
    await settled(page);
    trace.push(await observe(page, fixtures, 'Filter by Tag'));
    await capture('p53-scope-tags', { menu: `${MENU} >> visible=true` });
    await press(menuItem(page, 'Ops'), testInfo);
    await rest(page, testInfo);
    const leftAfterOps = await leftOpen(page, testInfo);
    await expect(page.locator('.session-col .session-row').filter({ hasText: 'Fix the flaky upload test' })).toHaveCount(0);
    trace.push({ ...await observe(page, fixtures, 'filtered to Ops'), leftOpen: leftAfterOps });
    await press(page.locator('.session-scope-menu'), testInfo);
    await press(menuItem(page, 'Filter by Tag'), testInfo);
    await press(menuItem(page, 'All'), testInfo);
    await rest(page, testInfo);
    const leftAfterAll = await leftOpen(page, testInfo);
    await press(page.locator('.session-scope-menu'), testInfo);
    await pick(page, 'New Folder', testInfo);
    await expect(page.locator('.session-folder-row.editing input')).toBeFocused();
    trace.push({ ...await observe(page, fixtures, 'New Folder… in place'), leftOpen: leftAfterAll });
    await page.keyboard.type('Design review');
    await page.keyboard.press('Enter');
    await expect(page.locator('.session-folder-row').filter({ hasText: 'Design review' })).toBeVisible();
    trace.push(await observe(page, fixtures, 'a folder made'));

    // A folder's ⋯: Delete Folder… asks first. A row's ⋯ shows on a hover, which a phone has not: there the folder's
    // own page carries it.
    const folder = page.locator('.session-folder-row').filter({ hasText: 'Release' }).first();
    if (phone(testInfo)) {
      await press(folder, testInfo);
      await expect(page.locator('.session-folder-head-more')).toBeVisible();
      await settled(page);
      await press(page.locator('.session-folder-head-more'), testInfo);
    } else {
      await folder.hover();
      await folder.locator('.session-folder-more').click();
    }
    await opened(page);
    trace.push(await observe(page, fixtures, 'a folder’s menu'));
    await capture('p53-folder-menu', { menu: `${MENU} >> visible=true` });
    await pick(page, 'Delete Folder', testInfo);
    await expect(dialog(page)).toBeVisible();
    await settled(page);
    trace.push(await observe(page, fixtures, 'Delete Folder… asks first'));
    await capture('p53-confirm-folder', { dialog: `${DIALOG} >> visible=true` });
    await press(dialog(page).getByRole('button', { name: 'Delete' }), testInfo);
    await expect(page.locator('.session-folder-row').filter({ hasText: 'Release' })).toHaveCount(0);
    trace.push(await observe(page, fixtures, 'the folder deleted'));

    // Trash: a row's Delete Permanently… asks first.
    await press(page.locator('.session-scope-menu'), testInfo);
    await pick(page, 'Trash', testInfo);
    const draft = listRow('Draft notes for the pilot');
    await expect(draft).toBeVisible();
    if (!phone(testInfo)) {
      await draft.hover();
      await draft.getByRole('button', { name: 'More actions' }).click();
      await opened(page);
      trace.push(await observe(page, fixtures, 'a trashed row’s menu'));
      await pick(page, 'Delete Permanently', testInfo);
      await expect(dialog(page)).toBeVisible();
      await settled(page);
      trace.push(await observe(page, fixtures, 'Delete Permanently… asks first'));
      await capture('p53-confirm-purge', { dialog: `${DIALOG} >> visible=true` });
      await dialog(page).getByRole('button', { name: 'Delete permanently' }).click();
      await expect(draft).toHaveCount(0);
      trace.push(await observe(page, fixtures, 'purged'));
    }
    await attachJson(testInfo, 'trace', trace);
  });

  test('the conversation header: its menu and tags, Find, Rename…, Share, Move, Delete', async ({ evidence }, testInfo) => {
    const { page, capture } = evidence;
    const fixtures = await installP53Fixtures(page);
    const trace = [];
    await openSession(page);
    const more = page.locator('.workspace-header button[title="More actions"]');
    await press(more, testInfo);
    await opened(page);
    trace.push(await observe(page, fixtures, 'the header menu'));
    await capture('p53-header-menu', { menu: `${MENU} >> visible=true`, trigger: '.workspace-header button[title="More actions"]' });
    // A tag is put on or taken off, and the menu stays open for the next.
    await press(menuItem(page, 'Ops'), testInfo);
    await opened(page);
    trace.push(await observe(page, fixtures, 'Ops put on, the menu still open'));
    await capture('p53-header-tags', { menu: `${MENU} >> visible=true` });
    await press(menuItem(page, 'Design'), testInfo);
    trace.push(await observe(page, fixtures, 'Design taken off'));
    await page.keyboard.press('Escape');
    await closed(page);
    trace.push(await observe(page, fixtures, 'Esc closes it'));

    await press(more, testInfo);
    await pick(page, 'Find in session', testInfo);
    await expect(page.locator('.find-bar input')).toBeFocused();
    await page.keyboard.type('interface');
    trace.push(await observe(page, fixtures, 'Find in session'));
    await capture('p53-find', { find: '.find-bar' });
    await page.keyboard.press('Escape');

    await press(more, testInfo);
    await pick(page, 'Rename', testInfo);
    await expect(page.locator('.workspace-name-input')).toBeFocused();
    trace.push(await observe(page, fixtures, 'Rename… in the header'));
    await page.keyboard.press('Escape');

    await press(more, testInfo);
    await pick(page, 'Share', testInfo);
    await expect(dialog(page)).toBeVisible();
    await settled(page);
    trace.push(await observe(page, fixtures, 'Share… opens its dialog'));
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toHaveCount(0);
    trace.push(await observe(page, fixtures, 'Share closed'));

    await press(more, testInfo);
    await pick(page, 'Move', testInfo);
    await expect(dialog(page)).toBeVisible();
    await settled(page);
    trace.push(await observe(page, fixtures, 'Move… opens its dialog'));
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toHaveCount(0);
    trace.push(await observe(page, fixtures, 'Move closed'));

    // Delete moves a session nobody shared to Trash at once, with its Undo.
    await press(more, testInfo);
    await pick(page, 'Delete', testInfo);
    await expect.poll(() => fixtures.requests.some((r) => r.method === 'DELETE')).toBe(true);
    trace.push(await observe(page, fixtures, 'Delete: to Trash at once'));
    await attachJson(testInfo, 'trace', trace);
  });

  test('a link to one record, a phone’s Back, and a session link that leads nowhere', async ({ evidence }, testInfo) => {
    const { page, capture } = evidence;
    const fixtures = await installP53Fixtures(page);
    const missing = gate();
    fixtures.state.missingHold = missing;
    const trace = [];
    await page.goto(`${P53_PATHS.session}?record=1`);
    await expect(page.locator(`${CONVERSATION} [data-seq="1"]`)).toBeVisible();
    await settled(page);
    trace.push(await observe(page, fixtures, 'opened at record 1'));
    if (phone(testInfo)) {
      // From the list into a conversation and back with the pane's ←, then the browser's own Forward and Back.
      await page.goto(P53_PATHS.workspace);
      const listRow = page.locator('.session-col .session-row').filter({ hasText: 'Review the component migration' }).first();
      await expect(listRow).toBeVisible();
      await listRow.tap();
      await expect(page.locator(COMPOSER)).toBeVisible();
      await settled(page);
      trace.push(await observe(page, fixtures, 'a row opened from the list'));
      await page.locator('.workspace-back, button[aria-label^="Back"]').first().tap();
      await expect(listRow).toBeVisible();
      await settled(page);
      trace.push(await observe(page, fixtures, 'the pane’s ←: the list'));
      await page.goForward();
      await expect(page.locator(COMPOSER)).toBeVisible();
      await settled(page);
      trace.push(await observe(page, fixtures, 'Forward: the conversation'));
      await page.goBack();
      await expect(listRow).toBeVisible();
      await settled(page);
      trace.push(await observe(page, fixtures, 'Back: the list'));
    }
    await page.goto(P53_PATHS.missing);
    await expect(page.locator('.orbit-spinner, .ant-spin').filter({ visible: true }).first()).toBeVisible();
    trace.push(await observe(page, fixtures, 'a link to a session not yet read'));
    await capture('p53-console-loading', { main: '.app-view' });
    missing.release();
    await expect(page.getByText('Session not found')).toBeVisible();
    trace.push(await observe(page, fixtures, 'not found'));
    await capture('p53-not-found', { result: '.ant-result, .orbit-result', home: '.ant-result button, .orbit-result button' });
    await press(page.getByRole('button', { name: 'Go home' }), testInfo);
    await expect(page).not.toHaveURL(new RegExp(P53_IDS.missing));
    trace.push(await observe(page, fixtures, 'Go home'));
    await attachJson(testInfo, 'trace', trace);
  });
});
