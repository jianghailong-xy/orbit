// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { MergeRecovery } from '@orbit/shared';
import type { MergeRepairSession } from '../api';
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

async function mount(recovery = reviewed, busy = false, supported = true,
  repairSession?: MergeRepairSession, repairStarting = false, branch?: string) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div'); document.body.appendChild(container);
  root = createRoot(container);
  const action = vi.fn(); const repair = vi.fn(); const openRepair = vi.fn();
  await act(async () => root!.render(<MergeRecoveryPanel recovery={recovery} branch={branch} message="actual runner detail"
    busy={busy} supported={supported} onAction={action} onRepair={repair}
    repairSession={repairSession} repairStarting={repairStarting} onOpenRepair={openRepair} />));
  return { element: container, action, repair, openRepair };
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

it('lists exactly what the push adds, each commit labelled by where it comes from', async () => {
  const local = reviewed.localCommits![0];
  const h = await mount({ ...reviewed, remoteCommits: [{ sha: 'c'.repeat(40), subject: 'Remote work', author: 'Bob', date: '2026-09-30' }],
    pushCommits: [{ sha: 'd'.repeat(40), subject: 'Session work', author: 'Orbit', date: '2026-10-01' },
      { sha: 'f'.repeat(40), subject: 'Merge origin/develop into develop', author: 'Orbit', date: '2026-10-01', merge: true }, local] },
  false, true, undefined, false, 'orbit/feature-abc123');
  expect(h.element.querySelector('.wt-recovery-route')?.textContent)
    .toBe('orbit/feature-abc123 → develop · Local develop: 1 ahead, 1 behind origin/develop');
  expect(h.element.querySelector('.wt-recovery-push summary')?.textContent).toBe('Pushes to origin/develop (3 commits)');
  expect([...h.element.querySelectorAll('.wt-recovery-origin')].map((e) => e.textContent))
    .toEqual(['This session', 'Merge commit', 'Local-only']);
  expect(h.element.querySelector('.wt-recovery-origin.is-local')?.textContent).toBe('Local-only');
  expect(h.element.textContent).toContain('A merge commit joins both histories; nothing already on origin/develop is rewritten. Includes 1 local-only commit that was never pushed.');
  expect(h.element.textContent).not.toContain('— included in the push');
  expect(h.element.textContent).not.toContain('Preserves both target histories');
  expect(h.element.querySelector('.wt-recovery-diff pre')?.textContent).toBe(reviewed.patch);
  await act(async () => button(h.element, /^Sync develop and merge$/)!.click());
  expect(h.action).toHaveBeenCalledExactlyOnceWith('apply', 'exact-preview');
});

it('never points at local-only commits that are not there', async () => {
  // The owner's case, 2026-10-01: local develop matched origin/develop and only this session's
  // commits went out, yet the footer spoke of "the local-only commits above".
  const matching = { ...reviewed, remoteSha: reviewed.localSha, localCommits: undefined, remoteCommits: undefined, addsMergeCommit: false };
  const h = await mount({ ...matching, pushCommits: [{ sha: 'd'.repeat(40), subject: 'Session work', author: 'Orbit', date: '2026-10-01' }] });
  expect(h.element.querySelector('.wt-recovery-route')?.textContent).toBe('Local develop matches origin/develop');
  expect(h.element.textContent).toContain('Fast-forward push: nothing already on origin/develop is rewritten.');
  expect(h.element.textContent).not.toContain('Remote-only commits');
  expect(h.element.textContent).not.toMatch(/local-only commit/i);
  await act(async () => root!.unmount()); root = null; container?.remove();
  const legacy = await mount(matching);
  expect(legacy.element.textContent).toContain('Preserves both target histories. If the repository requires linear history or a PR');
  expect(legacy.element.textContent).not.toMatch(/local-only commit/i);
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

it('keeps a running repair session tappable and prevents a duplicate repair', async () => {
  const h = await mount({ ...reviewed, code: 'CONFLICT', phase: 'TARGET_SYNC' }, false, true, {
    id: 'repair-session', title: 'Resolve merge recovery', status: 'RUNNING', runState: 'RUNNING',
  });
  expect(h.element.textContent).toContain('Repair session running');
  expect(h.element.textContent).toContain('Tap to open the running session');
  await act(async () => button(h.element, /Repair session running/)!.click());
  expect(h.openRepair).toHaveBeenCalledOnce();
  expect(button(h.element, /^Resolve in repair session$/)?.disabled).toBe(true);
  expect(button(h.element, /^Prepare PR candidate$/)?.disabled).toBe(true);
});

it('renders the latest repair result after the child session settles', async () => {
  const h = await mount({ ...reviewed, code: 'CONFLICT', phase: 'TARGET_SYNC' }, false, true, {
    id: 'repair-session', title: 'Resolve merge recovery', status: 'AWAITING_INPUT', runState: 'AWAITING_INPUT',
  });
  expect(h.element.textContent).toContain('Repair session completed');
  expect(h.element.textContent).toContain('Ready to check again');
  expect(button(h.element, /^Resolve in repair session$/)?.disabled).toBe(false);
});
