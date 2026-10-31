// Real-page captures for docs/mocks/claude-region-check. One vite tree at a time (run-ns.sh):
//   unshare -n ./run-ns.sh <K>/today shoot.mjs [scene ...]
// Each scene → OUT/<scene>.png, with its size and boxes (CSS px) in OUT/marks.json.
import fs from 'node:fs';
import { launch, open, settle } from './lib.mjs';
import { SCENES } from './scenes.mjs';

const OUT = process.env.OUT ?? '/mnt/data/tmp/34pVMqv27RB2CakEffAzt/shots-kit/out';
fs.mkdirSync(OUT, { recursive: true });
const marksPath = `${OUT}/marks.json`;
const marks = fs.existsSync(marksPath) ? JSON.parse(fs.readFileSync(marksPath, 'utf8')) : {};
const t0 = Date.now();
const log = (...a) => console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s`, ...a);
const want = process.argv.slice(2);
const names = Object.keys(SCENES).filter((n) => want.length === 0 || want.some((w) => n === w || (w.endsWith('*') && n.startsWith(w.slice(0, -1)))));

async function clipOf(page, scene) {
  if (typeof scene.clip === 'function') return scene.clip(page);
  const pad = scene.pad ?? 0;
  const el = page.locator(scene.clip).first();
  await el.waitFor({ state: 'visible', timeout: 30_000 });
  const b = await el.boundingBox();
  return { x: Math.max(0, b.x - pad), y: Math.max(0, b.y - pad), width: b.width + 2 * pad, height: b.height + 2 * pad };
}

const browser = await launch();
let failed = false;
try {
  for (const name of names) {
    const scene = SCENES[name];
    const theme = scene.theme ?? 'light';
    const { page, context, errors } = await open(browser, {
      path: scene.path, theme, size: scene.size, width: scene.width ?? 1280, height: scene.height ?? 900,
      routes: scene.routes?.() ?? {}, init: scene.init,
    });
    try {
      await page.waitForTimeout(scene.wait ?? 1500);
      if (scene.act) await scene.act(page);
      if (!scene.keepMouse) await page.mouse.move(2, 2);
      await page.waitForTimeout(300);
      await settle(page);
      let clip = await clipOf(page, scene);
      const vp = page.viewportSize();
      if (clip.y + clip.height > vp.height || clip.x + clip.width > vp.width) {
        await page.setViewportSize({ width: Math.max(vp.width, Math.ceil(clip.x + clip.width + 8)), height: Math.ceil(clip.y + clip.height + 40) });
        await page.waitForTimeout(500); await settle(page);
        if (scene.act && scene.reAct) await scene.act(page);
        clip = await clipOf(page, scene);
      }
      const boxes = {};
      for (const [key, sel] of Object.entries(scene.boxes ?? {})) {
        const r = typeof sel === 'function' ? await sel(page) : await page.locator(sel).first().boundingBox({ timeout: 2000 }).catch(() => null);
        boxes[key] = r ? [r.x - clip.x, r.y - clip.y, r.width, r.height, ...(r.endX != null ? [r.endX - clip.x, r.endY - clip.y] : [])].map((v) => Math.round(v)) : null;
      }
      const file = `${OUT}/${name}.png`;
      const png = await page.screenshot({ path: file, clip });
      const pw = png.readUInt32BE(16) / 2, ph = png.readUInt32BE(20) / 2;
      marks[name] = { w: Math.round(pw), h: Math.round(ph), boxes };
      log(name, `${pw}x${ph}`, JSON.stringify(boxes), errors.length ? `errors: ${errors.slice(0, 3).join(' | ')}` : '');
    } catch (e) {
      failed = true;
      log(name, 'FAILED', e.message);
      await page.screenshot({ path: `${OUT}/_fail-${name}.png` }).catch(() => {});
    } finally {
      await context.close();
    }
  }
} finally {
  fs.writeFileSync(marksPath, JSON.stringify(marks, null, 1));
  await browser.close();
}
process.exit(failed ? 1 : 0);
