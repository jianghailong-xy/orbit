// ── The turn the control plane opens when a SubAgent ends ───────────────────────────────────────────

/**
 * A turn nobody typed: a SubAgent (`delegate`) ended and the control plane opened a turn in its
 * parent to hand over how it ended and what it said. Like a background job's wake (lib/backgroundWake)
 * the turn's own content is empty and the block is the control plane's note, built by the apiserver's
 * `buildSubagentFinishedBlock` (runner-api/background-job-wake.ts):
 *
 *     <orbit-subagent-finished>
 *       SubAgent <description> (run <id>) finished: <STATUS>
 *       <why it ended, for a run that did not finish>
 *       Result:
 *         <the result, four spaces in>          — or —   (no result)
 *       … the next run …
 *       <the sentences for the agent>
 *     </orbit-subagent-finished>
 *
 * A wording this does not recognise parses as nothing at all rather than half a line: the note then
 * stays the entry it has always been.
 */

export type SubagentEnd = 'DONE' | 'FAILED' | 'STOPPED' | 'INTERRUPTED';

/** One run's end, as the block spells it out. */
export interface SubagentFinishedRun {
  runId: string;
  /** The `delegate` call's description (or what the block names a run without one by). */
  description: string;
  status: SubagentEnd;
  /** Why a run that did not finish ended, as the control plane put it; null for DONE. */
  reason: string | null;
  /** What it handed back, back at column zero; empty where the block said there was none. */
  result: string;
}

export interface SubagentFinished {
  runs: SubagentFinishedRun[];
  /** The block itself, exactly as the agent received it. */
  text: string;
  /** Whatever else the same note carried: not the line's to draw, it stays a folded entry. */
  rest: string;
}

const BLOCK = /<orbit-subagent-finished>\n([\s\S]*?)\n<\/orbit-subagent-finished>/g;

/** `SubAgent <description> (run <id>) finished: <STATUS>` — the description may hold brackets of its own. */
const HEAD = /^ {2}SubAgent (.+) \(run (\S+)\) finished: (DONE|FAILED|STOPPED|INTERRUPTED)$/;
/** A line at the block's own indent, not inside a result. */
const SENTENCE = /^ {2}(?! )(.+)$/;

/** The SubAgent block in a control plane note, or null for a note carrying none it can read. */
export function parseSubagentFinished(note: string | null | undefined): SubagentFinished | null {
  if (typeof note !== 'string' || !note.includes('<orbit-subagent-finished>')) return null;
  const runs: SubagentFinishedRun[] = [];
  const blocks: string[] = [];
  let rest = '';
  let end = 0;
  BLOCK.lastIndex = 0;
  for (let m = BLOCK.exec(note); m; m = BLOCK.exec(note)) {
    const parsed = parseRuns(m[1]);
    // One block it cannot read is a note it cannot read: never a line that drops a run.
    if (!parsed) return null;
    rest += note.slice(end, m.index);
    end = m.index + m[0].length;
    blocks.push(m[0]);
    runs.push(...parsed);
  }
  if (runs.length === 0) return null;
  return {
    runs,
    text: blocks.join('\n\n'),
    rest: (rest + note.slice(end)).replace(/\n{3,}/g, '\n\n').trim(),
  };
}

/** Each run in a block, read line by line; null on any line the shape has no place for. */
function parseRuns(body: string): SubagentFinishedRun[] | null {
  const runs: SubagentFinishedRun[] = [];
  let run: SubagentFinishedRun | null = null;
  // Where the reading is: just past a run's head, inside its result, past its result, or in the
  // sentences closing the block (which are the agent's and never shown outside the raw block).
  let at: 'start' | 'head' | 'result' | 'ended' | 'closing' = 'start';
  let result: string[] = [];
  const close = () => {
    if (run) run.result = result.join('\n').replace(/\s+$/, '');
    run = null;
    result = [];
  };
  for (const line of body.split('\n')) {
    // A blank line of the result is four spaces, unless something on the way trimmed it.
    if (at === 'result' && (line.startsWith('    ') || line === '')) {
      result.push(line.slice(4));
      continue;
    }
    if (at === 'closing') {
      if (!SENTENCE.test(line)) return null;
      continue;
    }
    const head = HEAD.exec(line);
    if (head && at !== 'head') {
      close();
      run = { description: head[1], runId: head[2], status: head[3] as SubagentEnd, reason: null, result: '' };
      runs.push(run);
      at = 'head';
      continue;
    }
    if (at === 'head' && run) {
      if (line === '  Result:') at = 'result';
      else if (line === '  (no result)') at = 'ended';
      else if (run.reason === null && run.status !== 'DONE' && SENTENCE.test(line)) run.reason = line.slice(2);
      else return null;
      continue;
    }
    if ((at === 'result' || at === 'ended') && SENTENCE.test(line)) {
      close();
      at = 'closing';
      continue;
    }
    return null;
  }
  // A block cut off before a run said how its result reads is not one this knows.
  if (at === 'start' || at === 'head') return null;
  close();
  return runs;
}

