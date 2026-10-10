// runtime-probe.mjs OUT.json: one tree's production build (PORT) on the P0 fixtures, every P0 route in one browser
// environment (BROWSER chromium|webkit, THEME light|dark, SIZE desktop|phone), recording for each route:
//  - sheets: every stylesheet in effect (a linked file, or a <style> with its data-* marks) and its top-level rules;
//  - census: the component library's classes on any element ([class*="ant-"], icons' anticon excepted);
//  - root: the element React renders into #root (the replaced App div or Orbit's div.orbit-app) and its text styles;
//  - elements: every element under <body>, in document order, with its box and the computed styles that the reset
//    and the root give or that inherit from them.
// analyze-runtime.py compares two trees' files. Fixtures: the tree's own ui-migration/fixtures.mjs, as P0 runs them.
const TREE = process.env.TREE;
const { chromium, webkit } = await import(`${TREE}/node_modules/playwright-core/index.mjs`);
const { installFixtures, installFixedDate, PATHS } = await import(`${TREE}/src/web/ui-migration/fixtures.mjs`);
const { writeFileSync } = await import('node:fs');
const port = process.env.PORT;
const browserName = process.env.BROWSER || 'chromium';
const theme = process.env.THEME || 'light';
const phone = process.env.SIZE === 'phone';
const PROPS = ['display', 'position', 'boxSizing', 'marginTop', 'marginRight', 'marginBottom', 'marginLeft', 'paddingTop', 'paddingRight',
  'paddingBottom', 'paddingLeft', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'fontFamily', 'fontSize',
  'fontWeight', 'fontStyle', 'lineHeight', 'letterSpacing', 'color', 'backgroundColor', 'textDecorationLine', 'textTransform', 'verticalAlign',
  'whiteSpace', 'overflowX', 'overflowY', 'listStyleType', 'textAlign', 'cursor', 'touchAction', 'appearance', 'resize', 'outlineStyle',
  'borderCollapse', 'webkitTapHighlightColor', 'textSizeAdjust', 'webkitTextSizeAdjust'];
const browser = await (browserName === 'webkit' ? webkit : chromium).launch();
const out = { tree: TREE, browser: browserName, theme, size: phone ? 'phone' : 'desktop', routes: {} };
for (const [name, path] of Object.entries(PATHS)) {
  const context = await browser.newContext({ baseURL: `http://127.0.0.1:${port}`, locale: 'en-US', timezoneId: 'UTC', deviceScaleFactor: 1,
    reducedMotion: 'reduce', colorScheme: theme, serviceWorkers: 'block',
    viewport: phone ? { width: 390, height: 844 } : { width: 1280, height: 900 }, isMobile: phone, hasTouch: phone });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await installFixedDate(page);
  await installFixtures(page, { theme });
  await page.goto(path);
  await page.waitForFunction(() => !document.getElementById('boot') && document.querySelector('#root > *'), null, { timeout: 30_000 }).catch(() => {});
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(1500);
  out.routes[name] = { path, errors, ...(await page.evaluate((PROPS) => {
    const describe = (node) => node.tagName === 'LINK' ? `link ${new URL(node.href).pathname.replace(/-[\w-]{8}\.css$/, '.css')}`
      : `${node.tagName.toLowerCase()} ${[...node.attributes].filter((a) => a.name.startsWith('data-')).map((a) => `${a.name}=${a.value.replace(/[\w-]{6,}$/, '…')}`).join(' ')}`.trim();
    const sheets = [...document.styleSheets].map((sheet) => {
      let rules = [];
      try { rules = [...sheet.cssRules].map((rule) => rule.cssText); } catch { rules = ['(unreadable)']; }
      return { owner: sheet.ownerNode ? describe(sheet.ownerNode) : '(none)', rules };
    });
    const census = [...new Set([...document.querySelectorAll('[class*="ant-"]')].flatMap((el) => [...el.classList])
      .filter((token) => token.startsWith('ant-') && !token.startsWith('anticon')))].sort();
    const rootChild = document.querySelector('#root > *');
    const pick = (el) => { const s = getComputedStyle(el); return Object.fromEntries(PROPS.map((p) => [p, s[p]])); };
    const label = (el) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${typeof el.className === 'string' && el.className
      ? `.${el.className.trim().split(/\s+/).filter((c) => !/^(css-var-|css-dev-only|ant-app$|orbit-app$)/.test(c)).join('.')}` : ''}`;
    const elements = [...document.body.querySelectorAll('*')].filter((el) => !['SCRIPT', 'STYLE', 'LINK', 'META'].includes(el.tagName)).map((el) => {
      const r = el.getBoundingClientRect();
      return [label(el), [r.x, r.y, r.width, r.height].map((v) => Math.round(v * 100) / 100), pick(el)];
    });
    return { sheets, census, root: rootChild && { tag: rootChild.tagName, className: String(rootChild.className), style: pick(rootChild) },
      html: pick(document.documentElement), body: pick(document.body), elements };
  }, PROPS)) };
  await context.close();
}
await browser.close();
writeFileSync(process.argv[2], JSON.stringify(out));
console.log(`${browserName}-${theme}-${out.size}: ${Object.keys(out.routes).length} routes, ${Object.values(out.routes).reduce((n, r) => n + r.elements.length, 0)} elements`);
