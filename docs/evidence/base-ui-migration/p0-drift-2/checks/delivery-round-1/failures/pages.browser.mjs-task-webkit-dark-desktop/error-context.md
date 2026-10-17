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

  706 pixels (ratio 0.01 of all image pixels) are different.

  Snapshot: task-share-dialog.png

Call log:
  - Expect "toHaveScreenshot(task-share-dialog.png)" with timeout 15000ms
    - verifying given screenshot expectation
  - taking page screenshot
    - disabled all CSS animations
  - waiting for fonts to load...
  - fonts loaded
  - 706 pixels (ratio 0.01 of all image pixels) are different.
  - waiting 100ms before taking screenshot
  - taking page screenshot
    - disabled all CSS animations
  - waiting for fonts to load...
  - fonts loaded
  - captured a stable screenshot
  - 706 pixels (ratio 0.01 of all image pixels) are different.

```

# Page snapshot

```yaml
- generic [ref=e1]:
  - generic [ref=e4]:
    - complementary [ref=e5]:
      - generic [aria-hidden] [ref=e6]:
        - generic [ref=e14]: Orbit
        - button [ref=e15] [cursor=pointer]
      - generic [ref=e19]:
        - generic [aria-hidden] [ref=e20]:
          - link [ref=e21] [cursor=pointer]:
            - generic [ref=e28]: Projects
            - generic [ref=e29]: Ctrl P
          - link [ref=e30] [cursor=pointer]:
            - generic [ref=e36]: Tasks
          - link [ref=e37] [cursor=pointer]:
            - generic [ref=e41]: Wiki
          - link [ref=e42] [cursor=pointer]:
            - generic [ref=e47]: Runners
          - link [ref=e48] [cursor=pointer]:
            - generic [ref=e52]: Providers
        - generic [ref=e54]:
          - generic [aria-hidden] [ref=e55] [cursor=pointer]:
            - generic [ref=e56]: Workspaces
            - generic [ref=e57]: "1"
            - button [ref=e61]: Edit
          - generic [aria-hidden] [ref=e62] [cursor=pointer]:
            - generic [ref=e67]:
              - generic [ref=e68]: Orbit baseline
              - generic [aria-hidden] [ref=e69]: ·
              - generic [ref=e70]: Baseline runner
            - generic [ref=e71]: Ctrl 1
          - status [ref=e72]
        - generic [aria-hidden] [ref=e74]:
          - generic [ref=e75] [cursor=pointer]:
            - generic [ref=e76]: Projects
            - generic [ref=e77]: "1"
          - generic [ref=e81] [cursor=pointer]: Orbit UI migration
      - button [ref=e86] [cursor=pointer]:
        - generic [ref=e91]: Baseline Reviewer
      - separator [aria-hidden] [ref=e92]
    - main [aria-hidden] [ref=e93]:
      - generic [ref=e94]:
        - generic [ref=e95]:
          - heading [level=1] [ref=e97]:
            - button [ref=e98] [cursor=pointer]: All tasks
          - generic [ref=e102]: Done 0 / 1·Open 1
          - generic [ref=e105]:
            - radiogroup [ref=e106]:
              - generic [ref=e107]:
                - generic [ref=e110] [cursor=pointer]:
                  - text: All
                  - generic [ref=e111]: "1"
                - generic [ref=e114] [cursor=pointer]:
                  - text: Open
                  - generic [ref=e115]: "1"
                - generic [ref=e118] [cursor=pointer]:
                  - text: Ready
                  - generic [ref=e119]: "1"
                - generic [ref=e122] [cursor=pointer]:
                  - text: Running
                  - generic [ref=e123]: "0"
                - generic [ref=e126] [cursor=pointer]:
                  - text: Failed
                  - generic [ref=e127]: "0"
                - generic [ref=e130] [cursor=pointer]:
                  - text: Done
                  - generic [ref=e131]: "0"
            - textbox [ref=e137]:
              - /placeholder: Search tasks
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
            - generic [ref=e159]: Review the visual baseline
            - generic:
              - button
    - complementary [aria-hidden] [ref=e161]:
      - generic [ref=e163]:
        - generic [ref=e164]:
          - generic [ref=e165]: Review the visual baseline
          - generic [ref=e166]:
            - generic [ref=e167]: Open
            - generic [ref=e168]:
              - generic [ref=e169]: O
              - text: Orbit baseline
            - generic [ref=e171]: · Sep 27, 10:00 AM
          - generic [ref=e172]: Judged by · submitted evidence
        - button [ref=e179] [cursor=pointer]:
          - generic [ref=e185]: Run now
        - button [ref=e186] [cursor=pointer]
        - button [ref=e191] [cursor=pointer]
        - button [ref=e196] [cursor=pointer]
      - generic [ref=e201]:
        - generic [ref=e202]:
          - generic [ref=e203]: Details
          - generic [ref=e204]:
            - generic [ref=e205]: Assignee
            - generic [ref=e206]:
              - generic [ref=e207]:
                - generic: Orbit baseline
                - combobox [ref=e208]
              - button [ref=e209] [cursor=pointer]
              - button [ref=e213] [cursor=pointer]
            - textbox [aria-hidden] [ref=e217]: 2zwQZ2hd93IvLb59t6p1s
          - generic [ref=e218]:
            - generic [ref=e219]: Provider
            - generic [ref=e220]:
              - generic [ref=e221]:
                - generic: Codex
                - combobox [ref=e222]
              - button [ref=e223] [cursor=pointer]
              - button [ref=e227] [cursor=pointer]
            - textbox [aria-hidden] [ref=e231]: codex
          - generic [ref=e232]:
            - generic [ref=e233]: Model
            - generic [ref=e234]:
              - generic [ref=e235]:
                - generic [aria-hidden]: Provider default
                - combobox [ref=e236]
              - button [ref=e237] [cursor=pointer]
            - textbox [aria-hidden] [ref=e241]
          - generic [ref=e242]:
            - generic [ref=e243]: List
            - generic [ref=e244]:
              - generic [ref=e245]:
                - generic [aria-hidden]: No list
                - combobox [ref=e246]
              - button [ref=e247] [cursor=pointer]
            - textbox [aria-hidden] [ref=e251]
          - generic [ref=e252]:
            - generic [ref=e253]: Start at
            - generic [ref=e254]:
              - textbox [ref=e255]
              - button [disabled] [ref=e257]:
                - generic: Save schedule
              - generic [ref=e258]: Optional, in your own time zone. The task starts once, at that time.
          - generic [ref=e259]:
            - generic [ref=e260]: Created by
            - generic [ref=e261]: —
          - generic [ref=e262]:
            - generic [ref=e263]: Created
            - generic [ref=e264]: Sep 27, 10:00 AM
        - generic [ref=e265]:
          - generic [ref=e266]: Dependencies
          - generic [ref=e268]: No dependencies
          - generic [ref=e269]:
            - generic [ref=e270]:
              - generic [aria-hidden]: Add a prerequisite…
              - combobox [ref=e271]
            - button [ref=e272] [cursor=pointer]
          - textbox [aria-hidden] [ref=e276]
        - generic [ref=e277]:
          - generic [ref=e278]: Description
          - generic [ref=e280]:
            - paragraph [ref=e281]:
              - text: Keep the existing
              - strong [ref=e282]: Orbit appearance
              - text: and business interactions.
            - paragraph [ref=e283]: Check light and dark themes, keyboard focus, and narrow screens.
        - generic [ref=e284]:
          - generic [ref=e285]: Acceptance
          - generic [ref=e286]:
            - generic [ref=e287]: Acceptance criteria
            - button [ref=e288] [cursor=pointer]:
              - generic [ref=e289]: Edit
          - paragraph [ref=e292]: The representative pages retain their layout and keyboard behavior.
          - generic [ref=e293]: Automatic judgement
          - generic [ref=e295]: Not set — a person decides when this task is done.
          - generic [ref=e296]: Filled in as a pair, the task is judged by running this command and reading its exit code — nobody has to decide by hand.
        - generic [ref=e297]:
          - generic [ref=e298]: Inputs (0)
          - generic [ref=e299]: Files every run of this task is given — design mocks, specs. Each run gets its own copy.
          - button [ref=e301] [cursor=pointer]:
            - generic [ref=e306]: Add file
        - generic [ref=e307]:
          - generic [ref=e308]: Attribution
          - generic [ref=e312]:
            - generic [ref=e313]:
              - generic [ref=e314]: Counts towards
              - generic [ref=e315]: This task is filed under no project.
            - generic [ref=e316]:
              - generic [ref=e317]: Noticed in
              - generic [ref=e318]: Nothing was recorded about where this work was noticed.
            - generic [ref=e319]:
              - generic [ref=e320]: Crossing
              - generic [ref=e321]: No declared crossing touches this task.
            - generic [ref=e322]:
              - generic [ref=e323]: Blocked by
              - generic [ref=e324]: Nothing is blocking where this work counts.
        - region [ref=e325]:
          - generic [ref=e326]:
            - generic [ref=e327]: Followed by (0)
            - button [ref=e328] [cursor=pointer]:
              - generic [ref=e333]: Follow task
          - generic [ref=e334]: Nothing is watching this task.
        - generic [ref=e335]:
          - generic [ref=e336]: Runs (0)
          - generic [ref=e337]: No runs yet
        - generic [ref=e338]:
          - generic [ref=e339]: Comments (1)
          - generic [ref=e340]:
            - generic [ref=e341]: B
            - generic [ref=e343]:
              - generic [ref=e344]:
                - generic [ref=e345]: Baseline Reviewer
                - generic [ref=e346]: Sep 27, 10:00 AM
              - paragraph [ref=e348]: Capture the current interface before the first component migration.
      - generic [ref=e349]:
        - textbox [ref=e350]:
          - /placeholder: Add a comment…  type @ to mention a workspace  (⌘/Ctrl + Enter to send)
        - button [disabled] [ref=e351]:
          - generic [ref=e352]: Send
  - dialog [ref=e356]:
    - generic [ref=e357]:
      - button "Close" [active] [ref=e358] [cursor=pointer]
      - heading "Share task" [level=2] [ref=e362]
    - generic [ref=e363]:
      - generic [ref=e369]:
        - button "Access" [ref=e370] [cursor=pointer]:
          - text: Anyone with the link
          - img "down" [ref=e371]
        - generic [ref=e374]: Anyone with the link can view — no sign-in. They can’t change anything.
      - generic [ref=e375]:
        - textbox "Public link" [ref=e376]: http://127.0.0.1:4173/s/uiMigrationBaselineTask20260928
        - button "Copy" [ref=e377] [cursor=pointer]
      - generic [ref=e383]: Includes
      - generic [ref=e384]:
        - generic [ref=e385]:
          - generic [ref=e386]:
            - checkbox "Overview Description, acceptance, dependencies and runs" [checked] [disabled] [ref=e387]
            - checkbox [checked] [disabled] [aria-hidden] [ref=e388]
            - generic [ref=e389]:
              - generic [ref=e390]: Overview
              - generic [ref=e391]: Description, acceptance, dependencies and runs
          - generic [ref=e392]: Always
        - generic [ref=e393]:
          - generic [ref=e394] [cursor=pointer]:
            - checkbox "Comments & files Written by agents and people" [checked] [ref=e395]
            - checkbox [checked] [aria-hidden] [ref=e396]
            - generic [ref=e397]:
              - generic [ref=e398]: Comments & files
              - generic [ref=e399]: Written by agents and people
          - generic [ref=e400]: 1 comment
        - generic [ref=e401]:
          - generic [ref=e402] [cursor=pointer]:
            - checkbox "Conversations Can include command output and file contents." [ref=e403]
            - checkbox [aria-hidden] [ref=e404]
            - generic [ref=e405]:
              - generic [ref=e406]: Conversations
              - generic [ref=e407]: Can include command output and file contents.
          - generic [ref=e408]: 0 transcripts
      - generic [ref=e409]:
        - generic [ref=e410]: Updates
        - generic [ref=e411]: Live — viewers see changes as they happen
      - generic [ref=e413]:
        - generic [ref=e414]: Expires
        - combobox "Expires" [ref=e416] [cursor=pointer]:
          - generic [ref=e417]: Never
        - textbox [aria-hidden] [ref=e421]: never
      - generic [ref=e422]:
        - generic [ref=e423]: Viewed 7 times · last 1d 2h ago
        - link "Preview ↗" [ref=e424] [cursor=pointer]:
          - /url: http://127.0.0.1:4173/s/uiMigrationBaselineTask20260928?preview=1
        - button "Done" [ref=e426] [cursor=pointer]
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