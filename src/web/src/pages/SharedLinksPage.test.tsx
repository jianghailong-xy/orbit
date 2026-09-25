// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ShareLink } from '../api';

/**
 * Settings → Shared links (docs/share-links-design.md §3, §8; mock 06-manage-and-entry), in a real
 * document over the links GET /share-links answers with: the three tabs and their counts, the
 * banner that names the links nobody is working behind any more and turns them off in one request,
 * and what each row says and offers in each state.
 */

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  listShareLinks: vi.fn(),
  turnOffShareLinks: vi.fn(),
  putShareLink: vi.fn(),
  getShareLink: vi.fn(),
}));
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() };
vi.mock('../lib/toast', () => ({ useToast: () => toast }));
const { getShareLink, listShareLinks, putShareLink, turnOffShareLinks } = await import('../api');
const { SharedLinksPage } = await import('./SharedLinksPage');

const DAY = 24 * 3_600_000;
const at = (fromNow: number) => new Date(Date.now() + fromNow).toISOString();

let serial = 0;
/** A session link, ACTIVE unless told otherwise, for a session that is still open. */
const sessionLink = (title: string, over: Partial<ShareLink> = {}, root: Partial<ShareLink['root']> = {}): ShareLink => {
  serial += 1;
  return {
    id: `L${serial}`,
    kind: 'SESSION',
    token: `token-${serial}`,
    include: { toolOutput: true },
    expiresAt: null,
    revokedAt: null,
    viewCount: 0,
    lastViewedAt: null,
    createdAt: at(-60 * DAY),
    updatedAt: at(-60 * DAY),
    state: 'ACTIVE',
    stateReason: null,
    root: { id: `S${serial}`, title, status: 'SUCCEEDED', lifecycleState: 'OPEN', completedAt: null, ...root },
    ...over,
  };
};
const completed = (daysAgo: number) => ({ lifecycleState: 'COMPLETED', completedAt: at(-daysAgo * DAY) });

// Titles from the mock, which took them from links open on this deployment.
const STALE_A = sessionLink('Web 上的 tag 功能是否可以对齐 iOS', {}, completed(73));
const STALE_B = sessionLink('iOS发送失败不重试', { viewCount: 3, lastViewedAt: at(-2 * 3_600_000) }, completed(52));
const STALE_C = sessionLink('跨平台Agent记忆共享方案', { include: { toolOutput: false } }, completed(31));
const RECENT = sessionLink('子代理模型由伺服器端設定', { createdAt: at(-4 * DAY) }, completed(3));
const OPEN = sessionLink('总结最近提交变更', { expiresAt: at(7 * DAY) });
const TASK: ShareLink = {
  ...sessionLink('T6 安全边界：跨 owner、准入与凭据不外泄的回归断言'),
  kind: 'TASK',
  include: { commentsAndFiles: true, conversations: true, toolOutput: true },
  root: { id: 'T6', title: 'T6 安全边界：跨 owner、准入与凭据不外泄的回归断言', status: 'DONE' },
};
const PAUSED = sessionLink('Coordinator 使用设计', { state: 'PAUSED', stateReason: 'IN_TRASH' }, {
  lifecycleState: 'TRASH',
});
const TURNED_OFF = sessionLink('Old dispatch notes', {
  state: 'ENDED',
  stateReason: 'TURNED_OFF',
  revokedAt: at(-5 * DAY),
});
const EXPIRED = sessionLink('Release checklist', {
  state: 'ENDED',
  stateReason: 'EXPIRED',
  expiresAt: at(-2 * DAY),
  revokedAt: null,
});
const LINKS = [STALE_A, STALE_B, STALE_C, RECENT, OPEN, TASK, PAUSED, TURNED_OFF, EXPIRED];

let stored: ShareLink[] = [];
function serve(links: ShareLink[]): void {
  stored = links.map((link) => structuredClone(link));
  vi.mocked(listShareLinks).mockImplementation(async () => ({ links: structuredClone(stored) }));
  vi.mocked(turnOffShareLinks).mockImplementation(async (ids) => {
    let count = 0;
    stored = stored.map((link) => {
      if (!ids.includes(link.id) || link.state === 'ENDED') return link;
      count += 1;
      return { ...link, state: 'ENDED', stateReason: 'TURNED_OFF', revokedAt: new Date().toISOString() };
    });
    return { count };
  });
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function open(path = '/settings/shared-links'): Promise<void> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
  container = document.createElement('div');
  document.body.appendChild(container);
  const next = createRoot(container);
  root = next;
  await act(async () => {
    next.render(
      <MemoryRouter initialEntries={[path]}>
        <QueryClientProvider client={client}>
          <SharedLinksPage />
        </QueryClientProvider>
      </MemoryRouter>,
    );
  });
  await vi.waitFor(() => expect(page().querySelector('.shared-link-row:not(.is-head), .following-empty')).not.toBeNull(), {
    timeout: 10_000,
  });
  await settle();
}

const page = (): HTMLElement => {
  if (!container) throw new Error('the page is not mounted');
  return container;
};

async function click(element: Element | null | undefined, what: string): Promise<void> {
  expect(element, `${what} is on screen`).toBeTruthy();
  await act(async () => {
    element!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await settle();
}

/** Each tab as it reads: its label and its count. */
const tabs = () =>
  [...page().querySelectorAll<HTMLElement>('[role="tab"]')].map((tab) => ({
    label: tab.firstChild?.textContent,
    count: tab.querySelector('.following-count')?.textContent,
    selected: tab.getAttribute('aria-selected') === 'true',
  }));
const tab = (label: string) =>
  [...page().querySelectorAll<HTMLElement>('[role="tab"]')].find((t) => t.firstChild?.textContent === label);

/** Each link row as it reads: title, the line under it, the chips, and the actions it offers. */
const rows = () =>
  [...page().querySelectorAll<HTMLElement>('.shared-link-row:not(.is-head)')].map((row) => ({
    title: row.querySelector('.shared-link-title')?.textContent,
    where: row.querySelector('.shared-link-where')?.textContent,
    chips: [...row.querySelectorAll('.shared-link-chip')].map((chip) => chip.textContent),
    updates: row.querySelector('.shared-link-updates')?.textContent,
    actions: [...row.querySelectorAll('.shared-link-actions .ant-btn')].map((b) => b.textContent?.trim()),
  }));

const banner = () => page().querySelector<HTMLElement>('.shared-links-banner');

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  for (const fn of [listShareLinks, turnOffShareLinks, putShareLink, getShareLink]) vi.mocked(fn).mockReset();
  for (const fn of Object.values(toast)) fn.mockReset();
});

afterEach(async () => {
  const mounted = root;
  root = null;
  if (mounted) await act(async () => mounted.unmount());
  container?.remove();
  container = null;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

describe('Settings → Shared links', { timeout: 60_000 }, () => {
  it('files every link under Active, Paused or Ended, with each tab counting its own', async () => {
    serve(LINKS);
    await open();

    expect(page().querySelector('.page-title')?.textContent).toBe('Shared links');
    expect(page().querySelector('.following-sub')?.textContent).toBe(
      'Everything you’ve made viewable by link. Anyone who has one of these links can open what it includes — no sign-in.',
    );
    expect(tabs()).toEqual([
      { label: 'Active', count: '6', selected: true },
      { label: 'Paused', count: '1', selected: false },
      { label: 'Ended', count: '2', selected: false },
    ]);
    expect(rows().map((row) => row.title)).toEqual([STALE_A, STALE_B, STALE_C, RECENT, OPEN, TASK].map((l) => l.root.title));
  });

  it('names the links for sessions completed more than 30 days ago, and turns exactly those off', async () => {
    serve(LINKS);
    await open();

    expect(banner()?.textContent).toContain('3 links are for sessions completed more than 30 days ago.');
    expect(banner()?.textContent).toContain('They still open for anyone who has them.');
    const button = banner()!.querySelector('.ant-btn');
    expect(button?.textContent?.trim()).toBe('Turn off these 3');

    await click(button, 'Turn off these 3');
    // One question for the batch, then one request naming exactly the three.
    expect(turnOffShareLinks).not.toHaveBeenCalled();
    const asked = document.body.querySelector('.ant-popconfirm');
    expect(asked?.querySelector('.ant-popconfirm-title')?.textContent).toBe('Turn off these 3 links?');
    const confirm = [...asked!.querySelectorAll('.ant-btn')].find((b) => b.textContent?.trim() === 'Turn off');
    await click(confirm, 'Turn off');

    expect(turnOffShareLinks).toHaveBeenCalledTimes(1);
    expect(vi.mocked(turnOffShareLinks).mock.calls[0][0]).toEqual([STALE_A.id, STALE_B.id, STALE_C.id]);
    await vi.waitFor(() =>
      expect(tabs()).toEqual([
        { label: 'Active', count: '3', selected: true },
        { label: 'Paused', count: '1', selected: false },
        { label: 'Ended', count: '5', selected: false },
      ]),
    );
    expect(banner()).toBeNull();
  });

  it('says nothing about old links when no open link is for a session finished 30 days ago', async () => {
    serve([RECENT, OPEN, TASK, PAUSED]);
    await open();
    expect(banner()).toBeNull();
  });

  it('gives every active link Copy, Settings and Turn off, and says what it includes and how long it lives', async () => {
    serve(LINKS);
    await open();

    const [staleA, staleB, staleC, recent, open7, task] = rows();
    for (const row of [staleA, staleB, staleC, recent, open7]) expect(row.actions).toEqual(['Copy', 'Settings', 'Turn off']);
    expect(staleA).toMatchObject({
      where: `Session · Completed ${new Date(STALE_A.root.completedAt!).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`,
      chips: ['Messages', 'Tool output'],
      updates: 'Live',
    });
    expect(staleC.chips).toEqual(['Messages']);
    expect(open7.where).toBe('Session · Open');
    expect(open7.updates).toBe(
      `Live · until ${new Date(OPEN.expiresAt!).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`,
    );
    // A task's link can be copied and turned off here; its settings open once tasks have the dialog.
    expect(task).toMatchObject({ where: 'Task · Done', chips: ['Overview', 'Comments', 'Conversations'] });
    expect(task.actions).toEqual(['Copy', 'Turn off']);
  });

  it('Settings opens the Share dialog on that link’s session', async () => {
    serve(LINKS);
    vi.mocked(getShareLink).mockResolvedValue({ link: RECENT, counts: { messages: 12, toolCalls: 40 } });
    await open();

    const recent = [...page().querySelectorAll<HTMLElement>('.shared-link-row')].find(
      (row) => row.querySelector('.shared-link-title')?.textContent === RECENT.root.title,
    );
    const settings = [...recent!.querySelectorAll('.ant-btn')].find((b) => b.textContent?.trim() === 'Settings');
    await click(settings, 'Settings');

    await vi.waitFor(() => expect(document.body.querySelector('.ant-modal.share-dialog')).not.toBeNull());
    expect(getShareLink).toHaveBeenCalledWith('SESSION', RECENT.root.id);
    expect(document.body.querySelector('.ant-modal.share-dialog .ant-modal-title')?.textContent).toBe('Share session');
  });

  it('a row’s Turn off asks first, then turns off that one link', async () => {
    serve(LINKS);
    await open();

    const row = [...page().querySelectorAll<HTMLElement>('.shared-link-row')].find(
      (r) => r.querySelector('.shared-link-title')?.textContent === OPEN.root.title,
    );
    await click([...row!.querySelectorAll('.ant-btn')].find((b) => b.textContent?.trim() === 'Turn off'), 'Turn off');
    const asked = document.body.querySelector('.ant-popconfirm');
    expect(asked?.querySelector('.ant-popconfirm-title')?.textContent).toBe('Turn off this link?');
    expect(asked?.querySelector('.ant-popconfirm-description')?.textContent).toBe('Anyone who has it loses access right away.');
    expect(turnOffShareLinks).not.toHaveBeenCalled();
    await click([...asked!.querySelectorAll('.ant-btn')].find((b) => b.textContent?.trim() === 'Turn off'), 'confirm');
    expect(vi.mocked(turnOffShareLinks).mock.calls).toEqual([[[OPEN.id]]]);
  });

  it('Paused: a session in Trash says restoring it turns the link back on, and offers only Turn off', async () => {
    serve(LINKS);
    await open();
    await click(tab('Paused'), 'the Paused tab');

    expect(rows()).toEqual([
      {
        title: PAUSED.root.title,
        where: 'Paused · in Trash — restoring the session turns this link back on',
        chips: ['Messages', 'Tool output'],
        updates: 'Live',
        actions: ['Turn off'],
      },
    ]);
    expect(page().querySelector('.shared-link-paused')?.textContent).toBe('Paused · in Trash');
    expect(banner()).toBeNull();
  });

  it('Ended: says how and when each ended, and offers Share again only for an expired one', async () => {
    serve(LINKS);
    vi.mocked(putShareLink).mockResolvedValue({ ...EXPIRED, id: 'L-new', state: 'ACTIVE', stateReason: null, token: 'new' });
    await open('/settings/shared-links?tab=ended');

    const day = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    expect(rows().map(({ title, where, actions }) => ({ title, where, actions }))).toEqual([
      { title: TURNED_OFF.root.title, where: `Session · Turned off ${day(TURNED_OFF.revokedAt!)}`, actions: [] },
      { title: EXPIRED.root.title, where: `Session · Expired ${day(EXPIRED.expiresAt!)}`, actions: ['Share again'] },
    ]);

    const again = [...page().querySelectorAll('.shared-link-actions .ant-btn')].find(
      (b) => b.textContent?.trim() === 'Share again',
    );
    await click(again, 'Share again');
    expect(putShareLink).toHaveBeenCalledWith('SESSION', EXPIRED.root.id, { include: EXPIRED.include });
  });
});
