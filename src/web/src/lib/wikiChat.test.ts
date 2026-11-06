import { describe, expect, it } from 'vitest';
import { WIKI_CHAT_COPY, WIKI_CHAT_RULES, wikiChatContextErrors } from '@orbit/shared';
import {
  WIKI_CHAT_ASK,
  WIKI_CHAT_CHOOSE_WORKSPACE,
  WIKI_CHAT_EMPTY_HINT,
  WIKI_CHAT_EMPTY_NOTE,
  WIKI_CHAT_LABEL,
  WIKI_CHAT_NEW,
  WIKI_CHAT_NO_ATTACHMENTS,
  WIKI_CHAT_NO_WORKTREE,
  WIKI_CHAT_PLACEHOLDER,
  WIKI_CHAT_RUNS_IN,
  wikiChatAttach,
  wikiChatContext,
  wikiChatDocks,
  wikiChatFab,
  wikiChatFabShown,
  wikiChatFoldsDirectory,
  wikiChatLayout,
  wikiChatOffline,
  wikiChatPanelWidth,
  wikiChatQuoteCounts,
  wikiChatRunLine,
  wikiChatRunsIn,
  wikiChatSearch,
  wikiChatShown,
  wikiChatSnap,
  wikiChatToOpen,
  type WikiChatAttachments,
  type WikiChatPage,
  type WikiChatQuote,
  type WikiChatRow,
  type WikiChatSentence,
  type WikiChatWorkspace,
} from './wikiChat';

/**
 * The wiki chat's rules on the web (docs/wiki-chat-design.md §3–§5, contract `chat`, board 42 ⓪ ①), as pure
 * functions: the button's four looks and the pages that wear it, the panel's place by the window's width, which
 * chat the button opens and where it runs, a selection snapped to whole sentences under the cap of 20, and the
 * composer's attachments — shown, crossed out, and frozen into the message's `wikiContext` when it is sent.
 */

describe('the words', () => {
  it('are the contract’s own, taken from the shared copy', () => {
    expect(WIKI_CHAT_LABEL).toBe('Chat');
    expect(WIKI_CHAT_NEW).toBe('New chat');
    expect(WIKI_CHAT_RUNS_IN).toBe('Runs in');
    expect(WIKI_CHAT_ASK).toBe('Ask');
    expect(WIKI_CHAT_EMPTY_HINT).toBe('Ask about this page, or say what should change.');
    expect(WIKI_CHAT_EMPTY_NOTE).toBe('Nothing in the wiki changes until you apply it.');
    expect(WIKI_CHAT_PLACEHOLDER).toBe(WIKI_CHAT_COPY.panel.placeholder);
    expect(WIKI_CHAT_NO_WORKTREE).toBe('Turn on worktrees for a workspace in this repository to chat here');
    expect(WIKI_CHAT_CHOOSE_WORKSPACE).toBe("Choose where this space's chats run");
    expect(wikiChatOffline('HPC')).toBe('HPC is offline. The chat waits for it to come back.');
  });

  it('name a quote as the attachment line does: 1 sentence · 2 sources (board 42 ①)', () => {
    expect(wikiChatQuoteCounts(1, 2)).toBe('1 sentence · 2 sources');
    expect(wikiChatQuoteCounts(3, 1)).toBe('3 sentences · 1 source');
    expect(wikiChatQuoteCounts(2, 0)).toBe('2 sentences');
  });

  it('say where a chat runs on one line: workspace · machine · engine · mode', () => {
    expect(wikiChatRunLine(['orbit-develop', 'HPC', 'Claude Opus 5.5', 'Default'])).toBe('orbit-develop · HPC · Claude Opus 5.5 · Default');
    expect(wikiChatRunLine(['orbit-develop', null, '', 'Default'])).toBe('orbit-develop · Default');
  });
});

describe('the round button', () => {
  it('is on every page of a space but its Settings, and on none without a space', () => {
    const pages = ['home', 'activity', 'topic', 'entry', 'review', 'run', 'browse', 'index', 'doc', 'plan', 'planDoc', 'planSection'];
    for (const route of pages) expect(wikiChatFabShown(route, true)).toBe(true);
    expect(wikiChatFabShown('settings', true)).toBe(false);
    expect(wikiChatFabShown('home', false)).toBe(false);
  });

  it('has four looks read from the three counts, needs you before working before updated (design §3)', () => {
    expect(wikiChatFab({ needsYou: 0, working: false, updated: 0 })).toEqual({ state: 'idle', label: 'Chat', count: 0 });
    expect(wikiChatFab({ needsYou: 0, working: true, updated: 2 })).toEqual({ state: 'working', label: 'Working…', count: 0 });
    expect(wikiChatFab({ needsYou: 1, working: true, updated: 2 })).toEqual({ state: 'needs_you', label: '1 needs you', count: 1 });
    expect(wikiChatFab({ needsYou: 3, working: false, updated: 0 })).toEqual({ state: 'needs_you', label: '3 need you', count: 3 });
    expect(wikiChatFab({ needsYou: 0, working: false, updated: 1 })).toEqual({ state: 'updated', label: 'Wiki updated', count: 0 });
  });

  it('is at rest before the chats are read, and from a server that has none', () => {
    expect(wikiChatFab(undefined).state).toBe('idle');
    expect(wikiChatFab(null).label).toBe('Chat');
  });

  it('opens the newest chat that needs the owner, else the newest open one, else a new chat', () => {
    const row = (sessionId: string, over: Partial<WikiChatRow> = {}): WikiChatRow => ({
      sessionId, title: sessionId, status: 'AWAITING_INPUT', open: true, createdAt: '', updatedAt: '', drafts: 0, needsYou: 0, ...over,
    });
    expect(wikiChatToOpen([row('a'), row('b', { needsYou: 2 }), row('c', { needsYou: 1 })])).toBe('b');
    expect(wikiChatToOpen([row('a', { open: false }), row('b'), row('c')])).toBe('b');
    expect(wikiChatToOpen([row('a', { open: false })])).toBe('new');
    expect(wikiChatToOpen([])).toBe('new');
    expect(wikiChatToOpen(undefined)).toBe('new');
  });
});

describe("the panel's place", () => {
  it('docks at 1440 and wider, still docks from 1200, lies over the page from 640, and is a sheet below (design §4.1)', () => {
    expect([1920, 1440, 1439, 1200, 1199, 640, 639, 390].map(wikiChatLayout)).toEqual([
      'wide', 'wide', 'docked', 'docked', 'over', 'over', 'sheet', 'sheet',
    ]);
    expect(['wide', 'docked', 'over', 'sheet'].map((layout) => wikiChatDocks(layout as never))).toEqual([true, true, false, false]);
    // The directory stays beside the page only when the window is wide; narrower, it folds into Contents.
    expect(['wide', 'docked', 'over', 'sheet'].map((layout) => wikiChatFoldsDirectory(layout as never))).toEqual([false, true, true, true]);
  });

  it('is 400 wide by default, dragged between 320 and 560 where it is wide, and as wide as the window as a sheet', () => {
    expect(wikiChatPanelWidth('wide', null)).toBe(400);
    expect(wikiChatPanelWidth('wide', 480)).toBe(480);
    expect(wikiChatPanelWidth('wide', 200)).toBe(320);
    expect(wikiChatPanelWidth('wide', 900)).toBe(560);
    expect(wikiChatPanelWidth('docked', 520)).toBe(400);
    expect(wikiChatPanelWidth('over', 520)).toBe(400);
    expect(wikiChatPanelWidth('sheet', 520)).toBeNull();
  });

  it('is named in the address, every other key kept: ?chat=<session>', () => {
    expect(wikiChatSearch('', 'Sx1')).toBe('?chat=Sx1');
    expect(wikiChatSearch('?v=2', 'new')).toBe('?v=2&chat=new');
    expect(wikiChatSearch('?v=2&chat=Sx1', null)).toBe('?v=2');
    expect(wikiChatSearch('?chat=Sx1', null)).toBe('');
  });
});

describe('where a chat runs (design §5.1)', () => {
  const develop: WikiChatWorkspace = { id: 'w1', name: 'orbit-develop', runner: 'HPC', online: true };
  const mac: WikiChatWorkspace = { id: 'w2', name: 'orbit-mac', runner: 'austin', online: false };

  it('is chosen the first time, from the workspaces that run sessions in worktrees, with nothing picked for the owner', () => {
    expect(wikiChatRunsIn({ workspace: null, choices: [develop, mac] }, null)).toEqual({ kind: 'choose', choices: [develop, mac], again: false });
    expect(wikiChatRunsIn({ workspace: null, choices: [develop, mac] }, 'w2')).toEqual({
      kind: 'chosen', workspace: mac, remembered: false, choices: [develop, mac],
    });
  });

  it('is remembered after that, and an offline machine stays the chat’s', () => {
    const remembered = { ...mac, eligible: true };
    expect(wikiChatRunsIn({ workspace: remembered, choices: [develop, mac] }, null)).toEqual({
      kind: 'chosen', workspace: mac, remembered: true, choices: [develop, mac],
    });
  });

  it('is chosen again when the remembered one no longer qualifies', () => {
    expect(wikiChatRunsIn({ workspace: { ...mac, eligible: false }, choices: [develop] }, null)).toEqual({ kind: 'choose', choices: [develop], again: true });
  });

  it('has nothing to choose when no workspace runs in worktrees', () => {
    expect(wikiChatRunsIn({ workspace: null, choices: [] }, null)).toEqual({ kind: 'none' });
    expect(wikiChatRunsIn({ workspace: { ...mac, eligible: false }, choices: [] }, null)).toEqual({ kind: 'none' });
  });
});

/** A document's sentences in reading order: three sections, the second with 24 sentences. */
function sentences(): WikiChatSentence[] {
  const out: WikiChatSentence[] = [
    { id: 'a1', section: 's1', text: 'Runner 通过出站 HTTP 轮询领取工作。', notes: [5, 2] },
    { id: 'a2', section: 's1', text: 'Runner 每 30 秒发送一次心跳，控制面连续 90 秒未收到心跳即判定 runner 离线。', notes: [5, 12] },
    { id: 'a3', section: 's1', text: '该机制确保控制面能及时感知 runner 状态变化。', notes: [] },
  ];
  for (let i = 1; i <= 24; i += 1) out.push({ id: `b${i}`, section: 's2', text: `Sentence ${i}.`, notes: i % 2 ? [i] : [] });
  out.push({ id: 'c1', section: 's3', text: 'The last one.', notes: [40] });
  return out;
}

describe('a selection snapped to sentences (comment design §2, step 1)', () => {
  const order = sentences();
  const snap = (touched: { sentences?: string[]; headings?: string[] }) =>
    wikiChatSnap('session-runtime', order, { sentences: touched.sentences ?? [], headings: touched.headings ?? [] });

  it('takes a sentence it touches at all as a whole one, with its sources', () => {
    expect(snap({ sentences: ['a2'] })).toEqual({
      docSlug: 'session-runtime',
      sectionKey: 's1',
      sentenceIds: ['a2'],
      first: 'Runner 每 30 秒发送一次心跳，控制面连续 90 秒未收到心跳即判定 runner 离线。',
      sources: 2,
      selected: 1,
    });
  });

  it('takes every sentence between the first and the last it touches, across sections, starting where it starts', () => {
    const quote = snap({ sentences: ['a3', 'b2'] })!;
    expect(quote.sentenceIds).toEqual(['a3', 'b1', 'b2']);
    expect(quote.sectionKey).toBe('s1');
    expect(quote.sources).toBe(1);
  });

  it('takes a section whose heading it touches as all of that section', () => {
    const quote = snap({ headings: ['s3'] })!;
    expect(quote.sentenceIds).toEqual(['c1']);
    expect(quote.sectionKey).toBe('s3');
  });

  it('takes at most 20 sentences, the first ones, and says how many there were', () => {
    const quote = snap({ sentences: ['a1', 'c1'] })!;
    expect(quote.sentenceIds).toHaveLength(WIKI_CHAT_RULES.selectionSentencesMax);
    expect(quote.sentenceIds).toEqual(['a1', 'a2', 'a3', ...Array.from({ length: 17 }, (_, i) => `b${i + 1}`)]);
    expect(quote.selected).toBe(28);
    // A heading of 24 sentences is capped the same way.
    expect(snap({ headings: ['s2'] })!.sentenceIds).toHaveLength(20);
    expect(snap({ headings: ['s2'] })!.selected).toBe(24);
  });

  it('is nothing when it touches no sentence: a code block or a diagram has none to send', () => {
    expect(snap({})).toBeNull();
    expect(snap({ sentences: ['not-in-this-doc'] })).toBeNull();
  });
});

describe('the attachments (design §4.2)', () => {
  const page = (section: string): WikiChatPage => ({ kind: 'doc', docSlug: 'session-runtime', sectionKey: section, label: `3.1 §${section.slice(1)}` });
  const quote: WikiChatQuote = { docSlug: 'session-runtime', sectionKey: 's3', sentenceIds: ['x1', 'x2'], first: 'Runner…', sources: 2, selected: 2 };
  const run = (...actions: Parameters<typeof wikiChatAttach>[1][]): WikiChatAttachments =>
    actions.reduce(wikiChatAttach, WIKI_CHAT_NO_ATTACHMENTS);

  it('follow the reader: the page is the one in view now', () => {
    const state = run({ type: 'follow', page: page('s1') }, { type: 'follow', page: page('s3') });
    expect(wikiChatShown(state)).toEqual({ page: page('s3'), quote: null });
    expect(wikiChatContext(state)).toEqual({ page: { kind: 'doc', docSlug: 'session-runtime', sectionKey: 's3' } });
  });

  it('add a quote with Ask, a newer Ask replacing it, and send what they show', () => {
    const state = run({ type: 'follow', page: page('s3') }, { type: 'quote', quote: { ...quote, sentenceIds: ['old'] } }, { type: 'quote', quote });
    expect(wikiChatContext(state)).toEqual({
      page: { kind: 'doc', docSlug: 'session-runtime', sectionKey: 's3' },
      selection: { docSlug: 'session-runtime', sectionKey: 's3', sentenceIds: ['x1', 'x2'] },
    });
    expect(wikiChatContextErrors(wikiChatContext(state))).toEqual([]);
  });

  it('are crossed out one by one, and what is not shown is not sent', () => {
    const crossedPage = run({ type: 'follow', page: page('s3') }, { type: 'quote', quote }, { type: 'crossPage' });
    expect(wikiChatShown(crossedPage).page).toBeNull();
    expect(wikiChatContext(crossedPage)).toEqual({ selection: { docSlug: 'session-runtime', sectionKey: 's3', sentenceIds: ['x1', 'x2'] } });
    // A crossed-out page stays out while the reader moves on, until the message goes.
    expect(wikiChatShown(wikiChatAttach(crossedPage, { type: 'follow', page: page('s1') })).page).toBeNull();
    const both = wikiChatAttach(crossedPage, { type: 'crossQuote' });
    expect(wikiChatShown(both)).toEqual({ page: null, quote: null });
    expect(wikiChatContext(both)).toBeUndefined();
  });

  it('are frozen when the message is sent: the next one starts with the page in view and no quote', () => {
    const before = run({ type: 'follow', page: page('s3') }, { type: 'quote', quote }, { type: 'crossPage' });
    const sent = wikiChatContext(before);
    const after = run({ type: 'follow', page: page('s3') }, { type: 'quote', quote }, { type: 'crossPage' }, { type: 'sent' }, { type: 'follow', page: page('s1') });
    // What went is what was shown when it went; moving on changes nothing in it.
    expect(sent).toEqual({ selection: { docSlug: 'session-runtime', sectionKey: 's3', sentenceIds: ['x1', 'x2'] } });
    expect(wikiChatShown(after)).toEqual({ page: page('s1'), quote: null });
  });

  it('name an entry or a plan document by the shape the contract gives each', () => {
    const entry = run({ type: 'follow', page: { kind: 'entry', entryId: 'E1', label: 'Wakeups are held by the server' } });
    expect(wikiChatContext(entry)).toEqual({ page: { kind: 'entry', entryId: 'E1' } });
    const plan = run({ type: 'follow', page: { kind: 'plan', docSlug: 'session-runtime', label: '3.1' } });
    expect(wikiChatContext(plan)).toEqual({ page: { kind: 'plan', docSlug: 'session-runtime' } });
    for (const state of [entry, plan]) expect(wikiChatContextErrors(wikiChatContext(state))).toEqual([]);
  });
});
