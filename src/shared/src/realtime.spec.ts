import { describe, expect, it } from 'vitest';
import { isLifecycleType, RunEventType } from './enums';
import { ControlEventType } from './realtime';

describe('control-plane protocol', () => {
  it('lifecycle signals are exactly session_created/session_ended — transcript types are not', () => {
    expect(isLifecycleType(RunEventType.SESSION_CREATED)).toBe(true);
    expect(isLifecycleType(RunEventType.SESSION_ENDED)).toBe(true);
    for (const t of [
      RunEventType.STATUS,
      RunEventType.TEXT_DELTA,
      RunEventType.TURN_END,
      RunEventType.APPROVAL_REQUEST,
      RunEventType.BACKGROUND_TASK,
    ]) {
      expect(isLifecycleType(t)).toBe(false);
    }
  });

  it('control event types are disjoint from RunEventType values (own namespace)', () => {
    const control = Object.values(ControlEventType) as string[];
    const run = Object.values(RunEventType) as string[];
    for (const c of control) {
      expect(run).not.toContain(c);
    }
  });
});
