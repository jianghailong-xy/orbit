import { describe, expect, it } from 'vitest';
import { firstOpenableWorkspace, orderWorkspaces, reorderedWorkspaceIds } from './workspaceOrder';

const a = (id: string, runnerId: string | null, position: number | null = null, createdAt = '2024-01-01') => ({
  id,
  runnerId,
  position,
  createdAt,
});

describe('orderWorkspaces', () => {
  it('follows position across runners, then places the never-placed oldest-first', () => {
    const ordered = orderWorkspaces([
      a('late', 'r1', null, '2024-03-01'),
      a('hpc', 'r2', 1),
      a('wikova', 'r1', 0),
      a('early', 'r2', null, '2024-02-01'),
      a('workstation', 'r3', 2),
    ]);
    expect(ordered.map((x) => x.id)).toEqual(['wikova', 'hpc', 'workstation', 'early', 'late']);
  });

  it('keeps a workspace with no runner below every openable one, whatever its position', () => {
    const ordered = orderWorkspaces([a('shared', null, 0), a('one', 'r1', 1), a('two', 'r2', null)]);
    expect(ordered.map((x) => x.id)).toEqual(['one', 'two', 'shared']);
  });

  it('reads the nested runner shape too', () => {
    const ordered = orderWorkspaces([
      { id: 'flat-none', createdAt: '2024-01-01', position: 0 },
      { id: 'nested', createdAt: '2024-01-01', position: 1, runner: { id: 'r9' } },
    ]);
    expect(ordered.map((x) => x.id)).toEqual(['nested', 'flat-none']);
  });
});

describe('reorderedWorkspaceIds', () => {
  const list = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];

  it('moves the dragged row into the slot it was dropped on, either way', () => {
    expect(reorderedWorkspaceIds(list, 'd', 'b')).toEqual(['a', 'd', 'b', 'c']);
    expect(reorderedWorkspaceIds(list, 'a', 'c')).toEqual(['b', 'c', 'a', 'd']);
  });

  it('has nothing to send when the drop moves nothing', () => {
    expect(reorderedWorkspaceIds(list, 'b', 'b')).toBeNull();
    expect(reorderedWorkspaceIds(list, 'gone', 'b')).toBeNull();
    expect(reorderedWorkspaceIds(list, 'b', 'gone')).toBeNull();
  });
});

describe('firstOpenableWorkspace', () => {
  it('lands on the first workspace in the arranged order that has a runner', () => {
    const workspaces = [a('workstation', 'workstation', 1), a('shared', null, 0), a('wikova', 'wikova', 2)];
    expect(firstOpenableWorkspace(workspaces)?.id).toBe('workstation');
  });
});
