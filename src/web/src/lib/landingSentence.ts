import type { IntegrationTimelineEntry, ProjectPromotionView, SessionLandingView } from '@orbit/shared';
import { mainBranchName } from './projectStart';
import type { LandingStep } from './landingSteps';

/**
 * A landing as a chat turn's reply (owner 2026-11-11, docs/mocks/landings-chat-turns): one plain sentence that says how the
 * landing ended — the task in bold, the line and the commit as code — under the turn's steps. The words are these, the same on
 * every client (OrbitKit `LandingSentenceCopy`, Kotlin `LandingSentenceCopy`); the facts are the landing view's fields: the
 * settled state, the result line's `landedSha`, the attempt's `targetRef`, the count of attempts. Nothing is read out of a
 * server sentence.
 */
export const LANDING_SENTENCE_COPY = {
  LANDED: 'Landed',
  ON: 'on',
  ON_THE_SECOND_TRY: 'on the second try',
  ON_TRY: 'on try',
  MERGED: 'Merged',
  INTO: 'into',
  ALREADY_LANDED: 'Already landed:',
  WAS_ON_THE_LINE: 'was on the project line before this landing',
  NOTHING_TO_LAND_FOR: 'Nothing to land for',
  NO_COMMITS: 'its branch has no commits beyond the project line',
  DID_NOT_LAND: 'Did not land',
  AND_NOTHING_WAS_PUSHED: 'and nothing was pushed',
  STOPPED_LANDING: 'Stopped landing',
  LANDING: 'Landing',
  STEPS: 'steps',
  STEP: 'step',
  GENERATION: 'Generation',
  FAILED: 'failed',
} as const;

/** One run of a sentence: plain, the task in bold, or a line or commit as code. */
export interface SentencePart {
  text: string;
  strong?: boolean;
  code?: boolean;
}

/** How a landing stands, for its sentence. */
export type SentenceKind = 'LANDED' | 'ALREADY_LANDED' | 'NOTHING_TO_LAND' | 'MERGED' | 'NOT_LANDED' | 'STOPPED' | 'RUNNING';

export interface SentenceFacts {
  kind: SentenceKind;
  /** The task's name, or the round's own title. */
  task: string;
  /** The line it landed on (`project/…`) and the commit; null where the landing's view was not read yet. */
  line?: string | null;
  sha?: string | null;
  /** How many attempts it took; 2 says `on the second try`. */
  tries?: number;
  /** A merge into main: its tasks, its commit, whether Orbit merged it, and main's name. */
  merge?: { tasks: number; sha: string | null; automatic: boolean; main: string } | null;
  /** Why it did not land: the card's own failure sentence. */
  reason?: string | null;
  nothingPushed?: boolean;
}

const plain = (text: string): SentencePart => ({ text });
const strong = (text: string): SentencePart => ({ text, strong: true });
const code = (text: string): SentencePart => ({ text, code: true });

/** The sentence, run by run. */
export function landingSentence(facts: SentenceFacts): SentencePart[] {
  const C = LANDING_SENTENCE_COPY;
  const where = (): SentencePart[] => {
    const parts: SentencePart[] = [];
    if (facts.line) parts.push(plain(` ${C.ON} `), code(facts.line));
    if (facts.sha) parts.push(plain(' · '), code(facts.sha));
    return parts;
  };
  switch (facts.kind) {
    case 'LANDED': {
      const tries = facts.tries ?? 1;
      const after = tries === 2 ? `, ${C.ON_THE_SECOND_TRY}` : tries > 2 ? `, ${C.ON_TRY} ${tries}` : '';
      return [plain(`${C.LANDED} `), strong(facts.task), ...where(), plain(`${after}.`)];
    }
    case 'MERGED': {
      const merge = facts.merge;
      if (!merge) return [plain(`${C.MERGED} ${C.INTO} `), strong(facts.task), plain('.')];
      const tasks = `${merge.tasks} ${merge.tasks === 1 ? 'task' : 'tasks'}`;
      return [
        plain(`${C.MERGED} `), strong(tasks), plain(` ${C.INTO} ${merge.main}`),
        ...(merge.sha ? [plain(' · '), code(merge.sha)] : []),
        plain(` · ${merge.automatic ? 'automatically' : 'by you'}.`),
      ];
    }
    case 'ALREADY_LANDED':
      return [plain(`${C.ALREADY_LANDED} `), strong(facts.task), plain(` ${C.WAS_ON_THE_LINE}.`)];
    case 'NOTHING_TO_LAND':
      return [plain(`${C.NOTHING_TO_LAND_FOR} `), strong(facts.task), plain(`: ${C.NO_COMMITS}.`)];
    case 'NOT_LANDED': {
      // The card's failure sentence already says whether anything was pushed; only without one does the sentence say it.
      const reason = (facts.reason ?? '').replace(/\.+$/u, '');
      const tail = reason ? lowerFirst(reason) : facts.nothingPushed ? C.AND_NOTHING_WAS_PUSHED.replace(/^and /u, '') : '';
      return [plain(`${C.DID_NOT_LAND} `), strong(facts.task), plain(tail ? `: ${tail}.` : '.')];
    }
    case 'STOPPED':
      return [plain(`${C.STOPPED_LANDING} `), strong(facts.task), plain('.')];
    case 'RUNNING':
      return [plain(`${C.LANDING} `), strong(facts.task), ...(facts.line ? [plain(` ${C.ON} `), code(facts.line)] : []), plain('…')];
  }
}

/** The plain text of a sentence: what a screen reader and a copy hear. */
export function sentenceText(parts: readonly SentencePart[]): string {
  return parts.map((part) => part.text).join('');
}

function lowerFirst(text: string): string {
  // A sentence's own clause after a colon: `Merge check exited 1` reads `merge check exited 1`.
  return /^[A-Z][a-z]/u.test(text) ? `${text[0].toLowerCase()}${text.slice(1)}` : text;
}

/** The result line of the landing's newest attempt, where it has one. */
function lastResult(landing: SessionLandingView): IntegrationTimelineEntry | null {
  const sections = landing.timeline?.sections ?? [];
  for (let i = sections.length - 1; i >= 0; i -= 1) {
    const entries = sections[i].entries;
    for (let j = entries.length - 1; j >= 0; j -= 1) {
      if (entries[j].kind === 'RESULT' || entries[j].kind === 'RESULT_FALLBACK') return entries[j];
    }
  }
  return null;
}

/** The kind a settled landing's `settledAs` says. */
export function settledSentenceKind(settledAs: string | null | undefined): SentenceKind {
  switch (settledAs) {
    case 'LANDED': return 'LANDED';
    case 'MERGED': return 'MERGED';
    case 'ALREADY_LANDED': return 'ALREADY_LANDED';
    case 'NOTHING_TO_LAND': return 'NOTHING_TO_LAND';
    default: return 'STOPPED';
  }
}

/** The facts a landing's sentence takes from its own view (when read) and its round's merged record. */
export function sentenceFacts(input: {
  kind: SentenceKind;
  task: string;
  landing: SessionLandingView | null;
  promotion?: ProjectPromotionView | null;
  reason?: string | null;
  nothingPushed?: boolean;
}): SentenceFacts {
  const landing = input.landing;
  const result = landing ? lastResult(landing) : null;
  const sha = typeof result?.data?.landedSha === 'string' ? result.data.landedSha
    : typeof result?.data?.targetShaBefore === 'string' ? result.data.targetShaBefore : null;
  const targetRef = landing?.currentAttempt?.targetRef ?? null;
  const promotion = input.promotion ?? null;
  return {
    kind: input.kind,
    task: input.task,
    line: targetRef ? mainBranchName(targetRef) : null,
    sha: sha ? sha.slice(0, 7) : null,
    tries: landing?.timeline?.sections.length ?? 1,
    merge: promotion ? {
      tasks: promotion.taskIds.length,
      sha: promotion.merged ? promotion.merged.sha.slice(0, 7) : null,
      automatic: promotion.merged?.automatic === true,
      main: mainBranchName(promotion.upstreamRef),
    } : null,
    reason: input.reason ?? null,
    nothingPushed: input.nothingPushed ?? false,
  };
}

/** The steps line of one attempt, as the chat's `ran 8 shell commands`: `5 steps`; `Generation 2 · 5 steps` when a task's
 *  landing took several; a merge round's own section title (`Merge check · 1 · 2 steps`), since its sections are its check and
 *  its merge. The failed count rides beside it, in red, as the chat's `· 1 failed`. */
export function stepsLabel(steps: readonly LandingStep[], section: { generation: number; title: string; kind: string },
  several: boolean): string {
  const C = LANDING_SENTENCE_COPY;
  const count = `${steps.length} ${steps.length === 1 ? C.STEP : C.STEPS}`;
  if (!several) return count;
  return section.kind === 'LAND_TASK' ? `${C.GENERATION} ${section.generation} · ${count}` : `${section.title} · ${count}`;
}
