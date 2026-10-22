import { describe, expect, it } from 'vitest';
import { mergeRecoveryCommitOrigin, mergeRecoveryConfirmable, mergeRecoveryContinuePrompt, mergeRecoveryPrompt,
  mergeRecoveryReady, mergeRecoveryTargetRelation, readMergeRecovery, type MergeRecovery } from './mergeRecovery';

const ready: MergeRecovery = {
  code: 'READY', targetBranch: 'develop', previewId: 'reviewed', sourceSha: 'a'.repeat(40),
  localSha: 'b'.repeat(40), remoteSha: 'c'.repeat(40), candidateSha: 'd'.repeat(40),
  candidateTreeSha: 'e'.repeat(40), patch: '', check: { status: 'unconfigured' },
};

describe('merge recovery wire contract', () => {
  it('accepts minimal old diagnostics but requires a complete checked candidate for approval', () => {
    const diagnostic = readMergeRecovery({ code: 'TARGET_DIVERGED', targetBranch: 'develop' });
    expect(diagnostic).toBeTruthy();
    expect(mergeRecoveryReady(diagnostic)).toBe(false);
    expect(mergeRecoveryReady(ready)).toBe(true);
    for (const incomplete of [ { ...ready, check: undefined }, { ...ready, previewId: '' },
      { ...ready, patch: undefined }, { ...ready, candidateTreeSha: 'short' },
      { ...ready, check: { status: 'failed' as const } }, { ...ready, code: 'CONFLICT' } ]) {
      expect(mergeRecoveryReady(incomplete)).toBe(false);
    }
  });
  it('rejects malformed fields before clients render or decode them', () => {
    for (const bad of [null, [], { code: 'READY' }, { ...ready, localCommits: [null] },
      { ...ready, patch: 5 }, { ...ready, conflicts: [false] }, { ...ready, check: { status: 'unknown' } }]) {
      expect(readMergeRecovery(bad)).toBeNull();
    }
  });
  it('reads the commits a push adds and tells where each comes from', () => {
    const local = { sha: 'b'.repeat(40), subject: 'Local unpublished work', author: 'Alice', date: '2026-09-30' };
    const r = readMergeRecovery({ ...ready, localCommits: [local], pushCommits: [
      { sha: 'd'.repeat(40), subject: 'Session work', author: 'Orbit', date: '2026-10-01' },
      { sha: 'f'.repeat(40), subject: 'Merge origin/develop into develop', author: 'Orbit', date: '2026-10-01', merge: true },
      local,
    ] });
    expect(r?.pushCommits?.map((c) => mergeRecoveryCommitOrigin(r!, c))).toEqual(['session', 'merge', 'local']);
    expect(mergeRecoveryCommitOrigin(r!, { ...local, merge: true })).toBe('local');
    for (const bad of [{ ...ready, pushCommits: [{ ...local, merge: 'yes' }] }, { ...ready, pushCommits: {} }]) {
      expect(readMergeRecovery(bad)).toBeNull();
    }
  });
  it('reads the origin commits an ALREADY_LANDED result names for each session commit', () => {
    const landed = [
      { sha: 'f'.repeat(40), subject: 'Session list wiring tests', author: 'Alice', date: '2026-10-11T10:34:00Z', sourceSha: 'a'.repeat(40) },
      { sha: 'e'.repeat(40), subject: 'Agents model', author: 'Alice', date: '2026-10-11T09:36:00Z', sourceSha: '9'.repeat(40) },
    ];
    const r = readMergeRecovery({ code: 'ALREADY_LANDED', targetBranch: 'main', sourceSha: 'a'.repeat(40), localSha: 'b'.repeat(40),
      remoteSha: 'c'.repeat(40), checkedAt: '2026-10-17T06:00:00Z', patch: '', landedCommits: landed });
    expect(r?.landedCommits).toEqual(landed);
    expect(mergeRecoveryReady(r)).toBe(false);
  });
  it('offers Done only on an ALREADY_LANDED check stored with a previewId and naming its source, and never as a candidate', () => {
    const landed: MergeRecovery = { code: 'ALREADY_LANDED', targetBranch: 'main', previewId: 'stored', sourceSha: 'a'.repeat(40),
      localSha: 'b'.repeat(40), remoteSha: 'c'.repeat(40), patch: '', checkedAt: '2026-10-17T06:00:00Z',
      landedCommits: [{ sha: 'f'.repeat(40), subject: 'Agents model', author: 'Alice', date: '2026-10-11T09:36:00Z', sourceSha: 'a'.repeat(40) }] };
    expect(mergeRecoveryConfirmable(readMergeRecovery(landed))).toBe(true);
    for (const not of [null, undefined, { ...landed, previewId: undefined }, { ...landed, previewId: '' },
      { ...landed, sourceSha: undefined }, { ...landed, sourceSha: 'a'.repeat(7) }, { ...landed, code: 'READY' },
      { ...landed, code: 'CONFLICT' }, { ...landed, code: 'TARGET_DIVERGED' }, ready]) {
      expect(mergeRecoveryConfirmable(not)).toBe(false);
    }
    // The previewId the server gives it changes none of the existing judgments: it is no candidate to apply.
    expect(mergeRecoveryReady(landed)).toBe(false);
    expect(mergeRecoveryReady({ ...landed, candidateSha: 'd'.repeat(40), candidateTreeSha: 'e'.repeat(40), check: { status: 'passed' } })).toBe(false);
  });
  it('rejects landedCommits of the wrong shape', () => {
    const commit = { sha: 'f'.repeat(40), subject: 'Agents model', author: 'Alice', date: '2026-10-11T09:36:00Z' };
    const landed = { ...commit, sourceSha: 'a'.repeat(40) };
    for (const bad of [{}, 'f'.repeat(40), [null], [commit], [{ ...landed, sourceSha: 5 }], [{ ...landed, sha: 1 }],
      [{ ...landed, merge: 'no' }]]) {
      expect(readMergeRecovery({ code: 'ALREADY_LANDED', targetBranch: 'main', landedCommits: bad })).toBeNull();
    }
  });
  it('relates the local target to origin only when a check has read both sides', () => {
    const c = { sha: 'f'.repeat(40), subject: 'x', author: 'Alice', date: '2026-09-30' };
    expect(mergeRecoveryTargetRelation({ ...ready, remoteSha: ready.localSha })).toEqual({ ahead: 0, behind: 0 });
    expect(mergeRecoveryTargetRelation({ ...ready, localCommits: [c] })).toEqual({ ahead: 1, behind: 0 });
    expect(mergeRecoveryTargetRelation({ ...ready, localCommits: [c], remoteCommits: [c, c] })).toEqual({ ahead: 1, behind: 2 });
    expect(mergeRecoveryTargetRelation(ready)).toBeNull();
    expect(mergeRecoveryTargetRelation({ code: 'TARGET_DIVERGED', targetBranch: 'develop' })).toBeNull();
  });
  it('hands repairs the actual private checkout and forbids shared target writes', () => {
    const prompt = mergeRecoveryPrompt({ ...ready, repairBranch: 'orbit/recovery/abc', repairWorktree: '/private/abc',
      phase: 'SOURCE_REPLAY', conflicts: ['file.ts'] });
    expect(prompt).toContain('/private/abc');
    expect(prompt).toContain(ready.sourceSha);
    expect(prompt).toContain('SOURCE_REPLAY');
    expect(prompt).toContain('file.ts');
    expect(prompt).toContain('Do not push the target.');
    expect(prompt).toContain('The owner reviews the complete diff before any target push.');
    expect(mergeRecoveryPrompt(ready, true)).toContain('organize commits on a separate PR candidate');
  });
  it('tells a repair that Orbit checks again when its turn ends, to commit, and to ask the owner directly', () => {
    for (const prompt of [mergeRecoveryPrompt(ready), mergeRecoveryPrompt(ready, true),
      mergeRecoveryContinuePrompt(ready), mergeRecoveryContinuePrompt(ready, true)]) {
      expect(prompt).toContain('When this turn ends, Orbit checks the recovery again by itself');
      expect(prompt).toContain('Commit the resolution in the repair worktree');
      expect(prompt).toContain('ask the owner directly');
      expect(prompt).not.toContain('owner will check');
    }
  });
  it('hands the repair session the next step of the same recovery, with where it stands now', () => {
    const conflict: MergeRecovery = { ...ready, code: 'CONFLICT', phase: 'TARGET_SYNC', conflicts: ['a.ts', 'b.ts'],
      repairBranch: 'orbit/recovery/abc', repairWorktree: '/private/abc' };
    const prompt = mergeRecoveryContinuePrompt(conflict);
    expect(prompt).toContain('This is the next step of the same merge recovery for develop');
    expect(prompt).toContain('Check result: CONFLICT');
    expect(prompt).toContain('Phase: TARGET_SYNC');
    expect(prompt).toContain('Conflicting files: a.ts, b.ts');
    expect(prompt).toContain('Repair branch: orbit/recovery/abc');
    expect(prompt).toContain('Repair worktree: /private/abc');
    expect(prompt).toContain(ready.remoteSha);
    // The first message's asks, word for word, and no PR candidate unless one is asked for.
    expect(prompt.slice(prompt.indexOf('Work only'))).toBe(mergeRecoveryPrompt(conflict).slice(mergeRecoveryPrompt(conflict).indexOf('Work only')));
    expect(prompt).not.toContain('PR candidate');
  });
  it('lists what an unfinished repair left unresolved, and keeps to the repair it has when the check names none', () => {
    const unfinished = mergeRecoveryContinuePrompt({ code: 'REPAIR_IN_PROGRESS', targetBranch: 'main', phase: 'SOURCE_REPLAY',
      conflicts: ['Sources/AgentsModel.swift'] });
    expect(unfinished).toContain('Check result: REPAIR_IN_PROGRESS');
    expect(unfinished).toContain('Unresolved files: Sources/AgentsModel.swift');
    expect(unfinished).not.toContain('Conflicting files');
    expect(unfinished).toContain('Repair branch: the one you have been repairing on');
    expect(unfinished).toContain('Repair worktree: the one you have been repairing in');
    expect(unfinished).not.toContain('create a separate repair branch');
  });
  it('asks the repair session for a PR candidate when one is being prepared', () => {
    const prompt = mergeRecoveryContinuePrompt({ ...ready, code: 'CONFLICT', conflicts: ['a.ts'] }, true);
    expect(prompt).toContain('This is the next step of the same merge recovery for develop: prepare a reviewable PR candidate');
    expect(prompt).toContain('organize commits on a separate PR candidate according to repository policy');
    expect(prompt).toContain('Respect required linear history and branch protection.');
    expect(prompt).toContain('Prepare a candidate branch and complete diff for review; do not claim it is merged.');
  });
});
