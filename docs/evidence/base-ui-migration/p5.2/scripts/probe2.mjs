// Probe the reference (AntD) preview group: DOM, computed styles, focus, scroll lock.
const WT = process.env.WT || '/root/.orbit/worktrees/6d689aae-2d33-526f-af1f-826adf954c6d';
const { chromium, webkit } = await import(`${WT}/node_modules/playwright-core/index.mjs`);
const { installFixtures, installFixedDate } = await import(`${WT}/src/web/ui-migration/fixtures.mjs`);
const { installP52Fixtures, installObjectUrlLog, P52_PATHS } = await import(`${WT}/src/web/ui-migration/p52-fixtures.mjs`);
const port = process.env.PORT || 4352;
const browserName = process.env.BROWSER || 'chromium';
const theme = process.env.THEME || 'light';
const phone = process.env.SIZE === 'phone';
const browser = await (browserName === 'webkit' ? webkit : chromium).launch();
const context = await browser.newContext({ baseURL: `http://127.0.0.1:${port}`, locale: 'en-US', timezoneId: 'UTC', deviceScaleFactor: 1, reducedMotion: 'reduce', colorScheme: theme,
  viewport: phone ? { width: 390, height: 844 } : { width: 1280, height: 900 }, isMobile: phone, hasTouch: phone });
const page = await context.newPage();
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('CONSOLE', m.type(), m.text().slice(0, 300)); });
await installFixedDate(page);
await installFixtures(page, { theme });
await installObjectUrlLog(page);
await installP52Fixtures(page);
await page.goto(P52_PATHS.session);
await page.waitForSelector('.chat-assistant');
await page.waitForTimeout(1200);
const settle = () => page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'), null, { timeout: 3000 }).catch(() => {});
const state = () => page.evaluate(() => {
  const pick = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return { tag: el.tagName, cls: String(el.className).replace(/css-[\w-]+/g, '').trim(), role: el.getAttribute('role'), aria: el.getAttribute('aria-label'), tabindex: el.getAttribute('tabindex'), disabled: el.disabled, rect: [r.x, r.y, r.width, r.height].map((v) => Math.round(v * 100) / 100), display: s.display, position: s.position, inset: [s.top, s.right, s.bottom, s.left].join(' '), z: s.zIndex, padding: s.padding, margin: s.margin, gap: s.gap, font: `${s.fontSize}/${s.lineHeight} ${s.fontWeight}`, bg: s.backgroundColor, color: s.color, radius: s.borderRadius, border: s.border, outline: `${s.outlineStyle} ${s.outlineWidth} ${s.outlineColor} ${s.outlineOffset}`, cursor: s.cursor, transform: s.transform, transition: s.transition, opacity: s.opacity, textAlign: s.textAlign, userSelect: s.userSelect, pointerEvents: s.pointerEvents, maxW: s.maxWidth, maxH: s.maxHeight, va: s.verticalAlign, flexDir: s.flexDirection, align: s.alignItems, justify: s.justifyContent, backdrop: s.backdropFilter }; };
  const root = document.querySelector('.ant-image-preview, .orbit-image-preview');
  const all = root ? [root, ...root.querySelectorAll('*')].filter((el) => !el.closest('svg') || el.tagName === 'svg') : [];
  const active = document.activeElement;
  return {
    html: root ? root.outerHTML.replace(/src="[^"]+"/g, 'src=…').replace(/<svg.*?<\/svg>/g, '<svg/>').slice(0, 3000) : null,
    parents: root ? (() => { const chain = []; for (let n = root.parentElement; n; n = n.parentElement) chain.push(`${n.tagName}.${String(n.className).slice(0, 60)}`); return chain; })() : [],
    elements: all.map(pick),
    focus: active ? `${active.tagName}.${String(active.className).slice(0, 80)} aria=${active.getAttribute('aria-label')}` : null,
    html_overflow: getComputedStyle(document.documentElement).overflow, body_overflow: getComputedStyle(document.body).overflow, body_style: document.body.getAttribute('style'), html_style: document.documentElement.getAttribute('style'),
    bodyWidth: document.body.getBoundingClientRect().width,
    styleTags: [...document.querySelectorAll('style')].map((s) => s.textContent).filter((t) => /overflow|scroll/.test(t) && t.length < 400),
  };
});
const out = {};
const thumbs = page.locator('button.chat-image-btn');
console.log('thumbs', await thumbs.count());
await thumbs.nth(1).scrollIntoViewIfNeeded();
await thumbs.nth(1).click();
await settle();
await page.waitForTimeout(500);
out.open = await state();
await page.keyboard.press('ArrowRight');
await settle(); await page.waitForTimeout(400);
out.right = await state();
await page.mouse.move(5, 5);
for (const [k, v] of Object.entries(out)) {
  console.log('==== ' + k);
  console.log('html', v.html);
  console.log('parents', JSON.stringify(v.parents));
  console.log('focus', v.focus, '| html overflow', v.html_overflow, '| body overflow', v.body_overflow, '| body style', v.body_style, '| html style', v.html_style, '| bodyWidth', v.bodyWidth);
  console.log('styleTags', JSON.stringify(v.styleTags));
  for (const e of v.elements) console.log(JSON.stringify(e));
}
await browser.close();
