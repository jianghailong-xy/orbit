import { describe, expect, it } from 'vitest';
import {
  coordinatorWorkspaceRows,
  startCoordinatorAction,
  startCoordinatorParagraphs,
  startCoordinatorTitle,
} from './coordinatorWorkspace';

const providerName = (slug: string) => (slug === 'codex' ? 'Codex' : 'Claude');

describe('the Start a new coordinator in… picker', () => {
  it('greys the workspaces a new conversation cannot open in, and marks where it is now', () => {
    const rows = coordinatorWorkspaceRows(
      [
        { id: 'w1', name: 'orbit', enabled: true, runnerId: 'r1', runner: { displayName: 'workstation-gpu' }, lastProvider: 'claude' },
        { id: 'w2', name: 'wikova-develop', enabled: true, runnerId: 'r2', runner: { name: 'wikova' }, lastProvider: 'codex' },
        { id: 'w3', name: 'HPC', enabled: true, runnerId: null },
        { id: 'w4', name: 'mac-tools', enabled: false, runnerId: 'r1' },
      ],
      'w1',
      new Set(['r1']),
      providerName,
    );
    expect(rows.map((r) => [r.name, r.detail, r.reason, r.current, r.runnerOffline])).toEqual([
      ['orbit', 'Claude · workstation-gpu', null, true, false],
      ['wikova-develop', 'Codex · wikova', null, false, true],
      ['HPC', 'This workspace has no runner.', 'This workspace has no runner.', false, false],
      ['mac-tools', 'This workspace is disabled.', 'This workspace is disabled.', false, false],
    ]);
  });

  it('draws no offline pill before the runner list is read', () => {
    const [row] = coordinatorWorkspaceRows([{ id: 'w2', name: 'x', enabled: true, runnerId: 'r2' }], null, null, providerName);
    expect(row.runnerOffline).toBe(false);
  });
});

describe('its confirmation', () => {
  it('says where the old conversation stays and what moves with the new one', () => {
    expect(startCoordinatorTitle('orbit-prod')).toBe('Start a new coordinator in orbit-prod?');
    expect(startCoordinatorParagraphs({ project: 'Session list redesign', to: 'orbit-prod', from: 'orbit', outgoing: 'open' })).toEqual([
      'The current conversation is completed — a turn in flight finishes first — and stays readable in orbit.',
      "Session list redesign is coordinated from a new, empty conversation in orbit-prod, and its row moves to orbit-prod’s list. Its tasks keep running where they are.",
    ]);
    expect(startCoordinatorAction('orbit-prod', 'open')).toBe('Complete and start in orbit-prod');
  });

  it('has nothing to complete when the conversation is over or gone', () => {
    expect(startCoordinatorParagraphs({ project: 'P', to: 'b', from: 'a', outgoing: 'completed' })[0]).toBe(
      'The current conversation stays completed and readable in a.',
    );
    expect(startCoordinatorParagraphs({ project: 'P', to: 'b', from: null, outgoing: 'none' })).toHaveLength(1);
    expect(startCoordinatorAction('b', 'none')).toBe('Start in b');
  });
});
