# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: performance.browser.mjs >> record browser performance baseline
- Location: ui-migration/performance.browser.mjs:16:1

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: getByRole('menu').filter({ has: getByRole('menuitem', { name: 'File', exact: true }) })
Expected: visible
Timeout: 15000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" getByRole('menu').filter({ has: getByRole('menuitem', { name: 'File', exact: true }) }) with timeout 15000ms
  - waiting for getByRole('menu').filter({ has: getByRole('menuitem', { name: 'File', exact: true }) })

```

```yaml
- complementary:
  - img
  - text: Orbit
  - button "Collapse sidebar":
    - img "menu-fold"
  - link "Projects Ctrl P"
  - link "Tasks"
  - link "Wiki"
  - link "Runners"
  - link "Providers"
  - text: Workspaces 1
  - img "caret-down"
  - button "Edit"
  - text: Orbit baseline Baseline runner Ctrl 1
  - status
  - text: Projects 1
  - img "caret-down"
  - text: Orbit UI migration
  - button "Account menu, Baseline Reviewer":
    - img "user"
    - text: Baseline Reviewer
  - separator
- main:
  - complementary:
    - text: Orbit baseline Open
    - img "down"
    - img "plus"
    - text: New session
    - button "search Search sessions Ctrl K":
      - img "search"
      - text: Search sessions Ctrl K
    - text: Today
    - img "message"
    - text: Review the component migration just now Waiting for your reply
    - button "More actions":
      - img "ellipsis"
  - separator
  - text: Review the component migration
  - button "Follow"
  - text: Waiting for your reply · Open · just now
  - button "more":
    - img "more"
  - paragraph: Keep the current appearance and keyboard behavior. 请保留现有外观与键盘交互。
  - button "Copy message":
    - img "copy"
  - text: just now
  - paragraph:
    - text: I will verify the
    - strong: existing interface
    - text: before changing components.
  - list:
    - listitem: Light and dark themes
    - listitem: Desktop and phone layouts
    - listitem: Input focus and attachments
  - paragraph:
    - code: npm run test:ui-migration -w @orbit/web
  - textbox "Reply…": Review the migration baseline 1
  - button "Add attachment":
    - img "plus"
  - text: Default
  - combobox
  - button "Model claude-opus-5, effort Default": claude-opus-5 Default
  - text: —
  - button "Send":
    - img "arrow-up"
- menu:
  - menuitem "paper-clip File":
    - img "paper-clip"
    - text: File
  - menuitem "picture Image":
    - img "picture"
    - text: Image
  - separator
  - menuitem "code Shell":
    - img "code"
    - text: Shell
  - menuitem "thunderbolt Skill":
    - img "thunderbolt"
    - text: Skill
  - menuitem "Command"
```

# Test source

```ts
  12  |     median: ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2,
  13  |     p95: ordered[Math.ceil(ordered.length * 0.95) - 1] };
  14  | }
  15  | 
  16  | test('record browser performance baseline', async ({ browser }, testInfo) => {
  17  |   test.skip(testInfo.project.name !== 'chromium-light-desktop', 'Performance samples use one fixed browser/theme/viewport.');
  18  |   const report = {
  19  |     project: testInfo.project.name, browser: browser.version(), node: process.version,
  20  |     fixedDate: FIXED_NOW, observedAt: new Date().toISOString(),
  21  |     platform: `${os.platform()} ${os.release()} ${os.arch()}`, hostStart: host(),
  22  |     methodology: {
  23  |       loads: 'Five fresh browser contexts per route; routing disables HTTP cache. Browser process, OS file cache and local preview server are shared. Ready means visible route content, fonts ready and two animation frames.',
  24  |       operations: 'Ten sequential samples per operation after session ready. Browser and host intervals include Playwright command transport, actionability checks and two animation frames; these are observed end-to-end intervals, not isolated React render times.',
  25  |       clock: 'Date is fixed with page.clock.setFixedTime; performance.now, navigation timing and animation frames remain real.',
  26  |       percentile: 'p95 is nearest rank; median averages the middle pair for even sample counts.',
  27  |       scope: 'Local production preview with deterministic REST/SSE fixtures; no backend/network latency, CPU throttling or pass/fail performance threshold.',
  28  |     },
  29  |     loads: {}, operations: {},
  30  |   };
  31  |   const { baseURL, viewport, deviceScaleFactor, locale, timezoneId, reducedMotion, serviceWorkers } = testInfo.project.use;
  32  |   async function freshPage() {
  33  |     const context = await browser.newContext({ baseURL, viewport, deviceScaleFactor, locale, timezoneId, reducedMotion, serviceWorkers, colorScheme: 'light' });
  34  |     const page = await context.newPage();
  35  |     await page.clock.setFixedTime(new Date(FIXED_NOW));
  36  |     const api = await installFixtures(page, { theme: 'light' });
  37  |     const pageErrors = [];
  38  |     page.on('pageerror', (error) => pageErrors.push(error.message));
  39  |     return { context, page, verify: () => { api.assertHandled(); expect(pageErrors).toEqual([]); } };
  40  |   }
  41  |   const ready = {
  42  |     task: async (page) => {
  43  |       await expect(page.getByText('Review the visual baseline', { exact: true }).last()).toBeVisible();
  44  |       await expect(page.getByRole('button', { name: 'More actions', exact: true })).toBeVisible();
  45  |     },
  46  |     project: async (page) => {
  47  |       await expect(page.getByRole('heading', { name: 'Orbit UI migration', exact: true })).toBeVisible();
  48  |       await expect(page.getByTestId('project-dependency-graph')).toBeVisible();
  49  |       await expect(page.locator('.pdg-task-title')).toHaveCount(3);
  50  |     },
  51  |     session: async (page) => {
  52  |       await expect(page.locator('.composer-field textarea')).toBeVisible();
  53  |       await expect(page.locator('.composer-field textarea')).toBeEnabled();
  54  |       await expect(page.getByText('existing interface', { exact: true })).toBeVisible();
  55  |     },
  56  |   };
  57  |   try {
  58  |     for (const route of ['task', 'project', 'session']) {
  59  |       const samples = [];
  60  |       for (let iteration = 1; iteration <= 5; iteration++) {
  61  |         const { context, page, verify } = await freshPage();
  62  |         try {
  63  |           const hostBefore = host();
  64  |           const start = performance.now();
  65  |           await page.goto(PATHS[route]);
  66  |           await ready[route](page);
  67  |           await page.evaluate(() => document.fonts.ready);
  68  |           await frames(page);
  69  |           const hostReadyMs = performance.now() - start;
  70  |           const timing = await page.evaluate(() => ({
  71  |             browserReadyMs: performance.now(),
  72  |             navigation: performance.getEntriesByType('navigation').map((entry) => entry.toJSON()),
  73  |             paint: performance.getEntriesByType('paint').map((entry) => entry.toJSON()),
  74  |             viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio, scale: visualViewport?.scale },
  75  |           }));
  76  |           verify();
  77  |           samples.push({ iteration, hostBefore, hostReadyMs, ...timing });
  78  |         } finally { await context.close(); }
  79  |       }
  80  |       report.loads[route] = { path: PATHS[route], samples,
  81  |         hostReadyMs: statistics(samples.map((sample) => sample.hostReadyMs)),
  82  |         browserReadyMs: statistics(samples.map((sample) => sample.browserReadyMs)) };
  83  |     }
  84  |     const { context, page, verify } = await freshPage();
  85  |     try {
  86  |       await page.goto(PATHS.session);
  87  |       await ready.session(page);
  88  |       await page.evaluate(() => document.fonts.ready);
  89  |       await frames(page);
  90  |       const composer = page.locator('.composer-field textarea');
  91  |       const attach = page.getByRole('button', { name: 'Add attachment', exact: true });
  92  |       const menu = page.getByRole('menu').filter({ has: page.getByRole('menuitem', { name: 'File', exact: true }) });
  93  |       async function measure(name, operation) {
  94  |         const samples = report.operations[name] ??= { samples: [] };
  95  |         const hostBefore = host();
  96  |         const browserStart = await page.evaluate(() => performance.now());
  97  |         const start = performance.now();
  98  |         await operation();
  99  |         await frames(page);
  100 |         const browserMs = await page.evaluate((before) => performance.now() - before, browserStart);
  101 |         samples.samples.push({ iteration: samples.samples.length + 1, browserMs, hostMs: performance.now() - start, hostBefore });
  102 |       }
  103 |       for (let iteration = 1; iteration <= 10; iteration++) {
  104 |         await measure('composer-fill', async () => {
  105 |           const value = `Review the migration baseline ${iteration}`;
  106 |           await composer.fill(value);
  107 |           await expect(composer).toHaveValue(value);
  108 |           await expect(composer).toBeFocused();
  109 |         });
  110 |         await measure('attachment-menu-open', async () => {
  111 |           await attach.click();
> 112 |           await expect(menu).toBeVisible();
      |                              ^ Error: expect(locator).toBeVisible() failed
  113 |         });
  114 |         await measure('attachment-menu-close', async () => {
  115 |           await composer.click();
  116 |           await expect(menu).toBeHidden();
  117 |           await expect(composer).toBeFocused();
  118 |         });
  119 |       }
  120 |       verify();
  121 |       for (const operation of Object.values(report.operations)) {
  122 |         operation.browserMs = statistics(operation.samples.map((sample) => sample.browserMs));
  123 |         operation.hostMs = statistics(operation.samples.map((sample) => sample.hostMs));
  124 |       }
  125 |     } finally { await context.close(); }
  126 |   } finally {
  127 |     report.hostEnd = host();
  128 |     const path = testInfo.outputPath('performance.json');
  129 |     writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
  130 |     await testInfo.attach('browser-performance-samples', { path, contentType: 'application/json' });
  131 |   }
  132 | });
  133 | 
```