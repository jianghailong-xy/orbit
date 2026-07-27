import { describe, expect, it } from 'vitest';
import { isLifecycleType, RunEventType } from './enums';
import { ControlEventType } from './realtime';

describe('control-plane protocol', () => {
  it('every synthesized control signal is a lifecycle type — transcript types are not', () => {
    for (const t of [
      RunEventType.SESSION_CREATED,
      RunEventType.SESSION_ENDED,
      RunEventType.SESSION_UPDATED,
      RunEventType.TASK_CHANGED,
      RunEventType.AGENT_CHANGED,
      RunEventType.TASK_LIST_CHANGED,
      RunEventType.TAG_CHANGED,
      RunEventType.PROVIDER_CHANGED,
    ]) {
      expect(isLifecycleType(t)).toBe(true);
    }
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
