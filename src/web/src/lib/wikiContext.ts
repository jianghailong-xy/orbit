// ── The notes the wiki handed a session when it started: what the agent had read before it began ──

/**
 * The `<orbit_wiki_context>` block delivery appends on a session's first turn under a new engine
 * (apiserver wiki/wiki-push.ts, design §7.1).
 *
 * It rides along with the turn's brief, so it stays the folded entry inside the task start card —
 * `ControlPlaneNote` is what draws it, and this only turns its lines into rows. What it replaces is
 * the block verbatim: a header sentence addressed to the model, then one line per entry naming its
 * kind, its title and its summary, all of it the agent's reading matter rather than the reader's.
 *
 * The lines are the contract's own shape (`contracts/wiki.contract.json` `push.line`, which
 * `wiki-push.ts` builds and its pg spec pins): `[Kind] Title — summary (orbit-wiki:<id>)`. Nothing
 * here is invented — the entry's id is on the line, which is what lets the rows read the entry's
 * trust back off the control plane rather than being told it.
 */
import { WIKI_CONTEXT_TAG } from './deliveredMessage';

/** One line of the block, as the session was handed it. */
export interface WikiContextEntry {
  /** The block's own word, capitalized: `Principle`, `Convention`, `Pitfall`, `Decision`, `Recipe`. */
  kind: string;
  title: string;
  summary: string;
  /** The entry's public id, as the line spells it — what the row's trust is read back under. */
  id: string;
}

export interface WikiContext {
  entries: WikiContextEntry[];
  /** The block itself, exactly as the agent received it. */
  text: string;
  /** Whatever else the same note carried — another block's text is not this one's to draw. */
  rest: string;
}

/**
 * The block, entire. The `entries` attribute is optional here and not read: the count on the folded
 * line is `describeNote`'s business, and a list this parser could not fill is not one it should
 * claim a size for.
 */
const BLOCK = new RegExp(
  `<${WIKI_CONTEXT_TAG}(?:\\s+entries="\\d+")?>\\n([\\s\\S]*?)\\n</${WIKI_CONTEXT_TAG}>`,
);

/**
 * One entry's line. The title is greedy and the summary is what is left, so a title that itself
 * carries a dash is not split at the wrong one: the block writes the summary last, and the id after
 * it is what says where the line ends.
 */
const LINE = /^\[([^\]]+)\] (.*) — (.*) \(orbit-wiki:([0-9A-Za-z]+)\)$/;

/**
 * The block's entries, or null for a note that carries none.
 *
 * Null is also the answer for a block whose lines are all unreadable: the folded entry then reads as
 * it always has rather than as a card with an empty list in it.
 */
export function parseWikiContext(note: string | null | undefined): WikiContext | null {
  if (typeof note !== 'string') return null;
  const block = BLOCK.exec(note);
  if (!block) return null;
  const entries: WikiContextEntry[] = [];
  for (const line of block[1].split('\n')) {
    // The header sentence is addressed to the model and is not an entry; it is what the fold's own
    // verbatim reading is for.
    const found = LINE.exec(line);
    if (found) entries.push({ kind: found[1], title: found[2], summary: found[3], id: found[4] });
  }
  if (entries.length === 0) return null;
  const rest = (note.slice(0, block.index) + note.slice(block.index + block[0].length))
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { entries, text: block[0], rest };
}
