// Before/after of the start dialog's top-right corner: the real project page + the real
// `ProjectStartDialog`, driven on the P4.3b fixtures. The "after" half injects the candidate CSS
// into the already-open dialog, so both halves are the same page, same data, same frame.
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

// The repo root this kit sits in (docs/evidence/start-dialog-close-corner/kit -> three up).
const WT = process.env.WT ?? new URL('../../../..', import.meta.url).pathname.replace(/\/$/u, '');
const require = createRequire(`${WT}/src/web/package.json`);
const { chromium } = require('playwright');
const { installFixedDate, installFixtures } = await import(`${WT}/src/web/ui-migration/fixtures.mjs`);
const { installP43bFixtures, P43B_PATHS } = await import(`${WT}/src/web/ui-migration/p43b-fixtures.mjs`);

const BASE = process.env.BASE ?? 'http://127.0.0.1:4178';
const OUT = process.env.OUT ?? new URL('.', import.meta.url).pathname + 'out';
mkdirSync(OUT, { recursive: true });

const settle = (page) => page.waitForFunction(() => document.getAnimations()
  .every((a) => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity));

/** The dialog's own geometry: the close button's box and the card's border box, dialog-relative. */
const geometry = (page) => page.evaluate(() => {
  const dialog = document.querySelector('.start-card-dialog');
  const close = dialog.querySelector('.orbit-overlay-close');
  const card = dialog.querySelector('.start-card');
  const d = dialog.getBoundingClientRect();
  const c = close.getBoundingClientRect();
  const k = card.getBoundingClientRect();
  const rel = (r) => ({ x: +(r.x - d.x).toFixed(1), y: +(r.y - d.y).toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) });
  return {
    dialog: rel(d), close: rel(c), card: rel(k),
    closeBottom: +(c.bottom - d.top).toFixed(1),
    cardTop: +(k.top - d.top).toFixed(1),
    gapBox: +(k.top - c.bottom).toFixed(1),   // >0: the card starts clear below the close's box
    dialogHeight: +d.height.toFixed(1),
  };
});

const browser = await chromium.launch();
const report = {};
for (const [label, viewport] of [['desktop-1280', { width: 1280, height: 900 }], ['window-1000', { width: 1000, height: 900 }]]) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 2, colorScheme: 'light' });
  const noise = [];
  page.on('console', (m) => noise.push(`[${m.type()}] ${m.text().slice(0, 160)}`));
  page.on('pageerror', (e) => noise.push(`[pageerror] ${e.message.slice(0, 200)}`));
  page.on('requestfailed', (r) => noise.push(`[failed] ${r.url().slice(0, 120)} ${r.failure()?.errorText ?? ''}`));
  await installFixedDate(page);
  await installFixtures(page, { theme: 'light' });
  await installP43bFixtures(page, { graph: 'p0', started: false });
  // Pressed by a DOM click: the page re-renders (its reads poll), and Playwright's actionability
  // checks never settle on a node React keeps replacing.
  const pressStart = () => page.evaluate(() => {
    const button = [...document.querySelectorAll('.project-open-items button')]
      .find((each) => each.textContent.trim().startsWith('Start'));
    button?.click();
    return Boolean(button);
  });
  await page.goto(BASE + P43B_PATHS.project);
  try {
    await page.waitForFunction(() => [...document.querySelectorAll('.project-open-items button')]
      .some((each) => each.textContent.trim().startsWith('Start')), null, { timeout: 20000 });
  } catch (error) {
    const body = await page.evaluate(() => document.body.innerText.slice(0, 400));
    await page.screenshot({ path: `${OUT}/${label}-FAILED.png` });
    console.error(`[${label}] no Start button. body=${JSON.stringify(body)}\nnoise:\n${noise.slice(-12).join('\n')}`);
    throw error;
  }
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await pressStart();
    try {
      await page.waitForSelector('.start-card-dialog .start-card', { state: 'visible', timeout: 8000 });
      break;
    } catch (error) {
      if (attempt === 3) {
        console.error(`[${label}] dialog did not open. noise:\n${noise.slice(-12).join('\n')}`);
        throw error;
      }
      await page.waitForTimeout(1500);
    }
  }
  await page.evaluate(() => document.fonts.ready);
  await settle(page);
  await page.waitForTimeout(300);

  const box = await page.evaluate(() => {
    const r = document.querySelector('.start-card-dialog').getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  // Fixed clips, taken once: both halves are shot through the same window.
  const corner = {
    x: Math.max(0, box.x + box.width - 190), y: Math.max(0, box.y - 10),
    width: Math.min(190, viewport.width - Math.max(0, box.x + box.width - 190)), height: 150,
  };
  const top = {
    x: Math.max(0, box.x - 6), y: Math.max(0, box.y - 10),
    width: Math.min(box.width + 12, viewport.width - Math.max(0, box.x - 6)), height: 420,
  };

  report[label] = { before: await geometry(page) };
  await page.screenshot({ path: `${OUT}/${label}-top-before.png`, clip: top });
  await page.screenshot({ path: `${OUT}/${label}-corner-before.png`, clip: corner });
  await page.screenshot({ path: `${OUT}/${label}-full-before.png`, clip: { x: Math.max(0, box.x - 6), y: Math.max(0, box.y - 10), width: Math.min(box.width + 12, viewport.width), height: viewport.height - Math.max(0, box.y - 10) } });

  // INJECT=1 adds the candidate to the open dialog (the before/after board); INJECT=0 shoots the
  // tree as it stands twice, so a built fix can be pixel-compared with the injected one.
  if (process.env.INJECT !== '0') {
    await page.addStyleTag({ content: '.start-card-dialog > .orbit-overlay-header { height: 36px; }' });
    await settle(page);
    await page.waitForTimeout(200);
  }
  report[label].after = await geometry(page);
  await page.screenshot({ path: `${OUT}/${label}-top-after.png`, clip: top });
  await page.screenshot({ path: `${OUT}/${label}-corner-after.png`, clip: corner });
  await page.screenshot({ path: `${OUT}/${label}-full-after.png`, clip: { x: Math.max(0, box.x - 6), y: Math.max(0, box.y - 10), width: Math.min(box.width + 12, viewport.width), height: viewport.height - Math.max(0, box.y - 10) } });
  await page.close();
}

await browser.close();
writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
