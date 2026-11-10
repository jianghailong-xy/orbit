import { launch } from '/var/tmp/compact-steps-mock/lib.mjs';
const [html, out] = process.argv.slice(2);
const b = await launch(); const p = await b.newPage({ viewport: { width: 2280, height: 1200 }, deviceScaleFactor: 2 });
await p.goto('file://' + html); await p.evaluate(() => document.fonts.ready);
await p.locator('.board').screenshot({ path: out }); await b.close();
