import { launch } from './lib.mjs';
const [file, out] = process.argv.slice(2);
const b = await launch();
const p = await b.newPage({ deviceScaleFactor: 1.5, viewport: { width: 2060, height: 1000 } });
await p.goto('file://' + file); await p.evaluate(() => document.fonts.ready); await p.waitForTimeout(800);
for (const id of ['part-1', 'part-2', 'part-3']) await p.locator('#' + id).screenshot({ path: `${out}/${id.replace('part-', '0')}.png`, timeout: 240000 });
await b.close();
