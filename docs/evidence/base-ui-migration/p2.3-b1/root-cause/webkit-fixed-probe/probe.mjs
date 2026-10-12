// WebKit/Chromium, the P0 phone and desktop contexts (390x844 isMobile+hasTouch / 1280x900, DPR 1):
// width of a fixed inset:0 element and of documentElement.clientWidth on a bare page, with the document
// fitting the viewport and with it 1px taller; plus whether an element laid out before the overflow keeps
// its width (no relayout) while a fresh one sees the new width.
import { chromium, webkit } from '/root/.orbit/worktrees/bf593adf-7724-576c-968c-fcd10880a595/node_modules/playwright/index.mjs';
const html = `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1">
<style>html,body{margin:0}#page{height:100vh}</style><div id="page"></div>`;
const results = [];
for (const [name, type] of [['chromium', chromium], ['webkit', webkit]]) {
  const browser = await type.launch();
  for (const size of ['phone', 'desktop']) {
    const context = await browser.newContext(size === 'phone'
      ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 }
      : { viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    await page.setContent(html);
    const r = await page.evaluate(async () => {
      const frame = () => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
      const fixed = (css) => { const el = document.createElement('div'); el.style.cssText = `position:fixed;top:0;height:1px;visibility:hidden;${css}`; document.body.appendChild(el); return el; };
      const early = fixed('inset:0 auto auto 0;left:0;right:0');
      const earlyColumn = fixed('left:16px;right:16px');
      await frame();
      const fits = { clientWidth: document.documentElement.clientWidth, innerWidth, scrollHeight: document.documentElement.scrollHeight, freshProbe: fixed('left:0;right:0').getBoundingClientRect().width, early: early.getBoundingClientRect().width };
      document.getElementById('page').style.height = 'calc(100vh + 1px)';
      await frame();
      const overflow = { clientWidth: document.documentElement.clientWidth, innerWidth, scrollHeight: document.documentElement.scrollHeight,
        freshProbe: fixed('left:0;right:0').getBoundingClientRect().width, freshColumn: fixed('left:16px;right:16px').getBoundingClientRect().width,
        earlyProbe: early.getBoundingClientRect().width, earlyColumn: earlyColumn.getBoundingClientRect().width };
      earlyColumn.style.top = '1px';
      await frame();
      overflow.earlyColumnAfterItsOwnStyleChange = earlyColumn.getBoundingClientRect().width;
      return { fits, overflow };
    });
    results.push({ browser: name, version: browser.version(), size, ...r });
    await context.close();
  }
  await browser.close();
}
console.log(JSON.stringify(results, null, 1));
