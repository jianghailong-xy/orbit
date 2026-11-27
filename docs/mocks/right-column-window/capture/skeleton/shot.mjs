const { chromium } = await import('/root/.orbit/worktrees/01a21683-38ce-7198-944a-27906417a0cb/node_modules/playwright/index.mjs');
const b = await chromium.launch({ executablePath: `${process.env.HOME}/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`, args: ['--allow-file-access-from-files'] });
for (const n of ['sched', 'drive', 'project']) {
  const p = await b.newPage({ viewport: { width: 1440, height: 820 }, deviceScaleFactor: 1 });
  await p.goto(`file:///mnt/tmp/rcw-mock/skel/${n}.html`); await p.waitForTimeout(500);
  await p.screenshot({ path: `/mnt/tmp/rcw-mock/skel/${n}.png` });
}
await b.close();
