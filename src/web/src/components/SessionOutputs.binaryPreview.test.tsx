// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, getWorktreeFile, type SessionDetail } from '../api';
import { SessionOutputs } from './SessionOutputs';

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  getSessionDiff: vi.fn(async () => ({
    patches: [{ path: 'docs/mocks/board/README.md', patch: '@@ -0,0 +1 @@\n+# Board' }],
  })),
  getWorktreeFile: vi.fn(),
  refreshSessionDiff: vi.fn(async () => undefined),
}));

const SESSION = 'session-that-drew-a-board';
const BOARD = 'docs/mocks/board/01-flow.png';
const FRAME = 'docs/mocks/board/frames/a.png';
const FONT = 'docs/mocks/board/fonts/Inter.woff2';
const GONE = 'old-logo.png';
const bin = (path: string, status = 'A') => ({ path, additions: -1, deletions: -1, status });

/** A session whose agent drew a mock board: its files as the runner reported them. In the drawer's
 *  order (folders first): fonts/Inter.woff2, frames/a.png, 01-flow.png, README.md, old-logo.png. */
const DETAIL = {
  id: SESSION,
  isolationStatus: 'worktree',
  branch: 'orbit/draw-the-board-6b9cd9',
  changedFiles: [
    { path: 'docs/mocks/board/README.md', additions: 1, deletions: 0, status: 'A' },
    bin(BOARD), bin(FRAME), bin(FONT), bin(GONE, 'D'),
  ],
  worktreeDirty: true,
} as unknown as SessionDetail;

// jsdom neither makes object URLs nor decodes pictures: these stand in, decoding a PNG blob as a
// 3440 × 9130 picture and anything else as bytes that are not a picture.
const blobs = new Map<string, Blob>();
class FakeImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  naturalWidth = 0;
  naturalHeight = 0;
  set src(url: string) {
    const blob = blobs.get(url);
    setTimeout(() => {
      if (blob?.type !== 'image/png') return this.onerror?.();
      this.naturalWidth = 3440;
      this.naturalHeight = 9130;
      this.onload?.();
    }, 0);
  }
}
const png = () => new Blob([new Uint8Array(2_256_476)], { type: 'image/png' });

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let downloads: string[] = [];

beforeEach(() => {
  let made = 0;
  blobs.clear();
  Object.assign(URL, {
    createObjectURL: (blob: Blob) => {
      const url = `blob:test/${++made}`;
      blobs.set(url, blob);
      return url;
    },
    revokeObjectURL: (url: string) => void blobs.delete(url),
  });
  vi.stubGlobal('Image', FakeImage);
  downloads = [];
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    downloads.push(this.download);
  });
  vi.mocked(getWorktreeFile).mockReset();
});

afterEach(async () => {
  const mounted = root;
  root = null;
  if (mounted) await act(async () => mounted.unmount());
  container?.remove();
  container = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

/** Let fetches, decodes and the re-renders they cause run out: React flushes at the end of each act,
 *  and each flush can start the next step (the object URL, then the decode), so one act per tick. */
async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/** The session's worktree bar, pressed open: the drawer starts on the first text file (README.md). */
async function openDrawer(): Promise<void> {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root!.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <SessionOutputs detail={DETAIL} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await press(container.querySelector('.wt-row-toggle'));
  await settle();
}

async function press(el: Element | null | undefined): Promise<void> {
  expect(el, 'the element to press').toBeTruthy();
  await act(async () => (el as HTMLElement).click());
  await settle();
}

const row = (path: string) => document.querySelector(`.wt-diff-list button[title="View diff · ${path}"]`);
const head = () => document.querySelector('.wt-diff-pane-head');
const pane = () => document.querySelector('.wt-diff-pane');
const buttonIn = (scope: Element | null, label: string) =>
  [...(scope?.querySelectorAll('button') ?? [])].find((b) => b.textContent?.trim() === label);

describe('a binary file in the diff drawer', () => {
  it('is read from the worktree and drawn, with its kind, size and a Download', async () => {
    vi.mocked(getWorktreeFile).mockResolvedValue(png());
    await openDrawer();

    await press(row(BOARD));

    expect(getWorktreeFile).toHaveBeenCalledTimes(1);
    expect(vi.mocked(getWorktreeFile).mock.calls[0].slice(0, 2)).toEqual([SESSION, BOARD]);
    const img = pane()?.querySelector<HTMLImageElement>('.wt-preview-img img');
    expect(img?.getAttribute('src')).toMatch(/^blob:test\//);
    expect(img?.alt).toBe('01-flow.png');
    expect(head()?.querySelector('.wt-preview-meta')?.textContent).toBe('PNG3440 × 9130·2.2 MB');
    expect(buttonIn(head(), 'Download')?.disabled).toBe(false);
    expect(pane()?.textContent).not.toContain('Binary file');

    // Download hands over the bytes already read, under the file's own name.
    await press(buttonIn(head(), 'Download'));
    expect(downloads).toEqual(['01-flow.png']);
    expect(getWorktreeFile).toHaveBeenCalledTimes(1);

    // Pressing the picture opens it in the full-screen viewer.
    await press(pane()?.querySelector('.wt-preview-img'));
    expect(document.querySelector('.orbit-image-preview-img')?.getAttribute('src')).toBe(img?.getAttribute('src'));
  });

  it('is not read when it is not a picture, until Download asks for it', async () => {
    vi.mocked(getWorktreeFile).mockResolvedValue(new Blob([new Uint8Array(110_000)]));
    await openDrawer();
    await press(document.querySelector('.wt-diff-group-head[title="docs/mocks/board/fonts"]'));

    await press(row(FONT));

    expect(pane()?.textContent).toContain('No preview available');
    expect(getWorktreeFile).not.toHaveBeenCalled();
    await press(buttonIn(pane(), 'Download'));
    expect(vi.mocked(getWorktreeFile).mock.calls.map((call) => call[1])).toEqual([FONT]);
    expect(downloads).toEqual(['Inter.woff2']);
    expect(head()?.querySelector('.wt-preview-meta')?.textContent).toBe('WOFF2107 KB');
  });

  it('is not read when it was deleted', async () => {
    await openDrawer();

    await press(row(GONE));

    expect(pane()?.textContent).toContain('File deleted');
    expect(pane()?.textContent).toContain('This file is no longer in the current worktree.');
    expect(buttonIn(head(), 'Download')).toBeUndefined();
    expect(getWorktreeFile).not.toHaveBeenCalled();
  });

  it('says why a read failed, and Retry reads it again', async () => {
    vi.mocked(getWorktreeFile).mockRejectedValueOnce(
      new ApiError('The runner is offline. Try again when it is online.', 503),
    );
    await openDrawer();

    await press(row(BOARD));

    expect(pane()?.textContent).toContain('Runner unavailable');
    expect(buttonIn(head(), 'Download')).toBeUndefined();
    vi.mocked(getWorktreeFile).mockResolvedValueOnce(png());
    await press(buttonIn(pane(), 'Retry'));
    expect(getWorktreeFile).toHaveBeenCalledTimes(2);
    expect(pane()?.querySelector('.wt-preview-img img')).toBeTruthy();
  });

  it('offers no Retry for a file over the upload limit', async () => {
    vi.mocked(getWorktreeFile).mockRejectedValue(new ApiError('This file is too large to preview or download.', 413));
    await openDrawer();

    await press(row(BOARD));

    expect(pane()?.textContent).toContain('File too large');
    expect(buttonIn(pane(), 'Retry')).toBeUndefined();
  });

  it('says so when the bytes that came back are not a picture after all', async () => {
    vi.mocked(getWorktreeFile).mockResolvedValue(new Blob(['<html>'], { type: 'text/html' }));
    await openDrawer();

    await press(row(BOARD));

    expect(pane()?.textContent).toContain("Couldn't preview image");
    expect(buttonIn(pane(), 'Retry')).toBeTruthy();
  });
});

describe('paging the drawer with ‹ ›', () => {
  it('takes in binary files, and opens the shut folder the shown file is in', async () => {
    vi.mocked(getWorktreeFile).mockResolvedValue(png());
    await openDrawer();
    expect(head()?.querySelector('.wt-diff-nav-pos')?.textContent).toBe('4/5');
    // frames/ holds only binary files, so it starts shut.
    expect(row(FRAME)).toBeNull();

    await press(document.querySelector('button[aria-label="Previous file"]'));
    expect(head()?.querySelector('.wt-diff-pane-path')?.textContent).toBe(BOARD);
    expect(head()?.querySelector('.wt-diff-nav-pos')?.textContent).toBe('3/5');

    await press(document.querySelector('button[aria-label="Previous file"]'));
    expect(head()?.querySelector('.wt-diff-pane-path')?.textContent).toBe(FRAME);
    expect(row(FRAME)?.classList.contains('active')).toBe(true);
    expect(vi.mocked(getWorktreeFile).mock.calls.map((call) => call[1])).toEqual([BOARD, FRAME]);
  });
});
