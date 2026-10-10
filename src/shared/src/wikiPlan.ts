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

/**
 * The facts a proposal names as what led to it: entries of the space, sessions of its owner, and — for a
 * design document that landed on origin/main and no section of the plan cites — the commit that added it
 * (its id the commit's full sha, which the maintenance run found at origin/main; the server has no
 * checkout to look it up in).
 */
export const WIKI_PLAN_FACT_KINDS = ['entry', 'session', 'commit'] as const;
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
  /** The owner's, as a changeset's (contract `plan.idempotency`): the same draft sent again under it is
   *  answered with the version it stored, `replayed`; another draft under it is refused
   *  `WIKI_IDEMPOTENCY_KEY_REUSED`. */
  idempotencyKey?: string;
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
  /** The wiki_job that drafted it, when the server ran the plan job (contract `plan.jobs.server`); null otherwise. */
  authorJobId: string | null;
  authorUserId: string | null;
  confirmedByUserId: string | null;
  confirmedAt: string | null;
  supersededAt: string | null;
  createdAt: string;
  docs: WikiPlanDoc[];
}

/** The answer to a draft: the version it stored, `replayed` when the same draft under its key stored it before. */
export interface WikiPlanDraftAnswer extends WikiPlanVersion {
  replayed: boolean;
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
  /** The maintenance run that filed it: a session's, or null for a run the server's wiki job ran (P8, 0406). */
  authorSessionId: string | null;
  /** The wiki_job that filed it when the server ran the run (contract `plan.proposals.author`); null otherwise. */
  authorJobId: string | null;
  decidedByUserId: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  /** The draft accepting it made. */
  resultVersion: number | null;
  createdAt: string;
}

/** `GET …/plan`: the version in force, the draft waiting for the owner, the pending proposals, and the job. */
export interface WikiPlanState {
  spaceId: string;
  confirmed: WikiPlanVersion | null;
  draft: WikiPlanVersion | null;
  proposals: WikiPlanProposal[];
  /** The space's plan job: the one not ended, else the one that ended last; null when it never had one. */
  job: WikiPlanJob | null;
}

/** `POST …/plan/proposals/:id/decide`. */
export interface WikiPlanDecisionResult {
  proposal: WikiPlanProposal;
  /** The draft an acceptance made; null for a rejection. */
  draft: WikiPlanVersion | null;
}

// ── The plan's jobs (contract `plan.jobs`, migration 0338) ──────────────────────────────────────

/**
 * What a job does: draft a plan (`orbit wiki plan draft`), revise the newest version with the owner's
 * words (`orbit wiki plan revise`), or build the documents from a confirmed version (`orbit wiki docs
 * build`), which the owner's confirmation asks for.
 */
export const WIKI_PLAN_JOB_KINDS = ['draft', 'revise', 'build'] as const;
export type WikiPlanJobKind = (typeof WIKI_PLAN_JOB_KINDS)[number];

/**
 * The fact that asked for a job: the space was created, or its owner asked on the plan page — for a draft,
 * or, by confirming a version, for the build of its documents.
 */
export const WIKI_PLAN_JOB_TRIGGERS = ['space_created', 'owner'] as const;
export type WikiPlanJobTrigger = (typeof WIKI_PLAN_JOB_TRIGGERS)[number];

/** Where a job stands as it is stored (`wiki_plan_job.state`). */
export const WIKI_PLAN_JOB_STORED_STATES = ['queued', 'held', 'made', 'ended'] as const;
export type WikiPlanJobStoredState = (typeof WIKI_PLAN_JOB_STORED_STATES)[number];

/**
 * Where a job stands as the plan's read says it (contract `plan.jobs.states`): queued behind an
 * unfinished task of the space's maintenance list, held (with why), running (its task is made), or
 * ended — succeeded with the version it stored, or failed with the gate's errors.
 */
export const WIKI_PLAN_JOB_STATES = ['queued', 'held', 'running', 'succeeded', 'failed'] as const;
export type WikiPlanJobState = (typeof WIKI_PLAN_JOB_STATES)[number];

/**
 * Why a job was not made (contract `plan.jobs.held`), kept on the job until it is: the space's
 * maintenance names no workspace a run could take place in, or its provider is one no run could start
 * on. The owner's next change to the space's maintenance settings, or their next request, asks again.
 */
export const WIKI_PLAN_JOB_HELD_REASONS = ['no_maintenance_workspace', 'maintenance_provider_unusable'] as const;
export type WikiPlanJobHeldReason = (typeof WIKI_PLAN_JOB_HELD_REASONS)[number];

export const WIKI_PLAN_JOB_OUTCOMES = ['succeeded', 'failed'] as const;
export type WikiPlanJobOutcome = (typeof WIKI_PLAN_JOB_OUTCOMES)[number];

/** The numbers a job runs by (contract `plan.jobs.rules`). */
export const WIKI_PLAN_JOB_RULES = {
  /** The gate rounds a draft has: the first, and two more with every error handed back to the model. */
  attemptsMax: 3,
  /** The owner's instructions for a revision, at most. */
  instructionsMaxChars: 4_000,
  /** What a run's report may weigh as JSON: counts and a few short strings. */
  reportMaxBytes: 16_000,
  /** The last draft a job that failed keeps, as JSON, at most. */
  draftMaxBytes: 1_000_000,
  /** A failure in words, at most. */
  errorMaxChars: 2_000,
  /** The budget a job's task declares for its check, in seconds: the check reads one row. */
  checkTimeoutSeconds: 300,
  /** The window of sessions the materials count and cluster, in days. */
  materialsSessionDays: 90,
  /** The most sessions and projects the materials list. */
  materialsSessionsMax: 5_000,
  materialsProjectsMax: 500,
} as const;

/**
 * A draft or a revision run by the wiki-worker (contract `plan.jobs.server`, design §8, P6): when the executor
 * switch gives the account to the server (`jobs.executor`), the plan job is made as a `wiki_job` instead of a
 * task of the hidden list, and the worker drafts with the System model through the request queue — the runner's
 * pipeline (`orbit wiki plan draft | revise`), ported, its repository read from the space's snapshot.
 */
export const WIKI_PLAN_SERVER_JOB = {
  /** The wiki_job a draft and a revision run as (contract `jobs.kinds`). */
  kinds: { draft: 'plan_draft', revise: 'plan_revise' },
  /** Owner-initiated: the space's creation and the owner's redraft are both the owner's (contract `jobs.priority`). */
  priority: 1,
  /** One call's max_tokens: a catalogue of forty documents in the line format, with room (the runner's 32,000). */
  maxTokens: 32_000,
  /** The calls one unit gets: the first, and two more with the format said again when its answer does not read. */
  formatTries: 3,
  /** The units in flight at once: the runner's --concurrency default, and the queue's own cap on one job. */
  concurrency: 4,
  /** How long the job waits for the space's runner to snapshot origin/main, and for a read of the texts the snapshot does not carry. */
  snapshotWaitSeconds: 300,
  readWaitSeconds: 300,
  /** Every call's whole system prompt, word for word the runner's (wikiPlanSystemPrompt). */
  systemPrompt: '你是这个仓库的文档主编。你根据给你的材料规划产品与技术文档。只使用材料里出现的文件路径、'
    + '章节标题、符号、项目名，不编造。用中文写，代码名、路径、命令保留原文。只输出要求的内容。',
  /**
   * The repository's materials, cut to the runner's caps, in characters: the overview a catalogue, a category's
   * details and a document's outline read; the structure and the documents' heading tree a catalogue and the
   * details read; one document's code symbols.
   */
  materialCaps: {
    overview: { full: 14_000, detail: 10_000, doc: 8_000 },
    layout: { full: 32_000, detail: 26_000 },
    docsTree: { full: 45_000, detail: 30_000 },
    codeExcerpt: 16_000,
  },
  /** Each kind of call's step in the queue: `plan_*`, so the plan's wait limit and call budget apply (modelQueue). */
  steps: {
    skeleton: 'plan_skeleton',
    details: 'plan_details',
    outline: 'plan_outline',
    rules: 'plan_rules',
    reviseCatalogue: 'plan_revise_catalogue',
    reviseDoc: 'plan_revise_doc',
    redoDoc: 'plan_redo_doc',
  },
} as const;

/** What a draft's or a revision's run reports when it ends (contract `plan.jobs.report`), kept as it was said. */
export interface WikiPlanJobReport {
  categories: number;
  docs: number;
  sections: number;
  target: { min: number; max: number };
  /** Every gate round: the errors the runner's own gate found, and the server's. */
  attempts: Array<{ attempt: number; local: number; server: number; checks: Record<string, number> }>;
  repo: { sha: string; checked: number; missing: number } | null;
  tokens: { input: number; output: number; calls: number };
  seconds: number;
  model: string | null;
  /** The fourth step's draft of the rules the documents are written by, cut to fit. */
  rulesDraft?: string;
}

/**
 * What a build's run reports when it ends (contract `plan.jobs.buildReport`), kept as it was said: the
 * version it wrote, at which commit, its documents and sections by what became of them, the spend and the
 * time. A section whose material did not change is `unchanged` — not written again, and asked no model.
 */
export interface WikiPlanBuildReport {
  planVersion: number;
  repoSha: string;
  docs: { total: number; written: number };
  sections: { written: number; unchanged: number; failed: number };
  tokens: { input: number; output: number; calls: number };
  seconds: number;
  model: string | null;
}

/**
 * A build's progress while it runs (contract `plan.jobs.progress`): the documents it went through of the
 * confirmed version's, and the one it is writing now — the plan page's «Writing documents».
 */
export interface WikiPlanBuildProgress {
  docs: { done: number; total: number };
  current: { slug: string; title: string } | null;
}

/** A space's plan job, as the plan's read gives it. */
export interface WikiPlanJob {
  id: string;
  spaceId: string;
  kind: WikiPlanJobKind;
  trigger: WikiPlanJobTrigger;
  state: WikiPlanJobState;
  /** A revision's instructions: the owner's words, as they were given. */
  instructions: string | null;
  requestedAt: string;
  /** Held: why, and since when. */
  held: { reason: WikiPlanJobHeldReason; at: string } | null;
  /** Queued: the unfinished task of the maintenance list it waits for, and that task's run. */
  waitingFor: { taskId: string; title: string; sessionId: string | null; startedAt: string | null } | null;
  /** The task it made, the provider that task is pinned to, and the session that runs it. */
  taskId: string | null;
  provider: string | null;
  sessionId: string | null;
  madeAt: string | null;
  startedAt: string | null;
  endedAt: string | null;
  /** The gate round the run is on, or ended on, of `attemptsMax`. */
  attempt: number | null;
  attemptsMax: number;
  /** A build's, while it runs: the documents written of how many, and the one being written. */
  progress: WikiPlanBuildProgress | null;
  /** Succeeded: the version it stored. A build's, from the start: the confirmed version it writes. */
  version: number | null;
  /** Failed: the gate's errors on the last round, and what went wrong in words. */
  errors: WikiPlanGateError[];
  error: string | null;
  /** A draft's or a revision's report, or a build's (`kind` says which). */
  report: WikiPlanJobReport | WikiPlanBuildReport | null;
  /** Failed: the last draft it had, as it was sent to the gate. */
  draft: WikiPlanDraftInput | null;
}

/** `POST /api/wiki/spaces/:id/plan/redraft`: with instructions a revision, without them a draft. */
export interface WikiPlanRedraftRequest {
  instructions?: string | null;
}

/** Its answer: the job — the one made, or the space's draft that had not ended, and whether it was new. */
export interface WikiPlanRedraftResult {
  created: boolean;
  job: WikiPlanJob;
}

/**
 * `GET /api/runner/wiki/spaces/:id/plan/job`: the job the calling maintenance session runs, and what it
 * starts from — the space, its repository and the maintenance workspace's checkout.
 */
export interface WikiPlanJobContext {
  job: WikiPlanJob;
  space: {
    id: string;
    title: string;
    repo: { urlNorm: string | null; rootCommitSha: string | null };
    workspace: { id: string; workDir: string | null } | null;
  };
}

/** `POST …/plan/job/progress`: the gate round a draft's run is on, or how far a build's has got. */
export type WikiPlanJobProgressRequest = { attempt: number } | WikiPlanBuildProgress;

/** `POST …/plan/job/finish`: how the run ended. */
export interface WikiPlanJobFinishRequest {
  outcome: WikiPlanJobOutcome;
  version?: number | null;
  errors?: WikiPlanGateError[];
  error?: string | null;
  report?: WikiPlanJobReport | WikiPlanBuildReport | null;
  draft?: WikiPlanDraftInput | null;
}

/** `GET …/plan/check?job=<id>`: `orbit wiki plan check`'s verdict. */
export interface WikiPlanJobCheck {
  spaceId: string;
  jobId: string;
  kind: WikiPlanJobKind;
  outcome: WikiPlanJobOutcome | null;
  version: number | null;
  ok: boolean;
  /** Why it is not ok, one sentence each. */
  problems: string[];
}

/**
 * A topic of the space as a session condition may name it (contract `plan.gate.references`): its slug, its
 * display name, and how many of the space's active entries name it.
 */
export interface WikiPlanTopic {
  slug: string;
  title: string;
  active: number;
}

/**
 * `GET /api/runner/wiki/spaces/:id/plan/materials` (contract `plan.jobs.materials`): what the drafting
 * job reads of Orbit besides the repository — the owner's projects, the space's sessions of the last
 * `materialsSessionDays` days, and how the space's entries and topics are spread. Titles are redacted
 * before they leave the server; the runner counts and clusters them.
 */
export interface WikiPlanMaterials {
  spaceId: string;
  title: string;
  asOf: string;
  repo: { urlNorm: string | null; rootCommitSha: string | null };
  workspace: { id: string; workDir: string | null } | null;
  projects: Array<{ id: string; title: string; status: string; createdAt: string; tasks: number; sessions: number }>;
  sessions: {
    days: number;
    total: number;
    /** Newest first, at most `materialsSessionsMax`. */
    items: Array<{ title: string; month: string; task: boolean; project: string | null; provider: string | null }>;
  };
  entries: Array<{ kind: string; status: string; count: number }>;
  topics: Array<{
    slug: string;
    title: string;
    category: string | null;
    pathPrefixes: string[];
    active: number;
    /** The topic's newest active entries, at most six. */
    recent: Array<{ kind: string; title: string }>;
  }>;
}
