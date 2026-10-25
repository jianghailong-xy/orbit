export default async function (page) {
  const sel = page.locator('.composer-toolbar .ant-select, .composer-toolbar .orbit-select').last();
  await sel.tap();
  const out = [];
  for (const ms of [100, 300, 600]) {
    await page.waitForTimeout(ms);
    out.push(await page.evaluate(() => { const t = [...document.querySelectorAll('.composer-toolbar .ant-select, .composer-toolbar .orbit-select')].pop(); return { hover: t.matches(':hover'), bg: getComputedStyle(t).backgroundColor }; }));
  }
  console.log(JSON.stringify(out));
}
