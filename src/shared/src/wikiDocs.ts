// Orbit Wiki's documents (contracts/wiki.contract.json `docs`, migration 0326, criterion 9 revised
// 2026-09-28): a space's documents, written section by section from the plan its owner confirmed
// (`wikiPlan.ts`), every footnote pointing at a first-hand original with its verbatim quote, and the
// entry it was found through kept as the via entry. wikiContract.spec.ts holds every constant below to
// the contract JSON.

import type { WikiAnchorState, WikiEntryKind, WikiEntryStatus, WikiTrust } from './wiki';
import type { WikiPlanSectionKind } from './wikiPlan';

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

/** Why a sentence was withdrawn: what happened to the entry it came through. */
export const WIKI_DOC_WITHDRAW_REASONS = ['rejected', 'retired', 'superseded', 'anchor_changed', 'anchor_missing'] as const;
export type WikiDocWithdrawReason = (typeof WIKI_DOC_WITHDRAW_REASONS)[number];

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
} as const;

/**
 * Every field a write may carry, at each level (contract `docs.schema`). Anything else is refused
 * WIKI_DOC_INVALID. A repository footnote and a record footnote are told apart by their kind.
 */
export const WIKI_DOC_SCHEMA = {
  write: ['planVersion', 'repoSha', 'model', 'sections'],
  section: ['key', 'materialSha256', 'markdown', 'footnotes'],
  repoFootnote: ['kind', 'path', 'sha', 'lines', 'section', 'symbol', 'quote', 'excerpt', 'verified', 'viaEntryId'],
  recordFootnote: ['kind', 'ref', 'chars', 'quote', 'viaEntryId'],
  lines: ['start', 'end'],
  chars: ['start', 'end'],
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

export interface WikiDocSectionInput {
  /** The plan section's key. */
  key: string;
  /** The runner's fingerprint of the section's plan definition and the material it gathered. */
  materialSha256: string;
  /** The section's body: Markdown with footnote markers `[n]`, n naming `footnotes[n-1]`. */
  markdown: string;
  footnotes: WikiDocFootnoteInput[];
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
  withdrawn: { reason: WikiDocWithdrawReason; entryId: string; at: string } | null;
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
  // A record: where it is, and what the page links to.
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
