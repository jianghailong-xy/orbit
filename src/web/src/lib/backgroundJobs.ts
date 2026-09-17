// ── The inventory a returning engine is handed: what is still running, what ended while it was gone ──

/**
 * The `<background-jobs>` block delivery appends the first time a new engine takes a turn
 * (apiserver runner-api/background-jobs-context.ts).
 *
 * Unlike a wake, this block rides along with whatever the person typed, so it stays the folded
 * entry under their words (Transcript's ControlPlaneNote) — this only turns its job lines into rows.
 * What it replaces there is a line that runs four lines wide: an id, a kind, a shell command, an
 * outcome and an absolute path, all divided by a `｜` the reader has to count.
 *
 * The block was written in Chinese until 2026-09-15 and the rows already in the record are not
 * migrated — 85 of this deployment's 106 carry the older wording — so both are read, and neither is
 * ever translated: the section headings, the field prefixes, the `no end reported` outcome, and the
 * status values, which were already English in both.
 *
 * Each job line is `id｜kind｜command[｜status[｜exit code N][｜reason R]][｜output PATH]`. The ends
 * are read first and whatever is left in the middle is the command, so a `｜` the command itself
 * contains survives — the same trust the writer places in it (lib/backgroundWake `parseJob`).
 *
 * The Monitor section and the two sentences addressed to the agent are deliberately not rows: they
 * are read from the verbatim fold the note keeps under them.
 */

/** One line of the block's two job sections. */
export interface BackgroundJobRow {
  id: string;
  /** `service` | `job` | `watch` — the three a `bg_run` can be (runner-go background_job.go). */
  kind: string;
  command: string;
  /** `completed` | `failed` | `killed` | `stopped`, or empty for a job that is still running. */
  status: string;
  exitCode: number | null;
  /** Why it ended the way it did: a runner's kill reason, or that no end was ever reported. */
  reason: string | null;
  outputPath: string | null;
}

export interface BackgroundJobs {
  running: BackgroundJobRow[];
  ended: BackgroundJobRow[];
  /** The block itself, exactly as the agent received it. */
  text: string;
  /** Whatever else the same note carried — another block's rows are not this one's to draw. */
  rest: string;
}

const BLOCK = /<background-jobs>\n([\s\S]*?)\n<\/background-jobs>/;

/** The two sections whose lines become rows, in both wordings. */
const RUNNING = /^ {2}(?:Still running|仍在运行)/;
const ENDED = /^ {2}(?:Ended while you were away|你不在的时候结束了)/;
/**
 * Every line the block itself writes at section indent, which is how a section's list ends.
 *
 * Named one by one rather than taken as "any line at this indent": a command runs to several lines
 * of its own (a `while` loop, a heredoc) and those lines are indented however the person wrote them
 * — an `  fi` two spaces in would otherwise cut the command, and the job, in half.
 */
const NARRATION =
  /^ {2}(?:Still running|Ended while you were away|Monitors that stopped|If you are still waiting|The control plane recorded|Read output with|仍在运行|你不在的时候结束了|随上一个 engine|还要等的事|这是控制面替你记下的|用 mcp__orbit__bg_output)/;
/** Where one job's fields open, which is also where the previous job's command ends. */
const JOB_HEAD = /^ {4}\S+｜/;

const TERMINAL = new Set(['completed', 'failed', 'killed', 'stopped']);
const EXIT_CODE = /^(?:exit code|退出码) (-?\d+)$/;
const REASON = /^(?:reason|原因) /;
const OUTPUT = /^(?:output|输出) /;
/** A job whose runner process died without reporting an end, as the block spells it out. */
const NO_END = /^(?:no end reported|没有结束报告)$/;

/**
 * The block's jobs, or null for a note that carries none.
 *
 * Null is also the answer for a block whose sections are all unreadable — better the note as it has
 * always read than half a card.
 */
export function parseBackgroundJobs(note: string | null | undefined): BackgroundJobs | null {
  if (typeof note !== 'string') return null;
  const block = BLOCK.exec(note);
  if (!block) return null;
  const lines = block[1].split('\n');
  const running = parseSection(lines, RUNNING);
  const ended = parseSection(lines, ENDED);
  if (running.length === 0 && ended.length === 0) return null;
  const rest = (note.slice(0, block.index) + note.slice(block.index + block[0].length))
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { running, ended, text: block[0], rest };
}

/** The lines listed under one heading, each folded into a row. */
function parseSection(lines: string[], heading: RegExp): BackgroundJobRow[] {
  const from = lines.findIndex((line) => heading.test(line));
  if (from < 0) return [];
  const listed: string[] = [];
  for (const line of lines.slice(from + 1)) {
    if (NARRATION.test(line)) break;
    listed.push(line);
  }
  const heads = listed.flatMap((line, i) => (JOB_HEAD.test(line) ? [i] : []));
  return heads.map((at, n) => parseJob(listed.slice(at, heads[n + 1] ?? listed.length)));
}

function parseJob(lines: string[]): BackgroundJobRow {
  const fields = lines.join('\n').replace(/^ {4}/, '').split('｜');
  const id = fields[0] ?? '';
  const kind = fields[1] ?? '';
  const rest = fields.slice(2);
  const outputPath = takeSuffix(rest, OUTPUT);
  let reason = takeSuffix(rest, REASON);
  const exit = EXIT_CODE.exec(rest[rest.length - 1] ?? '');
  if (exit) rest.pop();
  let status = TERMINAL.has(rest[rest.length - 1] ?? '') ? (rest.pop() as string) : '';
  // `no end reported｜<why that is all anyone can say>`: two fields, one outcome. The gloss is for
  // the agent, so the row keeps the outcome's own words and the gloss stays in the verbatim fold.
  if (NO_END.test(rest[rest.length - 2] ?? '')) {
    rest.pop();
    reason = rest.pop() as string;
    status = 'stopped';
  }
  return {
    id,
    kind,
    command: rest.join('｜'),
    status,
    exitCode: exit ? Number(exit[1]) : null,
    reason,
    outputPath,
  };
}

/** The last field when it is the one this prefix names, taken off the end. */
function takeSuffix(fields: string[], prefix: RegExp): string | null {
  const last = fields[fields.length - 1];
  if (last === undefined || !prefix.test(last)) return null;
  fields.pop();
  return last.replace(prefix, '');
}

/**
 * "2 running, 1 failed" — what the block holds, on the line that names it folded.
 *
 * The count is the whole point of the line: "background jobs" alone never said whether opening it
 * was worth it. A lone job that ended says how, because that one number is what its reader came for.
 */
export function summarizeBackgroundJobs({ running, ended }: BackgroundJobs): string {
  if (running.length === 0 && ended.length === 1) {
    const [job] = ended;
    if (job.exitCode !== null) return `1 ended, exit ${job.exitCode}`;
    return `1 ${job.status || 'ended'}`;
  }
  const failed = ended.filter((job) => job.status === 'failed' || job.status === 'killed');
  return [
    running.length > 0 ? `${running.length} running` : null,
    ended.length > failed.length ? `${ended.length - failed.length} ended` : null,
    failed.length > 0 ? `${failed.length} failed` : null,
  ]
    .filter(Boolean)
    .join(', ');
}
