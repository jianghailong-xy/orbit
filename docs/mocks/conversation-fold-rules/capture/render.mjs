import { launch } from '/var/tmp/fold-rule-mock/lib.mjs';
const [html, out] = process.argv.slice(2);
const b = await launch(); const p = await b.newPage({ viewport: { width: 2240, height: 1200 }, deviceScaleFactor: 1 });
await p.goto('file://' + html); await p.evaluate(() => document.fonts.ready);
await p.locator('.board').screenshot({ path: out }); await b.close();
