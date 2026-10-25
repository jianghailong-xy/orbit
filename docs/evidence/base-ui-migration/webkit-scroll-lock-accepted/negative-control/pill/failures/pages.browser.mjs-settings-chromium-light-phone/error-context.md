# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: pages.browser.mjs >> settings
- Location: ui-migration/pages.browser.mjs:6:3

# Error details

```
Error: expect(page).toHaveScreenshot(expected) failed

  291 pixels (ratio 0.01 of all image pixels) are different.

  Snapshot: settings-saved.png

Call log:
  - Expect "toHaveScreenshot(settings-saved.png)" with timeout 15000ms
    - verifying given screenshot expectation
  - taking page screenshot
    - disabled all CSS animations
  - waiting for fonts to load...
  - fonts loaded
  - 291 pixels (ratio 0.01 of all image pixels) are different.
  - waiting 100ms before taking screenshot
  - taking page screenshot
    - disabled all CSS animations
  - waiting for fonts to load...
  - fonts loaded
  - captured a stable screenshot
  - 291 pixels (ratio 0.01 of all image pixels) are different.

```

# Page snapshot

```yaml
- generic [ref=e1]:
  - generic [ref=e4]:
    - banner [ref=e5]:
      - button "Open menu" [ref=e6] [cursor=pointer]:
        - img "menu" [ref=e7]
      - generic [ref=e10]: Orbit
    - complementary [ref=e11]:
      - generic [ref=e12]: Orbit
      - generic [ref=e21]:
        - generic [ref=e22]:
          - link "Projects" [ref=e23] [cursor=pointer]
          - link "Tasks" [ref=e31] [cursor=pointer]
          - link "Wiki" [ref=e38] [cursor=pointer]
          - link "Runners" [ref=e43] [cursor=pointer]
          - link "Providers" [ref=e49] [cursor=pointer]
        - generic [ref=e55]:
          - generic [ref=e56] [cursor=pointer]:
            - generic [ref=e57]: Workspaces
            - generic [ref=e58]: "1"
            - img "caret-down" [ref=e59]
            - button "Edit" [ref=e62]
          - generic [ref=e68] [cursor=pointer]:
            - generic [ref=e69]: Orbit baseline
            - generic [aria-hidden] [ref=e70]: ·
            - generic "Baseline runner" [ref=e71]
          - status [ref=e72]
        - generic [ref=e74]:
          - generic [ref=e75] [cursor=pointer]:
            - generic [ref=e76]: Projects
            - generic [ref=e77]: "1"
            - img "caret-down" [ref=e78]
          - generic [ref=e81] [cursor=pointer]: Orbit UI migration
      - button "Account menu, Baseline Reviewer" [ref=e86] [cursor=pointer]:
        - img "user" [ref=e88]
        - generic [ref=e91]: Baseline Reviewer
    - main [ref=e92]:
      - generic [ref=e94]:
        - heading "Settings" [level=1] [ref=e95]
        - region [ref=e96]:
          - heading "Session defaults" [level=2] [ref=e98]
          - generic [ref=e99]:
            - generic [ref=e100]:
              - generic [ref=e101]:
                - generic [ref=e102]: Default permission mode
                - generic [ref=e103]: "The mode a new session starts in, unless the composer picks another. Account-wide: the mode is a property of the run, not of the workspace it runs in."
              - generic [ref=e104]:
                - combobox "Default permission mode" [ref=e106] [cursor=pointer]:
                  - generic [ref=e107]: Default
                - textbox [aria-hidden] [ref=e111]: default
            - generic [ref=e112]:
              - generic [ref=e113]:
                - generic [ref=e114]: Smart model selection
                - generic [ref=e115]: "Coordinators suggest a tier for each task, and Agents you turn this on for run their tasks on that tier's model and effort. Off: tasks run exactly as before."
              - generic [ref=e116]:
                - switch "Smart model selection" [checked] [active] [ref=e117] [cursor=pointer]
                - checkbox [checked] [aria-hidden] [ref=e119]
            - generic [ref=e120]:
              - generic [ref=e121]:
                - generic [ref=e122]: Suggested replies
                - generic [ref=e123]: When a Claude turn ends, the empty message box offers what you'd probably type next. Each suggestion is one more request on that session's Claude account.
              - generic [ref=e124]:
                - switch "Suggested replies" [checked] [ref=e125] [cursor=pointer]
                - checkbox [checked] [aria-hidden] [ref=e127]
        - region [ref=e128]:
          - heading "Session orchestration" [level=2] [ref=e130]
          - generic [ref=e132]:
            - generic [ref=e133]:
              - generic [ref=e134]: Let sessions orchestrate
              - generic [ref=e135]: Sessions in every workspace can spawn and manage other sessions via the orbit MCP session tools. Off → those tools are hidden and refused.
            - generic [ref=e136]:
              - switch "Let sessions orchestrate" [checked] [ref=e137] [cursor=pointer]
              - checkbox [checked] [aria-hidden] [ref=e139]
        - region [ref=e140]:
          - heading "Notifications" [level=2] [ref=e142]
          - generic [ref=e143]:
            - generic [ref=e144]:
              - generic [ref=e145]:
                - generic [ref=e146]: When a session finishes
                - generic [ref=e147]: Alert your devices when a run finishes on its own or fails for good.
              - generic [ref=e148]:
                - switch "When a session finishes" [checked] [ref=e149] [cursor=pointer]
                - checkbox [checked] [aria-hidden] [ref=e151]
            - generic [ref=e152]:
              - generic [ref=e153]:
                - generic [ref=e154]: When an agent asks for you
                - generic [ref=e155]: Let a running agent alert your devices itself — to ask something only you can answer, or to report what you were waiting for. At most one per session per minute.
              - generic [ref=e156]:
                - switch "When an agent asks for you" [checked] [ref=e157] [cursor=pointer]
                - checkbox [checked] [aria-hidden] [ref=e159]
        - region [ref=e160]:
          - heading "Appearance" [level=2] [ref=e162]
          - generic [ref=e164]:
            - generic [ref=e165]:
              - generic [ref=e166]: Theme
              - generic [ref=e167]: Synced to your account across devices.
            - radiogroup "Theme" [ref=e169]:
              - generic [ref=e170]:
                - radio "System" [ref=e171] [cursor=pointer]
                - radio [aria-hidden] [ref=e173]
                - radio "Light" [checked] [ref=e174] [cursor=pointer]
                - radio [checked] [aria-hidden] [ref=e176]
                - radio "Dark" [ref=e177] [cursor=pointer]
                - radio [aria-hidden] [ref=e179]
        - region [ref=e180]:
          - heading "Sharing" [level=2] [ref=e182]
          - generic [ref=e184]:
            - generic [ref=e185]:
              - generic [ref=e186]: Shared links
              - generic [ref=e187]: "Everything you’ve made viewable by link: what each one includes, how often it was opened, and a way to turn it off."
            - button "Manage" [ref=e189] [cursor=pointer]
        - region [ref=e191]:
          - heading "Access tokens" [level=2] [ref=e193]
          - generic [ref=e195]:
            - generic [ref=e196]:
              - generic [ref=e197]: Personal access tokens
              - generic [ref=e198]: "Let scripts and the orbit CLI use the Orbit API as you: what each token can reach, when it was last used, and a way to revoke it."
            - button "Manage" [ref=e200] [cursor=pointer]
  - generic:
    - region "Notifications":
      - generic: Setting saved
  - generic [ref=e202]: Setting saved
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