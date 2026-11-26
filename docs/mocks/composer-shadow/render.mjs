// Renders board.html to 01-board.png at 2x with Inter / Noto SC / JetBrains Mono loaded first.
const WT = new URL('../../..', import.meta.url).pathname;
const { chromium } = await import(`${WT}node_modules/playwright-core/index.mjs`);
const dir = new URL('.', import.meta.url).pathname, F = '/mnt/tmp/band-glass-mock/fonts/';
const b = await chromium.launch({ args: ['--allow-file-access-from-files'] });
const p = await b.newPage({ viewport: { width: 1840, height: 1000 }, deviceScaleFactor: 2 });
await p.goto('file://' + dir + 'board.html');
await p.addStyleTag({ content: `@font-face{font-family:BlinkMacSystemFont;src:url(file://${F}Inter.ttf);font-weight:100 900}@font-face{font-family:'PingFang SC';src:url(file://${F}NotoSansSC.ttf);font-weight:100 900}@font-face{font-family:'JetBrains Mono';src:url(file://${F}JetBrainsMono.ttf);font-weight:100 900}` });
await p.evaluate(async () => { await Promise.all([...document.fonts].map((f) => f.load())); await document.fonts.ready; });
await p.locator('.board').screenshot({ path: dir + '01-board.png' });
await b.close();
