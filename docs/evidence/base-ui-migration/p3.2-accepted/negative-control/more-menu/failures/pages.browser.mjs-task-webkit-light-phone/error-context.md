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

  690 pixels (ratio 0.01 of all image pixels) are different.

  Snapshot: task-action-menu.png

Call log:
  - Expect "toHaveScreenshot(task-action-menu.png)" with timeout 15000ms
    - verifying given screenshot expectation
  - taking page screenshot
    - disabled all CSS animations
  - waiting for fonts to load...
  - fonts loaded
  - 690 pixels (ratio 0.01 of all image pixels) are different.
  - waiting 100ms before taking screenshot
  - taking page screenshot
    - disabled all CSS animations
  - waiting for fonts to load...
  - fonts loaded
  - captured a stable screenshot
  - 690 pixels (ratio 0.01 of all image pixels) are different.

```

# Page snapshot

```yaml
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
    - generic [ref=e93]:
      - generic [ref=e94]:
        - heading [level=1] [ref=e96]:
          - button [ref=e97] [cursor=pointer]:
            - text: All tasks
            - img "caret-down" [ref=e98]
        - generic [ref=e101]: Done 0 / 1·Open 1
        - generic [ref=e104]:
          - radiogroup "segmented control" [ref=e105]:
            - generic [ref=e106]:
              - generic [ref=e107] [cursor=pointer]:
                - radio "All 1" [checked]
                - generic [ref=e109]:
                  - text: All
                  - generic [ref=e110]: "1"
              - generic [ref=e111] [cursor=pointer]:
                - radio "Open 1"
                - generic [ref=e113]:
                  - text: Open
                  - generic [ref=e114]: "1"
              - generic [ref=e115] [cursor=pointer]:
                - radio "Ready 1"
                - generic [ref=e117]:
                  - text: Ready
                  - generic [ref=e118]: "1"
              - generic [ref=e119] [cursor=pointer]:
                - radio "Running 0"
                - generic [ref=e121]:
                  - text: Running
                  - generic [ref=e122]: "0"
              - generic [ref=e123] [cursor=pointer]:
                - radio "Failed 0"
                - generic [ref=e125]:
                  - text: Failed
                  - generic [ref=e126]: "0"
              - generic [ref=e127] [cursor=pointer]:
                - radio "Done 0"
                - generic [ref=e129]:
                  - text: Done
                  - generic [ref=e130]: "0"
          - generic [ref=e131]:
            - img "search" [ref=e133]
            - textbox "Search tasks" [ref=e136]
          - generic [ref=e138]:
            - generic [ref=e139]: O
            - text: Orbit baseline
      - generic [ref=e142]:
        - generic [ref=e143]:
          - checkbox [ref=e147] [cursor=pointer]
          - generic [ref=e148] [cursor=pointer]: Status
          - generic [ref=e149] [cursor=pointer]: Task
        - generic [ref=e150] [cursor=pointer]:
          - checkbox [ref=e154]
          - generic [ref=e155]: Open
          - generic "Review the visual baseline" [ref=e159]
          - generic:
            - button "Delete Review the visual baseline":
              - generic:
                - img "delete"
  - complementary [ref=e160]:
    - generic [ref=e161]:
      - generic [ref=e162]:
        - generic [ref=e163]: Review the visual baseline
        - generic [ref=e164]:
          - generic [ref=e165]: Open
          - generic [ref=e166]:
            - generic [ref=e167]: O
            - text: Orbit baseline
          - generic [ref=e169]: · Sep 27, 10:00 AM
        - generic [ref=e170]:
          - img "check" [ref=e171]
          - generic [ref=e174]: Judged by · submitted evidence
      - button "Run now" [ref=e177] [cursor=pointer]
      - button "Delete task" [ref=e184] [cursor=pointer]
      - button "More actions" [expanded] [ref=e190] [cursor=pointer]
      - menu "More actions" [active] [ref=e198]:
        - menuitem "Copy link" [ref=e199] [cursor=pointer]
        - menuitem "Share… Live link" [ref=e205] [cursor=pointer]:
          - generic [ref=e211]:
            - text: Share…
            - generic [ref=e212]: Live link
        - menuitem "Copy as Markdown" [ref=e213] [cursor=pointer]
      - button "Close" [ref=e221] [cursor=pointer]
    - generic [ref=e226]:
      - generic [ref=e227]:
        - generic [ref=e228]: Details
        - generic [ref=e229]:
          - generic [ref=e230]: Assignee
          - generic [ref=e231]:
            - generic [ref=e232]:
              - generic: Orbit baseline
              - combobox [ref=e233]
            - button "Clear selection" [ref=e234] [cursor=pointer]
          - textbox [aria-hidden] [ref=e238]: 2zwQZ2hd93IvLb59t6p1s
        - generic [ref=e239]:
          - generic [ref=e240]: Provider
          - generic [ref=e241]:
            - generic [ref=e242]:
              - generic: Codex
              - combobox [ref=e243]
            - button "Clear selection" [ref=e244] [cursor=pointer]
          - textbox [aria-hidden] [ref=e248]: codex
        - generic [ref=e249]:
          - generic [ref=e250]: Model
          - generic [ref=e251]:
            - generic [ref=e252]:
              - generic [aria-hidden]: Provider default
              - combobox [ref=e253]
            - button "Show options" [ref=e254] [cursor=pointer]
          - textbox [aria-hidden] [ref=e258]
        - generic [ref=e259]:
          - generic [ref=e260]: List
          - generic [ref=e261]:
            - generic [ref=e262]:
              - generic [aria-hidden]: No list
              - combobox [ref=e263]
            - button "Show options" [ref=e264] [cursor=pointer]
          - textbox [aria-hidden] [ref=e268]
        - generic [ref=e269]:
          - generic [ref=e270]: Start at
          - generic [ref=e271]:
            - textbox "Start at" [ref=e272]
            - button "Save schedule" [disabled] [ref=e274]
            - generic [ref=e275]: Optional, in your own time zone. The task starts once, at that time.
        - generic [ref=e276]:
          - generic [ref=e277]: Created by
          - generic [ref=e278]: —
        - generic [ref=e279]:
          - generic [ref=e280]: Created
          - generic [ref=e281]: Sep 27, 10:00 AM
      - generic [ref=e282]:
        - generic [ref=e283]: Dependencies
        - generic [ref=e285]: No dependencies
        - generic [ref=e286]:
          - generic [ref=e287]:
            - generic [aria-hidden]: Add a prerequisite…
            - combobox [ref=e288]
          - button "Show options" [ref=e289] [cursor=pointer]
        - textbox [aria-hidden] [ref=e293]
      - generic [ref=e294]:
        - generic [ref=e295]: Description
        - generic [ref=e297]:
          - paragraph [ref=e298]:
            - text: Keep the existing
            - strong [ref=e299]: Orbit appearance
            - text: and business interactions.
          - paragraph [ref=e300]: Check light and dark themes, keyboard focus, and narrow screens.
      - generic [ref=e301]:
        - generic [ref=e302]: Acceptance
        - generic [ref=e303]:
          - generic [ref=e304]: Acceptance criteria
          - button "Edit" [ref=e305] [cursor=pointer]
        - paragraph [ref=e309]: The representative pages retain their layout and keyboard behavior.
        - generic [ref=e310]: Automatic judgement
        - generic [ref=e312]: Not set — a person decides when this task is done.
        - generic [ref=e313]: Filled in as a pair, the task is judged by running this command and reading its exit code — nobody has to decide by hand.
      - generic [ref=e314]:
        - generic [ref=e315]: Inputs (0)
        - generic [ref=e316]: Files every run of this task is given — design mocks, specs. Each run gets its own copy.
        - button "Add file" [ref=e318] [cursor=pointer]
      - generic [ref=e324]:
        - generic [ref=e325]: Attribution
        - generic [ref=e329]:
          - generic [ref=e330]:
            - generic [ref=e331]: Counts towards
            - generic [ref=e332]: This task is filed under no project.
          - generic [ref=e333]:
            - generic [ref=e334]: Noticed in
            - generic [ref=e335]: Nothing was recorded about where this work was noticed.
          - generic [ref=e336]:
            - generic [ref=e337]: Crossing
            - generic [ref=e338]: No declared crossing touches this task.
          - generic [ref=e339]:
            - generic [ref=e340]: Blocked by
            - generic [ref=e341]: Nothing is blocking where this work counts.
      - region "Followed by" [ref=e342]:
        - generic [ref=e343]:
          - generic [ref=e344]: Followed by (0)
          - button "eye Follow task" [ref=e345] [cursor=pointer]:
            - img "eye" [ref=e347]
            - generic [ref=e350]: Follow task
        - generic [ref=e351]: Nothing is watching this task.
      - generic [ref=e352]:
        - generic [ref=e353]: Runs (0)
        - generic [ref=e354]: No runs yet
      - generic [ref=e355]:
        - generic [ref=e356]: Comments (1)
        - generic [ref=e357]:
          - generic [ref=e358]: B
          - generic [ref=e360]:
            - generic [ref=e361]:
              - generic [ref=e362]: Baseline Reviewer
              - generic [ref=e363]: Sep 27, 10:00 AM
            - paragraph [ref=e365]: Capture the current interface before the first component migration.
    - generic [ref=e366]:
      - textbox "Add a comment… type @ to mention a workspace (⌘/Ctrl + Enter to send)" [ref=e367]:
        - /placeholder: Add a comment…  type @ to mention a workspace  (⌘/Ctrl + Enter to send)
      - button "Send" [disabled] [ref=e368]
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