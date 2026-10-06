import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WikiActivityPage } from '../components/WikiActivityPage';
import type { WikiArticleDirectory, WikiDocsDirectory } from '@orbit/shared';
import type { WikiChangeset, WikiEntry, WikiSpaceWithUsage, WikiTimeline } from '../lib/wiki';
import { WIKI_DISABLED_NOTE, WIKI_NO_ENTRIES, WIKI_NO_PRINCIPLES, WIKI_NO_SPACES } from '../lib/wiki';
import { WIKI_NO_DOCUMENTS, WIKI_NO_DOCUMENTS_NOTE } from '../lib/wikiDocs';
import { WIKI_FROM_WORKSPACE_KEY, WIKI_LAST_SPACE_KEY, wikiWaiting } from '../lib/wikiSpace';
import { WikiPage } from './WikiPage';

// The browser's storage, which the space `/wiki` opens reads: the workspace this tab came from and the
// space last looked at. Empty unless a test fills it.
const browser = vi.hoisted(() => {
  const store = () => {
    const items = new Map<string, string>();
    return {
      items,
      storage: {
        getItem: (key: string) => items.get(key) ?? null,
        setItem: (key: string, value: string) => void items.set(key, value),
        removeItem: (key: string) => void items.delete(key),
      },
    };
  };
  const local = store();
  const session = store();
  vi.stubGlobal('localStorage', local.storage);
  vi.stubGlobal('sessionStorage', session.storage);
  return { local: local.items, session: session.items };
});

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  api: () => new Promise(() => undefined),
}));

/**
 * The Wiki's pages, from a fixture: the home's bands in the design's order, and a topic page's rows
 * carrying the three trailing facts.
 *
 * WHAT THE ORDER IS FOR: the home is what the codebase's wiki says, read top-down (design §12.3.1, mock
 * 30 ③) — the line under the head saying what it holds, the search, the principles the rest is judged
 * against, the documents by category, and the ways to Browse and the A–Z index — with the category
 * directory beside it all. How the wiki is kept is Activity's. Both clients draw that order and iOS
 * mirrors it band for band, so it is asserted here rather than left to a screenshot.
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

const DIRECTORY: WikiArticleDirectory = {
  spaceId: SPACE_ID,
  categories: [
    {
      key: 'platform',
      title: 'Platform core',
      topics: [
        {
          slug: 'tasks-dispatch',
          title: '任务与派发',
          description: null,
          category: 'platform',
          article: { part: 0, kind: 'article', title: '任务派发与验收', entryCount: 795, generatedAt: '2026-09-27T00:00:00.000Z' },
          parts: [],
        },
      ],
    },
  ],
  uncategorized: [],
};

/**
 * The space's documents as the docs read answers them, titled as the live orbit plan's (mocks 29–30): a
 * category with two written of three, one with one of four, one with none written yet.
 */
function doc(number: string, title: string, lead: string | null = null): WikiDocsDirectory['categories'][number]['docs'][number] {
  return {
    slug: `doc-${number.replace('.', '-')}`,
    number,
    title,
    question: `What ${number} answers`,
    written: lead !== null,
    status: lead !== null ? 'ok' : null,
    updatedAt: lead !== null ? '2026-10-06T08:00:00.000Z' : null,
    planVersion: lead !== null ? 13 : null,
    lead,
    sections: [],
  };
}

const DOCS: WikiDocsDirectory = {
  spaceId: SPACE_ID,
  plan: { version: 13, confirmedAt: '2026-10-05T00:00:00.000Z' },
  docs: { total: 10, written: 3 },
  categories: [
    {
      key: 'overview',
      number: 1,
      title: '产品概览与架构',
      question: 'What is Orbit?',
      forAgents: false,
      docs: [
        doc('1.1', '产品定位与核心能力', 'Orbit 是自托管的 coding agent 控制台：agent 跑在你自己的机器上，计划、历史和控制都留在一个自托管的地方。'),
        doc('1.2', '系统架构与数据流', 'Orbit 把协调和执行分开：服务器保存意图与历史，注册的 runner 在本来就有仓库、凭据和网络权限的机器上跑 agent 进程。'),
        doc('1.3', '自部署与首次运行'),
      ],
    },
    {
      key: 'tasks',
      number: 2,
      title: '任务与项目',
      question: 'How does work get done?',
      forAgents: false,
      docs: [
        doc('2.1', '任务生命周期与依赖', '任务是持久的排队工作单元：可以归进清单、依赖别的任务；合格的 runner 原子地领取它，开一个会话，再回报结果。'),
        doc('2.2', '项目启动与协调'),
        doc('2.3', '完成判据与验收'),
        doc('2.4', '项目集成线与落地'),
      ],
    },
    {
      key: 'runner',
      number: 3,
      title: 'Runner 与运行时',
      question: 'Where does an agent run?',
      forAgents: false,
      docs: [doc('3.1', 'Runner 注册与排障'), doc('3.2', '引擎接入与 provider 管理'), doc('3.3', 'Runner CLI 与自动化')],
    },
  ],
};

const NO_DOCS: WikiDocsDirectory = { spaceId: SPACE_ID, plan: null, docs: { total: 0, written: 0 }, categories: [] };

function paint(
  route: 'home' | 'topic',
  path: string,
  seeds: { entries?: WikiEntry[]; spaces?: unknown; docs?: WikiDocsDirectory; articles?: WikiArticleDirectory } = {},
): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['wiki', 'spaces'], 'spaces' in seeds ? seeds.spaces : [{ ...SPACE, pendingOps: 3 }]);
  client.setQueryData(['wiki', 'space', SPACE_ID], SPACE);
  client.setQueryData(['wiki', 'space', SPACE_ID, 'entries'], seeds.entries ?? ENTRIES);
  // The home's two bands read their own kind (`wikiEntriesOfKindQuery`).
  const ofKind = (kind: string) => (seeds.entries ?? ENTRIES).filter((row) => row.kind === kind);
  client.setQueryData(['wiki', 'space', SPACE_ID, 'entries', 'principle', 200], ofKind('principle'));
  client.setQueryData(['wiki', 'space', SPACE_ID, 'entries', 'decision', 4], ofKind('decision'));
  client.setQueryData(['wiki', 'space', SPACE_ID, 'timeline'], TIMELINE);
  client.setQueryData(['wiki', 'review', SPACE_ID], REVIEW);
  const topic = (seeds.entries ?? ENTRIES).filter((row) => row.topics.includes('tasks-dispatch'));
  // No article yet for the topic: its page is its entries alone (`WikiArticleRoute`).
  client.setQueryData(['wiki', 'space', SPACE_ID, 'article', 'tasks-dispatch', 0], null);
  client.setQueryData(['wiki', 'space', SPACE_ID, 'articles'], seeds.articles ?? DIRECTORY);
  // The home's documents; left out, their first read is still out.
  if (seeds.docs) client.setQueryData(['wiki', 'space', SPACE_ID, 'docs'], seeds.docs);
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
          <Route path="/wiki/:space/activity" element={<WikiPage route="activity" />} />
          <Route path="/wiki/:space/t/:topic" element={<WikiPage route={route} />} />
          <Route path="/wiki/:space/t/:topic/:part" element={<WikiPage route={route} />} />
          <Route path="/wiki/:space/e/:entry" element={<WikiPage route="entry" />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('the Wiki home', () => {
  it('draws the design’s bands in the design’s order: the line under the head, the search, Principles, the documents, Browse · A–Z', () => {
    const html = paint('home', '/wiki/orbit', { docs: DOCS });
    const order = [
      '<h1 class="page-title">Wiki</h1>',
      'class="wk-home-state"',
      'class="wk-search"',
      'class="wk-dir-col"',
      '<b>Principles</b>',
      '<span class="no">1</span><b>产品概览与架构</b>',
      '<span class="no">2</span><b>任务与项目</b>',
      '<span class="no">3</span><b>Runner 与运行时</b>',
      'class="wk-home-more"',
    ].map((needle) => {
      const at = html.indexOf(needle);
      expect(at, needle).toBeGreaterThan(-1);
      return at;
    });
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // The topics are the directory beside the page, not a grid of their own (mock 11 ③).
    expect(html).not.toContain('>Topics<');
  });

  it('draws nothing of how the wiki is kept: that is Activity’s', () => {
    const html = paint('home', '/wiki/orbit', { docs: DOCS });
    for (const block of ['wk-status-row', 'wk-banner', 'wk-review-card', 'wk-plan-card', 'wk-cols', '>Recent decisions<', '>Recently changed<', '>Agents used the wiki<', 'Anchors verified at', 'to review']) {
      expect(html, block).not.toContain(block);
    }
  });

  it('says under its head how many documents the plan has and how many are written', () => {
    const html = paint('home', '/wiki/orbit', { docs: DOCS });
    expect(html).toContain('<div class="wk-home-state">10 documents · 3 written</div>');
  });

  it('lists each topic in the directory with the entries its article was written from, and links to it', () => {
    const html = paint('home', '/wiki/orbit');
    expect(html).toContain('href="/wiki/orbit/t/tasks-dispatch"');
    expect(html).toContain('<div class="wk-toc-cat">Platform core</div>');
    expect(html).toContain('<span class="lb">任务与派发</span><span class="n">795</span>');
  });

  it('draws the principles their own read answered, and none of the decisions', () => {
    const html = paint('home', '/wiki/orbit', { docs: DOCS });
    expect(html).toContain('A clock never starts agent work');
    expect(html).toContain('Delete means forget');
    expect(html).toContain('<span class="wk-home-n">2</span>');
    expect(html).not.toContain('Wakeups are held by the server');
    expect(html).not.toContain(WIKI_NO_PRINCIPLES);
  });

  it('draws no Principles at all when there is none, and says nothing for them', () => {
    const html = paint('home', '/wiki/orbit', { docs: DOCS, entries: ENTRIES.filter((row) => row.kind !== 'principle') });
    expect(html).not.toContain('Principles');
    expect(html).not.toContain(WIKI_NO_PRINCIPLES);
    expect(html).not.toContain(WIKI_NO_ENTRIES);
  });

  it('draws the head from the spaces list and grey bars for the rest while the first read is out (mock 31 ⑦)', () => {
    const html = paint('home', '/wiki/orbit', { spaces: [{ ...SPACE, pendingOps: 3 }] });
    expect(html).toContain('<span class="wk-space-tag" title="The codebase this wiki describes">orbit</span>');
    expect(html).toContain('title="3 waiting on you"');
    expect(html).toContain('<div class="wk-home-state"><span class="wk-sk" aria-hidden="true"></span></div>');
    expect(html).toContain('class="wk-pl-cat wk-home-sk" aria-busy="true"');
    expect(html).not.toContain('class="wk-home-more"');
    expect(html).not.toContain(WIKI_NO_SPACES);
  });

  it('says nothing of the spaces while their list is still out, opened by its address', () => {
    const html = paint('home', '/wiki/orbit', { spaces: undefined });
    expect(html).toContain('<h1 class="page-title">Wiki</h1>');
    expect(html).not.toContain(WIKI_NO_SPACES);
  });
});

describe('a new space, with no document and no maintenance (mock 31 ⑥)', () => {
  const empty: WikiArticleDirectory = { spaceId: SPACE_ID, categories: [], uncategorized: [] };

  it('says it has no documents yet, and draws one card: why, and the way to set maintenance up', () => {
    const html = paint('home', '/wiki/orbit', { docs: NO_DOCS, articles: empty, entries: ENTRIES.filter((row) => row.kind !== 'principle') });
    expect(html).toContain(`<div class="wk-home-state">${WIKI_NO_DOCUMENTS}</div>`);
    expect(html).toMatch(new RegExp(`<div class="wk-home-new"><p>${WIKI_NO_DOCUMENTS_NOTE}</p><a href="/wiki/orbit/settings"[^>]*>Set up maintenance ›</a></div>`));
    expect(html).not.toContain('class="wk-home-more"');
    expect(html).not.toContain('wk-pl-cat');
  });

  it('draws no card once its maintenance is set up: only that it has none yet', () => {
    const kept = { ...SPACE, pendingOps: 0, settings: { ...SPACE.settings, maintenance: { enabled: true } } };
    const html = paint('home', '/wiki/orbit', { docs: NO_DOCS, articles: empty, spaces: [kept] });
    expect(html).toContain(`<div class="wk-home-state">${WIKI_NO_DOCUMENTS}</div>`);
    expect(html).not.toContain('wk-home-new');
  });
});

describe('Activity, which took the home’s other blocks', () => {
  it('leads with what is waiting, and says how old it is', () => {
    const html = paint('home', '/wiki/orbit/activity');
    expect(html).toContain('Secret redaction lets ENV_VAR=value secrets through');
    expect(html).toContain('1 proposal from 1 session');
    expect(html).toContain('oldest');
    expect(html).toContain('Wakeups are held by the server');
    expect(html).toContain('All decisions ›');
  });

  it('says nothing has used the wiki rather than drawing an empty meter', () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(['wiki', 'space', SPACE_ID], { ...SPACE, usage: undefined });
    client.setQueryData(['wiki', 'space', SPACE_ID, 'entries'], []);
    client.setQueryData(['wiki', 'space', SPACE_ID, 'entries', 'decision', 4], []);
    client.setQueryData(['wiki', 'space', SPACE_ID, 'timeline'], { items: [] });
    client.setQueryData(['wiki', 'review', SPACE_ID], []);
    const row = { ...SPACE, pendingOps: 0 };
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <WikiActivityPage space={row} spaces={[row]} status={null} />
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

describe('the Wiki, for an account the server has not switched it on for', () => {
  it('says so on every route, instead of drawing a wiki with nothing in it', () => {
    for (const path of ['/wiki', '/wiki/orbit', '/wiki/review', '/wiki/orbit/t/tasks-dispatch']) {
      const html = paint('topic', path, { spaces: null });
      expect(html, path).toContain(WIKI_DISABLED_NOTE);
      expect(html, path).not.toContain(WIKI_NO_SPACES);
      expect(html, path).not.toContain('>Principles<');
    }
  });
});

/**
 * The head (design §12.3.1, §12.3.4, mocks 30 ③ and 31 ④): `Wiki`, the space, Contents, Activity with
 * the number waiting on the owner, Settings and New entry. One space is a label; several are a select.
 */
const WIKOVA_ID = '0196e000-0000-7000-8000-0000000000b2';
const WIKIDS_ID = '0196e000-0000-7000-8000-0000000000b3';
const THREE_SPACES = [
  { ...SPACE, pendingOps: 2, planWaiting: 1, workspaceIds: ['ws-orbit-develop'], docs: { written: 5, total: 35 } },
  {
    ...SPACE,
    id: WIKOVA_ID,
    slug: 'wikova',
    title: 'github-com-jianghailong-xy-wikova',
    repoUrlNorm: 'github.com/jianghailong-xy/wikova',
    pendingOps: 1,
    planWaiting: 3,
    workspaceIds: ['ws-wikova-develop'],
    docs: { written: 12, total: 12 },
  },
  {
    ...SPACE,
    id: WIKIDS_ID,
    slug: 'wikids',
    title: 'github-com-jianghailong-xy-wikids',
    repoUrlNorm: 'github.com/jianghailong-xy/wikids',
    pendingOps: 0,
    planWaiting: 0,
    workspaceIds: [],
    docs: null,
  },
];

describe('the Wiki head', () => {
  it('names a lone space by its repository, as a label with nothing to choose', () => {
    const html = paint('home', '/wiki/orbit');
    expect(html).toContain('<span class="wk-space-tag" title="The codebase this wiki describes">orbit</span>');
    expect(html).not.toContain('<select');
  });

  it('offers a native select over several, closed on the name, each option saying what waits in it', () => {
    const html = paint('home', '/wiki/orbit', { spaces: THREE_SPACES });
    expect(html).toContain('<span class="v">orbit</span>');
    expect(html).toContain('<option value="orbit" selected="">orbit · 3 waiting</option>');
    expect(html).toContain('<option value="wikova">wikova · 4 waiting</option>');
    expect(html).toContain('<option value="wikids">wikids</option>');
    expect(html).not.toContain('wk-space-tag');
  });

  it('puts Contents, Activity, Settings and New entry in that order, Activity carrying every space’s number', () => {
    const html = paint('home', '/wiki/orbit', { spaces: THREE_SPACES });
    const at = (needle: string) => html.indexOf(needle);
    expect(at('wk-contents-btn')).toBeGreaterThan(-1);
    expect(at('wk-activity-btn')).toBeGreaterThan(at('wk-contents-btn'));
    expect(at('aria-label="Settings"')).toBeGreaterThan(at('wk-activity-btn'));
    expect(at('aria-label="New entry"')).toBeGreaterThan(at('aria-label="Settings"'));
    expect(wikiWaiting(THREE_SPACES)).toBe(7);
    expect(html).toContain('class="tp-rail-badge needs-you" title="7 waiting on you" aria-label="7 waiting on you">7</span>');
  });

  it('draws no badge at zero', () => {
    const html = paint('home', '/wiki/orbit', { spaces: [{ ...SPACE, pendingOps: 0, planWaiting: 0 }] });
    expect(html).toContain('wk-activity-btn');
    expect(html).not.toContain('tp-rail-badge');
  });
});

describe('the space /wiki opens (design §12.3.4)', () => {
  beforeEach(() => {
    browser.local.clear();
    browser.session.clear();
  });

  const opened = (path = '/wiki'): string | null =>
    paint('home', path, { spaces: THREE_SPACES }).match(/<option value="([^"]+)" selected="">/)?.[1] ?? null;

  it('is the one bound to the workspace the reader came from, ahead of the last one looked at', () => {
    browser.session.set(WIKI_FROM_WORKSPACE_KEY, 'ws-wikova-develop');
    browser.local.set(WIKI_LAST_SPACE_KEY, 'orbit');
    expect(opened()).toBe('wikova');
  });

  it('else the one last looked at', () => {
    browser.session.set(WIKI_FROM_WORKSPACE_KEY, 'ws-bound-to-nothing');
    browser.local.set(WIKI_LAST_SPACE_KEY, 'wikids');
    expect(opened()).toBe('wikids');
  });

  it('else the one with the most documents written', () => {
    expect(opened()).toBe('wikova');
  });

  it('is never asked when the URL names a space', () => {
    browser.session.set(WIKI_FROM_WORKSPACE_KEY, 'ws-wikova-develop');
    expect(opened('/wiki/orbit')).toBe('orbit');
  });
});
