// usage: node render.cjs <in.html> <out.png> [width]   (2x, fonts injected; playwright-core from /root/orbit)
// With FRAMES=<prefix> it also writes one PNG per frame at its own size (393×852 phones, 820×560 desktop).
const path = require('path');
const fs = require('fs');
const { chromium } = require('/root/orbit/node_modules/playwright-core');
const FONTS = '/var/tmp/landing-mock-render/fonts';
(async () => {
  const [inp, out, w] = process.argv.slice(2);
  const base = process.env.HOME + '/.cache/ms-playwright/chromium_headless_shell-1243';
  const exe = fs.readdirSync(base).map((d) => `${base}/${d}/chrome-headless-shell`).find((p) => fs.existsSync(p));
  const b = await chromium.launch({ executablePath: exe });
  const p = await b.newPage({ viewport: { width: +(w || 1900), height: 1000 }, deviceScaleFactor: 2 });
  await p.goto('file://' + path.resolve(inp));
  await p.addStyleTag({
    content: `@font-face{font-family:Inter;src:url(file://${FONTS}/Inter.ttf)}@font-face{font-family:"Noto Sans SC";src:url(file://${FONTS}/NotoSansSC.ttf)}`,
  });
  await p.evaluate(() => document.fonts.ready);
  await p.waitForTimeout(400);
  await p.screenshot({ path: out, fullPage: true, timeout: 180000 });
  if (process.env.FRAMES) {
    const els = await p.$$('.w-frame, .phone, .droid');
    for (let i = 0; i < els.length; i++) {
      await els[i].screenshot({ path: `${process.env.FRAMES}-${String(i + 1).padStart(2, '0')}.png`, timeout: 180000 });
    }
  }
  await b.close();
})();
