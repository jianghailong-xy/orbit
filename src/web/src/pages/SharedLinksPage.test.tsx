// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ShareLink } from '../api';

/**
 * Settings → Shared links (docs/share-links-design.md §3, §8; mocks 06-manage-and-entry, 13-row-buttons), in a real
 * document over the links GET /share-links answers with: the three tabs and their counts, that no
 * link is singled out for its session being finished long ago, and what each row says and offers in
 * each state.
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

/** A row's own controls as they read: a button's words, else its name; the ⋯ reads as ⋯. */
const controlName = (b: Element) =>
  b.textContent?.trim() || (b.getAttribute('aria-label')?.startsWith('More for ') ? '⋯' : b.getAttribute('aria-label'));

/** Each link row as it reads: title, the line under it, the chips, and the actions it offers. */
const rows = () =>
  [...page().querySelectorAll<HTMLElement>('.shared-link-row:not(.is-head)')].map((row) => ({
    title: row.querySelector('.shared-link-title')?.textContent,
    where: row.querySelector('.shared-link-where')?.textContent,
    chips: [...row.querySelectorAll('.shared-link-chip')].map((chip) => chip.textContent),
    updates: row.querySelector('.shared-link-updates')?.textContent,
    actions: [...row.querySelectorAll('.shared-link-actions button')].map(controlName),
    opens: row.classList.contains('is-pressable'),
  }));

const rowOf = (title: string) =>
  [...page().querySelectorAll<HTMLElement>('.shared-link-row')].find(
    (r) => r.querySelector('.shared-link-title')?.textContent === title,
  )!;
const menuItems = () => [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')];
/** Opens a row's ⋯ (board 13) and reads what it holds. */
async function openMenu(title: string): Promise<string[]> {
  await click(rowOf(title).querySelector(`button[aria-label="More for ${title}"]`), `the ⋯ for ${title}`);
  await act(async () => {
    await vi.waitFor(() => expect(menuItems().length).toBeGreaterThan(0));
  });
  return menuItems().map((item) => item.textContent?.trim() ?? '');
}
async function pressMenu(title: string, label: string): Promise<void> {
  await openMenu(title);
  await click(
    menuItems().find((item) => item.textContent?.trim() === label),
    label,
  );
}
/** A press on the row's words, as a person opens it (board 13). */
const pressRow = (title: string) => click(rowOf(title).querySelector('.shared-link-title'), `the row ${title}`);


/** The anchored question a Turn off asks, its words by what the dialog is named and described by. */
const question = () => document.body.querySelector<HTMLElement>('[role="dialog"]');
const nameOf = (el: Element): string | undefined =>
  document.getElementById(el.getAttribute('aria-labelledby') ?? '')?.textContent ?? undefined;
const descriptionOf = (el: Element): string | undefined =>
  document.getElementById(el.getAttribute('aria-describedby') ?? '')?.textContent ?? undefined;

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

/** The Share dialog's name, as assistive technology reads it. */
const shareDialogName = (): string | undefined => {
  const dialog = document.body.querySelector('[role="dialog"].share-dialog');
  return document.getElementById(dialog?.getAttribute('aria-labelledby') ?? '')?.textContent ?? undefined;
};

describe('Settings → Shared links', { timeout: 60_000 }, () => {
  it('files every link under Active, Paused or Ended, with each tab counting its own', async () => {
    serve(LINKS);
    await open();

    expect(page().querySelector('.settings-header-title')?.textContent).toBe('Shared links');
    expect(page().querySelector('.settings-header-description')?.textContent).toBe(
      'Everything you’ve made viewable by link. Anyone who has one of these links can open what it includes — no sign-in.',
    );
    expect(tabs()).toEqual([
      { label: 'Active', count: '6', selected: true },
      { label: 'Paused', count: '1', selected: false },
      { label: 'Ended', count: '2', selected: false },
    ]);
    expect(rows().map((row) => row.title)).toEqual([STALE_A, STALE_B, STALE_C, RECENT, OPEN, TASK].map((l) => l.root.title));
  });

  it('names no link for its session being finished long ago: a finished session stays shared as set', async () => {
    serve(LINKS);
    await open();

    // Three of the six active links are for sessions completed 31 to 73 days ago.
    expect(page().textContent).not.toContain('30 days');
    expect(page().querySelector('[role="status"]')).toBeNull();
    expect([...page().querySelectorAll('button')].map((b) => b.textContent?.trim())).not.toContain('Turn off these 3');
  });

  it('gives every active link a copy icon and a ⋯, opens from its row, and says what it includes and how long it lives', async () => {
    serve(LINKS);
    await open();

    const [staleA, staleB, staleC, recent, open7, task] = rows();
    for (const row of [staleA, staleB, staleC, recent, open7, task]) {
      expect(row.actions).toEqual(['Copy link', '⋯']);
      expect(row.opens).toBe(true);
    }
    expect(await openMenu(RECENT.root.title)).toEqual(['Copy link', 'Settings…', 'Turn off…']);
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
    // A task's link reads the same: tasks have the dialog too.
    expect(task).toMatchObject({ where: 'Task · Done', chips: ['Overview', 'Comments', 'Conversations'] });
  });

  it('a press on a task row opens the Share dialog on that task', async () => {
    serve(LINKS);
    vi.mocked(getShareLink).mockResolvedValue({ link: TASK, counts: { comments: 3, files: 0, transcripts: 1 } });
    await open();

    await pressRow(TASK.root.title);

    await vi.waitFor(() => expect(document.body.querySelector('[role="dialog"].share-dialog')).not.toBeNull());
    expect(getShareLink).toHaveBeenCalledWith('TASK', TASK.root.id);
    expect(shareDialogName()).toBe('Share task');
  });

  it('a project row has the copy icon and ⋯, and a press on it opens the Share dialog on that project', async () => {
    const PROJECT: ShareLink = {
      ...sessionLink('Claude 账号池：按订阅配额均衡派发'),
      kind: 'PROJECT',
      include: { taskPages: true, commentsAndFiles: false, conversations: false, toolOutput: true },
      root: { id: 'P1', title: 'Claude 账号池：按订阅配额均衡派发', status: 'OPEN' },
    };
    serve([PROJECT]);
    vi.mocked(getShareLink).mockResolvedValue({
      link: PROJECT,
      counts: { tasks: 12, comments: 29, files: 0, runs: 13, transcripts: 14 },
    });
    await open();

    const [row] = rows();
    expect(row).toMatchObject({ chips: ['Overview', 'Task pages'], actions: ['Copy link', '⋯'], opens: true });
    await pressRow(PROJECT.root.title);

    await vi.waitFor(() => expect(document.body.querySelector('[role="dialog"].share-dialog')).not.toBeNull());
    expect(getShareLink).toHaveBeenCalledWith('PROJECT', 'P1');
    expect(shareDialogName()).toBe('Share project');
  });

  it('a wiki row is the space by name, says Wiki and what it includes, and its ⋯ Settings… opens the Share dialog on that space', async () => {
    const WIKI: ShareLink = {
      ...sessionLink('orbit'),
      kind: 'WIKI',
      include: { footnotes: true },
      root: { id: 'W1', title: 'orbit', slug: 'orbit' },
    };
    serve([WIKI]);
    vi.mocked(getShareLink).mockResolvedValue({ link: WIKI, counts: { documents: 12, footnotes: 486 } });
    await open();

    const [row] = rows();
    expect(row).toMatchObject({ title: 'orbit', where: 'Wiki', chips: ['Documents', 'Footnotes'], actions: ['Copy link', '⋯'] });
    const wiki = page().querySelector<HTMLElement>('.shared-link-row[data-kind="WIKI"]')!;
    expect(wiki.querySelector('.shared-link-kind')?.textContent).toBe('W');
    // Footnotes can carry command output and file contents: its chip is the one to notice.
    expect(wiki.querySelector('.shared-link-chip.is-warn')?.textContent).toBe('Footnotes');
    await pressMenu('orbit', 'Settings…');

    await vi.waitFor(() => expect(document.body.querySelector('[role="dialog"].share-dialog')).not.toBeNull());
    expect(getShareLink).toHaveBeenCalledWith('WIKI', 'W1');
    expect(shareDialogName()).toBe('Share wiki');
  });

  it('a press on a session row opens the Share dialog on that link’s session; one on its copy icon only copies', async () => {
    serve(LINKS);
    vi.mocked(getShareLink).mockResolvedValue({ link: RECENT, counts: { messages: 12, toolCalls: 40 } });
    await open();

    await click(rowOf(RECENT.root.title).querySelector('button[aria-label="Copy link"]'), 'the copy icon');
    expect(document.body.querySelector('[role="dialog"].share-dialog')).toBeNull();
    await pressRow(RECENT.root.title);

    await vi.waitFor(() => expect(document.body.querySelector('[role="dialog"].share-dialog')).not.toBeNull());
    expect(getShareLink).toHaveBeenCalledWith('SESSION', RECENT.root.id);
    expect(shareDialogName()).toBe('Share session');
  });

  it('a row’s ⋯ Turn off… asks first, then turns off that one link', async () => {
    serve(LINKS);
    await open();

    await pressMenu(OPEN.root.title, 'Turn off…');
    await act(async () => {
      await vi.waitFor(() => expect(nameOf(question()!)).toBe('Turn off this link?'));
    });
    const asked = question();
    expect(nameOf(asked!)).toBe('Turn off this link?');
    expect(descriptionOf(asked!)).toBe('Anyone who has it loses access right away.');
    expect(turnOffShareLinks).not.toHaveBeenCalled();
    await click([...asked!.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Turn off'), 'confirm');
    expect(vi.mocked(turnOffShareLinks).mock.calls).toEqual([[[OPEN.id]]]);
  });

  it('Paused: a session in Trash says restoring it turns the link back on, does not open, and its ⋯ holds only Turn off…', async () => {
    serve(LINKS);
    await open();
    await click(tab('Paused'), 'the Paused tab');

    expect(rows()).toEqual([
      {
        title: PAUSED.root.title,
        where: 'Paused · in Trash — restoring the session turns this link back on',
        chips: ['Messages', 'Tool output'],
        updates: 'Live',
        actions: ['⋯'],
        opens: false,
      },
    ]);
    expect(page().querySelector('.shared-link-paused')?.textContent).toBe('Paused · in Trash');
    expect(await openMenu(PAUSED.root.title)).toEqual(['Turn off…']);
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

    const again = [...page().querySelectorAll('.shared-link-actions button')].find(
      (b) => b.textContent?.trim() === 'Share again',
    );
    await click(again, 'Share again');
    expect(putShareLink).toHaveBeenCalledWith('SESSION', EXPIRED.root.id, { include: EXPIRED.include });
  });
});
