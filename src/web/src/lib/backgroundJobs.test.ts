import { describe, expect, it } from 'vitest';
import { parseBackgroundJobs, summarizeBackgroundJobs } from './backgroundJobs';
import {
  EN_ENDED,
  EN_RUNNING_AND_ENDED,
  ZH_ENDED,
  ZH_KILLED,
  ZH_MONITOR,
  ZH_MULTILINE_COMMAND,
  ZH_NO_END,
  ZH_RUNNING_AND_ENDED,
} from './backgroundJobs.fixtures';

/**
 * Reading the inventory block a returning engine is handed.
 *
 * Held to the wording the apiserver writes today (runner-api/background-jobs-context.ts
 * `buildBackgroundJobsBlock`) AND to the one that shipped until 2026-09-15, which most of the blocks
 * already in the record still carry — recognising only the new one would have sent every older
 * transcript back to a wall of `｜` on the day it shipped. Every fixture is copied out of this
 * deployment's own `run_event` rows (backgroundJobs.fixtures.ts).
 */
describe('parseBackgroundJobs', () => {
  it('reads one ended job in the wording written today', () => {
    const jobs = parseBackgroundJobs(EN_ENDED);

    expect(jobs?.running).toEqual([]);
    expect(jobs?.ended).toEqual([
      {
        id: 'bgj_41314cd48e66',
        kind: 'job',
        command:
          'cd src/macos/OrbitKit && swift test && cd ../OrbitApp/Sources/OrbitApp && for f in *.swift Views/*.swift Views/Console/*.swift; do swift -frontend -parse "$f" >/dev/null || exit 1; done; echo "ACCEPTANCE_EXIT=$?"',
        status: 'completed',
        exitCode: 0,
        reason: null,
        outputPath:
          '/root/.orbit/runs/6add2dbe-be98-5ea7-a619-4b729c74e82f/bgj_41314cd48e66.output',
      },
    ]);
  });

  it('reads the same fields out of the older wording', () => {
    const jobs = parseBackgroundJobs(ZH_ENDED);

    expect(jobs?.ended).toEqual([
      {
        id: 'bgj_0f012a1b9d50',
        kind: 'job',
        command: '/root/orbit/.claude/skills/upgrade/upgrade.sh 2>&1',
        status: 'completed',
        exitCode: 0,
        reason: null,
        outputPath:
          '/root/.orbit/runs/01a066d7-5db3-763e-a3c4-0291a933ee0b/bgj_0f012a1b9d50.output',
      },
    ]);
  });

  it('keeps a kill reason as the runner recorded it, untranslated', () => {
    const [job] = parseBackgroundJobs(ZH_KILLED)?.ended ?? [];

    expect(job.status).toBe('killed');
    expect(job.reason).toBe('drain_cap');
    expect(job.exitCode).toBeNull();
  });

  it('reads a job whose runner died without reporting an end as stopped, with no exit code', () => {
    const [job] = parseBackgroundJobs(ZH_NO_END)?.ended ?? [];

    expect(job.command).toBe('/usr/bin/python3 /root/gpu-ladder.py');
    expect(job.status).toBe('stopped');
    expect(job.exitCode).toBeNull();
    // The outcome's own two words, not the sentence of gloss the block appends to them.
    expect(job.reason).toBe('没有结束报告');
    expect(job.outputPath).toBe(
      '/root/.orbit/runs/01a0a34b-e497-762e-9742-1db4f1a0b7b0/bgj_9056fe0308d8.output',
    );
  });

  it('tells the two sections apart', () => {
    const today = parseBackgroundJobs(EN_RUNNING_AND_ENDED);
    const older = parseBackgroundJobs(ZH_RUNNING_AND_ENDED);

    expect(today?.running.map((job) => job.id)).toEqual(['bgj_b6ac1419950c']);
    expect(today?.ended.map((job) => job.id)).toEqual(['bgj_e95780ddaf25']);
    // A running job has no outcome to report, and must not borrow the ended one's.
    expect(today?.running[0].status).toBe('');
    expect(today?.running[0].exitCode).toBeNull();
    expect(older?.running.map((job) => job.id)).toEqual(['bgj_06e2cae99078']);
    expect(older?.ended.map((job) => job.id)).toEqual(['bgj_6dff87bf9125']);
  });

  it('keeps a command that runs to several lines whole', () => {
    const jobs = parseBackgroundJobs(ZH_MULTILINE_COMMAND);

    expect(jobs?.running.map((job) => job.id)).toEqual([
      'bgj_e5753c1a7d36',
      'bgj_5beaf98d55a4',
      'bgj_dd920b03adc6',
    ]);
    // Six lines of shell, ending on the line that reports the exit code — not cut at the first
    // newline, and not swallowing the job listed after it.
    expect(jobs?.running[1].command).toContain('\nBGPID=$!\n');
    expect(jobs?.running[1].command.endsWith('echo "EXIT=$?"')).toBe(true);
    expect(jobs?.running[2].command.startsWith('chmod +x')).toBe(true);
  });

  it('leaves the Monitor section to the verbatim fold', () => {
    const jobs = parseBackgroundJobs(ZH_MONITOR);

    // The Monitor line is `｜`-separated like a job's and sits at the same indent; reading it as one
    // would put a row nobody can act on between two that matter.
    expect(jobs?.ended.map((job) => job.id)).toEqual(['bgj_76417c73491e']);
    expect(jobs?.running).toEqual([]);
    expect(jobs?.text).toContain('Monitor｜tool_use toolu_014ZNoYjEsHpmEucpLSzBGzT');
  });

  it('hands back the block verbatim, and whatever else the note carried', () => {
    const note = `<referenced-task>\n  34QGTYmD6gkY7BqjTXk1c\n</referenced-task>\n\n${ZH_ENDED}`;

    const jobs = parseBackgroundJobs(note);

    expect(jobs?.text).toBe(ZH_ENDED);
    expect(jobs?.rest).toBe('<referenced-task>\n  34QGTYmD6gkY7BqjTXk1c\n</referenced-task>');
  });

  it('is nothing at all for a note with no block, or a block with no jobs', () => {
    expect(parseBackgroundJobs(null)).toBeNull();
    expect(parseBackgroundJobs('<referenced-task>\n  34QG\n</referenced-task>')).toBeNull();
    expect(
      parseBackgroundJobs(
        '<background-jobs>\n  这是控制面替你记下的，不是用户说的。\n</background-jobs>',
      ),
    ).toBeNull();
  });
});

describe('summarizeBackgroundJobs', () => {
  const summarize = (note: string) =>
    summarizeBackgroundJobs(parseBackgroundJobs(note) as NonNullable<ReturnType<typeof parseBackgroundJobs>>);

  it('says how the one job came out', () => {
    expect(summarize(EN_ENDED)).toBe('1 ended, exit 0');
    expect(summarize(ZH_KILLED)).toBe('1 killed');
  });

  it('counts the sections when there is more than one job', () => {
    expect(summarize(EN_RUNNING_AND_ENDED)).toBe('1 running, 1 ended');
    expect(summarize(ZH_MULTILINE_COMMAND)).toBe('3 running');
  });
});
