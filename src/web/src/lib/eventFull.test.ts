import { describe, expect, it, vi } from 'vitest';
import { memoizeEventFull } from './eventFull';
import type { EventPageEvent } from '../api';

const event = (seq: number) => ({ seq, payload: { seq } }) as unknown as EventPageEvent;

describe('memoized untrimmed payloads', () => {
  // The measured defect: one phone pulled the same two 400KB screenshots eight times in fifteen
  // seconds while its reader scrolled, because each recycled row asked again.
  it('asks the server once per seq, however many times a card comes back for it', async () => {
    const fetchOne = vi.fn((seq: number) => Promise.resolve(event(seq)));
    const fetchFull = memoizeEventFull(fetchOne);

    const [first, afterRemount] = await Promise.all([fetchFull(101918), fetchFull(101918)]);

    expect(afterRemount).toBe(first);
    expect(fetchOne).toHaveBeenCalledTimes(1);
  });

  it('keeps one seq out of another’s answer', async () => {
    const fetchOne = vi.fn((seq: number) => Promise.resolve(event(seq)));
    const fetchFull = memoizeEventFull(fetchOne);

    expect((await fetchFull(99323)).seq).toBe(99323);
    expect((await fetchFull(101918)).seq).toBe(101918);
    expect(fetchOne).toHaveBeenCalledTimes(2);
  });

  // A cached failure would be permanent: the card has nothing else to render from, and the reader
  // has no way to ask for the picture again.
  it('does not remember a failure as the answer', async () => {
    let calls = 0;
    const fetchOne = vi.fn(() => {
      calls += 1;
      return calls === 1 ? Promise.reject(new Error('offline')) : Promise.resolve(event(7));
    });
    const fetchFull = memoizeEventFull(fetchOne);

    await expect(fetchFull(7)).rejects.toThrow('offline');
    expect((await fetchFull(7)).seq).toBe(7);
    expect(fetchOne).toHaveBeenCalledTimes(2);
  });
});
