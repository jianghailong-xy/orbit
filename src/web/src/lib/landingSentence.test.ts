import { describe, expect, it } from 'vitest';
import type { SessionLandingView } from '@orbit/shared';
import { landingSentence, sentenceFacts, sentenceText, settledSentenceKind, stepsLabel } from './landingSentence';
import type { LandingStep } from './landingSteps';

/** A landing view with just what a sentence reads: its attempts' result lines and its target line. */
function view(results: Array<Record<string, unknown>>, targetRef = 'refs/heads/project/p1'): SessionLandingView {
  return {
    currentAttempt: { targetRef },
    timeline: {
      sections: results.map((data, index) => ({
        title: `Generation ${index + 1}`, jobId: `j-${index}`, kind: 'LAND_TASK', generation: index + 1, state: String(data.state),
        entries: [{ id: `r${index}`, kind: 'RESULT', at: '2026-11-11T07:47:00.000Z', claim: 1, round: 1, check: null, phase: 'PUSH',
          step: null, actor: null, reason: null, data, text: 'server words' }],
      })),
      facts: [], truncated: false,
    },
  } as unknown as SessionLandingView;
}

describe('landingSentence', () => {
  it('says where a landing went, from the result line’s fields, and on which try', () => {
    const once = landingSentence(sentenceFacts({ kind: 'LANDED', task: 'Record the OOM kill', landing: view([{ state: 'LANDED', landedSha: 'ed3d3e9abcdef' }]) }));
    expect(sentenceText(once)).toBe('Landed Record the OOM kill on project/p1 · ed3d3e9.');
    expect(once.filter((part) => part.strong).map((part) => part.text)).toEqual(['Record the OOM kill']);
    expect(once.filter((part) => part.code).map((part) => part.text)).toEqual(['project/p1', 'ed3d3e9']);
    const twice = landingSentence(sentenceFacts({ kind: 'LANDED', task: 'Record the OOM kill',
      landing: view([{ state: 'CHECK_FAILED' }, { state: 'LANDED', landedSha: 'ed3d3e9abcdef' }]) }));
    expect(sentenceText(twice)).toBe('Landed Record the OOM kill on project/p1 · ed3d3e9, on the second try.');
    const thrice = landingSentence({ kind: 'LANDED', task: 'T', tries: 3 });
    expect(sentenceText(thrice)).toBe('Landed T, on try 3.');
  });

  it('says a merge into main from the round’s merged record', () => {
    const merged = landingSentence(sentenceFacts({ kind: 'MERGED', task: 'Merged into main', landing: null, promotion: {
      taskIds: ['a', 'b'], upstreamRef: 'refs/heads/main', merged: { sha: 'f0416c9aaaa', at: '', automatic: true },
    } as never }));
    expect(sentenceText(merged)).toBe('Merged 2 tasks into main · f0416c9 · automatically.');
    const byYou = landingSentence({ kind: 'MERGED', task: '', merge: { tasks: 1, sha: '3f1c2a9', automatic: false, main: 'main' } });
    expect(sentenceText(byYou)).toBe('Merged 1 task into main · 3f1c2a9 · by you.');
  });

  it('says every other ending in its own words', () => {
    expect(sentenceText(landingSentence({ kind: 'ALREADY_LANDED', task: 'T' })))
      .toBe('Already landed: T was on the project line before this landing.');
    expect(sentenceText(landingSentence({ kind: 'NOTHING_TO_LAND', task: 'T' })))
      .toBe('Nothing to land for T: its branch has no commits beyond the project line.');
    expect(sentenceText(landingSentence({ kind: 'NOT_LANDED', task: 'T', reason: 'Merge check exited 1 (expected 0) · nothing was pushed.' })))
      .toBe('Did not land T: merge check exited 1 (expected 0) · nothing was pushed.');
    expect(sentenceText(landingSentence({ kind: 'NOT_LANDED', task: 'T', nothingPushed: true })))
      .toBe('Did not land T: nothing was pushed.');
    expect(sentenceText(landingSentence({ kind: 'STOPPED', task: 'T' }))).toBe('Stopped landing T.');
    expect(sentenceText(landingSentence({ kind: 'RUNNING', task: 'T', line: 'project/p1' }))).toBe('Landing T on project/p1…');
  });

  it('reads the kind off settledAs', () => {
    expect(['LANDED', 'MERGED', 'ALREADY_LANDED', 'NOTHING_TO_LAND', 'CANCELLED', null].map(settledSentenceKind))
      .toEqual(['LANDED', 'MERGED', 'ALREADY_LANDED', 'NOTHING_TO_LAND', 'STOPPED', 'STOPPED']);
  });

  it('labels an attempt’s steps line as the chat counts its tool calls', () => {
    const steps = (n: number) => Array.from({ length: n }, () => ({}) as LandingStep);
    expect(stepsLabel(steps(5), { generation: 1, title: 'Generation 1', kind: 'LAND_TASK' }, false)).toBe('5 steps');
    expect(stepsLabel(steps(1), { generation: 1, title: 'Generation 1', kind: 'LAND_TASK' }, false)).toBe('1 step');
    expect(stepsLabel(steps(4), { generation: 2, title: 'Generation 2', kind: 'LAND_TASK' }, true)).toBe('Generation 2 · 4 steps');
    expect(stepsLabel(steps(2), { generation: 1, title: 'Merge to main · 1', kind: 'LAND_PROMOTION' }, true)).toBe('Merge to main · 1 · 2 steps');
  });
});
