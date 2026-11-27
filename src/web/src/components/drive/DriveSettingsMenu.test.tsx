// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { driveUsageQuery, storageUsageQuery, type DriveUsage, type StorageUsage } from '../../lib/queries';
import { DriveSettingsMenu } from './DriveSettingsMenu';

const GB = 1000 * 1000 * 1000;

/** Shaped as GET /attachments/usage answers. */
const stored = (quotaBytes: number | null): StorageUsage => ({ totalBytes: 0, fileCount: 0, quotaBytes, projects: [], tasks: [], weeks: [] });
/** Shaped as GET /drive/usage answers. */
const drive = (extra: Partial<DriveUsage> = {}): DriveUsage => ({
  totalBytes: 47.1 * GB, driveBytes: 44.7 * GB, trashBytes: 3.1 * GB, otherBytes: 2.4 * GB, ...extra,
});

let root: Root;
let host: HTMLElement;
const where = { path: '' };
function Where() {
  where.path = useLocation().pathname;
  return null;
}

async function render(usage: DriveUsage, quotaBytes: number | null) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(driveUsageQuery().queryKey, usage);
  qc.setQueryData(storageUsageQuery().queryKey, stored(quotaBytes));
  await act(async () => {
    root.render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/drive']}>
          <DriveSettingsMenu />
          <Where />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
}
const gear = () => document.querySelector<HTMLButtonElement>('button[aria-label="Settings"]')!;
const dot = () => gear().querySelector('.drive-gear-dot')?.getAttribute('data-level') ?? null;
async function openMenu() {
  await act(async () => gear().click());
  await vi.waitFor(() => expect(document.querySelector('.drive-meter')).toBeTruthy());
}
const meter = () => document.querySelector('.drive-meter')!.textContent!.replace(/\s+/g, ' ').trim();

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('Drive Settings gear menu', () => {
  it('no limit: the total, a split bar with no track, the legend, and no dot', async () => {
    await render(drive(), null);
    expect(dot()).toBeNull();
    await openMenu();
    expect(meter()).toBe('Storage 47 GB Drive 42 GB Trash 3.1 GB Other 2.4 GB No limit set · Open Storage');
    expect(document.querySelector('.drive-meter-bar')!.classList.contains('has-track')).toBe(false);
  });

  it('47% of a limit: used of limit with the percent on a grey track, no dot', async () => {
    await render(drive(), 100 * GB);
    expect(dot()).toBeNull();
    await openMenu();
    expect(meter()).toContain('47 GB of 100 GB 47%');
    expect(document.querySelector('.drive-meter-bar')!.classList.contains('has-track')).toBe(true);
    expect(meter()).not.toContain('Uploads');
  });

  it('92%: amber with where uploads stop and what Trash frees; an amber dot', async () => {
    await render(drive({ totalBytes: 92.4 * GB, driveBytes: 90 * GB, trashBytes: 9.6 * GB }), 100 * GB);
    expect(dot()).toBe('amber');
    await openMenu();
    expect(meter()).toContain('92 GB of 100 GB 92%');
    expect(meter()).toContain('Uploads stop at 100 GB. Empty Trash to free 9.6 GB.');
    expect(document.querySelector('.drive-meter')!.getAttribute('data-level')).toBe('amber');
  });

  it('full: red, uploads refused; a red dot', async () => {
    await render(drive({ totalBytes: 100 * GB }), 100 * GB);
    expect(dot()).toBe('red');
    await openMenu();
    expect(meter()).toContain('100 GB of 100 GB Full');
    expect(meter()).toContain('Uploads are refused.');
    expect(document.querySelector('.drive-meter')!.getAttribute('data-level')).toBe('red');
  });

  it("the server store's nearQuota: amber with the operator's remedy; an amber dot", async () => {
    await render(drive({ nearQuota: true, storeUsedBytes: 94 * GB, storeQuotaBytes: 100 * GB }), null);
    expect(dot()).toBe('amber');
    await openMenu();
    expect(meter()).toContain("Orbit's storage is 94% full. Ask the operator to raise the limit.");
  });

  it('has a Trash row with its size that opens /drive/trash, and the meter opens /drive/storage', async () => {
    await render(drive(), null);
    await openMenu();
    const trash = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) => el.textContent?.includes('Trash'))!;
    expect(trash.textContent).toContain('3.1 GB');
    await act(async () => document.querySelector<HTMLElement>('.drive-meter')!.click());
    expect(where.path).toBe('/drive/storage');
  });

  it('pressing Trash goes to /drive/trash', async () => {
    await render(drive(), null);
    await openMenu();
    const trash = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) => el.textContent?.includes('Trash'))!;
    await act(async () => trash.click());
    expect(where.path).toBe('/drive/trash');
  });
});
