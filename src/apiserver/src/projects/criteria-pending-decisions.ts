import { Prisma } from '@prisma/client';

import {
  CRITERIA_WEAKENING_EFFECT_CLASS,
  type CriteriaWeakeningAction,
  type ProposedCriterion,
} from './criteria-weakening-intent';
import {
  type StatedAcceptanceCriterion,
  criteriaFromDefinitions,
  standardSetVersion,
} from './project-acceptance';

/**
 * Which loosening proposals an account owner is being asked to decide, derived from the ledger
 * every time it is asked.
 *
 * A DERIVED READ, NOT A QUEUE
 * ---------------------------
 * `pending-evidence-judgments.ts` is the shape this copies, and copies for its reasons. There is no
 * row anywhere that says "this proposal is pending": `project_ratified_action_intent` has no status
 * column, and could not have one — a BEFORE UPDATE OR DELETE trigger (0195) refuses every write to
 * a filed row, which is the point, since the party proposing a looser ruler is the party that must
 * not be able to edit the proposal after it is read. So pending is a shape the committed rows
 * already have: a weakening intent of this project that no later proposal displaced and that
 * nothing has settled. Every one of those is a row somebody else wrote for their own reasons, so
 * this read cannot fall out of date with them, cannot be delivered twice, and cannot be lost.
 * Closing the conversation that was reading it changes none of them.
 *
 * THIS READ IS WHAT THE DECISION CARD IS DRAWN FROM
 * -------------------------------------------------
 * Until 2026-09-10 a held proposal was also relayed to the project's coordinator conversation, as a
 * message that could do nothing but hand the question on — approving a looser ruler is the account
 * owner's alone. That relay is gone. The owner's card reads this derivation (through
 * `readPendingCriteriaDecisionsForOwner` below, which adds the key) and answers at the decision
 * door, so nothing has to be delivered for a proposal to be asked: pending is a shape the rows
 * already have, so a question nobody has looked at yet is still here on the next read.
 *
 * WHY EACH ROW CARRIES A REASON RATHER THAN A FLAG
 * ------------------------------------------------
 * Same shape `criterionSatisfaction` and the evidence queue settled on: a reader who is told only
 * "no" cannot act. So a row that cannot be decided today still comes back, carrying the refusal the
 * decision door would give and the action that would clear it. What a reader must never be shown is
 * a card whose only lit button is refused every time it is pressed.
 *
 * NOTHING HERE GATES ANYTHING. It writes nothing and no status is derived from it.
 */

/**
 * The two refusals a decision on a pending proposal can meet, in the door's spelling.
 *
 * Stated HERE, in the read, and not in the door — because the read is what exists first, and
 * `ProjectsService.decideCriteriaChange` imports these rather than spelling its own. One rule, one
 * spelling: a queue that promises a decision the door refuses, or refuses one the door would take,
 * is the drift both of them exist to keep out.
 */
export const CRITERIA_DECISION_BASE_SEAL_MOVED = 'PROJECT_CRITERIA_DECISION_BASE_SEAL_MOVED';
export const CRITERIA_DECISION_ALREADY_SETTLED = 'PROJECT_CRITERIA_DECISION_ALREADY_SETTLED';

/** What clears a proposal whose baseline is no longer the ruler in force. */
export const CRITERIA_DECISION_REFILE_ACTION = 'REFILE_AGAINST_THE_CURRENT_STANDARD_SET';

/**
 * Whether a decision could be recorded about this proposal right now, and — when it could not —
 * why not.
 *
 * Only one refusal can reach a row this read returns, and it is `BASE_SEAL_MOVED`: a settled
 * proposal is not returned at all (see below), so `ALREADY_SETTLED` is a refusal the DOOR gives to
 * a caller holding a stale id rather than a state this read can report. It is named beside the
 * other for that reason — the two are the door's set, and a reader of this file should be able to
 * see which of them this read can and cannot produce.
 */
export interface CriteriaDecisionDecidability {
  /** True when the decision door would not refuse this proposal for want of a live baseline. */
  decidable: boolean;
  /** Null when decidable; otherwise the door's own code. */
  refusal: string | null;
  /** The action that would clear it, in the same vocabulary the refusal carries. */
  requiredAction: string | null;
}

/**
 * WHAT ONE PROPOSED CRITERION DOES TO THE ONE IT NAMES — DERIVED HERE AND NOWHERE ELSE
 * ------------------------------------------------------------------------------------
 * A weakening edit restates the WHOLE collection: `project_update(acceptanceCriteriaItems)` is a
 * replacement, so a proposal that reworded one criterion out of eight arrives carrying all eight,
 * and seven of them are the words already on record. `proposed` is that restatement verbatim,
 * because it is the material `actionDigest` is taken over and has to stay recomputable from the
 * request alone — so it cannot say which of the eight moved, and a card built from it alone can
 * only lay out all eight and leave the reader to find the three.
 *
 * WHY THE COMPARISON IS THE SERVER'S AND NOT THE CARD'S. A client could fetch the criteria in
 * force and diff them against `proposed` itself. That would make the card's central claim — these
 * are the words that change — a conclusion the CLIENT reached from two reads taken at two moments,
 * about a ruler that can move between them, and it would have to be reached again, identically, in
 * every client. The rule this whole surface is built on is that the card's content comes from one
 * derived read; so the comparison is taken here, inside the same transaction that decided which
 * proposals are pending, against the same definition rows the seal above is computed from.
 *
 * AGAINST THE SET IN FORCE, WHICH IS NOT ALWAYS THE BASELINE. `action.baseline.material` records
 * the set the proposer composed against, but as `(definitionId, revision, contentHash)` and not as
 * words — the baseline's text is not stored anywhere — so it can say THAT something differs and
 * never WHAT. The comparison is therefore against the definitions standing now, which is also the
 * more useful question: it is what approving this would change. For a decidable proposal the two
 * are the same set, because that is exactly what `baselineSeal === currentSeal` means; for one
 * whose base seal has moved they are not, and that row's buttons are already dead.
 */
export type CriteriaProposalChange = 'SAME' | 'CHANGED' | 'NEW' | 'REMOVED';

/**
 * The fields a rewrite can move, and the whole of what `CHANGED` is decided over.
 *
 * All three that a criterion carries today, not just `text`: a criterion states an assertion AND
 * how a reader decides it holds, and an edit that leaves the assertion alone while rewriting the
 * procedure has changed what the project has to prove. `content_hash` (0233) covers the first two;
 * this covers the third as well, because the advisory override reason is stored, is returned, and
 * is a thing the proposer can silently drop.
 */
export type CriteriaProposalField =
  | 'text'
  | 'verificationMethod'
  | 'completionCriterionOverrideReason';

const CRITERION_FIELDS: readonly CriteriaProposalField[] = [
  'text',
  'verificationMethod',
  'completionCriterionOverrideReason',
];

/**
 * WHY THE REWRITE IS CUT INTO PIECES HERE, AND NOT LEFT AS TWO PARAGRAPHS FOR THE CARD
 * ------------------------------------------------------------------------------------
 * Saying WHICH criteria moved was only half of it. A rewrite still arrived as two whole
 * paragraphs — the words proposed and the words on record — and the first real proposal Orbit held
 * was eight Chinese criteria of about ninety characters each, of which three had a clause swapped
 * inside them. Laid out as two paragraphs apiece that is six long blocks for three edits, 483px of
 * content in a 360px scroll box, and a reader who must compare two paragraphs by eye to find the
 * clause that moved. The clause is the answer; the other eighty characters are the question
 * repeated.
 *
 * So the comparison is taken down to the level the change actually happened at, and it is taken
 * HERE for exactly the reason the criterion-level one is (see above): a client that diffed the two
 * texts itself would be reaching the card's central claim — THESE are the words that change — on
 * its own, twice, in two languages, and the two would not stay identical. The server says it once.
 *
 * BY GRAPHEME CLUSTER, NOT BY WORD. Chinese does not put spaces between words, so an algorithm
 * that splits on whitespace sees one token per sentence and can only report the sentence as
 * different — which is the thing being fixed, not a smaller version of it. Splitting on UTF-16
 * code units is the opposite failure: it cuts an emoji in half and a combining mark off its base,
 * and the halves are then rendered as their own struck-through fragments. `Intl.Segmenter` at
 * `grapheme` granularity is the unit a reader would call one character in every script, which is
 * the unit this cuts on.
 */
export type CriterionSegmentSide = 'KEPT' | 'REMOVED' | 'ADDED';

/**
 * One run of a rewritten field, and what the rewrite does with it.
 *
 * ONE MERGED SEQUENCE RATHER THAN TWO. The segments are in reading order, and the two sides are
 * read out of it rather than shipped separately: the words ON RECORD are the `KEPT` and `REMOVED`
 * segments in order, and the words PROPOSED are the `KEPT` and `ADDED` ones. Both are recovered
 * character for character (`criteria-inline-diff.spec.ts` pins that), which is what makes this a
 * cut of the two texts and not a summary of them — a card can render the merged line, and a reader
 * who wants either side whole can still be given it, from the same field.
 */
export interface CriterionSegment {
  side: CriterionSegmentSide;
  /** Never empty: an empty run is not a run, and would render as a stray mark. */
  text: string;
}

/** One field of a rewrite, cut up. One of these per entry in `changed`, in that same order. */
export interface CriterionFieldRewrite {
  field: CriteriaProposalField;
  segments: CriterionSegment[];
}

/**
 * The unit the cut is made in: what a reader of any script would call one character.
 *
 * `und` and not a locale, because grapheme boundaries are not locale-dependent (word and sentence
 * boundaries are, which is part of why this cuts on graphemes) and because a read must not give
 * two answers on two machines with two default locales.
 */
const GRAPHEMES = new Intl.Segmenter('und', { granularity: 'grapheme' });

function graphemes(text: string): string[] {
  return Array.from(GRAPHEMES.segment(text), (piece) => piece.segment);
}

/**
 * The most this will spend deciding where a rewrite differs, in cells of the LCS table.
 *
 * A derived read is on the path of every card render, and the table is quadratic, so a criterion
 * somebody pastes a novel into must not be able to make this read expensive. Past the budget the
 * middle is reported whole — one REMOVED run and one ADDED run — which is the honest answer at
 * that size anyway: nobody reads a character-level diff of two thousand-character paragraphs. The
 * common head and tail are still cut off first, so the fallback is reached far less often than the
 * raw lengths suggest.
 */
const MAX_REWRITE_CELLS = 1_000_000;

/**
 * A common run this short between two changes is dropped and read as part of the change.
 *
 * The longest common subsequence of two Chinese sentences is littered with single characters that
 * happen to appear in both — 的, 一, 不, a comma — and honouring every one of them turns a swapped
 * clause into a dozen alternating fragments that is harder to read than the two paragraphs this
 * replaces. Keeping only runs that are a word or more long is what makes the output a clause a
 * reader can see rather than confetti.
 */
const MIN_KEPT_RUN = 3;

/** The longest common subsequence of two grapheme sequences, as a keep-mask over each side. */
function commonMask(before: string[], after: string[]): { before: boolean[]; after: boolean[] } {
  const rows = before.length;
  const columns = after.length;
  const stride = columns + 1;
  const table = new Uint16Array((rows + 1) * stride);
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = columns - 1; j >= 0; j -= 1) {
      table[i * stride + j] = before[i] === after[j]
        ? table[(i + 1) * stride + j + 1]! + 1
        : Math.max(table[(i + 1) * stride + j]!, table[i * stride + j + 1]!);
    }
  }
  const keptBefore = new Array<boolean>(rows).fill(false);
  const keptAfter = new Array<boolean>(columns).fill(false);
  let i = 0;
  let j = 0;
  while (i < rows && j < columns) {
    if (before[i] === after[j]) {
      keptBefore[i] = true;
      keptAfter[j] = true;
      i += 1;
      j += 1;
    } else if (table[(i + 1) * stride + j]! >= table[i * stride + j + 1]!) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return { before: keptBefore, after: keptAfter };
}

/** Runs of `true` shorter than `MIN_KEPT_RUN` are cleared, in place. */
function dropShortRuns(mask: boolean[]): void {
  let at = 0;
  while (at < mask.length) {
    if (!mask[at]) {
      at += 1;
      continue;
    }
    let end = at;
    while (end < mask.length && mask[end]) end += 1;
    if (end - at < MIN_KEPT_RUN) for (let k = at; k < end; k += 1) mask[k] = false;
    at = end;
  }
}

/** Appends, coalescing with the run before it, and never appending an empty one. */
function appendSegment(into: CriterionSegment[], side: CriterionSegmentSide, text: string): void {
  if (text === '') return;
  const last = into[into.length - 1];
  if (last && last.side === side) last.text += text;
  else into.push({ side, text });
}

/**
 * Two versions of one field, cut into the runs they share and the runs they do not.
 *
 * The common head and tail come off first — which is where nearly all of a real edit's agreement
 * is, and it costs a linear scan instead of a quadratic table — and only what is left in the
 * middle is put through the subsequence. Exported so a caller can ask the question about two
 * strings, and so the spec that pins the cut does not have to build a proposal to get one.
 */
export function criterionFieldSegments(before: string, after: string): CriterionSegment[] {
  const left = graphemes(before);
  const right = graphemes(after);
  let head = 0;
  while (head < left.length && head < right.length && left[head] === right[head]) head += 1;
  let tail = 0;
  while (
    tail < left.length - head
    && tail < right.length - head
    && left[left.length - 1 - tail] === right[right.length - 1 - tail]
  ) tail += 1;
  const middleBefore = left.slice(head, left.length - tail);
  const middleAfter = right.slice(head, right.length - tail);

  const segments: CriterionSegment[] = [];
  appendSegment(segments, 'KEPT', left.slice(0, head).join(''));
  if (
    middleBefore.length === 0
    || middleAfter.length === 0
    || middleBefore.length * middleAfter.length > MAX_REWRITE_CELLS
  ) {
    appendSegment(segments, 'REMOVED', middleBefore.join(''));
    appendSegment(segments, 'ADDED', middleAfter.join(''));
  } else {
    const kept = commonMask(middleBefore, middleAfter);
    dropShortRuns(kept.before);
    dropShortRuns(kept.after);
    let i = 0;
    let j = 0;
    while (i < middleBefore.length || j < middleAfter.length) {
      if (i < middleBefore.length && !kept.before[i]) {
        appendSegment(segments, 'REMOVED', middleBefore[i]!);
        i += 1;
      } else if (j < middleAfter.length && !kept.after[j]) {
        appendSegment(segments, 'ADDED', middleAfter[j]!);
        j += 1;
      } else if (i < middleBefore.length && j < middleAfter.length) {
        appendSegment(segments, 'KEPT', middleBefore[i]!);
        i += 1;
        j += 1;
      } else if (i < middleBefore.length) {
        appendSegment(segments, 'REMOVED', middleBefore[i]!);
        i += 1;
      } else {
        appendSegment(segments, 'ADDED', middleAfter[j]!);
        j += 1;
      }
    }
  }
  appendSegment(segments, 'KEPT', left.slice(left.length - tail).join(''));
  return segments;
}

/** One criterion's words, on either side of the comparison, normalised the same way on both. */
export interface CriterionWording {
  text: string;
  verificationMethod: string | null;
  completionCriterionOverrideReason: string | null;
}

/** What this proposal does to one criterion: which one, which way, and both sets of words. */
export interface CriteriaProposalChangeEntry {
  change: CriteriaProposalChange;
  /** The definition this entry is about; null for one the proposal is ADDING, which names none. */
  definitionId: string | null;
  /** Its place in the proposed set — or, for one being dropped, its place in the set on record. */
  ordinal: number;
  /** The proposal's words. Null for `REMOVED`: the proposal states none. */
  proposed: CriterionWording | null;
  /** THE WORDS IT REPLACES, off the definition in force. Null for `NEW`: it replaces nothing. */
  onRecord: CriterionWording | null;
  /** Which fields differ. Empty except on `CHANGED`, where it is never empty. */
  changed: CriteriaProposalField[];
  /** Each of those fields cut into what the rewrite keeps, drops and adds, in `changed` order.
   *  Empty exactly when `changed` is: `NEW` and `REMOVED` state one side and cut nothing. */
  rewrites: CriterionFieldRewrite[];
}

/**
 * The whole of what a proposal would do to the ruler, and how much of it it leaves alone.
 *
 * The counts are the part a card can act on without walking the entries: `sameCount` is what
 * licenses a reader to fold the untouched ones away, and it has to be a number the server said
 * rather than one a collapsed list implies, or "5 unchanged" would be a claim about how many rows
 * the client chose not to draw.
 */
export interface CriteriaProposalDiff {
  /** Every proposed criterion, judged, then every criterion the proposal drops. */
  entries: CriteriaProposalChangeEntry[];
  sameCount: number;
  changedCount: number;
  newCount: number;
  removedCount: number;
}

/** Trimmed, and empty-as-null, so that whitespace is not a change and `''` is not a wording. */
function wording(
  text: string,
  verificationMethod: string | null | undefined,
  completionCriterionOverrideReason: string | null | undefined,
): CriterionWording {
  return {
    text: text.trim(),
    verificationMethod: verificationMethod?.trim() || null,
    completionCriterionOverrideReason: completionCriterionOverrideReason?.trim() || null,
  };
}

/**
 * The proposal read against the criteria in force: one entry per proposed criterion, plus one for
 * every criterion on record the proposal does not restate.
 *
 * Matched by the definition id the request itself carries, never by position: an edit may reorder
 * the collection, and a comparison by ordinal would then report two rewrites where a reader
 * dragged one row past another. A proposed criterion with no id is one being ADDED — the write
 * path puts `null` there precisely because the id it would get is a uuid the request never named.
 * An id that resolves to nothing on record is treated the same way and for the same reason: there
 * is no criterion here for it to replace.
 *
 * Exported so both the read below and the specs that pin it call one function, and so a caller
 * holding a proposal and a set of definitions can ask the question without a database.
 */
export function criteriaProposalDiff(
  proposed: readonly ProposedCriterion[],
  onRecord: readonly StatedAcceptanceCriterion[],
): CriteriaProposalDiff {
  const standing = new Map(onRecord.map((criterion) => [criterion.definitionId, criterion]));
  const restated = new Set<string>();
  const entries: CriteriaProposalChangeEntry[] = [];

  proposed.forEach((criterion, index) => {
    const ordinal = criterion.ordinal > 0 ? criterion.ordinal : index + 1;
    const words = wording(
      criterion.text, criterion.verificationMethod, criterion.completionCriterionOverrideReason,
    );
    const replaced = criterion.id === null ? undefined : standing.get(criterion.id);
    if (!replaced) {
      entries.push({
        change: 'NEW',
        definitionId: criterion.id,
        ordinal,
        proposed: words,
        onRecord: null,
        changed: [],
        rewrites: [],
      });
      return;
    }
    restated.add(replaced.definitionId);
    const was = wording(
      replaced.text, replaced.verificationMethod, replaced.completionCriterionOverrideReason,
    );
    const changed = CRITERION_FIELDS.filter((field) => was[field] !== words[field]);
    entries.push({
      change: changed.length === 0 ? 'SAME' : 'CHANGED',
      definitionId: replaced.definitionId,
      ordinal,
      proposed: words,
      onRecord: was,
      changed,
      // A field a criterion does not carry is the empty string on that side, not a missing side:
      // adding a procedure to a criterion that had none is an addition of every character of it,
      // which is exactly what the cut then says.
      rewrites: changed.map((field) => ({
        field,
        segments: criterionFieldSegments(was[field] ?? '', words[field] ?? ''),
      })),
    });
  });

  for (const criterion of onRecord) {
    if (restated.has(criterion.definitionId)) continue;
    entries.push({
      change: 'REMOVED',
      definitionId: criterion.definitionId,
      ordinal: criterion.ordinal,
      proposed: null,
      changed: [],
      rewrites: [],
      onRecord: wording(
        criterion.text, criterion.verificationMethod, criterion.completionCriterionOverrideReason,
      ),
    });
  }

  const counted = (change: CriteriaProposalChange): number =>
    entries.filter((entry) => entry.change === change).length;
  return {
    entries,
    sameCount: counted('SAME'),
    changedCount: counted('CHANGED'),
    newCount: counted('NEW'),
    removedCount: counted('REMOVED'),
  };
}

/** One loosening proposal waiting for an answer, with everything the answer needs in it. */
export interface PendingCriteriaDecision {
  /** The proposal's address, which is what the proposer was told and what the door takes back. */
  intentId: string;
  projectId: string;
  /** Recomputable by anyone holding the request that made it — see `criteria-weakening-intent.ts`. */
  actionDigest: string;
  filedAt: Date;
  /** Age at `readAt`, in whole seconds, so "oldest" is the server's clock and not a browser's. */
  ageSeconds: number;
  /** The seal of the standard set this proposal was composed against. */
  baselineSeal: string;
  /** The seal of the standard set that stands NOW. Equal to `baselineSeal` when decidable. */
  currentSeal: string;
  /** What the edit asked for, exactly as the request stated it — the material of the digest. */
  proposed: ProposedCriterion[];
  /** The same restatement read against the criteria in force: what it changes, and what it does
   *  not. This is the shape a card renders; `proposed` is the shape a digest is taken over. */
  diff: CriteriaProposalDiff;
  /** The proposal this one displaced, or null when it displaced nothing. */
  supersededIntentId: string | null;
  decidability: CriteriaDecisionDecidability;
}

/**
 * What this project's owner is being asked about: the count, the oldest age, and the rows.
 *
 * A list rather than the single row the write path enforces, and deliberately: "one pending
 * proposal per project" is maintained by the supersession link the newer proposal writes, and a
 * read that returned `row | null` would be asserting that invariant instead of reporting it. If two
 * rows ever come back, that is the fact a reader needs to see rather than one this read picked
 * between.
 */
export interface PendingCriteriaDecisionQueue {
  readAt: Date;
  projectId: string;
  /** How many proposals are waiting for an answer: the length of `pending`. */
  count: number;
  /** The age of the oldest of them, or null when there is none. */
  oldestAgeSeconds: number | null;
  /** How many of them a decision could actually be recorded on today. */
  decidableCount: number;
  pending: PendingCriteriaDecision[];
}

/** The stored `action`, or null for a row whose JSONB is not one this reader understands. */
function storedAction(action: unknown): CriteriaWeakeningAction | null {
  if (!action || typeof action !== 'object' || Array.isArray(action)) return null;
  const candidate = action as Partial<CriteriaWeakeningAction>;
  const request = candidate.request;
  const baseline = candidate.baseline;
  if (!request || typeof request !== 'object' || !Array.isArray(request.proposed)) return null;
  if (!baseline || typeof baseline !== 'object' || typeof baseline.seal !== 'string') return null;
  return candidate as CriteriaWeakeningAction;
}

function ageSeconds(readAt: Date, filedAt: Date): number {
  return Math.max(0, Math.floor((readAt.getTime() - filedAt.getTime()) / 1000));
}

/**
 * Which of these filed proposals are still questions — THE one place that sentence is composed,
 * so the per-project read below and the owner-wide signal that merely COUNTS them cannot come to
 * different answers about which rows are waiting.
 *
 * Two of the three ways a row stops being a question are decided here, because both are facts
 * about the rows themselves: it was answered (`settledIntentIds`), or a later proposal about the
 * same project displaced it. The third — the base seal moved — is deliberately NOT here: a row in
 * that state is still a question, it is only one that cannot be answered today, and the read below
 * returns it carrying the door's refusal. A counter that dropped it would tell the owner there is
 * nothing waiting when there is.
 *
 * The supersession link is folded from the rows the caller already holds rather than asked of the
 * database a second time: it lives IN the action of the row that did the displacing. Callers pass
 * every filed row of the scope they care about — including settled ones — because a settled row
 * can still be the one that displaced another.
 */
export async function stillUnanswered<T extends { id: string; action: unknown }>(
  tx: Prisma.TransactionClient,
  rows: readonly T[],
): Promise<T[]> {
  if (rows.length === 0) return [];
  const settled = await settledIntentIds(tx, rows.map((row) => row.id));
  const displaced = new Set<string>();
  for (const row of rows) {
    const action = storedAction(row.action);
    if (action?.supersedes) displaced.add(action.supersedes.intentId);
  }
  return rows.filter((row) => !settled.has(row.id) && !displaced.has(row.id));
}

/**
 * Every proposal of this project that is still a question, oldest first, recomputed from the rows.
 *
 * THE THREE WAYS A ROW STOPS BEING A QUESTION, AND WHY TWO OF THEM VANISH AND ONE DOES NOT
 * ----------------------------------------------------------------------------------------
 *   * SETTLED — somebody answered it. The row is not returned at all, exactly as the evidence
 *     queue drops a revision that carries a decision: an answered question is not a question, and
 *     it has to disappear from EVERY reader's next read rather than from the one that happened to
 *     be listening.
 *   * SUPERSEDED — a later proposal about the same project replaced it. Also not returned, and for
 *     a stricter reason than "it is old": what the owner would be approving is not what anybody is
 *     asking for any more. Read off the supersession links themselves rather than off `created_at`,
 *     because two transactions can share a timestamp and "the newest row" would then be a coin toss
 *     where the invariant needs an answer.
 *   * THE BASE SEAL MOVED — the ruler this proposal was composed against is not the ruler in force.
 *     This one IS returned, undecidable, carrying the door's refusal and the action that clears it.
 *     Dropping it would leave the proposer's card silently blank, and the row is the only thing
 *     that can explain why the answer they were waiting for cannot be given.
 *
 * `EXISTS` rather than a join for the supersession: the question is whether ANY later row names
 * this one, and a join would multiply a row by the number of proposals that displaced it.
 */
export async function readPendingCriteriaDecisions(
  tx: Prisma.TransactionClient,
  ownerId: string,
  projectId: string,
  readAt: Date = new Date(),
): Promise<PendingCriteriaDecisionQueue> {
  const rows = await tx.projectRatifiedActionIntent.findMany({
    where: {
      ownerId,
      projectId,
      effectClass: CRITERIA_WEAKENING_EFFECT_CLASS,
    },
    select: { id: true, action: true, actionDigest: true, createdAt: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });

  const pending: PendingCriteriaDecision[] = [];
  if (rows.length > 0) {
    const open = await stillUnanswered(tx, rows);
    // The set in force, read ONCE: its seal is what this read calls "moved" — computed by the
    // same function the confirmation read path uses, so it is the value a reader of
    // `GET /projects/:id/acceptance/confirmation` sees — and its words are the other side of
    // every comparison below. One read of these rows rather than two, because a proposal being
    // told it is decidable against one version of the ruler and diffed against another is the
    // exact incoherence this read exists to keep out of the card.
    const inForce = await standardSetInForce(tx, projectId);
    const currentSeal = inForce.seal;

    for (const row of open) {
      const action = storedAction(row.action);
      // A row whose JSONB this reader cannot make sense of is not silently dropped — dropping it
      // would make an unreadable proposal look like no proposal — but it has no diff to show and
      // no baseline to compare, so it comes back undecidable with the seal that stands.
      const baselineSeal = action?.baseline.seal ?? '';
      const moved = baselineSeal !== currentSeal;
      // An unreadable proposal gets an EMPTY diff rather than one saying it drops everything:
      // `proposed` is `[]` for it because nothing could be read out of the row, and a comparison
      // taken over that would report every criterion on record as dropped — which is a statement
      // about this reader's failure dressed up as a statement about somebody's proposal.
      const diff = action
        ? criteriaProposalDiff(action.request.proposed, inForce.criteria)
        : criteriaProposalDiff([], []);
      pending.push({
        intentId: row.id,
        projectId,
        actionDigest: row.actionDigest,
        filedAt: row.createdAt,
        ageSeconds: ageSeconds(readAt, row.createdAt),
        baselineSeal,
        currentSeal,
        proposed: action?.request.proposed ?? [],
        diff,
        supersededIntentId: action?.supersedes?.intentId ?? null,
        decidability: {
          decidable: !moved,
          refusal: moved ? CRITERIA_DECISION_BASE_SEAL_MOVED : null,
          requiredAction: moved ? CRITERIA_DECISION_REFILE_ACTION : null,
        },
      });
    }
  }

  return {
    readAt,
    projectId,
    count: pending.length,
    oldestAgeSeconds: pending.length === 0 ? null : pending[0].ageSeconds,
    decidableCount: pending.filter((row) => row.decidability.decidable).length,
    pending,
  };
}

/**
 * One held proposal as the ACCOUNT OWNER reads it: the row above, and the key that answers it.
 *
 * `commitToken` is the proposal's own one-time secret and the second of the decision door's two
 * keys — the first being the owner credential the request arrived with. The proposer never
 * receives it (`criteriaUnchangedNotice` hands back an address and nothing that could act on one),
 * so this read is the ONLY place it leaves the database, and that is the whole of the argument
 * that a decision card is authorised by the server rather than typed by an agent: the browser can
 * press the button because the server gave the owner the key, not because the card said so.
 */
export interface OwnerPendingCriteriaDecision extends PendingCriteriaDecision {
  commitToken: string;
}

/** The queue above, on the owner's path, where every row carries its key. */
export interface OwnerPendingCriteriaDecisionQueue
  extends Omit<PendingCriteriaDecisionQueue, 'pending'> {
  pending: OwnerPendingCriteriaDecision[];
}

/**
 * The same derivation, for the one reader that may hold the keys.
 *
 * WHY THIS IS A SECOND FUNCTION AND NOT A FLAG ON THE FIRST
 * ---------------------------------------------------------
 * `readPendingCriteriaDecisions` answers whoever asks it, and until 2026-09-10 an agent was sent a
 * card composed from it. So the requirement is not "the token is usually absent there" but
 * "the token cannot be there": the query above never SELECTs `commit_token` at all, and no
 * argument to it can make it. What separates the two paths is therefore a fact about which columns
 * were read, which is checkable by looking, rather than a branch somebody has to keep correct.
 *
 * WHY THE KEYS ARE A SECOND QUERY AND NOT A JOIN
 * ----------------------------------------------
 * For the same reason. Which proposals are pending is derived in exactly one place; this adds a
 * column to the rows that derivation already picked, and cannot disagree with it about which rows
 * those are. A proposal answered between the two reads comes back carrying a key the door will
 * refuse as `ALREADY_SETTLED`, which is the ordinary answer to a card rendered a moment too early
 * — the door re-reads under the project lock, and it, not this, is what decides.
 *
 * IT DOES NOT CHECK WHO IS ASKING. The caller does: `ProjectsService.pendingCriteriaDecisions` is
 * where the owner-channel rule is applied, on the same rail as the door it hands the keys to.
 */
export async function readPendingCriteriaDecisionsForOwner(
  tx: Prisma.TransactionClient,
  ownerId: string,
  projectId: string,
  readAt: Date = new Date(),
): Promise<OwnerPendingCriteriaDecisionQueue> {
  const queue = await readPendingCriteriaDecisions(tx, ownerId, projectId, readAt);
  if (queue.pending.length === 0) return { ...queue, pending: [] };
  const keys = new Map(
    (await tx.projectRatifiedActionIntent.findMany({
      where: { ownerId, projectId, id: { in: queue.pending.map((row) => row.intentId) } },
      select: { id: true, commitToken: true },
    })).map((row) => [row.id, row.commitToken]),
  );
  return {
    ...queue,
    // The fallback is unreachable rather than defensive: 0195's BEFORE UPDATE OR DELETE trigger
    // refuses every write to a filed intent, so the row each of these ids came from a moment ago is
    // still there. It is spelled as a fallback because a `!` here would be a claim about that
    // trigger made in a file that cannot see it.
    pending: queue.pending.map((row) => ({
      ...row,
      commitToken: keys.get(row.intentId) ?? '',
    })),
  };
}

/**
 * "Somebody answered this proposal", as one SQL clause — the same sentence `settledIntentIds`
 * says, for the callers that have to ask it of the database inside a query rather than of rows
 * they already hold.
 *
 * IT IS EXPORTED SO THAT THERE IS ONE OF IT. The write path asks the same question from the other
 * side: before filing a proposal, `ProjectsService.pendingWeakeningProposal` has to know whether
 * the one already on record is still a question, and it asks that in raw SQL because the answer
 * has to be part of the `ORDER BY ... LIMIT 1` rather than a filter applied to whatever that
 * picked. Written out there as well as here, the two would be free to disagree about what
 * "answered" means — and the disagreement is not cosmetic: the read would stop showing a proposal
 * the write path still treats as pending, so the owner would have no card for a proposal that is
 * blocking the next edit. So the clause lives here, beside the definition it belongs to, and the
 * write path composes it.
 *
 * A FRAGMENT AND NOT A SECOND QUERY, deliberately: the caller runs one `$queryRaw` and must go on
 * running one. `intentAlias` is however the calling query names the intent row; it cannot be bound
 * as a parameter, so it is raw the way `common/session-tree-sql.ts` takes its aliases — every
 * caller passes a literal of its own.
 */
export function criteriaDecisionRecorded(intentAlias: string): Prisma.Sql {
  const i = Prisma.raw(intentAlias);
  return Prisma.sql`EXISTS (
           SELECT 1 FROM "project_criteria_decision" d WHERE d."intent_id" = ${i}."id")`;
}

/**
 * Which of these proposals have been answered — THE one place that sentence is defined.
 *
 * TWO LANDINGS, ONE SENTENCE, and neither is a superset of the other:
 *
 *   * `project_criteria_decision` is the decision door's own row, and it is where BOTH outcomes of
 *     an answer land. Its primary key IS the intent id, so a proposal carries at most one and the
 *     database rather than this function is what makes "answered twice" impossible. `decision` is
 *     deliberately NOT read: APPROVE and REJECT are one predicate here, because a proposal that was
 *     turned down is as answered as one that was applied. Splitting them would put a rejected
 *     proposal back on the owner's card as a question they have already answered — which is the
 *     hole this function was written around and no longer has, now that the door exists.
 *   * `project_ratified_action_commit` is 0195's own landing, written by the generic two-phase
 *     machine — and by this door beside the decision, for an APPROVE. A proposal committed through
 *     that machine rather than through this door has no decision row, so this half is not
 *     redundant: dropping it would make a committed proposal a question again.
 *
 * Two primary-key reads over the ids this caller already holds rather than one join, so the union
 * is computed where both halves are visible instead of on the wrong side of an outer join.
 *
 * `criteriaDecisionRecorded` above is the decision half as SQL, for the write path that has to ask
 * it inside a query it is already running; this is that same sentence for the caller that holds the
 * rows. The two are one rule stated twice in the one file that defines it.
 */
async function settledIntentIds(
  tx: Prisma.TransactionClient,
  intentIds: readonly string[],
): Promise<Set<string>> {
  const ids = [...intentIds];
  const decisions = await tx.projectCriteriaDecision.findMany({
    where: { intentId: { in: ids } },
    select: { intentId: true },
  });
  const commits = await tx.projectRatifiedActionCommit.findMany({
    where: { intentId: { in: ids } },
    select: { intentId: true },
  });
  return new Set([
    ...decisions.map((decision) => decision.intentId),
    ...commits.map((commit) => commit.intentId),
  ]);
}

/**
 * The standard set in force, read off the definition rows the trigger maintains: its seal, and the
 * words behind that seal.
 *
 * Both come back together because both are answers about the SAME rows at the SAME moment. The
 * seal decides whether a proposal is still decidable and the words decide what it would change;
 * taken from two reads they could disagree, and the disagreement would surface as a card that
 * says a decision is live beside a diff against a ruler that has already moved.
 */
async function standardSetInForce(
  tx: Prisma.TransactionClient,
  projectId: string,
): Promise<{ seal: string; criteria: StatedAcceptanceCriterion[] }> {
  const definitions = await tx.projectAcceptanceCriterionDefinition.findMany({
    where: { projectId },
    orderBy: { ordinal: 'asc' },
    select: {
      id: true,
      ordinal: true,
      text: true,
      verificationMethod: true,
      completionCriterionOverrideReason: true,
      revision: true,
      contentHash: true,
    },
  });
  const criteria = criteriaFromDefinitions(definitions);
  return { seal: standardSetVersion(criteria).digest, criteria };
}
