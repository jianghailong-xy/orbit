// ── The turn the control plane opens for a background job, or for a wakeup coming due ─────────

/**
 * A turn nobody typed: a `bg_run` job had the news its agent was waiting for, or a
 * `schedule_wakeup` came due, and the control plane opened a turn to carry it. The block IS the
 * turn — the turn's own content is empty (apiserver runner-api/background-job-wake.ts and
 * scheduled-wakeup.ts) — and it is stored beside the echo as the control plane's note, which is
 * where this reads it from (lib/deliveredMessage `splitRecordedNote`).
 *
 * Both blocks were written in Chinese until 2026-09-15 and the 73 turns already in the record are
 * not migrated, so every field is read off what the two wordings share and never translated: the
 * tag names, the `bgj_` prefix, the full-width `｜` between fields, the indent each line sits at,
 * and the status and kill-reason values themselves. A wording this does not recognise parses as
 * nothing at all rather than half a card — the note then stays the entry it has always been.
 */

/** One job's wake, as the block spells it out. */
export interface BackgroundWakeJob {
  id: string;
  kind: string;
  command: string;
  description: string | null;
  /** `completed` | `failed` | `killed` | `running` — never translated, in either wording. */
  status: string;
  /** False for a wake the job's new output opened rather than its exit. */
  ended: boolean;
  exitCode: number | null;
  /** Why a runner killed it (`runner_shutdown`, `session_cancelled`), without its gloss. */
  killReason: string | null;
  outputPath: string | null;
  /** The byte range of the output this turn covered, or null where the block named none. */
  outputFrom: number | null;
  outputTo: number | null;
  /** The tail of the output the agent was shown; empty where the block said there was none. */
  outputTail: string;
  /** Set for a job that is still running but has gone quiet (`<background-job-stall>`), null otherwise. */
  stall: BackgroundJobStall | null;
}

/** How a quiet job stood when its stall wake was sent, as the stall block spells it out. */
export interface BackgroundJobStall {
  /** How long it had been running; null where the block did not say. */
  runningForMs: number | null;
  /** How long it had written nothing — all of its run when it never wrote anything. */
  quietForMs: number | null;
  /** When it last wrote something; null when it never did, or the block did not say. */
  lastOutputAt: string | null;
  /** It has written nothing at all since it started. */
  wroteNothing: boolean;
}

/** One wakeup that came due on this turn. */
export interface ScheduledWakeup {
  /** When it was asked for, and how far out it was asked to land. */
  askedAt: string | null;
  delaySeconds: number | null;
  dueAt: string | null;
  reason: string | null;
  /** What the agent left for this turn to read; empty where it left nothing. */
  prompt: string;
}

export interface BackgroundWake {
  jobs: BackgroundWakeJob[];
  wakeups: ScheduledWakeup[];
  /** The wake blocks themselves, exactly as the agent received them. */
  text: string;
  /**
   * Whatever else the same note carried — a returning engine's continuation nudge, a coordinator's
   * standing role. Not the card's to draw: it stays the folded entry under it.
   */
  rest: string;
}

/**
 * A whole block, tag to matching tag. A quiet job's wake comes in a block of its own
 * (`<background-job-stall>`, runner-api/background-job-wake.ts `buildBackgroundStallBlock`), whose job
 * lines are written as a wake's are; only what brought it differs.
 */
const BLOCK = /<(background-job-wake|background-job-stall|scheduled-wakeup)>\n([\s\S]*?)\n<\/\1>/g;

/** The line a job's fields open on, at the indent the block puts it at. */
const JOB_HEAD = /^ {4}bgj_[^｜\s]*｜/;

/** `ended｜…` / `已结束｜…`, and the same for a wake new output opened. */
const TRIGGER = /^ {6}(ended|已结束|new output|有新输出)(?:｜(.*))?$/;

/** `gone quiet｜still running｜running for 15m 2s when this was sent` — a stall block's trigger. Only
 *  ever written in English: the stall wake postdates the Chinese wording. */
const STALL_TRIGGER = /^ {6}gone quiet｜(.*)$/;
const RUNNING_FOR = /running for (.+?) when this was sent/;
/** `no new output for 15m 0s｜last output at 2026-11-15T17:34:10Z` */
const QUIET_FOR = /^ {6}no new output for (.+?)(?:｜last output at (\S+))?$/;
/** `no output at all｜it has written nothing in the 15m 2s since it started` */
const WROTE_NOTHING = /^ {6}no output at all｜/;

const EXIT_CODE = /^(?:exit code|退出码)\s*(-?\d+)$/;
const KILL_REASON = /^(?:reason|原因)\s*(.+)$/;
/** The gloss the block appends to a known kill reason, in either wording's brackets. */
const REASON_GLOSS = /\s*[(（].*[)）]\s*$/;

const OUTPUT_LINE =
  /^ {6}(?:output|输出) (.+?)｜(?:this covers bytes|这次说到的是第) (\d+)[–-](\d+)(?: 字节)?$/;
const OUTPUT_TAIL = /^ {6}(?:output tail:|输出末尾：)$/;
const NO_OUTPUT = /^ {6}(?:\(no output\)|（没有输出）)$/;

/** The line a wakeup's timing sits on: when it was asked for, how far out, when it came due. */
const WAKEUP_TIMING =
  /^ {4}(\S+) (?:scheduled (\d+) seconds out, due (\S+)|约在 (\d+) 秒后，(\S+) 到点)$/;
const WAKEUP_REASON = /^ {4}(?:reason: |理由：)(.*)$/;
const WAKEUP_PROMPT = /^ {4}(?:what you left for this turn:|你留给这一轮的话：)$/;

/**
 * The wake blocks in a control plane note, or null for a note carrying none.
 *
 * `rest` hands back everything else the note held, so a note that carries a wake and something else
 * (a continuation nudge, a coordinator's role) keeps that part where it has always been.
 */
export function parseBackgroundWake(note: string | null | undefined): BackgroundWake | null {
  if (typeof note !== 'string') return null;
  const jobs: BackgroundWakeJob[] = [];
  const wakeups: ScheduledWakeup[] = [];
  const blocks: string[] = [];
  let rest = '';
  let end = 0;
  BLOCK.lastIndex = 0;
  for (let m = BLOCK.exec(note); m; m = BLOCK.exec(note)) {
    rest += note.slice(end, m.index);
    end = m.index + m[0].length;
    blocks.push(m[0]);
    if (m[1] === 'scheduled-wakeup') wakeups.push(...parseWakeups(m[2]));
    else jobs.push(...parseJobs(m[2]));
  }
  // A block whose every field is unreadable is not a card: better the note as it always read.
  if (jobs.length === 0 && wakeups.length === 0) return null;
  return {
    jobs,
    wakeups,
    text: blocks.join('\n\n'),
    rest: (rest + note.slice(end)).replace(/\n{3,}/g, '\n\n').trim(),
  };
}

/** Each job in a block, split where the next one's fields open. */
function parseJobs(body: string): BackgroundWakeJob[] {
  const lines = body.split('\n');
  const heads = lines.flatMap((line, i) => (JOB_HEAD.test(line) ? [i] : []));
  return heads.map((from, n) => parseJob(lines.slice(from, heads[n + 1] ?? lines.length)));
}

function parseJob(lines: string[]): BackgroundWakeJob {
  // The command can run to several lines of its own (a `while` loop, a heredoc), so the fields end
  // where the trigger line starts rather than at the first newline.
  const at = lines.findIndex((line, i) => i > 0 && (TRIGGER.test(line) || STALL_TRIGGER.test(line)));
  const head = lines.slice(0, at < 0 ? lines.length : at).join('\n').replace(/^ {4}/, '');
  // id｜kind｜command[｜description]. A `｜` inside the command would be indistinguishable from a
  // field break to the writer too, so the ends are trusted and the middle is the command.
  const fields = head.split('｜');
  const stalled = at < 0 ? null : STALL_TRIGGER.exec(lines[at]);
  const trigger = at < 0 || stalled ? null : TRIGGER.exec(lines[at]);
  const facts = (trigger?.[2] ?? '').split('｜');
  const kill = KILL_REASON.exec(facts[1] ?? '');
  const output = find(lines, OUTPUT_LINE);
  return {
    id: fields[0] ?? '',
    kind: fields[1] ?? '',
    command: fields.length > 3 ? fields.slice(2, -1).join('｜') : (fields[2] ?? ''),
    description: fields.length > 3 ? fields[fields.length - 1] : null,
    status: trigger ? (facts[0] ?? '') : stalled ? 'running' : '',
    ended: trigger ? trigger[1] === 'ended' || trigger[1] === '已结束' : false,
    exitCode: numberOr(EXIT_CODE.exec(facts[1] ?? '')?.[1]),
    killReason: kill ? kill[1].replace(REASON_GLOSS, '') : null,
    outputPath: output?.[1] ?? null,
    outputFrom: numberOr(output?.[2]),
    outputTo: numberOr(output?.[3]),
    outputTail: parseTail(lines),
    stall: stalled ? parseStall(stalled[1], lines) : null,
  };
}

function parseStall(facts: string, lines: string[]): BackgroundJobStall {
  const runningForMs = durationMs(RUNNING_FOR.exec(facts)?.[1]);
  const wroteNothing = lines.some((line) => WROTE_NOTHING.test(line));
  const quiet = find(lines, QUIET_FOR);
  return {
    runningForMs,
    quietForMs: wroteNothing ? runningForMs : durationMs(quiet?.[1]),
    lastOutputAt: quiet?.[2] ?? null,
    wroteNothing,
  };
}

/** `2h 5m 0s` / `15m 2s` / `45s` (the block's `readableDuration`) in milliseconds; null for anything else. */
function durationMs(text: string | undefined): number | null {
  if (!text || !/^(?:\d+[hms] ?)+$/.test(text)) return null;
  const unit: Record<string, number> = { h: 3_600_000, m: 60_000, s: 1000 };
  let ms = 0;
  for (const [, n, u] of text.matchAll(/(\d+)([hms])/g)) ms += Number(n) * unit[u];
  return ms;
}

/** The output tail as the agent read it, back at column zero. */
function parseTail(lines: string[]): string {
  const at = lines.findIndex((line) => OUTPUT_TAIL.test(line));
  if (at < 0) return '';
  const tail: string[] = [];
  for (const line of lines.slice(at + 1)) {
    // The narration closing the block sits at a shallower indent; the excerpt's own blank lines
    // survive as whitespace, and stopping on them would cut the tail in half.
    if (!line.startsWith('        ') && line.trim() !== '') break;
    tail.push(line.slice(8));
  }
  return tail.join('\n').replace(/\s+$/, '');
}

function parseWakeups(body: string): ScheduledWakeup[] {
  const lines = body.split('\n');
  const heads = lines.flatMap((line, i) => (WAKEUP_TIMING.test(line) ? [i] : []));
  return heads.map((from, n) => parseWakeup(lines.slice(from, heads[n + 1] ?? lines.length)));
}

function parseWakeup(lines: string[]): ScheduledWakeup {
  const timing = WAKEUP_TIMING.exec(lines[0]);
  const at = lines.findIndex((line) => WAKEUP_PROMPT.test(line));
  const prompt =
    at < 0
      ? []
      : lines.slice(at + 1).flatMap((line) => (line.startsWith('      ') ? [line.slice(6)] : []));
  return {
    askedAt: timing?.[1] ?? null,
    delaySeconds: numberOr(timing?.[2] ?? timing?.[4]),
    dueAt: timing?.[3] ?? timing?.[5] ?? null,
    reason: find(lines, WAKEUP_REASON)?.[1] ?? null,
    prompt: prompt.join('\n').replace(/\s+$/, ''),
  };
}

function find(lines: string[], re: RegExp): RegExpExecArray | null {
  for (const line of lines) {
    const m = re.exec(line);
    if (m) return m;
  }
  return null;
}

function numberOr(text: string | undefined): number | null {
  if (text === undefined) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}
