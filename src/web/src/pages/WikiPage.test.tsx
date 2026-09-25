import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { WikiHome } from '../components/WikiHome';
import type { WikiChangeset, WikiEntry, WikiSpaceWithUsage, WikiTimeline } from '../lib/wiki';
import { WikiPage } from './WikiPage';

vi.hoisted(() => {
  const noop = (): void => undefined;
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: noop, removeItem: noop });
});

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  api: () => new Promise(() => undefined),
}));

/**
 * The Wiki's pages, from a fixture: the home's blocks in the design's order, and a topic page's rows
 * carrying the three trailing facts.
 *
 * WHAT THE ORDER IS FOR: the home page is read top-down, and the design puts the principles first
 * because they are what the rest is judged against — then the topics, then the decision log, with the
 * owner's own queue leading the right rail. Both clients draw that order and iOS mirrors it block for
 * block, so it is asserted here rather than left to a screenshot.
 */

const SPACE_ID = '0196e000-0000-7000-8000-000000000001';

let counter = 0;
const id = (): string => `0196e000-0000-7000-8000-${String(++counter).padStart(12, '0')}`;

function entry(over: Partial<WikiEntry> = {}): WikiEntry {
  return {
    id: id(),
    spaceId: SPACE_ID,
    kind: 'principle',
    status: 'active',
    trust: 'owner',
    currentRevision: 1,
    title: 'A clock never starts agent work',
    summary: 'Work starts from a committed fact.',
    fields: { statement: 'A clock never starts agent work.', rationale: 'Time is not a fact.' },
    topics: ['tasks-dispatch'],
    aliases: [],
    anchors: [],
    anchorState: 'verified',
    anchorCheckedRef: 'a'.repeat(40),
    anchorCheckedAt: '2026-09-25T00:00:00.000Z',
    tainted: false,
    challenged: false,
    unsupported: false,
    pinned: false,
    supersedesId: null,
    supersededById: null,
    validFrom: '2026-09-25T00:00:00.000Z',
    validTo: null,
    recordedAt: '2026-09-24T00:00:00.000Z',
    retiredAt: null,
    ...over,
  } as WikiEntry;
}

const SPACE: WikiSpaceWithUsage = {
  id: SPACE_ID,
  slug: 'orbit',
  title: 'Orbit',
  repoUrlNorm: 'github.com/jianghailong-xy/orbit',
  rootCommitSha: 'b'.repeat(40),
  settings: { push: true, autoAcceptReinforce: true },
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  usage: {
    days: 7,
    sessionsPushed: 214,
    searches: 38,
    gets: 12,
    entries: [{ entryId: 'one', title: 'runner-go’s full suite inside a session reaches production', total: 41, pushed: 40, searched: 1, fetched: 0 }],
  },
};

const ENTRIES: WikiEntry[] = [
  entry({ kind: 'principle', title: 'A clock never starts agent work', topics: ['tasks-dispatch'] }),
  entry({ kind: 'principle', title: 'Delete means forget', topics: ['tasks-dispatch'] }),
  entry({ kind: 'decision', title: 'Wakeups are held by the server', topics: ['tasks-dispatch'], trust: 'confirmed', validFrom: '2026-09-22T00:00:00.000Z' }),
  entry({ kind: 'pitfall', title: 'Piping a test run into grep hides its exit code', topics: ['testing-ci'], trust: 'confirmed', validFrom: '2026-09-20T00:00:00.000Z' }),
];

const TIMELINE: WikiTimeline = {
  items: [
    {
      opId: 'op-one',
      op: 'add',
      decision: 'accepted',
      origin: 'agent',
      at: '2026-09-25T10:00:00.000Z',
      entryId: ENTRIES[2].id,
      title: 'Wakeups are held by the server',
      kind: 'decision',
      status: 'active',
      trust: 'confirmed',
      supersededById: null,
      supersededByTitle: null,
      reason: null,
    },
  ],
};

const REVIEW = [
  {
    id: 'changeset',
    spaceId: SPACE_ID,
    origin: 'agent',
    sessionId: '0196e000-0000-7000-8000-0000000000ff',
    toolCallId: null,
    rationale: 'Orbit wiki review',
    status: 'pending',
    createdAt: '2026-09-25T12:00:00.000Z',
    decidedAt: null,
    expiresAt: null,
    ops: [
      {
        id: 'op-pending',
        changesetId: 'changeset',
        seq: 0,
        op: 'add',
        entryId: null,
        baseRevision: null,
        payload: { entry: { kind: 'pitfall', title: 'Secret redaction lets ENV_VAR=value secrets through' } },
        similar: [],
        tainted: false,
        decision: 'pending',
        decisionReason: null,
        decisionNote: null,
        resultEntryId: null,
        resultRevision: null,
        decidedAt: null,
      },
    ],
  },
] as unknown as WikiChangeset[];

function paint(route: 'home' | 'topic', path: string, seeds: { entries?: WikiEntry[] } = {}): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['wiki', 'spaces'], [{ ...SPACE, pendingOps: 3 }]);
  client.setQueryData(['wiki', 'space', SPACE_ID], SPACE);
  client.setQueryData(['wiki', 'space', SPACE_ID, 'entries'], seeds.entries ?? ENTRIES);
  client.setQueryData(['wiki', 'space', SPACE_ID, 'timeline'], TIMELINE);
  client.setQueryData(['wiki', 'review', SPACE_ID], REVIEW);
  const topic = (seeds.entries ?? ENTRIES).filter((row) => row.topics.includes('tasks-dispatch'));
  client.setQueryData(['wiki', 'space', SPACE_ID, 'topic', 'tasks-dispatch'], {
    slug: 'tasks-dispatch',
    title: 'Tasks dispatch',
    description: null,
    declared: false,
    entryCount: topic.length,
    entries: topic,
  });
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        {/* The real route tree, because the params are the point: a topic's slug is read out of the
            URL here exactly as it is in `App.tsx`. */}
        <Routes>
          <Route path="/wiki" element={<WikiPage route="home" />} />
          <Route path="/wiki/review" element={<WikiPage route="review" />} />
          <Route path="/wiki/:space" element={<WikiPage route="home" />} />
          <Route path="/wiki/:space/t/:topic" element={<WikiPage route={route} />} />
          <Route path="/wiki/:space/e/:entry" element={<WikiPage route="entry" />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('the Wiki home', () => {
  it('draws the design’s blocks in the design’s order', () => {
    const html = paint('home', '/wiki/orbit');
    const at = (needle: string) => html.indexOf(needle);
    expect(at('>Principles<')).toBeGreaterThan(-1);
    expect(at('>Topics<')).toBeGreaterThan(at('>Principles<'));
    expect(at('>Recent decisions<')).toBeGreaterThan(at('>Topics<'));
    expect(at('>Review<')).toBeGreaterThan(at('>Recent decisions<'));
    expect(at('>Recently changed<')).toBeGreaterThan(at('>Review<'));
    expect(at('>Agents used the wiki<')).toBeGreaterThan(at('>Recently changed<'));
  });

  it('opens with the space’s own numbers and closes the decision log with a way into it', () => {
    const html = paint('home', '/wiki/orbit');
    expect(html).toContain('4</b> entries');
    expect(html).toContain('3</b> to review');
    expect(html).toContain('Anchors verified at bbbbbbb');
    expect(html).toContain('All decisions ›');
  });

  it('counts each topic from the entries that carry it, and links to it', () => {
    const html = paint('home', '/wiki/orbit');
    expect(html).toContain('/wiki/orbit/t/tasks-dispatch');
    expect(html).toContain('/wiki/orbit/t/testing-ci');
    // The two principles and the decision are filed under one topic, the pitfall under the other.
    expect(html).toContain('>Tasks dispatch</span><span class="wk-topic-c">3</span>');
    expect(html).toContain('>Testing ci</span><span class="wk-topic-c">1</span>');
  });

  it('leads the rail with what is waiting, and says how old it is', () => {
    const html = paint('home', '/wiki/orbit');
    expect(html).toContain('Secret redaction lets ENV_VAR=value secrets through');
    expect(html).toContain('1 proposal from 1 session');
    expect(html).toContain('oldest');
  });

  it('says what the agents did with it, and puts the most used entry first', () => {
    const html = paint('home', '/wiki/orbit');
    expect(html).toContain('>214<');
    expect(html).toContain('sessions received wiki context');
    expect(html).toContain('>38<');
    expect(html).toContain('>41×<');
  });

  it('says nothing has used the wiki rather than drawing an empty meter', () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(['wiki', 'space', SPACE_ID, 'entries'], []);
    client.setQueryData(['wiki', 'space', SPACE_ID, 'timeline'], { items: [] });
    client.setQueryData(['wiki', 'review', SPACE_ID], []);
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <WikiHome space={{ ...SPACE, usage: undefined }} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(html).toContain('No session has used this wiki yet.');
    expect(html).toContain('No decision has been recorded yet.');
  });
});

describe('a topic page', () => {
  it('names itself, counts its entries, and groups them by kind', () => {
    const html = paint('topic', '/wiki/orbit/t/tasks-dispatch');
    expect(html).toContain('Tasks dispatch');
    expect(html).toContain('3 entries');
    expect(html).toContain('Principles &amp; conventions');
    expect(html).toContain('Decisions');
  });

  it('carries the three trailing facts the design’s columns are named for', () => {
    const html = paint('topic', '/wiki/orbit/t/tasks-dispatch');
    expect(html).toContain('Confirmed by');
    expect(html).toContain('Anchor');
    expect(html).toContain('This week');
    // The trust badge, the anchor's ref and the use count, on a row that has all three.
    expect(html).toContain('tone-owner');
    expect(html).toContain('aaaaaaa');
  });

  it('keeps a superseded entry, struck through, naming what replaced it', () => {
    const successor = entry({ kind: 'decision', title: 'Project DONE is a projection, not a gate' });
    const retired = entry({
      kind: 'decision',
      title: 'Projects close through an acceptance DONE gate',
      status: 'superseded',
      supersededById: successor.id,
    });
    const html = paint('topic', '/wiki/orbit/t/tasks-dispatch', { entries: [successor, retired] });
    expect(html).toContain('Projects close through an acceptance DONE gate');
    expect(html).toContain('Superseded by');
    expect(html).toContain('Project DONE is a projection, not a gate');
    expect(html).toContain('no longer sent to agents');
    expect(html).toContain('wk-erow sup');
  });
});
