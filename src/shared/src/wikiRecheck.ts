// Orbit Wiki's claim recheck (contracts/wiki.contract.json `claimStates` and `maintenance.job.server.recheck`,
// docs/wiki-claim-recheck-design.md): an anchor check says an entry's files are still there; this asks whether what
// the entry SAYS is still true once main changes those files. wikiContract.spec.ts holds every constant below to the
// contract JSON, and wiki-schema.pg.spec.ts holds the states to the CHECK of migration 0481.

/**
 * What the last ask found of an entry's claim (contract `claimStates`). `unchecked` until it is first asked; `holds`
 * and `unsure` change nothing; `fixed` and `obsolete` take it out of agents' search and file a challenge.
 */
export const WIKI_CLAIM_STATES = ['unchecked', 'holds', 'fixed', 'obsolete', 'unsure'] as const;
export type WikiClaimState = (typeof WIKI_CLAIM_STATES)[number];

/** What one answer of the System model may say (`recheck.answer`). */
export const WIKI_RECHECK_VERDICTS = ['holds', 'fixed', 'obsolete', 'unsure'] as const;
export type WikiRecheckVerdict = (typeof WIKI_RECHECK_VERDICTS)[number];

/** The states agents' search leaves out (`recheck.effect.search`): two answers agreed the entry no longer holds. */
export const WIKI_CLAIM_HIDDEN_STATES: readonly WikiClaimState[] = ['fixed', 'obsolete'];

/**
 * The screen's ranks (`recheck.screen.ranks`), lowest asked first: 0 an entry written in the last day with any
 * signal since its earliest source; 1 a term no longer in any of its paths, or one of its paths itself added, deleted
 * or renamed; 2 the number of lines holding one of its terms changed; 3 its paths changed and its terms did not.
 */
export const WIKI_RECHECK_RANKS = { fresh: 0, vanished: 1, census: 2, touched: 3 } as const;
export type WikiRecheckRank = (typeof WIKI_RECHECK_RANKS)[keyof typeof WIKI_RECHECK_RANKS];

/** The numbers the recheck runs by (`recheck.rules`); the owner chose the budget on 2026-11-06 (design §9 D2). */
export const WIKI_RECHECK = {
  /** The queue step its model calls are filed under; units are the entry's id and `<id>#second`. */
  step: 'recheck',
  /** The kinds whose claim is about the code. */
  kinds: ['pitfall', 'decision', 'convention'],
  /** Entries asked a run at most: the budget. */
  asksMax: 20,
  /** An entry asked within this many days waits, whatever its rank. */
  askIntervalDays: 7,
  /** Never-screened entries a run screens from their earliest source, newest first. */
  screenMax: 400,
  /** Entries one screen operation carries, and asked ones one detail operation carries (the runner's limits). */
  screenOpMax: 500,
  detailOpMax: 40,
  /** An entry written this recently ranks 0 when its screen shows any signal. */
  freshHours: 24,
  /** Terms taken from an entry, commits, lines and diff bytes one answer carries. */
  termsMax: 8,
  commitsMax: 20,
  linesMax: 40,
  diffBytes: 6000,
  /**
   * The changes one answer carries (`repoOps.kindRuns.history`): commits that changed how often a term occurs, each
   * with its message's body and its own patch with `changeContext` lines of context, cut to `changeBytes`, all the
   * patches within `changesBytes`; a change is given only while `changeMinBytes` of that are left.
   */
  changesMax: 8,
  bodyRunes: 600,
  changeContext: 8,
  changeBytes: 2500,
  changesBytes: 12000,
  changeMinBytes: 500,
  /** One ask's max_tokens: one JSON object with a one-sentence reason. */
  maxTokens: 1024,
} as const;

/** One entry of a `history` repository operation (contract `repoOps.kindRuns.history`). */
export interface WikiHistoryRequestEntry {
  id: string;
  /** The commit it was screened or asked at last; absent for a first screen, which names `since`. */
  from?: string;
  /** The time to look back to: the first-parent commit of main before it is the base. */
  since?: string;
  paths: string[];
  terms: string[];
  /** Asked: commits, lines, the diff and the changes besides the census. */
  detail: boolean;
}

/** A path with one of these is a pattern (`*`, `?` within one directory, `**` across any number), not a file. */
export const WIKI_RECHECK_PATTERN = /[*?[]/u;

/** One commit that changed how often a term occurs in the entry's paths, as the model reads it. */
export interface WikiHistoryChange {
  sha: string;
  date: string;
  subject: string;
  /** The terms git log -S found it changed, in the entry's order. */
  terms: string[];
  body: string;
  /** Its own patch of the entry's paths against its first parent, the hunks holding a term first. */
  diff: string;
  diffTruncated: boolean;
}

/** What the runner answers for one entry. */
export interface WikiHistoryAnswerEntry {
  id: string;
  error?: string;
  base?: string;
  baseDate?: string;
  census?: Array<{ term: string; base: number; head: number }>;
  moved?: string[];
  /** The entry's paths differ between the base and the head at all. */
  changed?: boolean;
  commits?: Array<{ sha: string; date: string; subject: string; matched: boolean }>;
  commitsTotal?: number;
  lines?: Array<{ path: string; line: number; text: string }>;
  linesTotal?: number;
  diff?: string;
  diffTruncated?: boolean;
  /** Absent from a runner older than the changes: the question then has no CHANGES section. */
  changes?: WikiHistoryChange[];
  changesTotal?: number;
}

/** The whole answer, under the result's `history`. */
export interface WikiHistoryAnswer {
  sha: string;
  date: string;
  entries: WikiHistoryAnswerEntry[];
}

/** What a recheck wrote of one entry, kept as the entry's `claim_check` (`recheck.storage`). */
export interface WikiClaimCheck {
  verdict: WikiRecheckVerdict;
  /** The commit the verdict was made at, and the base the material ran from. */
  ref: string;
  base: string;
  /** The commit the answer named, with its date and subject; null when none. */
  commit: { sha: string; date: string; subject: string } | null;
  reason: string;
  /** Fixed or obsolete before the entry was recorded: wrong the moment it was written. */
  wrongWhenRecorded: boolean;
  /** Each ask's label, in order: one for holds or unsure, two otherwise. */
  answers: WikiRecheckVerdict[];
  /** Re-confirmed by the owner after a fixed or obsolete verdict. */
  ownerReconfirmed?: boolean;
}
