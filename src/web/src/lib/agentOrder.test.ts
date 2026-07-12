import { describe, expect, it } from 'vitest';
import { groupAgentsByRunner } from './agentOrder';

const a = (id: string, runnerId: string | null) => ({ id, runnerId, createdAt: '2024-01-01' });

describe('groupAgentsByRunner', () => {
  it('groups by first-seen runner order, keeps within-group order, sinks host to the bottom', () => {
    const groups = groupAgentsByRunner([a('1', 'r1'), a('2', 'r2'), a('3', 'r1'), a('4', null)]);
    expect(groups.map((g) => g.runnerId)).toEqual(['r1', 'r2', null]);
    expect(groups[0].agents.map((x) => x.id)).toEqual(['1', '3']);
    expect(groups[2].agents.map((x) => x.id)).toEqual(['4']);
  });

  it('omits the Shared group when every agent has a runner', () => {
    const groups = groupAgentsByRunner([a('1', 'r1'), a('2', 'r1')]);
    expect(groups).toHaveLength(1);
    expect(groups[0].runnerId).toBe('r1');
  });

  it('reads the nested runner shape too', () => {
    const groups = groupAgentsByRunner([{ id: '1', createdAt: '2024-01-01', runner: { id: 'r9' } }]);
    expect(groups[0].runnerId).toBe('r9');
  });
});
