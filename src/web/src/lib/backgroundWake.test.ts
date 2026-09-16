import { describe, expect, it } from 'vitest';
import { parseBackgroundWake } from './backgroundWake';
import {
  ZH_JOB_AND_SCHEDULED,
  ZH_JOB_DONE,
  ZH_JOB_FAILED,
  ZH_SCHEDULED,
  ZH_TWO_JOBS,
  ZH_WAKE_WITH_COORDINATOR_CONTEXT,
} from './backgroundWake.fixtures';

/**
 * Reading the two blocks the control plane opens a turn with.
 *
 * Both are held to the wording the apiserver writes today (runner-api/background-job-wake.ts
 * `buildBackgroundWakeBlock`, scheduled-wakeup.ts `buildScheduledWakeupBlock`) AND to the wording
 * that shipped until 2026-09-15, which the 73 turns already in the record still carry — recognising
 * only the new one would have sent every older transcript back to an unnamed grey strip on the day
 * it shipped. The older fixtures are copied out of this deployment's own `run_event` rows
 * (backgroundWake.fixtures.ts), not typed out from the format's description.
 */

// The byte range is written with an EN DASH, in both wordings.
const EN_DONE = [
  '<background-job-wake>',
  '  A background job you started with bg_run has news you were waiting for; the control plane opened this turn for it:',
  '    bgj_13c53745a88a｜job｜/root/orbit/.claude/skills/upgrade/upgrade.sh --pull｜upgrade to 39551b637',
  '      ended｜completed｜exit code 0',
  '      output /root/.orbit/runs/4f50733a/bgj_13c53745a88a.output｜this covers bytes 0–16570',
  '      output tail:',
  '        ==> recreating apiserver',
  '        ==> apiserver is healthy',
  '  The control plane recorded this for you; the user did not say it. Read the full output with mcp__orbit__bg_output by id; pass sinceOffset to read only what is new.',
  '</background-job-wake>',
].join('\n');

const EN_KILLED = [
  '<background-job-wake>',
  '  A background job you started with bg_run has news you were waiting for; the control plane opened this turn for it:',
  '    bgj_13c53745a88a｜job｜/root/orbit/.claude/skills/upgrade/upgrade.sh --pull｜upgrade to 39551b637',
  '      ended｜killed｜reason runner_shutdown (the runner process hosting it stopped — a restart or a self-update — and the job was killed with it)',
  '      output /root/.orbit/runs/4f50733a/bgj_13c53745a88a.output｜this covers bytes 0–16570',
  '      (no output)',
  '  The control plane recorded this for you; the user did not say it. Read the full output with mcp__orbit__bg_output by id; pass sinceOffset to read only what is new.',
  '  A killed job does not come back on its own: to keep waiting, start it again with bg_run.',
  '</background-job-wake>',
].join('\n');

const EN_TWO_JOBS = [
  '<background-job-wake>',
  '  A background job you started with bg_run has news you were waiting for; the control plane opened this turn for it:',
  '    bgj_987dbb363d36｜job｜bash scripts/run-pg-spec.sh src/apiserver/src/tasks/a.pg.spec.ts｜Red run: new pg spec on the unchanged tree',
  '      ended｜completed｜exit code 0',
  '      output /root/.orbit/runs/4f50733a/bgj_987dbb363d36.output｜this covers bytes 0–9626',
  '      output tail:',
  '        ok 1 - the criterion holds',
  '    bgj_645de7bb677b｜watch｜gh run watch 34997433169 --exit-status｜watch main CI 34997433169',
  '      ended｜failed｜exit code 1',
  '      output /root/.orbit/runs/4f50733a/bgj_645de7bb677b.output｜this covers bytes 0–350697',
  '      output tail:',
  '        X Process completed with exit code 1.',
  '  The control plane recorded this for you; the user did not say it. Read the full output with mcp__orbit__bg_output by id; pass sinceOffset to read only what is new.',
  '</background-job-wake>',
].join('\n');

const EN_SCHEDULED = [
  '<scheduled-wakeup>',
  '  The wakeup you asked for with schedule_wakeup is due; the control plane opened this turn for it:',
  '    2026-09-15T18:00:00.000Z scheduled 600 seconds out, due 2026-09-15T18:10:00.000Z',
  '    reason: waiting for CI run 4242',
  '    what you left for this turn:',
  '      read the CI result and fix what failed',
  '  The control plane recorded this for you; the user did not say it. To wait again, call mcp__orbit__schedule_wakeup again.',
  '</scheduled-wakeup>',
].join('\n');

// A block that is not a wake: it rides along on somebody's message and stays where it always was.
const CONTINUATION = [
  '<background-jobs>',
  '  你不在的时候结束了：',
  '    bgj_3a1af2b50428｜job｜bash upgrade.sh｜completed｜退出码 0｜输出 /root/.orbit/runs/01a07c80/bgj_3a1af2b50428.output',
  '</background-jobs>',
].join('\n');

describe('the block a background job’s wake opens a turn with', () => {
  it('reads every field of a job that finished, in the wording written today', () => {
    const wake = parseBackgroundWake(EN_DONE)!;

    expect(wake.jobs).toHaveLength(1);
    expect(wake.wakeups).toEqual([]);
    expect(wake.jobs[0]).toEqual({
      id: 'bgj_13c53745a88a',
      kind: 'job',
      command: '/root/orbit/.claude/skills/upgrade/upgrade.sh --pull',
      description: 'upgrade to 39551b637',
      status: 'completed',
      ended: true,
      exitCode: 0,
      killReason: null,
      outputPath: '/root/.orbit/runs/4f50733a/bgj_13c53745a88a.output',
      outputFrom: 0,
      outputTo: 16570,
      outputTail: '==> recreating apiserver\n==> apiserver is healthy',
    });
    // The block itself is kept whole, to be shown exactly as the agent received it.
    expect(wake.text).toBe(EN_DONE);
    expect(wake.rest).toBe('');
  });

  it('reads the same fields out of the wording that shipped until 2026-09-15', () => {
    const wake = parseBackgroundWake(ZH_JOB_DONE)!;

    expect(wake.jobs).toHaveLength(1);
    expect(wake.jobs[0]).toMatchObject({
      id: 'bgj_cc4b4ef84b39',
      kind: 'watch',
      description: 'watch main CI rerun 34970575848',
      status: 'completed',
      ended: true,
      exitCode: 0,
      outputFrom: 0,
      outputTo: 54,
    });
    expect(wake.jobs[0].command).toContain('gh run watch 34970575848 --exit-status');
    expect(wake.jobs[0].outputTail).toBe('CI 34970575848 (rerun of Test web, bb4a144ff) exit: 1');
  });

  it('reads a failure, and an empty output, out of an older turn', () => {
    const wake = parseBackgroundWake(ZH_JOB_FAILED)!;

    expect(wake.jobs[0]).toMatchObject({
      id: 'bgj_209fc7f9f47a',
      command: 'sleep 5; exit 3',
      description: 'Smoke: wakeOnExit on a job that exits 3',
      status: 'failed',
      ended: true,
      exitCode: 3,
      outputTo: 0,
      outputTail: '',
    });
  });

  it('reads a kill by its reason alone, with the gloss that explains it left off', () => {
    const wake = parseBackgroundWake(EN_KILLED)!;

    expect(wake.jobs[0]).toMatchObject({
      status: 'killed',
      ended: true,
      exitCode: null,
      killReason: 'runner_shutdown',
      outputTail: '',
    });
  });

  it('keeps several jobs apart, in the order the block lists them', () => {
    const wake = parseBackgroundWake(EN_TWO_JOBS)!;

    expect(wake.jobs.map((job) => job.id)).toEqual(['bgj_987dbb363d36', 'bgj_645de7bb677b']);
    expect(wake.jobs.map((job) => job.status)).toEqual(['completed', 'failed']);
    expect(wake.jobs.map((job) => job.exitCode)).toEqual([0, 1]);
    expect(wake.jobs[1].outputTail).toBe('X Process completed with exit code 1.');
  });

  it('keeps them apart in the older wording too, off a turn that answered for two', () => {
    const wake = parseBackgroundWake(ZH_TWO_JOBS)!;

    expect(wake.jobs.map((job) => job.id)).toEqual(['bgj_52843eb345d1', 'bgj_974ceb2c3d52']);
    expect(wake.jobs.map((job) => job.status)).toEqual(['failed', 'failed']);
    expect(wake.jobs.map((job) => job.exitCode)).toEqual([1, 1]);
    expect(wake.jobs.map((job) => job.outputTail)).toEqual(['', '']);
  });

  it('keeps a command that runs to several lines of its own whole, and still finds the description behind it', () => {
    const wake = parseBackgroundWake(ZH_WAKE_WITH_COORDINATOR_CONTEXT)!;

    expect(wake.jobs).toHaveLength(1);
    expect(wake.jobs[0].command).toContain('while true; do');
    expect(wake.jobs[0].command).toContain('sleep 30');
    expect(wake.jobs[0].description).toBe('Watch push-triggered main CI for merged tip 3a7686cf2');
    expect(wake.jobs[0].status).toBe('completed');
  });
});

describe('the block a scheduled wakeup opens a turn with', () => {
  it('reads when it was asked for, when it came due, why, and what was left for the turn', () => {
    const wake = parseBackgroundWake(EN_SCHEDULED)!;

    expect(wake.jobs).toEqual([]);
    expect(wake.wakeups).toEqual([
      {
        askedAt: '2026-09-15T18:00:00.000Z',
        delaySeconds: 600,
        dueAt: '2026-09-15T18:10:00.000Z',
        reason: 'waiting for CI run 4242',
        prompt: 'read the CI result and fix what failed',
      },
    ]);
  });

  it('reads the same out of the wording that shipped until 2026-09-15', () => {
    const wake = parseBackgroundWake(ZH_SCHEDULED)!;

    expect(wake.wakeups).toHaveLength(1);
    expect(wake.wakeups[0]).toMatchObject({
      askedAt: '2026-09-15T11:29:14.912Z',
      delaySeconds: 3600,
      dueAt: '2026-09-15T12:29:14.911Z',
    });
    expect(wake.wakeups[0].reason).toContain('复跑负载闸门');
    expect(wake.wakeups[0].prompt).toContain('兜底检查');
  });

  it('carries both blocks when a wakeup came due on a job’s turn', () => {
    const joined = `${EN_DONE}\n\n${EN_SCHEDULED}`;
    const wake = parseBackgroundWake(joined)!;

    expect(wake.jobs).toHaveLength(1);
    expect(wake.wakeups).toHaveLength(1);
    expect(wake.text).toBe(joined);
    expect(wake.rest).toBe('');
  });

  it('carries both out of the one older turn they came on together', () => {
    const wake = parseBackgroundWake(ZH_JOB_AND_SCHEDULED)!;

    expect(wake.jobs.map((job) => job.id)).toEqual(['bgj_13c53745a88a']);
    expect(wake.jobs[0].outputTail.endsWith('✓ Upgrade complete — all services healthy.')).toBe(true);
    expect(wake.wakeups).toHaveLength(1);
    expect(wake.wakeups[0]).toMatchObject({
      askedAt: '2026-09-15T17:35:28.715Z',
      delaySeconds: 720,
      dueAt: '2026-09-15T17:47:28.715Z',
    });
    expect(wake.wakeups[0].reason).toContain('升级作业的备份验证');
    expect(wake.wakeups[0].prompt).toContain('升级备份唤醒');
    expect(wake.text).toBe(ZH_JOB_AND_SCHEDULED);
    expect(wake.rest).toBe('');
  });
});

describe('what the card is not given', () => {
  it('hands back everything else the same note carried, for the entry that already shows it', () => {
    const wake = parseBackgroundWake(ZH_WAKE_WITH_COORDINATOR_CONTEXT)!;

    expect(wake.text.startsWith('<background-job-wake>')).toBe(true);
    expect(wake.text.endsWith('</background-job-wake>')).toBe(true);
    expect(wake.text).not.toContain('orbit_project_coordinator_context');
    expect(wake.rest.startsWith('<orbit_project_coordinator_context>')).toBe(true);
    expect(wake.rest.endsWith('</orbit_project_coordinator_context>')).toBe(true);
    expect(wake.rest).not.toContain('bgj_');
  });

  it('is nothing at all for a note with no wake in it, or no note', () => {
    expect(parseBackgroundWake(CONTINUATION)).toBeNull();
    expect(parseBackgroundWake('just a message someone typed')).toBeNull();
    expect(parseBackgroundWake('')).toBeNull();
    expect(parseBackgroundWake(null)).toBeNull();
    expect(parseBackgroundWake(undefined)).toBeNull();
  });

  it('is nothing at all for a block whose fields it cannot read, rather than half a card', () => {
    expect(parseBackgroundWake('<background-job-wake>\n  something else entirely\n</background-job-wake>')).toBeNull();
  });
});
