// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WikiChangeset, WikiChangesetOp } from '@orbit/shared';
import { WikiReviewPage } from './WikiReviewPage';

/**
 * A challenge card in Review (contract `anchorRules.verify.answers`): the same card, with its answers
 * swapped for Keep, Amend… and Retire…, and the line that says which anchor broke — path, symbol
 * or commit, changed or missing — and on which commit of main it was checked.
 *
 * The answers say what becomes of the entry, none of them is filled, an After row says what each does
 * and that Retire cannot be undone, and Retire… asks first in the entry page's own dialog (owner,
 * 2026-11-07, docs/mocks/wiki-challenge-answers): the owner had answered four challenges whose reasons
 * proposed Retire with the filled Re-confirm.
 *
 * The answers are read off the wire: `POST /api/wiki/changesets/:id/decide` with `reconfirm`,
 * `amend` (and the keys the owner changed) or `retire` (and its reason as `note`).
 */

const ENTRY_ID = '0196b600-0000-7000-8000-00000000eeee';
const SPACE_ID = '0196b600-0000-7000-8000-0000000000dd';
const CHANGESET_ID = '0196b600-0000-7000-8000-0000000000cc';
const OP_ID = '0196b600-0000-7000-8000-0000000000ab';
const MAIN = `1588c3b${'0'.repeat(33)}`;

const ENTRY = {
  id: ENTRY_ID,
  spaceId: SPACE_ID,
  kind: 'pitfall',
  title: 'wikiAnchorMark reads the anchor state',
  summary: 'A verified anchor shows the ref it was checked at.',
  fields: { symptom: 'the badge says Checked', cause: 'no ref', fix: 'pass the ref' },
  topics: [],
  aliases: [],
  anchors: [
    { type: 'symbol', path: 'src/web/src/lib/wiki.ts', symbol: 'wikiAnchorMark', check: { state: 'changed', ref: MAIN, at: '2026-09-28T01:00:00.000Z' } },
    { type: 'commit', sha: `abcdef0${'2'.repeat(33)}`, check: { state: 'missing', ref: MAIN, at: '2026-09-28T01:00:00.000Z' } },
    { type: 'path', path: 'src/web/src/lib/wiki.ts', check: { state: 'verified', ref: MAIN, at: '2026-09-28T01:00:00.000Z' } },
  ],
  anchorState: 'missing',
  trust: 'confirmed',
  status: 'active',
  currentRevision: 2,
  challenged: true,
  sources: [],
  history: [],
  exposure: [],
};

/** The kind the entry is served as: a decision is never amended, so its card offers no Amend…. */
let entryKind = 'pitfall';
const REASON = `Anchor re-verification on origin/main at ${MAIN}: symbol wikiAnchorMark in src/web/src/lib/wiki.ts has changed.`;

function queue(): WikiChangeset[] {
  const op = {
    id: OP_ID,
    changesetId: CHANGESET_ID,
    seq: 0,
    op: 'challenge',
    entryId: ENTRY_ID,
    baseRevision: null,
    payload: { reason: REASON },
    similar: [],
    tainted: false,
    decision: 'pending',
    decisionReason: null,
    decisionNote: null,
    resultEntryId: null,
    resultRevision: null,
    decidedAt: null,
    appliedByMode: null,
    spotCheck: false,
  } as unknown as WikiChangesetOp;
  return [
    {
      id: CHANGESET_ID,
      spaceId: SPACE_ID,
      origin: 'maintenance',
      sessionId: null,
      toolCallId: null,
      rationale: 'Anchor re-verification on origin/main',
      status: 'pending',
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      decidedAt: null,
      expiresAt: null,
      ops: [op],
    } as WikiChangeset,
  ];
}

let decides: Array<Array<Record<string, unknown>>> = [];

const reply = (status: number, body: unknown): Response =>
  ({ ok: status < 400, status, statusText: '', text: async () => JSON.stringify(body), json: async () => body }) as unknown as Response;

async function serve(url: string, init?: RequestInit): Promise<Response> {
  if (init?.method === 'POST' && url === `/api/wiki/changesets/${CHANGESET_ID}/decide`) {
    decides.push((JSON.parse(String(init.body)) as { decisions: Array<Record<string, unknown>> }).decisions);
    return reply(200, {});
  }
  if (url.startsWith('/api/wiki/review')) return reply(200, queue());
  if (url.startsWith('/api/wiki/spaces')) return reply(200, []);
  if (url.startsWith(`/api/wiki/entries/${ENTRY_ID}`)) return reply(200, { ...ENTRY, kind: entryKind });
  return reply(404, { message: `${url} is not in this fixture` });
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('ResizeObserver', class { observe(): void {} unobserve(): void {} disconnect(): void {} });
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false, media: query, onchange: null, addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }));
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  vi.stubGlobal('fetch', vi.fn(serve));
  decides = [];
  entryKind = 'pitfall';
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

async function settle(): Promise<void> {
  for (let tick = 0; tick < 5; tick += 1) {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  }
}

async function mount(): Promise<HTMLElement> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <WikiReviewPage spaceSlug={null} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await vi.waitFor(() => expect(container.querySelector('.wk-challenge-line')?.textContent).toContain('Changed'), { timeout: 10_000 });
  await settle();
  return container.querySelector<HTMLElement>('.approval-card')!;
}

function button(label: string, scope: ParentNode): HTMLButtonElement {
  const found = [...scope.querySelectorAll<HTMLButtonElement>('button')].find((one) => one.textContent?.trim() === label);
  if (!found) throw new Error(`no ${label} button`);
  return found;
}

describe('a challenge card', () => {
  it('says which anchors broke, how, and on which commit of main', async () => {
    const card = await mount();
    expect(card.querySelector('.wk-challenge-line')?.textContent).toBe(
      'Changed · symbol wikiAnchorMark in src/web/src/lib/wiki.ts; Missing · commit abcdef0 · checked on main at 1588c3b',
    );
  });

  it('is answered Keep, Amend… or Retire… — not Accept, Edit or Reject — and none of them is filled', async () => {
    const card = await mount();
    const answers = [...card.querySelectorAll('.card-actions .card-action')];
    expect(answers.map((node) => node.textContent)).toEqual(['Keep', 'Amend…', 'Retire…']);
    // Review's filled answer means "do what this card proposes"; a challenge has no such answer.
    expect(card.querySelector('.card-actions .card-action--primary')).toBeNull();
    expect(answers.map((node) => node.className)).toEqual([
      'card-action card-action--secondary',
      'card-action card-action--secondary',
      'card-action card-action--danger',
    ]);
    expect(card.querySelector('.card-actions .note')?.textContent).toBe('Agents stop getting this entry until you answer.');
    await act(async () => button('Keep', card).click());
    await settle();
    expect(decides).toEqual([[{ opId: OP_ID, action: 'reconfirm' }]]);
  });

  it('says above its answers what each does to the entry, and that Retire cannot be undone', async () => {
    const card = await mount();
    const keys = [...card.querySelectorAll('.wk-pkv > .k')].map((node) => node.textContent);
    expect(keys[keys.length - 1]).toBe('After');
    const lines = [...card.querySelectorAll('.wk-challenge-after > div')].map((node) => node.textContent);
    expect(lines).toEqual([
      'Keep · Agents get this entry again. You can still retire it later.',
      'Amend · Agents get your version, and its anchors are checked again.',
      'Retire · Agents stop getting it. This cannot be undone.',
    ]);
    expect(card.querySelector('.wk-challenge-after .wk-danger')?.textContent).toBe('Retire');
  });

  it('asks before it retires: the entry page’s dialog, the challenge’s reason in it, Cancel first', async () => {
    const card = await mount();
    await act(async () => button('Retire…', card).click());
    await settle();
    expect(decides).toEqual([]);
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.querySelector('.orbit-overlay-title')?.textContent).toBe('Retire…');
    expect(dialog.textContent).toContain(
      'Agents stop getting this entry. It stays in History, struck through, and the reason goes on the record. This cannot be undone.',
    );
    expect(dialog.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe(REASON);
    await vi.waitFor(() => expect(document.activeElement?.textContent).toBe('Cancel'), { timeout: 10_000 });
    await act(async () => button('Retire', dialog).click());
    await settle();
    expect(decides).toEqual([[{ opId: OP_ID, action: 'retire', note: REASON }]]);
  });

  it('records the reason as the owner leaves it, and retires nothing without one', async () => {
    const card = await mount();
    await act(async () => button('Retire…', card).click());
    await settle();
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    const area = dialog.querySelector<HTMLTextAreaElement>('textarea')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(area, '   ');
      area.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await settle();
    expect(button('Retire', dialog).disabled).toBe(true);
    await act(async () => {
      setter.call(area, '  The symbol moved to wikiMarks.ts and the rule went with it.  ');
      area.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await settle();
    await act(async () => button('Retire', dialog).click());
    await settle();
    expect(decides).toEqual([
      [{ opId: OP_ID, action: 'retire', note: 'The symbol moved to wikiMarks.ts and the rule went with it.' }],
    ]);
  });

  it('Cancel in the dialog sends nothing', async () => {
    const card = await mount();
    await act(async () => button('Retire…', card).click());
    await settle();
    await act(async () => button('Cancel', document.querySelector<HTMLElement>('[role="dialog"]')!).click());
    await settle();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(decides).toEqual([]);
  });

  it('offers a decision no Amend…: a decision is only ever superseded, and the server refuses its amend', async () => {
    entryKind = 'decision';
    const card = await mount();
    await vi.waitFor(() =>
      expect([...card.querySelectorAll('.card-actions .card-action')].map((node) => node.textContent)).toEqual(['Keep', 'Retire…']),
    { timeout: 10_000 });
    expect([...card.querySelectorAll('.wk-challenge-after > div')].map((node) => node.textContent)).toEqual([
      'Keep · Agents get this entry again. You can still retire it later.',
      'Retire · Agents stop getting it. This cannot be undone.',
    ]);
  });

  it('amends it with the keys the owner changed, and no others', async () => {
    const card = await mount();
    await act(async () => button('Amend…', card).click());
    await settle();
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.textContent).toContain('Your version replaces the entry, and its anchors are checked again.');
    const summary = dialog.querySelector<HTMLTextAreaElement>('textarea')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(summary, 'A verified anchor shows the short ref it was checked at.');
      summary.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await settle();
    await act(async () => button('Amend', dialog).click());
    await settle();
    expect(decides).toEqual([
      [{ opId: OP_ID, action: 'amend', edited: { summary: 'A verified anchor shows the short ref it was checked at.' } }],
    ]);
  });
});

describe('a phone, one card at a time', () => {
  const SECOND_OP = '0196b600-0000-7000-8000-0000000000ac';

  it('shows the next card from its top after an answer, not with its answers under the finger', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === '(max-width: 600px)', media: query, onchange: null, addListener: () => {}, removeListener: () => {},
      addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
    }));
    // Two challenges; a decided one leaves the queue on the next read, as the server's own Review does.
    const answered = new Set<string>();
    const twoCards = (): WikiChangeset[] => {
      const [changeset] = queue();
      const first = changeset.ops[0];
      const second = { ...first, id: SECOND_OP, seq: 1 } as WikiChangesetOp;
      return [{ ...changeset, ops: [first, second].filter((op) => !answered.has(op.id)) }];
    };
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST' && url === `/api/wiki/changesets/${CHANGESET_ID}/decide`) {
        const decisions = (JSON.parse(String(init.body)) as { decisions: Array<{ opId: string }> }).decisions;
        decides.push(decisions);
        for (const decision of decisions) answered.add(decision.opId);
        return reply(200, {});
      }
      if (url.startsWith('/api/wiki/review')) return reply(200, twoCards());
      return serve(url, init);
    }));
    const scrolled: Element[] = [];
    const scrollIntoView = vi.fn(function (this: Element) {
      scrolled.push(this);
    });
    (Element.prototype as unknown as { scrollIntoView: unknown }).scrollIntoView = scrollIntoView;
    try {
      const card = await mount();
      await vi.waitFor(() => expect(container.querySelector('.wk-pager .pos')?.textContent).toBe('1 of 2'), { timeout: 10_000 });
      expect(scrolled).toEqual([]);
      await act(async () => button('Keep', card).click());
      await settle();
      await vi.waitFor(() => expect(container.querySelector('.wk-pager')).toBeNull(), { timeout: 10_000 });
      expect(decides).toEqual([[{ opId: OP_ID, action: 'reconfirm' }]]);
      // The second card is on screen, and the list it heads was brought to the top of the view.
      await vi.waitFor(() => expect(scrolled.map((node) => node.className)).toContain('rv-list'), { timeout: 10_000 });
      expect(scrollIntoView).toHaveBeenLastCalledWith({ block: 'start' });
    } finally {
      delete (Element.prototype as unknown as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });
});
