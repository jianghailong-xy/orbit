/**
 * The block the control plane writes at the top of a run's first turn (docs/scheduled-tasks-design.md §6.3). A
 * fresh session per run keeps each run's context small; what carries over is on the schedule, and this block is
 * how it reaches the run: the person's words, the last result, the keys already reported, the last run's note, and
 * the access and limit the run works under.
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
  lines.push(
    `Run ${input.runNumber} of ${JSON.stringify(input.title)}, planned ${utc(input.plannedAt)} `
      + `(${localTime(input.plannedAt, input.timezone)} ${input.timezone}), started ${started}.`,
  );
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
  lines.push('When you are done, call mcp__orbit__schedule_run_report exactly once.');
  return ['<scheduled-run>', ...lines.map((l) => `  ${l}`), '</scheduled-run>', input.prompt].join('\n');
}
