const WT = '/root/.orbit/worktrees/01a1d29b-0306-7079-b3bb-ab500ed9efe1';
const { chromium } = await import(`${WT}/node_modules/playwright-core/index.mjs`);
const F = '/mnt/data/tmp/settings-colors-mock/fonts';
const b = await chromium.launch({ args: ['--allow-file-access-from-files'] });
const p = await b.newPage({ viewport: { width: 1560, height: 1000 }, deviceScaleFactor: 2 });
await p.goto(`file://${process.argv[2]}`);
await p.addStyleTag({ content: `@font-face{font-family:BlinkMacSystemFont;src:url(file://${F}/Inter.ttf);font-weight:100 900}
@font-face{font-family:'PingFang SC';src:url(file://${F}/NotoSansSC.ttf);font-weight:100 900}
@font-face{font-family:'JetBrains Mono';src:url(file://${F}/JetBrainsMono.ttf);font-weight:100 900}` });
await p.evaluate(async () => { await document.fonts.load('14px BlinkMacSystemFont'); await document.fonts.load('14px "PingFang SC"', '中'); await document.fonts.load('12px "JetBrains Mono"'); await document.fonts.ready; await Promise.all([...document.images].map(i => i.decode())); });
await p.locator('.board').screenshot({ path: process.argv[3] });
await b.close();
