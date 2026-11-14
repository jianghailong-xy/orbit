// @vitest-environment jsdom
// The repair loop folded into one row of the parking strip (docs/mocks/merge-repair-strip-row, decided 2026-11-14):
// D1 the row carries the next step, D2 it stays folded while the repair runs or Orbit checks and opens itself once
// when a result needs the owner.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { MergeRecovery } from '@orbit/shared';
import type { MergeRepairSession } from '../api';
import { MergeRepairStrip } from './MergeRecoveryPanel';

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const repairOf = (over: Partial<MergeRepairSession> = {}): MergeRepairSession => ({
  id: 'repair-session', title: 'Resolve merge recovery for develop', status: 'AWAITING_INPUT', runState: 'AWAITING_INPUT',
  lastTurnAt: ago(2 * 60_000), ...over,
});
const base: MergeRecovery = {
  code: 'CONFLICT', phase: 'SOURCE_REPLAY', targetBranch: 'develop', previewId: 'exact-preview', checkedAt: ago(5_000),
  sourceSha: 'a'.repeat(40), localSha: 'b'.repeat(40), remoteSha: 'c'.repeat(40), conflicts: ['a.ts', 'b.ts'],
  localCommits: [], remoteCommits: [], repairWorktree: '/private/repair', repairBranch: 'orbit/recovery/exact-preview',
};
const ready: MergeRecovery = { ...base, code: 'READY', conflicts: [], candidateSha: 'd'.repeat(40), candidateTreeSha: 'e'.repeat(40), patch: 'diff', check: { status: 'unconfigured' },
  addsMergeCommit: false, pushCommits: [{ sha: 'd'.repeat(40), subject: 'Session work', author: 'coordinator', date: ago(60_000) }] };

let root: Root | null = null;
let container: HTMLDivElement | null = null;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove(); root = null; container = null;
});
async function mount(recovery: MergeRecovery, repairSession?: MergeRepairSession, checking = false) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div'); document.body.appendChild(container);
  root = createRoot(container);
  const h = { action: vi.fn(), repair: vi.fn(), openRepair: vi.fn(), element: container,
    render: (r: MergeRecovery, s?: MergeRepairSession, c = checking) => act(async () => root!.render(
      <MergeRepairStrip recovery={r} busy={false} supported checking={c} onAction={h.action} onRepair={h.repair}
        repairSession={s} onOpenRepair={h.openRepair} />)) };
  await h.render(recovery, repairSession);
  return h;
}
const row = (el: Element) => el.querySelector('.wt-repair-row');
const step = (el: Element) => el.querySelector<HTMLButtonElement>('.wt-repair-row-step');
const arrow = (el: Element) => el.querySelector<HTMLButtonElement>('.wt-repair-row .wt-expand')!;
const panel = (el: Element) => el.querySelector('.wt-recovery');
const panelButtons = (el: Element) => [...el.querySelectorAll('.wt-recovery-actions button')].map((b) => b.textContent);

it('without a repair session the panel is drawn as before, with no row', async () => {
  const h = await mount(base);
  expect(row(h.element)).toBeNull();
  expect(panel(h.element)).not.toBeNull();
});

it('repair running: folded to one row whose step opens the session; the arrow opens the panel without a second Open', async () => {
  const h = await mount(base, repairOf({ status: 'RUNNING', runState: 'RUNNING' }));
  expect(row(h.element)?.className).toContain('is-running');
  expect(row(h.element)?.querySelector('.wt-repair-row-head')?.textContent).toBe('Repair session running');
  expect(row(h.element)?.querySelector('.wt-repair-row-note')?.textContent)
    .toBe('· Resolve merge recovery for develop · Orbit checks again when it stops');
  expect(panel(h.element)).toBeNull();
  await act(async () => step(h.element)!.click());
  expect(h.openRepair).toHaveBeenCalledOnce();
  expect(panel(h.element)).toBeNull();
  await act(async () => arrow(h.element).click());
  expect(arrow(h.element).getAttribute('aria-expanded')).toBe('true');
  expect(panel(h.element)).not.toBeNull();
  expect(h.element.querySelector('.wt-recovery-repair-status')).toBeNull();
  expect(panelButtons(h.element)).toEqual([]);
  expect(h.element.querySelector('.wt-recovery-actions-note')).toBeNull();
});

it('Orbit checking the repair: folded, no step', async () => {
  const h = await mount({ ...base, checkedAt: ago(14 * 60_000) }, repairOf(), true);
  expect(row(h.element)?.className).toContain('is-checking');
  expect(row(h.element)?.textContent).toContain('Checking its result…');
  expect(step(h.element)).toBeNull();
  expect(panel(h.element)).toBeNull();
});

it('ready: opens itself once, the row carries Merge and the panel does not repeat it', async () => {
  const repair = repairOf();
  const h = await mount(ready, repair);
  expect(row(h.element)?.className).toContain('is-ready');
  expect(panel(h.element)).not.toBeNull();
  expect(step(h.element)?.textContent).toBe('Merge into develop');
  expect(panelButtons(h.element)).toEqual(['Prepare PR candidate']);
  await act(async () => step(h.element)!.click());
  expect(h.action).toHaveBeenCalledExactlyOnceWith('apply', 'exact-preview');
  // Folded by the owner, it stays folded for this result…
  await act(async () => arrow(h.element).click());
  expect(panel(h.element)).toBeNull();
  await h.render({ ...ready }, repair);
  expect(panel(h.element)).toBeNull();
  // …and a new result opens it again.
  await h.render({ ...base, checkedAt: ago(1_000) }, repair);
  expect(row(h.element)?.className).toContain('is-conflict');
  expect(panel(h.element)).not.toBeNull();
});

it.each([
  ['conflict', base, repairOf(), 'Continue repair'],
  ['reply', { ...base, code: 'REPAIR_IN_PROGRESS' as const }, repairOf({ lastAssistantText: 'Keep which fixture?' }), 'Reply in repair session'],
  ['failed', base, repairOf({ status: 'FAILED', runState: 'FAILED', error: 'The runner stopped reporting' }), 'Resolve in repair session'],
])('%s: opens itself, and the row step continues the repair', async (kind, recovery, repair, label) => {
  const h = await mount(recovery, repair);
  expect(row(h.element)?.className).toContain(`is-${kind}`);
  expect(panel(h.element)).not.toBeNull();
  expect(step(h.element)?.textContent).toBe(label);
  expect(step(h.element)?.classList.contains('wt-merge-btn')).toBe(true);
  expect(panelButtons(h.element)).not.toContain(label);
  await act(async () => step(h.element)!.click());
  expect(h.repair).toHaveBeenCalledExactlyOnceWith(false);
});
