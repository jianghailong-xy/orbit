// Real-stack captures of the web console's Wiki Review (gateway :2734 -> this worktree's apiserver :3734).
// usage: FONTCONFIG_FILE=/mnt/data/pe-mock/fonts.conf node capture.mjs <out-dir> <shot>[,<shot>...]
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from '/root/.orbit/worktrees/1ff76a3e-e1d0-52b9-a611-9b0c45796a70/node_modules/playwright/index.mjs';
const ORIGIN = process.env.ORIGIN ?? 'http://127.0.0.1:2734';
const [out, list] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
const st = JSON.parse(fs.readFileSync('/mnt/data/tmp/34tDf8/stack/seed.json', 'utf8'));
const browser = await chromium.launch({ args: ['--disable-features=BackForwardCache', '--font-render-hinting=none'] });
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);

async function open(route, { w = 1440, h = 1000, scale = 2, phone = false, theme = 'light' } = {}) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: scale, isMobile: phone, hasTouch: phone,
    colorScheme: theme, locale: 'en-GB', timezoneId: 'Asia/Shanghai' });
  await ctx.addInitScript(([t, r, th]) => {
    localStorage.setItem('orbit_token', t); localStorage.setItem('orbit_refresh', r); localStorage.setItem('orbit-theme', th);
  }, [st.accessToken, st.refreshToken, theme]);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => log('pageerror', e.message));
  await page.goto(ORIGIN + route, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !document.getElementById('boot'), null, { timeout: 30000 });
  return { ctx, page };
}
async function settle(page, ms = 600) {
  await page.waitForTimeout(ms);
  await page.evaluate(() => Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming().endTime !== Infinity).map((a) => a.finished.catch(() => {}))));
}
async function clip(page, locator, file, pad = 0) {
  const box = await locator.boundingBox();
  if (!box) throw new Error(`no box for ${file}`);
  await page.screenshot({ path: path.join(out, file), clip: { x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad), width: box.width + 2 * pad, height: box.height + 2 * pad } });
  log('wrote', file, Math.round(box.width), 'x', Math.round(box.height));
  return box;
}
// Grow the viewport until the page's scroller holds everything, so one frame shows the whole card.
async function fitHeight(page, w, min = 900) {
  const need = await page.evaluate(() => Math.max(...[...document.querySelectorAll('*')].filter((el) => el.scrollHeight > el.clientHeight + 4 && getComputedStyle(el).overflowY !== 'visible').map((el) => el.scrollHeight + el.getBoundingClientRect().top), document.documentElement.scrollHeight));
  const h = Math.max(min, Math.ceil(need) + 8);
  await page.setViewportSize({ width: w, height: h });
  await settle(page, 400);
  return h;
}

const shots = {
  // Desktop Review with the four challenge cards, as the owner met them (1440 wide).
  async desk() {
    const { ctx, page } = await open('/wiki/review');
    await page.locator('.wk-prop').nth(3).waitFor({ timeout: 30000 });
    await settle(page, 1500);
    await page.screenshot({ path: path.join(out, 'desk-review-viewport.png') });
    await fitHeight(page, 1440);
    await page.screenshot({ path: path.join(out, 'desk-review-full.png') });
    for (let i = 0; i < 4; i += 1) await clip(page, page.locator('.wk-prop').nth(i), `desk-card-${i + 1}.png`, 0);
    await clip(page, page.locator('.wk-prop').nth(1).locator('.approval-actions'), 'desk-card-2-actions.png', 0);
    await ctx.close();
  },
  // Phone web (390 wide): one card at a time with the pager.
  async phone() {
    const { ctx, page } = await open('/wiki/review', { w: 390, h: 844, scale: 3, phone: true });
    await page.locator('.wk-prop').first().waitFor({ timeout: 30000 });
    await settle(page, 1500);
    await page.screenshot({ path: path.join(out, 'phone-review-viewport.png') });
    await fitHeight(page, 390, 844);
    await page.screenshot({ path: path.join(out, 'phone-review-full.png') });
    await clip(page, page.locator('.wk-prop').first(), 'phone-card-1.png', 0);
    await ctx.close();
  },
  // A press of Re-confirm on the desktop's second card (34ZfFGATAFiBBi9qmqPF7): what the owner sees just after.
  async pressDesk() {
    const { ctx, page } = await open('/wiki/review');
    await page.locator('.wk-prop').nth(3).waitFor({ timeout: 30000 });
    await settle(page, 1200);
    const card = page.locator('.wk-prop').nth(1);
    await card.scrollIntoViewIfNeeded();
    await settle(page, 300);
    await page.screenshot({ path: path.join(out, 'press-desk-0-before.png') });
    const t0 = Date.now();
    await card.getByRole('button', { name: 'Re-confirm', exact: true }).click();
    for (const ms of [250, 900, 2500, 5000]) {
      await page.waitForTimeout(Math.max(0, ms - (Date.now() - t0)));
      await page.screenshot({ path: path.join(out, `press-desk-${ms}ms.png`) });
      log('press frame', ms, 'cards', await page.locator('.wk-prop').count());
    }
    await ctx.close();
  },
  // The same press on the phone (the card on screen, then what replaces it).
  async pressPhone() {
    const { ctx, page } = await open('/wiki/review', { w: 390, h: 844, scale: 3, phone: true });
    await page.locator('.wk-prop').first().waitFor({ timeout: 30000 });
    await settle(page, 1200);
    const button = page.locator('.wk-prop').first().getByRole('button', { name: 'Re-confirm', exact: true });
    await button.scrollIntoViewIfNeeded();
    await settle(page, 300);
    await page.screenshot({ path: path.join(out, 'press-phone-0-before.png') });
    const t0 = Date.now();
    await button.click();
    for (const ms of [250, 900, 2500]) {
      await page.waitForTimeout(Math.max(0, ms - (Date.now() - t0)));
      await page.screenshot({ path: path.join(out, `press-phone-${ms}ms.png`) });
      log('press frame', ms, 'pager', await page.locator('.wk-pager .pos').textContent().catch(() => null));
    }
    await ctx.close();
  },
  // The product's own irreversible Retire: the entry drawer's Retire… dialog (desktop), for the board's reference.
  async drawerRetire() {
    const id = st.entryIds['34ZfFGMSeZihiWjfnfrqp'];
    const { ctx, page } = await open(`/wiki/orbit/e/${id}`);
    await page.locator('.tdp-title').first().waitFor({ timeout: 30000 });
    await settle(page, 1200);
    await page.getByRole('button', { name: 'More actions' }).click();
    await settle(page, 400);
    await page.screenshot({ path: path.join(out, 'drawer-menu.png') });
    await page.getByRole('menuitem', { name: /Retire/ }).click();
    await settle(page, 600);
    await page.screenshot({ path: path.join(out, 'drawer-retire-dialog.png') });
    await clip(page, page.locator('[role="dialog"]').last(), 'drawer-retire-dialog-clip.png', 0);
    await ctx.close();
  },
  // The retire card (changeset 34stmJcx3PtpKqU6EUnBD's ops), the one the owner answered right at 23:35Z.
  async retireCards() {
    const { ctx, page } = await open('/wiki/review');
    await page.locator('.wk-prop').first().waitFor({ timeout: 30000 });
    await settle(page, 1500);
    await fitHeight(page, 1440);
    await page.screenshot({ path: path.join(out, 'retire-review-full.png') });
    const n = await page.locator('.wk-prop').count();
    for (let i = 0; i < n; i += 1) await clip(page, page.locator('.wk-prop').nth(i), `retire-card-${i + 1}.png`, 0);
    await ctx.close();
    const phone = await open('/wiki/review', { w: 390, h: 844, scale: 3, phone: true });
    await phone.page.locator('.wk-prop').first().waitFor({ timeout: 30000 });
    await settle(phone.page, 1200);
    await fitHeight(phone.page, 390, 844);
    await phone.page.screenshot({ path: path.join(out, 'retire-phone-full.png') });
    await phone.ctx.close();
  },
};
for (const name of list.split(',')) { log('shot', name); await shots[name](); }
await browser.close();
