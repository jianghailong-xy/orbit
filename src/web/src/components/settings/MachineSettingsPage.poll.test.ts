/**
 * The machine page re-reads the runners every 4 s while an engine install or an account removal on
 * that machine is in flight, and every 15 s otherwise.
 */
import { describe, expect, it } from 'vitest';
import type { Runner } from '../TasksSidePanel';
import { machinePagePollMs } from './MachineSettingsPage';

const ID = 'r1';
const runner = (extra: Partial<Runner>): Runner => ({ id: ID, name: 'mac', online: true, ...extra }) as Runner;

describe('machinePagePollMs', () => {
  it('is 15 s with nothing in flight', () => {
    expect(machinePagePollMs([runner({})], ID)).toBe(15_000);
    expect(machinePagePollMs(undefined, ID)).toBe(15_000);
  });

  it('is 4 s while an engine installs, and back to 15 s once the update is done', () => {
    expect(machinePagePollMs([runner({ install: { status: 'installing' } } as Partial<Runner>)], ID)).toBe(4_000);
    expect(machinePagePollMs([runner({ install: { status: 'done', mode: 'update' } } as Partial<Runner>)], ID)).toBe(15_000);
  });

  it('is 4 s while an account removal is pending', () => {
    expect(machinePagePollMs([runner({ accountRemove: { status: 'pending' } } as Partial<Runner>)], ID)).toBe(4_000);
  });

  it('counts only this machine', () => {
    const other = { ...runner({ install: { status: 'installing' } } as Partial<Runner>), id: 'r2' };
    expect(machinePagePollMs([runner({}), other], ID)).toBe(15_000);
  });
});
