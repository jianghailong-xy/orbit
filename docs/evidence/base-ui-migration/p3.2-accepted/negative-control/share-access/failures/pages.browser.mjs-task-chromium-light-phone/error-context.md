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

  426 pixels (ratio 0.01 of all image pixels) are different.

  Snapshot: task-share-dialog.png

Call log:
  - Expect "toHaveScreenshot(task-share-dialog.png)" with timeout 15000ms
    - verifying given screenshot expectation
  - taking page screenshot
    - disabled all CSS animations
  - waiting for fonts to load...
  - fonts loaded
  - 426 pixels (ratio 0.01 of all image pixels) are different.
  - waiting 100ms before taking screenshot
  - taking page screenshot
    - disabled all CSS animations
  - waiting for fonts to load...
  - fonts loaded
  - captured a stable screenshot
  - 426 pixels (ratio 0.01 of all image pixels) are different.

```

# Page snapshot

```yaml
- generic [ref=e1]:
  - generic [ref=e4]:
    - banner [aria-hidden] [ref=e5]:
      - button [ref=e6] [cursor=pointer]
      - generic [ref=e10]: Orbit
    - complementary [ref=e11]:
      - generic [ref=e20]: Orbit
      - generic [ref=e21]:
        - generic [aria-hidden] [ref=e22]:
          - link [ref=e23] [cursor=pointer]:
            - generic [ref=e30]: Projects
          - link [ref=e31] [cursor=pointer]:
            - generic [ref=e37]: Tasks
          - link [ref=e38] [cursor=pointer]:
            - generic [ref=e42]: Wiki
          - link [ref=e43] [cursor=pointer]:
            - generic [ref=e48]: Runners
          - link [ref=e49] [cursor=pointer]:
            - generic [ref=e53]: Providers
        - generic [ref=e55]:
          - generic [aria-hidden] [ref=e56] [cursor=pointer]:
            - generic [ref=e57]: Workspaces
            - generic [ref=e58]: "1"
            - button [ref=e62]: Edit
          - generic [ref=e68] [cursor=pointer]:
            - generic [ref=e69]: Orbit baseline
            - generic [aria-hidden] [ref=e70]: ·
            - generic [ref=e71]: Baseline runner
          - status [ref=e72]
        - generic [aria-hidden] [ref=e74]:
          - generic [ref=e75] [cursor=pointer]:
            - generic [ref=e76]: Projects
            - generic [ref=e77]: "1"
          - generic [ref=e81] [cursor=pointer]: Orbit UI migration
      - button [ref=e86] [cursor=pointer]:
        - generic [ref=e91]: Baseline Reviewer
    - main [aria-hidden] [ref=e92]:
      - generic [ref=e93]:
        - generic [ref=e94]:
          - heading [level=1] [ref=e96]:
            - button [ref=e97] [cursor=pointer]: All tasks
          - generic [ref=e101]: Done 0 / 1·Open 1
          - generic [ref=e104]:
            - radiogroup [ref=e105]:
              - generic [ref=e106]:
                - generic [ref=e109] [cursor=pointer]:
                  - text: All
                  - generic [ref=e110]: "1"
                - generic [ref=e113] [cursor=pointer]:
                  - text: Open
                  - generic [ref=e114]: "1"
                - generic [ref=e117] [cursor=pointer]:
                  - text: Ready
                  - generic [ref=e118]: "1"
                - generic [ref=e121] [cursor=pointer]:
                  - text: Running
                  - generic [ref=e122]: "0"
                - generic [ref=e125] [cursor=pointer]:
                  - text: Failed
                  - generic [ref=e126]: "0"
                - generic [ref=e129] [cursor=pointer]:
                  - text: Done
                  - generic [ref=e130]: "0"
            - textbox [ref=e136]:
              - /placeholder: Search tasks
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
            - generic [ref=e158]: Review the visual baseline
            - generic:
              - button
    - complementary [aria-hidden] [ref=e160]:
      - generic [ref=e161]:
        - generic [ref=e162]:
          - generic [ref=e163]: Review the visual baseline
          - generic [ref=e164]:
            - generic [ref=e165]: Open
            - generic [ref=e166]:
              - generic [ref=e167]: O
              - text: Orbit baseline
            - generic [ref=e169]: · Sep 27, 10:00 AM
          - generic [ref=e170]: Judged by · submitted evidence
        - button [ref=e177] [cursor=pointer]:
          - generic [ref=e183]: Run now
        - button [ref=e184] [cursor=pointer]
        - button [ref=e189] [cursor=pointer]
        - button [ref=e194] [cursor=pointer]
      - generic [ref=e199]:
        - generic [ref=e200]:
          - generic [ref=e201]: Details
          - generic [ref=e202]:
            - generic [ref=e203]: Assignee
            - generic [ref=e204]:
              - generic [ref=e205]:
                - generic: Orbit baseline
                - combobox [ref=e206]
              - button [ref=e207] [cursor=pointer]
            - textbox [aria-hidden] [ref=e211]: 2zwQZ2hd93IvLb59t6p1s
          - generic [ref=e212]:
            - generic [ref=e213]: Provider
            - generic [ref=e214]:
              - generic [ref=e215]:
                - generic: Codex
                - combobox [ref=e216]
              - button [ref=e217] [cursor=pointer]
            - textbox [aria-hidden] [ref=e221]: codex
          - generic [ref=e222]:
            - generic [ref=e223]: Model
            - generic [ref=e224]:
              - generic [ref=e225]:
                - generic [aria-hidden]: Provider default
                - combobox [ref=e226]
              - button [ref=e227] [cursor=pointer]
            - textbox [aria-hidden] [ref=e231]
          - generic [ref=e232]:
            - generic [ref=e233]: List
            - generic [ref=e234]:
              - generic [ref=e235]:
                - generic [aria-hidden]: No list
                - combobox [ref=e236]
              - button [ref=e237] [cursor=pointer]
            - textbox [aria-hidden] [ref=e241]
          - generic [ref=e242]:
            - generic [ref=e243]: Start at
            - generic [ref=e244]:
              - textbox [ref=e245]
              - button [disabled] [ref=e247]:
                - generic: Save schedule
              - generic [ref=e248]: Optional, in your own time zone. The task starts once, at that time.
          - generic [ref=e249]:
            - generic [ref=e250]: Created by
            - generic [ref=e251]: —
          - generic [ref=e252]:
            - generic [ref=e253]: Created
            - generic [ref=e254]: Sep 27, 10:00 AM
        - generic [ref=e255]:
          - generic [ref=e256]: Dependencies
          - generic [ref=e258]: No dependencies
          - generic [ref=e259]:
            - generic [ref=e260]:
              - generic [aria-hidden]: Add a prerequisite…
              - combobox [ref=e261]
            - button [ref=e262] [cursor=pointer]
          - textbox [aria-hidden] [ref=e266]
        - generic [ref=e267]:
          - generic [ref=e268]: Description
          - generic [ref=e270]:
            - paragraph [ref=e271]:
              - text: Keep the existing
              - strong [ref=e272]: Orbit appearance
              - text: and business interactions.
            - paragraph [ref=e273]: Check light and dark themes, keyboard focus, and narrow screens.
        - generic [ref=e274]:
          - generic [ref=e275]: Acceptance
          - generic [ref=e276]:
            - generic [ref=e277]: Acceptance criteria
            - button [ref=e278] [cursor=pointer]:
              - generic [ref=e279]: Edit
          - paragraph [ref=e282]: The representative pages retain their layout and keyboard behavior.
          - generic [ref=e283]: Automatic judgement
          - generic [ref=e285]: Not set — a person decides when this task is done.
          - generic [ref=e286]: Filled in as a pair, the task is judged by running this command and reading its exit code — nobody has to decide by hand.
        - generic [ref=e287]:
          - generic [ref=e288]: Inputs (0)
          - generic [ref=e289]: Files every run of this task is given — design mocks, specs. Each run gets its own copy.
          - button [ref=e291] [cursor=pointer]:
            - generic [ref=e296]: Add file
        - generic [ref=e297]:
          - generic [ref=e298]: Attribution
          - generic [ref=e302]:
            - generic [ref=e303]:
              - generic [ref=e304]: Counts towards
              - generic [ref=e305]: This task is filed under no project.
            - generic [ref=e306]:
              - generic [ref=e307]: Noticed in
              - generic [ref=e308]: Nothing was recorded about where this work was noticed.
            - generic [ref=e309]:
              - generic [ref=e310]: Crossing
              - generic [ref=e311]: No declared crossing touches this task.
            - generic [ref=e312]:
              - generic [ref=e313]: Blocked by
              - generic [ref=e314]: Nothing is blocking where this work counts.
        - region [ref=e315]:
          - generic [ref=e316]:
            - generic [ref=e317]: Followed by (0)
            - button [ref=e318] [cursor=pointer]:
              - generic [ref=e323]: Follow task
          - generic [ref=e324]: Nothing is watching this task.
        - generic [ref=e325]:
          - generic [ref=e326]: Runs (0)
          - generic [ref=e327]: No runs yet
        - generic [ref=e328]:
          - generic [ref=e329]: Comments (1)
          - generic [ref=e330]:
            - generic [ref=e331]: B
            - generic [ref=e333]:
              - generic [ref=e334]:
                - generic [ref=e335]: Baseline Reviewer
                - generic [ref=e336]: Sep 27, 10:00 AM
              - paragraph [ref=e338]: Capture the current interface before the first component migration.
      - generic [ref=e339]:
        - textbox [ref=e340]:
          - /placeholder: Add a comment…  type @ to mention a workspace  (⌘/Ctrl + Enter to send)
        - button [disabled] [ref=e341]:
          - generic [ref=e342]: Send
  - dialog [ref=e346]:
    - generic [ref=e347]:
      - button "Close" [active] [ref=e348] [cursor=pointer]
      - heading "Share task" [level=2] [ref=e352]
    - generic [ref=e353]:
      - generic [ref=e359]:
        - button "Access" [ref=e360] [cursor=pointer]:
          - text: Anyone with the link
          - img "down" [ref=e361]
        - generic [ref=e364]: Anyone with the link can view — no sign-in. They can’t change anything.
      - generic [ref=e365]:
        - textbox "Public link" [ref=e366]: http://127.0.0.1:4173/s/uiMigrationBaselineTask20260928
        - button "Copy" [ref=e367] [cursor=pointer]
      - generic [ref=e373]: Includes
      - generic [ref=e374]:
        - generic [ref=e375]:
          - generic [ref=e376]:
            - checkbox "Overview Description, acceptance, dependencies and runs" [checked] [disabled] [ref=e377]
            - checkbox [checked] [disabled] [aria-hidden] [ref=e378]
            - generic [ref=e379]:
              - generic [ref=e380]: Overview
              - generic [ref=e381]: Description, acceptance, dependencies and runs
          - generic [ref=e382]: Always
        - generic [ref=e383]:
          - generic [ref=e384] [cursor=pointer]:
            - checkbox "Comments & files Written by agents and people" [checked] [ref=e385]
            - checkbox [checked] [aria-hidden] [ref=e386]
            - generic [ref=e387]:
              - generic [ref=e388]: Comments & files
              - generic [ref=e389]: Written by agents and people
          - generic [ref=e390]: 1 comment
        - generic [ref=e391]:
          - generic [ref=e392] [cursor=pointer]:
            - checkbox "Conversations Can include command output and file contents." [ref=e393]
            - checkbox [aria-hidden] [ref=e394]
            - generic [ref=e395]:
              - generic [ref=e396]: Conversations
              - generic [ref=e397]: Can include command output and file contents.
          - generic [ref=e398]: 0 transcripts
      - generic [ref=e399]:
        - generic [ref=e400]: Updates
        - generic [ref=e401]: Live — viewers see changes as they happen
      - generic [ref=e403]:
        - generic [ref=e404]: Expires
        - combobox "Expires" [ref=e406] [cursor=pointer]:
          - generic [ref=e407]: Never
        - textbox [aria-hidden] [ref=e411]: never
      - generic [ref=e412]:
        - generic [ref=e413]: Viewed 7 times · last 1d 2h ago
        - link "Preview ↗" [ref=e414] [cursor=pointer]:
          - /url: http://127.0.0.1:4173/s/uiMigrationBaselineTask20260928?preview=1
        - button "Done" [ref=e416] [cursor=pointer]
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