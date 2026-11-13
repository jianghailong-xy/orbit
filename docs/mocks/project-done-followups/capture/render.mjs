// node render.mjs <abs board.html> <out.png> — shoots .board at 2x with the kit's fonts.
const T = '/root/.orbit/worktrees/67abea98-cec7-5593-80f0-8a0ef57346a7';
const { chromium } = await import(`${T}/node_modules/playwright/index.mjs`);
const [html, out] = process.argv.slice(2);
const b = await chromium.launch({ args: ['--allow-file-access-from-files'] });
const p = await b.newPage({ viewport: { width: 3400, height: 1600 }, deviceScaleFactor: 2 });
await p.goto('file://' + html);
await p.evaluate(async () => { await document.fonts.ready; for (const f of ['MockInter', 'MockNoto', 'MockMono']) await document.fonts.load(`14px ${f}`, 'a中'); });
console.log(await p.evaluate(() => [...document.fonts].map((f) => f.family + ':' + f.status).join(' ')));
await p.waitForTimeout(300);
await p.locator('.board').screenshot({ path: out });
await b.close();
