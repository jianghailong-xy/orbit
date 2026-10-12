# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: scroll-negative-control.browser.mjs >> observer rejects retained scroll lock
- Location: docs/evidence/base-ui-migration/p2.2/revision-4/scroll-negative-control.browser.mjs:6:42

# Error details

```
Error: page.evaluate: TypeError: null is not an object (evaluating 'document.scrollingElement.scrollHeight')
```

# Page snapshot

```yaml
- generic [ref=e1]:
  - button "Focus target" [active] [ref=e2]
  - generic [ref=e3]: Scrollable content
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
  44 | export async function scrollPage(page, info) {
  45 |   const inputType = info.project.use.isMobile ? 'keydown' : 'wheel';
  46 |   const viewport = page.viewportSize();
  47 |   if (inputType === 'wheel') await page.mouse.move(viewport.width - 12, viewport.height - 24);
> 48 |   await page.evaluate((inputType) => {
     |              ^ Error: page.evaluate: TypeError: null is not an object (evaluating 'document.scrollingElement.scrollHeight')
  49 |     const state = { limitMs: 250, startedAt: performance.now(), before: scrollY,
  50 |       scrollHeight: document.scrollingElement.scrollHeight, viewportHeight: innerHeight,
  51 |       input: null, movedAfterMs: null };
  52 |     let finish;
  53 |     let deadline;
  54 |     state.complete = new Promise((resolve) => { finish = resolve; });
  55 |     const stop = () => {
  56 |       window.removeEventListener(inputType, input, true);
  57 |       window.removeEventListener('scroll', moved, true);
  58 |       clearTimeout(deadline);
  59 |       finish();
  60 |     };
  61 |     const input = (event) => {
  62 |       state.input = { kind: inputType === 'wheel' ? 'wheel' : event.key, trusted: event.isTrusted,
  63 |         afterStartMs: performance.now() - state.startedAt };
  64 |     };
  65 |     const moved = () => {
  66 |       if (scrollY > state.before) {
  67 |         state.movedAfterMs = performance.now() - state.startedAt;
  68 |         stop();
  69 |       }
  70 |     };
  71 |     window.addEventListener(inputType, input, true);
  72 |     window.addEventListener('scroll', moved, true);
  73 |     deadline = setTimeout(stop, state.limitMs);
  74 |     window.choicePageScroll = state;
  75 |   }, inputType);
  76 |   // Trusted browser input, not scrollTo/scrollTop or a synthetic DOM event.
  77 |   // Mobile WebKit explicitly does not support Playwright's wheel command.
  78 |   if (inputType === 'keydown') await page.keyboard.press('PageDown');
  79 |   else await page.mouse.wheel(0, 240);
  80 |   return page.evaluate(async () => {
  81 |     const state = window.choicePageScroll;
  82 |     await state.complete;
  83 |     return { limitMs: state.limitMs, before: state.before, after: scrollY,
  84 |       scrollHeight: state.scrollHeight, viewportHeight: state.viewportHeight,
  85 |       input: state.input, movedAfterMs: state.movedAfterMs };
  86 |   });
  87 | }
  88 | 
```