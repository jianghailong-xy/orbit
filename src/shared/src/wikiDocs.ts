// Orbit Wiki's documents (contracts/wiki.contract.json `docs`, migration 0326, criterion 9 revised
// 2026-09-28): a space's documents, written section by section from the plan its owner confirmed
// (`wikiPlan.ts`), every footnote pointing at a first-hand original with its verbatim quote, and the
// entry it was found through kept as the via entry. wikiContract.spec.ts holds every constant below to
// the contract JSON.

import type { WikiAnchorState, WikiEntryKind, WikiEntryStatus, WikiTrust } from './wiki';
import type { WikiPlanSectionKind, WikiPlanSessionCondition } from './wikiPlan';

/** `needs_review`: more than `rules.needsReviewAbove` of its sentences are unsourced or unverified. */
export const WIKI_DOC_STATUSES = ['ok', 'needs_review'] as const;
export type WikiDocStatus = (typeof WIKI_DOC_STATUSES)[number];

/**
 * What one sentence is (contract `docs.sentenceStatuses`): backed by a verified footnote; a transition
 * or summary that brings no fact the document's sourced sentences and headings do not already carry;
 * a fact with no footnote; a sentence whose every footnote failed its check; and a sentence whose via
 * entry was rejected, retired, superseded or lost its anchor, waiting for its section to be rewritten.
 */
export const WIKI_DOC_SENTENCE_STATUSES = ['sourced', 'transition', 'unsourced', 'unverified', 'withdrawn'] as const;
export type WikiDocSentenceStatus = (typeof WIKI_DOC_SENTENCE_STATUSES)[number];

/** The originals in the repository, which only a checkout holds: the runner checks them, at a sha. */
export const WIKI_DOC_REPO_KINDS = ['design_doc', 'code', 'contract'] as const;
export type WikiDocRepoKind = (typeof WIKI_DOC_REPO_KINDS)[number];

/** Orbit's own first-hand records, which the server reads again, redacts, and checks itself. */
export const WIKI_DOC_RECORD_KINDS = [
  'turn',
  'event',
  'tool_call',
  'task',
  'task_comment',
  'approval',
  'owner_decision',
  'merge_receipt',
  'note',
] as const;
export type WikiDocRecordKind = (typeof WIKI_DOC_RECORD_KINDS)[number];

export const WIKI_DOC_FOOTNOTE_KINDS = [...WIKI_DOC_REPO_KINDS, ...WIKI_DOC_RECORD_KINDS] as const;
export type WikiDocFootnoteKind = (typeof WIKI_DOC_FOOTNOTE_KINDS)[number];

/**
 * A footnote's check (contract `docs.verdicts`): its quote is in the original; it is not; it gave no
 * quote to check; or the record it names is not one of this account's (a repository footnote is
 * never unresolved: the runner read it at its sha).
 */
export const WIKI_DOC_VERDICTS = ['verified', 'not_found', 'no_quote', 'unresolved'] as const;
export type WikiDocVerdict = (typeof WIKI_DOC_VERDICTS)[number];

/** Who checked a footnote: the server, which re-read the record, or the runner, at the sha. */
export const WIKI_DOC_CHECKERS = ['server', 'runner'] as const;
export type WikiDocChecker = (typeof WIKI_DOC_CHECKERS)[number];

/**
 * Why a sentence was withdrawn: what happened to the entry it came through — or, as anchor_missing, that
 * the repository file it cites was deleted or renamed on origin/main.
 */
export const WIKI_DOC_WITHDRAW_REASONS = ['rejected', 'retired', 'superseded', 'anchor_changed', 'anchor_missing'] as const;
export type WikiDocWithdrawReason = (typeof WIKI_DOC_WITHDRAW_REASONS)[number];

/**
 * What became of one piece of a section's material (contract `docs.dispositionActions`): the model's
 * merge adopted it, folded it into another piece, or dropped it; or the runner never handed it over —
 * the section's material was full, or a rule took it out (a platform template, a repeated text).
 */
export const WIKI_DOC_DISPOSITION_ACTIONS = ['adopt', 'merge', 'drop', 'over_cap', 'filtered'] as const;
export type WikiDocDispositionAction = (typeof WIKI_DOC_DISPOSITION_ACTIONS)[number];

/**
 * The evidence weight the merge reads a record with (contract `docs.material.weights`), heaviest first:
 * the owner's decision, a record of what was merged or delivered, a command's output, an error.
 */
export const WIKI_DOC_MATERIAL_WEIGHTS = ['decision', 'merge', 'output', 'error', 'other'] as const;
export type WikiDocMaterialWeight = (typeof WIKI_DOC_MATERIAL_WEIGHTS)[number];

/** The numbers the server's half of a section's material is gathered by (contract `docs.material.rules`). */
export const WIKI_DOC_MATERIAL_RULES = {
  entriesPerSection: 6,
  sourcesPerEntry: 3,
  ownerTurnsPerSection: 6,
  commentsPerSection: 4,
  /** A longer record is returned as this many characters around what found it. */
  excerptChars: 1_100,
} as const;

/** The numbers `orbit wiki docs build` holds a section to (contract `docs.build.rules`). */
export const WIKI_DOC_BUILD_RULES = {
  materialMaxChars: 22_000,
  materialHeaderChars: 120,
  parallel: 4,
} as const;

/**
 * The documents built on the server (contract `docs.build.server`, `jobs.kindRuns.docs_build`; design §8, P7): for
 * an account the executor switch gives the server, the owner's confirmation of a plan version makes a `docs_build`
 * job of the wiki-worker instead of a task of the hidden list, and the System model writes through the queue.
 */
export const WIKI_DOCS_BUILD_JOB = {
  kind: 'docs_build',
  /** Asked for by the owner's confirmation: owner-initiated work, above background maintenance (contract `jobs.priority`). */
  priority: 1,
  /** The queue's step of each call; `docs_*` is the documents' wait limit and call budget (modelQueue). */
  steps: { merge: 'docs_merge', write: 'docs_write', rewrite: 'docs_rewrite', quotes: 'docs_quotes', overview: 'docs_overview' },
  /** One call's max_tokens: a section of a few thousand characters and its quotes, with room to spare. */
  maxTokens: 8192,
  /** How long the job waits for the snapshot that names the commit it reads, and for one read of files at it. */
  repoWaitSeconds: 300,
  /** Reads of one job in flight at once: each is a fetch in the same checkout on the space's runner. */
  readsInFlight: 2,
  /** A read that failed is asked again this many times in all before the attempt is the platform's failure. */
  readAttempts: 3,
} as const;

/** A section's blocks: paragraphs and list items hold sentences; a heading or a code block its text. */
export const WIKI_DOC_BLOCK_KINDS = ['paragraph', 'item', 'heading', 'code'] as const;
export type WikiDocBlockKind = (typeof WIKI_DOC_BLOCK_KINDS)[number];

/** The numbers a document write is held to (contract `docs.rules`). */
export const WIKI_DOC_RULES = {
  /** A document whose unsourced and unverified sentences are more than this share of all is marked. */
  needsReviewAbove: 0.05,
  /** A quote shorter than this, once normalized, is not checked: it is found anywhere. */
  quoteMinChars: 4,
  quoteMaxChars: 1_000,
  /** The lines a repository quote was taken from. */
  excerptMaxChars: 4_000,
  markdownMaxChars: 20_000,
  /** The sections one write carries: a plan document's `plan.rules.sectionsMax`. */
  sectionsPerWrite: 20,
  footnotesPerSection: 200,
  /** A path, a docs section, a symbol, a record id. */
  textMaxChars: 1_000,
  /** The most errors one refusal lists; the message counts them all. */
  errorsMax: 200,
  /** The pieces of material one section's ledger lists, and the longest reason one gives. */
  dispositionsPerSection: 200,
  reasonMaxChars: 500,
} as const;

/**
 * A written document's lead on the directory (contract `docs.lead`): the first sentences of its first
 * section, withdrawn ones skipped, and cut to this many characters with an ellipsis when longer.
 */
export const WIKI_DOC_LEAD_RULES = {
  sentences: 2,
  maxChars: 200,
} as const;

/**
 * Every field a write may carry, at each level (contract `docs.schema`). Anything else is refused
 * WIKI_DOC_INVALID. A repository footnote and a record footnote are told apart by their kind.
 */
export const WIKI_DOC_SCHEMA = {
  write: ['planVersion', 'repoSha', 'model', 'sections'],
  section: ['key', 'materialSha256', 'markdown', 'footnotes', 'dispositions'],
  repoFootnote: ['kind', 'path', 'sha', 'lines', 'section', 'symbol', 'quote', 'excerpt', 'verified', 'viaEntryId'],
  recordFootnote: ['kind', 'ref', 'chars', 'quote', 'viaEntryId'],
  lines: ['start', 'end'],
  chars: ['start', 'end'],
  disposition: ['material', 'kind', 'ref', 'action', 'into', 'reason'],
} as const;
export type WikiDocSchemaLevel = keyof typeof WIKI_DOC_SCHEMA;

// ── What a maintenance run writes ───────────────────────────────────────────────────────────────

/** A design-document section, code or a contract, as the runner read it at `sha`. */
export interface WikiDocRepoFootnoteInput {
  kind: WikiDocRepoKind;
  /** Relative to the repository. */
  path: string;
  /** The commit it was read at: required, 7–64 lowercase hex. */
  sha: string;
  /** 1-based and inclusive. */
  lines: { start: number; end: number };
  /** A design document's section heading. */
  section?: string | null;
  /** A code symbol. */
  symbol?: string | null;
  quote?: string | null;
  /** The quoted lines as the runner read them, for the page to show. */
  excerpt?: string | null;
  /** The runner's own check of the quote against those lines. */
  verified: boolean;
  viaEntryId?: string | null;
}

/** One of this account's records; the server reads it again, redacts it, and checks the quote itself. */
export interface WikiDocRecordFootnoteInput {
  kind: WikiDocRecordKind;
  /** The record's id. */
  ref: string;
  /** Where to look, in code points of the record's redacted text; the whole record when left out. */
  chars?: { start: number; end: number } | null;
  quote?: string | null;
  viaEntryId?: string | null;
}

export type WikiDocFootnoteInput = WikiDocRepoFootnoteInput | WikiDocRecordFootnoteInput;

/** What became of one piece of a section's material (contract `docs.dispositions`). */
export interface WikiDocDisposition {
  /** The id the runner gave it in the section: `D1`, `C2`, `K1`, `S3`. */
  material: string;
  kind: WikiDocFootnoteKind;
  /** A repository path with its lines (`path#L12-40`), or a record's id. */
  ref: string;
  action: WikiDocDispositionAction;
  /** The piece it was merged into: set exactly for `merge`. */
  into: string | null;
  reason: string;
}

export interface WikiDocSectionInput {
  /** The plan section's key. */
  key: string;
  /** The runner's fingerprint of the section's plan definition and the material it gathered. */
  materialSha256: string;
  /** The section's body: Markdown with footnote markers `[n]`, n naming `footnotes[n-1]`. */
  markdown: string;
  footnotes: WikiDocFootnoteInput[];
  /** What became of each piece of its material; stored with the section as it came. */
  dispositions?: WikiDocDisposition[];
}

/** `POST /api/runner/wiki/spaces/:id/docs/:slug`. */
export interface WikiDocWriteRequest {
  /** The confirmed plan version it was written from. */
  planVersion: number;
  /**
   * The origin/main commit (40 lowercase hex) the run read the repository at. Every section written is
   * stored with it: a later maintenance run compares it with origin/main, and writes again a section
   * whose design documents, code or contracts changed since.
   */
  repoSha: string;
  model?: string | null;
  sections: WikiDocSectionInput[];
}

export interface WikiDocSentenceCounts {
  sentences: number;
  sourced: number;
  transition: number;
  unsourced: number;
  unverified: number;
  withdrawn: number;
}

/** What one section's write did (`wiki_doc_section.stats`). */
export interface WikiDocSectionStats {
  sentences: number;
  footnotes: number;
  verified: number;
  notFound: number;
  noQuote: number;
  unresolved: number;
  /** Markers that named no footnote of the section, taken out of the text. */
  markersDropped: number;
  /** Characters (code points) of its sentences, markers left out. */
  chars: number;
}

/** The write's answer. */
export interface WikiDocWriteResult {
  spaceId: string;
  slug: string;
  docId: string;
  planVersion: number;
  status: WikiDocStatus;
  /** `unchanged`: its material's fingerprint was the stored one, and nothing of it was withdrawn. */
  sections: Array<{ key: string; outcome: 'written' | 'unchanged'; stats: WikiDocSectionStats | null }>;
  counts: WikiDocSentenceCounts;
}

/** `GET /api/runner/wiki/spaces/:id/docs`: what is written, for a run to tell what to write again. */
export interface WikiDocsWriterState {
  spaceId: string;
  /** The confirmed plan's version, or null while there is none. */
  planVersion: number | null;
  docs: Array<{
    slug: string;
    /** The version it was last written from. */
    planVersion: number;
    status: WikiDocStatus;
    /** The origin/main commit its last write read the repository at. */
    repoSha: string;
    updatedAt: string;
    /** Each written section, with the origin/main commit it was generated at. */
    sections: Array<{ key: string; materialSha256: string; repoSha: string; stale: boolean; generatedAt: string }>;
  }>;
}

// ── What the owner reads ────────────────────────────────────────────────────────────────────────

export interface WikiDocsDirectorySection {
  key: string;
  /** 1… in the plan document's order. */
  number: number;
  title: string;
  kind: WikiPlanSectionKind;
  written: boolean;
  stale: boolean;
}

export interface WikiDocsDirectoryDoc {
  slug: string;
  /** `<category number>.<its place in the category>`, both from 1: `3.1`. */
  number: string;
  title: string;
  question: string;
  written: boolean;
  /** Null until it is written. */
  status: WikiDocStatus | null;
  updatedAt: string | null;
  /** The plan version it was written from. */
  planVersion: number | null;
  /**
   * Its two lines on the home (`WIKI_DOC_LEAD_RULES`): null until it is written, and while its first section
   * has no sentence that is not withdrawn. Absent from a server older than it.
   */
  lead?: string | null;
  sections: WikiDocsDirectorySection[];
}

/** `GET /api/wiki/spaces/:id/docs`: the confirmed plan's categories and documents, as written so far. */
export interface WikiDocsDirectory {
  spaceId: string;
  plan: { version: number; confirmedAt: string } | null;
  docs: { total: number; written: number };
  categories: Array<{
    key: string;
    number: number;
    title: string;
    question: string;
    forAgents: boolean;
    docs: WikiDocsDirectoryDoc[];
  }>;
}

export interface WikiDocSentenceView {
  text: string;
  status: WikiDocSentenceStatus;
  /** The document's footnote numbers it carries. */
  notes: number[];
  /** An unsourced sentence's fact tokens no sourced sentence or heading carries. */
  newTokens: string[];
  /** Once withdrawn: why and when, and what withdrew it — the entry it came through, or the file it cited. */
  withdrawn: { reason: WikiDocWithdrawReason; entryId: string | null; path: string | null; at: string } | null;
}

export interface WikiDocBlockView {
  kind: WikiDocBlockKind;
  /** A heading's or a code block's text; null for a paragraph or a list item, which hold sentences. */
  text: string | null;
  sentences: WikiDocSentenceView[];
}

export interface WikiDocSectionView {
  key: string;
  number: number;
  title: string;
  kind: WikiPlanSectionKind;
  written: boolean;
  /** A sentence of it was withdrawn: the next maintenance run writes it again. */
  stale: boolean;
  staleAt: string | null;
  generatedAt: string | null;
  /** The origin/main commit it was generated at. */
  repoSha: string | null;
  model: string | null;
  /** What became of each piece of its material when it was written (none for a section not written yet). */
  dispositions: WikiDocDisposition[];
  blocks: WikiDocBlockView[];
}

/** One footnote of the document, numbered by first appearance and resolved for the page. */
export interface WikiDocFootnoteView {
  n: number;
  kind: WikiDocFootnoteKind;
  verdict: WikiDocVerdict;
  checkedBy: WikiDocChecker;
  quote: string | null;
  /** `path@sha#L12-20`, or `<kind>:<record id>#c40-96`. */
  location: string;
  // A repository original.
  path: string | null;
  sha: string | null;
  lineStart: number | null;
  lineEnd: number | null;
  section: string | null;
  symbol: string | null;
  excerpt: string | null;
  // A record: where it is, and what the page links to (contract `docs.links`). A turn's, an event's or
  // a tool call's footnote carries `recordId` AND `sessionId`: `wiki_source` keeps a record's id alone,
  // and the deep link needs both — web `sessionRecordHref(sessionId, recordId)`, iOS
  // `SessionRecordLink.url(session:record:)`, served by `GET /api/sessions/:id/events/page?around=<recordId>`.
  recordId: string | null;
  charStart: number | null;
  charEnd: number | null;
  sessionId: string | null;
  sessionTitle: string | null;
  /** A turn's or an event's number in its session. */
  seq: number | null;
  at: string | null;
  /** A turn's kind, an event's type, a tool's name, a comment's author, a receipt's result. */
  label: string | null;
  taskId: string | null;
  taskTitle: string | null;
  projectId: string | null;
  projectTitle: string | null;
  notePath: string | null;
  viaEntryId: string | null;
}

/** An entry the document's quotes came through, as it stands now, with the footnotes it carried. */
export interface WikiDocViaEntry {
  id: string;
  kind: WikiEntryKind;
  title: string;
  status: WikiEntryStatus;
  trust: WikiTrust;
  anchorState: WikiAnchorState;
  notes: number[];
}

/** `GET /api/wiki/spaces/:id/docs/:slug`. */
export interface WikiDocView {
  spaceId: string;
  slug: string;
  number: string;
  title: string;
  question: string;
  audience: string[];
  scopeIn: string[];
  scopeOut: Array<{ text: string; docs: Array<{ slug: string; number: string | null; title: string | null }> }>;
  category: { key: string; number: number; title: string };
  length: { min: number; max: number };
  /** The confirmed plan's version. */
  planVersion: number;
  written: boolean;
  status: WikiDocStatus | null;
  /** The plan version it was last written from. */
  writtenFromPlanVersion: number | null;
  /** The origin/main commit its last write read the repository at. */
  repoSha: string | null;
  updatedAt: string | null;
  counts: WikiDocSentenceCounts;
  /** The unsourced and unverified sentences' share of all, which past `rules.needsReviewAbove` marks it. */
  unsourcedShare: number;
  sections: WikiDocSectionView[];
  footnotes: WikiDocFootnoteView[];
  entries: WikiDocViaEntry[];
}

/** One line of the A–Z index: a document, or a section whose title no other document shares. */
export interface WikiDocsIndexItem {
  kind: 'doc' | 'section';
  title: string;
  docSlug: string;
  docNumber: string;
  docTitle: string;
  sectionKey: string | null;
  sectionNumber: number | null;
  category: { key: string; title: string };
  written: boolean;
}

/** `GET /api/wiki/spaces/:id/doc-index`. */
export interface WikiDocsIndex {
  spaceId: string;
  plan: { version: number; confirmedAt: string } | null;
  items: WikiDocsIndexItem[];
}

// ── The server's half of a section's material ──────────────────────────────────────────────────

/** An entry a section's session condition picked: the way in to the records it cites, never the material. */
export interface WikiDocMaterialEntry {
  id: string;
  kind: WikiEntryKind;
  title: string;
  summary: string;
  /** 3 per keyword, 2 for a path under an anchor path, 1 for a topic, 1 for a kind (contract `docs.material.entries`). */
  score: number;
  recordedAt: string;
}

/** One record of a section's material, redacted and placed. */
export interface WikiDocMaterialRecord {
  kind: WikiDocRecordKind;
  /** The record's id: a record footnote's `ref`. */
  ref: string;
  /** Through one of `entries` (its via entry), or by the condition's projects, window and keywords. */
  found: 'entry' | 'search';
  via: { entryId: string; title: string; kind: WikiEntryKind; quote: string | null } | null;
  weight: WikiDocMaterialWeight;
  /** The owner's own words (`isOwnerTurn`, an answered question, an owner's comment or decision). */
  ownerWords: boolean;
  /** A turn's kind, an event's type, a tool's name, a comment's author, a receipt's result. */
  label: string | null;
  at: string | null;
  sessionId: string | null;
  sessionTitle: string | null;
  taskId: string | null;
  taskTitle: string | null;
  projectId: string | null;
  projectTitle: string | null;
  notePath: string | null;
  /** Redacted: the whole record, or `docs.material.rules.excerptChars` of it around what found it. */
  text: string;
  /** Where `text` is in the record's redacted text, in code points, end exclusive: a record footnote's `chars`. */
  chars: { start: number; end: number };
  /** The redacted record's length, in code points. */
  length: number;
}

/** `GET /api/runner/wiki/spaces/:id/docs/:slug/material?section=<key>` (contract `docs.reads.material`). */
export interface WikiDocMaterial {
  spaceId: string;
  slug: string;
  section: string;
  planVersion: number;
  /** The section's session condition as the confirmed plan states it; null when it has none. */
  condition: WikiPlanSessionCondition | null;
  entries: WikiDocMaterialEntry[];
  records: WikiDocMaterialRecord[];
  /** Sources the picked entries cite whose records are not this account's any more: never read. */
  unresolved: Array<{ kind: string; ref: string; entryId: string }>;
}

// ── What a maintenance run writes again (criterion 3, revision 3) ───────────────────────────────

/** The numbers the affected read and the path withdrawal go by (contract `docs.affected.rules`). */
export const WIKI_DOCS_AFFECTED_RULES = {
  /** The most entries that fit no section the read lists; `unplacedMore` counts the rest. */
  unplacedMax: 50,
  /** The most repository paths one withdrawal names. */
  withdrawPathsMax: 500,
} as const;

/** An entry the confirmed plan has no place for: what a plan proposal is made of. */
export interface WikiDocsUnplacedEntry {
  id: string;
  kind: string;
  title: string;
  summary: string;
  topics: string[];
  anchorPaths: string[];
  /** When it last changed: the op that last applied to it. */
  changedAt: string;
}

/**
 * `GET /api/runner/wiki/spaces/:id/docs/affected` (contract `docs.reads.affected`): what a maintenance run
 * of the space writes again because of the entries — every written section of the confirmed plan that an
 * entry changed since it was written fits (`docs.affected.fit`), and every stale one — and what it may
 * propose: the entries changed since the plan was first drafted that fit no section, less those a proposal
 * already names. The repository's half — sections whose design documents, code or contracts changed on
 * origin/main since their repoSha — is the run's to find, in its checkout.
 */
export interface WikiDocsAffected {
  spaceId: string;
  /**
   * The confirmed plan, or null: with none, a maintenance run writes no document. repoSha is the commit the
   * plan's references were last checked at — the confirmed version's, or the newest of the versions it
   * was made from — from which a run looks for design documents that are new.
   */
  plan: { version: number; confirmedAt: string; repoSha: string | null; draftedAt: string } | null;
  /** The space's build that has not ended: it writes the sections not written yet, so a run leaves them to it. */
  build: { jobId: string; state: 'queued' | 'held' | 'running'; version: number } | null;
  /** The written sections to write again, and why: the entries that fit them, stale for a withdrawn sentence. */
  sections: Array<{ doc: string; key: string; repoSha: string; generatedAt: string; stale: boolean; entryIds: string[] }>;
  /** Entries that fit no section of the confirmed plan and that no proposal names, newest first. */
  unplaced: WikiDocsUnplacedEntry[];
  /** How many more such entries there are than `unplaced` lists. */
  unplacedMore: number;
  /** What the space's proposals, whatever became of them, already name: its entries, commits and design documents. */
  proposed: { entryIds: string[]; commits: string[]; paths: string[] };
}

/**
 * `POST /api/runner/wiki/spaces/:id/docs/withdrawals` (contract `docs.withdrawal.paths`): repository files a
 * maintenance run found deleted or renamed on origin/main at repoSha, among those the plan's sections cite.
 * Every sentence with a footnote citing one is withdrawn as anchor_missing, naming the path, and its
 * section marked stale.
 */
export interface WikiDocsPathWithdrawalRequest {
  repoSha: string;
  paths: Array<{ path: string; change: 'deleted' | 'renamed'; to?: string | null }>;
}

export interface WikiDocsPathWithdrawalResult {
  spaceId: string;
  /** Sentences withdrawn now; one withdrawn already is not counted again. */
  withdrawn: number;
  sections: Array<{ doc: string; key: string }>;
}
