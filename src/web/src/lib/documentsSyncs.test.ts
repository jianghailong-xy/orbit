// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiMock = vi.hoisted(() => vi.fn());
vi.mock('../api', () => ({ api: apiMock }));

import { clearFinishedSyncs, refreshDocumentsSyncs, resetDocumentsSyncs, useDocumentsSyncs, type DocumentsSync, type DocumentsSyncView } from './documentsSyncs';

const view = (id: string, status: DocumentsSyncView['status']): DocumentsSyncView => ({
  id,
  status,
  sourceName: 'out',
  destPath: '/R/out',
  destEntryId: null,
  session: null,
  filesSeen: 0,
  filesTotal: null,
  filesDone: 0,
  filesSame: 0,
  filesDeleted: 0,
  bytesTotal: null,
  bytesSent: 0,
  currentPath: null,
  failed: [],
  failedCount: 0,
  error: null,
  startedAt: '2026-11-24T10:00:00Z',
  updatedAt: '2026-11-24T10:00:00Z',
  endedAt: null,
});

beforeEach(() => {
  resetDocumentsSyncs();
  localStorage.clear();
  apiMock.mockReset();
});

function mount() {
  const seen = { current: [] as DocumentsSync[] };
  const host = document.createElement('div');
  const root = createRoot(host);
  const Probe = () => {
    seen.current = useDocumentsSyncs();
    return null;
  };
  act(() => root.render(createElement(Probe)));
  return { seen, unmount: () => act(() => root.unmount()) };
}
const settle = () => act(() => new Promise<void>((r) => setTimeout(r, 0)));

describe('drive syncs store', () => {
  it('reads again when told (drive.sync) and keeps Clear finished across a reload', async () => {
    apiMock.mockResolvedValue({ syncs: [view('a', 'UPLOADING')] });
    const first = mount();
    await settle();
    expect(first.seen.current).toHaveLength(1);
    expect(apiMock).toHaveBeenCalledWith('/documents/syncs');

    apiMock.mockResolvedValue({ syncs: [view('a', 'DONE'), view('b', 'UPLOADING')] });
    await act(() => refreshDocumentsSyncs());
    expect(first.seen.current.map((s) => s.status)).toEqual(['DONE', 'UPLOADING']);

    act(() => clearFinishedSyncs());
    expect(first.seen.current.map((s) => s.id)).toEqual(['b']);
    first.unmount();

    // A reload: memory is gone, localStorage stays.
    resetDocumentsSyncs();
    const second = mount();
    await settle();
    expect(second.seen.current.map((s) => s.id)).toEqual(['b']);
    second.unmount();
  });
});
