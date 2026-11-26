const K = '/mnt/tmp/band-glass-mock';
const { chromium } = await import(`${K}/node_modules/playwright-core/index.mjs`);
const [html, out] = process.argv.slice(2);
const b = await chromium.launch({ args: ['--allow-file-access-from-files'] });
const p = await b.newPage({ viewport: { width: 2400, height: 1600 }, deviceScaleFactor: 2 });
await p.goto('file://' + html); await p.waitForTimeout(800);
await p.addStyleTag({ content: `
@font-face{font-family:Inter;src:url(file://${K}/fonts/Inter.ttf);font-weight:100 900}
@font-face{font-family:'Noto Sans SC';src:url(file://${K}/fonts/NotoSansSC.ttf);font-weight:100 900}
@font-face{font-family:'JetBrains Mono';src:url(file://${K}/fonts/JetBrainsMono.ttf);font-weight:100 900}` });
await p.evaluate(async () => { await Promise.all([...document.fonts].map(f => f.load())); await document.fonts.ready; });
console.log(await p.evaluate(() => [...document.fonts].map(f => f.family + ':' + f.status).join(' ')));
await p.locator('.board').screenshot({ path: out });
await b.close();
