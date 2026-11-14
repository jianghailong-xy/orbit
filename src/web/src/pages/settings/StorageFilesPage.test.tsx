// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoredFile, StoredFilesPage } from '../../lib/queries';

/**
 * Settings → Storage → a project, task or week: the files its row counts, each once, with how long each stays, and a menu
 * that downloads, pins, opens its session, or deletes it everywhere: asked first, refused with the reason where evidence or
 * a session holds it. Over a stand-in for the server's `/api`.
 */
vi.mock('../../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api')>()),
  api: vi.fn(),
  deleteAttachmentEverywhere: vi.fn(),
}));
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() };
vi.mock('../../lib/toast', () => ({ useToast: () => toast }));

const { api, deleteAttachmentEverywhere } = await import('../../api');
const { StorageFilesPage, storedFileDeleteDescription, storedFileFacts } = await import('./StorageFilesPage');

const MB = 1024 * 1024;
const NOW = Date.parse('2026-11-14T10:00:00Z');
const DAY = 86_400_000;

function file(name: string, extra: Partial<StoredFile> = {}): StoredFile {
  return {
    id: `id-${name}`, fileName: name, label: null, mimeType: 'text/plain', sizeBytes: MB, createdAt: new Date(NOW - 3 * DAY).toISOString(),
    taskId: 't1', taskTitle: 'A02 · Android CI', sessionId: 's1', sessionTitle: 'Android project and CI', source: 'upload',
    pinnedAt: null, expiresAt: new Date(NOW + 7 * DAY).toISOString(), expiredAt: null, heldBy: null, alsoIn: 0, ...extra,
  };
}

let files: StoredFile[];
let requests: Array<{ path: string; method: string }>;
let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function click(element: Element | null | undefined, what: string): Promise<void> {
  expect(element, `${what} is on screen`).toBeTruthy();
  await act(async () => {
    element!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await settle();
}

async function open(path = '/settings/storage/projects/p1'): Promise<void> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={[path]}>
        <QueryClientProvider client={client}>
          <Routes>
            <Route path="/settings/storage/:kind/:id" element={<StorageFilesPage />} />
          </Routes>
        </QueryClientProvider>
      </MemoryRouter>,
    );
  });
  await vi.waitFor(() => expect(rows().length).toBeGreaterThan(0));
  await settle();
}

const rows = () => [...container!.querySelectorAll<HTMLElement>('.storage-file-row')];
const rowOf = (name: string) => rows().find((row) => row.querySelector('.storage-file-name-text')?.textContent === name);
const menuItems = () => [...document.body.querySelectorAll<HTMLElement>('[role="menu"] [role="menuitem"]')];
const confirmDialog = () => document.body.querySelector<HTMLElement>('.orbit-confirm[data-open]');
const button = (within: ParentNode | null | undefined, label: string) =>
  [...(within?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find((b) => b.textContent?.trim() === label);

async function openMenu(name: string): Promise<void> {
  await click(rowOf(name)?.querySelector(`button[aria-label="More for ${name}"]`), `${name}'s menu`);
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false, media: query, onchange: null, addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  files = [
    file('boot.mp4', { mimeType: 'video/mp4', sizeBytes: 38 * MB, heldBy: 'EVIDENCE', expiresAt: null, label: 'Cold boot on API 35' }),
    file('scan.zip', { sizeBytes: 21 * MB, alsoIn: 2 }),
    file('shot.png', { sizeBytes: 3 * MB, source: 'conversation', heldBy: 'CONVERSATION', expiresAt: null }),
  ];
  requests = [];
  vi.mocked(deleteAttachmentEverywhere).mockReset();
  vi.mocked(deleteAttachmentEverywhere).mockImplementation(async (id: string) => {
    requests.push({ path: `/attachments/${id}/everywhere`, method: 'DELETE' });
    files = files.filter((f) => f.id !== id);
  });
  vi.mocked(api).mockReset();
  vi.mocked(api).mockImplementation(async (path: string, options: { method?: string } = {}) => {
    const method = options.method ?? 'GET';
    requests.push({ path, method });
    if (path.startsWith('/attachments/usage/projects/p1/files')) {
      const page: StoredFilesPage = {
        title: 'Orbit Android', totalBytes: files.reduce((n, f) => n + f.sizeBytes, 0), fileCount: files.length, files, nextCursor: null,
      };
      return page;
    }
    throw new Error(`unexpected ${method} ${path}`);
  });
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('Settings → Storage → one row\'s files', () => {
  it('lists each file under its project\'s title, with its size and how long it stays', async () => {
    await open();
    expect(container!.querySelector('h1')?.textContent).toBe('Orbit Android');
    expect(container!.textContent).toContain('62.0 MB · 3 files');
    expect(rows().map((row) => row.querySelector('.storage-file-name-text')?.textContent)).toEqual(['boot.mp4', 'scan.zip', 'shot.png']);
    expect(rowOf('boot.mp4')!.textContent).toContain('Cold boot on API 35');
    expect(rowOf('boot.mp4')!.textContent).toContain('Kept by evidence');
    expect(rowOf('scan.zip')!.textContent).toContain('Also in 2 other places');
    expect(rowOf('shot.png')!.textContent).toContain('Kept with its session');
    expect(requests[0]).toEqual({ path: '/attachments/usage/projects/p1/files?order=size', method: 'GET' });
  });

  it('asks before deleting, says what it frees, and reads the list again', async () => {
    await open();
    await openMenu('scan.zip');
    expect(menuItems().map((item) => item.textContent?.trim())).toEqual(['Download', 'Pin', 'Go to session', 'Delete…']);
    await click(menuItems().find((item) => item.textContent?.trim() === 'Delete…'), 'Delete');
    const dialog = confirmDialog();
    expect(dialog?.textContent).toContain('Delete scan.zip?');
    expect(dialog?.textContent).toContain('It goes from here and from the 2 other places that keep it, which frees 21.0 MB.');
    expect(requests.some((r) => r.method === 'DELETE')).toBe(false);
    await click(button(dialog, 'Delete'), 'the dialog\'s Delete');
    expect(requests.filter((r) => r.method === 'DELETE')).toEqual([{ path: '/attachments/id-scan.zip/everywhere', method: 'DELETE' }]);
    await vi.waitFor(() => expect(rowOf('scan.zip')).toBeUndefined());
  });

  it('does not offer Delete where evidence or a session holds the file, and says why', async () => {
    await open();
    await openMenu('boot.mp4');
    const evidence = menuItems().find((item) => item.textContent?.startsWith('Delete'));
    expect(evidence?.getAttribute('aria-disabled')).toBe('true');
    expect(evidence?.textContent).toContain('Evidence cites it.');
    expect(menuItems().map((item) => item.textContent?.trim())).not.toContain('Pin');
  });
});

describe('what a file row says', () => {
  it('leaves out the task on a task\'s own list, and says an expired file expired', () => {
    const now = new Date(NOW);
    vi.setSystemTime(now);
    expect(storedFileFacts(file('a.txt'), 'tasks')).toBe('Android project and CI · Added Nov 11 · Expires Nov 21');
    expect(storedFileFacts(file('a.txt', { expiredAt: new Date(NOW - DAY).toISOString() }), 'weeks')).toContain('Expired Nov 13');
    expect(storedFileDeleteDescription(file('a.txt', { alsoIn: 1 }))).toBe(
      'It goes from here and from the other place that keeps it, which frees 1.0 MB. Where it was shown, Orbit says it was deleted.',
    );
    expect(storedFileDeleteDescription(file('a.txt'))).toBe('This frees 1.0 MB. Where it was shown, Orbit says it was deleted.');
    vi.useRealTimers();
  });
});
