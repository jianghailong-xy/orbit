import { describe, expect, it } from 'vitest';
import { BG_JOB_LIMITS_CAPABILITY, BG_JOB_LIMITS_UNAVAILABLE_CAPABILITY_PREFIX, bgJobLimitSupportOf } from './dto';

describe('bgJobLimitSupportOf', () => {
  it('reads no declaration as an old runner', () => {
    expect(bgJobLimitSupportOf(undefined)).toEqual({ state: 'old' });
    expect(bgJobLimitSupportOf(null)).toEqual({ state: 'old' });
    expect(bgJobLimitSupportOf(['machine-resources/v1'])).toEqual({ state: 'old' });
  });

  it('reads the capability as available', () => {
    expect(bgJobLimitSupportOf(['x', BG_JOB_LIMITS_CAPABILITY])).toEqual({ state: 'available' });
  });

  it('reads each reason code, and an unknown one as unknown', () => {
    for (const reason of ['os', 'cgroup', 'delegate', 'controllers'] as const) {
      expect(bgJobLimitSupportOf([`${BG_JOB_LIMITS_UNAVAILABLE_CAPABILITY_PREFIX}${reason}`])).toEqual({ state: 'unavailable', reason });
    }
    expect(bgJobLimitSupportOf([`${BG_JOB_LIMITS_UNAVAILABLE_CAPABILITY_PREFIX}future`])).toEqual({ state: 'unavailable', reason: 'unknown' });
    expect(bgJobLimitSupportOf([BG_JOB_LIMITS_UNAVAILABLE_CAPABILITY_PREFIX])).toEqual({ state: 'unavailable', reason: 'unknown' });
  });

  it('keeps the strings lowercase and within the server\'s 120-character capability rule', () => {
    for (const c of [BG_JOB_LIMITS_CAPABILITY, `${BG_JOB_LIMITS_UNAVAILABLE_CAPABILITY_PREFIX}controllers`]) {
      expect(c).toBe(c.toLowerCase());
      expect(c.length).toBeLessThanOrEqual(120);
    }
  });
});
