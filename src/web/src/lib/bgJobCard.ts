// ── A bg_run job, as its one card in the transcript (components/JobCard.tsx) ──────────────────────
//
// The owner's job-card board (file 350t1lTONlrPMjilBdXx7, choices A1 B1 C1 D1 E1 F1 and rulings R1-R4 of
// 2026-11-21): a `bg_run` call draws one card that carries its job from start to end, as a background
// SubAgent's does (SubagentCardEnd). What the card says is joined by the job's id (`bgj_…`) from four
// sources: the call's own receipt, the job's runner reports (the Background list's `BgShell`), the wake
// turns the control plane opened for it (lib/backgroundWake), and the tail read route.

import { toolResultText, type BgShell, type BackgroundJobTailResponse } from '@orbit/shared';
import { parseBackgroundWake, type BackgroundWake, type BackgroundWakeJob } from './backgroundWake';
import { parseSubagentFinished } from './subagentFinished';
import { parseWorkflowFinished } from './orbitWorkflow';

/** Orbit's background-job tool, as every engine's MCP name for it reaches the transcript. */
export const BG_RUN_TOOL = 'mcp__orbit__bg_run';

const JOB_ID_FIELD = /"jobId"\s*:\s*"(bgj_[^"\s]+)"/;
const JOB_ID_ANY = /\b(bgj_[0-9a-zA-Z]+)\b/;
const STARTED_AT_FIELD = /"startedAt"\s*:\s*"([^"]+)"/;

/** What a bg_run call's receipt names: the job's id and when its runner started it. Null before it answers. */
export function bgRunReceipt(content: unknown): { jobId: string; startedAt: string | null } | null {
  const text = toolResultText(content);
  const id = JOB_ID_FIELD.exec(text) ?? JOB_ID_ANY.exec(text);
  if (!id) return null;
  return { jobId: id[1], startedAt: STARTED_AT_FIELD.exec(text)?.[1] ?? null };
}

/**
 * The launch pair the runner writes for every bg_run job (runner-go background_job.go `launchJob`): a `Bash`
 * tool_use with run_in_background, whose id is the job's own. It exists for the Background list; the job's
 * card is the bg_run call, so the transcript draws nothing for it.
 */
export function isRunnerJobLaunch(name: string, id: string, input: unknown): boolean {
  return (
    name === 'Bash' &&
    id.startsWith('bgj_') &&
    !!input &&
    typeof input === 'object' &&
    (input as Record<string, unknown>).run_in_background === true
  );
}

/** One time the job woke its agent: the job as that wake's block spelled it out, and the turn that carried it. */
export interface JobWakeSeen {
  job: BackgroundWakeJob;
  /** The wake blocks, exactly as the agent read them. */
  text: string;
  /** When the wake turn was written. */
  ts?: string;
  /** When the agent read it; unset while it was never confirmed delivered. */
  readAt?: string;
}

/** The background-job wake blocks a turn's note carries, beside a SubAgent's or a workflow's end or alone. */
export function jobWakeOf(note: string | null | undefined): BackgroundWake | null {
  if (typeof note !== 'string') return null;
  const workflow = parseWorkflowFinished(note);
  const subagent = parseSubagentFinished(workflow ? workflow.rest : note);
  return parseBackgroundWake(subagent ? subagent.rest : workflow ? workflow.rest : note);
}

/**
 * What of a wake the transcript still draws as a line: only its scheduled wakeups. A job's end, new output or
 * stall draws nothing there (board C1): its card says it. Null when nothing is left to draw.
 */
export function wakeupsOnly(wake: BackgroundWake | null): BackgroundWake | null {
  if (!wake || wake.wakeups.length === 0) return null;
  return wake.jobs.length === 0 ? wake : { ...wake, jobs: [] };
}

/** The wake turns among `turns`, by job id, oldest first. */
export function jobWakesOf(
  turns: Iterable<{ note?: string | null; ts?: string; delivered: boolean }>,
): ReadonlyMap<string, JobWakeSeen[]> {
  const out = new Map<string, JobWakeSeen[]>();
  for (const turn of turns) {
    const wake = jobWakeOf(turn.note);
    if (!wake) continue;
    for (const job of wake.jobs) {
      const seen: JobWakeSeen = { job, text: wake.text, ts: turn.ts, readAt: turn.delivered ? turn.ts : undefined };
      out.set(job.id, [...(out.get(job.id) ?? []), seen]);
    }
  }
  return out;
}

/** The job ids a queued turn wakes, or none for any other turn. */
export function queuedJobWake(content: string): { jobIds: string[]; alone: boolean } | null {
  const wake = jobWakeOf(content);
  if (!wake || wake.jobs.length === 0) return null;
  const subagent = parseSubagentFinished(content);
  const workflow = parseWorkflowFinished(content);
  return {
    jobIds: wake.jobs.map((job) => job.id),
    // The queued tail still draws a turn that carries something else to draw: a wakeup, a SubAgent's or a workflow's end.
    alone: wake.wakeups.length === 0 && !subagent && !workflow,
  };
}

/**
 * Who stopped a killed job, in one line: the wording the wake glosses use for each reason (apiserver
 * runner-api/background-job-wake.ts `KILLED_BECAUSE`), cut to its first clause, and the board's own line for
 * the agent's bg_kill. Null for a reason none of them names.
 */
export function killedByLine(reason: string | null | undefined): string | null {
  switch (reason) {
    case 'requested':
      return 'Killed by the agent.';
    case 'stopped_by_owner':
    case 'stop':
      return 'The person who owns this session stopped it from the app.';
    case 'runner_shutdown':
      return 'The runner process hosting it stopped — a restart or a self-update — and the job was killed with it.';
    case 'session_cancelled':
      return 'The session was cancelled, or handed to another runner process, and the job was killed with it.';
    case 'not_allowed':
      return "It never ran: this session's permission mode asked the owner first, and they did not allow it.";
    default:
      return null;
  }
}

export type JobPhase = 'running' | 'done' | 'failed' | 'killed' | 'unknown';

export interface JobState {
  phase: JobPhase;
  exitCode: number | null;
  /** Why a killed job was killed, as the runner names it. */
  reason: string | null;
  /** How long a running job had been quiet when its newest wake said so; null when it has not gone quiet. */
  quietMs: number | null;
  /** When it ended, where something said. */
  endedAt: string | null;
}

/**
 * How the job stands. Its runner's terminal report wins (the Background list), then its end's wake, then the
 * tail read's own status. A job nothing says ended is running while its session is live; on a session that is
 * over, it can no longer be, and nothing said how it ended.
 */
export function jobState({
  shell,
  wakes,
  tail,
  live,
}: {
  shell?: BgShell;
  wakes: readonly JobWakeSeen[];
  tail?: BackgroundJobTailResponse | null;
  live: boolean;
}): JobState {
  const endWake = [...wakes].reverse().find((wake) => wake.job.ended);
  const end = endWake?.job;
  const tailEnded = tail && tail.status !== 'running' ? tail : null;
  const exitCode = shell?.exitCode ?? end?.exitCode ?? tailEnded?.exitCode ?? null;
  const reason = shell?.reason ?? end?.killReason ?? null;
  // The runner's report says when it ended; without one loaded, the wake its end opened was written then.
  const endedAt = shell?.endedAt ?? endWake?.ts ?? null;
  const terminal =
    shell?.terminal ??
    (end ? (end.status === 'killed' ? 'killed' : end.status === 'failed' ? 'failed' : 'done') : undefined) ??
    (tailEnded ? (tailEnded.status === 'killed' ? 'killed' : tailEnded.status === 'failed' ? 'failed' : 'done') : undefined);
  if (terminal) {
    const phase: JobPhase = terminal === 'killed' ? 'killed' : terminal === 'failed' || (exitCode ?? 0) !== 0 ? 'failed' : 'done';
    return { phase, exitCode: phase === 'killed' ? null : exitCode, reason: phase === 'killed' ? reason : null, quietMs: null, endedAt };
  }
  const newest = wakes[wakes.length - 1]?.job;
  const quietMs = newest?.stall ? newest.stall.quietForMs ?? 0 : null;
  return { phase: live || shell?.status === 'running' ? 'running' : 'unknown', exitCode: null, reason: null, quietMs, endedAt: null };
}

/**
 * The output the card shows. Running: what the tail read answered just now, else what the newest wake carried.
 * Ended: what its end's wake carried (R2), else the tail read's last answer, else the runner's end report.
 */
export function jobOutput({
  phase,
  shell,
  wakes,
  tail,
}: {
  phase: JobPhase;
  shell?: BgShell;
  wakes: readonly JobWakeSeen[];
  tail?: BackgroundJobTailResponse | null;
}): string {
  const polled = tail && tail.lines.length > 0 ? tail.lines.join('\n') : '';
  const newestTail = [...wakes].reverse().find((wake) => wake.job.outputTail !== '')?.job.outputTail ?? '';
  if (phase === 'running' || phase === 'unknown') return polled || newestTail;
  const endTail = [...wakes].reverse().find((wake) => wake.job.ended)?.job.outputTail ?? '';
  return endTail || polled || shell?.latestOutput || newestTail;
}

/** `12m 40s` / `3m 10s` / `40m` past an hour's worth of minutes / `45s`: how long the job has run. */
export function elapsedText(ms: number): string {
  let seconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(seconds / 3600);
  seconds -= hours * 3600;
  const minutes = Math.floor(seconds / 60);
  seconds -= minutes * 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes >= 20) return `${minutes}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  return `${seconds}s`;
}

/** The last `n` lines of some output, its trailing blank lines dropped. */
export function lastLines(text: string, n: number): string[] {
  const lines = text.replace(/\s+$/, '').split('\n');
  return text.trim() === '' ? [] : lines.slice(-n);
}
