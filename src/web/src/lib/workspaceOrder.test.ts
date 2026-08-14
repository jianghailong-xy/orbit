import { describe, expect, it } from 'vitest';
import {
  firstOpenableWorkspace,
  groupWorkspacesByRunner,
  orderWorkspaceGroupsByRunners,
} from './workspaceOrder';

const a = (id: string, runnerId: string | null) => ({ id, runnerId, createdAt: '2024-01-01' });

describe('groupWorkspacesByRunner', () => {
  it('groups by first-seen runner order, keeps within-group order, sinks host to the bottom', () => {
    const groups = groupWorkspacesByRunner([a('1', 'r1'), a('2', 'r2'), a('3', 'r1'), a('4', null)]);
    expect(groups.map((g) => g.runnerId)).toEqual(['r1', 'r2', null]);
    expect(groups[0].workspaces.map((x) => x.id)).toEqual(['1', '3']);
    expect(groups[2].workspaces.map((x) => x.id)).toEqual(['4']);
  });

  it('omits the Shared group when every workspace has a runner', () => {
    const groups = groupWorkspacesByRunner([a('1', 'r1'), a('2', 'r1')]);
    expect(groups).toHaveLength(1);
    expect(groups[0].runnerId).toBe('r1');
  });

  it('reads the nested runner shape too', () => {
    const groups = groupWorkspacesByRunner([{ id: '1', createdAt: '2024-01-01', runner: { id: 'r9' } }]);
    expect(groups[0].runnerId).toBe('r9');
  });
});

describe('orderWorkspaceGroupsByRunners', () => {
  it('matches persisted runner order while keeping Shared last', () => {
    const groups = groupWorkspacesByRunner([
      a('workstation-workspace', 'workstation'),
      a('shared-workspace', null),
      a('wikova-workspace', 'wikova'),
      a('macbook-workspace', 'macbook'),
    ]);

    expect(
      orderWorkspaceGroupsByRunners(groups, [
        { id: 'wikova' },
        { id: 'macbook' },
        { id: 'workstation' },
      ]).map((group) => group.runnerId),
    ).toEqual(['wikova', 'macbook', 'workstation', null]);
  });

  it('keeps unknown runner groups stable after known runners', () => {
    const groups = groupWorkspacesByRunner([
      a('stale-a', 'stale-a'),
      a('second', 'second'),
      a('stale-b', 'stale-b'),
      a('first', 'first'),
    ]);

    expect(
      orderWorkspaceGroupsByRunners(groups, [{ id: 'first' }, { id: 'second' }]).map(
        (group) => group.runnerId,
      ),
    ).toEqual(['first', 'second', 'stale-a', 'stale-b']);
  });

  it('uses runner order for the default openable workspace', () => {
    const workspaces = [a('workstation-workspace', 'workstation'), a('wikova-workspace', 'wikova')];

    expect(firstOpenableWorkspace(workspaces, [{ id: 'wikova' }, { id: 'workstation' }])?.id).toBe(
      'wikova-workspace',
    );
  });
});
