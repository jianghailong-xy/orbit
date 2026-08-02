import { describe, expect, it } from 'vitest';
import {
  firstOpenableAgent,
  groupAgentsByRunner,
  orderAgentGroupsByRunners,
} from './agentOrder';

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

describe('orderAgentGroupsByRunners', () => {
  it('matches persisted runner order while keeping Shared last', () => {
    const groups = groupAgentsByRunner([
      a('workstation-agent', 'workstation'),
      a('shared-agent', null),
      a('wikova-agent', 'wikova'),
      a('macbook-agent', 'macbook'),
    ]);

    expect(
      orderAgentGroupsByRunners(groups, [
        { id: 'wikova' },
        { id: 'macbook' },
        { id: 'workstation' },
      ]).map((group) => group.runnerId),
    ).toEqual(['wikova', 'macbook', 'workstation', null]);
  });

  it('keeps unknown runner groups stable after known runners', () => {
    const groups = groupAgentsByRunner([
      a('stale-a', 'stale-a'),
      a('second', 'second'),
      a('stale-b', 'stale-b'),
      a('first', 'first'),
    ]);

    expect(
      orderAgentGroupsByRunners(groups, [{ id: 'first' }, { id: 'second' }]).map(
        (group) => group.runnerId,
      ),
    ).toEqual(['first', 'second', 'stale-a', 'stale-b']);
  });

  it('uses runner order for the default openable agent', () => {
    const agents = [a('workstation-agent', 'workstation'), a('wikova-agent', 'wikova')];

    expect(firstOpenableAgent(agents, [{ id: 'wikova' }, { id: 'workstation' }])?.id).toBe(
      'wikova-agent',
    );
  });
});
