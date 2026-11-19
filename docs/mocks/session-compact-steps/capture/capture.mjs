// unshare -n ./run-ns.sh capture.mjs [scene ...] → shots/<name>.png
import fs from 'node:fs';
import { launch, open, outageEvents, settle } from '/var/tmp/compact-steps-mock/lib.mjs';
const OUT = '/var/tmp/compact-steps-mock/shots';
const CSS = {
  // B: the screenshot's ● before every reply.
  bullets: `.chat-msg.chat-assistant { position: relative; }
    .chat-msg.chat-assistant::before { content: ''; position: absolute; left: -1px; top: .72em; width: 7px; height: 7px; border-radius: 50%; background: currentColor; }`,
};
async function clipOf(page) {
  return page.evaluate(() => {
    const nodes = [...document.querySelectorAll('.chat-user-wrap, [data-seq]')];
    const first = document.querySelector('.chat-user-wrap').getBoundingClientRect();
    let bottom = 0, left = 1e9, right = 0;
    for (const n of nodes) { const r = n.getBoundingClientRect(); if (r.height) { bottom = Math.max(bottom, r.bottom); left = Math.min(left, r.left); right = Math.max(right, r.right); } }
    const live = document.querySelector('.chat-steps-live, .chat-tool-card:last-of-type');
    return { x: Math.max(0, Math.round(left - 28)), y: Math.max(0, Math.round(first.top - 16)), width: Math.round(right - left + 56), height: Math.round(bottom - first.top + 40) };
  });
}
async function shot(browser, name, tree, { live = true, failed = false, css, click, theme = 'light' } = {}) {
  const { page, context, errors } = await open(browser, { tree, live, theme, events: outageEvents({ live, failed }), width: 1280, height: 3000 });
  if (css) await page.addStyleTag({ content: css });
  if (click !== undefined) { await page.locator('.chat-steps-line').nth(click).click(); await page.mouse.move(5, 5); }
  await page.waitForTimeout(400); await settle(page);
  const clip = await clipOf(page);
  await page.screenshot({ path: `${OUT}/${name}.png`, clip });
  console.log(name, JSON.stringify(clip), errors.length ? errors.slice(0, 3) : 'ok');
  await context.close();
}
const scenes = {
  'today-live': (b) => shot(b, 'today-live', 'today'),
  'A-live': (b) => shot(b, 'A-live', 'new'),
  'A-open': (b) => shot(b, 'A-open', 'new', { click: 1 }),
  'A-done-failed': (b) => shot(b, 'A-done-failed', 'new', { live: false, failed: true }),
  'B-live': (b) => shot(b, 'B-live', 'new', { css: CSS.bullets }),
  'A-dark': (b) => shot(b, 'A-dark', 'new', { theme: 'dark' }),
};
const want = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(scenes);
const browser = await launch();
try { for (const n of want) await scenes[n](browser); } finally { await browser.close(); }
