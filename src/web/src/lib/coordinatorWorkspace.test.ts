import { describe, expect, it } from 'vitest';
import type { SessionMoveTarget, SessionMoveTargets } from '@orbit/shared';
import {
  changeMoveParagraphs,
  changeNewAction,
  changeNewParagraphs,
  changeRowsFromTargets,
  changeRowsFromWorkspaces,
  changeTitle,
} from './coordinatorWorkspace';

const providerName = (slug: string) => (slug === 'codex' ? 'Codex' : 'Claude');

const target = (over: Partial<SessionMoveTarget>): SessionMoveTarget => ({
  workspaceId: 'w2', name: 'orbit-prod', provider: 'claude', runnerId: 'r1', runnerName: 'workstation-gpu',
  runnerOnline: true, workDir: '/srv/prod', reason: null, conversation: 'continues', folders: [], startsCoordinator: true,
  ...over,
});
const answer = (over: Partial<SessionMoveTargets>): SessionMoveTargets => ({
  workspaceId: 'w1', folderId: null, folders: [], reason: null, needsEnd: false, branch: null, changedFiles: 0,
  unmergedFiles: 0, mergeTarget: null, coordinates: { projectId: 'p1', title: 'Website Revamp' }, targets: [], ...over,
});

describe('Change: the rows for a coordinator conversation that exists', () => {
  it('says per workspace whether the conversation comes along, a new one opens, or nothing can', () => {
    const rows = changeRowsFromTargets(
      answer({
        targets: [
          target({}),
          target({ workspaceId: 'w3', name: 'wikova-develop', provider: 'codex', runnerName: 'wikova', runnerOnline: false,
            reason: 'Codex keeps this conversation on workstation-gpu' }),
          target({ workspaceId: 'w4', name: 'HPC', runnerId: null, runnerName: null, reason: 'This workspace has no runner.', startsCoordinator: false }),
        ],
      }),
      { id: 'w1', name: 'orbit' },
      providerName,
    );
    expect(rows.map((r) => [r.name, r.detail, r.way, r.reason, r.current, r.runnerOffline])).toEqual([
      ['orbit', 'Current', null, null, true, false],
      ['orbit-prod', 'Claude · workstation-gpu', 'move', null, false, false],
      ['wikova-develop', 'Codex · wikova', 'new', 'Codex keeps this conversation on workstation-gpu', false, true],
      ['HPC', 'This workspace has no runner.', null, 'This workspace has no runner.', false, false],
    ]);
  });

  it('offers only new starts while the session itself cannot move, and says why', () => {
    const [, row] = changeRowsFromTargets(answer({ reason: 'Stop the session first.', targets: [target({})] }), { id: 'w1', name: 'orbit' }, providerName);
    expect([row.way, row.reason]).toEqual(['new', 'Stop the session first.']);
  });
});

describe('Change: the rows when there is no conversation to bring', () => {
  it('puts the current workspace first and greys what cannot take a new one', () => {
    const rows = changeRowsFromWorkspaces(
      [
        { id: 'w2', name: 'orbit-prod', enabled: true, runnerId: 'r1', runner: { displayName: 'workstation-gpu' }, lastProvider: 'claude' },
        { id: 'w1', name: 'orbit', enabled: true, runnerId: 'r1' },
        { id: 'w3', name: 'HPC', enabled: true, runnerId: null },
        { id: 'w4', name: 'mac-tools', enabled: false, runnerId: 'r1' },
        { id: 'w5', name: 'wikova', enabled: true, runnerId: 'r2', lastProvider: 'codex' },
      ],
      'w1',
      new Set(['r1']),
      providerName,
    );
    expect(rows.map((r) => [r.name, r.way, r.detail, r.runnerOffline])).toEqual([
      ['orbit', null, 'Current', false],
      ['orbit-prod', 'new', 'Claude · workstation-gpu', false],
      ['HPC', null, 'This workspace has no runner.', false],
      ['mac-tools', null, 'This workspace is disabled.', false],
      ['wikova', 'new', 'Codex', true],
    ]);
  });
});

describe('Change: the confirmations', () => {
  it('offers both ways where the conversation comes along', () => {
    expect(changeTitle('Website Revamp', 'orbit-prod')).toBe('Coordinate Website Revamp from orbit-prod?');
    expect(changeMoveParagraphs({
      to: 'orbit-prod', from: 'orbit', needsEnd: true,
      files: '3 changed files aren’t merged into main yet. They stay on branch b in orbit.',
    })).toEqual([
      'Move conversation: this conversation goes to orbit-prod and continues there. It ends first. 3 changed files aren’t merged into main yet. They stay on branch b in orbit.',
      'Start a new one there: this conversation is completed and stays readable in orbit, and a new, empty one opens in orbit-prod.',
      'Either way, its tasks keep running where they are.',
    ]);
  });

  it('starts with why when only a new one can open there', () => {
    expect(changeNewParagraphs({ to: 'wikova', from: 'orbit', outgoing: 'open', reason: 'Codex keeps this conversation on workstation-gpu' })).toEqual([
      'This conversation can’t come along: Codex keeps this conversation on workstation-gpu.',
      'It is completed — a turn in flight finishes first — and stays readable in orbit. A new, empty one opens in wikova.',
      'Its tasks keep running where they are.',
    ]);
    expect(changeNewAction('wikova', 'open')).toBe('Complete and start in wikova');
  });

  it('has nothing to complete or explain when the conversation is over or gone', () => {
    expect(changeNewParagraphs({ to: 'b', from: 'a', outgoing: 'completed', reason: null })[0]).toBe(
      'It stays completed and readable in a. A new, empty one opens in b.',
    );
    expect(changeNewParagraphs({ to: 'b', from: null, outgoing: 'none', reason: 'x' })).toEqual([
      'A new, empty one opens in b.',
      'Its tasks keep running where they are.',
    ]);
    expect(changeNewAction('b', 'none')).toBe('Start in b');
  });
});
