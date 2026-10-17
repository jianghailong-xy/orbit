// Browser-clock observations; no fake clock or changes to the component/lock.
export async function armScrollUnlock(page) {
  await page.evaluate(() => {
    const state = { limitMs: 100, startedAt: null, unlockedAfterMs: null, samples: [] };
    let finish;
    let deadline;
    state.complete = new Promise((resolve) => { finish = resolve; });
    state.read = (phase) => {
      const overflow = [document.documentElement, document.body].map((node) => getComputedStyle(node).overflowY);
      const sample = { phase, afterEscapeMs: performance.now() - state.startedAt, overflow,
        locked: overflow.some((value) => /hidden|clip/.test(value)) };
      state.samples.push(sample);
      return sample;
    };
    const stop = () => { observer.disconnect(); clearTimeout(deadline); finish(); };
    const observer = new MutationObserver(() => {
      if (state.startedAt === null) return;
      const sample = state.read('style-change');
      if (!sample.locked) { state.unlockedAfterMs = sample.afterEscapeMs; stop(); }
    });
    observer.observe(document.documentElement, { attributes: true });
    observer.observe(document.body, { attributes: true });
    window.addEventListener('keydown', () => {
      state.startedAt = performance.now();
      state.read('final-escape');
      deadline = setTimeout(() => { state.read('deadline'); stop(); }, state.limitMs);
    }, { capture: true, once: true });
    window.choiceScrollUnlock = state;
  });
}

export async function readScrollUnlock(page) {
  return page.evaluate(async () => {
    const state = window.choiceScrollUnlock;
    // The exact first read that used to be asserted synchronously is retained.
    const firstRead = state.read('first-read-after-hidden-and-focus');
    await state.complete;
    const finalRead = state.read('final-read');
    return { limitMs: state.limitMs, unlockedAfterMs: state.unlockedAfterMs,
      firstRead, finalRead, samples: state.samples };
  });
}

export async function scrollPageWithWheel(page) {
  const viewport = page.viewportSize();
  await page.mouse.move(viewport.width - 12, viewport.height - 24);
  await page.evaluate(() => {
    const state = { limitMs: 250, startedAt: performance.now(), before: scrollY,
      scrollHeight: document.scrollingElement.scrollHeight, viewportHeight: innerHeight,
      wheel: null, movedAfterMs: null };
    let finish;
    let deadline;
    state.complete = new Promise((resolve) => { finish = resolve; });
    const stop = () => {
      window.removeEventListener('wheel', wheel, true);
      window.removeEventListener('scroll', moved, true);
      clearTimeout(deadline);
      finish();
    };
    const wheel = (event) => {
      state.wheel = { trusted: event.isTrusted, deltaY: event.deltaY, afterStartMs: performance.now() - state.startedAt };
    };
    const moved = () => {
      if (scrollY > state.before) {
        state.movedAfterMs = performance.now() - state.startedAt;
        stop();
      }
    };
    window.addEventListener('wheel', wheel, true);
    window.addEventListener('scroll', moved, true);
    deadline = setTimeout(stop, state.limitMs);
    window.choicePageScroll = state;
  });
  // Trusted browser input, not scrollTo/scrollTop or a synthetic DOM event.
  await page.mouse.wheel(0, 240);
  return page.evaluate(async () => {
    const state = window.choicePageScroll;
    await state.complete;
    return { limitMs: state.limitMs, before: state.before, after: scrollY,
      scrollHeight: state.scrollHeight, viewportHeight: state.viewportHeight,
      wheel: state.wheel, movedAfterMs: state.movedAfterMs };
  });
}
