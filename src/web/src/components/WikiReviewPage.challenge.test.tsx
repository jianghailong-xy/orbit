// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { App as AntApp } from 'antd';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WikiChangeset, WikiChangesetOp } from '@orbit/shared';
import { WikiReviewPage } from './WikiReviewPage';

/**
 * A challenge card in Review (contract `anchorRules.verify.answers`): the same card, with its answers
 * swapped for Re-confirm, Amend and Retire, and the line that says which anchor broke — path, symbol
 * or commit, changed or missing — and on which commit of main it was checked.
 *
 * The answers are read off the wire: `POST /api/wiki/changesets/:id/decide` with `reconfirm`,
 * `amend` (and the keys the owner changed) or `retire`.
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

function queue(): WikiChangeset[] {
  const op = {
    id: OP_ID,
    changesetId: CHANGESET_ID,
    seq: 0,
    op: 'challenge',
    entryId: ENTRY_ID,
    baseRevision: null,
    payload: { reason: `Anchor re-verification on origin/main at ${MAIN}: symbol wikiAnchorMark in src/web/src/lib/wiki.ts has changed.` },
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
  if (url.startsWith(`/api/wiki/entries/${ENTRY_ID}`)) return reply(200, ENTRY);
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
          <AntApp>
            <WikiReviewPage spaceSlug={null} />
          </AntApp>
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

  it('is answered Re-confirm, Amend or Retire — not Accept, Edit or Reject', async () => {
    const card = await mount();
    const answers = [...card.querySelectorAll('.card-actions .card-action')].map((node) => node.textContent);
    expect(answers).toEqual(['Re-confirm', 'Amend', 'Retire']);
    expect(card.querySelector('.card-actions .note')?.textContent).toBe('Agents stop getting this entry until you answer.');
    await act(async () => button('Re-confirm', card).click());
    await settle();
    expect(decides).toEqual([[{ opId: OP_ID, action: 'reconfirm' }]]);
  });

  it('retires the entry it names', async () => {
    const card = await mount();
    await act(async () => button('Retire', card).click());
    await settle();
    expect(decides).toEqual([[{ opId: OP_ID, action: 'retire' }]]);
  });

  it('amends it with the keys the owner changed, and no others', async () => {
    const card = await mount();
    await act(async () => button('Amend', card).click());
    await settle();
    const dialog = document.querySelector<HTMLElement>('.ant-modal')!;
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
