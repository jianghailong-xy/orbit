export default async function (page) {
  await page.evaluate(() => {
    window.__ev = [];
    for (const t of ['touchstart', 'touchend', 'pointerdown', 'pointerup', 'mousemove', 'mouseover', 'mousedown', 'mouseup', 'click', 'pointerover']) {
      document.addEventListener(t, (e) => window.__ev.push(`${t}${e.defaultPrevented ? '(prevented)' : ''}:${e.target?.className?.baseVal ?? String(e.target?.className ?? '').slice(0, 30)}`), true);
      window.addEventListener(t, (e) => { if (e.defaultPrevented) window.__ev.push(`${t} prevented-at-window`); }, false);
    }
  });
  await page.locator('.workspace-header button[title="More actions"], .workspace-header .anticon-more').first().tap();
  await page.waitForTimeout(800);
  const r = await page.evaluate(() => {
    const t = document.querySelector('.workspace-header button[title="More actions"]') || document.querySelector('.workspace-header .anticon-more')?.closest('button');
    return { ev: window.__ev, hover: t?.matches(':hover'), hovered: [...document.querySelectorAll(':hover')].map((e) => e.tagName + '.' + String(e.className).slice(0, 25)).slice(-3), bg: t && getComputedStyle(t).backgroundColor };
  });
  console.log(JSON.stringify(r, null, 1));
}
