// Which elements in the conversation carry AntD classes (delivery), and from where.
const WT = '/root/.orbit/worktrees/6d689aae-2d33-526f-af1f-826adf954c6d';
const { chromium } = await import(`${WT}/node_modules/playwright-core/index.mjs`);
const { installFixtures, installFixedDate } = await import(`${WT}/src/web/ui-migration/fixtures.mjs`);
const { installP52Fixtures, installObjectUrlLog, P52_PATHS } = await import(`${WT}/src/web/ui-migration/p52-fixtures.mjs`);
const browser = await chromium.launch();
const context = await browser.newContext({ baseURL: `http://127.0.0.1:${process.env.PORT || 4353}`, locale: 'en-US', timezoneId: 'UTC', deviceScaleFactor: 1, reducedMotion: 'reduce', viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
await installFixedDate(page);
await installFixtures(page, { theme: 'light' });
await installObjectUrlLog(page);
await installP52Fixtures(page);
await page.goto(P52_PATHS.session);
await page.waitForSelector('.chat-assistant');
await page.waitForTimeout(1500);
console.log(JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('.workspace-scroll-wrap > .workspace-sessions [class*="ant-"], .composer-attachments [class*="ant-"]')]
  .filter((el) => [...el.classList].some((c) => c.startsWith('ant-') && !c.startsWith('anticon')))
  .map((el) => ({ tag: el.tagName, cls: el.className, text: el.textContent.trim().slice(0, 60), parent: el.parentElement.className, label: el.getAttribute('aria-label') }))), null, 1));
await browser.close();
