// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { driveUsageQuery, storageUsageQuery, type DriveUsage, type StorageUsage } from '../../lib/queries';
import { DriveSettingsMenu } from './DriveSettingsMenu';

const GB = 1000 * 1000 * 1000;

/** Shaped as GET /attachments/usage answers: what the per-account limit counts, attachments only. */
const stored = (totalBytes: number, quotaBytes: number | null): StorageUsage => ({ totalBytes, fileCount: 0, quotaBytes, projects: [], tasks: [], weeks: [] });
/** Shaped as GET /drive/usage answers; driveBytes includes Trash. */
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

/** The attachments total is the drive payload's otherBytes, as the server counts them. */
async function render(usage: DriveUsage, quotaBytes: number | null) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(driveUsageQuery().queryKey, usage);
  qc.setQueryData(storageUsageQuery().queryKey, stored(usage.otherBytes, quotaBytes));
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

const bar = () => document.querySelector('.drive-meter-bar')!;

describe('Drive Settings gear menu', () => {
  it('no quota: the total over a split bar with no track, the legend, No limit set, and no dot', async () => {
    await render(drive(), null);
    expect(dot()).toBeNull();
    await openMenu();
    expect(meter()).toBe('Storage 47 GB Drive 42 GB Trash 3.1 GB Other 2.4 GB No limit set Open Storage');
    expect(bar().classList.contains('has-track')).toBe(false);
  });

  it('attachments at 47% of the quota: a second line, the bar still a plain split, no dot', async () => {
    await render(drive({ otherBytes: 2.36 * GB }), 5 * GB);
    expect(dot()).toBeNull();
    await openMenu();
    expect(meter()).toContain('Storage 47 GB');
    expect(meter()).toContain('Other files 2.4 GB of 5 GB Open Storage');
    expect(meter()).not.toContain('%');
    expect(meter()).not.toContain('stop');
    expect(bar().classList.contains('has-track')).toBe(false);
  });

  it('attachments at 92%: amber, new attachments stop at the quota; an amber dot', async () => {
    await render(drive({ otherBytes: 4.6 * GB }), 5 * GB);
    expect(dot()).toBe('amber');
    await openMenu();
    expect(meter()).toContain('Other files 4.6 GB of 5 GB. New attachments stop at 5 GB.');
    expect(meter()).not.toContain('Empty Trash');
    expect(document.querySelector('.drive-meter-note[data-level="amber"]')).toBeTruthy();
  });

  it('attachments full: red, new attachments refused; a red dot', async () => {
    await render(drive({ otherBytes: 5 * GB }), 5 * GB);
    expect(dot()).toBe('red');
    await openMenu();
    expect(meter()).toContain('Other files 5 GB of 5 GB. New attachments are refused.');
    expect(document.querySelector('.drive-meter-note[data-level="red"]')).toBeTruthy();
  });

  it("the server store near full: amber with the operator's remedy; an amber dot", async () => {
    await render(drive({ nearQuota: true, storeUsedBytes: 94 * GB, storeQuotaBytes: 100 * GB }), null);
    expect(dot()).toBe('amber');
    await openMenu();
    expect(meter()).toContain('Drive storage is 94% full. Uploads stop at 100%. Ask the operator to raise the limit.');
  });

  it('the server store full: red; a red dot even with attachments well under their quota', async () => {
    await render(drive({ nearQuota: true, storeUsedBytes: 100 * GB, storeQuotaBytes: 100 * GB, otherBytes: 1 * GB }), 5 * GB);
    expect(dot()).toBe('red');
    await openMenu();
    expect(meter()).toContain("The drive's storage is full. Ask the operator to raise the limit.");
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
