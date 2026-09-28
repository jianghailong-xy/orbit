// @vitest-environment jsdom
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { App as AntApp } from 'antd';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WikiArticleDirectory, WikiArticleIndex, WikiArticleView, WikiEntry } from '@orbit/shared';
import { encodeId } from '../lib/idCodec';
import { WikiPage } from '../pages/WikiPage';

/**
 * The article-first Wiki (criterion 10, mocks 11–16), driven through the real routes: a topic's
 * article with its footnotes and entries, a footnote's card as a popover on a desktop and a sheet on
 * a phone, the directory beside the page and the phone's Contents drawer, Browse by category, the A–Z
 * index, and the home's Review bar where the Topics grid used to be.
 *
 * The directory and the index are the shared fixture's (`wiki-articles.fixture.json`), which OrbitKit
 * is held to as well.
 */

interface Shared {
  directory: { read: WikiArticleDirectory };
  index: { items: WikiArticleIndex['items'] };
}

function shared(): Shared {
  const path = [
    resolve(process.cwd(), '../shared/src/wiki-articles.fixture.json'),
    resolve(process.cwd(), 'src/shared/src/wiki-articles.fixture.json'),
  ].find((candidate) => existsSync(candidate))!;
  return JSON.parse(readFileSync(path, 'utf8')) as Shared;
}

const SHARED = shared();
const SPACE_ID = '0196f000-0000-7000-8000-000000000001';
const SPACE = {
  id: SPACE_ID,
  slug: 'orbit',
  title: 'orbit',
  repoUrlNorm: 'github.com/jianghailong-xy/orbit',
  rootCommitSha: 'b'.repeat(40),
  settings: {},
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  pendingOps: 2,
};

let counter = 0;
const uuid = (): string => `0196f000-0000-7000-8000-${String(++counter).padStart(12, '0')}`;

function entry(over: Partial<WikiEntry>): WikiEntry {
  return {
    id: uuid(),
    spaceId: SPACE_ID,
    kind: 'convention',
    status: 'active',
    trust: 'auto',
    currentRevision: 1,
    title: 'An entry',
    summary: 'What it says.',
    fields: {},
    topics: ['ui-design'],
    aliases: [],
    anchors: [],
    anchorState: 'verified',
    anchorCheckedRef: '1588c3b'.padEnd(40, '0'),
    anchorCheckedAt: '2026-09-27T00:00:00.000Z',
    tainted: false,
    challenged: false,
    unsupported: false,
    pinned: false,
    supersedesId: null,
    supersededById: null,
    validFrom: '2026-09-20T00:00:00.000Z',
    validTo: null,
    recordedAt: '2026-09-20T00:00:00.000Z',
    retiredAt: null,
    ...over,
  } as WikiEntry;
}

const MOCKUPS = entry({ kind: 'convention', title: '改 UI 先给效果图、分档选项等 owner 拍板', trust: 'confirmed', validFrom: '2026-09-18T00:00:00.000Z' });
const CHROMIUM = entry({ kind: 'recipe', title: '用 chromium headless 渲染 mock HTML 生成 PNG 效果图', summary: '在 Linux 环境下写成 HTML 文件，再截图。' });
const EXTRACT = entry({ kind: 'pitfall', title: 'extractStyle 输出再包一层 <style> 会吃掉首条规则', trust: 'unreviewed' });
const DOCS = entry({ kind: 'convention', title: 'UI 效果图按仓库惯例放进 docs/mocks/', validFrom: '2026-09-26T00:00:00.000Z' });
const GONE_ID = uuid();
const TOPIC_ENTRIES = [MOCKUPS, CHROMIUM, EXTRACT, DOCS];

const ARTICLE: WikiArticleView = {
  spaceId: SPACE_ID,
  topic: { slug: 'ui-design', title: 'UI 设计', category: 'clients', categoryTitle: 'Clients & UI' },
  part: 1,
  kind: 'subtopic',
  title: 'Orbit 仓库 UI 效果图生成与验收规范',
  blocks: [
    {
      heading: null,
      sentences: [
        { text: 'Orbit 仓库规定 UI 变更先出效果图。', notes: [1] },
        { text: '效果图用 `chromium --headless=new` 渲染为 PNG。', notes: [2, 3] },
      ],
    },
    { heading: '常见陷阱', sentences: [{ text: '**extractStyle** 的输出不要再包一层。', notes: [3, 4] }] },
  ],
  footnotes: [
    { n: 1, entryId: MOCKUPS.id, revision: 1, entry: { id: MOCKUPS.id, kind: 'convention', title: MOCKUPS.title, summary: MOCKUPS.summary, status: 'active', trust: 'confirmed', currentRevision: 1 } },
    { n: 2, entryId: CHROMIUM.id, revision: 1, entry: { id: CHROMIUM.id, kind: 'recipe', title: CHROMIUM.title, summary: CHROMIUM.summary, status: 'active', trust: 'auto', currentRevision: 1 } },
    { n: 3, entryId: EXTRACT.id, revision: 1, entry: { id: EXTRACT.id, kind: 'pitfall', title: EXTRACT.title, summary: EXTRACT.summary, status: 'active', trust: 'unreviewed', currentRevision: 1 } },
    { n: 4, entryId: GONE_ID, revision: 2, entry: null },
  ],
  entryCount: 59,
  chars: 612,
  generatedAt: '2026-09-27T03:10:00.000Z',
  ref: '1588c3bd26383b0b56244e975f8403b15b88a42d',
  model: 'qwen3.8-27b-fp8',
  overview: { part: 0, kind: 'overview', title: 'UI 设计', entryCount: 147 },
  parts: [{ part: 1, kind: 'subtopic', title: 'Orbit 仓库 UI 效果图生成与验收规范', entryCount: 59 }],
};

const SESSION_ONE = uuid();
const SESSION_TWO = uuid();
const DETAIL = {
  ...CHROMIUM,
  sources: [
    { id: 's1', kind: 'turn', ref: SESSION_ONE, locator: { turnId: 't1' }, quote: null, quoteVerified: false, state: 'live', tainted: false, createdAt: '' },
    { id: 's2', kind: 'turn', ref: SESSION_TWO, locator: { turnId: 't2' }, quote: null, quoteVerified: false, state: 'live', tainted: false, createdAt: '' },
    { id: 's3', kind: 'commit', ref: 'c'.repeat(40), locator: {}, quote: null, quoteVerified: false, state: 'live', tainted: false, createdAt: '' },
  ],
  history: [],
  exposure: [],
};

const reply = (status: number, body: unknown): Response =>
  ({ ok: status < 400, status, statusText: '', text: async () => JSON.stringify(body), json: async () => body }) as unknown as Response;

/** The door, answering what this fixture holds and 404 for the rest — the articles a topic lacks among them. */
async function serve(url: string): Promise<Response> {
  const path = url.split('?')[0];
  const space = `/api/wiki/spaces/${SPACE_ID}`;
  if (path === '/api/wiki/spaces') return reply(200, [SPACE]);
  if (path === space) return reply(200, SPACE);
  if (path === `${space}/articles`) return reply(200, SHARED.directory.read);
  if (path === `${space}/article-index`) return reply(200, { spaceId: SPACE_ID, items: SHARED.index.items });
  if (path === `${space}/articles/ui-design/1`) return reply(200, ARTICLE);
  if (path.startsWith(`${space}/articles/`)) return reply(404, { message: 'this topic has no article yet' });
  if (path === `${space}/topics/ui-design`) {
    return reply(200, { slug: 'ui-design', title: 'UI 设计', description: null, declared: true, entryCount: 4, entries: TOPIC_ENTRIES });
  }
  if (path === `${space}/topics/tasks`) {
    return reply(200, { slug: 'tasks', title: '任务与派发', description: null, declared: true, entryCount: 1, entries: [entry({ title: 'Tasks start from a fact', topics: ['tasks'] })] });
  }
  if (path === `${space}/entries`) return reply(200, TOPIC_ENTRIES);
  if (path === `${space}/timeline`) return reply(200, { items: [] });
  if (path.startsWith('/api/wiki/review')) return reply(200, REVIEW);
  if (path.startsWith('/api/wiki/entries/')) {
    const id = decodeURIComponent(path.slice('/api/wiki/entries/'.length));
    if (id === CHROMIUM.id || id === encodeId(CHROMIUM.id)) return reply(200, DETAIL);
    return reply(200, { ...TOPIC_ENTRIES.find((row) => row.id === id || encodeId(row.id) === id) ?? MOCKUPS, sources: [], history: [], exposure: [] });
  }
  return reply(404, { message: `${url} is not in this fixture` });
}

const REVIEW = [
  {
    id: 'changeset',
    spaceId: SPACE_ID,
    origin: 'agent',
    sessionId: 'session',
    toolCallId: null,
    rationale: 'why',
    status: 'pending',
    createdAt: '2026-09-25T12:00:00.000Z',
    decidedAt: null,
    expiresAt: null,
    ops: [
      { id: 'op-a', changesetId: 'changeset', seq: 0, op: 'add', entryId: null, baseRevision: null, payload: { entry: { kind: 'pitfall', title: 'One' } }, similar: [], tainted: false, decision: 'pending' },
      { id: 'op-b', changesetId: 'changeset', seq: 1, op: 'add', entryId: null, baseRevision: null, payload: { entry: { kind: 'pitfall', title: 'Two' } }, similar: [], tainted: false, decision: 'pending' },
    ],
  },
];

let phone = false;
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  phone = false;
  vi.stubGlobal('ResizeObserver', class { observe(): void {} unobserve(): void {} disconnect(): void {} });
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: phone && /max-width/.test(query), media: query, onchange: null, addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }));
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  vi.stubGlobal('fetch', vi.fn(serve));
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
  for (let tick = 0; tick < 8; tick += 1) {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  }
}

/** Where the router is: written into the page so a test can read where a press went. */
function Where() {
  const location = useLocation();
  return <output data-where={location.pathname} />;
}

async function open(path: string): Promise<void> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[path]}>
          <AntApp>
            <Routes>
              <Route path="/wiki/:space" element={<WikiPage route="home" />} />
              <Route path="/wiki/:space/browse" element={<WikiPage route="browse" />} />
              <Route path="/wiki/:space/az" element={<WikiPage route="index" />} />
              <Route path="/wiki/:space/t/:topic" element={<WikiPage route="topic" />} />
              <Route path="/wiki/:space/t/:topic/:part" element={<WikiPage route="topic" />} />
              <Route path="/wiki/:space/e/:entry" element={<WikiPage route="entry" />} />
              <Route path="/wiki/review" element={<span>review</span>} />
            </Routes>
            <Where />
          </AntApp>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await settle();
}

const where = (): string | null => container.querySelector('output')?.getAttribute('data-where') ?? null;
const text = (selector: string, scope: ParentNode = container): string[] =>
  [...scope.querySelectorAll(selector)].map((node) => node.textContent?.replace(/\s+/g, ' ').trim() ?? '');

/** A node's words as a reader hears them: its parts one space apart, the way the page lays them out. */
const spaced = (node: Node): string =>
  [...node.childNodes].every((child) => child.nodeType === Node.TEXT_NODE)
    ? (node.textContent ?? '').replace(/\s+/g, ' ').trim()
    : [...node.childNodes].map(spaced).filter(Boolean).join(' ');
const words = (selector: string, scope: ParentNode = container): string[] => [...scope.querySelectorAll(selector)].map(spaced);

/** The article on the page — not the one a drawer may keep behind itself. */
const page = (): HTMLElement => container.querySelector<HTMLElement>('.wk-main .wk-art-page')!;

describe("a topic's article", () => {
  it('draws the crumb, title, tags, when it was written, the text, the footnotes and the entries, in that order', async () => {
    await open('/wiki/orbit/t/ui-design/1');
    await vi.waitFor(() => expect(page()?.querySelector('.wk-art')).toBeTruthy());
    const art = page();
    const order = ['.wk-art-crumbrow', '.wk-art-title', '.wk-tags', '.wk-art-updated', '.wk-art', '.wk-fnlist', '.wk-art-entries'].map(
      (selector) => [...art.querySelectorAll('*')].indexOf(art.querySelector(selector)!),
    );
    expect(order.every((at) => at >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));

    expect(text('.wk-crumb a', art)).toEqual(['Wiki', 'Clients & UI', 'UI 设计']);
    expect(text('.wk-art-title', art)).toEqual(['Orbit 仓库 UI 效果图生成与验收规范']);
    expect(text('.wk-tag', art)).toEqual(['Clients & UI', 'UI 设计', '2 conventions', '1 pitfall', '1 recipe']);
    expect(text('.wk-art-updated', art)[0]).toMatch(/^Updated Sep 2[78] at 1588c3b · written by Wiki maintenance from 59 entries$/);
    // A heading over every block but the lead; a footnote run after every sentence.
    expect(text('.wk-art h2', art)).toEqual(['常见陷阱']);
    expect(text('.wk-art .wk-fn', art)).toEqual(['[1]', '[2][3]', '[3][4]']);
    expect(text('.wk-art code', art)).toEqual(['chromium --headless=new']);
    expect(text('.wk-art strong', art)).toEqual(['extractStyle']);
  });

  it('lists every footnote with its entry, kind and mark, and says when the entry is gone', async () => {
    await open('/wiki/orbit/t/ui-design/1');
    await vi.waitFor(() => expect(page()?.querySelector('.wk-fnlist li')).toBeTruthy());
    const list = page().querySelector('.wk-fnlist')!;
    expect(text('h3', list)).toEqual(['Footnotes 4 entries cited']);
    expect(words('li', list)).toEqual([
      '1. 改 UI 先给效果图、分档选项等 owner 拍板 Convention · Confirmed',
      '2. 用 chromium headless 渲染 mock HTML 生成 PNG 效果图 Recipe · Auto',
      '3. extractStyle 输出再包一层 <style> 会吃掉首条规则 Pitfall · Unreviewed',
      '4. This entry is no longer in the wiki.',
    ]);
    expect(list.querySelector('a')?.getAttribute('href')).toBe(`/wiki/orbit/e/${encodeId(MOCKUPS.id)}`);
  });

  it("puts the topic's entries under it by kind, what the article cites leading each group", async () => {
    await open('/wiki/orbit/t/ui-design/1');
    await vi.waitFor(() => expect(page()?.querySelector('.wk-art-entries .wk-sec')).toBeTruthy());
    const entries = page().querySelector('.wk-art-entries')!;
    expect(text('.wk-art-entries-h', entries)).toEqual(['Entries 4 filed under this topic, by kind']);
    expect(text('.wk-sec-h h3', entries)).toEqual(['Principles & conventions', 'Pitfalls', 'Recipes']);
    // The convention the article cites leads its group, ahead of the newer one it does not.
    expect(text('.wk-sec:first-of-type .wk-row-t .tt', entries)).toEqual([MOCKUPS.title, DOCS.title]);
    expect(text('.tdp-badge', entries)).toContain('Unreviewed');
    expect(text('.tdp-badge', entries)).toContain('Auto');
  });

  it("opens a footnote's entry card beside it on a desktop, and its Open entry keeps the article behind the entry", async () => {
    await open('/wiki/orbit/t/ui-design/1');
    await vi.waitFor(() => expect(page()?.querySelector('.wk-fn-n')).toBeTruthy());
    const marker = [...page().querySelectorAll<HTMLButtonElement>('.wk-fn-n')].find((node) => node.textContent === '[2]')!;
    await act(async () => marker.click());
    await settle();
    const card = document.querySelector<HTMLElement>('.ant-popover .wk-fncard')!;
    expect(card).toBeTruthy();
    expect(words('.k', card)).toEqual(['[2] Recipe Auto']);
    expect(text('.t', card)).toEqual([CHROMIUM.title]);
    await vi.waitFor(() => expect(text('.f', card)[0]).toContain('3 sources · 2 sessions'));
    expect(page().querySelector('.wk-art .hl')?.textContent).toContain('效果图用');
    expect(marker.className).toContain('on');

    await act(async () => card.querySelector<HTMLButtonElement>('.go')!.click());
    await settle();
    expect(where()).toBe(`/wiki/orbit/e/${encodeId(CHROMIUM.id)}`);
    // The drawer stands over the article it was opened from, not over the entry's first topic.
    await vi.waitFor(() => expect(container.querySelector('.wk-drawer-bg .wk-art-title')?.textContent).toBe(ARTICLE.title));
    await act(async () => container.querySelector<HTMLButtonElement>('.wk-scrim')!.click());
    await settle();
    expect(where()).toBe('/wiki/orbit/t/ui-design/1');
  });

  it('opens the same card as a sheet from the bottom on a phone, with Open entry across it', async () => {
    phone = true;
    await open('/wiki/orbit/t/ui-design/1');
    await vi.waitFor(() => expect(page()?.querySelector('.wk-fn-n')).toBeTruthy());
    const marker = [...page().querySelectorAll<HTMLButtonElement>('.wk-fn-n')].find((node) => node.textContent === '[1]')!;
    await act(async () => marker.click());
    await settle();
    expect(document.querySelector('.ant-popover')).toBeNull();
    const sheet = document.querySelector<HTMLElement>('.wk-fnsheet .wk-fncard.sheet')!;
    expect(sheet).toBeTruthy();
    expect(words('.k', sheet)).toEqual(['[1] Convention Confirmed']);
    expect(text('.wk-fncard-open', sheet)).toEqual(['Open entry']);
  });

  it('is the topic’s entries alone, saying why, while the topic has no article', async () => {
    await open('/wiki/orbit/t/tasks');
    await vi.waitFor(() => expect(container.querySelector('.wk-topic-page')).toBeTruthy());
    expect(container.querySelector('.wk-art-title')).toBeNull();
    expect(container.textContent).toContain('No article yet. The maintenance run writes one once this topic has entries.');
    expect(container.textContent).toContain('Tasks start from a fact');
  });
});

describe('the directory', () => {
  it('stands beside the page: its three ways in, then each category’s topics with their counts', async () => {
    await open('/wiki/orbit/t/ui-design/1');
    await vi.waitFor(() => expect(container.querySelector('.wk-dir-col .wk-toc-cat')).toBeTruthy());
    const toc = container.querySelector('.wk-dir-col .wk-toc')!;
    expect(text('.wk-toc-item .lb', toc).slice(0, 3)).toEqual(['Home', 'Browse by category', 'A–Z index']);
    expect(text('.wk-toc-cat', toc)).toEqual(['Platform core', 'Clients & UI', 'Other']);
    const sessions = [...toc.querySelectorAll('.wk-toc-item')].find((node) => node.querySelector('.lb')?.textContent === '会话')!;
    expect(sessions.querySelector('.n')?.textContent).toBe('725');
    // The open topic lists its subtopic articles, and the one on the page is lit.
    expect(text('.wk-toc-item.sub', toc)).toEqual([
      'Orbit 仓库 UI 效果图生成与验收规范',
      'UI 交互细节与文案规范',
      'UI 状态反馈与交互细节',
      '界面状态与交互的克制定制',
    ]);
    expect(text('.wk-toc-item.active', toc)).toEqual(['Orbit 仓库 UI 效果图生成与验收规范']);
  });

  it('is the Contents drawer on a phone, opened from the crumb row and closed by Escape', async () => {
    phone = true;
    await open('/wiki/orbit/t/ui-design/1');
    await vi.waitFor(() => expect(page()?.querySelector('.wk-art-crumbrow .wk-contents-btn')).toBeTruthy());
    expect(document.querySelector('.wk-contents')).toBeNull();
    await act(async () => page().querySelector<HTMLButtonElement>('.wk-art-crumbrow .wk-contents-btn')!.click());
    await settle();
    const drawer = document.querySelector('.wk-contents')!;
    expect(text('.wk-contents-h b', drawer)).toEqual(['Contents']);
    expect(text('.wk-toc-cat', drawer)).toEqual(['Platform core', 'Clients & UI', 'Other']);
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    expect(document.querySelector('.wk-contents')).toBeNull();
  });
});

describe('Browse by category', () => {
  it('says each category and topic with its counts, and lists a topic’s subtopic articles', async () => {
    await open('/wiki/orbit/browse');
    await vi.waitFor(() => expect(container.querySelector('.wk-browse-cat')).toBeTruthy());
    const browse = container.querySelector('.wk-browse-page')!;
    expect(text('.t-meta', browse)).toEqual(['18 articles · 5 topics · 911 entries']);
    expect(text('.wk-browse-cat > h2', browse)).toEqual([
      'Platform core 3 topics · 12 articles · 763 entries',
      'Clients & UI 1 topic · 5 articles · 147 entries',
      'Other 1 topic · 1 article · 1 entry',
    ]);
    const sessions = browse.querySelector('.wk-browse-topic')!;
    expect(words('.h', sessions)).toEqual(['会话 725 entries · 11 articles']);
    expect(sessions.querySelectorAll('.wk-browse-list a')).toHaveLength(8);
    await act(async () => sessions.querySelector<HTMLButtonElement>('.wk-more')!.click());
    expect(sessions.querySelectorAll('.wk-browse-list a')).toHaveLength(10);
    expect(sessions.querySelector('.h a')?.getAttribute('href')).toBe('/wiki/orbit/t/sessions');
  });
});

describe('the A–Z index', () => {
  it('greys the letters nothing starts with, and files every article under its letter by pinyin', async () => {
    await open('/wiki/orbit/az');
    await vi.waitFor(() => expect(container.querySelector('.wk-az-g')).toBeTruthy());
    const index = container.querySelector('.wk-az-page')!;
    expect(text('.wk-az-bar button', index).join('')).toBe('ABCHLRWYZ#');
    expect(text('.wk-az-bar .off', index).join('')).toBe('DEFGIJKMNOPQSTUVX');
    expect(text('.wk-az-g > h2', index)).toEqual(['A 4', 'B 4', 'C 4', 'H 2', 'L 1', 'R 1', 'W 1', 'Y 1', 'Z 2', '# 2']);
    expect(text('.wk-az-g:first-of-type .t', index)).toEqual(['安全与密钥', 'Agent 工具边界与 CLI 行为', 'Agent 工具与环境', 'AutoRetry 与 Resume 机制']);
    expect(text('.wk-az-g:first-of-type .m', index)[0]).toBe('Topic overview');
  });
});

describe('the Wiki home', () => {
  it('has the directory where the Topics grid was, and a Review bar for a phone', async () => {
    await open('/wiki/orbit');
    await vi.waitFor(() => expect(container.querySelector('.wk-dir-col .wk-toc-cat')).toBeTruthy());
    expect(container.textContent).not.toContain('Topics');
    expect(text('.wk-toc-item.active')).toEqual(['Home']);
    const bar = container.querySelector('.wk-banner')!;
    await vi.waitFor(() => expect(text('.wk-banner .t')).toEqual(['2 proposals to review']));
    expect(bar.getAttribute('href')).toBe('/wiki/review');
  });
});
