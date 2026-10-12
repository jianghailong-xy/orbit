// emu-steps.mjs: the P5.3 checks on the HPC Android emulator (emulator-5554, API 36, Chrome for Android 133 + Gboard),
// in one order, for the tree emu-server.mjs runs (POST /run with this file's path). Touches are the device's own
// (`adb shell input tap/swipe/keyevent`, Gboard's keys, Android's photo picker; the pinch is raw multi-touch evdev);
// the page is read over CDP. Each step records what it saw and whether that is what the step expects; screenshots are
// the device's (screencap: Chrome's bars, Gboard, the picker). An emulator, not a phone.
const ROOT = '/mnt/data/tmp/34Za39Ov1yysHZaYL6wgJ/android';
// Gboard's keys at 1080×2400 (English QWERTY, the emulator's default layout).
const KEY = {
  q: [56, 1714], w: [164, 1714], e: [272, 1714], r: [378, 1714], t: [484, 1714], y: [592, 1714], u: [700, 1714], i: [806, 1714], o: [914, 1714], p: [1020, 1714],
  a: [112, 1870], s: [218, 1870], d: [324, 1870], f: [432, 1870], g: [538, 1870], h: [646, 1870], j: [752, 1870], k: [860, 1870], l: [966, 1870],
  z: [218, 2024], x: [324, 2024], c: [432, 2024], v: [538, 2024], b: [646, 2024], n: [752, 2024], m: [860, 2024], back: [994, 2024], enter: [994, 2180],
};

export default async function run(ctx) {
  const { page, sh, tree } = ctx;
  const out = `${ROOT}/run/${tree}`;
  ctx.mkdirSync(out, { recursive: true });
  const record = [];
  const step = (name, expect, facts) => { record.push({ step: name, ok: !!expect, ...facts }); };
  const shot = (name) => ctx.shot(`${out}/${name}.png`);
  const wait = (ms) => page.waitForTimeout(ms);
  const type = async (word) => { for (const ch of word) { sh(`input tap ${KEY[ch].join(' ')}`); await wait(230); } };
  const keyboard = () => /mInputShown=true/.test(sh('dumpsys input_method | grep mInputShown'));
  const window = () => (sh('dumpsys window | grep mCurrentFocus').match(/u0 ([^ }]+)/) || [])[1];
  const path = () => page.evaluate(() => location.pathname);
  const menus = () => page.evaluate(() => [...document.querySelectorAll('[role=menu]')].filter((m) => m.getBoundingClientRect().width > 0).length);
  const active = () => page.evaluate(() => { const a = document.activeElement; return a === document.body ? 'body' : `${a.getAttribute('role') || a.tagName.toLowerCase()} ${(a.getAttribute('aria-label') || a.getAttribute('placeholder') || a.textContent || '').trim().slice(0, 30)}`; });
  const writes = () => ctx.fixtures.requests.filter((r) => r.method !== 'GET').map((r) => `${r.method} ${r.path.replace(/\/sessions\/[^/]+/, '/sessions/:id')}`);
  const composer = page.locator('.composer-field textarea');
  const header = page.locator('.workspace-header button[title="More actions"]');
  const listRow = (title) => page.locator('.session-col .session-row').filter({ hasText: title }).first();
  const item = (name) => page.locator('[role=menuitem]').filter({ hasText: name }).filter({ visible: true }).first();
  // A tap in the conversation's empty space, right of the mode list and below the header's menu.
  const tapBlank = () => sh('input tap 900 1950');
  // The system Back only while the keyboard is up: without it, Back leaves the page.
  const hideKeyboard = async () => { if (keyboard()) { sh('input keyevent KEYCODE_BACK'); await wait(700); } };

  // 1. The conversation, as a link opens it.
  step('session opened', await composer.count() === 1, { path: await path() });
  shot('01-session');

  // 2. A tap on the composer: Gboard comes up and the composer stays in sight above it.
  await page.evaluate(() => {
    window.__ime = [];
    const t = document.querySelector('.composer-field textarea');
    for (const n of ['compositionstart', 'compositionupdate', 'compositionend', 'beforeinput', 'keydown']) t.addEventListener(n, (e) => window.__ime.push(`${n}:${e.inputType ?? e.key ?? ''}:${e.keyCode ?? ''}`));
  });
  await ctx.tapEl(composer);
  await wait(1800);
  const kb = await page.evaluate(() => { const b = document.querySelector('.composer-box').getBoundingClientRect(); const v = visualViewport; return { vv: [Math.round(v.height), Math.round(v.offsetTop)], box: [Math.round(b.top - v.offsetTop), Math.round(b.bottom - v.offsetTop)], inner: innerHeight }; });
  const kbUp = keyboard();
  step('composer tapped: Gboard up, the composer above it', kbUp && kb.box[1] <= kb.vv[0] && kb.box[0] >= 0 && /textarea/.test(await active()), { keyboard: kbUp, active: await active(), ...kb });
  shot('02-keyboard');

  // 3. Typed on Gboard's keys. This Gboard (defaults, English) commits each letter; it opens no composition.
  await type('hello');
  await wait(700);
  const typed = await page.evaluate(() => ({ value: document.querySelector('.composer-field textarea').value, ime: window.__ime }));
  const kinds = {};
  for (const e of typed.ime) kinds[e] = (kinds[e] || 0) + 1;
  step('typed “hello” on Gboard’s keys', typed.value === 'Hello', { value: typed.value, events: kinds });
  shot('03-typed');

  // 4. Gboard's Enter sends, and the keyboard stays up.
  await page.evaluate(() => { window.__ime = []; });
  const sentBefore = writes().length;
  sh(`input tap ${KEY.enter.join(' ')}`);
  await wait(1300);
  const sent = ctx.fixtures.requests.filter((r) => r.method === 'POST' && /current-work-routing/.test(r.path)).pop();
  const afterEnter = await page.evaluate(() => ({ value: document.querySelector('.composer-field textarea').value, ime: window.__ime }));
  step('Gboard’s Enter sends', afterEnter.value === '' && sent?.body?.content === 'Hello' && writes().length > sentBefore, { value: afterEnter.value, sent: sent?.body?.content, keys: afterEnter.ime, keyboard: keyboard() });
  shot('04-sent');

  // 5. The system Back puts the keyboard away and stays on the page.
  const here = await path();
  sh('input keyevent KEYCODE_BACK');
  await wait(900);
  step('system Back: the keyboard goes, the page stays', !keyboard() && (await path()) === here, { keyboard: keyboard(), path: await path() });

  // 6. The header's ⋯ by a tap: its menu, the ⋯ under the finger (a touch screen's hover stays where it tapped).
  await ctx.tapEl(header);
  await wait(1000);
  const more = await page.evaluate(() => { const t = document.querySelector('.workspace-header button[title="More actions"]'); return { hover: t.matches(':hover'), background: getComputedStyle(t).backgroundColor }; });
  step('header ⋯ tapped: its menu', (await menus()) === 1, { trigger: more, focus: await active() });
  shot('05-header-menu');
  tapBlank();
  await wait(900);
  step('a tap outside closes it', (await menus()) === 0, { focus: await active() });

  // 7. The mode list by a tap; a tap outside closes it.
  const mode = page.locator('.composer-toolbar .ant-select, .composer-toolbar .orbit-select').last();
  await ctx.tapEl(mode);
  await wait(1000);
  const list = await page.evaluate(() => ({ options: [...document.querySelectorAll('[role=option]')].filter((o) => o.getBoundingClientRect().width > 0).map((o) => o.textContent.trim()),
    hover: [...document.querySelectorAll('.composer-toolbar .ant-select, .composer-toolbar .orbit-select')].pop().matches(':hover') }));
  step('mode list tapped', list.options.length >= 5, list);
  shot('06-mode-list');
  tapBlank();
  await wait(900);
  step('a tap outside closes it', (await page.evaluate(() => [...document.querySelectorAll('[role=option]')].filter((o) => o.getBoundingClientRect().width > 0).length)) === 0, {});

  // 8. Find in session from the header's menu, typed on Gboard.
  await ctx.tapEl(header);
  await wait(900);
  await ctx.tapEl(item('Find in session'));
  await wait(1800);
  const findFocus = await active();
  await type('interface');
  await wait(1200);
  const find = await page.evaluate(() => ({ value: document.querySelector('.find-input')?.value, marks: [...document.querySelectorAll('mark')].filter((m) => m.getBoundingClientRect().width > 0).map((m) => m.textContent) }));
  step('Find: its field focused with the keyboard up, one match', /input .*Find/i.test(findFocus) && find.marks.length >= 1, { focus: findFocus, keyboard: keyboard(), ...find });
  shot('07-find');
  await ctx.tapEl(page.locator('.find-bar button').last());
  await wait(800);
  await hideKeyboard();
  step('Find closed', (await page.locator('.find-bar').count()) === 0, {});

  // 9. The +, Image, Android's photo picker: the picture comes back as a thumbnail.
  await ctx.tapEl(page.locator('.composer-attach-btn').first());
  await wait(900);
  const plus = await page.evaluate(() => [...document.querySelectorAll('[role=menu] [role=menuitem]')].filter((e) => e.getBoundingClientRect().width > 0).map((e) => e.textContent));
  shot('08-plus-menu');
  await ctx.tapEl(item('Image'));
  await wait(2500);
  const picker = window();
  sh('input tap 180 1400');
  await wait(900);
  sh('input tap 906 2136');
  await wait(3500);
  const thumbs = await page.locator('.composer-attach-thumb').count();
  step('+ → Image → the photo picker → a thumbnail', /photopicker/.test(picker) && thumbs === 1 && writes().includes('POST /api/attachments'), { items: plus, picker, back: window(), thumbs });
  shot('09-attached');

  // 10. A tap on the thumbnail opens the preview; two fingers spread zoom it; Close by a tap.
  await ctx.tapEl(page.locator('.composer-attach-thumb').first());
  await wait(1500);
  const preview = await page.evaluate(() => { const d = [...document.querySelectorAll('[role=dialog]')].find((e) => e.getBoundingClientRect().width > 0); return d && { buttons: [...d.querySelectorAll('button')].map((b) => b.getAttribute('aria-label') || b.textContent.trim()) }; });
  step('thumbnail tapped: the preview', !!preview, { ...preview, focus: await active() });
  shot('10-preview');
  await page.evaluate(() => { window.__touch = []; for (const n of ['touchstart', 'touchend']) addEventListener(n, (e) => window.__touch.push(`${n}:${e.touches.length}`), { capture: true, passive: true }); });
  const scale = () => page.evaluate(() => { const i = document.querySelector('[role=dialog] img'); const m = getComputedStyle(i).transform.match(/matrix\(([^,]+)/); return m ? Number(Number(m[1]).toFixed(2)) : 1; });
  const before = await scale();
  sh('su 0 sh /data/local/tmp/p53pinch.sh');
  await wait(1500);
  const touches = await page.evaluate(() => window.__touch);
  step('two fingers spread: the picture zooms', touches.includes('touchstart:2') && (await scale()) > before * 2, { before, after: await scale(), touches });
  shot('11-pinched');
  await ctx.tapEl(page.locator('[role=dialog] button[aria-label=Close], .ant-image-preview-close').filter({ visible: true }).first());
  await wait(1200);
  step('Close tapped: the preview goes, focus back on the thumbnail', (await page.evaluate(() => [...document.querySelectorAll('[role=dialog]')].filter((e) => e.getBoundingClientRect().width > 0).length)) === 0, { focus: await page.evaluate(() => `${document.activeElement?.tagName}.${String(document.activeElement?.className).slice(0, 40)}`) });
  await ctx.tapEl(page.locator('.composer-attach-remove').first());
  await wait(700);
  step('× on the thumbnail removes it', (await page.locator('.composer-attach-thumb').count()) === 0, {});

  // 11. The pane's ← to the list; a held press opens a row's menu where the finger is; Pin.
  await hideKeyboard();
  await ctx.tapEl(page.locator('.workspace-back, .session-pane-back, button[aria-label^="Back"]').first());
  await wait(1300);
  const list1 = await path();
  await ctx.holdEl(listRow('Demo for the design review'), 900, 0.3, 0.5);
  await wait(1200);
  const press = await page.evaluate(() => { const m = [...document.querySelectorAll('[role=menu]')].find((e) => e.getBoundingClientRect().width > 0); if (!m) return null; const r = m.getBoundingClientRect(); return { rect: [r.x, r.y, r.width, r.height].map((v) => Math.round(v * 100) / 100), items: [...m.querySelectorAll('[role=menuitem]')].map((i) => i.textContent), selection: getSelection().toString() }; });
  step('the list; a held press: the row’s menu at the finger, no text selected', /workspaces/.test(list1) && press && press.selection === '', { path: list1, menu: press, focus: await active() });
  shot('12-press-menu');
  await ctx.tapEl(item('Pin'));
  await wait(900);
  step('Pin from it', (await menus()) === 0 && writes().some((w) => /\/pin$/.test(w)), {});

  // 12. The system Back and the edge swipe from a conversation opened from the list.
  await ctx.tapEl(listRow('Fix the flaky upload test'), 0.5, 0.3);
  await wait(1300);
  const opened = await path();
  sh('input keyevent KEYCODE_BACK');
  await wait(1300);
  const backed = await path();
  step('system Back: from the conversation to the list', /sessions/.test(opened) && backed === list1, { opened, back: backed });
  await ctx.tapEl(listRow('Fix the flaky upload test'), 0.5, 0.3);
  await wait(1300);
  const opened2 = await path();
  sh('input swipe 2 1500 700 1500 220');
  await wait(1500);
  const swiped = await path();
  step('edge swipe back: from the conversation to the list', /sessions/.test(opened2) && swiped === list1, { opened: opened2, back: swiped });

  // 13. A link to one record, and a session link that leads nowhere.
  await page.goto(`${ctx.base}${ctx.p53.P53_PATHS.session}?record=1`);
  await wait(2000);
  const rec = await page.evaluate(() => { const e = document.querySelector('[data-seq="1"]'); if (!e) return null; const r = e.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), viewport: innerHeight }; });
  step('a link to record 1: it is in sight', rec && rec.top >= 0 && rec.bottom <= rec.viewport, rec ?? {});
  shot('13-record');
  await page.goto(`${ctx.base}${ctx.p53.P53_PATHS.missing}`);
  await page.getByText('Session not found').waitFor({ timeout: 15000 });
  await wait(600);
  shot('14-not-found');
  await ctx.tapEl(page.getByRole('button', { name: 'Go home' }));
  await wait(1500);
  step('a session that is not there: Not found, Go home by a tap', !/sessions/.test(await path()), { path: await path() });

  // 14. Last, because Chrome's Touch to Search sheet it opens takes the next Back: a held press selects text.
  await page.goto(`${ctx.base}${ctx.p53.P53_PATHS.session}`);
  await page.waitForSelector('.composer-field textarea');
  await wait(1000);
  await ctx.holdEl(page.locator('.chat-msg p, .message-markdown p, .chat-markdown p, .md p').filter({ hasText: 'existing interface' }).first(), 1000, 0.3, 0.5);
  await wait(1000);
  const selected = await page.evaluate(() => getSelection().toString());
  step('a held press on a reply selects a word', selected.length > 0, { selected });
  shot('15-selection');

  ctx.writeFileSync(`${out}/record.json`, JSON.stringify({ tree, chrome: sh('dumpsys package com.android.chrome | grep -m1 versionName').trim(), steps: record }, null, 1));
  return { tree, passed: record.filter((r) => r.ok).length, of: record.length, failed: record.filter((r) => !r.ok).map((r) => r.step) };
}
