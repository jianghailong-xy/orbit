// Beyond the boards: the card in the dark theme and on a phone's width, shot the same way.
import { launch, open, settle, K } from './lib.mjs';
import * as D from './data.mjs';
const quiet = { 'GET /api/projects/sidebar': [], 'GET /api/wiki/spaces': [], 'GET /api/projects': [] };
const A = D.IDS.austin;
const routes = (fleet) => ({ ...D.fleetRoutes(fleet), ...quiet });
const FIRST = 'Fix the flaky login test in tests/auth — it fails about one run in five on CI.';
const browser = await launch();
for (const [name, opts] of [
  ['dark', { theme: 'dark', height: 900 }],
  ['phone', { size: 'phone' }],
  ['short', { height: 620 }],
]) {
  const s = await open(browser, { path: `/runners/${A}/new`, routes: routes(D.NEW_USER), ...opts });
  await s.page.locator('.msc').waitFor();
  await s.page.getByText('Where you ran orbit register').waitFor();
  await settle(s.page);
  await s.page.screenshot({ path: `${K}/shots-p1/x-${name}.png`, fullPage: false });
  const box = s.page.locator('.workspace-composer textarea');
  await box.fill(FIRST);
  await box.press('Enter');
  await s.page.locator('.msc-held').waitFor();
  await s.page.locator('.msc-held').scrollIntoViewIfNeeded();
  await settle(s.page);
  await s.page.screenshot({ path: `${K}/shots-p1/x-${name}-held.png` });
  // The first thing on the card can always be reached, however short the pane.
  const top = await s.page.evaluate(() => {
    const pane = document.querySelector('.workspace-sessions.workspace-draft, .workspace-scroll-wrap > .workspace-sessions');
    pane.scrollTop = 0;
    return { paneTop: pane.getBoundingClientRect().top, cardTop: document.querySelector('.msc').getBoundingClientRect().top, overflowX: document.documentElement.scrollWidth > window.innerWidth };
  });
  console.log(name, JSON.stringify(top), s.errors.slice(0, 2));
  await s.context.close();
}
await browser.close();
