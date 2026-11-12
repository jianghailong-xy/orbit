import { describe, expect, it } from 'vitest';
import { sessionLine } from './WorkspaceView';

/**
 * The row words for what a session asked of the owner and for task moves waiting on them (board
 * waiting-on-you-removal 01-board-2): the server names the kind (`waitingKind`) and the row says it
 * in amber, the same words iOS and Android say.
 */
describe('sessionLine — owner requests and task moves', () => {
  const parked = { status: 'AWAITING_INPUT', engineTurnActive: false, pendingApprovals: 1 };
  const request = (kind: string) => ({ ownerRequestId: `r-${kind}`, kind, title: 't', since: '2026-11-12T00:00:00Z' });
  const moves = (...counts: number[]) => counts.map((count, index) => ({
    requestedBySessionId: 's', fromProjectId: `f${index}`, toProjectId: 't', count, since: '2026-11-12T00:00:00Z', title: 't', handoffIds: [],
  }));

  it.each([
    ['DECISION', 'Decision for you'],
    ['SECRET', 'Key needed'],
    ['MANUAL_STEP', 'Steps for you'],
    ['CONFIRM', 'Confirm for you'],
  ])('a %s request says “%s”', (kind, words) => {
    expect(sessionLine({ ...parked, waitingKind: 'OWNER_REQUEST', ownerRequests: [request(kind), request(kind)] }, true))
      .toEqual({ text: words, tone: 'approval' });
  });

  it('one task move says “Approve task move”, several say how many', () => {
    expect(sessionLine({ ...parked, waitingKind: 'MOVE_REQUEST', taskMoves: moves(1) }, true))
      .toEqual({ text: 'Approve task move', tone: 'approval' });
    expect(sessionLine({ ...parked, pendingApprovals: 2, waitingKind: 'MOVE_REQUEST', taskMoves: moves(5, 3) }, true))
      .toEqual({ text: 'Approve 8 task moves', tone: 'approval' });
  });

  it('a mix — no waitingKind from the server — keeps “Waiting for approval”', () => {
    expect(sessionLine({ ...parked, pendingApprovals: 2, waitingKind: null, ownerRequests: [request('DECISION')], taskMoves: moves(1) }, true))
      .toEqual({ text: 'Waiting for approval', tone: 'approval' });
  });

  it('a kind whose list an older server did not send keeps “Waiting for approval”', () => {
    expect(sessionLine({ ...parked, waitingKind: 'MOVE_REQUEST' }, true))
      .toEqual({ text: 'Waiting for approval', tone: 'approval' });
    expect(sessionLine({ ...parked, waitingKind: 'OWNER_REQUEST' }, true))
      .toEqual({ text: 'Waiting for approval', tone: 'approval' });
  });

  it('says nothing about it once nothing is waiting', () => {
    expect(sessionLine({ ...parked, pendingApprovals: 0, waitingKind: null, lastAssistantText: 'Done.' }, true))
      .toEqual({ text: 'Done.', tone: 'preview' });
  });
});
