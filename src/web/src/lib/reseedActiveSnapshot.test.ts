import { describe, expect, it, vi } from 'vitest';
import { reseedWithActiveSnapshot } from './reseedActiveSnapshot';
import { reconcileQueuedTurnSnapshot } from './acceptedUserTurn';

describe('reseedWithActiveSnapshot', () => {
  it('refreshes durable active receipts after a successful in-place reseed', async () => {
    const refresh = vi.fn();
    await expect(reseedWithActiveSnapshot(async () => 'tail', refresh)).resolves.toBe('tail');
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('refreshes durable active receipts after a failed in-place reseed', async () => {
    const refresh = vi.fn();
    await expect(
      reseedWithActiveSnapshot(async () => { throw new Error('offline'); }, refresh),
    ).rejects.toThrow('offline');
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('successful resync replaces an optimistic startup bubble with its durable failure', async () => {
    const optimistic = {
      turnId: 'startup-own-id',
      targetTurnId: 'opening-target-id',
      placement: 'startup' as const,
    };
    const failed = { ...optimistic, delivery: 'failed' as const };
    let rows = [optimistic];

    await reseedWithActiveSnapshot(async () => 'new tail', () => {
      rows = reconcileQueuedTurnSnapshot([failed], rows, new Set([optimistic.turnId]));
    });

    expect(rows).toEqual([failed]);
  });

  it('failed tail resync still prunes a startup receipt that landed while disconnected', async () => {
    const optimistic = {
      turnId: 'startup-own-id',
      targetTurnId: 'opening-target-id',
      placement: 'startup' as const,
    };
    let rows = [optimistic];

    await expect(reseedWithActiveSnapshot(async () => {
      throw new Error('tail unavailable');
    }, () => {
      rows = reconcileQueuedTurnSnapshot([], rows, new Set([optimistic.turnId]));
    })).rejects.toThrow('tail unavailable');

    expect(rows).toEqual([]);
  });
});
