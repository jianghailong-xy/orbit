import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { driveUsageQuery, meQuery, storageUsageQuery, type DriveUsage, type StorageUsage } from '../../lib/queries';
import { StorageSettingsPage } from './StoragePage';

const MB = 1024 * 1024;
const GB = 1024 * MB;

function usage(extra: Partial<StorageUsage> = {}): StorageUsage {
  return {
    totalBytes: Math.round(1.5 * GB),
    fileCount: 3120,
    quotaBytes: null,
    projects: [{ projectId: 'p1', title: 'Drive', bytes: GB, fileCount: 2000 }],
    tasks: [
      { taskId: 't1', title: 'Web evidence card', bytes: 300 * MB, fileCount: 40 },
      { taskId: 't2', title: 'Retention', bytes: 12 * MB, fileCount: 3 },
    ],
    weeks: [
      { weekStart: '2026-10-26', bytes: 5 * MB },
      { weekStart: '2026-11-02', bytes: 118 * MB },
    ],
    ...extra,
  };
}

/** The page with this answer in the cache, or none at all, as while it is being read. */
function render(answer?: StorageUsage, drive?: DriveUsage) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(meQuery().queryKey, { id: 'u1', email: 'a@b.c', name: 'A', preferences: {} });
  if (answer) qc.setQueryData(storageUsageQuery().queryKey, answer);
  if (drive) qc.setQueryData(driveUsageQuery().queryKey, drive);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <StorageSettingsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** The page's text from its first row on, tags stripped. */
const card = (html: string) => html.slice(html.indexOf('Stored files')).replace(/<[^>]+>/g, '|').replace(/\|+/g, '|');

describe('Files → Storage', () => {
  it('is a page of its own, headed Storage, with each ranking a section of rows', () => {
    const html = render(usage());
    expect(html).toMatch(/<h1[^>]*>Storage<\/h1>/);
    const sections = [...html.matchAll(/<h2[^>]*>([^<]+)<\/h2>/g)].map((m) => m[1]);
    expect(sections).toEqual(['Largest projects', 'Largest tasks', 'Added each week']);
  });

  it('says what the account keeps, where most of it is, and what each week added', () => {
    const text = card(render(usage()));
    expect(text).toContain('|1.5 GB · 3,120 files|');
    expect(text).toContain('Largest projects|Drive|1.0 GB|');
    expect(text).toContain('Largest tasks|Web evidence card|300.0 MB|Retention|12.0 MB|');
    expect(text).toContain('Added each week|Week of Nov 2|118.0 MB|Week of Oct 26|5.0 MB|');
    expect(text).not.toContain(' of 1');
    expect(text).not.toContain('Your storage is full');
  });

  it('says the quota beside the size on an instance that sets one, and when it has been reached', () => {
    const under = card(render(usage({ quotaBytes: 10 * GB })));
    expect(under).toContain('|1.5 GB of 10.0 GB · 3,120 files|');
    expect(under).not.toContain('Your storage is full');
    const full = card(render(usage({ quotaBytes: GB })));
    expect(full).toContain('|1.5 GB of 1.0 GB · 3,120 files|');
    expect(full).toContain('Your storage is full, so new uploads are refused.');
  });

  it('leaves out the rankings an account has nothing in, and counts one file as one', () => {
    const text = card(render(usage({ totalBytes: 10, fileCount: 1, projects: [], tasks: [], weeks: [{ weekStart: '2026-11-02', bytes: 10 }] })));
    expect(text).toContain('|10 B · 1 file|');
    expect(text).not.toContain('Largest projects');
    expect(text).not.toContain('Largest tasks');
    expect(text).toContain('Added each week|Week of Nov 2|10 B|');
  });

  it('holds its place while the answer is on its way', () => {
    const text = card(render());
    expect(text).toContain('|…|');
    expect(text).not.toContain('Added each week');
  });

  it('shows the total as the drive and everything else, with Trash inside the drive', () => {
    const text = render(usage(), { totalBytes: 300 * MB, driveBytes: 200 * MB, trashBytes: 20 * MB, otherBytes: 100 * MB })
      .replace(/<[^>]+>/g, '|').replace(/\|+/g, '|');
    expect(text).toContain('Total|300.0 MB|');
    expect(text).toContain('Drive|Including 20.0 MB in Trash|200.0 MB|');
    expect(text).toContain('Everything else|');
    expect(text).toContain('|100.0 MB|');
  });

  it('shows the S3 quota warning from 80% and the drive storage full message from 100%', () => {
    const drive = { totalBytes: 300, driveBytes: 200, trashBytes: 20, otherBytes: 100 };
    const quota = { ...drive, storeQuotaBytes: 1000 };
    expect(render(usage(), drive)).not.toContain('Drive storage');
    expect(render(usage(), { ...quota, storeUsedBytes: 799, nearQuota: false })).not.toContain('Drive storage');
    for (const percent of [80, 83]) {
      const html = render(usage(), { ...quota, storeUsedBytes: percent * 10, nearQuota: true });
      expect(html).toContain(`Drive storage is ${percent}% full. Uploads stop at 100%. Ask the operator to raise the limit.`);
    }
    const full = render(usage(), { ...quota, storeUsedBytes: 1000, nearQuota: true });
    expect(full).toContain('The drive&#x27;s storage is full. Ask the operator to raise the limit.');
    expect(full).not.toContain('Drive storage is 100% full');
  });
});
