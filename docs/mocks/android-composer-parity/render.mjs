// node render.mjs [board.html] [out.png] — fonts from FONTS (default /mnt/tmp/acp-mock/fonts), playwright-core from PW.
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const F = process.env.FONTS ?? '/mnt/tmp/acp-mock/fonts';
const PW = process.env.PW ?? '/mnt/tmp/band-glass-mock/node_modules/playwright-core/index.mjs';
const { chromium } = await import(PW);
const html = resolve(process.argv[2] ?? `${here}/01-board.html`);
const out = resolve(process.argv[3] ?? html.replace(/\.html$/, '.png'));
const b = await chromium.launch({ args: ['--allow-file-access-from-files'] });
const p = await b.newPage({ viewport: { width: 1700, height: 1600 }, deviceScaleFactor: 2 });
await p.addInitScript(() => { window.__render = true; });
await p.goto('file://' + html);
await p.addStyleTag({ content: ['Inter', 'Roboto', 'JetBrains Mono', 'Noto Sans SC'].map(f =>
  `@font-face{font-family:'${f}';src:url(file://${F}/${f.replace(/ /g, '')}.ttf);font-weight:100 900}`).join('\n') });
await p.evaluate(async () => { await Promise.all([...document.fonts].map(f => f.load())); await document.fonts.ready; });
await p.evaluate(() => window.layoutBoard?.());
console.log(await p.evaluate(() => [...document.querySelectorAll('.a-bar')].map((x, i) => `bar ${i}: tier ${x.dataset.tier} ${x.querySelector('.a-model b')?.textContent ?? ''}`).join('\n')));
console.log(await p.evaluate(() => [...document.fonts].map(f => f.family + ':' + f.status).join(' ')));
await p.locator('.board').screenshot({ path: out });
await b.close();
