import { describe, expect, it } from 'vitest';
import type { IntegrationTimelineEntry, IntegrationTimelineSection, ProjectOpenItemRow } from '@orbit/shared';
import {
  LANDING_FIX_COPY,
  landingFixAgainSha,
  landingFixColumnCards,
  landingFixEventSub,
  landingFixEvents,
  landingFixFailureWords,
  landingFixLastWords,
  landingFixStanding,
  landingFixSteps,
  openItemFixLine,
  openItemFixTitle,
  parseLandingFixTurn,
} from './landingFix';
import { landingSteps } from './landingSteps';
import { triggerMessage } from './landingTrigger';

// The words apiserver projects/landing-fix-turn.ts `landingFixMessage` writes, for a conflict and for a red check.
const CONFLICT_TURN = [
  'Orbit could not land your work for "A10c · Notification cold start drops the session" on project/34ZZnCsCFp.',
  '',
  'Conflict while rebasing onto project/34ZZnCsCFp at 41ac9e0:',
  'app/notify/ColdStartRouter.kt, app/session/SessionListStore.kt',
  '',
  'Nothing was pushed. project/34ZZnCsCFp is unchanged.',
  '',
  'Fix it on your own branch, in this checkout:',
  '1. Merge project/34ZZnCsCFp into your branch and resolve what conflicts.',
  '2. Run what failed until it passes.',
  '3. Commit, then end your turn.',
  '',
  'Orbit lands the new commit and runs the checks again by itself. Do not push project/34ZZnCsCFp.',
  'If this is not yours to fix, end your turn without committing and say why; the project\'s coordinator takes it from there.',
  'The full record: landing 4Hk1yFe1Kt1kI1YVMuLJLi.',
].join('\n');

const CHECK_TURN = [
  'Orbit could not land your work for "Write back first" on project/x.',
  '',
  'The check "landing check" (npm test) failed on the combined tree (9f1c2ab), exit 1:',
  'FAIL src/a.test.ts',
  '  expected 2, got 3',
  '',
  'Nothing was pushed. project/x is unchanged.',
  '',
  'Fix it on your own branch, in this checkout:',
  '1. Merge project/x and main into your branch and resolve what conflicts.',
  '2. Run what failed until it passes.',
  '3. Commit, then end your turn.',
  '',
  'Orbit lands the new commit and runs the checks again by itself. Do not push project/x.',
  'If this is not yours to fix, end your turn without committing and say why; the project\'s coordinator takes it from there.',
  'The full record: landing not recorded.',
].join('\n');

let seq = 0;
const entry = (kind: string, at: string, o: Partial<IntegrationTimelineEntry> = {}): IntegrationTimelineEntry => ({
  id: `e${++seq}`, seq, kind, at, claim: 1, round: null, check: null, phase: null, step: null,
  actor: { type: 'PLATFORM' }, reason: null, data: null, text: kind, ...o,
} as unknown as IntegrationTimelineEntry);
const section = (jobId: string, entries: IntegrationTimelineEntry[]): IntegrationTimelineSection => ({
  title: 'Generation', jobId, kind: 'LAND_TASK', generation: 1, state: 'CONFLICT', entries,
} as unknown as IntegrationTimelineSection);

const handed = entry('HANDED_TO_SESSION', '2026-11-20T02:02:30Z', { data: { itemId: 'i1', sessionId: 'S1' }, text: 'Handed to the task\'s session' });
const fixed = entry('FIXED_BY_SESSION', '2026-11-20T02:09:00Z', {
  actor: { type: 'TASK_SESSION', sessionId: 'S1' }, data: { sessionId: 'S1', sourceSha: '4be19c2deadbeef' }, text: 'Fixed in 4be19c2 · landing again',
});
const returned = entry('RETURNED_TO_COORDINATOR', '2026-11-20T02:31:00Z', {
  reason: 'NO_NEW_COMMIT', data: { itemId: 'i1', sessionId: 'S1', returnReason: 'NO_NEW_COMMIT', lastMessage: ' It is not mine to fix. ' }, text: 'Returned to the coordinator: no new commit',
});
const failedResult = entry('RESULT', '2026-11-20T02:02:20Z', { data: { state: 'CONFLICT' } });

describe('parseLandingFixTurn', () => {
  it('reads a conflict turn back into the card’s facts', () => {
    const turn = parseLandingFixTurn(CONFLICT_TURN)!;
    expect(turn).toMatchObject({
      taskTitle: 'A10c · Notification cold start drops the session',
      target: 'project/34ZZnCsCFp',
      state: 'CONFLICT',
      verb: 'rebasing onto',
      targetSha: '41ac9e0',
      lines: ['app/notify/ColdStartRouter.kt', 'app/session/SessionListStore.kt'],
      landingSessionId: '4Hk1yFe1Kt1kI1YVMuLJLi',
    });
    expect(landingFixFailureWords(turn)).toEqual({ before: 'Conflict while rebasing onto the project branch at ', sha: '41ac9e0', after: '.' });
    expect(landingFixSteps(turn)).toEqual([
      'Merge the project branch into your branch and resolve what conflicts.',
      'Run what failed until it passes.',
      'Commit, then end your turn.',
    ]);
  });

  it('reads a red check, its failure lines, and a record it did not name', () => {
    const turn = parseLandingFixTurn(CHECK_TURN)!;
    expect(turn.state).toBe('CHECK_FAILED');
    expect(turn.lines).toEqual(['FAIL src/a.test.ts', '  expected 2, got 3']);
    expect(turn.landingSessionId).toBeNull();
    expect(landingFixFailureWords(turn).before).toBe('The check "landing check" (npm test) failed on the combined tree (9f1c2ab), exit 1');
    expect(landingFixSteps(turn)[0]).toBe('Merge the project branch and main into your branch and resolve what conflicts.');
  });

  it('is nothing for any other text, including a person quoting the first line', () => {
    expect(parseLandingFixTurn('Why did Orbit could not land your work?')).toBeNull();
    expect(parseLandingFixTurn('Orbit could not land your work for "x" on main.\n\nhello')).toBeNull();
    expect(parseLandingFixTurn(null)).toBeNull();
  });
});

describe('the landing window’s reading', () => {
  it('is FIXING while the newest of the three rows is the hand-off, with its round and its session', () => {
    const landing = { settledAt: null, timeline: { truncated: false, facts: [], sections: [section('j1', [failedResult, handed])] } };
    expect(landingFixStanding(landing as never)).toEqual({
      state: 'FIXING', sessionId: 'S1', at: handed.at, round: 1, returnReason: null, lastMessage: null,
    });
    const events = landingFixEvents(landing as never);
    expect(landingFixEventSub(events[0], events, false)).toBe('It wrote this work · round 1 of 2');
  });

  it('is nothing once the fix lands again, and names the commit it lands with', () => {
    const landing = { settledAt: null, timeline: { truncated: false, facts: [], sections: [section('j1', [failedResult, handed]), section('j2', [fixed])] } };
    expect(landingFixStanding(landing as never)).toBeNull();
    expect(landingFixAgainSha(landing as never, 'S1')).toBe('4be19c2');
    expect(landingFixAgainSha(landing as never, 'S2')).toBeNull();
  });

  it('is RETURNED after a hand-back, with its reason, and says where the last words are', () => {
    const landing = { settledAt: null, timeline: { truncated: false, facts: [], sections: [section('j1', [failedResult, handed, returned])] } };
    expect(landingFixStanding(landing as never)).toMatchObject({ state: 'RETURNED', returnReason: 'NO_NEW_COMMIT', round: 1, lastMessage: 'It is not mine to fix.' });
    const silent = entry('RETURNED_TO_COORDINATOR', '2026-11-20T02:31:00Z', { reason: 'TURN_FAILED', data: { itemId: 'i1', sessionId: 'S1', returnReason: 'TURN_FAILED', lastMessage: null } });
    expect(landingFixStanding({ settledAt: null, timeline: { truncated: false, facts: [], sections: [section('j1', [handed, silent])] } } as never)?.lastMessage).toBeNull();
    const events = landingFixEvents(landing as never);
    expect(landingFixEventSub(events[0], events, false)).toBe('round 1 of 2');
    expect(landingFixEventSub(events[1], events, false)).toBe(LANDING_FIX_COPY.LAST_WORDS_BELOW);
    expect(landingFixEventSub(events[1], events, true)).toBeNull();
  });

  it('counts the second hand-off as round 2, and says nothing for a settled landing', () => {
    const handed2 = entry('HANDED_TO_SESSION', '2026-11-20T02:20:00Z', { data: { sessionId: 'S1' } });
    const landing = { settledAt: null, timeline: { truncated: false, facts: [], sections: [section('j1', [handed]), section('j2', [fixed, handed2])] } };
    expect(landingFixStanding(landing as never)?.round).toBe(2);
    expect(landingFixStanding({ ...landing, settledAt: '2026-11-20T03:00:00Z' } as never)).toBeNull();
  });

  it('keeps the three rows out of the steps', () => {
    const steps = landingSteps([failedResult, handed, returned], 'LAND_TASK');
    expect(steps.flatMap((step) => step.entries.map(({ entry: line }) => line.kind))).toEqual(['RESULT']);
  });

  it('opens the fix’s attempt as the task session’s, with its commit', () => {
    const message = triggerMessage({
      cause: 'RETRY', by: 'TASK', at: fixed.at, sourceRef: 'refs/heads/orbit/task-a10c', sourceSha: '4be19c2deadbeef',
      sessionId: 'S1', reason: 'landing again',
    } as never, { task: 'A10c' });
    expect(message.from).toBe('From the task’s session · Fix');
    expect(message.parts.map((part) => part.text).join('')).toBe('Land A10c · orbit/task-a10c · 4be19c2');
  });

  it('quotes last words as the server does', () => {
    expect(landingFixLastWords('  hi  ')).toBe('hi');
    expect(landingFixLastWords('')).toBeNull();
    expect(landingFixLastWords('x'.repeat(1_300))).toHaveLength(1_201);
  });
});

describe('open items and the left column', () => {
  const NOW = Date.parse('2026-11-20T02:06:30Z');
  const row = (o: Partial<ProjectOpenItemRow>): ProjectOpenItemRow => ({
    itemId: 'i1', kind: 'INTEGRATION_CONFLICT', title: 'Merge conflict', taskId: 't1', landingSessionId: 'L1',
    facts: { task: { id: 't1', title: 'A10c · Notification cold start drops the session' }, targetRef: 'refs/heads/project/x', targetSha: null, files: [], nothingLanded: true, check: null, branchUnchanged: false, errorCode: null, failure: null },
    handling: null,
    workSession: { sessionId: 'S1', offeredAt: '2026-11-20T02:02:30Z', rounds: 0 },
    ...o,
  } as unknown as ProjectOpenItemRow);

  it('words a held item as the board does', () => {
    expect(openItemFixTitle(row({}))).toBe('Landing conflict · A10c · Notification cold start drops the session');
    expect(openItemFixLine(row({}), NOW)).toBe('The task’s session is on it · 4m · round 1 of 2 · nothing was pushed');
  });

  it('says a required check on a pull request left it unmerged, not that nothing was pushed', () => {
    const facts = { ...row({}).facts!, check: { name: 'GITHUB_CHECK' } as never };
    expect(openItemFixLine(row({ facts }), NOW)).toBe('The task’s session is on it · 4m · round 1 of 2 · pull request not merged');
  });

  it('draws a Fixing card per held item not already landing again, then a Not landed card per hand-back', () => {
    const cards = landingFixColumnCards({
      withWorkSession: [row({}), row({ itemId: 'i2', handling: { jobId: 'j2' } as never })],
      withCoordinator: [row({ itemId: 'i3', workSession: { sessionId: 'S3', offeredAt: '2026-11-20T02:02:30Z', returnedAt: '2026-11-20T02:06:10Z', returnReason: 'NO_NEW_COMMIT', rounds: 0 } }),
        row({ itemId: 'i4', workSession: null })],
    }, NOW);
    expect(cards.map((card) => [card.itemId, card.state, card.detail, card.target, card.line])).toEqual([
      ['i1', 'FIXING', 'conflict · its own session is on it', 'project/x', 'The task’s session is fixing it · 4m · round 1 of 2'],
      ['i3', 'RETURNED', 'conflict · nothing was pushed', 'project/x', 'Coordinator has it · just now'],
    ]);
  });
});
