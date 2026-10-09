# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: pages.browser.mjs >> wiki
- Location: ui-migration/pages.browser.mjs:6:3

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: locator('.wk-card').first()
Expected: visible
Timeout: 15000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" locator('.wk-card').first() with timeout 15000ms
  - waiting for locator('.wk-card').first()

```

```yaml
- banner:
  - button "Open menu":
    - img "menu"
  - text: Orbit
- complementary:
  - img
  - text: Orbit
  - link "Projects"
  - link "Tasks"
  - link "Wiki"
  - link "Runners"
  - link "Providers"
  - text: Workspaces 1
  - img "caret-down"
  - button "Edit"
  - text: Orbit baseline Baseline runner
  - status
  - text: Projects 1
  - img "caret-down"
  - text: Orbit UI migration
  - button "Account menu, Baseline Reviewer":
    - img "user"
    - text: Baseline Reviewer
- main:
  - heading "Wiki" [level=1]
  - text: orbit
  - button "Contents":
    - img "unordered-list"
  - button "Activity":
    - img "history"
  - button "Settings":
    - img "setting"
  - button "New entry":
    - img "plus"
  - text: 1 article
  - search:
    - button "search Search the wiki":
      - img "search"
      - text: Search the wiki
  - text: Principles 1 Owner
  - link "pushpin Preserve visible behavior 9/27":
    - /url: /wiki/orbit/e/2zwQZ2hd93IvLb59t6pHt
    - img "pushpin"
    - text: Preserve visible behavior 9/27
  - text: Clients & UI
  - link "UI migration right":
    - /url: /wiki/orbit/t/ui-migration
    - text: UI migration
    - img "right"
  - link "appstore Browse by category":
    - /url: /wiki/orbit/browse
    - img "appstore"
    - text: Browse by category
  - link "sort-ascending A–Z index":
    - /url: /wiki/orbit/az
    - img "sort-ascending"
    - text: A–Z index
```

# Test source

```ts
  1  | import { test as base, expect } from '@playwright/test';
  2  | import { writeFileSync } from 'node:fs';
  3  | import { installFixtures, installFixedDate } from './fixtures.mjs';
  4  | 
  5  | export { expect };
  6  | export const test = base.extend({
  7  |   scenario: ['default', { option: true }],
  8  |   evidence: async ({ page, scenario }, use, testInfo) => {
  9  |     const theme = testInfo.project.use.colorScheme;
  10 |     await installFixedDate(page);
  11 |     const api = await installFixtures(page, { theme, scenario });
  12 |     const pageErrors = [];
  13 |     page.on('pageerror', (error) => pageErrors.push(error.message));
  14 |     const measurements = { project: testInfo.project.name, test: testInfo.title, browser: page.context().browser().version(), captures: [], timings: [] };
  15 |     async function measure(name, operation) {
  16 |       const start = performance.now();
  17 |       const result = await operation();
  18 |       await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  19 |       const end = performance.now();
  20 |       measurements.timings.push({ name, elapsedMs: end - start });
  21 |       return result;
  22 |     }
  23 |     async function capture(name, selectors = {}) {
  24 |       await page.evaluate(() => document.fonts.ready);
  25 |       for (const selector of Object.values(selectors)) {
  26 |         const locator = typeof selector === 'string' ? page.locator(selector).first() : selector;
> 27 |         await expect(locator).toBeVisible();
     |                               ^ Error: expect(locator).toBeVisible() failed
  28 |         // Visibility alone accepts opacity:0 during an overlay's prepare phase.
  29 |         await expect.poll(() => locator.evaluate((el) => {
  30 |           for (let node = el; node; node = node.parentElement) {
  31 |             if (Number(getComputedStyle(node).opacity) < 1) return false;
  32 |           }
  33 |           return true;
  34 |         }), { message: `${name}: selected content has finished fading in` }).toBe(true);
  35 |       }
  36 |       await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  37 |       // Screenshot assertion waits for two identical frames. No visual masking or custom CSS.
  38 |       await expect(page).toHaveScreenshot(`${name}.png`);
  39 |       const styles = await page.evaluate(() => {
  40 |         const properties = ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'color', 'backgroundColor', 'border', 'borderTop', 'borderRight', 'borderBottom', 'borderLeft', 'borderRadius', 'boxShadow', 'outline', 'outlineOffset', 'padding', 'gap', 'display', 'position', 'zIndex', 'transitionDuration', 'animationDuration'];
  41 |         const controls = [...document.querySelectorAll('h1,h2,h3,button,input,textarea,[role="button"],[role="combobox"],[role="switch"],[role="dialog"],[role="menu"],.toast-card')].filter((el) => el.getBoundingClientRect().width && el.getBoundingClientRect().height && getComputedStyle(el).visibility !== 'hidden');
  42 |         const canvas = document.createElement('canvas');
  43 |         const context = canvas.getContext('2d');
  44 |         context.font = `14px ${getComputedStyle(document.body).fontFamily}`;
  45 |         const glyphProbe = { text: 'Orbit baseline 0123 — 中文输入', font: context.font, width: context.measureText('Orbit baseline 0123 — 中文输入').width };
  46 |         return {
  47 |           glyphProbe,
  48 |           viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio, scale: visualViewport?.scale, touch: navigator.maxTouchPoints },
  49 |           navigation: performance.getEntriesByType('navigation').map((entry) => entry.toJSON()),
  50 |           paint: performance.getEntriesByType('paint').map((entry) => entry.toJSON()),
  51 |           theme: document.documentElement.dataset.theme,
  52 |           tokens: Object.fromEntries(['--bg-base', '--bg-raised', '--text-1', '--text-2', '--border', '--brand'].map((name) => [name, getComputedStyle(document.documentElement).getPropertyValue(name).trim()])),
  53 |           documentWidth: document.documentElement.scrollWidth,
  54 |           graphGeometry: [...document.querySelectorAll('[data-testid="project-dependency-graph"],.pdg-task')].map((el) => ({ label: el.matches('.pdg-task') ? el.textContent : 'graph', ...el.getBoundingClientRect().toJSON() })),
  55 |           media: Object.fromEntries([600,640,960].map((width) => [width, matchMedia(`(max-width: ${width}px)`).matches])),
  56 |           controls: controls.map((el) => { const rect = el.getBoundingClientRect(), style = getComputedStyle(el); return {
  57 |             tag: el.tagName, role: el.getAttribute('role'), label: el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.textContent?.trim().slice(0, 100),
  58 |             disabled: el.matches(':disabled'), focused: el === document.activeElement, hovered: el.matches(':hover'),
  59 |             rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
  60 |             style: Object.fromEntries(properties.map((key) => [key, style[key]])),
  61 |           }; }),
  62 |         };
  63 |       });
  64 |       if (testInfo.project.use.browserName === 'chromium') {
  65 |         const cdp = await page.context().newCDPSession(page);
  66 |         await cdp.send('DOM.enable');
  67 |         await cdp.send('CSS.enable');
  68 |         const { root } = await cdp.send('DOM.getDocument');
  69 |         const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '.tdp-title, h1, .chat-assistant p' });
  70 |         if (nodeId) styles.renderedFonts = (await cdp.send('CSS.getPlatformFontsForNode', { nodeId })).fonts;
  71 |         await cdp.detach();
  72 |       }
  73 |       expect(styles.viewport.dpr).toBe(1);
  74 |       expect(styles.viewport.scale).toBe(1);
  75 |       expect(styles.viewport.width).toBe(page.viewportSize().width);
  76 |       expect(styles.theme).toBe(theme);
  77 |       const selected = {};
  78 |       for (const [label, selector] of Object.entries(selectors)) {
  79 |         const locator = typeof selector === 'string' ? page.locator(selector).first() : selector;
  80 |         await expect(locator).toBeVisible();
  81 |         selected[label] = await locator.evaluate((el) => { const r = el.getBoundingClientRect(), s = getComputedStyle(el); return { width: r.width, height: r.height, fontFamily: s.fontFamily, fontSize: s.fontSize, fontWeight: s.fontWeight, lineHeight: s.lineHeight, color: s.color, background: s.backgroundColor, border: s.border, radius: s.borderRadius, shadow: s.boxShadow }; });
  82 |       }
  83 |       measurements.captures.push({ name, ...styles, selected });
  84 |     }
  85 |     try {
  86 |       await use({ page, expect, capture, measure, api, measurements });
  87 |       api.assertHandled();
  88 |       expect(pageErrors, 'No unhandled errors in the real application').toEqual([]);
  89 |     } finally {
  90 |       const path = testInfo.outputPath('evidence.json');
  91 |       writeFileSync(path, JSON.stringify({ ...measurements, requests: api.requests, unhandled: api.unhandled, pageErrors }, null, 2) + '\n');
  92 |       await testInfo.attach('computed-styles-and-timings', { path, contentType: 'application/json' });
  93 |     }
  94 |   },
  95 | });
  96 | 
```