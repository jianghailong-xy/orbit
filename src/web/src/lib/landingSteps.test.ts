import { describe, expect, it } from 'vitest';
import type { IntegrationTimelineEntry } from '@orbit/shared';
import { landingSteps } from './landingSteps';

let seq = 0;
const line = (kind: IntegrationTimelineEntry['kind'], text: string, extra: Partial<IntegrationTimelineEntry> = {}): IntegrationTimelineEntry => {
  seq += 1;
  return {
    id: `e${seq}`, seq, kind, at: `2026-11-10T15:${String(20 + seq).padStart(2, '0')}:00.000Z`, claim: 1, round: 1,
    check: null, phase: null, step: null, actor: null, reason: null, data: null, text, ...extra,
  };
};
const merge = { name: 'MERGE_CHECK' as const, index: 1 };

describe('landingSteps', () => {
  it('gathers a landed task’s fifteen lines into Queue, Claim, Sync, Merge check and Push', () => {
    // The owner's 2026-11-11 screenshot, line for line.
    const entries = [
      line('ENQUEUED', 'Task marked done · queued to land on project/p1'),
      line('CLAIMED', 'Claimed by runner workstation-gpu · claim 1'),
      line('STEP', "Waiting for this runner's repository lock"),
      line('ROUND', 'Round 1 of 3'),
      line('STEP', 'Fetching the repository', { phase: 'FETCH' }),
      line('STEP', 'Syncing main into project/p1', { phase: 'MAIN_SYNC' }),
      line('STEP', 'Rebasing onto project/p1', { phase: 'REBASE' }),
      line('STEP', 'Running the checks', { phase: 'CHECK' }),
      line('STEP', 'Preparing the combined tree', { phase: 'MERGE' }),
      line('CHECK_STARTED', 'Merge check started · claim 1 · workstation-gpu', { check: merge }),
      line('STEP', 'Running the checks', { phase: 'CHECK' }),
      line('STEP', 'Reported starting the push to project/p1', { phase: 'PUSH' }),
      line('STEP', 'Verifying the merged tree', { phase: 'VERIFY' }),
      line('CHECK_FINISHED', 'Merge check passed · 0m 16s', { check: merge, data: { exitCode: 0, expectedExitCode: 0 } }),
      line('RESULT', 'Landed on project/p1 · 9afb7d1', { data: { state: 'LANDED' } }),
    ];
    const steps = landingSteps(entries, 'LAND_TASK');
    expect(steps.map((step) => [step.name, step.summary.text, step.entries.length])).toEqual([
      ['Queue', 'Task marked done · queued to land on project/p1', 1],
      ['Claim', 'Claimed by runner workstation-gpu · claim 1', 2],
      ['Sync', 'Preparing the combined tree', 6],
      ['Merge check', 'Merge check passed · 0m 16s', 3],
      ['Push', 'Landed on project/p1 · 9afb7d1', 3],
    ]);
    // Every line is kept, each once.
    expect(steps.flatMap((step) => step.entries.map(({ index }) => index)).sort((a, b) => a - b))
      .toEqual(entries.map((_, index) => index));
    // A step's time is its newest line's.
    expect(steps[4].at).toBe(entries[14].at);
  });

  it('keeps a failed check’s result in its check, so no Push row says a push failed', () => {
    const steps = landingSteps([
      line('ENQUEUED', 'Task marked done'),
      line('CLAIMED', 'Claimed by runner wikova · claim 1'),
      line('CHECK_STARTED', 'Merge check started', { check: merge }),
      line('CHECK_FINISHED', 'Merge check failed · exit 1 after 3m 52s', { check: merge, data: { exitCode: 1, expectedExitCode: 0 } }),
      line('RESULT', 'Check failed · nothing was pushed', { data: { state: 'CHECK_FAILED' } }),
    ], 'LAND_TASK');
    expect(steps.map((step) => step.name)).toEqual(['Queue', 'Claim', 'Merge check']);
    expect(steps[2].summary.text).toBe('Check failed · nothing was pushed');
  });

  it('says how a failed check ended, not the hand-off after it, and draws no step for a check that never ran', () => {
    // The owner's 2026-11-11 screenshot: task acceptance failed, the coordinator was asked, and the merge check never started.
    const acceptance = { name: 'TASK_ACCEPTANCE' as const, index: 1 };
    const steps = landingSteps([
      line('ENQUEUED', 'Task marked done'),
      line('CLAIMED', 'Claimed by runner workstation-gpu · claim 1'),
      line('STEP', 'Rebasing onto project/p1', { phase: 'REBASE' }),
      line('STEP', 'Running the checks', { phase: 'CHECK' }),
      line('STEP', 'Preparing the combined tree', { phase: 'CHECK' }),
      line('CHECK_STARTED', 'Task acceptance started', { check: acceptance }),
      line('CHECK_FINISHED', 'Task acceptance failed · exit 1', { check: acceptance, data: { exitCode: 1, expectedExitCode: 0 } }),
      line('HANDED_TO', 'Asked the coordinator to fix it'),
    ], 'LAND_TASK');
    expect(steps.map((step) => [step.name, step.summary.text])).toEqual([
      ['Queue', 'Task marked done'],
      ['Claim', 'Claimed by runner workstation-gpu · claim 1'],
      ['Sync', 'Preparing the combined tree'],
      ['Task acceptance', 'Task acceptance failed · exit 1'],
    ]);
  });

  it('names a merge round’s last step Merge, and a check round’s Result', () => {
    const ready = line('RESULT', 'Ready to merge into main', { data: { state: 'READY' } });
    expect(landingSteps([ready], 'CHECK_PROMOTION').map((step) => step.name)).toEqual(['Result']);
    const merged = line('RESULT', 'Merged into main · 8958893', { data: { state: 'LANDED' } });
    expect(landingSteps([merged], 'LAND_PROMOTION').map((step) => step.name)).toEqual(['Merge']);
  });

  it('gives task acceptance and the merge check a step each', () => {
    const acceptance = { name: 'TASK_ACCEPTANCE' as const, index: 1 };
    const steps = landingSteps([
      line('CHECK_STARTED', 'Task acceptance started', { check: acceptance }),
      line('CHECK_FINISHED', 'Task acceptance passed · 1m 02s', { check: acceptance }),
      line('CHECK_STARTED', 'Merge check started', { check: merge }),
    ], 'LAND_TASK');
    expect(steps.map((step) => step.name)).toEqual(['Task acceptance', 'Merge check']);
  });
});
