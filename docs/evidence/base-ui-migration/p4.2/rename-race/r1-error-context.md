# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: p42.browser.mjs >> P4.2 providers >> engines: an account menu, its remove question and the pause dialog
- Location: ui-migration/p42.browser.mjs:107:3

# Error details

```
Error: expect(locator).toBeFocused() failed

Locator: getByRole('textbox', { name: 'Rename Work' })
Expected: focused
Timeout: 15000ms
Error: element(s) not found

Call log:
  - Expect "toBeFocused" getByRole('textbox', { name: 'Rename Work' }) with timeout 15000ms
  - waiting for getByRole('textbox', { name: 'Rename Work' })

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
  - text: Workspaces 2
  - img "caret-down"
  - button "Edit"
  - text: orbit-web Studio Mac Ctrl 1 docs-site Studio Mac Ctrl 2
  - status
  - text: Projects 1
  - img "caret-down"
  - text: Orbit UI migration
  - button "Account menu, Baseline Reviewer":
    - img "user"
    - text: Baseline Reviewer
  - separator
- main:
  - heading "Providers" [level=1]
  - button "Add provider"
  - text: Where your workspaces' models come from — the CLIs signed in on your machines, and the API keys on your account.
  - heading "On your runners" [level=3]
  - text: Use subscriptions signed in on your machines. 3 runners · 5 signed in
  - button "Collapse Studio Mac" [expanded]: Studio Mac studio-mac.local · v0.1.230
  - link "Manage Studio Mac":
    - /url: /runners/2zwQZ2hd93IvLb59t6sDZ
    - text: Manage →
  - img
  - text: Claude Code 2.1.290 · checked 10m ago Available 5-hour limit 14% resets 15:00 Weekly · all models 62% resets Thu 12:00
  - button "Add account"
  - button "More actions"
  - button "Codex 0.160.0 · 2 of 2 accounts available · checked 10m ago" [expanded]:
    - img
    - text: Codex 0.160.0 · 2 of 2 accounts available · checked 10m ago
  - button "Add account"
  - text: Default NEXT ~/.codex · account a1b2c3… Available 5h limit 22% resets 14:00 Weekly limit 41% resets Fri 12:00
  - button "More actions"
  - text: Work ~/.orbit/codex-accounts/work · account d4e5f6… Available 5h limit 71% resets 13:00 Weekly limit 35% resets Sat 12:00
  - button "More actions"
  - img
  - text: Antigravity Not installed — Orbit can install it here Not installed —
  - button "Install"
  - link "Google terms":
    - /url: https://antigravity.google/terms
  - text: restrict personal account sign-in through third-party tools; your account may be suspended.
  - img
  - text: Kimi Code Not installed — Orbit can install it here Not installed —
  - button "Install"
  - button "Expand build-01": build-01 v0.1.230
  - text: 2 of 3 signed in
  - link "Manage build-01":
    - /url: /runners/2zwQZ2hd93IvLb59t6sDa
    - text: Manage →
  - button "Expand old-laptop": old-laptop v0.1.201
  - text: Offline 1 of 3 signed in
  - link "Manage old-laptop":
    - /url: /runners/2zwQZ2hd93IvLb59t6sDb
    - text: Manage →
  - heading "Account pools" [level=3]
  - text: Several accounts under one name.
  - button "New pool"
  - button "Team keys SHARED Zhang Min’s · 1 key you can run on" [expanded]:
    - img
    - text: Team keys SHARED Zhang Min’s · 1 key you can run on
  - link "Manage Team keys":
    - /url: /providers/pools/2zwQZ2hd93IvLb59t6vPn
    - text: Manage →
  - text: team-main NEXT Zhang Min · sk-…Q9WE Available Others $1.20 of $100
  - button "Claude accounts 1 of 2 accounts available" [expanded]:
    - img
    - text: Claude accounts 1 of 2 accounts available
  - text: "Next: Anthropic (Claude) Weekly 56%"
  - link "Manage Claude accounts":
    - /url: /providers/pools/2zwQZ2hd93IvLb59t6vPl
    - text: Manage →
  - img
  - text: Anthropic (Claude) NEXT Available Weekly · all models 56%
  - button "Pause…"
  - img
  - text: Claude Max (work) Spent · resets 13:30 5-hour limit 100%
  - button "Pause…"
  - button "My Codex SHARED 2 of 3 accounts available" [expanded]:
    - img
    - text: My Codex SHARED 2 of 3 accounts available
  - text: "Next for you: reviewer@example.test Weekly 58%"
  - link "Manage My Codex":
    - /url: /providers/pools/2zwQZ2hd93IvLb59t6vPm
    - text: Manage →
  - img
  - text: reviewer@example.test NEXT Baseline Reviewer · ChatGPT Plus · …9F3K ·
  - img "team"
  - text: Everyone here Available 5h limit 31% resets 14:00 Weekly limit 58% resets Fri 12:00
  - button "Pause…"
  - text: orbit-org you Baseline Reviewer · sk-…AB12 ·
  - img "team"
  - text: Everyone here Available Others $2.60 of $40
  - button "Pause…"
  - text: lin-proj Lin Wei · sk-…7K2P ·
  - img "team"
  - text: Everyone here Invalid Others $2.60
  - button "Pause…"
  - button "Replace key"
  - text: Rejected by OpenAI — replace it with a working key to put it back in the pool.
  - heading "Your API keys" [level=3]
  - text: On your account and usable from every runner — billed per token.
  - table:
    - rowgroup:
      - row "Provider Models Endpoint Enabled":
        - columnheader "Provider"
        - columnheader "Models"
        - columnheader "Endpoint"
        - columnheader "Enabled"
        - columnheader
    - rowgroup:
      - row "Anthropic (Claude) 3 https://api.anthropic.com Enabled Edit Delete":
        - cell "Anthropic (Claude)":
          - img
          - text: Anthropic (Claude)
        - cell "3"
        - cell "https://api.anthropic.com":
          - code: https://api.anthropic.com
        - cell "Enabled"
        - cell "Edit Delete":
          - button "Edit"
          - button "Delete"
      - row "Claude Max (work) 3 https://api.anthropic.com Enabled Edit Delete":
        - cell "Claude Max (work)":
          - img
          - text: Claude Max (work)
        - cell "3"
        - cell "https://api.anthropic.com":
          - code: https://api.anthropic.com
        - cell "Enabled"
        - cell "Edit Delete":
          - button "Edit"
          - button "Delete"
      - row "OpenAI (Codex) 2 https://api.openai.com/v1 Enabled Edit Delete":
        - cell "OpenAI (Codex)":
          - img
          - text: OpenAI (Codex)
        - cell "2"
        - cell "https://api.openai.com/v1":
          - code: https://api.openai.com/v1
        - cell "Enabled"
        - cell "Edit Delete":
          - button "Edit"
          - button "Delete"
      - row "L Lab gateway 1 https://gateway.example.test/anthropic Disabled Edit Delete":
        - cell "L Lab gateway"
        - cell "1"
        - cell "https://gateway.example.test/anthropic":
          - code: https://gateway.example.test/anthropic
        - cell "Disabled"
        - cell "Edit Delete":
          - button "Edit"
          - button "Delete"
  - heading "Connect another provider" [level=3]
  - link "Anthropic (Claude) Connected · 2 keys":
    - /url: /providers/new/anthropic
    - img
    - text: Anthropic (Claude) Connected · 2 keys
  - link "OpenAI (Codex) Connected":
    - /url: /providers/new/openai
    - img
    - text: OpenAI (Codex) Connected
  - link "Antigravity Runs on the Antigravity CLI":
    - /url: /providers/new/gemini
    - img
    - text: Antigravity Runs on the Antigravity CLI
  - link "DeepSeek Runs on Claude Code":
    - /url: /providers/new/deepseek
    - img
    - text: DeepSeek Runs on Claude Code
  - link "DeepSeek Harness Runs on DeepSeek Harness":
    - /url: /providers/new/deepseek-harness
    - img
    - text: DeepSeek Harness Runs on DeepSeek Harness
  - link "Kimi (Moonshot) Already signed in on build-01":
    - /url: /providers/new/moonshot
    - img
    - text: Kimi (Moonshot) Already signed in on build-01
  - link "Z.AI (GLM) Anthropic-compatible":
    - /url: /providers/new/glm
    - img
    - text: Z.AI (GLM) Anthropic-compatible
  - link "MiniMax Anthropic-compatible":
    - /url: /providers/new/minimax
    - img
    - text: MiniMax Anthropic-compatible
  - link "Qwen (Model Studio) Anthropic-compatible":
    - /url: /providers/new/qwen
    - img
    - text: Qwen (Model Studio) Anthropic-compatible
  - link "+ Custom Manual endpoint":
    - /url: /providers/new/custom
```

# Test source

```ts
  38  | const question = (page, title) => page.locator('[role="tooltip"], [role="dialog"], [role="alertdialog"]')
  39  |   .filter({ has: page.getByText(title, { exact: true }) }).filter({ visible: true }).last();
  40  | const dialog = (page, title) => page.locator('[role="dialog"], [role="alertdialog"]')
  41  |   .filter({ has: page.getByText(title, { exact: true }) }).filter({ visible: true }).last();
  42  | const notifications = (page) => page.getByRole('region', { name: 'Notifications', exact: true });
  43  | 
  44  | /** Wait out enter and leave animations (the replaced controls run theirs whatever motion is asked for),
  45  |  *  so an observation reads where a step ended up, not a frame of its transition. */
  46  | const settled = (page) => page.waitForFunction(
  47  |   () => document.getAnimations().every((animation) => animation.playState !== 'running' || animation.effect?.getTiming().iterations === Infinity),
  48  |   null, { timeout: 3000 },
  49  | ).catch(() => {});
  50  | 
  51  | async function observe(page, fixtures, step) {
  52  |   await settled(page);
  53  |   const state = await page.evaluate(() => {
  54  |     const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden' && Number(getComputedStyle(el).opacity) > 0; };
  55  |     const text = (ids) => (ids ?? '').split(/\s+/).filter(Boolean).map((id) => document.getElementById(id)?.textContent?.trim() ?? '').filter(Boolean).join(' | ');
  56  |     const name = (el) => el && (el.getAttribute('aria-label') || text(el.getAttribute('aria-labelledby')) || el.labels?.[0]?.textContent?.trim()
  57  |       || el.getAttribute('placeholder') || el.textContent?.trim().replace(/\s+/g, ' ').slice(0, 80) || el.tagName.toLowerCase());
  58  |     const active = document.activeElement;
  59  |     const notifications = document.querySelector('[role="region"][aria-label="Notifications"]');
  60  |     return {
  61  |       url: location.pathname + location.search,
  62  |       focus: active && active !== document.body ? { role: active.getAttribute('role') ?? active.tagName.toLowerCase(), name: name(active) } : 'body',
  63  |       dialogs: [...document.querySelectorAll('[role="dialog"],[role="alertdialog"]')].filter(visible).map((el) => el.textContent.trim().replace(/\s+/g, ' ').slice(0, 120)),
  64  |       menus: [...document.querySelectorAll('[role="menu"]')].filter(visible).map((el) => [...el.querySelectorAll('[role="menuitem"]')].map((entry) => ({
  65  |         text: entry.textContent.trim(), disabled: entry.getAttribute('aria-disabled') === 'true' || entry.hasAttribute('data-disabled') }))),
  66  |       alerts: [...document.querySelectorAll('[role="alert"]')].filter(visible).map((el) => el.textContent.trim().replace(/\s+/g, ' ')).filter(Boolean),
  67  |       notifications: notifications ? notifications.innerText.trim().replace(/\s+/g, ' ') : '',
  68  |     };
  69  |   });
  70  |   return { step, ...state, requests: fixtures.requests.splice(0).map(({ method, path, body }) => ({ method, path, body })) };
  71  | }
  72  | 
  73  | /** Type into a field the way a person does: focus, select what is there, type. */
  74  | async function fill(locator, value) {
  75  |   await locator.click();
  76  |   await locator.press('ControlOrMeta+a');
  77  |   if (value) await locator.pressSequentially(value);
  78  |   else await locator.press('Backspace');
  79  | }
  80  | 
  81  | // The enrollment card is fixed-width (460px), wider than a phone: Chromium's mobile layout viewport
  82  | // grows to fit it, so the harness's viewport check cannot hold there and only the screenshot is taken.
  83  | const wideCard = (testInfo) => testInfo.project.use.isMobile && testInfo.project.use.browserName === 'chromium';
  84  | function captureOf(evidence, testInfo) {
  85  |   if (!wideCard(testInfo)) return evidence.capture;
  86  |   return async (name) => {
  87  |     await evidence.page.evaluate(() => document.fonts.ready);
  88  |     await frames(evidence.page);
  89  |     await expect(evidence.page).toHaveScreenshot(`${name}.png`);
  90  |   };
  91  | }
  92  | // There the zoomed-out page also misplaces pointer clicks, so a button is pressed from the keyboard.
  93  | const pressOf = (testInfo) => (wideCard(testInfo)
  94  |   ? async (locator) => { await locator.focus(); await locator.press('Enter'); }
  95  |   : (locator) => locator.click());
  96  | 
  97  | const attachTrace = (testInfo, trace) => testInfo.attach('trace', { body: JSON.stringify(trace, null, 2), contentType: 'application/json' });
  98  | /** Bring a part of the page to the top of the view, the same way on both trees. */
  99  | const top = (locator) => locator.evaluate((el) => el.scrollIntoView({ block: 'start' }));
  100 | const phone = (testInfo) => !!testInfo.project.use.isMobile;
  101 | /** A row of the Providers page's engine cards or pool cards, by the name it shows. */
  102 | const engineRow = (page, label) => page.locator('.re-row').filter({ has: page.locator('.re-name', { hasText: new RegExp(`^${escape(label)}`) }) }).first();
  103 | const poolRow = (page, label) => page.locator('.pool-row').filter({ has: page.locator('.pool-member-label', { hasText: new RegExp(`^${escape(label)}$`) }) }).first();
  104 | const keyRow = (page, label) => page.locator('tr').filter({ has: page.locator('.prov-cell-name', { hasText: new RegExp(`^${escape(label)}$`) }) }).first();
  105 | 
  106 | test.describe('P4.2 providers', () => {
  107 |   test('engines: an account menu, its remove question and the pause dialog', async ({ evidence }, testInfo) => {
  108 |     const { page, capture } = evidence;
  109 |     const fixtures = await installP42Fixtures(page, { theme: testInfo.project.use.colorScheme });
  110 |     const trace = [];
  111 |     await page.goto(P42_PATHS.providers);
  112 |     const work = engineRow(page, 'Work');
  113 |     await expect(work).toBeVisible();
  114 |     await expect(page.locator('.pool-card').first()).toBeVisible();
  115 |     trace.push(await observe(page, fixtures, 'open'));
  116 |     await capture('p42-providers', { card: page.locator('.re-runner-card').first(), action: button(engineRow(page, 'Kimi'), 'Install') });
  117 | 
  118 |     await button(work, 'More actions').click();
  119 |     await expect(item(page, 'Remove account')).toBeVisible();
  120 |     await frames(page);
  121 |     trace.push(await observe(page, fixtures, 'account menu open'));
  122 |     await capture('p42-engine-menu', { menu: openMenu(page), more: button(work, 'More actions') });
  123 | 
  124 |     await item(page, 'Remove account').click();
  125 |     const remove = question(page, 'Remove Work?');
  126 |     await expect(remove).toBeVisible();
  127 |     await frames(page);
  128 |     trace.push(await observe(page, fixtures, 'remove asked'));
  129 |     await capture('p42-engine-remove', { question: remove });
  130 |     await button(remove, 'Cancel').click();
  131 |     await expect(remove).toHaveCount(0);
  132 |     trace.push(await observe(page, fixtures, 'remove cancelled'));
  133 | 
  134 |     // Rename from the menu: the name becomes its own editor, focused with the name selected.
  135 |     await button(work, 'More actions').click();
  136 |     await item(page, 'Rename').click();
  137 |     const name = page.getByRole('textbox', { name: 'Rename Work' });
> 138 |     await expect(name).toBeFocused();
      |                        ^ Error: expect(locator).toBeFocused() failed
  139 |     await frames(page);
  140 |     trace.push({ ...(await observe(page, fixtures, 'rename from the menu')), selected: await name.evaluate((input) => [input.selectionStart, input.selectionEnd]) });
  141 |     await name.pressSequentially('Personal');
  142 |     await name.press('Enter');
  143 |     await expect(engineRow(page, 'Personal')).toHaveCount(0);
  144 |     trace.push(await observe(page, fixtures, 'renamed'));
  145 | 
  146 |     await button(work, 'More actions').click();
  147 |     await item(page, 'Pause account…').click();
  148 |     const pause = dialog(page, 'Pause account');
  149 |     await expect(pause).toBeVisible();
  150 |     await frames(page);
  151 |     trace.push(await observe(page, fixtures, 'pause dialog'));
  152 |     await capture('p42-account-pause', { surface: pause, hours: pause.getByText('2h', { exact: true }) });
  153 |     // Where a person clicks it: on its text (the Orbit button-style radio lies over its whole button).
  154 |     await pause.getByText('Custom', { exact: true }).click({ force: true });
  155 |     const hours = pause.getByRole('spinbutton', { name: 'Pause hours' });
  156 |     await expect(hours).toBeVisible();
  157 |     await fill(hours, '2.5');
  158 |     await expect(pause.getByText(/Automatically resumes at/)).toBeVisible();
  159 |     await frames(page);
  160 |     trace.push({ ...(await observe(page, fixtures, 'custom 2.5 hours')), hours: await hours.inputValue() });
  161 |     await capture('p42-account-pause-custom', { surface: pause, number: pause.locator(NUMBER) });
  162 |     await fill(hours, '0');
  163 |     await hours.press('Tab');
  164 |     await frames(page);
  165 |     trace.push({ ...(await observe(page, fixtures, 'custom 0 hours, then Tab')), hours: await hours.inputValue() });
  166 |     await fill(hours, '3');
  167 |     await button(pause, 'Pause Account').click();
  168 |     await expect(notifications(page).getByText('Work paused', { exact: true })).toBeVisible();
  169 |     trace.push(await observe(page, fixtures, 'paused'));
  170 |     await attachTrace(testInfo, trace);
  171 |   });
  172 | 
  173 |   test('pools: each kind', async ({ evidence }, testInfo) => {
  174 |     const { page, capture } = evidence;
  175 |     const fixtures = await installP42Fixtures(page, { theme: testInfo.project.use.colorScheme });
  176 |     const trace = [];
  177 |     await page.goto(P42_PATHS.providers);
  178 |     const pools = page.locator('.pool-sec');
  179 |     await expect(pools.locator('.pool-card')).toHaveCount(3);
  180 |     // A phone starts every pool folded; open the first so its members show.
  181 |     if (phone(testInfo)) await pools.locator('.pool-card').filter({ hasText: 'Claude accounts' }).locator('.re-toggle').click();
  182 |     await top(pools);
  183 |     await frames(page);
  184 |     trace.push(await observe(page, fixtures, 'pools'));
  185 |     await capture('p42-pools', { head: pools.locator('.pool-sec-head'), card: pools.locator('.pool-card').first() });
  186 | 
  187 |     await attachTrace(testInfo, trace);
  188 |   });
  189 | 
  190 |   test('keys: the table, its delete question, loading and empty', async ({ evidence }, testInfo) => {
  191 |     const { page, capture } = evidence;
  192 |     const fixtures = await installP42Fixtures(page, { theme: testInfo.project.use.colorScheme });
  193 |     const trace = [];
  194 |     fixtures.state.holdProviders = gate();
  195 |     await page.goto(P42_PATHS.providers);
  196 |     const keys = page.locator('.provider-keys');
  197 |     const heading = page.getByRole('heading', { name: 'Your API keys', exact: true });
  198 |     await expect(heading).toBeVisible();
  199 |     await expect(keys).toBeVisible();
  200 |     await top(heading);
  201 |     await frames(page);
  202 |     trace.push(await observe(page, fixtures, 'keys loading'));
  203 |     await capture('p42-keys-loading', { table: keys });
  204 |     fixtures.state.holdProviders.open();
  205 |     fixtures.state.holdProviders = null;
  206 | 
  207 |     const lab = keyRow(page, 'Lab gateway');
  208 |     await expect(lab).toBeVisible();
  209 |     await top(heading);
  210 |     await frames(page);
  211 |     trace.push({ ...(await observe(page, fixtures, 'keys')), rows: await keys.locator('tbody tr').allInnerTexts() });
  212 |     await capture('p42-keys', { table: keys, row: lab });
  213 | 
  214 |     await lab.getByRole('button', { name: named(phone(testInfo) ? 'Delete Lab gateway' : 'Delete') }).click();
  215 |     const ask = question(page, 'Delete Lab gateway?');
  216 |     await expect(ask).toBeVisible();
  217 |     await frames(page);
  218 |     trace.push(await observe(page, fixtures, 'delete asked'));
  219 |     await capture('p42-keys-delete', { question: ask });
  220 |     await button(ask, 'OK').click();
  221 |     await expect(notifications(page).getByText('Provider deleted', { exact: true })).toBeVisible();
  222 |     await expect(keyRow(page, 'Lab gateway')).toHaveCount(0);
  223 |     trace.push(await observe(page, fixtures, 'deleted'));
  224 | 
  225 |     // No keys at all: the page offers the vendors instead of an empty table.
  226 |     fixtures.state.providers = [];
  227 |     await page.reload();
  228 |     await expect(page.getByRole('heading', { name: 'No keys yet', exact: true })).toBeVisible();
  229 |     await top(heading);
  230 |     await frames(page);
  231 |     trace.push(await observe(page, fixtures, 'no keys'));
  232 |     await capture('p42-keys-empty', { empty: page.locator('.provider-empty') });
  233 |     await attachTrace(testInfo, trace);
  234 |   });
  235 | 
  236 |   test('New pool: each engine and who can use it', async ({ evidence }, testInfo) => {
  237 |     const { page, capture } = evidence;
  238 |     const fixtures = await installP42Fixtures(page, { theme: testInfo.project.use.colorScheme });
```