// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const apiMock = vi.hoisted(() => vi.fn());
vi.mock('../../api', () => ({ api: apiMock }));

import { driveSyncIdOf, refreshDriveSyncs, resetDriveSyncs, type DriveSyncView } from '../../lib/driveSyncs';
import { DriveSyncCard } from './DriveSyncCard';

/**
 * An agent's drive_sync call drawn as its sync's card (board docs/mocks/drive-sync-card): every state, a clean
 * end left open until Hide folds it, the failed paths, and a sync read by id once it is too old for the tray's list.
 */

const sync = (over: Partial<DriveSyncView> = {}): DriveSyncView => ({
  id: 's1',
  status: 'UPLOADING',
  sourceName: 'stage',
  destPath: '/书格',
  destEntryId: 'd1',
  session: { id: 'x1', title: 'Sync the archive' },
  filesSeen: 28705,
  filesTotal: 28701,
  filesDone: 412,
  filesSame: 4,
  filesDeleted: 0,
  bytesTotal: 2_600_000_000_000,
  bytesSent: 238_000_000_000,
  currentPath: 'PDF/谢宣城诗集.pdf',
  failed: [],
  failedCount: 0,
  error: null,
  startedAt: '2026-11-24T06:57:00Z',
  updatedAt: '2026-11-24T07:30:00Z',
  endedAt: null,
  ...over,
});

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  resetDriveSyncs();
  apiMock.mockReset();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  resetDriveSyncs();
});

async function draw(list: DriveSyncView[], byId?: DriveSyncView) {
  apiMock.mockImplementation(async (path: string) => {
    if (path === '/drive/syncs') return { syncs: list };
    if (byId && path === `/drive/syncs/${byId.id}`) return byId;
    throw new Error('not found');
  });
  await act(async () => {
    root.render(
      <MemoryRouter>
        <DriveSyncCard syncId="s1" />
      </MemoryRouter>,
    );
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
  return host.textContent?.replace(/\s+/g, ' ') ?? '';
}

describe('the sync card', () => {
  it('names the sync from a drive_sync or documents_sync answer, and nothing from an older one', () => {
    expect(driveSyncIdOf('{"jobId":"bgj_1","syncId":"s1"}')).toBe('s1');
    // What a runner sends today: its answer as a receipt, the call's own answer under `entity`.
    const receipt = (entity: object, ok = true, operation = 'drive_sync') =>
      JSON.stringify({ receiptVersion: 1, ok, outcome: ok ? 'written' : 'refused', operation, id: 'bgj_1', entity });
    expect(driveSyncIdOf(receipt({ jobId: 'bgj_1', status: 'running', syncId: '35344yWPof4phuXdrUNez' }))).toBe('35344yWPof4phuXdrUNez');
    expect(driveSyncIdOf(receipt({ jobId: 'bgj_1', status: 'running', syncId: 's2' }, true, 'documents_sync'))).toBe('s2');
    expect(driveSyncIdOf(receipt({ jobId: 'bgj_1', status: 'running' }))).toBeNull();
    expect(driveSyncIdOf(receipt({ syncId: 's1' }, false))).toBeNull();
    expect(driveSyncIdOf('{"jobId":"bgj_1","status":"running"}')).toBeNull();
    expect(driveSyncIdOf('not json')).toBeNull();
  });

  it('draws checking with no total yet', async () => {
    const text = await draw([sync({ status: 'CHECKING', filesTotal: null, bytesTotal: null, filesSeen: 12480, currentPath: null })]);
    expect(text).toContain('Syncing to Drive');
    expect(text).toContain('Checking files… 12,480 so far');
    expect(text).toContain('Background');
    expect(host.querySelector('.drive-xfer-bar.is-indeterminate')).not.toBeNull();
  });

  it('draws an upload with its counts, the file going now and where it came from', async () => {
    const text = await draw([sync()]);
    expect(text).toContain('412 of 28,701 files');
    expect(text).toContain('PDF/谢宣城诗集.pdf');
    expect(text).toContain('from stage/');
    expect(text).toContain('Open folder');
  });

  it('keeps a clean end open, and Hide folds it to one line', async () => {
    const text = await draw([sync({ status: 'DONE', filesDone: 28701, bytesSent: 2_600_000_000_000, currentPath: null, endedAt: '2026-11-24T21:03:00Z' })]);
    expect(host.querySelector('section.drive-xfer')).not.toBeNull();
    expect(text).toContain('Synced 28,701 files');
    expect(text).toContain('4 already the same');
    const hide = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Hide')!;
    act(() => hide.click());
    const folded = host.textContent?.replace(/\s+/g, ' ') ?? '';
    expect(host.querySelector('section.drive-xfer')).toBeNull();
    expect(folded).toContain('Synced 28,701 files to');
    expect(folded).toContain('/书格');
  });

  it('keeps a sync that finishes while watched open', async () => {
    await draw([sync()]);
    expect(host.querySelector('section.drive-xfer')).not.toBeNull();
    apiMock.mockResolvedValue({ syncs: [sync({ status: 'DONE', filesDone: 28701, currentPath: null, endedAt: '2026-11-24T21:03:00Z' })] });
    await act(async () => {
      await refreshDriveSyncs();
    });
    expect(host.textContent).toContain('Synced 28,701 files');
    expect(host.querySelector('section.drive-xfer')).not.toBeNull();
  });

  it('says when there was nothing to send, and what --delete moved to Trash', async () => {
    const text = await draw([sync({ status: 'DONE', filesDone: 0, filesSame: 28701, filesDeleted: 3, endedAt: '2026-11-24T06:57:41Z' })]);
    expect(text).toContain('Already up to date');
    expect(text).toContain('28,701 files checked');
    expect(text).toContain('3 moved to Trash');
  });

  it('keeps a sync with failures open, with each failed path and its reason', async () => {
    const failed = [
      { path: 'PDF/a.pdf', error: 'The file is larger than 5 GB.' },
      { path: '古图/b.tif', error: 'Changed while uploading.' },
    ];
    const text = await draw([sync({ status: 'DONE', filesDone: 28694, failed, failedCount: 2, endedAt: '2026-11-24T21:03:00Z' })]);
    expect(text).toContain('Synced 28,694 of 28,701 files');
    expect(text).toContain('2 failed');
    expect(text).toContain('PDF/a.pdf');
    expect(text).toContain('Changed while uploading.');
  });

  it('draws a stopped sync and a failed one', async () => {
    expect(await draw([sync({ status: 'STOPPED', endedAt: '2026-11-24T07:40:00Z' })])).toContain('Sync stopped');
    act(() => root.unmount());
    resetDriveSyncs();
    root = createRoot(host);
    const text = await draw([sync({ status: 'FAILED', error: '/书格 is a file in Drive, not a folder.', endedAt: '2026-11-24T06:57:05Z' })]);
    expect(text).toContain('Sync failed');
    expect(text).toContain('not a folder');
  });

  it('reads a sync too old for the tray by id', async () => {
    const text = await draw([], sync({ status: 'DONE', filesDone: 9, endedAt: '2026-11-20T06:57:05Z' }));
    expect(apiMock).toHaveBeenCalledWith('/drive/syncs/s1');
    expect(text).toContain('Synced 9 files');
  });
});
