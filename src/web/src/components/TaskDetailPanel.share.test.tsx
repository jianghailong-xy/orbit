// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ShareLink } from '../api';
import { encodeId } from '../lib/idCodec';

/**
 * The task panel's ⋯ (docs/share-links-design.md §8; mock 06, the task panel's menu): Copy link —
 * the signed-in address, for its owner — Share…, which opens the one Share dialog on the task (mock
 * 03, the task's variant: Overview always included, Comments & files and Conversations with how much
 * each holds, and Conversations' risk said in amber once it is on), and Copy as Markdown — the
 * title, the status, what settles it, the dependencies, the runs in brief and the signed-in link.
 */

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  // The panel's own reads (runners, providers, the dependency graph…) are not this file's subject.
  api: vi.fn(() => new Promise(() => {})),
  getShareLink: vi.fn(),
  putShareLink: vi.fn(),
  turnOffShareLink: vi.fn(),
}));
vi.mock('../lib/clipboard', () => ({ copyText: vi.fn(async () => true) }));
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() };
vi.mock('../lib/toast', () => ({ useToast: () => toast }));
const { getShareLink, putShareLink } = await import('../api');
const { copyText } = await import('../lib/clipboard');
const { TaskDetailPanel, taskMarkdown } = await import('./TaskDetailPanel');

const TASK = encodeId('01a0702b-242d-74ed-8c72-75d49d5b498b');
const TITLE = 'T6 安全边界：跨 owner、准入与凭据不外泄的回归断言';

/** The owner's read of the task (GET /tasks/:id), with what Copy as Markdown turns into text. */
const DETAIL = {
  id: TASK,
  title: TITLE,
  status: 'DONE',
  terminalReason: null,
  completionCriterion: 'EVIDENCE_JUDGMENT',
  acceptanceCriteria: '新增的安全边界断言全部为绿。',
  acceptanceCommand: 'npm test',
  acceptanceExpectedExitCode: 0,
  description: 'What to do.',
  attachments: [],
  comments: [],
  sessions: [
    { id: encodeId('eb4677c5-44c5-5257-8bbb-02e7da5fbbd2'), title: 'Run', status: 'SUCCEEDED', createdAt: '2026-09-25T02:12:20.000Z', workspace: { name: 'orbit' } },
    { id: encodeId('eb4677c5-44c5-5257-8bbb-02e7da5fbbd3'), title: 'Trashed', status: 'FAILED', createdAt: '2026-09-24T02:12:20.000Z', deletedAt: '2026-09-24T03:00:00.000Z', workspace: { name: 'orbit' } },
  ],
  dependsOn: [{ dependsOnTask: { id: 'a', title: 'T3b 放开池 slug 的写入口', status: 'DONE' } }],
  dependedOnBy: [{ task: { id: 'b', title: 'T7 合并边界', status: 'OPEN' } }],
};

const link = (include: ShareLink['include']): ShareLink => ({
  id: 'L1',
  kind: 'TASK',
  token: 'Hs2Lq8Vn0bXw3tPz6KcR1mY7uDe4JfAa',
  include,
  expiresAt: null,
  revokedAt: null,
  viewCount: 3,
  lastViewedAt: new Date(Date.now() - 12 * 60_000).toISOString(),
  createdAt: '2026-09-25T04:00:00.000Z',
  updatedAt: '2026-09-25T04:00:00.000Z',
  state: 'ACTIVE',
  stateReason: null,
  root: { id: TASK, title: TITLE, status: 'DONE' },
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function mount(): Promise<void> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
  client.setQueryData(['task', TASK], DETAIL);
  container = document.createElement('div');
  document.body.appendChild(container);
  const next = createRoot(container);
  root = next;
  await act(async () => {
    next.render(
      <MemoryRouter>
        <QueryClientProvider client={client}>
          <TaskDetailPanel taskId={TASK} onOpenTask={() => {}} onClose={() => {}} onDelete={() => {}} deleting={false} />
        </QueryClientProvider>
      </MemoryRouter>,
    );
  });
  await settle();
}

async function click(element: Element | null | undefined, what: string): Promise<void> {
  expect(element, `${what} is on screen`).toBeTruthy();
  await act(async () => {
    element!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await settle();
}

/** Open the ⋯ and answer its items, as their labels. */
async function openMenu(): Promise<HTMLElement[]> {
  await click(container!.querySelector('button[aria-label="More actions"]'), 'the ⋯ button');
  await vi.waitFor(() => expect(document.body.querySelector('.tdp-more-menu')).not.toBeNull());
  return [...document.body.querySelectorAll<HTMLElement>('.tdp-more-menu .ant-dropdown-menu-item')];
}
const item = (items: HTMLElement[], label: string) =>
  items.find((el) => el.querySelector('.ant-dropdown-menu-title-content')?.textContent?.startsWith(label));

const dialog = (): HTMLElement => {
  const found = document.body.querySelector<HTMLElement>('.ant-modal.share-dialog');
  if (!found) throw new Error('the Share dialog is not open');
  return found;
};
const layers = () =>
  [...dialog().querySelectorAll<HTMLElement>('.share-layer')].map((row) => ({
    name: row.querySelector('.share-layer-name')?.textContent,
    detail: row.querySelector('.share-layer-detail')?.textContent,
    warn: row.querySelector('.share-layer-detail')?.classList.contains('is-warn') ?? false,
    on: row.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked,
    locked: row.querySelector<HTMLInputElement>('input[type="checkbox"]')!.disabled,
    count: row.querySelector('.share-layer-count')?.textContent,
  }));

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
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  vi.mocked(getShareLink).mockReset();
  vi.mocked(putShareLink).mockReset();
  vi.mocked(copyText).mockClear();
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

describe('the task panel’s ⋯', { timeout: 60_000 }, () => {
  it('offers Copy link, Share… and Copy as Markdown — asking nothing until it is opened', async () => {
    vi.mocked(getShareLink).mockResolvedValue({ link: null, counts: { comments: 0, files: 0, transcripts: 1 } });
    await mount();
    expect(getShareLink).not.toHaveBeenCalled();
    const items = await openMenu();
    expect(items.map((el) => el.textContent)).toEqual(['Copy link', 'Share…', 'Copy as Markdown']);
    expect(getShareLink).toHaveBeenCalledWith('TASK', TASK);
  });

  it('Copy link copies the signed-in address, not a public one', async () => {
    vi.mocked(getShareLink).mockResolvedValue({ link: link({ conversations: true }), counts: { comments: 0, files: 0, transcripts: 1 } });
    await mount();
    await click(item(await openMenu(), 'Copy link'), 'Copy link');
    expect(vi.mocked(copyText).mock.calls).toEqual([[`${window.location.origin}/tasks/${TASK}`]]);
    expect(toast.success).toHaveBeenCalledWith('Link copied');
  });

  it('Copy as Markdown copies the title, status, what settles it, dependencies, runs and the link', async () => {
    vi.mocked(getShareLink).mockResolvedValue({ link: null, counts: { comments: 0, files: 0, transcripts: 1 } });
    await mount();
    await click(item(await openMenu(), 'Copy as Markdown'), 'Copy as Markdown');
    expect(vi.mocked(copyText).mock.calls.length).toBe(1);
    const markdown = vi.mocked(copyText).mock.calls[0][0];
    expect(markdown).toBe(taskMarkdown(DETAIL, `${window.location.origin}/tasks/${TASK}`));
    const lines = markdown.split('\n');
    expect(lines.slice(0, 4)).toEqual([
      `# ${TITLE}`,
      '',
      '**Status:** Done · Judged by submitted evidence',
      `**Link:** ${window.location.origin}/tasks/${TASK}`,
    ]);
    expect(markdown).toContain('## Acceptance\n\n新增的安全边界断言全部为绿。\n\nCommand: `npm test` — done when it exits `0`');
    expect(markdown).toContain('## Dependencies\n\n- Needs: T3b 放开池 slug 的写入口 — Done\n- Unblocks: T7 合并边界 — Open');
    // Its runs in brief — the one in the Trash is not one to send anybody to.
    const runs = markdown.slice(markdown.indexOf('## Runs'));
    expect(runs).toMatch(/^## Runs\n\n1 run\n\n- Succeeded · .+ · orbit\n$/);
    expect(toast.success).toHaveBeenCalledWith('Markdown copied');
  });

  it('Share… opens the task’s Share dialog: Overview always, two layers with counts, the risk in amber once on', async () => {
    let stored = link({ commentsAndFiles: true, conversations: false, toolOutput: true });
    vi.mocked(getShareLink).mockImplementation(async () => ({
      link: structuredClone(stored),
      counts: { comments: 3, files: 0, transcripts: 1 },
    }));
    vi.mocked(putShareLink).mockImplementation(async (_kind, _id, body) => {
      stored = { ...stored, include: { ...stored.include, ...body.include } };
      return structuredClone(stored);
    });
    await mount();
    await openMenu();
    const menuItems = () => [...document.body.querySelectorAll<HTMLElement>('.tdp-more-menu .ant-dropdown-menu-item')];
    // A link is open, and the entry says so.
    await vi.waitFor(() => expect(item(menuItems(), 'Share…')?.textContent).toBe('Share…Live link'));
    await click(item(menuItems(), 'Share…'), 'Share…');
    await vi.waitFor(() => expect(dialog().querySelector('.share-layers')).not.toBeNull());
    expect(dialog().querySelector('.ant-modal-title')?.textContent).toBe('Share task');
    expect(layers()).toEqual([
      { name: 'Overview', detail: 'Description, acceptance, dependencies and runs', warn: false, on: true, locked: true, count: 'Always' },
      { name: 'Comments & files', detail: 'Written by agents and people', warn: false, on: true, locked: false, count: '3 comments' },
      { name: 'Conversations', detail: 'Can include command output and file contents.', warn: false, on: false, locked: false, count: '1 transcript' },
    ]);

    // Conversations on: saved as it is made, and its risk is now said in amber.
    const conversations = [...dialog().querySelectorAll<HTMLElement>('.share-layer')][2];
    await click(conversations.querySelector('input[type="checkbox"]'), 'the Conversations box');
    expect(vi.mocked(putShareLink).mock.calls).toEqual([['TASK', TASK, { include: { conversations: true } }]]);
    await vi.waitFor(() => expect(layers()[2]).toMatchObject({ on: true, warn: true }));
  });
});
