import { describe, expect, it } from 'vitest';
import { conditionQuery } from './conditions';
import { sessionRequestQuery } from './queries';
import { awaitDraftFrom, scheduleDetailQuery, scheduleDraftsQuery, scheduleRequestQuery } from './schedules';
import { sessionReaches, taskDocumentReach, taskGraphReach, type SessionReachDeclaration, type SessionSubject } from './sessionReach';

/**
 * The reads whose key does not name their sessions say which they are from what they hold (lib/sessionReach): a
 * session event reads one again only when it is about one of those (useControlPlane.sessionReach.test.tsx shows the
 * stream's side). Task 350wwd0BfOJPegSAOYpPY.
 */
describe('the reads whose sessions are in what they hold', () => {
  const subject = (id: string, extra: Partial<SessionSubject> = {}): SessionSubject => ({
    id, workspaceId: 'A', taskId: '', projectId: '', createdOnly: false, created: false, lifecycle: false, ...extra,
  });
  const reaches = (declared: unknown, data: unknown, who: SessionSubject): boolean => {
    const declaration = declared as SessionReachDeclaration;
    const reach = typeof declaration === 'function' ? declaration(data) : declaration;
    return sessionReaches(reach, who, [], () => true);
  };

  it('a session request: its two ends', () => {
    const meta = sessionRequestQuery('q1').meta!.sessionReach;
    const data = { fromSessionId: 'S1', toSessionId: 'S2' };
    expect(reaches(meta, data, subject('S1'))).toBe(true);
    expect(reaches(meta, data, subject('S2'))).toBe(true);
    expect(reaches(meta, data, subject('S3'))).toBe(false);
  });

  it('a schedule\'s inspector: its runs, its cards\' askers, and an unlisted run of its workspace', () => {
    const meta = scheduleDetailQuery('sc1').meta!.sessionReach;
    const data = {
      schedule: { workspaceId: 'A' }, lastRun: { sessionId: 'R1' }, recentRuns: [{ sessionId: 'R0' }],
      pendingCards: [{ askedBySessionId: 'S5' }],
    };
    expect(reaches(meta, data, subject('R0'))).toBe(true);
    expect(reaches(meta, data, subject('S5'))).toBe(true);
    // listedElsewhere says yes for everything here: a listed session of A is not a scheduled run.
    expect(reaches(meta, data, subject('S3'))).toBe(false);
    expect(sessionReaches({ scheduledRuns: 'A' }, subject('R9'), [], () => false)).toBe(true);
    expect(reaches(meta, data, subject('R9', { workspaceId: 'B' }))).toBe(false);
  });

  it('the drafts: their askers, and the sessions this tab waits on for a card', () => {
    const meta = scheduleDraftsQuery().meta!.sessionReach;
    const data = { drafts: [{ askedBySessionId: 'S5' }] };
    expect(reaches(meta, data, subject('S5'))).toBe(true);
    expect(reaches(meta, data, subject('Q1'))).toBe(false);
    awaitDraftFrom('Q1');
    expect(reaches(meta, data, subject('Q1'))).toBe(true);
  });

  it('a schedule request: its asker; a condition: its task\'s runs, else none', () => {
    expect(reaches(scheduleRequestQuery('r1').meta!.sessionReach, { askedBySessionId: 'S5' }, subject('S5'))).toBe(true);
    expect(reaches(scheduleRequestQuery('r1').meta!.sessionReach, { askedBySessionId: 'S5' }, subject('S6'))).toBe(false);
    const condition = conditionQuery('c1').meta!.sessionReach;
    expect(reaches(condition, { taskId: 'K1' }, subject('T1', { taskId: 'K1' }))).toBe(true);
    expect(reaches(condition, { taskId: 'K1' }, subject('T2', { taskId: 'K2' }))).toBe(false);
    expect(reaches(condition, { taskId: null }, subject('T1', { taskId: 'K1' }))).toBe(false);
  });

  it('a task\'s document: its runs and the sessions it names; a graph: runs of its tasks', () => {
    const doc = taskDocumentReach('K1');
    const data = { sessions: [{ id: 'T0' }], creatorSession: { id: 'C1' } };
    expect(reaches(doc, data, subject('T1', { taskId: 'K1' }))).toBe(true);
    expect(reaches(doc, data, subject('T0'))).toBe(true);
    expect(reaches(doc, data, subject('C1'))).toBe(true);
    expect(reaches(doc, data, subject('T2', { taskId: 'K2' }))).toBe(false);
    const graph = { nodes: [{ id: 'K1' }, { id: 'K3' }] };
    expect(reaches(taskGraphReach, graph, subject('T3', { taskId: 'K3' }))).toBe(true);
    expect(reaches(taskGraphReach, graph, subject('T2', { taskId: 'K2' }))).toBe(false);
    expect(reaches(taskGraphReach, graph, subject('S1'))).toBe(false);
  });
});
