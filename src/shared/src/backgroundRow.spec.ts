import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BACKGROUND_ROW_A11Y_PREFIX,
  BACKGROUND_ROW_LABEL,
  BACKGROUND_ROW_ROTATE_CHANGE_MS,
  BACKGROUND_ROW_ROTATE_PER_NAME_MS,
  backgroundRow,
  backgroundRowClearedAt,
  type BackgroundRow,
  type BackgroundRowInput,
} from './index';

interface RowCase {
  case: string;
  covers: string[];
  list: BackgroundRowInput[];
  lastUserMessageAt: string | null;
  sessionLive: boolean;
  lastAgentTurnStartedAt?: string | null;
  expect: BackgroundRow;
}

const fixture = JSON.parse(readFileSync(path.join(__dirname, 'background-row.fixture.json'), 'utf8')) as {
  rules: Record<string, string>;
  rotation: { perNameMs: number; changeMs: number };
  cases: RowCase[];
};

describe('background-row.fixture.json', () => {
  it.each(fixture.cases.map((c) => [c.case, c] as const))('%s', (_name, c) => {
    expect(backgroundRow(c.list, backgroundRowClearedAt(c.lastUserMessageAt, c.lastAgentTurnStartedAt ?? null), c.sessionLive)).toEqual(c.expect);
  });

  it('has at least one case for every rule, and tags only known rules', () => {
    const covered = new Set(fixture.cases.flatMap((c) => c.covers));
    for (const rule of Object.keys(fixture.rules)) expect(covered.has(rule), rule).toBe(true);
    for (const tag of covered) expect(Object.keys(fixture.rules), tag).toContain(tag);
  });

  it('states the constants the function uses', () => {
    expect(fixture.rotation).toEqual({
      perNameMs: BACKGROUND_ROW_ROTATE_PER_NAME_MS,
      changeMs: BACKGROUND_ROW_ROTATE_CHANGE_MS,
    });
    expect(BACKGROUND_ROW_ROTATE_PER_NAME_MS).toBe(3000);
    expect(BACKGROUND_ROW_ROTATE_CHANGE_MS).toBe(300);
    for (const c of fixture.cases) {
      if (c.expect.hidden) continue;
      expect(c.expect.label).toBe(BACKGROUND_ROW_LABEL);
      expect(c.expect.accessibilityLabel.startsWith(BACKGROUND_ROW_A11Y_PREFIX), c.case).toBe(true);
    }
  });

  it('a wake case ends after the last user message and before the agent turn that clears it', () => {
    const wakes = fixture.cases.filter((c) => c.covers.includes('wakeTurnClears'));
    expect(wakes.length).toBeGreaterThan(0);
    for (const c of wakes) {
      const ends = c.list.map((s) => Date.parse(s.endedAt ?? ''));
      expect(ends.every((e) => e > Date.parse(c.lastUserMessageAt!) && e < Date.parse(c.lastAgentTurnStartedAt!))).toBe(true);
      expect(c.expect.hidden).toBe(true);
    }
  });

  it('the cut-off is the later of the two', () => {
    expect(backgroundRowClearedAt(null, null)).toBeNull();
    expect(backgroundRowClearedAt('2026-11-16T02:40:00.000Z', null)).toBe('2026-11-16T02:40:00.000Z');
    expect(backgroundRowClearedAt(null, '2026-11-16T02:41:00.000Z')).toBe('2026-11-16T02:41:00.000Z');
    expect(backgroundRowClearedAt('2026-11-16T02:42:00.000Z', '2026-11-16T02:41:00.000Z')).toBe('2026-11-16T02:42:00.000Z');
  });
});
