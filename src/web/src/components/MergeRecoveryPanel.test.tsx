// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { MergeRecovery } from '@orbit/shared';
import { MergeRecoveryPanel } from './MergeRecoveryPanel';

const reviewed: MergeRecovery = {
  code: 'READY', targetBranch: 'develop', previewId: 'exact-preview',
  sourceSha: 'a'.repeat(40), localSha: 'b'.repeat(40), remoteSha: 'c'.repeat(40),
  candidateSha: 'd'.repeat(40), candidateTreeSha: 'e'.repeat(40),
  patch: 'diff --git a/extra.txt b/extra.txt\n+local extra content', addsMergeCommit: true,
  localCommits: [{ sha: 'b'.repeat(40), subject: 'Local unpublished work', author: 'Alice', date: '2026-09-30' }],
  remoteCommits: [], check: { status: 'unconfigured' }, repairWorktree: '/private/repair', repairBranch: 'orbit/recovery/abc',
};
let root: Root | null = null;
let container: HTMLDivElement | null = null;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove(); root = null; container = null;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

async function mount(recovery = reviewed, busy = false, supported = true) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div'); document.body.appendChild(container);
  root = createRoot(container);
  const action = vi.fn(); const repair = vi.fn();
  await act(async () => root!.render(<MergeRecoveryPanel recovery={recovery} message="actual runner detail"
    busy={busy} supported={supported} onAction={action} onRepair={repair} />));
  return { element: container, action, repair };
}
const button = (el: Element, label: RegExp) => [...el.querySelectorAll('button')].find((b) => label.test(b.textContent ?? ''));

it('shows every extra commit and the full diff, then approves exactly the displayed preview', async () => {
  const h = await mount();
  expect(h.element.textContent).toContain('Local unpublished work');
  expect(h.element.textContent).toContain('Alice');
  expect(h.element.querySelector('.wt-recovery-diff pre')?.textContent).toBe(reviewed.patch);
  expect(h.element.textContent).toContain('Adds one merge commit');
  expect(h.element.textContent).toContain('no merge check is configured');
  expect(h.element.textContent).not.toContain('check passed');
  await act(async () => button(h.element, /^Sync develop and merge$/)!.click());
  expect(h.action).toHaveBeenCalledExactlyOnceWith('apply', 'exact-preview');
});

it.each(['CONFLICT', 'PREVIEW_CHANGED', 'CHECK_FAILED', 'LINEAR_HISTORY_REQUIRED'])('%s cannot approve a candidate', async (code) => {
  const h = await mount({ ...reviewed, code, phase: 'TARGET_SYNC' });
  expect(button(h.element, /^Sync develop and merge$/)).toBeUndefined();
  expect(h.element.textContent).toContain('actual runner detail');
  await act(async () => button(h.element, /^Check again$/)!.click());
  expect(h.action).toHaveBeenCalledExactlyOnceWith('preview');
  await act(async () => button(h.element, /^Resolve in repair session$/)!.click());
  expect(h.repair).toHaveBeenCalledExactlyOnceWith(false);
});

it('partial landing offers only local sync and does not reapply or create another repair', async () => {
  const h = await mount({ ...reviewed, code: 'LOCAL_SYNC_PENDING' });
  expect(button(h.element, /Check again|and merge|repair session|PR candidate/)).toBeUndefined();
  await act(async () => button(h.element, /^Sync local checkout$/)!.click());
  expect(h.action).toHaveBeenCalledExactlyOnceWith('sync-local', 'exact-preview');
});

it('lost push responses retry the reviewed candidate, while busy state disables every write', async () => {
  const h = await mount({ ...reviewed, code: 'REMOTE_NOT_VERIFIED' }, true);
  for (const b of h.element.querySelectorAll('button')) expect(b.disabled).toBe(true);
  expect(button(h.element, /retry reviewed candidate/)).toBeTruthy();
  expect(h.action).not.toHaveBeenCalled();
});

it('an older runner retains the diagnostic and cannot receive new recovery actions', async () => {
  const h = await mount({ code: 'TARGET_DIVERGED', targetBranch: 'develop' }, false, false);
  expect(h.element.textContent).toContain('Update the runner');
  expect(h.element.querySelector('button')).toBeNull();
});
