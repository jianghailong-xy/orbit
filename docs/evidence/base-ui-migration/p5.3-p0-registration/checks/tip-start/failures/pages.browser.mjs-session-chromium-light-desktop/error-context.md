# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: pages.browser.mjs >> session
- Location: ui-migration/pages.browser.mjs:6:3

# Error details

```
Error: expect(page).toHaveScreenshot(expected) failed

  1382 pixels (ratio 0.01 of all image pixels) are different.

  Snapshot: session-attachment-staged.png

Call log:
  - Expect "toHaveScreenshot(session-attachment-staged.png)" with timeout 15000ms
    - verifying given screenshot expectation
  - taking page screenshot
    - disabled all CSS animations
  - waiting for fonts to load...
  - fonts loaded
  - 1382 pixels (ratio 0.01 of all image pixels) are different.
  - waiting 100ms before taking screenshot
  - taking page screenshot
    - disabled all CSS animations
  - waiting for fonts to load...
  - fonts loaded
  - captured a stable screenshot
  - 1382 pixels (ratio 0.01 of all image pixels) are different.

```

# Page snapshot

```yaml
- generic [ref=e4]:
  - complementary [ref=e5]:
    - generic [ref=e6]:
      - generic [ref=e14]: Orbit
      - button "Collapse sidebar" [ref=e15] [cursor=pointer]:
        - img "menu-fold" [ref=e16]
    - generic [ref=e19]:
      - generic [ref=e20]:
        - link "Projects Ctrl P" [ref=e21] [cursor=pointer]:
          - generic [ref=e28]: Projects
          - generic "Open Projects with Ctrl P" [ref=e29]: Ctrl P
        - link "Tasks" [ref=e30] [cursor=pointer]
        - link "Wiki" [ref=e37] [cursor=pointer]
        - link "Infrastructure" [ref=e42] [cursor=pointer]
      - generic [ref=e49]:
        - generic [ref=e50] [cursor=pointer]:
          - generic [ref=e51]: Workspaces
          - generic [ref=e52]: "1"
          - img "caret-down" [ref=e53]
          - button "Edit" [ref=e56]
        - generic [ref=e57] [cursor=pointer]:
          - generic [ref=e62]:
            - generic [ref=e63]: Orbit baseline
            - generic [aria-hidden] [ref=e64]: ·
            - generic "Baseline runner" [ref=e65]
          - generic "Open workspace with Ctrl 1" [ref=e66]: Ctrl 1
        - status [ref=e67]
      - generic [ref=e69]:
        - generic [ref=e70] [cursor=pointer]:
          - generic [ref=e71]: Projects
          - generic [ref=e72]: "1"
          - img "caret-down" [ref=e73]
        - generic [ref=e76] [cursor=pointer]: Orbit UI migration
    - button "Account menu, Baseline Reviewer" [ref=e81] [cursor=pointer]:
      - img "user" [ref=e83]
      - generic [ref=e86]: Baseline Reviewer
    - separator [ref=e87]
  - main [ref=e88]:
    - generic [ref=e90]:
      - complementary [ref=e91]:
        - generic [ref=e92]:
          - generic [ref=e94]: Orbit baseline
          - button [ref=e95] [cursor=pointer]:
            - text: Open
            - img "down" [ref=e96]
        - generic [ref=e99] [cursor=pointer]:
          - img "plus" [ref=e100]
          - generic [ref=e104]: New session
        - button "search Search sessions Ctrl K" [ref=e105] [cursor=pointer]:
          - img "search" [ref=e106]
          - generic [ref=e109]: Search sessions
          - generic [ref=e110]: Ctrl K
        - generic [ref=e112]:
          - generic [ref=e113]: Today
          - generic [ref=e114] [cursor=pointer]:
            - generic [ref=e115]:
              - img "message" [ref=e117]
              - generic [ref=e120]:
                - generic [ref=e121]:
                  - generic [ref=e122]: Review the component migration
                  - generic [ref=e123]: just now
                - generic [ref=e124]: Waiting for your reply
            - generic:
              - generic:
                - button "More actions":
                  - img "ellipsis"
      - separator [ref=e126]
      - generic [ref=e127]:
        - generic [ref=e128]:
          - generic [ref=e129]:
            - generic [ref=e130]:
              - generic "Double-click to rename" [ref=e131]: Review the component migration
              - button "Follow" [ref=e133] [cursor=pointer]
            - generic [ref=e134]: Waiting for your reply · Open · just now
          - button "More actions" [ref=e135] [cursor=pointer]
        - generic [ref=e141]:
          - generic [ref=e142]:
            - paragraph [ref=e145]: Keep the current appearance and keyboard behavior. 请保留现有外观与键盘交互。
            - generic:
              - button "Copy message":
                - img "copy"
              - generic: just now
          - generic [ref=e146]: Worked for 1s
          - generic [ref=e148]:
            - paragraph [ref=e149]:
              - text: I will verify the
              - strong [ref=e150]: existing interface
              - text: before changing components.
            - list [ref=e151]:
              - listitem [ref=e152]: Light and dark themes
              - listitem [ref=e153]: Desktop and phone layouts
              - listitem [ref=e154]: Input focus and attachments
            - paragraph [ref=e155]:
              - code [ref=e156]: npm run test:ui-migration -w @orbit/web
          - generic [ref=e157]:
            - button "Copy reply" [ref=e158] [cursor=pointer]:
              - img "copy" [ref=e159]
            - generic [ref=e162]: 12:00 PM
          - generic [ref=e163]:
            - paragraph [ref=e166]: Check the composer next.
            - generic:
              - button "Copy message":
                - img "copy"
              - generic: just now
          - generic [ref=e167]: Worked for 1s
          - paragraph [ref=e170]: The input, attachment menu, and notification keep their current appearance.
          - generic [ref=e171]:
            - button "Copy reply" [ref=e172] [cursor=pointer]:
              - img "copy" [ref=e173]
            - generic [ref=e176]: 12:00 PM
        - generic [ref=e178]:
          - generic [ref=e180]:
            - img "paper-clip" [ref=e181]
            - generic "baseline-note.txt" [ref=e184]
            - generic [ref=e185]: 33 B
            - button "Remove file" [ref=e186] [cursor=pointer]:
              - img "close" [ref=e187]
          - generic [ref=e190]:
            - generic [aria-hidden]: Review the migration Keep keyboard behavior.
            - textbox "Reply…" [ref=e191]: Review the migration Keep keyboard behavior.
          - generic [ref=e192]:
            - button "Add attachment" [active] [ref=e193] [cursor=pointer]
            - generic [ref=e199]:
              - combobox [ref=e201] [cursor=pointer]:
                - generic [ref=e202]: Default
              - textbox [aria-hidden] [ref=e203]: Default
            - button "Model claude-opus-5, effort Default" [ref=e205] [cursor=pointer]:
              - generic [ref=e206]: claude-opus-5
              - generic [ref=e207]: Default
            - button "Context window not reported yet" [ref=e208]:
              - generic [ref=e212]: —
            - button "Send" [ref=e213] [cursor=pointer]
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
  27 |         await expect(locator).toBeVisible();
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
> 38 |       await expect(page).toHaveScreenshot(`${name}.png`);
     |                          ^ Error: expect(page).toHaveScreenshot(expected) failed
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