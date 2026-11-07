// The proposal drawn INTO the real Review page at capture time (the same build, the same data): each challenge card's
// answers become Keep · Amend… · Retire… (red), an After row says what each does and whether it can be undone, and
// Retire… opens the product's own Retire… dialog with the challenge's reason in it. Nothing is pressed here.
// usage: FONTCONFIG_FILE=/mnt/data/pe-mock/fonts.conf node propose.mjs <out-dir> <shot>[,<shot>...]
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from '/root/.orbit/worktrees/1ff76a3e-e1d0-52b9-a611-9b0c45796a70/node_modules/playwright/index.mjs';
const ORIGIN = 'http://127.0.0.1:2734';
const [out, list] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
const st = JSON.parse(fs.readFileSync('/mnt/data/tmp/34tDf8/stack/seed.json', 'utf8'));
const browser = await chromium.launch({ args: ['--disable-features=BackForwardCache', '--font-render-hinting=none'] });
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);
export const COPY = {
  keep: 'Keep', amend: 'Amend…', retire: 'Retire…',
  after: 'After',
  afterKeep: 'Agents get this entry again. You can still retire it later.',
  afterAmend: 'Agents get your version, and its anchors are checked again.',
  afterRetire: 'Agents stop getting it. This cannot be undone.',
  dialogTitle: 'Retire…',
  dialogNote: 'Agents stop getting this entry. It stays in History, struck through, and the reason goes on the record. This cannot be undone.',
  dialogRetire: 'Retire',
};
async function open(route, { w = 1440, h = 1000, scale = 2, phone = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: scale, isMobile: phone, hasTouch: phone,
    colorScheme: 'light', locale: 'en-GB', timezoneId: 'Asia/Shanghai' });
  await ctx.addInitScript(([t, r]) => { localStorage.setItem('orbit_token', t); localStorage.setItem('orbit_refresh', r); localStorage.setItem('orbit-theme', 'light'); }, [st.accessToken, st.refreshToken]);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => log('pageerror', e.message));
  await page.goto(ORIGIN + route, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !document.getElementById('boot'), null, { timeout: 30000 });
  return { ctx, page };
}
const settle = (page, ms = 600) => page.waitForTimeout(ms);
async function clip(page, locator, file) {
  const box = await locator.boundingBox();
  await page.screenshot({ path: path.join(out, file), clip: { x: box.x, y: box.y, width: box.width, height: box.height } });
  log('wrote', file, Math.round(box.width), 'x', Math.round(box.height));
}
async function fitHeight(page, w, min = 900) {
  const need = await page.evaluate(() => Math.max(...[...document.querySelectorAll('*')].filter((el) => el.scrollHeight > el.clientHeight + 4 && getComputedStyle(el).overflowY !== 'visible').map((el) => el.scrollHeight + el.getBoundingClientRect().top), document.documentElement.scrollHeight));
  await page.setViewportSize({ width: w, height: Math.max(min, Math.ceil(need) + 8) });
  await settle(page, 400);
}
// The proposal, in the console's own classes and tokens.
async function inject(page, watch = false) {
  await page.evaluate(([C, watch]) => {
   const apply = () => {
    const danger = 'color: var(--orbit-control-error); border-color: var(--orbit-control-error); background: var(--bg-raised);';
    for (const card of document.querySelectorAll('.wk-prop')) {
      if (!card.querySelector('.wk-challenge-line') || card.dataset.bProp) continue;
      card.dataset.bProp = '1';
      const kind = card.querySelector('.approval-head .kind')?.textContent?.trim();
      const amendable = kind !== 'Decision';
      const buttons = [...card.querySelectorAll('.approval-actions button')];
      const [reconfirm, amend, retire] = buttons;
      reconfirm.textContent = C.keep;
      reconfirm.className = 'card-action card-action--secondary';
      amend.textContent = C.amend;
      if (!amendable) amend.remove();
      retire.textContent = C.retire;
      retire.setAttribute('style', danger);
      // Keep, Amend…, Retire…: the safe answer first, the one that cannot be undone last.
      const grid = card.querySelector('.wk-pkv');
      const k = document.createElement('span'); k.className = 'k'; k.textContent = C.after;
      const v = document.createElement('span'); v.className = 'v b-after';
      const line = (word, text, red) => `<div style="margin-bottom:4px"><b${red ? ' style="color: var(--orbit-control-error)"' : ''}>${word}</b> · ${text}</div>`;
      v.innerHTML = line('Keep', C.afterKeep) + (amendable ? line('Amend', C.afterAmend) : '') + line('Retire', C.afterRetire, true);
      grid.append(k, v);
    }
    // The toast in the proposal's words: Keep's outcome is Kept (the word Review's Retire card already uses).
    for (const t of document.querySelectorAll('.toast-head')) {
      if (t.textContent === 'Re-confirmed') t.textContent = 'Kept';
    }
   };
   apply();
   if (watch) new MutationObserver(apply).observe(document.body, { childList: true, subtree: true, characterData: true });
  }, [COPY, watch]);
  await settle(page, 300);
}
const shots = {
  // After Keep (the real Re-confirm press, relabelled) on the phone: the toast in the new words, and the next card
  // opened at its top — its reason first — rather than with its answers under the finger.
  async afterPhone() {
    const { ctx, page } = await open('/wiki/review', { w: 390, h: 844, scale: 3, phone: true });
    await page.locator('.wk-prop').first().waitFor({ timeout: 30000 });
    await settle(page, 1500);
    await inject(page, true);
    const keep = page.locator('.wk-prop').first().locator('.approval-actions button', { hasText: 'Keep' });
    await keep.scrollIntoViewIfNeeded();
    await settle(page, 300);
    await page.screenshot({ path: path.join(out, 'prop-after-phone-0-before.png') });
    await keep.click();
    await page.waitForFunction(() => document.querySelector('.wk-pager .pos')?.textContent?.includes('of 3'), null, { timeout: 10000 });
    await page.evaluate(() => document.querySelector('.wk-prop')?.scrollIntoView({ block: 'start' }));
    await page.evaluate(() => { const s = [...document.querySelectorAll('*')].find((el) => el.scrollTop > 0); if (s) s.scrollTop = Math.max(0, s.scrollTop - 64); });
    await settle(page, 350);
    await page.screenshot({ path: path.join(out, 'prop-after-phone-1-next-top.png') });
    await ctx.close();
  },
  async afterDesk() {
    const { ctx, page } = await open('/wiki/review');
    await page.locator('.wk-prop').nth(2).waitFor({ timeout: 30000 });
    await settle(page, 1500);
    await inject(page, true);
    const card = page.locator('.wk-prop').first();
    const keep = card.locator('.approval-actions button', { hasText: 'Keep' });
    await keep.scrollIntoViewIfNeeded();
    await settle(page, 300);
    await keep.click();
    await page.waitForTimeout(700);
    await page.screenshot({ path: path.join(out, 'prop-after-desk-700ms.png') });
    await ctx.close();
  },
  async desk() {
    const { ctx, page } = await open('/wiki/review');
    await page.locator('.wk-prop').nth(3).waitFor({ timeout: 30000 });
    await settle(page, 1500);
    await inject(page);
    await fitHeight(page, 1440);
    await page.screenshot({ path: path.join(out, 'prop-desk-review-full.png') });
    for (let i = 0; i < 4; i += 1) await clip(page, page.locator('.wk-prop').nth(i), `prop-desk-card-${i + 1}.png`);
    await ctx.close();
  },
  async phone() {
    const { ctx, page } = await open('/wiki/review', { w: 390, h: 844, scale: 3, phone: true });
    await page.locator('.wk-prop').first().waitFor({ timeout: 30000 });
    await settle(page, 1500);
    await inject(page);
    await fitHeight(page, 390, 844);
    await page.screenshot({ path: path.join(out, 'prop-phone-review-full.png') });
    await clip(page, page.locator('.wk-prop').first(), 'prop-phone-card-1.png');
    await ctx.close();
  },
  // Retire… on the card opens the product's Retire… dialog (WikiEntryDrawer's), its reason field holding the
  // challenge's reason. Drawn from the page's own Dialog (opened through Amend, which shares it) with the drawer
  // dialog's words and buttons. Nothing is sent.
  async dialog() {
    for (const [name, opts] of [['desk', {}], ['phone', { w: 390, h: 844, scale: 3, phone: true }]]) {
      const { ctx, page } = await open('/wiki/review', opts);
      await page.locator('.wk-prop').nth(name === 'desk' ? 3 : 0).waitFor({ timeout: 30000 });
      await settle(page, 1500);
      const card = page.locator('.wk-prop').nth(1 % (name === 'desk' ? 4 : 1));
      const reason = await card.locator('.wk-challenge-line').innerText();
      await inject(page);
      await card.locator('.approval-actions button', { hasText: 'Amend' }).scrollIntoViewIfNeeded();
      await card.locator('.approval-actions button', { hasText: 'Amend' }).click();
      await page.locator('[role="dialog"]').waitFor();
      await settle(page, 500);
      await page.evaluate(([C, why]) => {
        const dialog = [...document.querySelectorAll('[role="dialog"]')].pop();
        const title = dialog.querySelector('.orbit-overlay-title');
        if (title) title.textContent = C.dialogTitle;
        const note = dialog.querySelector('.wk-modal-note');
        note.textContent = C.dialogNote;
        const input = dialog.querySelector('input');
        if (input) (input.closest('.orbit-input, .orbit-field, span') ?? input).remove();
        const area = dialog.querySelector('textarea');
        area.value = why.replace(/^Challenged · /, '');
        area.rows = 6;
        area.style.height = '150px';
        const [cancel, ok] = [...dialog.querySelectorAll('.orbit-overlay-footer button')].slice(-2);
        ok.textContent = C.dialogRetire;
        ok.disabled = false;
        ok.classList.add('orbit-button-danger');
        cancel.focus();
      }, [COPY, reason]);
      await settle(page, 400);
      await page.screenshot({ path: path.join(out, `prop-${name}-retire-dialog.png`) });
      await clip(page, page.locator('[role="dialog"]').last(), `prop-${name}-retire-dialog-clip.png`);
      await ctx.close();
    }
  },
};
for (const name of list.split(',')) { log('shot', name); await shots[name](); }
await browser.close();
