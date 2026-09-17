// ── The tasks a person named with `#`, as the control plane described them to the agent ──

import { encodeId } from './idCodec';

/**
 * The `<referenced-task>` blocks delivery appends for every `#`-reference in a message (apiserver
 * tasks/reference-expansion.ts `describeTask`).
 *
 * Like the background-jobs inventory, this rides along with whatever the person typed, so it stays
 * the folded entry under their words (Transcript's ControlPlaneNote) — this only turns the block
 * into cards. What it replaces there is a plain-text table, and with it the one thing on it worth
 * the most: the task's id sits in the opening tag, where a reader could see it and not click it.
 *
 * The block is written in one wording only (it has never been reworded, unlike background-jobs), so
 * a reworded field is read as no field at all and the note keeps the shape it has always had. That
 * is the intended failure: a card missing the row a reader came for is worse than the text.
 *
 * Only `referenced-task`. Delivery writes `<referenced-list>` too, but this deployment's record
 * holds not one of them, and a shape nobody has seen is not one to guess at — such a block stays in
 * `rest` and is read as it always was.
 */

/** One block: a task as the control plane described it, in that description's own words. */
export interface ReferencedTask {
  /** From the opening tag, in the base62 spelling the agent would pass back — and the link's. */
  id: string;
  title: string;
  /** `DONE` | `OPEN` | `FAILED` | … — the lifecycle name, never translated. */
  status: string;
  /** What the status line said after it: `验收任务`, `协调任务`. */
  suffixes: string[];
  /** The list it is filed under, or the block's own words for being in none. */
  list: string;
  assignee: string;
  runs: number;
  /** Of those, how many took a turn — the evidence question, which the block answers up front. */
  executed: number;
  /** The last run as the block put it: `SUCCEEDED, 59 turns`, `FAILED (unattributed), 31 turns`. */
  lastRun: string;
}

export interface ReferencedTasks {
  tasks: ReferencedTask[];
  /** Whatever else the same note carried — another block's rows are not this one's to draw. */
  rest: string;
}

const BLOCK = /<referenced-task id="([^"\n]*)">\n([\s\S]*?)\n<\/referenced-task>/g;
/** A field line: two spaces, the label, and the value. The narration line matches no label. */
const FIELD = /^ {2}(标题|状态|所属|运行) +(.*)$/;
/** `(无列表) · 负责 orbit` — greedy, so a list whose own title says it keeps it. */
const PLACE = /^(.*) · 负责 (.*)$/;
const RUNS = /^共 (\d+) 次，其中执行过 turn 的 (\d+) 次；最近一次：(.*)$/;
/** What the status line hangs its suffixes off, and what a card hangs them off in turn. */
const SUFFIX = ' · ';

/**
 * The tasks a note's blocks name, or null for a note that names none.
 *
 * A block that is not this shape — a field missing, an id that is not one — is left in `rest` and
 * read as it always was, which is also what a note of nothing but such blocks gets: better the
 * note as it has always read than half a card.
 */
export function parseReferencedTasks(note: string | null | undefined): ReferencedTasks | null {
  if (typeof note !== 'string') return null;
  const tasks: ReferencedTask[] = [];
  let rest = '';
  let from = 0;
  for (const block of note.matchAll(BLOCK)) {
    const task = parseTask(block[1], block[2]);
    if (!task) continue;
    tasks.push(task);
    rest += note.slice(from, block.index);
    from = block.index + block[0].length;
  }
  if (tasks.length === 0) return null;
  rest = (rest + note.slice(from)).replace(/\n{3,}/g, '\n\n').trim();
  return { tasks, rest };
}

/** One block's fields, or null for anything that is not the shape delivery writes. */
function parseTask(id: string, body: string): ReferencedTask | null {
  if (!isPublicId(id)) return null;
  const fields = new Map<string, string>();
  for (const line of body.split('\n')) {
    const field = FIELD.exec(line);
    if (field) fields.set(field[1], field[2]);
  }
  const title = fields.get('标题');
  const [status, ...suffixes] = (fields.get('状态') ?? '').split(SUFFIX);
  const place = PLACE.exec(fields.get('所属') ?? '');
  const runs = RUNS.exec(fields.get('运行') ?? '');
  if (!title || !status || !place || !runs) return null;
  return {
    id,
    title,
    status,
    suffixes,
    list: place[1],
    assignee: place[2],
    runs: Number(runs[1]),
    executed: Number(runs[2]),
    lastRun: runs[3],
  };
}

/**
 * Whether the opening tag holds an id at all, which is what makes the card clickable.
 *
 * A card whose title goes nowhere would be the dead text this replaced, so a block that carries no
 * id stays the text it always was rather than becoming a card that looks like a link.
 */
function isPublicId(id: string): boolean {
  try {
    encodeId(id);
    return true;
  } catch {
    return false;
  }
}

/**
 * "DONE" — or "6 DONE, 2 OPEN" — on the line that names the note folded.
 *
 * What the reader came for is the state of the thing they referenced, so one task says its status
 * outright and several are counted by it, in the order the note named them.
 */
export function summarizeReferencedTasks(tasks: ReferencedTask[]): string {
  if (tasks.length === 1) return tasks[0].status;
  const counts = new Map<string, number>();
  for (const task of tasks) counts.set(task.status, (counts.get(task.status) ?? 0) + 1);
  return [...counts].map(([status, n]) => `${n} ${status}`).join(', ');
}
