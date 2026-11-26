// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import type { DriveSync } from '../../lib/driveSyncs';
import type { DriveUpload } from '../../lib/driveUploads';
import { DriveUploadTray } from './DriveUploadTray';

const sync = (over: Partial<DriveSync>): DriveSync => ({
  id: 's1',
  status: 'UPLOADING',
  sourceName: 'out',
  destPath: '/Reports/out',
  destEntryId: 'e1',
  session: { id: 'sess1', title: 'Nightly report' },
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
  updatedAt: '2026-11-24T10:05:00Z',
  endedAt: null,
  rate: null,
  ...over,
});

const upload = (over: Partial<DriveUpload> = {}): DriveUpload => ({
  key: 'u1',
  name: 'a.pdf',
  size: 2000,
  lastModified: 0,
  parentId: null,
  parentName: 'Drive',
  relativePath: null,
  dropKey: null,
  uploadId: null,
  sentBytes: 1000,
  status: 'uploading',
  error: null,
  rate: null,
  entryId: null,
  file: null,
  ...over,
});

let root: Root | null = null;
let host: HTMLElement | null = null;

const show = (syncs: DriveSync[], uploads: DriveUpload[] = []) => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <MemoryRouter>
        <DriveUploadTray uploads={uploads} syncs={syncs} />
      </MemoryRouter>,
    );
  });
};
const text = () => document.body.textContent ?? '';
const button = (name: string) =>
  [...document.body.querySelectorAll('button')].find((b) => b.textContent === name) ?? null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  document.body.innerHTML = '';
});

describe('sync rows in the upload tray', () => {
  it('shows a checking sync with a count and no Pause', () => {
    show([sync({ status: 'CHECKING', filesSeen: 1234 })]);
    expect(text()).toContain('Agent sync');
    expect(text()).toContain('Checking files… 1,234 so far');
    expect(button('Pause')).toBeNull();
  });

  it('shows an uploading sync with its counts, the current file and the session link', () => {
    show([sync({ filesTotal: 10, filesDone: 3, bytesTotal: 5000, bytesSent: 2000, currentPath: 'a/b.csv' })]);
    expect(text()).toContain('3 of 10 files · 2 KB of 5 KB');
    expect(text()).toContain('a/b.csv');
    const link = [...document.body.querySelectorAll('a')].find((a) => a.textContent === 'Nightly report');
    expect(link?.getAttribute('href')).toBe('/sessions/sess1');
  });

  it('shows done, and already up to date', () => {
    show([
      sync({ id: 'a', status: 'DONE', filesDone: 4, bytesSent: 3000, filesDeleted: 2 }),
      sync({ id: 'b', status: 'DONE', sourceName: 'logs', filesSame: 7 }),
    ]);
    expect(text()).toContain('Synced 4 files · 3 KB · 2 moved to Trash');
    expect(text()).toContain('Already up to date · 7 files');
    expect(text()).toContain('Synced 2 folders');
  });

  it('opens Details for failures and lists each path', () => {
    show([
      sync({
        status: 'DONE',
        filesDone: 5,
        failedCount: 3,
        failed: [{ path: 'x/y.bin', error: 'Too large' }],
        endedAt: '2026-11-24T10:06:00Z',
      }),
    ]);
    expect(text()).toContain('Synced 5 files · 3 failed ·');
    act(() => button('Details')!.click());
    expect(text()).toContain('x/y.bin');
    expect(text()).toContain('Too large');
    expect(text()).toContain('and 2 more');
    expect(text()).toContain("Ask the agent to run the sync again; it only sends what's still missing.");
    expect(button('Open out')).not.toBeNull();
  });

  it('shows a stopped sync next to an owner upload and counts both', () => {
    show([sync({ status: 'STOPPED', filesDone: 2, filesTotal: null })], [upload()]);
    expect(text()).toContain('Stopped · 2 of ? files synced');
    expect(text()).toMatch(/Uploading 2 of 2 · /);
    expect(button('Pause')).not.toBeNull();
  });
});
