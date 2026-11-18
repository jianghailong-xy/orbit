import { test, expect } from './harness.mjs';
import { SESSION, SESSION_PATH, SESSION_TIME } from './session-fixtures.mjs';

// The sticky question bar over a turn Orbit opened (a "Reply from" card handed back with the owner's
// question in the same turn). The bar sits above the scroller, so drawing or dropping it moves a
// transcript pinned to its tail by the bar's height. Once that move carried the card back and forth
// across the top edge, the bar came and went every frame. The window's height is swept a few pixels
// at a time across the band where the card crosses the top, with the transcript pinned to its tail,
// and at every height the bar has to hold still.
const QUESTION = 'Ask the coordinator to resolve that merge conflict';
const NOTE = '<orbit-session-reply request="req1">\nResolved.\n</orbit-session-reply>';
const at = { ts: SESSION_TIME };
const lines = (n, tag) => Array.from({ length: n }, (_, i) => `${tag} ${i + 1}.`).join('\n\n');
const EVENTS = [
  { ...at, seq: 1, turnId: 't1', type: 'user', payload: { text: 'First question' } },
  { ...at, seq: 2, turnId: 't1', type: 'assistant', payload: { text: lines(30, 'Answer') } },
  { ...at, seq: 3, turnId: 't1', type: 'turn_end', payload: {} },
  { ...at, seq: 4, turnId: 't2', type: 'user', payload: {
    text: QUESTION + NOTE, controlPlaneNote: NOTE,
    sessionReplies: [{ requestId: 'req1', outcome: 'REPLIED', fromSessionId: SESSION.id, fromTitle: 'Coordinator',
      requestPreview: 'Resolve the merge conflict', replyText: 'Resolved the conflict and pushed.' }],
  } },
  { ...at, seq: 5, turnId: 't2', type: 'assistant', payload: { text: lines(40, 'Step') } },
  { ...at, seq: 6, turnId: 't2', type: 'turn_end', payload: {} },
];

test('the sticky bar holds still while a reply card crosses the top at the tail', async ({ evidence }) => {
  const { page } = evidence;
  await page.route(`**/api${SESSION_PATH}/events/page*`, (route) =>
    route.fulfill({ json: { events: EVENTS, hasMore: false } }));
  // Reads the session page makes that the shared fixtures do not answer: none of them has anything.
  const empty = {
    '/api/guest-sessions': { sessions: [] },
    '/api/terminals/requests': { requests: [] },
    '/api/schedules': { schedules: [] },
    [`/api${SESSION_PATH}/schedule-cards`]: { run: null, cards: [], records: [] },
  };
  await page.route((url) => url.pathname in empty, (route) =>
    route.fulfill({ json: empty[new URL(route.request().url()).pathname] }));
  await page.goto(SESSION_PATH);
  await expect(page.locator('.src-wrap')).toBeVisible();
  await page.evaluate(() => {
    window.__stickyToggles = 0;
    let shown = !!document.querySelector('.chat-sticky-question');
    new MutationObserver(() => {
      const now = !!document.querySelector('.chat-sticky-question');
      if (now !== shown) { window.__stickyToggles++; shown = now; }
    }).observe(document.body, { childList: true, subtree: true });
  });
  // Where the card's bottom sits against the scroller's top; at the tail, a window d px shorter
  // moves it d px up.
  const cardBelowTop = () => page.evaluate(() =>
    document.querySelector('.src-wrap').getBoundingClientRect().bottom
      - document.querySelector('.workspace-scroll-wrap > .workspace-sessions').getBoundingClientRect().top);
  const { width, height } = page.viewportSize();
  const start = Math.round(height - (await cardBelowTop()) + 45);
  const flicker = [];
  for (let h = start; h >= start - 150; h -= 3) {
    await page.setViewportSize({ width, height: h });
    await page.waitForTimeout(150);
    const before = await page.evaluate(() => window.__stickyToggles);
    await page.waitForTimeout(250);
    const toggles = (await page.evaluate(() => window.__stickyToggles)) - before;
    if (toggles > 0) flicker.push({ height: h, toggles });
    if (h === start) await expect(page.locator('.chat-sticky-text')).toHaveText(QUESTION);
  }
  expect(flicker, 'heights at which the bar kept coming and going').toEqual([]);
  // Well past the top, the card is a turn Orbit opened, so the bar is hidden over it.
  await expect(page.locator('.chat-sticky-question')).toHaveCount(0);
});
