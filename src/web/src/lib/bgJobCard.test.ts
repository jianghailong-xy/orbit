import { describe, expect, it } from 'vitest';
import { bgRunReceipt, isRunnerJobLaunch, jobState, killedByLine, queuedJobWake, wakeupsOnly } from './bgJobCard';
import { parseBackgroundWake } from './backgroundWake';
import { ZH_JOB_AND_SCHEDULED, ZH_JOB_DONE, ZH_SCHEDULED } from './backgroundWake.fixtures';
import { SUBAGENT_DONE } from './subagentFinished.fixtures';

describe('a bg_run job’s card, joined by job id', () => {
  it('reads the job and its start off the call’s receipt', () => {
    const receipt = JSON.stringify({ ok: true, entity: { jobId: 'bgj_0af75213a408', startedAt: '2026-11-21T04:40:11Z' } });
    expect(bgRunReceipt([{ type: 'text', text: receipt }])).toEqual({ jobId: 'bgj_0af75213a408', startedAt: '2026-11-21T04:40:11Z' });
    expect(bgRunReceipt('started bgj_1a2b')).toEqual({ jobId: 'bgj_1a2b', startedAt: null });
    expect(bgRunReceipt('Plan mode refuses a background job.')).toBeNull();
  });

  it('knows the runner’s launch pair from an engine’s own background Bash', () => {
    expect(isRunnerJobLaunch('Bash', 'bgj_1', { command: 'x', run_in_background: true })).toBe(true);
    expect(isRunnerJobLaunch('Bash', 'toolu_1', { command: 'x', run_in_background: true })).toBe(false);
    expect(isRunnerJobLaunch('Bash', 'bgj_1', { command: 'x' })).toBe(false);
  });

  it('keeps of a wake only the wakeups the transcript still draws', () => {
    expect(wakeupsOnly(parseBackgroundWake(ZH_JOB_DONE))).toBeNull();
    expect(wakeupsOnly(parseBackgroundWake(ZH_SCHEDULED))?.wakeups).toHaveLength(1);
    const mixed = wakeupsOnly(parseBackgroundWake(ZH_JOB_AND_SCHEDULED))!;
    expect(mixed.jobs).toEqual([]);
    expect(mixed.wakeups).toHaveLength(1);
  });

  it('tells a queued job wake the tail draws nothing for from one it still draws', () => {
    expect(queuedJobWake(ZH_JOB_DONE)).toEqual({ jobIds: ['bgj_cc4b4ef84b39'], alone: true });
    expect(queuedJobWake(ZH_JOB_AND_SCHEDULED)?.alone).toBe(false);
    expect(queuedJobWake(`${SUBAGENT_DONE}\n\n${ZH_JOB_DONE}`)?.alone).toBe(false);
    expect(queuedJobWake(ZH_SCHEDULED)).toBeNull();
    expect(queuedJobWake('deploy it')).toBeNull();
  });

  it('names who stopped a killed job in one line, and nothing for a reason it does not know', () => {
    expect(killedByLine('requested')).toBe('Killed by the agent.');
    expect(killedByLine('stopped_by_owner')).toBe('The person who owns this session stopped it from the app.');
    expect(killedByLine('runner_shutdown')).toContain('a restart or a self-update');
    expect(killedByLine('session_cancelled')).toContain('The session was cancelled');
    expect(killedByLine('drain_cap')).toBeNull();
    expect(killedByLine(null)).toBeNull();
  });

  it('reads a job that nothing says ended as running on a live session, and unknown on one that is over', () => {
    expect(jobState({ wakes: [], live: true }).phase).toBe('running');
    expect(jobState({ wakes: [], live: false }).phase).toBe('unknown');
  });
});
