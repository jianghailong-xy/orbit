import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// Present the original browser screenshots at their native size, without altering their pixels.
const shots = new URL('./screenshots/', import.meta.url);
const cases = [
  ['runner-signed-out', 'Linux: signed out, Google entry and terms'],
  ['runner-google', 'Linux: Google account, weekly / 5-hour remaining quota and resets'],
  ['runner-macos', 'macOS runner: Google sign-in not supported yet'],
  ['runner-old', 'Older runner: upgrade required'],
  ['runner-env-key', 'Environment key: existing Gemini key explanation'],
  ['runner-unknown', 'Unknown authentication: no signed-in claim or quota'],
  ['selector', 'New-session selector: built-in Antigravity, Google account'],
  ['auth-error', 'Unauthenticated transcript: Google sign-in and terms'],
];
const browser = await chromium.launch({ headless: true });
try {
  for (const width of [1280, 443]) {
    const page = await browser.newPage({ viewport: { width: width === 443 ? 443 : 930, height: 1000 }, deviceScaleFactor: 1 });
    const figures = cases.map(([name, label]) => {
      const png = readFileSync(new URL(`${width}-${name}.png`, shots)).toString('base64');
      return `<figure><figcaption>${label}</figcaption><img src="data:image/png;base64,${png}"></figure>`;
    }).join('');
    await page.setContent(`<style>body{margin:0;padding:12px;background:#f5f6f8;font:13px system-ui;color:#26313f}h1{font-size:17px;margin:0 0 8px}p{margin:0 0 12px;font-size:12px}figure{margin:0 0 12px;padding:0}figcaption{margin:0 0 5px;font-weight:600}img{display:block;max-width:100%}</style><h1>Antigravity Google sign-in — ${width}px viewport</h1><p>Production web components; synthetic, sanitized control-plane fixtures.</p>${figures}`);
    await page.evaluate(() => Promise.all([...document.images].map(img => img.decode())));
    await page.screenshot({ path: fileURLToPath(new URL(`${width}-overview.png`, shots)), fullPage: true });
    await page.close();
    console.log(`Created ${width}px contact sheet from 8 original screenshots`);
  }
} finally { await browser.close(); }
