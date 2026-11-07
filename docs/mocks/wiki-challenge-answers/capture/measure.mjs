// Crops for the board (card top, card foot) and the boxes its marks ring, today and with the proposal injected.
// Nothing is pressed. usage: FONTCONFIG_FILE=… node measure.mjs <out-dir>
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from '/root/.orbit/worktrees/1ff76a3e-e1d0-52b9-a611-9b0c45796a70/node_modules/playwright/index.mjs';
const out = process.argv[2];
fs.mkdirSync(out, { recursive: true });
const st = JSON.parse(fs.readFileSync('/mnt/data/tmp/34tDf8/stack/seed.json', 'utf8'));
const src = fs.readFileSync('/mnt/data/tmp/34tDf8/web/propose.mjs', 'utf8');
const COPY = JSON.parse(JSON.stringify(eval('(' + src.slice(src.indexOf('export const COPY = ') + 'export const COPY = '.length, src.indexOf('};', src.indexOf('export const COPY')) + 1) + ')')));
const injectBody = src.slice(src.indexOf('async function inject'), src.indexOf('const shots = {'));
const inject = eval('(' + injectBody.replace('async function inject', 'async function') + ')');
const settle = (page, ms) => page.waitForTimeout(ms);
const browser = await chromium.launch({ args: ['--font-render-hinting=none'] });
const result = {};
for (const variant of ['today', 'prop']) for (const [form, opts] of [['desk', { w: 1440, h: 1000, scale: 2, phone: false }], ['phone', { w: 390, h: 844, scale: 3, phone: true }]]) {
  const ctx = await browser.newContext({ viewport: { width: opts.w, height: opts.h }, deviceScaleFactor: opts.scale, isMobile: opts.phone, hasTouch: opts.phone, colorScheme: 'light', locale: 'en-GB', timezoneId: 'Asia/Shanghai' });
  await ctx.addInitScript(([t, r]) => { localStorage.setItem('orbit_token', t); localStorage.setItem('orbit_refresh', r); localStorage.setItem('orbit-theme', 'light'); }, [st.accessToken, st.refreshToken]);
  const page = await ctx.newPage();
  await page.goto('http://127.0.0.1:2734/wiki/review', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !document.getElementById('boot'));
  await page.locator('.wk-prop').nth(form === 'desk' ? 3 : 0).waitFor({ timeout: 30000 });
  await settle(page, 1500);
  if (variant === 'prop') await inject.call(null, page);
  // Tall enough for the whole page, so every crop is one frame.
  const need = await page.evaluate(() => Math.max(...[...document.querySelectorAll('*')].filter((el) => el.scrollHeight > el.clientHeight + 4 && getComputedStyle(el).overflowY !== 'visible').map((el) => el.scrollHeight + el.getBoundingClientRect().top), document.documentElement.scrollHeight));
  await page.setViewportSize({ width: opts.w, height: Math.ceil(need) + 8 });
  await settle(page, 500);
  const index = form === 'desk' ? 1 : 0;
  const boxes = await page.evaluate((i) => {
    const card = document.querySelectorAll('.wk-prop')[i];
    const c = card.getBoundingClientRect();
    const rel = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return [r.x - c.x, r.y - c.y, r.width, r.height].map((v) => Math.round(v * 10) / 10); };
    const buttons = [...card.querySelectorAll('.approval-actions button')];
    const keys = [...card.querySelectorAll('.wk-pkv > .k')];
    const after = keys.find((k) => k.textContent === 'After');
    const similar = keys.find((k) => k.textContent === 'Similar entries');
    return { card: [c.x, c.y, c.width, c.height], line: rel(card.querySelector('.wk-challenge-line')), title: rel(card.querySelector('.wk-prop-t')),
      actions: rel(card.querySelector('.approval-actions')), buttons: buttons.map((b) => ({ text: b.textContent, box: rel(b), cls: b.className, color: getComputedStyle(b).color, bg: getComputedStyle(b).backgroundColor })),
      note: rel(card.querySelector('.wk-challenge-note')), after: rel(after?.nextElementSibling ?? null), afterKey: rel(after ?? null), similar: rel(similar ?? null) };
  }, index);
  result[`${variant}-${form}`] = boxes;
  const [cx, cy, cw, ch] = boxes.card;
  // Top: head, the amber line and the title. Foot: from Similar entries to the card's bottom edge.
  const topH = boxes.title[1] + boxes.title[3] + 10;
  await page.screenshot({ path: path.join(out, `${variant}-${form}-top.png`), clip: { x: cx, y: cy, width: cw, height: topH } });
  const footY = (boxes.similar ? boxes.similar[1] : boxes.actions[1]) - 12;
  await page.screenshot({ path: path.join(out, `${variant}-${form}-foot.png`), clip: { x: cx, y: cy + footY, width: cw, height: ch - footY } });
  await page.screenshot({ path: path.join(out, `${variant}-${form}-card.png`), clip: { x: cx, y: cy, width: cw, height: ch } });
  boxes.footY = footY; boxes.topH = topH;
  await ctx.close();
}
fs.writeFileSync(path.join(out, 'boxes.json'), JSON.stringify(result, null, 1));
await browser.close();
console.log(JSON.stringify(Object.fromEntries(Object.entries(result).map(([k, v]) => [k, { card: v.card, buttons: v.buttons.map((b) => [b.text, b.box, b.bg, b.color]), footY: v.footY, topH: v.topH, after: v.after }])), null, 1));
