const { chromium } = await import('/root/.orbit/worktrees/01a1a9a9-a2b3-726e-a6c5-a3cf6e09d200/node_modules/playwright-core/index.mjs');
const [html, outDir] = process.argv.slice(2);
const b = await chromium.launch({ args: ['--allow-file-access-from-files', '--no-sandbox'], env: { ...process.env, FONTCONFIG_FILE: '/var/tmp/admin-mock/fonts.conf' } });
const p = await b.newPage({ viewport: { width: 1580, height: 1000 }, deviceScaleFactor: 2 });
await p.goto('file://' + html);
await p.evaluate(async () => { await document.fonts.ready; });
await p.screenshot({ path: outDir + '/01-board.png', fullPage: true });
for (const n of [1, 2, 3]) await (await p.$('#part-' + n)).screenshot({ path: `${outDir}/01-board-${n}.png` });
// overflow check: any text clipped horizontally inside a frame
console.log(JSON.stringify(await p.evaluate(() => [...document.querySelectorAll('.win *, .rb-box')].filter(e => e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).overflow !== 'visible').map(e => e.className + ': ' + e.textContent.slice(0, 50)))));
await b.close();
