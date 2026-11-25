const K = '/mnt/tmp/band-glass-mock';
const F = '/mnt/tmp/01a1-usable-default';
const { chromium } = await import(`${K}/node_modules/playwright-core/index.mjs`);
const [html, out] = process.argv.slice(2);
const b = await chromium.launch({ args: ['--allow-file-access-from-files'] });
const p = await b.newPage({ viewport: { width: 2440, height: 1600 }, deviceScaleFactor: 1.5 });
await p.goto('file://' + html);
await p.addStyleTag({ content: `
@font-face{font-family:Inter;src:url(file://${F}/Inter.ttf);font-weight:100 900}
@font-face{font-family:'Noto Sans SC';src:url(file://${F}/NotoSansSC.ttf);font-weight:100 900}
@font-face{font-family:'JetBrains Mono';src:url(file://${F}/JetBrainsMono.ttf);font-weight:100 900}` });
await p.evaluate(async () => { await Promise.all([...document.fonts].map(f => f.load())); await document.fonts.ready; });
console.log(await p.evaluate(() => [...document.fonts].map(f => f.family + ':' + f.status).join(' ')));
await p.locator('.board').screenshot({ path: out });
await b.close();
