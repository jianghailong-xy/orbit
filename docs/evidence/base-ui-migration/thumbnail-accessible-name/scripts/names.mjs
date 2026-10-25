// names.mjs PORT: what one tree's build (vite preview on PORT) names the composer's thumbnails, in Chromium and WebKit,
// desktop and phone, on the P0 + P5.3 fixtures (P5.3's probe.mjs setup). Two pictures are pasted into the composer, as
// the P5.3 attachments case pastes one: `screenshot.png` and a picture whose file has no name. For each thumbnail:
//  - the DOM: role, tabindex, aria-label (present or not, and its value), the <img>'s alt;
//  - Playwright's own role and name (aria snapshot of the attachment strip; getByRole counts by name);
//  - Chromium only: the browser's own accessibility tree (CDP Accessibility.getPartialAXTree): role, name, and where the
//    name came from (the name sources Chromium reports, the superseded ones marked);
//  - the keyboard path: Enter on the first thumbnail opens the viewer (its name), Esc closes it, and the focused
//    element's name then (the step P5.3's trace records as `closed with Esc`).
// Prints one JSON document.
const WT = '/root/.orbit/worktrees/815e244b-5a5b-5984-96fb-3b42c31b28ff';
const { chromium, webkit } = await import(`${WT}/node_modules/playwright-core/index.mjs`);
const { installFixtures, installFixedDate } = await import(`${WT}/src/web/ui-migration/fixtures.mjs`);
const { installP53Fixtures, P53_PATHS, PNG } = await import(`${WT}/src/web/ui-migration/p53-fixtures.mjs`);
const port = Number(process.argv[2] || 4373);
const THUMB = '.composer-attach .orbit-image';

async function chromiumNames(page, selector) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('DOM.enable');
  await cdp.send('Accessibility.enable');
  const { root } = await cdp.send('DOM.getDocument', { depth: -1 });
  const { nodeIds } = await cdp.send('DOM.querySelectorAll', { nodeId: root.nodeId, selector });
  const out = [];
  for (const nodeId of nodeIds) {
    const { node } = await cdp.send('DOM.describeNode', { nodeId });
    const { nodes } = await cdp.send('Accessibility.getPartialAXTree', { backendNodeId: node.backendNodeId, fetchRelatives: false });
    const ax = nodes.find((n) => n.backendDOMNodeId === node.backendNodeId) ?? nodes[0];
    const sources = (ax.name?.sources ?? [])
      .filter((s) => s.value || s.attributeValue || s.nativeSourceValue)
      .map((s) => ({
        type: s.type, ...(s.attribute ? { attribute: s.attribute } : {}), ...(s.nativeSource ? { nativeSource: s.nativeSource } : {}),
        value: s.value?.value ?? s.attributeValue?.value ?? s.nativeSourceValue?.value ?? null,
        ...(s.superseded ? { superseded: true } : {}), ...(s.invalid ? { invalid: true } : {}),
      }));
    out.push({ role: ax.role?.value ?? null, name: ax.name?.value ?? null, ignored: !!ax.ignored, sources });
  }
  await cdp.detach();
  return out;
}

const results = [];
for (const browserName of ['chromium', 'webkit']) {
  const browser = await (browserName === 'webkit' ? webkit : chromium).launch();
  for (const size of ['desktop', 'phone']) {
    const phone = size === 'phone';
    const context = await browser.newContext({ baseURL: `http://127.0.0.1:${port}`, locale: 'en-US', timezoneId: 'UTC', deviceScaleFactor: 1,
      reducedMotion: 'reduce', colorScheme: 'light', viewport: phone ? { width: 390, height: 844 } : { width: 1280, height: 900 }, isMobile: phone, hasTouch: phone });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await installFixedDate(page);
    await installFixtures(page, { theme: 'light' });
    await installP53Fixtures(page);
    await page.goto(P53_PATHS.session);
    await page.waitForSelector('.composer-field textarea');
    await page.locator('.composer-field textarea').focus();
    // The paste the P5.3 case makes (its `bring`), with a second picture whose file has no name.
    await page.evaluate((base64) => {
      const data = new DataTransfer();
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      for (const name of ['screenshot.png', '']) data.items.add(new File([bytes], name, { type: 'image/png' }));
      document.querySelector('.composer-field textarea').dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
    }, PNG.toString('base64'));
    await page.locator(THUMB).nth(1).waitFor();
    await page.locator('.composer-attach-spin').first().waitFor({ state: 'detached' });
    const dom = await page.$$eval(THUMB, (els) => els.map((el) => ({
      tag: el.tagName.toLowerCase(), role: el.getAttribute('role'), tabindex: el.getAttribute('tabindex'),
      ariaLabel: el.hasAttribute('aria-label') ? el.getAttribute('aria-label') : '(absent)',
      imgAlt: el.querySelector('img')?.getAttribute('alt') ?? '(no img)',
    })));
    const snapshot = await page.locator('.composer-attachments').ariaSnapshot();
    const byName = {};
    for (const name of ['screenshot.png', 'Preview image', 'eye']) byName[name] = await page.getByRole('button', { name, exact: true }).count();
    const chromiumTree = browserName === 'chromium' ? await chromiumNames(page, THUMB) : null;
    // The keyboard path on the first thumbnail.
    await page.locator(THUMB).first().focus();
    await page.keyboard.press('Enter');
    await page.locator('.orbit-image-preview').filter({ visible: true }).waitFor();
    const viewer = await page.getByRole('dialog').getAttribute('aria-label');
    const focusInViewer = await page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? null);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => ![...document.querySelectorAll('.orbit-image-preview')].some((el) => el.getBoundingClientRect().width > 0));
    const focusAfter = await page.evaluate(() => {
      const el = document.activeElement;
      el?.setAttribute('data-names-focus', '');
      return el ? { tag: el.tagName.toLowerCase(), cls: String(el.className), ariaLabel: el.getAttribute('aria-label') } : null;
    });
    const focusAfterSnapshot = await page.locator('[data-names-focus]').ariaSnapshot();
    const focusAfterTree = browserName === 'chromium' ? (await chromiumNames(page, '[data-names-focus]'))[0] : null;
    await page.evaluate(() => document.querySelector('[data-names-focus]')?.removeAttribute('data-names-focus'));
    results.push({ env: `${browserName}-light-${size}`, dom, snapshot, byName, chromiumTree,
      keyboard: { viewer, focusInViewer, focusAfter, focusAfterSnapshot, focusAfterTree }, errors });
    await context.close();
  }
  await browser.close();
}
console.log(JSON.stringify({ port, results }, null, 2));
