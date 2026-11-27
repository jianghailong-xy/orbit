// Renders one board page to PNG once every font has loaded.
//   node render.mjs <abs path to .html> <out.png> [parts]
// With `parts`, each section.b-part is also written beside <out.png> as <out>-N.png, and window.drawMarks runs after the fonts.
// Kit (fonts + playwright-core): /mnt/tmp/band-glass-mock. Chromium: ~/.cache/ms-playwright/chromium_headless_shell-1243.
const K = process.env.MOCK_KIT || '/mnt/tmp/band-glass-mock';
// Roboto for the Android board (04-android); without it the phones fall back to Inter.
const R = process.env.MOCK_ROBOTO || '/mnt/tmp/acp-mock/fonts/Roboto.ttf';
const { chromium } = await import(`${K}/node_modules/playwright-core/index.mjs`);
const [html, out, parts] = process.argv.slice(2);
const b = await chromium.launch({ args: ['--allow-file-access-from-files', '--no-sandbox'] });
const p = await b.newPage({ viewport: { width: 2100, height: 1200 }, deviceScaleFactor: 2 });
await p.goto('file://' + html);
await p.addStyleTag({ content: `
@font-face{font-family:Inter;src:url(file://${K}/fonts/Inter.ttf);font-weight:100 900}
@font-face{font-family:'Noto Sans SC';src:url(file://${K}/fonts/NotoSansSC.ttf);font-weight:100 900}
@font-face{font-family:Roboto;src:url(file://${R});font-weight:100 900}
@font-face{font-family:'JetBrains Mono';src:url(file://${K}/fonts/JetBrainsMono.ttf);font-weight:100 900}` });
await p.evaluate(async () => { await Promise.all([...document.fonts].map(f => f.load())); await document.fonts.ready; });
console.log(await p.evaluate(() => [...document.fonts].map(f => f.family + ':' + f.status).join(' ')));
if (parts) {
  await p.evaluate(() => window.drawMarks && window.drawMarks());
  const n = await p.locator('section.b-part').count();
  for (let i = 0; i < n; i++) await p.locator('section.b-part').nth(i).screenshot({ path: out.replace(/\.png$/, `-${i + 1}.png`) });
}
await p.locator(parts ? '.b-board' : '.board').screenshot({ path: out });
await b.close();
