// T8 evidence: the boards' "after" iPhone frames (docs/mocks/provider-engine-decoupling/ios-*.html), rendered
// with the fonts T7 used, one PNG per frame and theme, for the side-by-side with the simulator's shots.
//   node render.mjs <mocks dir> <out dir>
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from '/root/.orbit/worktrees/5f30356b-85ab-515f-a540-538b86a6cd72/node_modules/playwright/index.mjs';

const [MOCKS, OUT] = process.argv.slice(2);
await mkdir(OUT, { recursive: true });
const FRAMES = {
  'ios-1-infrastructure.html': { p3: 'board-ios1-overview', p4: 'board-ios1-keys', p6: 'board-ios1-machine', p8: 'board-ios1-dsh-engine' },
  'ios-2-deepseek-key.html': { p3: 'board-ios2-key-top', p4: 'board-ios2-key-works-with' },
  'ios-4-new-session.html': { p2: 'board-ios4-engine-sheet', p4: 'board-ios4-engine-sheet-no-key', p6: 'board-ios4-provider-dsh',
    p7: 'board-ios4-provider-claude-code', p8: 'board-ios4-provider-opencode' },
  'ios-5-composer.html': { p2: 'board-ios5-session-dsh', p4: 'board-ios5-session-key-deleted' },
};
const browser = await chromium.launch({ env: { ...process.env, FONTCONFIG_FILE: '/mnt/data/pe-mock/fonts.conf' } });
for (const theme of ['light', 'dark']) {
  const context = await browser.newContext({ viewport: { width: 2000, height: 1400 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  for (const [file, frames] of Object.entries(FRAMES)) {
    await page.goto(`file://${MOCKS}/${file}${theme === 'dark' ? '?theme=dark' : ''}`);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(800);
    for (const [id, name] of Object.entries(frames)) {
      await page.locator(`#${id}`).screenshot({ path: join(OUT, `${name}-${theme}.png`) });
      console.log(`${name}-${theme}.png`);
    }
  }
  await context.close();
}
await browser.close();
