// Orbit Wiki's plan (contracts/wiki.contract.json `plan`, migration 0325, criterion 11): before a wiki's
// documents are written, the local model drafts a plan — categories, documents, each document's reader,
// scope and outline, and where each section's material comes from — the server's gate checks it, and
// the owner confirms it. wikiContract.spec.ts holds every constant below to the contract JSON.

import type { WikiEntryKind } from './wiki';

/** A version is a `draft` until the owner confirms it; a newer draft or confirmation `superseded` it. */
export const WIKI_PLAN_STATUSES = ['draft', 'confirmed', 'superseded'] as const;
export type WikiPlanStatus = (typeof WIKI_PLAN_STATUSES)[number];

/** Who made a version: a maintenance run's drafting job, or the owner (an edit, an accepted proposal). */
export const WIKI_PLAN_ORIGINS = ['maintenance', 'owner'] as const;
export type WikiPlanOrigin = (typeof WIKI_PLAN_ORIGINS)[number];

/**
 * What a section is (contract `plan.sectionKinds`). A mechanism's material is the design documents,
 * the code and the contracts; a pitfall's, decision's or convention's is what was said in sessions.
 */
export const WIKI_PLAN_SECTION_KINDS = [
  'overview',
  'concepts',
  'flow',
  'interface',
  'data',
  'ops',
  'pitfalls',
  'decisions',
  'conventions',
  'other',
] as const;
export type WikiPlanSectionKind = (typeof WIKI_PLAN_SECTION_KINDS)[number];

/** A proposal waits for the owner, who accepts or rejects it. */
export const WIKI_PLAN_PROPOSAL_STATUSES = ['pending', 'accepted', 'rejected'] as const;
export type WikiPlanProposalStatus = (typeof WIKI_PLAN_PROPOSAL_STATUSES)[number];
export const WIKI_PLAN_PROPOSAL_ACTIONS = ['accept', 'reject'] as const;
export type WikiPlanProposalAction = (typeof WIKI_PLAN_PROPOSAL_ACTIONS)[number];

/** The facts a proposal names as what led to it: entries of the space and sessions of its owner. */
export const WIKI_PLAN_FACT_KINDS = ['entry', 'session'] as const;
export type WikiPlanFactKind = (typeof WIKI_PLAN_FACT_KINDS)[number];

/** The gate's four checks, in the order it runs them (contract `plan.gate.checks`). */
export const WIKI_PLAN_GATE_CHECKS = ['schema', 'docCount', 'protected', 'references'] as const;
export type WikiPlanGateCheck = (typeof WIKI_PLAN_GATE_CHECKS)[number];

/** Where a field the schema does not have may be declared as needing adding (`newFields[].at`). */
export const WIKI_PLAN_NEW_FIELD_LEVELS = ['category', 'doc', 'section'] as const;
export type WikiPlanNewFieldLevel = (typeof WIKI_PLAN_NEW_FIELD_LEVELS)[number];

/** What the runner checked a repository reference as (`repoCheck.missing[].kind`). */
export const WIKI_PLAN_REPO_REF_KINDS = ['file', 'docSection', 'symbol', 'contract'] as const;
export type WikiPlanRepoRefKind = (typeof WIKI_PLAN_REPO_REF_KINDS)[number];

/** The numbers a plan is checked by (contract `plan.rules`). */
export const WIKI_PLAN_RULES = {
  /** The documents a draft must have, unless the request names its own target… */
  docsMin: 20,
  docsMax: 35,
  /** …which may not ask for more than this. */
  docsCeiling: 200,
  categoriesMax: 30,
  sectionsMax: 20,
  titleMaxChars: 120,
  questionMaxChars: 1_000,
  /** An audience line, a scope item, a source's path, section or symbol, a keyword. */
  textMaxChars: 1_000,
  coversMaxChars: 2_000,
  /** Every list inside a document or a section. */
  listMaxItems: 40,
  lengthMaxChars: 100_000,
  newFieldsMax: 20,
  reasonMaxChars: 2_000,
  factsMax: 50,
  /** The most errors one refusal lists; the message counts the rest. */
  errorsMax: 200,
  /** The most unfound references a runner's report may carry. */
  repoMissingMax: 2_000,
  /** The JSON of one object's `extra`: the values of the fields its plan declared as needing adding. */
  extraMaxChars: 4_000,
} as const;

/**
 * Every field a plan draft may carry, at each level (contract `plan.schema`). The gate refuses any
 * other key. A field the schema does not have is declared in the draft's `newFields` as needing adding,
 * at `category`, `doc` or `section`, and its values go in that object's `extra`, by name: kept apart
 * from the schema's own, and shown to the owner as fields to add.
 */
export const WIKI_PLAN_SCHEMA = {
  draft: ['categories', 'docs', 'newFields'],
  category: ['key', 'title', 'question', 'forAgents', 'extra'],
  doc: ['category', 'slug', 'title', 'question', 'audience', 'scopeIn', 'scopeOut', 'length', 'protected', 'sections', 'extra'],
  scopeOut: ['text', 'docs'],
  length: ['min', 'max'],
  section: ['key', 'title', 'kind', 'covers', 'length', 'sources', 'extra'],
  sources: ['docs', 'code', 'contracts', 'sessions'],
  docSource: ['path', 'section'],
  codeSource: ['path', 'symbols'],
  contractSource: ['path'],
  sessions: ['projects', 'since', 'until', 'keywords', 'anchorPaths', 'entryKinds', 'topics', 'evidence'],
  newField: ['at', 'name', 'why'],
} as const;
export type WikiPlanSchemaLevel = keyof typeof WIKI_PLAN_SCHEMA;

// ── What a draft is written as ──────────────────────────────────────────────────────────────────

export interface WikiPlanCategoryInput {
  /** A slug, unique in the plan. */
  key: string;
  title: string;
  /** What the category answers. */
  question?: string;
  /** The agents' development conventions (criterion 11: listed as a category of their own). */
  forAgents?: boolean;
  /** The values of fields `newFields` declares at `category`, by name. */
  extra?: Record<string, unknown>;
}

export interface WikiPlanSessionConditionInput {
  /** Projects of the owner, each by its id or its exact title. */
  projects?: string[];
  /** `YYYY-MM-DD`, or null for no bound. */
  since?: string | null;
  until?: string | null;
  keywords?: string[];
  anchorPaths?: string[];
  entryKinds?: string[];
  /** Topic slugs of the space. */
  topics?: string[];
  /** What original words to look for. */
  evidence?: string;
}

export interface WikiPlanSourcesInput {
  docs?: Array<{ path: string; section?: string | null }>;
  code?: Array<{ path: string; symbols?: string[] }>;
  contracts?: Array<{ path: string }>;
  sessions?: WikiPlanSessionConditionInput | null;
}

export interface WikiPlanSectionInput {
  /** Stable within its document; the server gives one to a section that has none. */
  key?: string;
  title: string;
  kind: WikiPlanSectionKind;
  covers: string;
  /** The characters the section is written to. */
  length: number;
  sources: WikiPlanSourcesInput;
  /** The values of fields `newFields` declares at `section`, by name. */
  extra?: Record<string, unknown>;
}

export interface WikiPlanDocInput {
  /** The key of one of the plan's categories. */
  category: string;
  slug: string;
  title: string;
  /** The question the reader comes with. */
  question: string;
  /** Who it is written for, and what each can do after reading it. */
  audience: string[];
  scopeIn: string[];
  /** What it leaves out, and the documents (slugs of this plan) it leaves that to. */
  scopeOut: Array<{ text: string; docs?: string[] }>;
  length: { min: number; max: number };
  /** Only the owner protects a document; a protected one is carried into every later draft as it is. */
  protected?: boolean;
  sections: WikiPlanSectionInput[];
  /** The values of fields `newFields` declares at `doc`, by name. */
  extra?: Record<string, unknown>;
}

export interface WikiPlanNewField {
  at: WikiPlanNewFieldLevel;
  name: string;
  why: string;
}

export interface WikiPlanDraftInput {
  categories: WikiPlanCategoryInput[];
  docs: WikiPlanDocInput[];
  newFields?: WikiPlanNewField[];
}

/** A reference the runner could not find at the sha it checked (contract `plan.gate.repo`). */
export interface WikiPlanRepoMiss {
  kind: WikiPlanRepoRefKind;
  ref: string;
  /** Where the plan names it, `docs[3].sections[2].code[0]`. */
  at: string | null;
}

/** What the drafting job reports of the repository references it checked on the runner. */
export interface WikiPlanRepoCheck {
  sha: string;
  checked: number;
  missing: WikiPlanRepoMiss[];
}

/** `POST /api/runner/wiki/spaces/:id/plan/drafts`. */
export interface WikiPlanDraftRequest {
  /** The version this draft revises: the space's newest draft or confirmed version, or null for its first. */
  baseVersion: number | null;
  /** The document count to hold the draft to; `rules.docsMin`–`rules.docsMax` when left out. */
  target?: { min: number; max: number };
  plan: WikiPlanDraftInput;
  repoCheck: WikiPlanRepoCheck;
  model?: string;
}

/** `POST /api/runner/wiki/spaces/:id/plan/proposals`. */
export interface WikiPlanProposalRequest {
  reason: string;
  /** The document as it should read — a new one, or one of the plan's by its slug — and the category
   *  it opens when it needs one the plan does not have. */
  change: { doc: WikiPlanDocInput; category?: WikiPlanCategoryInput | null };
  facts: Array<{ kind: WikiPlanFactKind; id: string }>;
}

/** `POST /api/wiki/spaces/:id/plan/edits`: one document, or one section of one, as the owner rewrote it. */
export interface WikiPlanEditRequest {
  /** The version edited: the space's newest draft or confirmed version. */
  baseVersion: number;
  /** The document edited, as it is named in that version. */
  docSlug: string;
  doc?: WikiPlanDocInput;
  sectionKey?: string;
  section?: WikiPlanSectionInput;
}

// ── What the doors answer ───────────────────────────────────────────────────────────────────────

/** One thing the gate found wrong (contract `plan.gate.errors`). */
export interface WikiPlanGateError {
  check: WikiPlanGateCheck;
  /** Where in the request: `docs[3].sections[2].sources.sessions.projects[0]`. */
  path: string;
  message: string;
}

/** What the gate checked of a version it let through, stored beside it. */
export interface WikiPlanGateReport {
  checkedAt: string;
  /** `skipped`: the protection check, for a version only the owner's hand made. */
  checks: Record<WikiPlanGateCheck, 'passed' | 'skipped'>;
  docs: number;
  target: { min: number; max: number };
  /** The fields it declared as needing adding, each with how many values it carried. */
  needsNewFields: Array<WikiPlanNewField & { values: number }>;
}

export interface WikiPlanCategory {
  key: string;
  title: string;
  question: string;
  forAgents: boolean;
  extra: Record<string, unknown>;
}

export interface WikiPlanSessionCondition {
  /** Resolved: a project's title as it stands, null for one since deleted. */
  projects: Array<{ id: string; title: string | null }>;
  since: string | null;
  until: string | null;
  keywords: string[];
  anchorPaths: string[];
  entryKinds: WikiEntryKind[];
  topics: string[];
  evidence: string;
}

export interface WikiPlanSources {
  docs: Array<{ path: string; section: string | null }>;
  code: Array<{ path: string; symbols: string[] }>;
  contracts: Array<{ path: string }>;
  sessions: WikiPlanSessionCondition | null;
}

export interface WikiPlanSection {
  id: string;
  key: string;
  position: number;
  title: string;
  kind: WikiPlanSectionKind;
  covers: string;
  length: number;
  sources: WikiPlanSources;
  extra: Record<string, unknown>;
}

export interface WikiPlanDoc {
  id: string;
  position: number;
  category: string;
  slug: string;
  title: string;
  question: string;
  audience: string[];
  scopeIn: string[];
  scopeOut: Array<{ text: string; docs: string[] }>;
  length: { min: number; max: number };
  protected: boolean;
  extra: Record<string, unknown>;
  sections: WikiPlanSection[];
}

/** One version, whole. */
export interface WikiPlanVersion {
  id: string;
  spaceId: string;
  version: number;
  status: WikiPlanStatus;
  origin: WikiPlanOrigin;
  baseVersion: number | null;
  proposalId: string | null;
  categories: WikiPlanCategory[];
  newFields: WikiPlanNewField[];
  target: { min: number; max: number };
  gate: WikiPlanGateReport;
  /** Null for a version the owner made: no runner checked it. */
  repoCheck: WikiPlanRepoCheck | null;
  model: string | null;
  authorSessionId: string | null;
  authorUserId: string | null;
  confirmedByUserId: string | null;
  confirmedAt: string | null;
  supersededAt: string | null;
  createdAt: string;
  docs: WikiPlanDoc[];
}

/** One version as the history lists it. */
export interface WikiPlanVersionSummary {
  id: string;
  version: number;
  status: WikiPlanStatus;
  origin: WikiPlanOrigin;
  baseVersion: number | null;
  proposalId: string | null;
  docCount: number;
  createdAt: string;
  confirmedAt: string | null;
  supersededAt: string | null;
}

export interface WikiPlanProposal {
  id: string;
  spaceId: string;
  status: WikiPlanProposalStatus;
  baseVersion: number;
  reason: string;
  change: { doc: WikiPlanDocInput; category: WikiPlanCategoryInput | null };
  facts: Array<{ kind: WikiPlanFactKind; id: string }>;
  gate: WikiPlanGateReport;
  authorSessionId: string;
  decidedByUserId: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  /** The draft accepting it made. */
  resultVersion: number | null;
  createdAt: string;
}

/** `GET …/plan`: the version in force, the draft waiting for the owner, and the pending proposals. */
export interface WikiPlanState {
  spaceId: string;
  confirmed: WikiPlanVersion | null;
  draft: WikiPlanVersion | null;
  proposals: WikiPlanProposal[];
}

/** `POST …/plan/proposals/:id/decide`. */
export interface WikiPlanDecisionResult {
  proposal: WikiPlanProposal;
  /** The draft an acceptance made; null for a rejection. */
  draft: WikiPlanVersion | null;
}
