// Browser-clock observations; no fake clock or changes to the component/lock.
export async function armScrollUnlock(dialog) {
  await dialog.evaluate((node) => {
    const state = { limitMs: 100, startedAt: null, exitStartedAfterMs: null,
      closedAfterMs: null, unlockedAfterMs: null, readyAfterCloseMs: null, samples: [] };
    let finish;
    let deadline;
    state.complete = new Promise((resolve) => { finish = resolve; });
    state.read = (phase) => {
      const overflow = [document.documentElement, document.body].map((node) => getComputedStyle(node).overflowY);
      const sample = { phase, afterEscapeMs: performance.now() - state.startedAt,
        connected: node.isConnected, hidden: node.hidden, overflow,
        locked: overflow.some((value) => /hidden|clip/.test(value)) };
      state.samples.push(sample);
      return sample;
    };
    const stop = () => { observer.disconnect(); clearTimeout(deadline); finish(); };
    const observer = new MutationObserver(() => {
      if (state.startedAt === null) return;
      const sample = state.read('dom-change');
      if (state.exitStartedAfterMs === null && node.hasAttribute('data-ending-style')) {
        state.exitStartedAfterMs = sample.afterEscapeMs;
        state.exitTransitionDuration = getComputedStyle(node).transitionDuration;
      }
      if (!sample.locked && state.unlockedAfterMs === null) state.unlockedAfterMs = sample.afterEscapeMs;
      // Wait for the actual popup lifecycle, not an assumed duration from Esc.
      // Normal exit transitions and React scheduling precede this cleanup window.
      if (state.closedAfterMs === null && (!sample.connected || sample.hidden)) {
        state.closedAfterMs = sample.afterEscapeMs;
        state.closeRead = sample;
        deadline = setTimeout(() => { state.read('close-deadline'); stop(); }, state.limitMs);
      }
      if (state.closedAfterMs !== null && !sample.locked) {
        state.readyAfterCloseMs = sample.afterEscapeMs - state.closedAfterMs;
        stop();
      }
    });
    observer.observe(document.documentElement, { attributes: true });
    observer.observe(document.body, { attributes: true, childList: true, subtree: true });
    window.addEventListener('keydown', () => {
      state.startedAt = performance.now();
      state.read('final-escape');
    }, { capture: true, once: true });
    window.choiceScrollUnlock = state;
  });
}

export async function readScrollUnlock(page) {
  return page.evaluate(async () => {
    const state = window.choiceScrollUnlock;
    // The exact first read that used to be asserted synchronously is retained.
    const firstRead = state.read('first-read-after-hidden-and-focus');
    // A hidden/focused assertion must not hide a missing close lifecycle signal.
    // Return that failure for the caller to assert instead of waiting indefinitely.
    if (state.closedAfterMs !== null) await state.complete;
    const finalRead = state.read('final-read');
    return { limitMs: state.limitMs, exitStartedAfterMs: state.exitStartedAfterMs,
      exitTransitionDuration: state.exitTransitionDuration, closedAfterMs: state.closedAfterMs,
      closeRead: state.closeRead, unlockedAfterMs: state.unlockedAfterMs, readyAfterCloseMs: state.readyAfterCloseMs,
      firstRead, finalRead, samples: state.samples };
  });
}

export async function scrollPage(page, info) {
  const inputType = info.project.use.isMobile ? 'keydown' : 'wheel';
  const viewport = page.viewportSize();
  if (inputType === 'wheel') await page.mouse.move(viewport.width - 12, viewport.height - 24);
  await page.evaluate((inputType) => {
    const state = { limitMs: 250, startedAt: performance.now(), before: scrollY,
      scrollHeight: document.scrollingElement.scrollHeight, viewportHeight: innerHeight,
      input: null, movedAfterMs: null };
    let finish;
    let deadline;
    state.complete = new Promise((resolve) => { finish = resolve; });
    const stop = () => {
      window.removeEventListener(inputType, input, true);
      window.removeEventListener('scroll', moved, true);
      clearTimeout(deadline);
      finish();
    };
    const input = (event) => {
      state.input = { kind: inputType === 'wheel' ? 'wheel' : event.key, trusted: event.isTrusted,
        afterStartMs: performance.now() - state.startedAt };
    };
    const moved = () => {
      if (scrollY > state.before) {
        state.movedAfterMs = performance.now() - state.startedAt;
        stop();
      }
    };
    window.addEventListener(inputType, input, true);
    window.addEventListener('scroll', moved, true);
    deadline = setTimeout(stop, state.limitMs);
    window.choicePageScroll = state;
  }, inputType);
  // Trusted browser input, not scrollTo/scrollTop or a synthetic DOM event.
  // Mobile WebKit explicitly does not support Playwright's wheel command.
  if (inputType === 'keydown') await page.keyboard.press('PageDown');
  else await page.mouse.wheel(0, 240);
  return page.evaluate(async () => {
    const state = window.choicePageScroll;
    await state.complete;
    return { limitMs: state.limitMs, before: state.before, after: scrollY,
      scrollHeight: state.scrollHeight, viewportHeight: state.viewportHeight,
      input: state.input, movedAfterMs: state.movedAfterMs };
  });
}
