# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: scroll-probe.browser.mjs >> no-preference Dialog Popover Select exits restore one layer at a time
- Location: docs/evidence/base-ui-migration/p2.2/revision-4/scroll-probe.browser.mjs:51:51

# Error details

```
Error: mouse.wheel: Mouse wheel is not supported in mobile WebKit
```

# Page snapshot

```yaml
- main [ref=e4]:
  - status [ref=e5]: light
  - button "Switch theme" [ref=e6] [cursor=pointer]
  - button "Open Dialog" [active] [ref=e8] [cursor=pointer]
  - button "Open legacy Modal" [ref=e10] [cursor=pointer]
  - region "Standalone choices" [ref=e12]:
    - generic [ref=e13]:
      - generic [ref=e14]:
        - combobox "Expires" [ref=e15] [cursor=pointer]:
          - generic [ref=e16]: Never
        - button "Clear selection" [ref=e17] [cursor=pointer]
      - textbox [aria-hidden] [ref=e21]: never
      - generic [ref=e22]:
        - generic: Orbit workspace
        - combobox "Workspace" [ref=e23]
        - button "Clear selection" [ref=e24] [cursor=pointer]
      - textbox [aria-hidden] [ref=e28]: orbit
      - combobox "Disabled select" [disabled] [ref=e30]:
        - generic [ref=e31]: Never
      - textbox [disabled] [aria-hidden] [ref=e35]: never
      - generic [ref=e36]:
        - generic: Never
        - combobox "Disabled search" [disabled] [ref=e37]
        - button "Show options" [disabled] [ref=e38] [cursor=pointer]
      - textbox [disabled] [aria-hidden] [ref=e42]: never
      - combobox "Empty select" [ref=e44] [cursor=pointer]:
        - generic [ref=e45]: No accounts
      - textbox [aria-hidden] [ref=e49]
      - combobox "Automatic account" [ref=e51] [cursor=pointer]:
        - generic [ref=e52]: Automatic
      - textbox [aria-hidden] [ref=e56]
      - button "Session actions" [ref=e57] [cursor=pointer]
      - button "Add attachment" [ref=e59] [cursor=pointer]
      - button "Open context" [ref=e61] [cursor=pointer]
      - button "Account usage" [ref=e63] [cursor=pointer]
      - button "Unavailable action" [disabled] [ref=e66]
      - button "After choices" [ref=e68] [cursor=pointer]
      - status "Expiry value" [ref=e70]: never
      - status "Workspace value" [ref=e71]: orbit
      - status "Action" [ref=e72]: none
      - status "Tag" [ref=e73]: "false"
    - generic [ref=e74]:
      - combobox "Add prerequisite" [ref=e75]
      - button "Show options" [ref=e76] [cursor=pointer]
    - textbox [aria-hidden] [ref=e80]
    - status "Prerequisite" [ref=e81]: none
  - region "Multiple choices" [ref=e82]:
    - generic [ref=e83]:
      - generic [ref=e84]:
        - toolbar [ref=e85]:
          - generic [ref=e86]:
            - generic [ref=e87]: Bug
            - button "Remove Bug" [ref=e88] [cursor=pointer]
          - combobox "Labels" [ref=e93]
        - button "Clear selection" [ref=e94] [cursor=pointer]
      - textbox [aria-hidden] [ref=e98]
      - generic [ref=e99]:
        - toolbar [ref=e100]:
          - generic [ref=e101]: Bug
          - combobox "Disabled labels" [disabled] [ref=e104]
        - button "Show options" [disabled] [ref=e105] [cursor=pointer]
      - textbox [disabled] [aria-hidden] [ref=e109]
      - generic [ref=e110]:
        - toolbar [ref=e111]:
          - generic [ref=e112]:
            - generic [ref=e113]: owner@orbit.test
            - button "Remove owner@orbit.test" [ref=e114] [cursor=pointer]
          - combobox "People to add" [ref=e119]
        - button "Clear selection" [ref=e120] [cursor=pointer]
      - textbox [aria-hidden] [ref=e124]
      - button "After tags" [ref=e125] [cursor=pointer]
      - status "Labels value" [ref=e127]: "[\"bug\"]"
      - status "People value" [ref=e128]: "[\"owner@orbit.test\"]"
      - status "People query"
    - button "Open multi Dialog" [ref=e129] [cursor=pointer]
    - group "Clickable row" [ref=e131]:
      - button "Open row" [ref=e132] [cursor=pointer]
      - button "Row actions" [ref=e134] [cursor=pointer]
    - status "Row clicks" [ref=e136]: "0"
    - status "Row actions" [ref=e137]: "0"
    - button "Long help" [ref=e138] [cursor=pointer]
    - button "Plan usage panel" [ref=e141] [cursor=pointer]
```

# Test source

```ts
  1  | // Browser-clock observations; no fake clock or changes to the component/lock.
  2  | export async function armScrollUnlock(page) {
  3  |   await page.evaluate(() => {
  4  |     const state = { limitMs: 100, startedAt: null, unlockedAfterMs: null, samples: [] };
  5  |     let finish;
  6  |     let deadline;
  7  |     state.complete = new Promise((resolve) => { finish = resolve; });
  8  |     state.read = (phase) => {
  9  |       const overflow = [document.documentElement, document.body].map((node) => getComputedStyle(node).overflowY);
  10 |       const sample = { phase, afterEscapeMs: performance.now() - state.startedAt, overflow,
  11 |         locked: overflow.some((value) => /hidden|clip/.test(value)) };
  12 |       state.samples.push(sample);
  13 |       return sample;
  14 |     };
  15 |     const stop = () => { observer.disconnect(); clearTimeout(deadline); finish(); };
  16 |     const observer = new MutationObserver(() => {
  17 |       if (state.startedAt === null) return;
  18 |       const sample = state.read('style-change');
  19 |       if (!sample.locked) { state.unlockedAfterMs = sample.afterEscapeMs; stop(); }
  20 |     });
  21 |     observer.observe(document.documentElement, { attributes: true });
  22 |     observer.observe(document.body, { attributes: true });
  23 |     window.addEventListener('keydown', () => {
  24 |       state.startedAt = performance.now();
  25 |       state.read('final-escape');
  26 |       deadline = setTimeout(() => { state.read('deadline'); stop(); }, state.limitMs);
  27 |     }, { capture: true, once: true });
  28 |     window.choiceScrollUnlock = state;
  29 |   });
  30 | }
  31 | 
  32 | export async function readScrollUnlock(page) {
  33 |   return page.evaluate(async () => {
  34 |     const state = window.choiceScrollUnlock;
  35 |     // The exact first read that used to be asserted synchronously is retained.
  36 |     const firstRead = state.read('first-read-after-hidden-and-focus');
  37 |     await state.complete;
  38 |     const finalRead = state.read('final-read');
  39 |     return { limitMs: state.limitMs, unlockedAfterMs: state.unlockedAfterMs,
  40 |       firstRead, finalRead, samples: state.samples };
  41 |   });
  42 | }
  43 | 
  44 | export async function scrollPageWithWheel(page) {
  45 |   const viewport = page.viewportSize();
  46 |   await page.mouse.move(viewport.width - 12, viewport.height - 24);
  47 |   await page.evaluate(() => {
  48 |     const state = { limitMs: 250, startedAt: performance.now(), before: scrollY,
  49 |       scrollHeight: document.scrollingElement.scrollHeight, viewportHeight: innerHeight,
  50 |       wheel: null, movedAfterMs: null };
  51 |     let finish;
  52 |     let deadline;
  53 |     state.complete = new Promise((resolve) => { finish = resolve; });
  54 |     const stop = () => {
  55 |       window.removeEventListener('wheel', wheel, true);
  56 |       window.removeEventListener('scroll', moved, true);
  57 |       clearTimeout(deadline);
  58 |       finish();
  59 |     };
  60 |     const wheel = (event) => {
  61 |       state.wheel = { trusted: event.isTrusted, deltaY: event.deltaY, afterStartMs: performance.now() - state.startedAt };
  62 |     };
  63 |     const moved = () => {
  64 |       if (scrollY > state.before) {
  65 |         state.movedAfterMs = performance.now() - state.startedAt;
  66 |         stop();
  67 |       }
  68 |     };
  69 |     window.addEventListener('wheel', wheel, true);
  70 |     window.addEventListener('scroll', moved, true);
  71 |     deadline = setTimeout(stop, state.limitMs);
  72 |     window.choicePageScroll = state;
  73 |   });
  74 |   // Trusted browser input, not scrollTo/scrollTop or a synthetic DOM event.
> 75 |   await page.mouse.wheel(0, 240);
     |                    ^ Error: mouse.wheel: Mouse wheel is not supported in mobile WebKit
  76 |   return page.evaluate(async () => {
  77 |     const state = window.choicePageScroll;
  78 |     await state.complete;
  79 |     return { limitMs: state.limitMs, before: state.before, after: scrollY,
  80 |       scrollHeight: state.scrollHeight, viewportHeight: state.viewportHeight,
  81 |       wheel: state.wheel, movedAfterMs: state.movedAfterMs };
  82 |   });
  83 | }
  84 | 
```