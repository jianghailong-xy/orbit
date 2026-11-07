// The implemented card on the real stack (gateway :2735 serves dist-new, this worktree's web build; :3734 is this
// worktree's apiserver). Same data, same sizes as the board's captures. Presses are real decides.
// usage: FONTCONFIG_FILE=… node impl.mjs <out-dir> <shot>[,<shot>…]
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from '/root/.orbit/worktrees/1ff76a3e-e1d0-52b9-a611-9b0c45796a70/node_modules/playwright/index.mjs';
const ORIGIN = process.env.ORIGIN ?? 'http://127.0.0.1:2735';
const [out, list] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
const st = JSON.parse(fs.readFileSync('/mnt/data/tmp/34tDf8/stack/seed.json', 'utf8'));
const browser = await chromium.launch({ args: ['--disable-features=BackForwardCache', '--font-render-hinting=none'] });
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);
const facts = {};
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
// What the card shows, read off the page: the answers with their classes and colours, and the After lines.
const read = (page, index) => page.evaluate((i) => {
  const card = document.querySelectorAll('.wk-prop')[i];
  return {
    answers: [...card.querySelectorAll('.approval-actions button')].map((b) => ({ text: b.textContent, cls: b.className,
      color: getComputedStyle(b).color, bg: getComputedStyle(b).backgroundColor, border: getComputedStyle(b).borderColor })),
    after: [...card.querySelectorAll('.wk-challenge-after > div')].map((d) => d.textContent),
    note: card.querySelector('.wk-challenge-note')?.textContent ?? null,
  };
}, index);
const shots = {
  async desk() {
    const { ctx, page } = await open('/wiki/review');
    await page.locator('.wk-prop').nth(3).waitFor({ timeout: 30000 });
    await settle(page, 1500);
    await fitHeight(page, 1440);
    for (let i = 0; i < 4; i += 1) await clip(page, page.locator('.wk-prop').nth(i), `impl-desk-card-${i + 1}.png`);
    facts.desk = [await read(page, 1), await read(page, 3)];
    await ctx.close();
  },
  async phone() {
    const { ctx, page } = await open('/wiki/review', { w: 390, h: 844, scale: 3, phone: true });
    await page.locator('.wk-prop').first().waitFor({ timeout: 30000 });
    await settle(page, 1500);
    await fitHeight(page, 390, 844);
    await clip(page, page.locator('.wk-prop').first(), 'impl-phone-card-1.png');
    facts.phone = await read(page, 0);
    await ctx.close();
  },
  async dialog() {
    for (const [name, opts] of [['desk', {}], ['phone', { w: 390, h: 844, scale: 3, phone: true }]]) {
      const { ctx, page } = await open('/wiki/review', opts);
      await page.locator('.wk-prop').nth(name === 'desk' ? 3 : 0).waitFor({ timeout: 30000 });
      await settle(page, 1500);
      const card = page.locator('.wk-prop').nth(name === 'desk' ? 1 : 0);
      const retire = card.locator('.approval-actions button', { hasText: 'Retire…' });
      await retire.scrollIntoViewIfNeeded();
      await retire.click();
      await page.locator('[role="dialog"]').waitFor();
      await settle(page, 700);
      await page.screenshot({ path: path.join(out, `impl-${name}-retire-dialog.png`) });
      await clip(page, page.locator('[role="dialog"]').last(), `impl-${name}-retire-dialog-clip.png`);
      facts[`${name}Dialog`] = await page.evaluate(() => {
        const d = [...document.querySelectorAll('[role="dialog"]')].pop();
        return { title: d.querySelector('.orbit-overlay-title')?.textContent, note: d.querySelector('.wk-modal-note')?.textContent,
          reason: d.querySelector('textarea')?.value?.slice(0, 80), focused: document.activeElement?.textContent,
          buttons: [...d.querySelectorAll('.orbit-overlay-footer button')].map((b) => [b.textContent, b.className, b.disabled]) };
      });
      await page.locator('[role="dialog"]').last().getByRole('button', { name: 'Cancel' }).click();
      await settle(page, 500);
      await ctx.close();
    }
  },
  // Keep pressed on the phone's first card: the toast, and the next card from its top. A real decide.
  async keepPhone() {
    const { ctx, page } = await open('/wiki/review', { w: 390, h: 844, scale: 3, phone: true });
    await page.locator('.wk-prop').first().waitFor({ timeout: 30000 });
    await settle(page, 1500);
    const keep = page.locator('.wk-prop').first().locator('.approval-actions button', { hasText: 'Keep' });
    await keep.scrollIntoViewIfNeeded();
    await settle(page, 300);
    await page.screenshot({ path: path.join(out, 'impl-phone-keep-0-before.png') });
    const before = await keep.boundingBox();
    await keep.click();
    await page.waitForFunction(() => document.querySelector('.wk-pager .pos')?.textContent?.includes('of 3'), null, { timeout: 10000 });
    await settle(page, 600);
    await page.screenshot({ path: path.join(out, 'impl-phone-keep-1-after.png') });
    facts.keepPhone = await page.evaluate((y) => {
      const at = document.elementFromPoint(195, y);
      return { toast: document.querySelector('.toast-head')?.textContent, pager: document.querySelector('.wk-pager .pos')?.textContent,
        cardHeadTop: Math.round(document.querySelector('.wk-prop .approval-head')?.getBoundingClientRect().top ?? -1),
        underFinger: at ? (at.closest('button')?.textContent ?? at.className ?? at.tagName) : null };
    }, before.y + before.height / 2);
    await ctx.close();
  },
};
for (const name of list.split(',')) { log('shot', name); await shots[name](); }
fs.writeFileSync(path.join(out, 'facts.json'), JSON.stringify(facts, null, 1));
console.log(JSON.stringify(facts, null, 1));
await browser.close();
