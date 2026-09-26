import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseTaskProgress } from './taskProgress';
import {
  agentDetail,
  agentLane,
  agentNow,
  progressBadge,
  progressDuration,
  progressFooter,
  progressPhaseGroups,
  progressTrayLine,
  workflowTitle,
} from './taskProgressCopy';

// The same table OrbitKit's TaskProgressCopyParityTests reads: a word changed here without the
// Swift port (or the other way round) turns one of the two suites red.
const golden = JSON.parse(readFileSync(path.resolve(__dirname, 'taskProgressCopy.golden.json'), 'utf8'));

describe('taskProgressCopy — golden table', () => {
  for (const c of golden.cases) {
    it(c.name, () => {
      const p = parseTaskProgress(c.progress)!;
      expect(progressBadge(p)).toBe(c.badge);
      expect(progressTrayLine(p)).toBe(c.trayLine);
      expect(progressFooter(p)).toBe(c.footer);
      expect(
        progressPhaseGroups(p).map((g) => ({
          title: g.title,
          done: g.done,
          total: g.total,
          agents: g.agents.map((a) => ({ label: a.label, lane: agentLane(a), detail: agentDetail(a), now: agentNow(a) })),
        })),
      ).toEqual(c.groups);
    });
  }

  it('durations', () => {
    for (const [ms, text] of golden.durations) expect(progressDuration(ms)).toBe(text);
  });

  for (const t of golden.titles) {
    it(`workflow title: ${t.name}`, () => {
      const progress = t.progressDescription ? parseTaskProgress({ toolUseId: 'x', description: t.progressDescription }) : null;
      expect(workflowTitle(t.input, t.result, progress) ?? null).toBe(t.title);
    });
  }
});
