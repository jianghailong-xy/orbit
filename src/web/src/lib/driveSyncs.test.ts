// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiMock = vi.hoisted(() => vi.fn());
vi.mock('../api', () => ({ api: apiMock }));

import { clearFinishedSyncs, refreshDriveSyncs, resetDriveSyncs, useDriveSyncs, type DriveSync, type DriveSyncView } from './driveSyncs';

const view = (id: string, status: DriveSyncView['status']): DriveSyncView => ({
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
  resetDriveSyncs();
  localStorage.clear();
  apiMock.mockReset();
});

function mount() {
  const seen = { current: [] as DriveSync[] };
  const host = document.createElement('div');
  const root = createRoot(host);
  const Probe = () => {
    seen.current = useDriveSyncs();
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
    expect(apiMock).toHaveBeenCalledWith('/drive/syncs');

    apiMock.mockResolvedValue({ syncs: [view('a', 'DONE'), view('b', 'UPLOADING')] });
    await act(() => refreshDriveSyncs());
    expect(first.seen.current.map((s) => s.status)).toEqual(['DONE', 'UPLOADING']);

    act(() => clearFinishedSyncs());
    expect(first.seen.current.map((s) => s.id)).toEqual(['b']);
    first.unmount();

    // A reload: memory is gone, localStorage stays.
    resetDriveSyncs();
    const second = mount();
    await settle();
    expect(second.seen.current.map((s) => s.id)).toEqual(['b']);
    second.unmount();
  });
});
