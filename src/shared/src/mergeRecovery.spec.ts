import { describe, expect, it } from 'vitest';
import { mergeRecoveryCommitOrigin, mergeRecoveryPrompt, mergeRecoveryReady, mergeRecoveryTargetRelation, readMergeRecovery,
  type MergeRecovery } from './mergeRecovery';

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
    for (const prompt of [mergeRecoveryPrompt(ready), mergeRecoveryPrompt(ready, true)]) {
      expect(prompt).toContain('When this turn ends, Orbit checks the recovery again by itself');
      expect(prompt).toContain('Commit the resolution in the repair worktree');
      expect(prompt).toContain('ask the owner directly');
      expect(prompt).not.toContain('owner will check');
    }
  });
});
