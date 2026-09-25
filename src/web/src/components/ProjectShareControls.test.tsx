// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectShareCounts, ShareLink } from '../api';
import { encodeId } from '../lib/idCodec';

/**
 * The project header's sharing controls (docs/share-links-design.md §8; mock 06 ④ and mock 03's
 * project dialog): the pill that says the project is public — "Shared · Live", which opens its Share
 * dialog — or Share while it is not; Copy link, the signed-in address; and the ⋯ menu with Copy
 * link, Share… and Copy as Markdown. Then the dialog's project variant: Overview always, Task pages
 * on by default, and Comments & files and Conversations indented under Task pages and greyed out
 * with it.
 */

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  getShareLink: vi.fn(),
  putShareLink: vi.fn(),
  turnOffShareLink: vi.fn(),
}));
vi.mock('../lib/clipboard', () => ({ copyText: vi.fn(async () => true) }));
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() };
vi.mock('../lib/toast', () => ({ useToast: () => toast }));
const { getShareLink, putShareLink } = await import('../api');
const { copyText } = await import('../lib/clipboard');
const { ProjectShareControls, projectMarkdown } = await import('./ProjectShareControls');

const PROJECT = encodeId('01a06f00-0000-7000-8000-000000000001');
const TITLE = 'Claude 账号池：按订阅配额均衡派发';
const APP_URL = `${window.location.origin}/projects/${PROJECT}`;

/** The project document the page holds (GET /projects/:id), as far as the controls read it. */
const PROJECT_DOC = {
  title: TITLE,
  status: 'OPEN' as const,
  goal: '把一组同厂商的 Claude 订阅凭据表达成一个可派发的池身份。',
  _count: { tasks: 12 },
  acceptanceCriteriaItems: [
    { ordinal: 1, text: '同一 owner 的多行订阅可以归入一个池。', satisfied: true, landing: 'LANDED' },
    { ordinal: 2, text: '派发时选中窗口占用最低的那一行。', satisfied: true, landing: 'ON_INTEGRATION_LINE' },
    { ordinal: 3, text: '客户端能看到每个成员的占用。', satisfied: false, landing: 'UNKNOWN' },
  ],
};

/** The counts the mock's project dialog shows: 12 tasks, 29 comments, 13 runs and the coordinator. */
const COUNTS: ProjectShareCounts = { tasks: 12, comments: 29, files: 0, runs: 13, transcripts: 14 };

const link = (include: ShareLink['include']): ShareLink => ({
  id: 'L1',
  kind: 'PROJECT',
  token: 'Qm4kT9vR2mT7wLp4sYb8nZc1eHf6uJaB',
  include,
  expiresAt: null,
  revokedAt: null,
  viewCount: 14,
  lastViewedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
  createdAt: '2026-09-25T04:00:00.000Z',
  updatedAt: '2026-09-25T04:00:00.000Z',
  state: 'ACTIVE',
  stateReason: null,
  root: { id: PROJECT, title: TITLE, status: 'OPEN' },
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let client: QueryClient;

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function mount(): Promise<void> {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
  container = document.createElement('div');
  document.body.appendChild(container);
  const next = createRoot(container);
  root = next;
  await act(async () => {
    next.render(
      <MemoryRouter>
        <QueryClientProvider client={client}>
          <ProjectShareControls projectId={PROJECT} project={PROJECT_DOC} />
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

const buttonNamed = (text: string) =>
  [...container!.querySelectorAll('button')].find((b) => b.textContent?.trim() === text) ?? null;

/** Open the ⋯ and answer its items. */
async function openMenu(): Promise<HTMLElement[]> {
  await click(container!.querySelector('button[aria-label="More project actions"]'), 'the ⋯ button');
  await vi.waitFor(() => expect(document.body.querySelector('.project-more-menu')).not.toBeNull());
  return [...document.body.querySelectorAll<HTMLElement>('.project-more-menu .ant-dropdown-menu-item')];
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
    nested: row.classList.contains('is-nested'),
    idle: row.classList.contains('is-idle'),
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

describe('the project header’s sharing controls', { timeout: 60_000 }, () => {
  it('says Share while nothing is public, and Shared · Live once a link is open', async () => {
    vi.mocked(getShareLink).mockResolvedValue({ link: null, counts: COUNTS });
    await mount();
    expect(getShareLink).toHaveBeenCalledWith('PROJECT', PROJECT);
    expect(buttonNamed('Share')).not.toBeNull();
    expect(container!.querySelector('.session-shared-pill')).toBeNull();
    expect(buttonNamed('Copy link')).not.toBeNull();
    await act(async () => root!.unmount());
    container!.remove();

    vi.mocked(getShareLink).mockResolvedValue({ link: link({ taskPages: true }), counts: COUNTS });
    await mount();
    const pill = container!.querySelector('.session-shared-pill');
    expect(pill?.textContent?.trim()).toBe('Shared · Live');
    expect(buttonNamed('Share')).toBeNull();
    // The pill opens the project's Share dialog.
    await click(pill, 'the Shared · Live pill');
    await vi.waitFor(() => expect(dialog().querySelector('.ant-modal-title')?.textContent).toBe('Share project'));
  });

  it('Copy link copies the signed-in address, not a public one', async () => {
    vi.mocked(getShareLink).mockResolvedValue({ link: link({ taskPages: true }), counts: COUNTS });
    await mount();
    await click(buttonNamed('Copy link'), 'Copy link');
    expect(vi.mocked(copyText).mock.calls).toEqual([[APP_URL]]);
    expect(toast.success).toHaveBeenCalledWith('Link copied');
  });

  it('the ⋯ menu offers Copy link, Share… and Copy as Markdown', async () => {
    vi.mocked(getShareLink).mockResolvedValue({ link: link({ taskPages: true }), counts: COUNTS });
    await mount();
    const items = await openMenu();
    expect(items.map((el) => el.textContent)).toEqual(['Copy link', 'Share…Live link', 'Copy as Markdown']);

    await click(item(items, 'Copy as Markdown'), 'Copy as Markdown');
    expect(vi.mocked(copyText).mock.calls.length).toBe(1);
    const markdown = vi.mocked(copyText).mock.calls[0][0];
    expect(markdown).toBe(projectMarkdown(PROJECT_DOC, APP_URL, {}));
    expect(toast.success).toHaveBeenCalledWith('Markdown copied');
  });

  it('Copy as Markdown: title, status and progress, goal, each criterion with what its work did, the tasks, the link', () => {
    const markdown = projectMarkdown(PROJECT_DOC, APP_URL, {
      buckets: { running: 2, ready: 0, blocked: 0, awaitingVerification: 0, done: 10, failed: 0, cancelled: 0 },
      tasks: [
        { title: 'T8 收尾', status: 'OPEN', workState: 'RUNNING' },
        { title: 'T6 安全边界', status: 'DONE', workState: 'DONE' },
      ],
    });
    expect(markdown).toBe(
      [
        `# ${TITLE}`,
        '',
        '**Status:** Open · 12 tasks · 10 done, 2 running',
        `**Link:** ${APP_URL}`,
        '',
        '## Goal',
        '',
        '把一组同厂商的 Claude 订阅凭据表达成一个可派发的池身份。',
        '',
        '## Acceptance criteria',
        '',
        '1. 同一 owner 的多行订阅可以归入一个池。 — Met by its work · on main',
        '2. 派发时选中窗口占用最低的那一行。 — Met by its work · on the project branch · not on main yet',
        '3. 客户端能看到每个成员的占用。 — Not met by its work',
        '',
        '## Tasks',
        '',
        '- T8 收尾 — Running',
        '- T6 安全边界 — Done',
        '',
      ].join('\n'),
    );
  });
});

describe('the Share dialog, on a project', { timeout: 60_000 }, () => {
  it('has Task pages on by default, and Comments & files and Conversations under it, greyed out with it', async () => {
    // A link opened with the defaults (contract §1): Task pages on, the two below it off.
    let stored = link({ taskPages: true, commentsAndFiles: false, conversations: false, toolOutput: true });
    vi.mocked(getShareLink).mockImplementation(async () => ({ link: structuredClone(stored), counts: COUNTS }));
    vi.mocked(putShareLink).mockImplementation(async (_kind, _id, body) => {
      stored = { ...stored, include: { ...stored.include, ...body.include } };
      return structuredClone(stored);
    });
    await mount();
    await click(container!.querySelector('.session-shared-pill'), 'the Shared · Live pill');
    await vi.waitFor(() => expect(dialog().querySelector('.share-layers')).not.toBeNull());
    expect(layers()).toEqual([
      { name: 'Overview', detail: 'Goal, work overview, acceptance criteria and task graph', nested: false, idle: false, on: true, locked: true, count: 'Always' },
      { name: 'Task pages', detail: 'Description, acceptance and runs for each task', nested: false, idle: false, on: true, locked: false, count: '12 tasks' },
      { name: 'Comments & files', detail: 'Written by agents and people', nested: true, idle: false, on: false, locked: false, count: '29 comments' },
      {
        name: 'Conversations',
        detail: '13 runs and the coordinator. Can include command output and file contents.',
        nested: true, idle: false, on: false, locked: false, count: '14 transcripts',
      },
    ]);

    // Task pages off: saved as it is made, and the two layers under it go grey and cannot be pressed.
    await click(dialog().querySelector('[data-layer="taskPages"] input[type="checkbox"]'), 'the Task pages box');
    expect(vi.mocked(putShareLink).mock.calls).toEqual([['PROJECT', PROJECT, { include: { taskPages: false } }]]);
    await vi.waitFor(() =>
      expect(layers().slice(1).map(({ name, on, idle, locked }) => ({ name, on, idle, locked }))).toEqual([
        { name: 'Task pages', on: false, idle: false, locked: false },
        { name: 'Comments & files', on: false, idle: true, locked: true },
        { name: 'Conversations', on: false, idle: true, locked: true },
      ]),
    );
  });
});
