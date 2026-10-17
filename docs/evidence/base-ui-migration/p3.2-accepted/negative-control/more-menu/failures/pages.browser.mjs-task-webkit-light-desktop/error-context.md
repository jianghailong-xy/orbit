# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: pages.browser.mjs >> task
- Location: ui-migration/pages.browser.mjs:6:3

# Error details

```
Error: expect(page).toHaveScreenshot(expected) failed

  538 pixels (ratio 0.01 of all image pixels) are different.

  Snapshot: task-action-menu.png

Call log:
  - Expect "toHaveScreenshot(task-action-menu.png)" with timeout 15000ms
    - verifying given screenshot expectation
  - taking page screenshot
    - disabled all CSS animations
  - waiting for fonts to load...
  - fonts loaded
  - 538 pixels (ratio 0.01 of all image pixels) are different.
  - waiting 100ms before taking screenshot
  - taking page screenshot
    - disabled all CSS animations
  - waiting for fonts to load...
  - fonts loaded
  - captured a stable screenshot
  - 538 pixels (ratio 0.01 of all image pixels) are different.

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
        - link "Runners" [ref=e42] [cursor=pointer]
        - link "Providers" [ref=e48] [cursor=pointer]
      - generic [ref=e54]:
        - generic [ref=e55] [cursor=pointer]:
          - generic [ref=e56]: Workspaces
          - generic [ref=e57]: "1"
          - img "caret-down" [ref=e58]
          - button "Edit" [ref=e61]
        - generic [ref=e62] [cursor=pointer]:
          - generic [ref=e67]:
            - generic [ref=e68]: Orbit baseline
            - generic [aria-hidden] [ref=e69]: ·
            - generic "Baseline runner" [ref=e70]
          - generic "Open workspace with Ctrl 1" [ref=e71]: Ctrl 1
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
    - separator [ref=e92]
  - main [ref=e93]:
    - generic [ref=e94]:
      - generic [ref=e95]:
        - heading [level=1] [ref=e97]:
          - button [ref=e98] [cursor=pointer]:
            - text: All tasks
            - img "caret-down" [ref=e99]
        - generic [ref=e102]: Done 0 / 1·Open 1
        - generic [ref=e105]:
          - radiogroup "segmented control" [ref=e106]:
            - generic [ref=e107]:
              - generic [ref=e108] [cursor=pointer]:
                - radio "All 1" [checked]
                - generic [ref=e110]:
                  - text: All
                  - generic [ref=e111]: "1"
              - generic [ref=e112] [cursor=pointer]:
                - radio "Open 1"
                - generic [ref=e114]:
                  - text: Open
                  - generic [ref=e115]: "1"
              - generic [ref=e116] [cursor=pointer]:
                - radio "Ready 1"
                - generic [ref=e118]:
                  - text: Ready
                  - generic [ref=e119]: "1"
              - generic [ref=e120] [cursor=pointer]:
                - radio "Running 0"
                - generic [ref=e122]:
                  - text: Running
                  - generic [ref=e123]: "0"
              - generic [ref=e124] [cursor=pointer]:
                - radio "Failed 0"
                - generic [ref=e126]:
                  - text: Failed
                  - generic [ref=e127]: "0"
              - generic [ref=e128] [cursor=pointer]:
                - radio "Done 0"
                - generic [ref=e130]:
                  - text: Done
                  - generic [ref=e131]: "0"
          - generic [ref=e132]:
            - img "search" [ref=e134]
            - textbox "Search tasks" [ref=e137]
          - generic [ref=e139]:
            - generic [ref=e140]: O
            - text: Orbit baseline
      - generic [ref=e143]:
        - generic [ref=e144]:
          - checkbox [ref=e148] [cursor=pointer]
          - generic [ref=e149] [cursor=pointer]: Status
          - generic [ref=e150] [cursor=pointer]: Task
        - generic [ref=e151] [cursor=pointer]:
          - checkbox [ref=e155]
          - generic [ref=e156]: Open
          - generic "Review the visual baseline" [ref=e160]
          - generic:
            - button "Delete Review the visual baseline":
              - generic:
                - img "delete"
  - complementary [ref=e161]:
    - generic [ref=e163]:
      - generic [ref=e164]:
        - generic [ref=e165]: Review the visual baseline
        - generic [ref=e166]:
          - generic [ref=e167]: Open
          - generic [ref=e168]:
            - generic [ref=e169]: O
            - text: Orbit baseline
          - generic [ref=e171]: · Sep 27, 10:00 AM
        - generic [ref=e172]:
          - img "check" [ref=e173]
          - generic [ref=e176]: Judged by · submitted evidence
      - button "Run now" [ref=e179] [cursor=pointer]
      - button "Delete task" [ref=e186] [cursor=pointer]
      - button "More actions" [expanded] [ref=e192] [cursor=pointer]
      - menu "More actions" [active] [ref=e200]:
        - menuitem "Copy link" [ref=e201] [cursor=pointer]
        - menuitem "Share… Live link" [ref=e207] [cursor=pointer]:
          - generic [ref=e213]:
            - text: Share…
            - generic [ref=e214]: Live link
        - menuitem "Copy as Markdown" [ref=e215] [cursor=pointer]
      - button "Close" [ref=e223] [cursor=pointer]
    - generic [ref=e228]:
      - generic [ref=e229]:
        - generic [ref=e230]: Details
        - generic [ref=e231]:
          - generic [ref=e232]: Assignee
          - generic [ref=e233]:
            - generic [ref=e234]:
              - generic: Orbit baseline
              - combobox [ref=e235]
            - button "Show options" [ref=e236] [cursor=pointer]
            - button "Clear selection" [ref=e240] [cursor=pointer]
          - textbox [aria-hidden] [ref=e244]: 2zwQZ2hd93IvLb59t6p1s
        - generic [ref=e245]:
          - generic [ref=e246]: Provider
          - generic [ref=e247]:
            - generic [ref=e248]:
              - generic: Codex
              - combobox [ref=e249]
            - button "Show options" [ref=e250] [cursor=pointer]
            - button "Clear selection" [ref=e254] [cursor=pointer]
          - textbox [aria-hidden] [ref=e258]: codex
        - generic [ref=e259]:
          - generic [ref=e260]: Model
          - generic [ref=e261]:
            - generic [ref=e262]:
              - generic [aria-hidden]: Provider default
              - combobox [ref=e263]
            - button "Show options" [ref=e264] [cursor=pointer]
          - textbox [aria-hidden] [ref=e268]
        - generic [ref=e269]:
          - generic [ref=e270]: List
          - generic [ref=e271]:
            - generic [ref=e272]:
              - generic [aria-hidden]: No list
              - combobox [ref=e273]
            - button "Show options" [ref=e274] [cursor=pointer]
          - textbox [aria-hidden] [ref=e278]
        - generic [ref=e279]:
          - generic [ref=e280]: Start at
          - generic [ref=e281]:
            - textbox "Start at" [ref=e282]
            - button "Save schedule" [disabled] [ref=e284]
            - generic [ref=e285]: Optional, in your own time zone. The task starts once, at that time.
        - generic [ref=e286]:
          - generic [ref=e287]: Created by
          - generic [ref=e288]: —
        - generic [ref=e289]:
          - generic [ref=e290]: Created
          - generic [ref=e291]: Sep 27, 10:00 AM
      - generic [ref=e292]:
        - generic [ref=e293]: Dependencies
        - generic [ref=e295]: No dependencies
        - generic [ref=e296]:
          - generic [ref=e297]:
            - generic [aria-hidden]: Add a prerequisite…
            - combobox [ref=e298]
          - button "Show options" [ref=e299] [cursor=pointer]
        - textbox [aria-hidden] [ref=e303]
      - generic [ref=e304]:
        - generic [ref=e305]: Description
        - generic [ref=e307]:
          - paragraph [ref=e308]:
            - text: Keep the existing
            - strong [ref=e309]: Orbit appearance
            - text: and business interactions.
          - paragraph [ref=e310]: Check light and dark themes, keyboard focus, and narrow screens.
      - generic [ref=e311]:
        - generic [ref=e312]: Acceptance
        - generic [ref=e313]:
          - generic [ref=e314]: Acceptance criteria
          - button "Edit" [ref=e315] [cursor=pointer]
        - paragraph [ref=e319]: The representative pages retain their layout and keyboard behavior.
        - generic [ref=e320]: Automatic judgement
        - generic [ref=e322]: Not set — a person decides when this task is done.
        - generic [ref=e323]: Filled in as a pair, the task is judged by running this command and reading its exit code — nobody has to decide by hand.
      - generic [ref=e324]:
        - generic [ref=e325]: Inputs (0)
        - generic [ref=e326]: Files every run of this task is given — design mocks, specs. Each run gets its own copy.
        - button "Add file" [ref=e328] [cursor=pointer]
      - generic [ref=e334]:
        - generic [ref=e335]: Attribution
        - generic [ref=e339]:
          - generic [ref=e340]:
            - generic [ref=e341]: Counts towards
            - generic [ref=e342]: This task is filed under no project.
          - generic [ref=e343]:
            - generic [ref=e344]: Noticed in
            - generic [ref=e345]: Nothing was recorded about where this work was noticed.
          - generic [ref=e346]:
            - generic [ref=e347]: Crossing
            - generic [ref=e348]: No declared crossing touches this task.
          - generic [ref=e349]:
            - generic [ref=e350]: Blocked by
            - generic [ref=e351]: Nothing is blocking where this work counts.
      - region "Followed by" [ref=e352]:
        - generic [ref=e353]:
          - generic [ref=e354]: Followed by (0)
          - button "eye Follow task" [ref=e355] [cursor=pointer]:
            - img "eye" [ref=e357]
            - generic [ref=e360]: Follow task
        - generic [ref=e361]: Nothing is watching this task.
      - generic [ref=e362]:
        - generic [ref=e363]: Runs (0)
        - generic [ref=e364]: No runs yet
      - generic [ref=e365]:
        - generic [ref=e366]: Comments (1)
        - generic [ref=e367]:
          - generic [ref=e368]: B
          - generic [ref=e370]:
            - generic [ref=e371]:
              - generic [ref=e372]: Baseline Reviewer
              - generic [ref=e373]: Sep 27, 10:00 AM
            - paragraph [ref=e375]: Capture the current interface before the first component migration.
    - generic [ref=e376]:
      - textbox "Add a comment… type @ to mention a workspace (⌘/Ctrl + Enter to send)" [ref=e377]:
        - /placeholder: Add a comment…  type @ to mention a workspace  (⌘/Ctrl + Enter to send)
      - button "Send" [disabled] [ref=e378]
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