// Painted frames (Chromium headless shell, begin-frame control): after the opening input, each frame is produced
// on demand with a screenshot. For every frame: the popup's box read inside requestAnimationFrame (before the
// frame's layout observers) and after the frame was produced (the DOM then, which may already hold work done after
// the paint), the owner's box and scroll, and how much of the picture's settled box matches the last frame's
// (pictureMatch: the share of equal pixels; 1 is the popup drawn where it settles, with the same contents).
// usage: node painted.mjs <port> <label> <outdir> <desktop|phone> <case>...   case: <sample>@<query>[!]
// A case ending in ! also writes its first four frames and the last one whole.
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
const require = createRequire(`${process.cwd()}/src/web/package.json`);
const { chromium } = require('@playwright/test');
// Playwright's own PNG codec (pngjs, bundled), as nothing else in the tree decodes PNG.
const { PNG } = require('playwright-core/lib/utilsBundle');
const [port, label, outdir, size, ...cases] = process.argv.slice(2);
mkdirSync(outdir, { recursive: true });
const browser = await chromium.launch({ args: ['--deterministic-mode', '--enable-begin-frame-control', '--run-all-compositor-stages-before-draw', '--disable-threaded-animation', '--disable-threaded-scrolling', '--disable-checker-imaging'] });
const results = [];
for (const raw of cases) {
  const whole = raw.endsWith('!');
  const [sample, query] = raw.replace(/!$/, '').split('@');
  const context = await browser.newContext({ viewport: size === 'phone' ? { width: 390, height: 844 } : { width: 1280, height: 900 },
    isMobile: size === 'phone', hasTouch: size === 'phone', deviceScaleFactor: 1, reducedMotion: 'reduce', locale: 'en-US', timezoneId: 'UTC' });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('HeadlessExperimental.enable');
  const begin = (screenshot) => cdp.send('HeadlessExperimental.beginFrame', screenshot ? { screenshot: { format: 'png' } } : {});
  let pumping = true;
  const pump = (async () => { while (pumping) { await begin(false).catch(() => {}); await new Promise((r) => setTimeout(r, 16)); } })();
  await page.goto(`http://127.0.0.1:${port}/ui-migration/choices.html?sample=${sample}&system=orbit${query ? `&${query}` : ''}`);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(600);
  const keyboard = sample === 'attachment';
  const target = sample === 'attachment' || sample === 'popover' ? page.getByRole('region', { name: 'Appearance sample' }).getByRole('button').first()
    : page.getByRole('region', { name: 'Appearance sample' }).getByRole('combobox', { name: 'Sample choice' });
  if (keyboard) await target.focus();
  const at = await target.boundingBox();
  await page.evaluate(() => {
    window.rafReads = [];
    const tick = () => {
      const surface = [...document.querySelectorAll('.sample-surface')].at(-1);
      const positioner = surface?.closest('.orbit-floating-positioner');
      if (surface && getComputedStyle(positioner).opacity !== '0') { const b = surface.getBoundingClientRect(); window.rafReads.push([b.x, b.y, b.width, b.height]); }
      else window.rafReads.push(null);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  pumping = false; await pump;
  await page.evaluate(() => { window.rafReads = []; });
  // The opening input, handled before any further frame is produced.
  if (keyboard) await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 })
    .then(() => cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 }));
  else {
    const x = at.x + 8, y = at.y + at.height / 2;
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  }
  const frames = [];
  for (let i = 0; i < 8; i++) {
    const shot = await begin(true);
    const { produced, owner } = await page.evaluate(() => {
      const surface = [...document.querySelectorAll('.sample-surface')].at(-1);
      const positioner = surface?.closest('.orbit-floating-positioner');
      const box = surface && getComputedStyle(positioner).opacity !== '0' ? surface.getBoundingClientRect() : null;
      const dialog = document.querySelector('.orbit-overlay')?.getBoundingClientRect();
      const viewport = document.querySelector('.orbit-overlay-viewport');
      return { produced: box && [box.x, box.y, box.width, box.height],
        owner: dialog ? { x: dialog.x, y: dialog.y, scrollLeft: viewport.scrollLeft, scrollTop: viewport.scrollTop } : null };
    });
    const raf = await page.evaluate(() => window.rafReads.splice(0));
    frames.push({ frame: i, raf: raf.at(-1) ?? null, produced, owner, png: shot.screenshotData ? PNG.sync.read(Buffer.from(shot.screenshotData, 'base64')) : null });
  }
  const settled = frames.at(-1);
  const region = (png, box) => {
    const [x0, y0, w, h] = box.map(Math.round);
    const out = [];
    for (let y = Math.max(0, y0); y < Math.min(png.height, y0 + h); y++) for (let x = Math.max(0, x0); x < Math.min(png.width, x0 + w); x++) {
      const i = (y * png.width + x) * 4; out.push(png.data[i], png.data[i + 1], png.data[i + 2]);
    }
    return Buffer.from(out);
  };
  const first = frames.find((frame) => frame.produced);
  const match = (a, b) => {
    let same = 0;
    for (let i = 0; i < a.length; i += 3) if (a[i] === b[i] && a[i + 1] === b[i + 1] && a[i + 2] === b[i + 2]) same += 1;
    return a.length ? Math.round((same / (a.length / 3)) * 1000) / 1000 : null;
  };
  const record = { label, size, sample, query, settledBox: settled.produced,
    frames: frames.map(({ frame, raf, produced, owner, png }) => ({ frame, raf, produced, owner,
      pictureMatch: png && settled.png && settled.produced ? match(region(png, settled.produced), region(settled.png, settled.produced)) : null })) };
  if (whole) for (const frame of [...frames.slice(0, 4), frames.at(-1)]) {
    if (frame.png) writeFileSync(`${outdir}/${label}-${size}-${sample}-${query.replace(/[&=]/g, '_')}-frame${frame.frame}.png`, PNG.sync.write(frame.png));
  }
  results.push(record);
  if (first?.png) {
    // The first produced frame and the last, cropped round both boxes, for the README.
    const boxes = [settled.produced, first.raf].filter(Boolean);
    const x0 = Math.max(0, Math.min(...boxes.map((b) => b[0])) - 24), y0 = Math.max(0, Math.min(...boxes.map((b) => b[1])) - 24);
    const x1 = Math.min(first.png.width, Math.max(...boxes.map((b) => b[0] + b[2])) + 24), y1 = Math.min(first.png.height, Math.max(...boxes.map((b) => b[1] + b[3])) + 24);
    for (const [name, png] of [['first', first.png], ['settled', settled.png]]) {
      const crop = new PNG({ width: Math.round(x1 - x0), height: Math.round(y1 - y0) });
      PNG.bitblt(png, crop, Math.round(x0), Math.round(y0), crop.width, crop.height, 0, 0);
      writeFileSync(`${outdir}/${label}-${size}-${sample}${query ? '-' + query.replace(/[&=]/g, '_') : ''}-${name}.png`, PNG.sync.write(crop));
    }
  }
  await context.close();
}
writeFileSync(`${outdir}/${label}-${size}.json`, JSON.stringify(results, null, 1));
for (const r of results) console.log(r.label, r.size, r.sample, r.query, 'settled', JSON.stringify(r.settledBox), r.frames.map((f) => `f${f.frame}:raf=${f.raf ? f.raf.slice(0, 2).join(',') : '-'} prod=${f.produced ? f.produced.slice(0, 2).join(',') : '-'} owner=${f.owner ? `${f.owner.x},${f.owner.scrollLeft}` : '-'} pic=${f.pictureMatch}`).join(' | '));
await browser.close();
