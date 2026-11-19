const { chromium } = await import('/root/.orbit/worktrees/00d36d0f-808f-5fe7-93e3-2ddc50555720/node_modules/playwright-core/index.mjs');
const b = await chromium.launch({ args: ['--allow-file-access-from-files'] });
const p = await b.newPage({ viewport: { width: 1180, height: 900 }, deviceScaleFactor: 2 });
await p.goto('file://' + process.argv[2]);
await p.evaluate(async () => { for (const f of document.fonts) await f.load(); await document.fonts.ready; });
await p.locator('.board').screenshot({ path: process.argv[3] });
await b.close();
