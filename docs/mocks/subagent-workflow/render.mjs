// Renders board.html to one PNG per section: node render.mjs (Playwright and fonts from the mock kit on the HPC host).
const K = '/mnt/tmp/band-glass-mock';
const { chromium } = await import(`${K}/node_modules/playwright-core/index.mjs`);
const dir = new URL('.', import.meta.url).pathname;
const b = await chromium.launch({ args: ['--allow-file-access-from-files'] });
const p = await b.newPage({ viewport: { width: 1400, height: 1000 }, deviceScaleFactor: 2 });
await p.goto('file://' + dir + 'board.html');
await p.addStyleTag({ content: `
@font-face{font-family:Inter;src:url(file://${K}/fonts/Inter.ttf);font-weight:100 900}
@font-face{font-family:'Noto Sans SC';src:url(file://${K}/fonts/NotoSansSC.ttf);font-weight:100 900}
@font-face{font-family:'JetBrains Mono';src:url(file://${K}/fonts/JetBrainsMono.ttf);font-weight:100 900}
body{font-family:Inter,'Noto Sans SC',sans-serif}` });
await p.evaluate(async () => { await Promise.all([...document.fonts].map(f => f.load())); await document.fonts.ready; });
console.log(await p.evaluate(() => [...document.fonts].map(f => f.family + ':' + f.status).join(' ')));
const n = await p.locator('section').count();
for (let i = 0; i < n; i++) await p.locator('section').nth(i).screenshot({ path: `${dir}0${i + 1}.png` });
await b.close();
