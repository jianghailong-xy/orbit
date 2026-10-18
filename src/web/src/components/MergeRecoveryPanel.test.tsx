// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { MergeRecovery } from '@orbit/shared';
import type { MergeRepairSession } from '../api';
import { MergeRecoveryPanel, mergeRecoveryChecking, mergeRecoveryTargetMovedAfterRepair, mergeRepairLoopLive } from './MergeRecoveryPanel';

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
  repairSession?: MergeRepairSession, repairStarting = false, branch?: string, checking = false) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div'); document.body.appendChild(container);
  root = createRoot(container);
  const action = vi.fn(); const repair = vi.fn(); const openRepair = vi.fn();
  await act(async () => root!.render(<MergeRecoveryPanel recovery={recovery} branch={branch} message="actual runner detail"
    busy={busy} supported={supported} checking={checking} onAction={action} onRepair={repair}
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


// The repair loop (docs/mocks/merge-recovery-repair-loop-ios.html): with a repair session attached, its row says where
// the repair stands and the one emphasized button is the next step.
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const AGENTS = 'src/macos/OrbitApp/Sources/OrbitApp/AgentsModel.swift';
const WIRING = 'src/macos/OrbitKit/Tests/OrbitKitTests/SessionListSwitchWiringTests.swift';
const repairOf = (over: Partial<MergeRepairSession> = {}): MergeRepairSession => ({
  id: 'repair-session', title: 'Resolve merge recovery for develop', status: 'AWAITING_INPUT', runState: 'AWAITING_INPUT',
  lastTurnAt: ago(2 * 60_000), ...over,
});
/** The board's conflict, checked five seconds ago — after the repair's turn ended two minutes ago. */
const conflicted: MergeRecovery = {
  ...reviewed, code: 'CONFLICT', phase: 'SOURCE_REPLAY', checkedAt: ago(5_000), conflicts: [AGENTS, WIRING],
  candidateSha: undefined, candidateTreeSha: undefined, patch: undefined, check: undefined, repairBranch: 'orbit/recovery/exact-preview',
};
const mountRepair = (recovery: MergeRecovery, repairSession: MergeRepairSession, checking = false, busy = false) =>
  mount(recovery, busy, true, repairSession, false, 'orbit/feature-abc123', checking);
const rowOf = (el: Element) => el.querySelector('.wt-recovery-repair-status');
/** The emphasized next step: exactly one per state. */
const primaryOf = (el: Element) => {
  const primary = el.querySelectorAll('.wt-recovery-actions .wt-merge-btn');
  expect(primary).toHaveLength(1);
  return primary[0] as HTMLButtonElement;
};
const actionLabels = (el: Element) => [...el.querySelectorAll('.wt-recovery-actions button')].map((b) => b.textContent);

it('repair running: the row opens the session and the one button is Open repair session', async () => {
  const h = await mountRepair({ ...conflicted, checkedAt: ago(14 * 60_000) }, repairOf({ status: 'RUNNING', runState: 'RUNNING' }));
  expect(rowOf(h.element)?.className).toContain('is-running');
  expect(rowOf(h.element)?.textContent).toBe('Repair session runningResolve merge recovery for developTap to open the running session›');
  expect(h.element.querySelector('.wt-recovery-checked')?.textContent).toBe('Checked 14m ago');
  expect(button(h.element, /Check again/)).toBeUndefined();
  expect(actionLabels(h.element)).toEqual(['Open repair session']);
  expect(primaryOf(h.element).disabled).toBe(false);
  expect(h.element.querySelector('.wt-recovery-actions-note')?.textContent).toBe('Orbit checks again when the repair stops.');
  await act(async () => primaryOf(h.element).click());
  await act(async () => (rowOf(h.element) as HTMLButtonElement).click());
  expect(h.openRepair).toHaveBeenCalledTimes(2);
  expect(h.repair).not.toHaveBeenCalled();
});

it('repair finished, checking: the old snapshot fades and the one button is a disabled Checking…', async () => {
  const h = await mountRepair({ ...conflicted, checkedAt: ago(14 * 60_000) }, repairOf(), true);
  expect(h.element.querySelector('.wt-recovery-checked')?.textContent).toBe(' Checking the repair…');
  expect(rowOf(h.element)?.className).toContain('is-checking');
  expect(rowOf(h.element)?.textContent).toContain('Repair session finished');
  expect(rowOf(h.element)?.textContent).toContain('Checking its result…');
  expect(h.element.querySelector('.wt-recovery-snapshot')?.classList.contains('is-stale')).toBe(true);
  expect(h.element.querySelector('.wt-recovery-snapshot')?.textContent).toContain(AGENTS);
  expect(actionLabels(h.element)).toEqual([' Checking…']);
  expect(primaryOf(h.element).disabled).toBe(true);
  expect(button(h.element, /Check again|Continue repair|PR candidate/)).toBeUndefined();
  expect(h.element.querySelector('.wt-recovery-actions-note')).toBeNull();
});

it('repair finished, ready: the row states the check and the next step is Sync and merge', async () => {
  const h = await mountRepair({ ...reviewed, checkedAt: ago(5_000), repairBranch: 'orbit/recovery/exact-preview',
    pushCommits: [{ sha: 'd'.repeat(40), subject: 'Session work', author: 'coordinator', date: ago(3 * 3_600_000) }] }, repairOf());
  expect(h.element.querySelector('strong')?.textContent).toBe('Review synchronization into develop');
  expect(rowOf(h.element)?.className).toContain('is-ready');
  expect(rowOf(h.element)?.querySelector('.wt-recovery-repair-note')?.textContent).toBe('Checked just now — ready to merge');
  expect(h.element.querySelector('.wt-recovery-push small')?.textContent).toBe('This session · coordinator · 3h ago · dddddddd');
  expect(h.element.querySelector('.wt-recovery-snapshot')?.classList.contains('is-stale')).toBe(false);
  expect(primaryOf(h.element).textContent).toBe('Sync develop and merge');
  expect(actionLabels(h.element)).toEqual(['Sync develop and merge', 'Prepare PR candidate']);
  await act(async () => primaryOf(h.element).click());
  expect(h.action).toHaveBeenCalledExactlyOnceWith('apply', 'exact-preview');
  await act(async () => button(h.element, /^Prepare PR candidate$/)!.click());
  expect(h.repair).toHaveBeenCalledExactlyOnceWith(true);
  // Check again moved beside the time.
  expect(h.element.querySelector('.wt-recovery-checked')?.textContent).toBe('Checked just now · Check again');
  await act(async () => button(h.element, /^Check again$/)!.click());
  expect(h.action).toHaveBeenLastCalledWith('preview');
});

it('repair finished, conflicts left: the row counts them and the next step is Continue repair', async () => {
  const h = await mountRepair(conflicted, repairOf());
  expect(rowOf(h.element)?.className).toContain('is-conflict');
  expect(rowOf(h.element)?.querySelector('.wt-recovery-repair-note')?.textContent).toBe('Checked just now — 2 conflicts left');
  expect(h.element.querySelector('.wt-recovery-files strong')?.textContent).toBe('Conflicts');
  expect([...h.element.querySelectorAll('.wt-recovery-files li')].map((li) => li.textContent)).toEqual([AGENTS, WIRING]);
  expect(primaryOf(h.element).textContent).toBe('Continue repair');
  expect(actionLabels(h.element)).toEqual(['Continue repair', 'Prepare PR candidate']);
  expect(button(h.element, /Resolve in repair session/)).toBeUndefined();
  await act(async () => primaryOf(h.element).click());
  expect(h.repair).toHaveBeenCalledExactlyOnceWith(false);
  await act(async () => root!.unmount()); root = null; container?.remove();
  const one = await mountRepair({ ...conflicted, conflicts: [AGENTS] }, repairOf());
  expect(rowOf(one.element)?.querySelector('.wt-recovery-repair-note')?.textContent).toBe('Checked just now — 1 conflict left');
});

it('repair waiting for the owner: its question is quoted and the next step is Reply in repair session', async () => {
  const h = await mountRepair({ ...conflicted, code: 'REPAIR_IN_PROGRESS', conflicts: [WIRING] },
    repairOf({ lastAssistantText: 'Keep the target’s\nversion?' }));
  expect(h.element.querySelector('strong')?.textContent).toBe('The repair isn’t finished');
  expect(h.element.textContent).toContain('Some files in the repair worktree are still unresolved.');
  expect(h.element.textContent).not.toContain('needs synchronization');
  expect(rowOf(h.element)?.className).toContain('is-reply');
  expect(rowOf(h.element)?.querySelector('strong')?.textContent).toBe('Repair session needs your reply');
  expect(rowOf(h.element)?.querySelector('.wt-recovery-repair-note')?.textContent).toBe('“Keep the target’s version?” · 2m ago');
  expect(rowOf(h.element)?.textContent).not.toContain('completed');
  expect(h.element.querySelector('.wt-recovery-files strong')?.textContent).toBe('Still unresolved');
  expect([...h.element.querySelectorAll('.wt-recovery-files li')].map((li) => li.textContent)).toEqual([WIRING]);
  expect(actionLabels(h.element)).toEqual(['Reply in repair session']);
  await act(async () => primaryOf(h.element).click());
  expect(h.repair).toHaveBeenCalledExactlyOnceWith(false);
});

it('repair failed: the row shows why, and the next step resolves it in a new repair session', async () => {
  const failed = repairOf({ status: 'FAILED', runState: 'FAILED', error: 'The model provider rejected the request' });
  const h = await mountRepair(conflicted, failed);
  expect(rowOf(h.element)?.className).toContain('is-failed');
  expect(rowOf(h.element)?.querySelector('strong')?.textContent).toBe('Repair session failed');
  expect(rowOf(h.element)?.querySelector('.wt-recovery-repair-note')?.textContent).toBe('The model provider rejected the request');
  expect(primaryOf(h.element).textContent).toBe('Resolve in repair session');
  expect(actionLabels(h.element)).toEqual(['Resolve in repair session', 'Prepare PR candidate']);
  await act(async () => primaryOf(h.element).click());
  expect(h.repair).toHaveBeenCalledExactlyOnceWith(false);
  // While Orbit checks what it left, the row keeps saying it failed.
  await act(async () => root!.unmount()); root = null; container?.remove();
  const checking = await mountRepair(conflicted, failed, true);
  expect(rowOf(checking.element)?.querySelector('strong')?.textContent).toBe('Repair session failed');
  expect(checking.element.querySelector('.wt-recovery-checked')?.textContent).toBe(' Checking the repair…');
  expect(primaryOf(checking.element).textContent).toBe(' Checking…');
});

it('names the repair step by what the server does with the attached session: a failed one is replaced, the rest go on', async () => {
  // S2: POST /merge-repair continues the repair session it finds, unless that session failed; then it opens a new one.
  const unmount = async () => { await act(async () => root!.unmount()); root = null; container?.remove(); };
  const failed = { status: 'FAILED', runStatus: 'FAILED', runState: 'FAILED' };
  const resumable = [
    { status: 'AWAITING_INPUT', runStatus: 'AWAITING_INPUT', runState: 'AWAITING_INPUT' },
    { status: 'SUCCEEDED', runStatus: 'SUCCEEDED', runState: 'SUCCEEDED' },
    { status: 'CANCELLED', runStatus: 'CANCELLED', runState: 'ENDED' },
    { status: 'INTERRUPTED', runStatus: 'INTERRUPTED', runState: 'INTERRUPTED' },
  ];
  const h = await mountRepair(conflicted, repairOf(failed));
  expect(primaryOf(h.element).textContent).toBe('Resolve in repair session');
  expect(actionLabels(h.element)).toEqual(['Resolve in repair session', 'Prepare PR candidate']);
  await unmount();
  for (const state of resumable) {
    const going = await mountRepair(conflicted, repairOf(state));
    expect(primaryOf(going.element).textContent, state.status).toBe('Continue repair');
    expect(actionLabels(going.element), state.status).toEqual(['Continue repair', 'Prepare PR candidate']);
    await unmount();
  }
  // Nor is a failed session replied to when its repair is unfinished.
  const unfinished = { ...conflicted, code: 'REPAIR_IN_PROGRESS', conflicts: [WIRING] };
  const replaced = await mountRepair(unfinished, repairOf(failed));
  expect(actionLabels(replaced.element)).toEqual(['Resolve in repair session']);
  await unmount();
  const asked = await mountRepair(unfinished, repairOf());
  expect(actionLabels(asked.element)).toEqual(['Reply in repair session']);
});

it('a result from before the repair stopped is not that repair’s result', async () => {
  // Checked 14 minutes ago, the repair stopped 2 minutes ago, and no check is running: nothing is concluded for it.
  const h = await mountRepair({ ...conflicted, checkedAt: ago(14 * 60_000) }, repairOf());
  expect(rowOf(h.element)?.className).toContain('is-finished');
  expect(rowOf(h.element)?.querySelector('.wt-recovery-repair-note')).toBeNull();
  expect(h.element.querySelector('.wt-recovery-checked')?.textContent).toBe('Checked 14m ago · Check again');
  expect(primaryOf(h.element).textContent).toBe('Continue repair');
});

it('busy while the session runs a turn: every write waits, opening the repair does not', async () => {
  const h = await mountRepair(conflicted, repairOf(), false, true);
  for (const b of h.element.querySelectorAll('.wt-recovery-actions button, .wt-recovery-link')) expect((b as HTMLButtonElement).disabled).toBe(true);
  expect((rowOf(h.element) as HTMLButtonElement).disabled).toBe(false);
});

const landedRecovery: MergeRecovery = {
  code: 'ALREADY_LANDED', targetBranch: 'main', previewId: 'server-minted', sourceSha: '0032a5e'.padEnd(40, '0'),
  localSha: 'b'.repeat(40), remoteSha: 'c'.repeat(40), checkedAt: ago(5_000),
  localCommits: [
    { sha: '749188d8'.padEnd(40, '1'), subject: 'feat(suggestions): server-written next-message guess', author: 'coordinator', date: ago(3 * 3_600_000) },
    { sha: '8a954110'.padEnd(40, '2'), subject: 'feat(composer): "Double-tap to use" stays', author: 'coordinator', date: ago(4 * 3_600_000) },
  ],
  remoteCommits: [{ sha: 'c'.repeat(40), subject: 'Remote work', author: 'Bob', date: ago(3_600_000) }],
  landedCommits: [
    { sha: 'bba5d7b3'.padEnd(40, '3'), subject: 'Explicit self in the session-list currency closure', author: 'coordinator',
      date: `${new Date().getFullYear()}-10-11T12:30:00Z`, sourceSha: 'e'.repeat(40) },
    { sha: '99cd5459'.padEnd(40, '4'), subject: 'Update AgentsModel.swift, SessionListSwitchWiringTests.swift', author: 'coordinator',
      date: `${new Date().getFullYear()}-10-11T11:30:00Z`, sourceSha: 'f'.repeat(40) },
  ],
};

it('already on origin: board ⑥ — what landed where, and Done records it', async () => {
  // The owner's case: a repair session is still attached, and the panel draws no repair row for it.
  const h = await mountRepair(landedRecovery, repairOf());
  const text = h.element.textContent ?? '';
  expect(h.element.querySelector('strong')?.textContent).toBe('Already on origin/main');
  expect(h.element.querySelector('.wt-recovery-checked')?.textContent).toBe('Checked just now');
  expect(text).toContain('This session’s changes reached origin/main on Oct 11. Nothing is left to merge.');
  expect(h.element.querySelector('.wt-recovery-landed summary')?.textContent).toBe('On origin/main (2 commits)');
  expect([...h.element.querySelectorAll('.wt-recovery-landed small')].map((s) => s.textContent))
    .toEqual(['Merged Oct 11 · coordinator · bba5d7b3', 'Merged Oct 11 · coordinator · 99cd5459']);
  expect(text).toContain('Matched by content — this branch was rewritten after these merged.');
  expect(text).toContain('Local main’s own 2 commits aren’t part of this session.');
  expect(rowOf(h.element)).toBeNull();
  expect(text).not.toMatch(/included in the push|Remote-only commits|Details|Check the local and remote/);
  expect(actionLabels(h.element)).toEqual(['Done']);
  await act(async () => primaryOf(h.element).click());
  expect(h.action).toHaveBeenCalledExactlyOnceWith('confirm-landed', 'server-minted');
});

it('already on origin without a repair session draws the same, and one origin never minted an id for cannot be Done', async () => {
  const one = { ...landedRecovery, localCommits: [landedRecovery.localCommits![0]], landedCommits: [{ ...landedRecovery.landedCommits![0], sha: 'e'.repeat(40) }] };
  const h = await mount(one, false, true, undefined, false, 'orbit/ios-works-workspace-d0afa0');
  expect(h.element.textContent).toContain('Local main’s own 1 commit isn’t part of this session.');
  expect(h.element.textContent).not.toContain('Matched by content');
  expect(h.element.querySelector('.wt-recovery-landed summary')?.textContent).toBe('On origin/main (1 commit)');
  expect(actionLabels(h.element)).toEqual(['Done']);
  await act(async () => root!.unmount()); root = null; container?.remove();
  const unminted = await mount({ ...landedRecovery, previewId: undefined });
  expect(button(unminted.element, /^Done$/)).toBeUndefined();
  expect(button(unminted.element, /^Check and repair$/)).toBeTruthy();
});

it('without a repair session an unfinished repair keeps the current buttons but says what is left', async () => {
  const h = await mount({ ...conflicted, code: 'REPAIR_IN_PROGRESS', conflicts: [WIRING] });
  expect(h.element.querySelector('strong')?.textContent).toBe('The repair isn’t finished');
  expect(h.element.querySelector('.wt-recovery-files strong')?.textContent).toBe('Still unresolved');
  expect(actionLabels(h.element)).toEqual(['Check again', 'Resolve in repair session', 'Prepare PR candidate']);
  expect(h.element.querySelectorAll('.wt-recovery-actions .wt-merge-btn')).toHaveLength(0);
});

it('says the target moved after the repair only for a kept repair whose new tips conflict', async () => {
  const kept: MergeRecovery = { ...conflicted, phase: 'TARGET_SYNC', previewId: 'second-check', repairBranch: 'orbit/recovery/first-check' };
  // Carried, conflicting on the new target tips.
  expect(mergeRecoveryTargetMovedAfterRepair(kept)).toBe(true);
  // Carried, but the conflict is in replaying the source: nothing moved.
  expect(mergeRecoveryTargetMovedAfterRepair({ ...kept, phase: 'SOURCE_REPLAY' })).toBe(false);
  // A fresh repair branch, named after this check.
  expect(mergeRecoveryTargetMovedAfterRepair({ ...kept, repairBranch: 'orbit/recovery/second-check' })).toBe(false);
  expect(mergeRecoveryTargetMovedAfterRepair({ ...kept, repairBranch: undefined })).toBe(false);
  expect(mergeRecoveryTargetMovedAfterRepair({ ...kept, code: 'REPAIR_IN_PROGRESS' })).toBe(false);
  const h = await mountRepair({ ...kept, conflicts: [AGENTS] }, repairOf());
  expect(h.element.querySelector('.wt-recovery-files p')?.textContent)
    .toBe('origin/develop moved after the repair. The repair was kept; only this file conflicts with the new commits.');
  await act(async () => root!.unmount()); root = null; container?.remove();
  const replay = await mountRepair({ ...kept, phase: 'SOURCE_REPLAY' }, repairOf());
  expect(replay.element.querySelector('.wt-recovery-files p')).toBeNull();
  expect(replay.element.textContent).not.toContain('moved after the repair');
});

it('polls the repair loop from running, through the stop, until the check after it has answered', () => {
  const now = Date.now();
  const detail = (over: Record<string, unknown> = {}) => ({
    mergeRecovery: { ...conflicted, checkedAt: ago(14 * 60_000) }, mergeRepairSession: repairOf({ status: 'RUNNING', runState: 'RUNNING' }),
    mergeStatus: 'conflict' as const, mergeRecoveryAction: 'preview' as const, mergeRepairTurnEndedAt: null, ...over,
  });
  // Running.
  expect(mergeRepairLoopLive(detail(), now)).toBe(true);
  // Stopped a moment ago: the check the server queues as the turn settles has not shown up yet.
  expect(mergeRepairLoopLive(detail({ mergeRepairSession: repairOf({ lastTurnAt: ago(2_000) }) }), now)).toBe(true);
  // Checking.
  expect(mergeRepairLoopLive(detail({ mergeRepairSession: repairOf(), mergeStatus: 'pending' }), now)).toBe(true);
  // Owed, waiting for this session's own turn to end.
  expect(mergeRepairLoopLive(detail({ mergeRepairSession: repairOf(), mergeRepairTurnEndedAt: ago(1_000) }), now)).toBe(true);
  // The check answered: quiet.
  expect(mergeRepairLoopLive(detail({ mergeRepairSession: repairOf(), mergeRecovery: conflicted }), now)).toBe(false);
  // No check came for a turn that ended long ago (an older runner, say): quiet too, until Check again.
  expect(mergeRepairLoopLive(detail({ mergeRepairSession: repairOf() }), now)).toBe(false);
  // Nothing to follow.
  expect(mergeRepairLoopLive(detail({ mergeRepairSession: null }), now)).toBe(false);
  expect(mergeRepairLoopLive(detail({ mergeRecovery: null }), now)).toBe(false);
});

it('a check counts as running only for a preview in flight or one owed to a turn', () => {
  expect(mergeRecoveryChecking({ mergeStatus: 'pending', mergeRecoveryAction: 'preview' })).toBe(true);
  expect(mergeRecoveryChecking({ mergeStatus: 'pending', mergeRecoveryAction: 'apply' })).toBe(false);
  expect(mergeRecoveryChecking({ mergeStatus: 'conflict', mergeRecoveryAction: 'preview' })).toBe(false);
  expect(mergeRecoveryChecking({ mergeStatus: 'conflict', mergeRecoveryAction: 'preview', mergeRepairTurnEndedAt: ago(1_000) })).toBe(true);
});
