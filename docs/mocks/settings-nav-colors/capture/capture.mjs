import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
const WT = '/root/.orbit/worktrees/01a1d29b-0306-7079-b3bb-ab500ed9efe1';
const { chromium } = await import(`${WT}/node_modules/playwright-core/index.mjs`);
const { installFixtures, installFixedDate, PATHS } = await import(`${WT}/src/web/ui-migration/fixtures.mjs`);
const PORT = 5311;
const vite = spawn('npx', ['vite', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], { cwd: `${WT}/src/web`, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((ok) => vite.stdout.on('data', (d) => { if (String(d).includes('Local')) ok(); }));
const css = readFileSync('proposal.css', 'utf8');
const fonts = '/mnt/data/tmp/settings-colors-mock/fonts';
const browser = await chromium.launch();
async function shot(path, out, { proposal = false, theme = 'light' } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, baseURL: `http://127.0.0.1:${PORT}` });
  const page = await ctx.newPage();
  await page.route('**/__mockfonts/**', (r) => r.fulfill({ body: readFileSync(`${fonts}/${r.request().url().split('/').pop()}`), contentType: 'font/ttf' }));
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'MacIntel' });
    const s = document.createElement('style');
    s.textContent = "@font-face{font-family:BlinkMacSystemFont;src:url(/__mockfonts/Inter.ttf);font-weight:100 900}";
    document.addEventListener('DOMContentLoaded', () => document.head.append(s));
  });
  await installFixedDate(page);
  await installFixtures(page, { theme });
  await page.goto(path);
  await page.waitForTimeout(2500);
  if (proposal) await page.addStyleTag({ content: css });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
  await page.screenshot({ path: out });
  await ctx.close();
}
const settings = PATHS.settings + '/general';
for (const theme of ['light', 'dark']) {
  await shot(settings, `settings-today-${theme}.png`, { theme });
  await shot(settings, `settings-new-${theme}.png`, { proposal: true, theme });
  await shot(PATHS.session, `main-${theme}.png`, { theme });
}
await browser.close(); vite.kill();
