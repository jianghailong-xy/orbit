// Real-page captures of the P7a implementation, adapted from docs/mocks/cursor-engine/capture/scenes.mjs:
//   unshare -n /mnt/data/tmp/p7a-shots/run-ns.sh scenes.mjs [scene ...]
// Each scene is shot light and dark into OUT/<scene>-<theme>.png, and its size and the boxes worth
// marking (CSS px, relative to the shot) go into OUT/marks.json + marks.js (window.SHOT_MARKS).
import fs from 'node:fs';
import path from 'node:path';
import { launch, open, settle } from './lib.mjs';
import { SCENES } from './scene-list.mjs';

const OUT = process.env.OUT ?? '/mnt/data/tmp/p7a-shots/shots';
const THEMES = (process.env.THEMES ?? 'light,dark').split(',');
fs.mkdirSync(OUT, { recursive: true });
const marksPath = `${OUT}/marks.json`;
const marks = fs.existsSync(marksPath) ? JSON.parse(fs.readFileSync(marksPath, 'utf8')) : {};
const t0 = Date.now();
const log = (...a) => console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s`, ...a);

const want = process.argv.slice(2);
const names = Object.keys(SCENES).filter((n) => want.length === 0 || want.some((w) => n === w || (w.endsWith('*') && n.startsWith(w.slice(0, -1)))));
if (names.length === 0) { console.error(`no scenes: ${want.join(' ')}`); process.exit(1); }

async function clipOf(page, scene) {
  if (typeof scene.clip === 'function') return scene.clip(page);
  const pad = scene.pad ?? 0;
  const el = page.locator(scene.clip).first();
  await el.waitFor({ state: 'visible', timeout: 30_000 });
  const b = await el.boundingBox();
  const vp = page.viewportSize();
  const x = Math.max(0, b.x - pad);
  const y = Math.max(0, b.y - pad);
  return { x, y, width: Math.min(vp.width - x, b.width + 2 * pad), height: b.height + 2 * pad };
}

const browser = await launch();
let failed = false;
try {
  for (const name of names) {
    const scene = SCENES[name];
    for (const theme of THEMES) {
      const { page, context, api, errors } = await open(browser, {
        path: scene.path, theme, width: scene.width ?? 1280, height: scene.height ?? 900, routes: scene.routes?.() ?? {}, init: scene.init,
      });
      try {
        await page.waitForTimeout(scene.wait ?? 1500);
        if (scene.act) await scene.act(page, { theme });
        if (scene.mouse !== null) await page.mouse.move(scene.mouse?.[0] ?? 2, scene.mouse?.[1] ?? 2);
        await page.waitForTimeout(250);
        if (scene.after) await scene.after(page, { theme });
        await settle(page);
        // The app scrolls in its own panes: a clip below the fold needs a taller viewport first.
        if (scene.grow) {
          const need = await page.evaluate((sel) => {
            const el = document.querySelector(sel);
            return el ? Math.ceil(el.getBoundingClientRect().bottom + 40) : 0;
          }, scene.grow);
          const vp = page.viewportSize();
          if (need > vp.height) { await page.setViewportSize({ width: vp.width, height: Math.min(need, 7000) }); await page.waitForTimeout(500); await settle(page); }
        }
        let clip = await clipOf(page, scene);
        // A screenshot clip is cut at the viewport: grow it until the clip fits, then measure again.
        for (let i = 0; i < 3; i++) {
          const vp = page.viewportSize();
          if (clip.y + clip.height <= vp.height && clip.x + clip.width <= vp.width) break;
          await page.setViewportSize({ width: Math.max(vp.width, Math.ceil(clip.x + clip.width + 8)), height: Math.ceil(clip.y + clip.height + 40) });
          await page.waitForTimeout(400);
          await settle(page);
          clip = await clipOf(page, scene);
        }
        const boxes = {};
        for (const [key, sel] of Object.entries(scene.boxes ?? {})) {
          const r = typeof sel === 'function' ? await sel(page) : await page.locator(sel).first().boundingBox({ timeout: 2000 }).catch(() => null);
          boxes[key] = r ? [r.x - clip.x, r.y - clip.y, r.width, r.height].map((v) => Math.round(v)) : null;
        }
        const file = `${OUT}/${name}-${theme}.png`;
        const png = await page.screenshot({ path: file, clip });
        // The image's own size (IHDR), at 2x: what the board lays out, whatever the clip asked for.
        const pw = png.readUInt32BE(16) / 2, phh = png.readUInt32BE(20) / 2;
        if (Math.abs(pw - clip.width) > 1 || Math.abs(phh - clip.height) > 1) log(name, theme, `clip ${Math.round(clip.width)}x${Math.round(clip.height)} came out ${pw}x${phh}`);
        marks[`${name}-${theme}`] = { w: Math.round(pw), h: Math.round(phh), boxes };
        const missing = Object.entries(boxes).filter(([, v]) => !v).map(([k]) => k);
        const unhandled = [...new Set(api.unhandled)];
        const errs = [...new Set(errors)].filter((e) => !/status of 501/.test(e));
        log(name, theme, `${Math.round(clip.width)}x${Math.round(clip.height)}`, missing.length ? `MISSING ${missing}` : '', unhandled.length ? `unhandled ${unhandled.join(' ')}` : '', errs.length ? `errors ${errs.slice(0, 3).join(' | ')}` : '');
        if (missing.length || errs.length) failed = true;
      } catch (e) {
        failed = true;
        log(name, theme, 'FAILED', e.message.split('\n')[0]);
        await page.screenshot({ path: `${OUT}/_fail-${name}-${theme}.png` }).catch(() => {});
      } finally {
        await context.close();
      }
    }
  }
} finally {
  await browser.close();
  fs.writeFileSync(marksPath, JSON.stringify(marks, null, 1));
  fs.writeFileSync(`${OUT}/marks.js`, `// Generated by the capture kit: CSS-px size of each shot and the boxes marked on it.\nwindow.SHOT_MARKS = ${JSON.stringify(marks)};\n`);
}
process.exit(failed ? 1 : 0);
