import { describe, expect, it } from 'vitest';
import { parseBackgroundWake } from './backgroundWake';
import { parseSubagentFinished } from './subagentFinished';
import {
  SUBAGENT_DONE,
  SUBAGENT_FAILED,
  SUBAGENT_INTERRUPTED,
  SUBAGENT_NODESC,
  SUBAGENT_STEER,
  SUBAGENT_STOPPED,
  SUBAGENT_TWO,
} from './subagentFinished.fixtures';

/**
 * Reading the block the control plane opens a turn with when a SubAgent ends, held to the words the
 * apiserver writes (the fixtures are `buildSubagentFinishedBlock`'s own output).
 */

const PROTOCOL = [
  'The control plane opened this turn for it.',
  'It ended while you were working',
  'the user did not say it',
  'call delegate with resume',
];

describe('parseSubagentFinished', () => {
  it('reads a run that finished: its description, run, end and the whole result back at column zero', () => {
    const wake = parseSubagentFinished(SUBAGENT_DONE)!;
    expect(wake.runs).toHaveLength(1);
    const [run] = wake.runs;
    expect(run).toMatchObject({
      runId: '34y5NxcqKYA179mC04VUB',
      description: 'Deploy 6bb50a957 to production',
      status: 'DONE',
      reason: null,
    });
    expect(run.result.startsWith('Stopped at step 1: the local lock `/tmp/orbit-upgrade.lock/pid`')).toBe(true);
    // The result's own blank line survives, and nothing of the block's indent does.
    expect(run.result).toContain('(not mine).\n\nThe remote check came back clean.');
    expect(run.result.split('\n').some((line) => line.startsWith(' '))).toBe(false);
    expect(wake.text).toBe(SUBAGENT_DONE);
    expect(wake.rest).toBe('');
  });

  it('never takes the sentences the block closes on into a result or a reason', () => {
    for (const block of [SUBAGENT_DONE, SUBAGENT_FAILED, SUBAGENT_STOPPED, SUBAGENT_INTERRUPTED, SUBAGENT_TWO, SUBAGENT_STEER]) {
      for (const run of parseSubagentFinished(block)!.runs) {
        for (const sentence of PROTOCOL) {
          expect(run.result).not.toContain(sentence);
          expect(run.reason ?? '').not.toContain(sentence);
        }
      }
    }
  });

  it('reads each way a run can fail to finish, with why', () => {
    expect(parseSubagentFinished(SUBAGENT_FAILED)!.runs[0]).toMatchObject({
      status: 'FAILED',
      reason: 'It did not finish its work.',
      result: 'vitest could not resolve `../quota/poller`; nothing written.',
    });
    expect(parseSubagentFinished(SUBAGENT_STOPPED)!.runs[0]).toMatchObject({
      status: 'STOPPED',
      reason: 'It was stopped before it finished.',
      result: '',
    });
    const interrupted = parseSubagentFinished(SUBAGENT_INTERRUPTED)!.runs[0];
    expect(interrupted.status).toBe('INTERRUPTED');
    expect(interrupted.reason).toMatch(/^The runner process hosting it stopped \(a restart, an update or a crash\)/);
    expect(interrupted.result).toBe('');
  });

  it('reads every run of a block that carries several', () => {
    const wake = parseSubagentFinished(SUBAGENT_TWO)!;
    expect(wake.runs.map((run) => [run.description, run.status])).toEqual([
      ['Find every caller of pollQuota', 'DONE'],
      ['Write the poller spec', 'FAILED'],
    ]);
    expect(wake.runs[0].result).toBe('Three callers, all in `quota/`: poller.ts, account.ts, limits.ts.\n\nNothing else imports it.');
    expect(wake.runs[1].reason).toBe('It did not finish its work.');
  });

  it('reads the block a steer delivers, and a run named by the stand-in for no description', () => {
    expect(parseSubagentFinished(SUBAGENT_STEER)!.runs[0].status).toBe('DONE');
    expect(parseSubagentFinished(SUBAGENT_NODESC)!.runs[0]).toMatchObject({ description: 'without a description', result: 'ok' });
  });

  it('keeps the rest of the note, and leaves a background job’s block beside it to its own reader', () => {
    const job = [
      '<background-job-wake>',
      '  A background job you started with bg_run has news you were waiting for; the control plane opened this turn for it:',
      '    bgj_13c53745a88a｜job｜make test｜unit tests',
      '      ended｜completed｜exit code 0',
      '      output /root/.orbit/runs/4f50733a/bgj_13c53745a88a.output｜this covers bytes 0–10',
      '      (no output)',
      '  The control plane recorded this for you; the user did not say it.',
      '</background-job-wake>',
    ].join('\n');
    const wake = parseSubagentFinished(`${SUBAGENT_DONE}\n\n${job}`)!;
    expect(wake.runs).toHaveLength(1);
    expect(wake.rest).toBe(job);
    expect(parseBackgroundWake(wake.rest)!.jobs[0].id).toBe('bgj_13c53745a88a');

    const nudge = 'You were interrupted; carry on from where you were.';
    expect(parseSubagentFinished(`${nudge}\n\n${SUBAGENT_DONE}`)!.rest).toBe(nudge);
  });

  it('reads a wording it does not know as nothing at all', () => {
    expect(parseSubagentFinished(null)).toBeNull();
    expect(parseSubagentFinished('')).toBeNull();
    expect(parseSubagentFinished('Please deploy it')).toBeNull();
    // An end it does not know.
    expect(parseSubagentFinished(SUBAGENT_DONE.replace('finished: DONE', 'finished: CANCELLED'))).toBeNull();
    // A head worded otherwise.
    expect(parseSubagentFinished(SUBAGENT_DONE.replace('SubAgent Deploy', 'Sub-agent Deploy'))).toBeNull();
    // A run that never says how its result reads.
    expect(parseSubagentFinished(SUBAGENT_DONE.replace('  Result:\n', ''))).toBeNull();
    // A block with no run in it.
    expect(parseSubagentFinished('<orbit-subagent-finished>\n  The control plane opened this turn for it.\n</orbit-subagent-finished>')).toBeNull();
    // A block cut off before its end tag.
    expect(parseSubagentFinished(SUBAGENT_DONE.replace('</orbit-subagent-finished>', ''))).toBeNull();
    // One run of two it cannot read takes the whole block with it, rather than a line that drops a run.
    expect(parseSubagentFinished(SUBAGENT_TWO.replace('finished: FAILED', 'finished: LOST'))).toBeNull();
  });
});
