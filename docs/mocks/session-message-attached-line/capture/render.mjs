const D = process.argv[2];
const { chromium } = await import('/var/tmp/smc-attached/today/node_modules/playwright/index.mjs');
const b = await chromium.launch({ executablePath: '/mnt/data/ms-playwright/chromium-1243/chrome-linux64/chrome', env: { ...process.env, FONTCONFIG_FILE: '/mnt/data/tmp/44-repo-tiers/fonts.conf' } });
const p = await b.newPage({ viewport: { width: 1400, height: 1000 }, deviceScaleFactor: 2 });
await p.goto(`file://${D}/board.html`); await p.evaluate(() => document.fonts.ready); await p.waitForTimeout(300);
const n = await p.locator('section.b-part').count();
for (let i = 0; i < n; i++) await p.locator('section.b-part').nth(i).screenshot({ path: `${D}/0${i + 1}-board.png` });
await b.close(); console.log(n);
