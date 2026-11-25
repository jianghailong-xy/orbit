/**
 * The block the control plane writes at the top of a run's first turn (docs/scheduled-tasks-design.md §6.3). A
 * fresh session per run keeps each run's context small; what carries over is on the schedule, and this block is
 * how it reaches the run: the person's words, the last result, the keys already reported, the last run's note, and
 * the access and limit the run works under. A run a WHEN rule's condition started (trigger CONDITION) is told its
 * firing instead of a planned time: the reading, since when it held, and the recent samples.
 */
import type { AccessLevel } from './schedule-envelope';

export interface RunBlockInput {
  /** This run's number among the schedule's runs that started, counting this one. */
  runNumber: number;
  title: string;
  intent: string;
  prompt: string;
  timezone: string;
  plannedAt: Date;
  startedAt: Date;
  /** The latest run that ended with a result before this one. */
  lastRun: { state: 'NO_CHANGE' | 'CHANGED' | 'FAILED'; endedAt: Date } | null;
  /** Every key reported so far, the baseline among them (`firstSeenAt` null). */
  findings: Array<{ key: string; firstSeenAt: Date | null }>;
  note: string | null;
  accessLevel: AccessLevel;
  runLimitMinutes: number;
  /** A CONDITION run's firing (docs/condition-triggers-design.md §6.1); null for a run of a time. */
  firing?: RunBlockFiring | null;
}

export interface RunBlockFiring {
  /** The condition in words: "Raw used above 90%". */
  text: string;
  unit: string | null;
  /** The firing sample's time: the run's plannedAt. */
  at: Date;
  /** What the firing sample read (its exit code under EXIT_ZERO); null when it is no longer kept. */
  value: number | null;
  /** The oldest of the unbroken true readings up to the firing. */
  since: Date | null;
  /** Newest first, the firing sample among them. */
  samples: Array<{ at: Date; value: number | null; outcome: string }>;
  /**
   * A repeat firing (docs/condition-triggers-design.md §5.1): when the condition first fired, on the crossing this
   * repeat follows, and how many runs started from it between then and this one. Null for a crossing.
   */
  repeat?: { firstFiredAt: Date; runsSince: number } | null;
}

/** At most this many recent samples are listed in a firing. */
export const RUN_BLOCK_MAX_SAMPLES = 10;

function reading(value: number | null, unit: string | null): string {
  if (value === null) return 'no reading';
  if (!unit) return String(value);
  return unit === '%' ? `${value}%` : `${value} ${unit}`;
}

function heldFor(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return `${Math.round(ms / 1000)} s`;
  if (minutes < 120) return `${minutes} min`;
  return `${Math.round(minutes / 60)} h`;
}

/** At most this many keys are listed; the rest are counted. */
export const RUN_BLOCK_MAX_FINDINGS = 50;

function localDate(at: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(at);
}

function localTime(at: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' })
    .format(at);
}

function utc(at: Date): string {
  return at.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** The first turn of a run: the block, then the schedule's prompt. */
export function scheduledRunTurn(input: RunBlockInput): string {
  const lines: string[] = [];
  const started = input.plannedAt.toISOString().slice(0, 10) === input.startedAt.toISOString().slice(0, 10)
    ? utc(input.startedAt).slice(11)
    : utc(input.startedAt);
  const f = input.firing;
  lines.push(
    `Run ${input.runNumber} of ${JSON.stringify(input.title)}, ${f ? 'fired' : 'planned'} ${utc(input.plannedAt)} `
      + `(${localTime(input.plannedAt, input.timezone)} ${input.timezone}), started ${started}.`,
  );
  if (f) {
    const since = f.since
      ? ` It has held since ${utc(f.since)} (${heldFor(f.at.getTime() - f.since.getTime())}).`
      : '';
    lines.push(`Fired because: ${JSON.stringify(f.text)}. The reading was ${reading(f.value, f.unit)} at ${utc(f.at)}.${since}`);
    if (f.repeat) {
      const n = f.repeat.runsSince;
      lines.push(
        `This is a repeat: the condition first fired at ${utc(f.repeat.firstFiredAt)} and has not re-armed since. `
          + `${n === 1 ? '1 run has' : `${n} runs have`} started from it since then, before this one.`,
      );
    }
    if (f.samples.length > 0) {
      lines.push('Recent samples, newest first:');
      for (const s of f.samples) {
        lines.push(`  ${utc(s.at)}  ${s.outcome === 'VALUE' || s.outcome === 'EXIT' ? reading(s.value, f.unit) : `could not read (${s.outcome})`}`);
      }
    }
  }
  lines.push(`The person asked: ${JSON.stringify(input.intent)}`);
  lines.push(
    input.lastRun
      ? `Last run: ${input.lastRun.state} on ${localDate(input.lastRun.endedAt, input.timezone)}.`
      : 'Last run: none, this is the first.',
  );
  if (input.findings.length === 0) {
    lines.push('Already reported: nothing yet.');
  } else {
    lines.push('Already reported (do not report again; link these instead of opening new ones):');
    for (const f of input.findings.slice(0, RUN_BLOCK_MAX_FINDINGS)) {
      lines.push(`  ${f.key}  ${f.firstSeenAt ? `first reported ${localDate(f.firstSeenAt, input.timezone)}` : 'baseline'}`);
    }
    if (input.findings.length > RUN_BLOCK_MAX_FINDINGS) {
      lines.push(`  …and ${input.findings.length - RUN_BLOCK_MAX_FINDINGS} more (schedule_get lists them all).`);
    }
  }
  lines.push(`Note from the last run: ${input.note ?? 'none.'}`);
  lines.push(`Access: ${input.accessLevel}. Limit: ${input.runLimitMinutes} minutes.`);
  if (input.accessLevel === 'LAND') {
    lines.push('Commit your work on your branch. Do not open a PR, merge, push, release or deploy. '
      + 'Orbit lands it on main after your turn ends and you report CHANGED or NO_CHANGE, using the normal merge check.');
  }
  lines.push('When you are done, call mcp__orbit__schedule_run_report exactly once.');
  // §7.1: the run ends when the session settles idle, so the deadline is the end of a turn, not the run limit.
  lines.push('Ending your turn without it fails this run (NO_REPORT). To wait, use bg_run or a SubAgent: a watch, '
    + 'wakeup or task_await does not keep the run open.');
  return ['<scheduled-run>', ...lines.map((l) => `  ${l}`), '</scheduled-run>', input.prompt].join('\n');
}
