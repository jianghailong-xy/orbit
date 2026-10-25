// @vitest-environment jsdom
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WikiDocView, WikiDocsDirectory, WikiDocsIndexItem, WikiPlanJob, WikiPlanProposal, WikiPlanVersion } from '@orbit/shared';
import { WikiPage } from '../pages/WikiPage';

/**
 * The documents (criterion 10 revised 2026-09-28, mocks 23–28), driven through the real routes: a document's
 * page with its marks, footnotes and entries — a footnote's card as a popover on a desktop and a sheet on a
 * phone, whose one button opens the original — a document no run has written, one the plan does not have;
 * the directory by the confirmed plan with the Plan row's count; Browse and the A–Z index by document.
 *
 * The reads are the shared fixture's (`wiki-docs.fixture.json`), which OrbitKit is held to as well.
 */

interface Shared {
  docs: {
    directory: { read: WikiDocsDirectory };
    doc: { read: WikiDocView };
    notWritten: { read: WikiDocView };
    index: { items: WikiDocsIndexItem[] };
  };
  plan: { versions: { v1: WikiPlanVersion }; proposals: WikiPlanProposal[]; jobs: Record<string, WikiPlanJob> };
}

function shared(): Shared {
  const path = [
    resolve(process.cwd(), '../shared/src/wiki-docs.fixture.json'),
    resolve(process.cwd(), 'src/shared/src/wiki-docs.fixture.json'),
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
  pendingOps: 0,
};
/** The plan in force with two changes proposed: the directory's Plan row counts them. */
const PLAN = { spaceId: SPACE_ID, confirmed: SHARED.plan.versions.v1, draft: null, proposals: SHARED.plan.proposals, job: SHARED.plan.jobs.built };

const reply = (status: number, body: unknown): Response =>
  ({ ok: status < 400, status, statusText: '', text: async () => JSON.stringify(body), json: async () => body }) as unknown as Response;

async function serve(url: string): Promise<Response> {
  const path = url.split('?')[0];
  const space = `/api/wiki/spaces/${SPACE_ID}`;
  if (path === '/api/wiki/spaces') return reply(200, [SPACE]);
  if (path === space) return reply(200, SPACE);
  if (path === `${space}/docs`) return reply(200, SHARED.docs.directory.read);
  if (path === `${space}/docs/session-runtime`) return reply(200, SHARED.docs.doc.read);
  if (path === `${space}/docs/session-search`) return reply(200, SHARED.docs.notWritten.read);
  if (path.startsWith(`${space}/docs/`)) return reply(404, { message: 'the confirmed plan has no such document' });
  if (path === `${space}/doc-index`) return reply(200, { spaceId: SPACE_ID, plan: SHARED.docs.directory.read.plan, items: SHARED.docs.index.items });
  if (path === `${space}/plan`) return reply(200, PLAN);
  if (path === `${space}/plan/versions`) return reply(200, { spaceId: SPACE_ID, versions: [] });
  if (path === `${space}/articles`) return reply(200, { spaceId: SPACE_ID, categories: [], uncategorized: [] });
  if (path === `${space}/entries`) return reply(200, []);
  if (path === `${space}/timeline`) return reply(200, { items: [] });
  if (path.startsWith('/api/wiki/review')) return reply(200, []);
  if (path === '/api/workspaces' || path === '/api/runners') return reply(200, []);
  return reply(404, { message: `${url} is not in this fixture` });
}

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

function Where() {
  const location = useLocation();
  return <output data-where={`${location.pathname}${location.search}`} />;
}

async function open(path: string): Promise<void> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/wiki/:space" element={<WikiPage route="home" />} />
            <Route path="/wiki/:space/browse" element={<WikiPage route="browse" />} />
            <Route path="/wiki/:space/az" element={<WikiPage route="index" />} />
            <Route path="/wiki/:space/d/:doc" element={<WikiPage route="doc" />} />
            <Route path="/wiki/:space/plan" element={<WikiPage route="plan" />} />
            <Route path="/wiki/:space/e/:entry" element={<span>entry</span>} />
            <Route path="/sessions/:id" element={<span>session</span>} />
          </Routes>
          <Where />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await settle();
}

const where = (): string | null => container.querySelector('output')?.getAttribute('data-where') ?? null;
const text = (selector: string, scope: ParentNode = container): string[] =>
  [...scope.querySelectorAll(selector)].map((node) => node.textContent?.replace(/\s+/g, ' ').trim() ?? '');
const page = (): HTMLElement => container.querySelector<HTMLElement>('.wk-main .wk-dc-page')!;
/** A node's words as a reader hears them: its parts one space apart, the way the page lays them out. */
const spaced = (node: Node): string =>
  [...node.childNodes].every((child) => child.nodeType === Node.TEXT_NODE)
    ? (node.textContent ?? '').replace(/\s+/g, ' ').trim()
    : [...node.childNodes].map(spaced).filter(Boolean).join(' ');
const press = async (node: Element | null): Promise<void> => {
  expect(node).toBeTruthy();
  await act(async () => (node as HTMLElement).click());
  await settle();
};

describe("a document's page", () => {
  it('draws the crumb, title, tags, when it was written, the banner, the reader and scope, the text, the footnotes and the entries, in that order', async () => {
    await open('/wiki/orbit/d/session-runtime');
    await vi.waitFor(() => expect(page()?.querySelector('.wk-dc-body')).toBeTruthy());
    const doc = page();
    const order = ['.wk-art-crumbrow', '.wk-art-title', '.wk-tags', '.wk-art-updated', '.wk-dc-banner', '.wk-dc-scope', '.wk-dc-body', '.wk-fn2-list', '.wk-dc-entries'].map(
      (selector) => [...doc.querySelectorAll('*')].indexOf(doc.querySelector(selector)!),
    );
    expect(order.every((at) => at >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));

    expect(text('.wk-crumb a', doc)).toEqual(['Wiki', '会话']);
    expect(text('.wk-art-title', doc)).toEqual(['会话运行模型与长连接']);
    expect(text('.wk-tag', doc)).toEqual(['会话', '4 sections', '12 footnotes', '5 session quotes', '4 code & doc quotes', '1 task quote', '1 record quote', '1 note']);
    expect(text('.wk-art-updated', doc)[0]).toMatch(/^Updated Sep 28 at 99cd3c4 · written by Wiki maintenance from plan v1 · 95 sentences$/);
    expect(text('.wk-dc-banner', doc)[0]).toContain('Needs review · 8 of 95 sentences (8.4%) state something no footnote backs');
    expect(text('.wk-dc-banner .wk-s-lab', doc)).toEqual(['No source', 'Not verified', 'Withdrawn']);
  });

  it('marks what is not sourced, not verified and withdrawn in place, and the section waiting to be written again', async () => {
    await open('/wiki/orbit/d/session-runtime');
    await vi.waitFor(() => expect(page()?.querySelector('.wk-dc-body [data-mark]')).toBeTruthy());
    const body = page().querySelector('.wk-dc-body')!;
    expect([...body.querySelectorAll('[data-mark]')].map((node) => node.getAttribute('data-mark'))).toEqual(['unverified', 'unverified', 'withdrawn', 'unsourced']);
    expect(text('.wk-s-lab', body)).toEqual(['Not verified', 'Not verified', 'Withdrawn', 'No source']);
    // The withdrawn sentence stays where it was, struck; its section says it is written again (owner's call 2026-09-29).
    expect(text('h2', body)).toEqual(['1会话运行模型与长连接：总览', '2turn 投递与 inbox 领取：long-poll 与心跳', '3已知的坑Rewrite pending', '4约定']);
    expect(body.querySelector('.wk-s-gone')?.textContent).toContain('mergeToMain');
    // Footnote numbers after their sentences, the failed ones marked.
    expect(text('.wk-fn', body)).toContain('[28][30]');
    expect([...body.querySelectorAll('.wk-fn-n.x')].map((node) => node.textContent)).toEqual(['[10]', '[11]', '[30]', '[30]', '[47]']);
  });

  it('opens a footnote as a popover on a desktop: the quote, where it is, the way to it and the entry it came through', async () => {
    await open('/wiki/orbit/d/session-runtime');
    await vi.waitFor(() => expect(page()?.querySelector('[aria-label="Footnote 44"]')).toBeTruthy());
    await press(page().querySelector('[aria-label="Footnote 44"]'));
    await vi.waitFor(() => expect(document.querySelector('.orbit-popover .wk-fn2')).toBeTruthy());
    const card = document.querySelector('.orbit-popover .wk-fn2')!;
    expect(spaced(card.querySelector('.k')!)).toBe('[44] Session · User message quote verified ✓');
    expect(text('.wk-quote-text', card)).toEqual(['“runner — drain 就会把作业杀掉，唤醒不一定送到，你这次就是这么停了六小时”']);
    expect(text('.loc', card)[0]).toContain('执行任务：例外待办：模型、FAILED 全路径来源 · 项目推进可靠性 · turn #4');
    const link = card.querySelector<HTMLAnchorElement>('.loc a')!;
    expect(link.textContent).toBe('Open at this turn ›');
    expect(link.getAttribute('href')).toBe('/sessions/se4?at=t44');
    expect(text('.via', card)[0]).toContain('Via entry');
    expect(text('.via', card)[0]).toContain('别用 bg 唤醒等长命令，runner drain 会杀作业致卡死');
  });

  it('shows code at the lines it quotes, lit, and opens it on GitHub at the sha', async () => {
    await open('/wiki/orbit/d/session-runtime');
    await vi.waitFor(() => expect(page()?.querySelector('[aria-label="Footnote 9"]')).toBeTruthy());
    await press(page().querySelector('[aria-label="Footnote 9"]'));
    await vi.waitFor(() => expect(document.querySelector('.orbit-popover .wk-fn2 .code')).toBeTruthy());
    const card = document.querySelector('.orbit-popover .wk-fn2')!;
    expect(text('.code .ln.q .i', card)).toEqual(['330']);
    expect(text('.code .ln.cut', card)).toEqual(['… 4 more lines']);
    const link = card.querySelector<HTMLAnchorElement>('.loc a')!;
    expect(link.textContent).toBe('Open on GitHub at 99cd3c4 ↗');
    expect(link.getAttribute('href')).toBe(
      'https://github.com/jianghailong-xy/orbit/blob/99cd3c4a1b2c3d4e5f60718293a4b5c6d7e8f901/src/apiserver/src/realtime/realtime.service.ts#L330-L341',
    );
  });

  it('on a phone, opens a footnote as a sheet whose one button opens the original, the entry a Via entry row (owner’s call 2026-09-29)', async () => {
    phone = true;
    await open('/wiki/orbit/d/session-runtime');
    await vi.waitFor(() => expect(page()?.querySelector('[aria-label="Footnote 44"]')).toBeTruthy());
    await press(page().querySelector('[aria-label="Footnote 44"]'));
    await vi.waitFor(() => expect(document.querySelector('.wk-fnsheet .wk-fn2.sheet')).toBeTruthy());
    const sheet = document.querySelector('.wk-fnsheet .wk-fn2.sheet')!;
    expect(text('.wk-fncard-open', sheet)).toEqual(['Open at this turn']);
    expect(sheet.textContent).not.toContain('Open entry');
    expect(text('.via .lb', sheet)).toEqual(['Via entry']);
    await press(sheet.querySelector('.wk-fncard-open'));
    expect(where()).toBe('/sessions/se4?at=t44');
  });

  it('lists the footnotes with their check, and the entries the quotes came through by kind', async () => {
    await open('/wiki/orbit/d/session-runtime');
    await vi.waitFor(() => expect(page()?.querySelector('.wk-fn2-row')).toBeTruthy());
    const list = page().querySelector('.wk-fn2-list')!;
    expect(text('h3', list)).toEqual(['Footnotes 12 · 5 session quotes · 4 code & doc quotes · 1 task quote · 1 record quote · 1 note']);
    expect(text('.wk-fn2-row .no', list)).toEqual(['1.', '2.', '9.', '10.', '11.', '28.', '30.', '39.', '44.', '45.', '46.', '47.']);
    expect(text('.wk-fn2-row .ver', list)).toEqual(['✓', '✓', '✓', '✗ no quote', '✗ quote not found', '✓', '✗ quote not found', '✓', '✓', '✓', '✓', '✗ not found']);
    const entries = page().querySelector('.wk-dc-entries')!;
    expect(text('.wk-art-entries-h', entries)).toEqual(['Entries the 4 this document’s quotes came through, by kind']);
    expect(text('.wk-sec-h h3', entries)).toEqual(['Principles & conventions', 'Decisions', 'Pitfalls']);
    expect(text('.supby', entries)).toEqual(['Rejected by you · its sentence in §3 is withdrawn']);
  });

  it('says a document no run has written is not written yet, and what writes it', async () => {
    await open('/wiki/orbit/d/session-search');
    await vi.waitFor(() => expect(page()?.querySelector('.wk-dc-notwritten')).toBeTruthy());
    expect(text('.wk-dc-notwritten', page())).toEqual([
      'Not written yet. Wiki maintenance writes it on its next run — 3 of 5 documents are written. What it will cover is below.',
    ]);
    expect(page().querySelector('.wk-art-updated')).toBeNull();
  });

  it('says so of a document the confirmed plan does not have', async () => {
    await open('/wiki/orbit/d/nowhere');
    await vi.waitFor(() => expect(container.textContent).toContain('That document is not in this space’s plan.'));
  });
});

describe('the directory, Browse and the A–Z index by document', () => {
  it('lists Home, Browse, the A–Z index and the Plan with what waits on the owner, then the plan’s categories and documents', async () => {
    await open('/wiki/orbit/d/session-runtime');
    await vi.waitFor(() => expect(container.querySelector('.wk-toc .wk-toc-item.doc')).toBeTruthy());
    const toc = container.querySelector('.wk-toc')!;
    expect(text('.wk-toc-item:not(.doc):not(.sec) .lb', toc)).toEqual(['Home', 'Browse by category', 'A–Z index', 'Plan']);
    expect(text('.wk-toc-item.plan .tp-count', toc)).toEqual(['2']);
    expect(text('.wk-toc-cat', toc)).toEqual(['产品概览', '会话', '给 agent 的开发约定']);
    expect(text('.wk-toc-item.doc .no', toc)).toEqual(['1.1', '3.1', '3.2', '3.3', '4.1']);
    // The open document lists its sections; the one past the threshold wears its dot; unwritten ones are grey.
    expect(text('.wk-toc-item.sec .lb', toc)).toEqual(['会话运行模型与长连接：总览', 'turn 投递与 inbox 领取：long-poll 与心跳', '已知的坑', '约定']);
    expect([...toc.querySelectorAll('.wk-toc-item.doc')].filter((row) => row.querySelector('.st')).map((row) => row.querySelector('.no')?.textContent)).toEqual(['3.1']);
    expect([...toc.querySelectorAll('.wk-toc-item.doc.todo .no')].map((node) => node.textContent)).toEqual(['3.3', '4.1']);
  });

  it('browses by the plan’s categories and documents, each with its sections', async () => {
    await open('/wiki/orbit/browse');
    await vi.waitFor(() => expect(container.querySelector('.wk-browse-docs .wk-browse-doc')).toBeTruthy());
    const browse = container.querySelector('.wk-browse-docs')!;
    expect(text('.t-meta', browse)).toEqual(['5 documents · 3 categories · 10 sections · plan v1']);
    expect(text('.wk-browse-cat h2', browse)).toEqual(['1 产品概览 1 document · 2 sections', '3 会话 3 documents · 7 sections', '4 给 agent 的开发约定 1 document · 1 section']);
    expect(text('.wk-browse-doc .h .n', browse)).toEqual(['2 sections', '4 sections · Needs review', '1 section', '2 sections · Not written yet', '1 section · Not written yet']);
  });

  it('files every document and every section title no other document shares, A to Z', async () => {
    await open('/wiki/orbit/az');
    await vi.waitFor(() => expect(container.querySelector('.wk-az-docs .wk-az-g')).toBeTruthy());
    const index = container.querySelector('.wk-az-docs')!;
    expect(text('.t-meta', index)).toEqual(['5 documents and 7 sections by title · Chinese titles by pinyin']);
    expect(text('.wk-az-g h2', index)).toEqual(['A 5', 'B 3', 'H 1', 'T 1', 'W 1', '# 1']);
    const a = index.querySelector('.wk-az-g')!;
    expect(text('.m', a)).toEqual([
      '1.3 · 产品概览 · document',
      '§2 in 7.1 Runner 架构与注册',
      '§3 in 6.2 Project Coordinator 与调度',
      '6.4 · Project 与多 Agent 协作 · document',
      '§2 in 3.3 会话搜索',
    ]);
    // A document's title in bold; a section's goes to its place on its document's page.
    expect([...a.querySelectorAll('.t.ov')].map((node) => node.textContent)).toEqual(['安全模型与密钥信任', 'Agent 公平调度域']);
    expect(a.querySelectorAll('a')[1].getAttribute('href')).toBe('/wiki/orbit/d/runner-arch#sec-s2');
  });
});
