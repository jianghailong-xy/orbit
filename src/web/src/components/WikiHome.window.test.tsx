// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { App as AntApp } from 'antd';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WikiChangeset, WikiEntry } from '../lib/wiki';
import { WIKI_NO_ENTRIES, WIKI_NO_PRINCIPLES } from '../lib/wiki';
import { WikiPage } from '../pages/WikiPage';

/**
 * The home's principles and Activity's decisions in a space whose principles and decisions are all OLDER
 * than its 200 newest entries — the orbit space's shape, eleven thousand entries deep — driven through the
 * real routes against a fake `/api` whose entries read answers the way `listEntries` does: filtered by
 * `kind` and `status`, newest record first, at most 200.
 *
 * Out of the 200 newest entries of every kind the home used to pick its principles and its decisions,
 * so this space drew none of either and said "Nothing has been recorded in this space yet."; a Review
 * card about an entry outside that window said "An entry". Each band now reads its own kind — the
 * principles on the home, the decisions on Activity, where the home's other blocks went (design §12.3) —
 * and a Review card names its entry by the title Review's read carries.
 */

const SPACE_ID = '0196e100-0000-7000-8000-000000000001';
const SPACE = {
  id: SPACE_ID,
  slug: 'orbit',
  title: 'orbit',
  repoUrlNorm: 'github.com/jianghailong-xy/orbit',
  rootCommitSha: null,
  settings: {},
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  pendingOps: 1,
};

let counter = 0;
const id = (): string => `0196e100-0000-7000-8000-${String(++counter).padStart(12, '0')}`;

/** One entry, recorded at `at`: the server writes `validFrom` and `recordedAt` together, once. */
function entry(kind: WikiEntry['kind'], title: string, at: string, over: Partial<WikiEntry> = {}): WikiEntry {
  return {
    id: id(),
    spaceId: SPACE_ID,
    kind,
    status: 'active',
    trust: kind === 'principle' ? 'owner' : 'confirmed',
    currentRevision: 1,
    title,
    summary: `${title}, in one line.`,
    fields: {},
    topics: [],
    aliases: [],
    anchors: [],
    anchorState: 'unchecked',
    anchorCheckedRef: null,
    anchorCheckedAt: null,
    tainted: false,
    challenged: false,
    unsupported: false,
    pinned: false,
    supersedesId: null,
    supersededById: null,
    validFrom: at,
    validTo: null,
    recordedAt: at,
    retiredAt: null,
    ...over,
  } as WikiEntry;
}

const day = (month: number, date: number): string =>
  `2026-${String(month).padStart(2, '0')}-${String(date).padStart(2, '0')}T00:00:00.000Z`;

const PRINCIPLES = [
  entry('principle', 'A clock never starts agent work', day(1, 1)),
  entry('principle', 'Delete means forget', day(1, 2)),
  entry('principle', 'Completion is adjudicated, not claimed', day(1, 3), { status: 'retired', retiredAt: day(3, 1) }),
];
/** Six decisions, oldest first: the home shows the newest four. */
const DECISIONS = [1, 2, 3, 4, 5, 6].map((n) => entry('decision', `Decision ${n}`, day(2, n)));
const OLD_PITFALL = entry('pitfall', 'Piping a test run into grep hides its exit code', day(1, 5));
/** 250 entries newer than every principle and decision. */
const NEWER = Array.from({ length: 250 }, (_, n) =>
  entry(n % 2 === 0 ? 'pitfall' : 'recipe', `Newer entry ${n}`, new Date(Date.parse(day(9, 1)) + n * 60_000).toISOString()),
);

let store: WikiEntry[] = [];
const reads: string[] = [];

/** `WikiService.listEntries`: this space's entries, filtered, newest record first, between 1 and 200 of them. */
function listEntries(query: URLSearchParams): WikiEntry[] {
  const kind = query.get('kind');
  const status = query.get('status');
  const asked = query.get('limit');
  const limit = Math.min(Math.max(asked ? Number(asked) : 50, 1), 200);
  return store
    .filter((row) => (!kind || row.kind === kind) && (!status || row.status === status))
    .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt) || b.id.localeCompare(a.id))
    .slice(0, limit);
}

const REVIEW = (): WikiChangeset[] =>
  [
    {
      id: 'cs-challenge',
      spaceId: SPACE_ID,
      origin: 'agent',
      sessionId: '0196e100-0000-7000-8000-0000000000ff',
      toolCallId: null,
      rationale: 'the anchored code moved',
      status: 'pending',
      createdAt: day(9, 2),
      decidedAt: null,
      expiresAt: null,
      ops: [
        {
          id: 'op-challenge',
          changesetId: 'cs-challenge',
          seq: 0,
          op: 'challenge',
          entryId: OLD_PITFALL.id,
          baseRevision: 1,
          payload: { reason: 'the anchored code moved' },
          similar: [],
          tainted: false,
          decision: 'pending',
          decisionReason: null,
          decisionNote: null,
          resultEntryId: OLD_PITFALL.id,
          resultRevision: 1,
          decidedAt: null,
          appliedByMode: null,
          spotCheck: false,
          entryTitle: OLD_PITFALL.title,
        },
      ],
    },
  ] as unknown as WikiChangeset[];

const reply = (status: number, body: unknown): Response =>
  ({ ok: status < 400, status, statusText: '', text: async () => JSON.stringify(body), json: async () => body }) as unknown as Response;

async function serve(url: string): Promise<Response> {
  const [path, search = ''] = url.split('?');
  const space = `/api/wiki/spaces/${SPACE_ID}`;
  reads.push(url);
  if (path === '/api/wiki/spaces') return reply(200, [SPACE]);
  if (path === space) return reply(200, SPACE);
  if (path === `${space}/entries`) return reply(200, listEntries(new URLSearchParams(search)));
  if (path === `${space}/timeline`) return reply(200, { items: [] });
  if (path === `${space}/articles`) return reply(200, { spaceId: SPACE_ID, categories: [], uncategorized: [] });
  if (path === `${space}/docs`) return reply(200, { spaceId: SPACE_ID, plan: null, docs: { total: 0, written: 0 }, categories: [] });
  if (path.startsWith('/api/wiki/review')) return reply(200, REVIEW());
  return reply(404, { message: `${url} is not in this fixture` });
}

let container: HTMLDivElement;
let root: Root;
let mounted = false;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  store = [...PRINCIPLES, ...DECISIONS, OLD_PITFALL, ...NEWER];
  reads.length = 0;
  vi.stubGlobal('ResizeObserver', class { observe(): void {} unobserve(): void {} disconnect(): void {} });
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false, media: query, onchange: null, addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }));
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  vi.stubGlobal('fetch', vi.fn(serve));
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  mounted = false;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

async function open(path = '/wiki/orbit'): Promise<void> {
  // Each open is a fresh page: a second one in a test must not inherit the first's router or reads.
  if (mounted) {
    act(() => root.unmount());
    root = createRoot(container);
  }
  mounted = true;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[path]}>
          <AntApp>
            <Routes>
              <Route path="/wiki/:space" element={<WikiPage route="home" />} />
              <Route path="/wiki/:space/activity" element={<WikiPage route="activity" />} />
            </Routes>
          </AntApp>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  for (let tick = 0; tick < 8; tick += 1) {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  }
}

const words = (node: Element | null | undefined): string => node?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
const card = (title: string): Element | undefined =>
  [...container.querySelectorAll('section.wk-card')].find(
    (section) => words(section.querySelector('.project-open-items-title')) === title,
  );

describe('the Wiki home and Activity, in a space with 200 newer entries than its principles and decisions', () => {
  it('is a space whose 200 newest entries hold no principle and no decision', () => {
    const window = listEntries(new URLSearchParams('limit=200'));
    expect(window).toHaveLength(200);
    expect(window.filter((row) => row.kind === 'principle' || row.kind === 'decision')).toEqual([]);
    expect(window.map((row) => row.id)).not.toContain(OLD_PITFALL.id);
  });

  it('still lists every principle on the home, oldest recorded first, whatever its status', async () => {
    await open();
    const principles = container.querySelector('.wk-home .wk-home-pr');
    expect(words(principles?.querySelector('.wk-pl-cat-h b'))).toBe('Principles');
    expect([...principles!.querySelectorAll('.wk-pl-doc .tt')].map(words)).toEqual(PRINCIPLES.map((row) => row.title));
    expect(words(principles!.querySelector('.wk-home-n'))).toBe('3');
    expect(words(container)).not.toContain(WIKI_NO_ENTRIES);
    expect(reads).toContain(`/api/wiki/spaces/${SPACE_ID}/entries?kind=principle&limit=200`);
  });

  it('still shows Activity the four newest decisions, newest first', async () => {
    await open('/wiki/orbit/activity');
    const decisions = card('Recent decisions');
    expect([...decisions!.querySelectorAll('.wk-dec .t')].map(words)).toEqual([
      'Decision 6',
      'Decision 5',
      'Decision 4',
      'Decision 3',
    ]);
    expect(reads).toContain(`/api/wiki/spaces/${SPACE_ID}/entries?kind=decision&limit=4`);
  });

  it('names on Activity the entry a waiting challenge is about, though no entry read of the page holds it', async () => {
    await open('/wiki/orbit/activity');
    const review = card('Review');
    expect(words(review!.querySelector('.wk-rv-row .t'))).toBe(OLD_PITFALL.title);
    expect(words(review)).not.toContain('An entry');
    // One waiting proposal is one proposal.
    expect(words(container.querySelector('.wk-banner .t'))).toBe('1 proposal to review');
  });

  it('draws no Principles on the home when the space has entries but no principle, and says nothing of it', async () => {
    store = store.filter((row) => row.kind !== 'principle');
    await open();
    expect(container.querySelector('.wk-home-pr')).toBeNull();
    expect(words(container)).not.toContain('Principles');
    expect(words(container)).not.toContain(WIKI_NO_PRINCIPLES);
    expect(words(container)).not.toContain(WIKI_NO_ENTRIES);
    await open('/wiki/orbit/activity');
    expect([...card('Recent decisions')!.querySelectorAll('.wk-dec .t')]).toHaveLength(4);
  });
});
