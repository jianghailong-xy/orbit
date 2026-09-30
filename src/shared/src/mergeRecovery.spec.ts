import { describe, expect, it } from 'vitest';
import { mergeRecoveryPrompt, mergeRecoveryReady, readMergeRecovery, type MergeRecovery } from './mergeRecovery';

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
  it('hands repairs the actual private checkout and forbids shared target writes', () => {
    const prompt = mergeRecoveryPrompt({ ...ready, repairBranch: 'orbit/recovery/abc', repairWorktree: '/private/abc',
      phase: 'SOURCE_REPLAY', conflicts: ['file.ts'] });
    expect(prompt).toContain('/private/abc');
    expect(prompt).toContain(ready.sourceSha);
    expect(prompt).toContain('SOURCE_REPLAY');
    expect(prompt).toContain('file.ts');
    expect(prompt).toContain('Do not push the target.');
    expect(prompt).toContain('owner will check');
    expect(mergeRecoveryPrompt(ready, true)).toContain('organize commits on a separate PR candidate');
  });
});
