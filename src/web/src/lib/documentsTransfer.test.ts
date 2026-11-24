import { describe, expect, it } from 'vitest';
import {
  commonFolder,
  documentsDisplayPath,
  documentsTransferFile,
  parseDocumentsProgress,
  summarizeDocumentsTransfer,
  timeLeftText,
  transferRate,
} from './documentsTransfer';

describe('drive transfer progress', () => {
  it('reads the runner’s line and nothing else', () => {
    expect(parseDocumentsProgress('Uploaded 3355443 of 11954323 bytes')).toEqual({ sent: 3355443, size: 11954323 });
    expect(parseDocumentsProgress('Downloaded 5 of 5 bytes')).toEqual({ sent: 5, size: 5 });
    expect(parseDocumentsProgress('Uploaded 5 of 0 bytes')).toBeNull();
    expect(parseDocumentsProgress('npm test')).toBeNull();
    expect(parseDocumentsProgress(42)).toBeNull();
  });

  it('shows drive paths as Files does', () => {
    expect(documentsDisplayPath('~/Files/Shuge/a.jpg')).toBe('/Shuge/a.jpg');
    expect(documentsDisplayPath('/run/orbit-files/drive/Shuge/a.jpg')).toBe('/Shuge/a.jpg');
    expect(documentsDisplayPath('Shuge//a.jpg')).toBe('/Shuge/a.jpg');
    expect(commonFolder(['/Shuge/d/单幅/a.jpg', '/Shuge/d/老地图/b.jpg'])).toBe('/Shuge/d/');
    expect(commonFolder(['/a.jpg', '/b/c.jpg'])).toBe('/');
  });

  it('builds each file from its result, its live count, or neither', () => {
    const done = documentsTransferFile({
      id: 't1',
      toolInput: { path: '/S/a.jpg' },
      result: { text: '{"id":"e1","link":"orbit-document:e1","sizeBytes":400}' },
      progress: undefined,
      live: true,
      ts: '2026-11-24T10:00:00Z',
      resultTs: '2026-11-24T10:00:02Z',
    });
    expect(done).toMatchObject({ status: 'done', sent: 400, size: 400, link: 'orbit-document:e1' });

    const failed = documentsTransferFile({
      id: 't2',
      toolInput: { path: '/S/b.jpg' },
      result: { text: 'Drive quota reached.\nmore', isError: true },
      progress: undefined,
      live: true,
    });
    expect(failed).toMatchObject({ status: 'failed', error: 'Drive quota reached.' });

    const running = { id: 't3', toolInput: { path: '/S/c.jpg' }, progress: 'Uploaded 100 of 1000 bytes' };
    expect(documentsTransferFile({ ...running, live: true })).toMatchObject({ status: 'running', sent: 100, size: 1000 });
    expect(documentsTransferFile({ ...running, live: false }).status).toBe('stopped');
    expect(documentsTransferFile({ id: 't4', toolInput: { path: '/S/d.jpg' }, progress: undefined, live: true }).status).toBe(
      'waiting',
    );
  });

  it('sums a run: files done, the running share, and the bytes still to go', () => {
    const files = [
      documentsTransferFile({ id: 'a', toolInput: { path: '/S/x/a' }, result: { text: '{"sizeBytes":400}' }, progress: undefined, live: true }),
      documentsTransferFile({ id: 'b', toolInput: { path: '/S/y/b' }, progress: 'Uploaded 250 of 1000 bytes', live: true }),
    ];
    const summary = summarizeDocumentsTransfer('put', files);
    expect(summary).toMatchObject({ folder: '/S/', total: 2, done: 1, waiting: 0, sentBytes: 650, leftBytes: 750, finished: false });
    expect(summary.fraction).toBeCloseTo(0.625);

    const withWaiting = summarizeDocumentsTransfer('put', [
      ...files,
      documentsTransferFile({ id: 'c', toolInput: { path: '/S/c' }, progress: undefined, live: true }),
    ]);
    expect(withWaiting.leftBytes).toBeNull();
  });

  it('measures speed over the last few seconds and says the time left as the upload tray does', () => {
    expect(transferRate([{ at: 0, bytes: 0 }])).toBeNull();
    expect(
      transferRate([
        { at: 0, bytes: 0 },
        { at: 5000, bytes: 1_000_000 },
        { at: 6000, bytes: 6_000_000 },
        { at: 8000, bytes: 16_000_000 },
      ]),
    ).toBe(5_000_000);
    expect(timeLeftText(10_000_000, 5_000_000)).toBe('under a minute left');
    expect(timeLeftText(900_000_000, 5_000_000)).toBe('about 3 min left');
  });
});
