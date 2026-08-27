import { describe, expect, it } from 'vitest';
import { adaptJudgmentEvidence } from './judgmentEvidence';

describe('judgment evidence adapter', () => {
  it('adapts the explicit v1 criterion snapshot and follows only declared evidence refs', () => {
    const adapted = adaptJudgmentEvidence({
      schemaVersion: 1,
      kind: 'TASK_COMPLETION_EVIDENCE',
      task: { criterionSnapshot: ['第一条原始判据', '第二条原始判据'] },
      acceptanceCriteria: [
        {
          ordinal: 1,
          satisfied: true,
          explanation: '390×844 与 430×932 均无横向滚动。',
          evidenceRefs: ['mobile'],
        },
        {
          ordinal: 2,
          satisfied: false,
          explanation: '仍需补充键盘轨迹。',
          evidenceRefs: ['trace'],
        },
      ],
      verification: [{
        id: 'mobile',
        command: 'npm test -w @orbit/web',
        exitCode: 0,
        rawOutput: 'Test Files 95 passed\nTests 1234 passed\n' + 'long output\n'.repeat(20),
      }],
      artifacts: [{ id: 'trace', name: 'focus-trace.json', sha256: 'a'.repeat(64) }],
      commands: [{ id: 'unreferenced', command: 'must not be attached', exitCode: 0 }],
    });

    expect(adapted.kind).toBe('SUPPORTED');
    if (adapted.kind !== 'SUPPORTED') return;
    expect(adapted.criteria.map((criterion) => criterion.text)).toEqual([
      '第一条原始判据',
      '第二条原始判据',
    ]);
    expect(adapted.criteria[0]).toMatchObject({
      submitterConclusion: 'PASS',
      submitterClaimsPass: true,
      finding: '390×844 与 430×932 均无横向滚动。',
    });
    expect(adapted.criteria[0].commands).toHaveLength(1);
    expect(adapted.criteria[0].commands[0].keyOutput).toContain('Test Files 95 passed');
    expect(adapted.criteria[0].commands[0].fullOutput).toContain('long output');
    expect(adapted.criteria[0].commands.some((command) => command.id === 'unreferenced')).toBe(false);
    expect(adapted.criteria[1].submitterClaimsPass).toBe(false);
    expect(adapted.criteria[1].artifacts[0]).toMatchObject({
      title: 'focus-trace.json',
      facts: [{ label: 'SHA-256', value: 'a'.repeat(64) }],
    });
  });

  it('supports self-describing v1 criteria with embedded commands and artifacts', () => {
    const adapted = adaptJudgmentEvidence({
      schemaVersion: 1,
      kind: 'TASK_COMPLETION_EVIDENCE',
      criteria: [{
        id: 'criterion-a',
        text: '原始判据 A',
        submitterConclusion: 'PASS',
        finding: '提交者记录的 finding。',
        commands: [{ command: 'git diff --check', exitCode: 0, observation: 'no output' }],
        artifacts: [{ name: 'after-390.png', path: '/tmp/after-390.png' }],
      }],
    });

    expect(adapted.kind).toBe('SUPPORTED');
    if (adapted.kind !== 'SUPPORTED') return;
    expect(adapted.criteria[0].key).toBe('criterion-a');
    expect(adapted.criteria[0].commands[0]).toMatchObject({
      command: 'git diff --check',
      exitCode: 0,
      keyOutput: 'no output',
    });
    expect(adapted.criteria[0].artifacts[0].title).toBe('after-390.png');
  });

  it('never parses acceptanceCriteria prose to invent criterion boundaries', () => {
    const adapted = adaptJudgmentEvidence({
      schemaVersion: 1,
      kind: 'TASK_COMPLETION_EVIDENCE',
      acceptanceCriteria: '1. first\n2. second',
      verdict: 'PASS',
      commands: [{ command: 'npm test', exitCode: 0 }],
    });
    expect(adapted).toEqual({
      kind: 'FALLBACK',
      reason: 'UNRECOGNIZED_V1_SHAPE',
      version: '1',
    });
  });

  it('falls back for old v1 variants without structured criterion text', () => {
    expect(adaptJudgmentEvidence({
      schemaVersion: 1,
      acceptanceCriteria: [{ number: 1, result: 'PASS', finding: 'No text identity.' }],
    })).toEqual({
      kind: 'FALLBACK',
      reason: 'UNRECOGNIZED_V1_SHAPE',
      version: '1',
    });
  });

  it('falls back clearly for missing, unknown, and incomplete versions', () => {
    expect(adaptJudgmentEvidence({ criteria: [] })).toEqual({
      kind: 'FALLBACK', reason: 'MISSING_VERSION', version: null,
    });
    expect(adaptJudgmentEvidence({ schemaVersion: 2, criteria: [] })).toEqual({
      kind: 'FALLBACK', reason: 'UNSUPPORTED_VERSION', version: '2',
    });
    expect(adaptJudgmentEvidence({
      schemaVersion: 1,
      kind: 'SOME_OTHER_DOCUMENT',
      criteria: [{ text: 'Looks structured', submitterConclusion: 'PASS' }],
    })).toEqual({
      kind: 'FALLBACK', reason: 'UNRECOGNIZED_V1_SHAPE', version: '1',
    });
    expect(adaptJudgmentEvidence({
      schemaVersion: 1,
      kind: 'TASK_COMPLETION_EVIDENCE',
      criteria: [{ text: 'A criterion without a conclusion' }],
    })).toEqual({
      kind: 'FALLBACK', reason: 'INCOMPLETE_CRITERIA', version: '1',
    });
  });
});
