// emu-server.mjs TREE CTLPORT: one tree's build (ref :4384, del :4383, reversed onto the device) in Chrome for Android on
// the HPC emulator (emulator-5554, API 36, Gboard), with the P0 + P5.3 fixtures served by this process through
// Playwright's Android connection. Input is the device's own (`adb shell input`, Gboard's keys); the page is read over
// CDP. A local control port runs code against { page, device, adb, sh, ... } so the checks can be explored and then run
// as one scripted pass (POST /run with a steps module). Emulator, not a phone: see ../../README.
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
const WT = '/root/.orbit/worktrees/4071e471-3592-5308-a8bb-f597b81ac833';
const { _android } = await import(`${WT}/node_modules/playwright-core/index.mjs`);
const { installFixtures, installFixedDate } = await import(`${WT}/src/web/ui-migration/fixtures.mjs`);
const p53 = await import(`${WT}/src/web/ui-migration/p53-fixtures.mjs`);
const [tree, ctlPort] = process.argv.slice(2);
const port = tree === 'ref' ? 4384 : 4383;
const ADB = '/opt/android-sdk/platform-tools/adb';
const adb = (...args) => execFileSync(ADB, ['-s', 'emulator-5554', ...args], { maxBuffer: 64 << 20 });
const sh = (cmd) => adb('shell', cmd).toString();
adb('reverse', `tcp:${port}`, `tcp:${port}`);
const [device] = await _android.devices();
sh('am force-stop com.android.chrome');
const context = await device.launchBrowser();
const page = context.pages()[0] ?? await context.newPage();
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
await installFixedDate(page);
await installFixtures(page, { theme: 'light' });
const fixtures = await p53.installP53Fixtures(page);
const base = `http://127.0.0.1:${port}`;
await page.goto(base + p53.P53_PATHS.session);
await page.waitForSelector('.composer-field textarea');
const ctx = { page, device, context, adb, sh, fixtures, p53, base, tree, writeFileSync, mkdirSync };
// Device pixels for a point in the page: the content area's top on the screen is measured once by a tap.
ctx.screen = async (x, y) => {
  const v = await page.evaluate(() => ({ dpr: devicePixelRatio, ox: visualViewport.offsetLeft, oy: visualViewport.offsetTop }));
  return [Math.round((x - v.ox) * v.dpr), Math.round(ctx.top + (y - v.oy) * v.dpr)];
};
ctx.tapAt = async (x, y) => { const [sx, sy] = await ctx.screen(x, y); sh(`input tap ${sx} ${sy}`); };
ctx.tapEl = async (locator, dx = 0.5, dy = 0.5) => {
  const b = await locator.boundingBox();
  if (!b) throw new Error('no box');
  await ctx.tapAt(b.x + b.width * dx, b.y + b.height * dy);
};
ctx.holdEl = async (locator, ms = 900, dx = 0.5, dy = 0.5) => {
  const b = await locator.boundingBox();
  const [sx, sy] = await ctx.screen(b.x + b.width * dx, b.y + b.height * dy);
  sh(`input swipe ${sx} ${sy} ${sx} ${sy} ${ms}`);
};
ctx.shot = (file) => writeFileSync(file, adb('exec-out', 'screencap', '-p'));
// Calibrate: a tap in the transcript's empty margin, read back as the pointer's client position.
await page.evaluate(() => { window.__cal = null; addEventListener('pointerdown', (e) => { window.__cal ??= [e.clientX, e.clientY]; }, { capture: true, once: true }); });
const dpr = await page.evaluate(() => devicePixelRatio);
sh('input tap 1040 900');
await page.waitForTimeout(500);
const cal = await page.evaluate(() => window.__cal);
ctx.top = 900 - cal[1] * dpr;
console.log('READY', JSON.stringify({ tree, port, dpr, cal, top: ctx.top, x: cal[0] * dpr }));
http.createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  try {
    let result;
    if (req.url === '/pw') result = await (new Function('ctx', `return (async () => { const { page, sh } = ctx; ${body} })();`))(ctx);
    else if (req.url === '/run') result = await (await import(`${body}?t=${Date.now()}`)).default(ctx);
    else if (req.url === '/quit') { res.end('bye'); await context.close().catch(() => {}); process.exit(0); }
    res.end(JSON.stringify(result ?? null, null, 1));
  } catch (e) { res.statusCode = 500; res.end(String(e?.stack || e)); }
}).listen(Number(ctlPort), '127.0.0.1');
