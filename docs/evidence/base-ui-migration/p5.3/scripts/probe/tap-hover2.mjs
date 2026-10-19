export default async function (page) {
  await page.evaluate(() => {
    window.__ev = [];
    const t0 = performance.now();
    for (const t of ['mousemove', 'mouseover', 'mouseout']) {
      document.addEventListener(t, (e) => window.__ev.push(`${Math.round(performance.now() - t0)} ${t} (${e.clientX},${e.clientY}) ${e.target?.tagName}.${String(e.target?.className?.baseVal ?? e.target?.className ?? '').slice(0, 30)}`), true);
    }
  });
  const btn = page.locator('.workspace-header button[title="More actions"], .workspace-header .anticon-more').first();
  const box = await btn.boundingBox();
  await btn.tap();
  const samples = [];
  for (const ms of [50, 150, 300, 600]) {
    await page.waitForTimeout(ms);
    samples.push(await page.evaluate(({ x, y }) => ({
      at: [...document.querySelectorAll(':hover')].map((e) => e.tagName + '.' + String(e.className?.baseVal ?? e.className).slice(0, 25)).slice(-1)[0],
      fromPoint: (() => { const e = document.elementFromPoint(x, y); return e && e.tagName + '.' + String(e.className?.baseVal ?? e.className).slice(0, 40); })(),
      backdrop: [...document.querySelectorAll('[data-base-ui-inert], [role="presentation"]')].map((e) => e.tagName + ' ' + (e.getAttribute('style') || '').slice(0, 80)).slice(0, 2),
    }), { x: box.x + box.width / 2, y: box.y + box.height / 2 }));
  }
  console.log(JSON.stringify({ box, ev: await page.evaluate(() => window.__ev), samples }, null, 1));
}
