import { describe, expect, it } from 'vitest';
import { isSteerKind, steerDeliveryState, supersedesLiveDrafts } from './steerDelivery';

describe('steer delivery states', () => {
  it('names every stage the runner reports', () => {
    // The window between "the control plane took it" and "the runner has it" reads the same as
    // the runner's own acceptance: both are a promise that it will be offered to the engine.
    expect(steerDeliveryState(undefined).label).toBe('Sending…');
    expect(steerDeliveryState('enqueued').label).toBe('Sending…');
    expect(steerDeliveryState('written').label).toBe('Delivering…');
    expect(steerDeliveryState('acknowledged').label).toBe('Sent into this turn');
    expect(steerDeliveryState('failed').label).toBe('Not delivered');
  });

  it('separates on-its-way from arrived from lost', () => {
    // The tone is what the bubble colours itself by, so the three outcomes must not collapse:
    // a steer still in flight must never read as delivered, and a lost one never as either.
    expect(steerDeliveryState('written').tone).toBe('progress');
    expect(steerDeliveryState('acknowledged').tone).toBe('delivered');
    expect(steerDeliveryState('failed').tone).toBe('failed');
  });

  it('treats an unknown state as still on its way, never as delivered', () => {
    // A newer runner may report a stage this client has never heard of. Guessing "arrived" for
    // it would claim the engine has a message that may still be sitting in a queue.
    expect(steerDeliveryState('teleported').tone).toBe('progress');
    expect(steerDeliveryState(null).tone).toBe('progress');
  });

  it('recognises only the kind the server files a mid-turn message as', () => {
    expect(isSteerKind('steer')).toBe(true);
    expect(isSteerKind('message')).toBe(false);
    expect(isSteerKind('shell')).toBe(false);
    // An older server omits the kind entirely; that is the pre-steer behaviour (queued), and
    // reading it as a steer would drop the Cancel from a message that really is withdrawable.
    expect(isSteerKind(undefined)).toBe(false);
  });
});

describe('what clears the live streaming drafts', () => {
  it('keeps clearing on every boundary it always did', () => {
    // The regression guard: a draft that outlives its turn is rendered twice, once as animation
    // and once as the durable text that replaced it.
    for (const type of ['assistant', 'turn_end', 'user', 'interrupt', 'error']) {
      expect(supersedesLiveDrafts({ type })).toBe(true);
    }
    expect(supersedesLiveDrafts({ type: 'text_delta' })).toBe(false);
    expect(supersedesLiveDrafts({ type: 'system' })).toBe(false);
  });

  it('does not treat a steer as the end of the reply it landed in', () => {
    // A steer arrives mid-reply by definition. Clearing here would blank text that has no
    // authoritative `assistant` event yet — it would simply be gone until the block finished.
    expect(supersedesLiveDrafts({ type: 'user', payload: { steer: true } })).toBe(false);
    // An ordinary message still opens a turn, so it still supersedes.
    expect(supersedesLiveDrafts({ type: 'user', payload: { steer: false } })).toBe(true);
    expect(supersedesLiveDrafts({ type: 'user', payload: {} })).toBe(true);
  });
});
