// Whether a scrollbar takes room, and whether a box sized to its content counts a child's scrollbar: WebKit bug 310940's
// own case (a width:max-content box whose child gains a vertical scrollbar), with the browsers' default scrollbars and
// with the app's 8px ::-webkit-scrollbar. Prints the outer box's width: 10 means the scrollbar took no room (or was not
// counted), 18 that an 8px one did and was.
import { webkit, chromium } from '@playwright/test';
for (const type of [webkit, chromium]) {
  const browser = await type.launch();
  const page = await browser.newPage();
  for (const css of ['', '::-webkit-scrollbar { width: 8px; height: 8px; }']) {
    await page.setContent(`<style>${css}</style><div id="outer" style="width: max-content; background: green"><div style="height: 79px; overflow: auto"><div style="width: 10px; height: 80px"></div></div></div>`);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    console.log(type.name(), browser.version(), css ? 'the app\'s 8px ::-webkit-scrollbar' : 'default scrollbars', 'outer width', await page.evaluate(() => document.getElementById('outer').offsetWidth));
  }
  await browser.close();
}
