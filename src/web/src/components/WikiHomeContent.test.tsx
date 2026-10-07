// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { App as AntApp } from 'antd';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WikiDocsDirectory } from '@orbit/shared';
import type { WikiEntry } from '../lib/wiki';
import { wikiSeenKey } from '../lib/wiki';
import { WikiPage } from '../pages/WikiPage';

/**
 * The Wiki home as content (design §12.3.1, mocks 30 ③ and 31 ① ③ ⑦), driven through the real routes
 * against a fake `/api`: the confirmed plan's documents by category — a written one's number, title and
 * lead, a blue dot on one written since the reader last looked, the rest folded one row a category and
 * opened to their titles — the principles with `All N ›`, the ways to Browse and the A–Z index, and grey
 * bars only while the first read is out.
 *
 * The documents are titled as the live orbit plan's (mocks 29–30); the leads are the ones mock 30 draws.
 */

const SPACE_ID = '0196e200-0000-7000-8000-000000000001';
const SPACE = {
  id: SPACE_ID,
  slug: 'orbit',
  title: 'github-com-jianghailong-xy-orbit',
  repoUrlNorm: 'github.com/jianghailong-xy/orbit',
  rootCommitSha: null,
  settings: { maintenance: { enabled: true } },
  createdAt: '2026-09-20T00:00:00.000Z',
  updatedAt: '2026-10-06T00:00:00.000Z',
  pendingOps: 1,
  planWaiting: 0,
  workspaceIds: [],
  docs: { written: 5, total: 13 },
};

/** Written the day before the reader last looked, and the two since. */
const BEFORE = '2026-10-04T08:00:00.000Z';
const LOOKED = Date.parse('2026-10-05T08:00:00.000Z');
const SINCE = '2026-10-06T08:00:00.000Z';

function doc(number: string, title: string, lead?: string, updatedAt = BEFORE): WikiDocsDirectory['categories'][number]['docs'][number] {
  return {
    slug: `d${number.replace('.', '-')}`,
    number,
    title,
    question: `What ${title} is for`,
    written: lead !== undefined,
    status: lead !== undefined ? 'ok' : null,
    updatedAt: lead !== undefined ? updatedAt : null,
    planVersion: lead !== undefined ? 13 : null,
    lead: lead ?? null,
    sections: [],
  };
}

const category = (number: number, title: string, docs: WikiDocsDirectory['categories'][number]['docs']) => ({
  key: `c${number}`,
  number,
  title,
  question: `What ${title} covers`,
  forAgents: false,
  docs,
});

const DOCS: WikiDocsDirectory = {
  spaceId: SPACE_ID,
  plan: { version: 13, confirmedAt: '2026-10-03T00:00:00.000Z' },
  docs: { total: 13, written: 5 },
  categories: [
    category(1, '产品概览与架构', [
      doc('1.1', '产品定位与核心能力', 'Orbit 是自托管的 coding agent 控制台：agent 跑在你自己的机器上，计划、历史和控制都留在一个自托管的地方。'),
      doc('1.2', '系统架构与数据流', 'Orbit 把协调和执行分开：服务器保存意图与历史，注册的 runner 在本来就有仓库、凭据和网络权限的机器上跑 agent 进程。'),
      doc('1.3', '自部署与首次运行'),
    ]),
    category(2, '任务与项目', [
      doc('2.1', '任务生命周期与依赖', '任务是持久的排队工作单元：可以归进清单、依赖别的任务；合格的 runner 原子地领取它，开一个会话，再回报结果。'),
      doc('2.2', '项目启动与协调'),
      doc('2.3', '完成判据与验收'),
      doc('2.4', '项目集成线与落地'),
    ]),
    category(3, '会话与交互', [
      doc('3.1', 'Session 运行与恢复', 'session 是一个 runner 上、一个 agent runtime 的可恢复多轮会话：用户的回合先存后投，runner 长轮询领取、交给 runtime，再上传归一化事件。', SINCE),
      doc('3.2', '实时流与推送', '客户端从每个会话的 SSE 流拿转录事件；用户级控制面流把各处的变化推给所有在线的客户端。', SINCE),
      doc('3.3', 'Session 搜索与消息路由'),
    ]),
    category(4, 'Runner 与运行时', [doc('4.1', 'Runner 注册与排障'), doc('4.2', '引擎接入与 provider 管理'), doc('4.3', 'Runner CLI 与自动化')]),
  ],
};

function principle(n: number): WikiEntry {
  const at = `2026-09-${String(n).padStart(2, '0')}T12:00:00.000Z`;
  return {
    id: `0196e200-0000-7000-8000-${String(100 + n).padStart(12, '0')}`,
    spaceId: SPACE_ID,
    kind: 'principle',
    status: 'active',
    trust: 'owner',
    currentRevision: 1,
    title: `Principle ${n}`,
    summary: '',
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
    pinned: true,
    supersedesId: null,
    supersededById: null,
    validFrom: at,
    validTo: null,
    recordedAt: at,
    retiredAt: null,
  } as WikiEntry;
}

let principles: WikiEntry[] = [];
let docsAnswer: () => Promise<WikiDocsDirectory> = async () => DOCS;
const reads: string[] = [];
const local = new Map<string, string>();

const reply = (status: number, body: unknown): Response =>
  ({ ok: status < 400, status, statusText: '', text: async () => JSON.stringify(body), json: async () => body }) as unknown as Response;

async function serve(url: string): Promise<Response> {
  const [path, search = ''] = url.split('?');
  const space = `/api/wiki/spaces/${SPACE_ID}`;
  reads.push(url);
  if (path === '/api/wiki/spaces') return reply(200, [SPACE]);
  if (path === space) return reply(200, SPACE);
  if (path === `${space}/docs`) return reply(200, await docsAnswer());
  if (path === `${space}/articles`) return reply(200, { spaceId: SPACE_ID, categories: [], uncategorized: [] });
  if (path === `${space}/entries` && new URLSearchParams(search).get('kind') === 'principle') return reply(200, principles);
  return reply(404, { message: `${url} is not in this fixture` });
}

let container: HTMLDivElement;
let root: Root;
let mounted = false;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  principles = [];
  docsAnswer = async () => DOCS;
  reads.length = 0;
  local.clear();
  vi.stubGlobal('ResizeObserver', class { observe(): void {} unobserve(): void {} disconnect(): void {} });
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: /max-width/.test(query), media: query, onchange: null, addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }));
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => local.get(key) ?? null,
    setItem: (key: string, value: string) => void local.set(key, value),
    removeItem: (key: string) => void local.delete(key),
  });
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

async function settle(): Promise<void> {
  for (let tick = 0; tick < 8; tick += 1) {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  }
}

/** The home of `orbit`, as a fresh page — or, given the client the last one read with, as a visit after it. */
async function open(client = new QueryClient({ defaultOptions: { queries: { retry: false } } })): Promise<QueryClient> {
  if (mounted) {
    act(() => root.unmount());
    root = createRoot(container);
  }
  mounted = true;
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/wiki/orbit']}>
          <AntApp>
            <Routes>
              <Route path="/wiki/:space" element={<WikiPage route="home" />} />
            </Routes>
          </AntApp>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await settle();
  return client;
}

const words = (node: Element | null | undefined): string => node?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
const all = (selector: string, scope: ParentNode = container): Element[] => [...scope.querySelectorAll(selector)];
const home = (): Element => container.querySelector('.wk-home')!;
const categories = (): Element[] => all('.wk-home > section.wk-pl-cat:not(.wk-home-pr)');
const press = async (node: Element | null | undefined): Promise<void> => {
  expect(node).toBeTruthy();
  await act(async () => (node as HTMLElement).click());
  await settle();
};

describe('the Wiki home, by the confirmed plan', () => {
  it('says under its head how many documents there are and how many are written', async () => {
    await open();
    expect(words(container.querySelector('.wk-home-state'))).toBe('13 documents · 5 written');
    // Under the head, before the search: the line the status row stood in.
    const order = ['.wk-title-row', '.wk-home-state', '.wk-search', '.wk-layout'].map((selector) =>
      [...container.querySelector('.wk-page')!.children].findIndex((child) => child.matches(selector)),
    );
    expect(order).toEqual([0, 1, 2, 3]);
  });

  it('lists the documents by category: each written one with its number, title and lead, into its page', async () => {
    await open();
    expect(categories().map((section) => `${words(section.querySelector('.wk-pl-cat-h .no'))} ${words(section.querySelector('.wk-pl-cat-h b'))}`)).toEqual([
      '1 产品概览与架构',
      '2 任务与项目',
      '3 会话与交互',
      '4 Runner 与运行时',
    ]);
    const [first] = categories();
    const rows = all('a.wk-pl-doc', first);
    expect(rows.map((row) => [words(row.querySelector('.no')), words(row.querySelector('.tt'))])).toEqual([
      ['1.1', '产品定位与核心能力'],
      ['1.2', '系统架构与数据流'],
    ]);
    expect(rows[0].getAttribute('href')).toBe('/wiki/orbit/d/d1-1');
    // The second line is the document's lead — a shade darker than the plan's question — not its question.
    expect(rows[0].querySelector('.q')?.className).toBe('q lead');
    expect(words(rows[0].querySelector('.q.lead'))).toBe(DOCS.categories[0].docs[0].lead);
    expect(words(home())).not.toContain('What 产品定位与核心能力 is for');
    expect(rows[0].querySelector('.chev')).toBeTruthy();
  });

  it('folds what is not written yet into one row a category, saying how many', async () => {
    await open();
    expect(categories().map((section) => words(section.querySelector('.wk-pl-doc.more .q')))).toEqual([
      '+1 not written yet',
      '+3 not written yet',
      '+1 not written yet',
      '3 documents · Not written yet',
    ]);
    // A category none of whose documents is written is that one row alone.
    expect(all('a.wk-pl-doc', categories()[3])).toHaveLength(0);
  });

  it('opens a folded row to the titles not written yet, in grey, and closes it again', async () => {
    await open();
    const tasks = categories()[1];
    const fold = tasks.querySelector('.wk-pl-doc.more')!;
    expect(fold.getAttribute('aria-expanded')).toBe('false');
    await press(fold);
    expect(fold.getAttribute('aria-expanded')).toBe('true');
    const todo = all('a.wk-pl-doc.todo', tasks);
    expect(todo.map((row) => [words(row.querySelector('.no')), words(row.querySelector('.tt')), words(row.querySelector('.q'))])).toEqual([
      ['2.2', '项目启动与协调', 'Not written yet'],
      ['2.3', '完成判据与验收', 'Not written yet'],
      ['2.4', '项目集成线与落地', 'Not written yet'],
    ]);
    expect(todo[0].getAttribute('href')).toBe('/wiki/orbit/d/d2-2');
    // The others stay folded.
    expect(all('a.wk-pl-doc.todo', categories()[0])).toHaveLength(0);
    await press(fold);
    expect(all('a.wk-pl-doc.todo', tasks)).toHaveLength(0);
  });

  it('marks with a blue dot the documents written since the reader last looked, and moves the stamp', async () => {
    local.set(wikiSeenKey('orbit', 'home'), String(LOOKED));
    await open();
    const fresh = all('a.wk-pl-doc', home()).filter((row) => row.querySelector('.t > .wk-new'));
    expect(fresh.map((row) => words(row.querySelector('.no')))).toEqual(['3.1', '3.2']);
    expect(Number(local.get(wikiSeenKey('orbit', 'home')))).toBeGreaterThan(LOOKED);
    // Looked at now: on the next visit nothing is new.
    await open();
    expect(home().querySelectorAll('.wk-new')).toHaveLength(0);
  });

  it('ends on Browse by category and the A–Z index', async () => {
    await open();
    const more = home().lastElementChild!;
    expect(more.className).toBe('wk-home-more');
    expect(all('a', more).map((link) => [words(link), link.getAttribute('href')])).toEqual([
      ['Browse by category', '/wiki/orbit/browse'],
      ['A–Z index', '/wiki/orbit/az'],
    ]);
  });

  it('reads nothing of how the wiki is kept: no review, no timeline, no decisions, no health', async () => {
    await open();
    expect(reads.filter((url) => /\/review|\/timeline|kind=decision|\/health/.test(url))).toEqual([]);
    expect(container.querySelector('.wk-status-row, .wk-banner, .wk-card')).toBeNull();
  });
});

describe('the home’s principles (mock 31 ③)', () => {
  it('lists the first three before the documents, then All N ›, which lists the rest', async () => {
    principles = [6, 5, 4, 3, 2, 1].map(principle);
    await open();
    const group = home().firstElementChild!;
    expect(group.className).toBe('wk-pl-cat wk-home-pr');
    expect([...group.querySelector('.wk-pl-cat-h')!.children].map((part) => words(part))).toEqual(['Principles', '6', 'Owner', 'All 6 ›']);
    // Oldest recorded first, as the set is read; each its title, its day, and a way into the entry.
    const rows = (): Element[] => all('a.wk-pl-doc.pr', group);
    expect(rows().map((row) => words(row.querySelector('.tt')))).toEqual(['Principle 1', 'Principle 2', 'Principle 3']);
    expect(words(rows()[0].querySelector('.d'))).toBe('9/1');
    expect(rows()[0].getAttribute('href')).toMatch(/^\/wiki\/orbit\/e\//);
    await press(group.querySelector('.wk-home-all'));
    expect(rows().map((row) => words(row.querySelector('.tt')))).toEqual([1, 2, 3, 4, 5, 6].map((n) => `Principle ${n}`));
    expect(group.querySelector('.wk-home-all')).toBeNull();
  });

  it('says no All when there are three or fewer', async () => {
    principles = [principle(1), principle(2)];
    await open();
    expect(all('a.wk-pl-doc.pr')).toHaveLength(2);
    expect(container.querySelector('.wk-home-all')).toBeNull();
  });
});

describe('the home’s first read (design §12.3.6, mock 31 ⑦)', () => {
  it('draws the head at once and grey bars for the line and the documents, never a spinner over the page', async () => {
    let answer: (directory: WikiDocsDirectory) => void = () => {};
    docsAnswer = () => new Promise((resolve) => (answer = resolve));
    const client = await open();
    expect(words(container.querySelector('.wk-title-row .wk-space-tag'))).toBe('orbit');
    expect(words(container.querySelector('.wk-activity-btn .tp-rail-badge'))).toBe('1');
    expect(container.querySelector('.wk-home-state .wk-sk')).toBeTruthy();
    expect(container.querySelector('.wk-home-sk')?.getAttribute('aria-busy')).toBe('true');
    expect(all('.wk-home-sk .wk-pl-doc')).toHaveLength(4);
    expect(container.querySelector('.ant-spin')).toBeNull();
    await act(async () => answer(DOCS));
    await settle();
    expect(container.querySelector('.wk-sk')).toBeNull();
    expect(words(container.querySelector('.wk-home-state'))).toBe('13 documents · 5 written');
    // The next visit draws what it read last at once, while it reads again.
    docsAnswer = () => new Promise(() => undefined);
    await open(client);
    expect(container.querySelector('.wk-sk')).toBeNull();
    expect(categories()).toHaveLength(4);
  });
});
