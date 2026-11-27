// Render each section.b-part of a board to <outDir>/<name>-N.png.
const { chromium } = await import('/root/.orbit/worktrees/01a1b526-5a6e-749f-8602-e9a88d10a688/node_modules/playwright-core/index.mjs');
const [html, outDir, name] = process.argv.slice(2);
const b = await chromium.launch({ env: { ...process.env, FONTCONFIG_FILE: '/var/tmp/rpr-mock/fonts.conf' }, args: ['--allow-file-access-from-files', '--no-sandbox'] });
const p = await b.newPage({ viewport: { width: 2400, height: 1200 }, deviceScaleFactor: 2 });
await p.goto('file://' + html);
await p.evaluate(async () => { await document.fonts.ready; });
await p.evaluate(() => window.drawMarks && window.drawMarks());
const parts = await p.$$('section.b-part');
for (let i = 0; i < parts.length; i++) await parts[i].screenshot({ path: `${outDir}/${name}-${i + 1}.png` });
console.log(parts.length, 'parts');
await b.close();
