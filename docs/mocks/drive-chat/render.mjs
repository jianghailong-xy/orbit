// Renders the board to PNG once every font has loaded.
//   node render.mjs <abs path to .html> <out.png>
// Kit (fonts + playwright-core): /mnt/tmp/band-glass-mock (override with MOCK_KIT).
const K = process.env.MOCK_KIT || '/mnt/tmp/band-glass-mock';
const { chromium } = await import(`${K}/node_modules/playwright-core/index.mjs`);
const [html, out] = process.argv.slice(2);
const b = await chromium.launch({ args: ['--allow-file-access-from-files', '--no-sandbox'] });
const p = await b.newPage({ viewport: { width: 1800, height: 1200 }, deviceScaleFactor: 2 });
await p.goto('file://' + html);
await p.addStyleTag({ content: `
@font-face{font-family:Inter;src:url(file://${K}/fonts/Inter.ttf);font-weight:100 900}
@font-face{font-family:'Noto Sans SC';src:url(file://${K}/fonts/NotoSansSC.ttf);font-weight:100 900}
@font-face{font-family:'JetBrains Mono';src:url(file://${K}/fonts/JetBrainsMono.ttf);font-weight:100 900}` });
await p.evaluate(async () => { await Promise.all([...document.fonts].map(f => f.load())); await document.fonts.ready; });
console.log(await p.evaluate(() => [...document.fonts].map(f => f.family + ':' + f.status).join(' ')));
await p.locator('.board').screenshot({ path: out });
await b.close();
