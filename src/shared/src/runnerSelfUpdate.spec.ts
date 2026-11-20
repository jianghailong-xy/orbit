import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  RUNNER_SELF_UPDATE_PHASES,
  RUNNER_SELF_UPDATE_STATES,
  type RunnerSelfUpdate,
} from './dto';

// RunnerSelfUpdate as the Go runner writes it (runner-self-update.fixture.json, which
// src/runner-go/selfupdate_phase_test.go replays field for field): one case per Update card phase,
// and a runner too old to send a phase.
const fixture = JSON.parse(
  readFileSync(new URL('./runner-self-update.fixture.json', import.meta.url), 'utf8'),
) as { cases: Array<{ name: string; report: RunnerSelfUpdate }> };
const cases = new Map(fixture.cases.map((c) => [c.name, c.report]));

/** Every field of RunnerSelfUpdate: `satisfies` fails to compile if one is added without it. */
const FIELDS = {
  state: true,
  reason: true,
  installDir: true,
  lastUpdatedAt: true,
  lastUpdatedFrom: true,
  lastUpdatedTo: true,
  phase: true,
  targetVersion: true,
  availableSince: true,
  drainingSince: true,
  postponedUntil: true,
  turnsInFlight: true,
  turnsAtDrain: true,
  quietWindowSeconds: true,
} satisfies Record<keyof RunnerSelfUpdate, true>;

describe('RunnerSelfUpdate phases', () => {
  it('names the four phases of the design, in its order', () => {
    expect(RUNNER_SELF_UPDATE_PHASES).toEqual(['available', 'draining', 'restarting', 'postponed']);
  });

  it('has a fixture case for every phase and for an old runner', () => {
    expect([...cases.keys()].sort()).toEqual([...RUNNER_SELF_UPDATE_PHASES, 'oldRunner'].sort());
    for (const phase of RUNNER_SELF_UPDATE_PHASES) expect(cases.get(phase)?.phase).toBe(phase);
  });

  it('sends only fields the dto declares, with a known state', () => {
    for (const [name, report] of cases) {
      expect(RUNNER_SELF_UPDATE_STATES, name).toContain(report.state);
      for (const key of Object.keys(report)) expect(Object.keys(FIELDS), `${name}.${key}`).toContain(key);
    }
  });

  it('carries the version and times each phase draws', () => {
    for (const phase of RUNNER_SELF_UPDATE_PHASES) {
      const report = cases.get(phase)!;
      expect(report.targetVersion, phase).toMatch(/^\d+\.\d+\.\d+$/);
      for (const at of [report.availableSince, report.drainingSince, report.postponedUntil]) {
        if (at !== undefined) expect(Number.isNaN(Date.parse(at)), `${phase}: ${at}`).toBe(false);
      }
    }
    const draining = cases.get('draining')!;
    expect(draining.drainingSince).toBeDefined();
    expect(draining.turnsInFlight).toBeLessThanOrEqual(draining.turnsAtDrain!);
    expect(cases.get('postponed')!.postponedUntil).toBeDefined();
  });

  it('a runner that reports a phase also reports its quiet window, in whole seconds', () => {
    for (const phase of RUNNER_SELF_UPDATE_PHASES) {
      expect(cases.get(phase)!.quietWindowSeconds, phase).toBe(600);
    }
  });

  it('an old runner sends a state and none of the phase fields', () => {
    const old = cases.get('oldRunner')!;
    expect(old).toEqual({ state: 'waitingForIdle' });
    expect(old.phase).toBeUndefined();
    expect(old.quietWindowSeconds).toBeUndefined();
  });
});
