/**
 * The Wiki's plan on the web (criterion 10 revised 2026-09-28 and criterion 11, mocks 21, 22, 25, 26):
 * the plan page — the version shown and its history, the job that drafts it, the gate's report, the
 * categories and documents with every section's material, the changes a maintenance run proposed —
 * and the plan's card on the home page and its banner on a phone.
 *
 * ONE PLACE FOR THE WORDS, as in `lib/wikiDocs.ts`: OrbitKit's `WikiPlanCopy` says the same sentences,
 * `WikiPlanCopyParityTests` looks each one up here, and both ends are held to the cases in
 * `src/shared/src/wiki-docs.fixture.json`.
 *
 * TWO SHAPES OF A PLAN, ONE PAGE. A stored version is read back with ids, positions and its projects
 * resolved (`WikiPlanVersion`); the draft a job that failed the gate last had is kept as it was sent to
 * the gate (`WikiPlanDraftInput`) — the server stores nothing that did not pass. The page draws both, so
 * both are read into `WikiPlanShown` first. And the other way: an owner's edit is sent in the DRAFT's
 * shape (no ids or positions, a session condition's projects as ids), never as it was read back.
 */
import {
  WIKI_PLAN_GATE_CHECKS,
  WIKI_PLAN_JOB_RULES,
  WIKI_PLAN_RULES,
  type WikiDocsDirectory,
  type WikiPlanCategoryInput,
  type WikiPlanDoc,
  type WikiPlanDocInput,
  type WikiPlanDraftInput,
  type WikiPlanGateCheck,
  type WikiPlanGateError,
  type WikiPlanGateReport,
  type WikiPlanJob,
  type WikiPlanJobHeldReason,
  type WikiPlanJobReport,
  type WikiPlanProposal,
  type WikiPlanRepoCheck,
  type WikiPlanSection,
  type WikiPlanSectionInput,
  type WikiPlanSectionKind,
  type WikiPlanSources,
  type WikiPlanState,
  type WikiPlanVersion,
  type WikiPlanVersionSummary,
} from '@orbit/shared';
import { WIKI_HISTORY_MAINTENANCE, WIKI_PATH, shortSha } from './wiki';
import { wikiCount } from './wikiArticles';
import { wikiMonthDayTime, wikiSectionKindLabel } from './wikiDocs';
import { wikiAgo } from './wikiHealth';
import { wikiMonthDay } from './wikiReviewMode';

export type {
  WikiPlanDoc,
  WikiPlanJob,
  WikiPlanProposal,
  WikiPlanState,
  WikiPlanVersion,
  WikiPlanVersionSummary,
} from '@orbit/shared';

// ── Routes ──────────────────────────────────────────────────────────────────────────────────────

/** The plan page (`/wiki/orbit/plan`), a version of it (`?v=1`), and a phone's document and section pages. */
export const wikiPlanPath = (spaceSlug: string, version?: number | null): string =>
  `${WIKI_PATH}/${spaceSlug}/plan${version ? `?v=${version}` : ''}`;
export const wikiPlanDocPath = (spaceSlug: string, slug: string, version?: number | null): string =>
  `${WIKI_PATH}/${spaceSlug}/plan/d/${slug}${version ? `?v=${version}` : ''}`;
export const wikiPlanSectionPath = (spaceSlug: string, slug: string, index: number, version?: number | null): string =>
  `${WIKI_PATH}/${spaceSlug}/plan/d/${slug}/${index + 1}${version ? `?v=${version}` : ''}`;

// ── The words ───────────────────────────────────────────────────────────────────────────────────

export const WIKI_PLAN_TITLE = 'Plan';
export const WIKI_PLAN_REDRAFT = 'Redraft…';
export const WIKI_PLAN_CONFIRM = 'Confirm plan';
export const WIKI_PLAN_DRAFT = 'Draft plan';
export const WIKI_PLAN_OPEN = 'Open plan';
export const WIKI_PLAN_EDIT = 'Edit';
export const WIKI_PLAN_ACCEPT = 'Accept';
export const WIKI_PLAN_REJECT = 'Reject';
export const WIKI_PLAN_CANCEL = 'Cancel';
export const WIKI_PLAN_VIEW_RUN = 'View run';
export const WIKI_PLAN_SET_UP = 'Set up maintenance';
export const WIKI_PLAN_VIEW_RUNNERS = 'View runners';
export const wikiPlanCompare = (version: number): string => `Compare with v${version}`;
export const WIKI_PLAN_HIDE_COMPARE = 'Hide comparison';

/** A version as the head and the version menu name it. */
export const wikiPlanVersionLabel = (version: number): string => `v${version}`;
export const WIKI_PLAN_STATUS_LABELS = { draft: 'Draft', confirmed: 'Confirmed', superseded: 'Superseded', failed: 'Draft' } as const;

/** The empty page (mock 21 ⑨ A, 22 ①). */
export const WIKI_PLAN_NONE = 'This space has no plan yet';
export const WIKI_PLAN_EMPTY_TITLE = 'No plan yet';
export function wikiPlanEmptyText(provider: string | null): string {
  return (
    'A plan lays out this wiki’s documents: the categories, the documents in each, who each one is for and what it covers, '
    + `and where each section’s material comes from. ${provider ?? WIKI_HISTORY_MAINTENANCE} drafts it; nothing is written until you confirm it.`
  );
}
/** Where a draft runs and how long it takes, under Draft plan: `on orbit · wikova with local-vllm`. */
export function wikiPlanEmptyNote(where: string | null, provider: string | null): string {
  const on = where ? `, on ${where}` : '';
  const with_ = provider ? ` with ${provider}` : '';
  return `Runs as a task in the Wiki maintenance list${on}${with_} — usually 1–2 hours. Until you confirm a plan, the Wiki shows its topic articles.`;
}

/** The sentence under the head of a draft that failed the gate (mock 21 ①): what the owner can do about it. */
export const wikiPlanFailedHint = (inForce: number | null): string =>
  `Confirm needs a passing check. Redraft with what to change — ${
    inForce !== null ? `v${inForce} stays in force until you confirm` : 'until you confirm a plan, the Wiki shows its topic articles'
  }.`;

/** The documents list's heading on the version in force, under its changes (mock 21 ②). */
export const WIKI_PLAN_DOCUMENTS = 'Documents';
export const WIKI_PLAN_IN_FORCE = 'the plan in force';

const plural = (count: number, one: string, many: string): string => `${wikiCount(count)} ${count === 1 ? one : many}`;

/** `3.1, 4.2 and 7.1`. */
export function wikiJoinAnd(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

// ── A plan, as the page draws it ────────────────────────────────────────────────────────────────

export interface WikiPlanShownSessions {
  projects: Array<{ id: string | null; title: string }>;
  since: string | null;
  until: string | null;
  keywords: string[];
  anchorPaths: string[];
  entryKinds: string[];
  topics: string[];
  evidence: string;
}

export interface WikiPlanShownSources {
  docs: Array<{ path: string; section: string | null }>;
  code: Array<{ path: string; symbols: string[] }>;
  contracts: Array<{ path: string }>;
  sessions: WikiPlanShownSessions | null;
}

export interface WikiPlanShownSection {
  key: string | null;
  title: string;
  kind: WikiPlanSectionKind;
  covers: string;
  length: number;
  sources: WikiPlanShownSources;
}

export interface WikiPlanShownDoc {
  /** Its place in the plan's `docs`: what a gate error's path names it by (`plan.docs[12]`). */
  index: number;
  number: string;
  slug: string;
  category: string;
  title: string;
  question: string;
  audience: string[];
  scopeIn: string[];
  scopeOut: Array<{ text: string; docs: string[] }>;
  length: { min: number; max: number };
  protected: boolean;
  sections: WikiPlanShownSection[];
  /** The stored document, when the version is stored: what an edit starts from. */
  stored: WikiPlanDoc | null;
}

export interface WikiPlanShownCategory {
  key: string;
  number: number;
  title: string;
  question: string;
  forAgents: boolean;
  docs: WikiPlanShownDoc[];
}

/** A version, or the draft a failed job last had, read into one shape. */
export interface WikiPlanShown {
  version: number;
  status: 'draft' | 'confirmed' | 'superseded' | 'failed';
  origin: 'maintenance' | 'owner';
  baseVersion: number | null;
  proposalId: string | null;
  categories: WikiPlanShownCategory[];
  /** In the plan's order. */
  docs: WikiPlanShownDoc[];
  target: { min: number; max: number };
  gate: WikiPlanGateReport | null;
  repoCheck: WikiPlanRepoCheck | null;
  model: string | null;
  createdAt: string | null;
  confirmedAt: string | null;
  /** A failed draft's: the gate's errors on its last round. */
  errors: WikiPlanGateError[];
}

const sessionsOf = (sessions: WikiPlanSources['sessions']): WikiPlanShownSessions | null =>
  sessions
    ? {
        projects: sessions.projects.map((project) => ({ id: project.id, title: project.title ?? project.id })),
        since: sessions.since,
        until: sessions.until,
        keywords: sessions.keywords,
        anchorPaths: sessions.anchorPaths,
        entryKinds: sessions.entryKinds,
        topics: sessions.topics,
        evidence: sessions.evidence,
      }
    : null;

/** Number the documents the way the directory does: `<category number>.<place in the category>`. */
function numbered(
  categories: ReadonlyArray<{ key: string; title: string; question?: string; forAgents?: boolean }>,
  docs: Array<Omit<WikiPlanShownDoc, 'number'>>,
): { categories: WikiPlanShownCategory[]; docs: WikiPlanShownDoc[] } {
  const byKey = new Map<string, WikiPlanShownCategory>();
  const shownCategories = categories.map((category, i) => {
    const row: WikiPlanShownCategory = {
      key: category.key,
      number: i + 1,
      title: category.title || category.key,
      question: category.question ?? '',
      forAgents: category.forAgents ?? false,
      docs: [],
    };
    byKey.set(category.key, row);
    return row;
  });
  const shownDocs = docs.map((doc) => {
    const category = byKey.get(doc.category);
    const number = category ? `${category.number}.${category.docs.length + 1}` : '—';
    const row: WikiPlanShownDoc = { ...doc, number };
    category?.docs.push(row);
    return row;
  });
  return { categories: shownCategories, docs: shownDocs };
}

/** A stored version, as the page draws it. */
export function wikiPlanFromVersion(version: WikiPlanVersion): WikiPlanShown {
  const { categories, docs } = numbered(
    version.categories,
    version.docs.map((doc, index) => ({
      index,
      slug: doc.slug,
      category: doc.category,
      title: doc.title,
      question: doc.question,
      audience: doc.audience,
      scopeIn: doc.scopeIn,
      scopeOut: doc.scopeOut,
      length: doc.length,
      protected: doc.protected,
      sections: doc.sections.map((section) => ({
        key: section.key,
        title: section.title,
        kind: section.kind,
        covers: section.covers,
        length: section.length,
        sources: {
          docs: section.sources.docs,
          code: section.sources.code,
          contracts: section.sources.contracts,
          sessions: sessionsOf(section.sources.sessions),
        },
      })),
      stored: doc,
    })),
  );
  return {
    version: version.version,
    status: version.status,
    origin: version.origin,
    baseVersion: version.baseVersion,
    proposalId: version.proposalId,
    categories,
    docs,
    target: version.target,
    gate: version.gate,
    repoCheck: version.repoCheck,
    model: version.model,
    createdAt: version.createdAt,
    confirmedAt: version.confirmedAt,
    errors: [],
  };
}

/**
 * A draft's or a revision's report — the gate's rounds, the references checked, the spend — or null: a
 * build reports what it wrote (`WikiPlanBuildReport`), which says nothing of a draft.
 */
export function wikiPlanDraftReport(job: WikiPlanJob | null | undefined): WikiPlanJobReport | null {
  return job && job.kind !== 'build' ? ((job.report as WikiPlanJobReport | null) ?? null) : null;
}

/** The draft a failed job last had, as the page draws it — numbered as the version it would have been. */
export function wikiPlanFromFailedJob(job: WikiPlanJob, number: number, baseVersion: number | null): WikiPlanShown | null {
  const draft: WikiPlanDraftInput | null = job.draft;
  const report = wikiPlanDraftReport(job);
  if (!draft || !Array.isArray(draft.docs) || !Array.isArray(draft.categories)) return null;
  const { categories, docs } = numbered(
    draft.categories.map((category) => ({ ...category, title: category.title ?? category.key })),
    draft.docs.map((doc, index) => ({
      index,
      slug: doc.slug,
      category: doc.category,
      title: doc.title,
      question: doc.question ?? '',
      audience: doc.audience ?? [],
      scopeIn: doc.scopeIn ?? [],
      scopeOut: (doc.scopeOut ?? []).map((out) => ({ text: out.text, docs: out.docs ?? [] })),
      length: doc.length ?? { min: 0, max: 0 },
      protected: doc.protected ?? false,
      sections: (doc.sections ?? []).map((section) => ({
        key: section.key ?? null,
        title: section.title,
        kind: section.kind,
        covers: section.covers ?? '',
        length: section.length ?? 0,
        sources: {
          docs: (section.sources?.docs ?? []).map((source) => ({ path: source.path, section: source.section ?? null })),
          code: (section.sources?.code ?? []).map((source) => ({ path: source.path, symbols: source.symbols ?? [] })),
          contracts: section.sources?.contracts ?? [],
          sessions: section.sources?.sessions
            ? {
                projects: (section.sources.sessions.projects ?? []).map((project) => ({ id: null, title: project })),
                since: section.sources.sessions.since ?? null,
                until: section.sources.sessions.until ?? null,
                keywords: section.sources.sessions.keywords ?? [],
                anchorPaths: section.sources.sessions.anchorPaths ?? [],
                entryKinds: section.sources.sessions.entryKinds ?? [],
                topics: section.sources.sessions.topics ?? [],
                evidence: section.sources.sessions.evidence ?? '',
              }
            : null,
        },
      })),
      stored: null,
    })),
  );
  return {
    version: number,
    status: 'failed',
    origin: 'maintenance',
    baseVersion,
    proposalId: null,
    categories,
    docs,
    target: report?.target ?? { min: WIKI_PLAN_RULES.docsMin, max: WIKI_PLAN_RULES.docsMax },
    gate: null,
    repoCheck: report?.repo ? { sha: report.repo.sha, checked: report.repo.checked, missing: [] } : null,
    model: report?.model ?? job.provider,
    createdAt: job.endedAt,
    confirmedAt: null,
    errors: job.errors,
  };
}

/** The newest version the space has stored, draft or confirmed. */
export function wikiPlanNewest(state: Pick<WikiPlanState, 'confirmed' | 'draft'>): WikiPlanVersion | null {
  return state.draft ?? state.confirmed;
}

/**
 * The job whose failure the page and the home still show: a draft or a revision that ended failed with
 * no version stored since it was asked for — a later draft, edit or confirmation answers it.
 */
export function wikiPlanFailedJob(state: Pick<WikiPlanState, 'confirmed' | 'draft' | 'job'>): WikiPlanJob | null {
  const job = state.job;
  if (!job || job.state !== 'failed' || job.kind === 'build') return null;
  const newest = wikiPlanNewest(state);
  if (newest && Date.parse(newest.createdAt) > Date.parse(job.requestedAt)) return null;
  return job;
}

/** The job still on its way: queued, held or running — a draft or a revision. */
export function wikiPlanOpenJob(state: Pick<WikiPlanState, 'job'>): WikiPlanJob | null {
  const job = state.job;
  return job && job.kind !== 'build' && (job.state === 'queued' || job.state === 'held' || job.state === 'running') ? job : null;
}

/** The number the next version gets. */
export function wikiPlanNextVersion(state: Pick<WikiPlanState, 'confirmed' | 'draft'>): number {
  return Math.max(state.confirmed?.version ?? 0, state.draft?.version ?? 0) + 1;
}

/**
 * What the page shows with no version asked for: the failed draft, the draft waiting, the version in
 * force — or nothing, the empty page.
 */
export function wikiPlanDefault(state: WikiPlanState): WikiPlanShown | null {
  const failed = wikiPlanFailedJob(state);
  if (failed) {
    const shown = wikiPlanFromFailedJob(failed, wikiPlanNextVersion(state), wikiPlanNewest(state)?.version ?? null);
    if (shown) return shown;
  }
  if (state.draft) return wikiPlanFromVersion(state.draft);
  if (state.confirmed) return wikiPlanFromVersion(state.confirmed);
  return null;
}

// ── The head (mock 21 ①) ────────────────────────────────────────────────────────────────────────

const counts = (shown: WikiPlanShown): string => {
  const sections = shown.docs.reduce((sum, doc) => sum + doc.sections.length, 0);
  return `${plural(shown.categories.length, 'category', 'categories')} · ${plural(shown.docs.length, 'document', 'documents')} · ${plural(sections, 'section', 'sections')}`;
};

/**
 * The line under the head: where the version came from, the model and when, and what it holds —
 * `Redrafted from v1 at your request · local-vllm · Sep 28, 20:43 · 11 categories · 40 documents · 321
 * sections` — and on the version in force, how far the documents are written: `46 written, 3 to write`.
 */
export function wikiPlanMeta(
  shown: WikiPlanShown,
  context: { job?: WikiPlanJob | null; docs?: { written: number; total: number } | null } = {},
): string[] {
  const parts: string[] = [];
  if (shown.status === 'confirmed') {
    parts.push(`Confirmed ${wikiMonthDay(shown.confirmedAt ?? '') ?? ''} by you`.replace('  ', ' '));
    parts.push(counts(shown));
    const docs = context.docs;
    if (docs && docs.written < docs.total) parts.push(`${wikiCount(docs.written)} written, ${wikiCount(docs.total - docs.written)} to write`);
    return parts;
  }
  if (shown.status === 'superseded') {
    parts.push(`Superseded · made ${wikiMonthDayTime(shown.createdAt) ?? ''}`);
    parts.push(counts(shown));
    return parts;
  }
  const asked = context.job?.trigger === 'owner';
  if (shown.origin === 'owner') {
    parts.push(shown.proposalId ? `v${shown.baseVersion} with the change you accepted` : `v${shown.baseVersion} with your edit`);
  } else if (shown.baseVersion !== null) {
    parts.push(`Redrafted from v${shown.baseVersion}${asked ? ' at your request' : ''}`);
  } else {
    parts.push(asked ? 'First draft · at your request' : 'First draft');
  }
  const when = wikiMonthDayTime(shown.createdAt);
  const made = [shown.model, when].filter((part): part is string => !!part).join(' · ');
  if (made) parts.push(made);
  parts.push(counts(shown));
  return parts;
}

/** A row of the version menu (mock 21 strip): `v2` · `Redraft · Sep 28, 20:43 · didn’t pass the check` · Draft. */
export interface WikiPlanVersionRow {
  version: number;
  status: keyof typeof WIKI_PLAN_STATUS_LABELS;
  note: string;
}

export function wikiPlanVersionRows(
  versions: readonly WikiPlanVersionSummary[],
  failed: { version: number; at: string | null } | null,
): WikiPlanVersionRow[] {
  const rows: WikiPlanVersionRow[] = versions.map((row) => {
    const at = wikiMonthDayTime(row.confirmedAt ?? row.createdAt) ?? '';
    const made = row.origin === 'owner' ? (row.proposalId ? 'Accepted change' : 'Your edit') : row.baseVersion !== null ? 'Redraft' : 'First draft';
    const note =
      row.status === 'confirmed' ? `${at} · confirmed by you` : row.status === 'draft' ? `${made} · ${at} · waiting for you` : `${made} · ${at}`;
    return { version: row.version, status: row.status, note };
  });
  if (failed) {
    rows.unshift({ version: failed.version, status: 'failed', note: `Redraft · ${wikiMonthDayTime(failed.at) ?? ''} · didn’t pass the check` });
  }
  return rows.sort((a, b) => b.version - a.version);
}

// ── The job (mock 21 ⑨, 22 ⑩) ────────────────────────────────────────────────────────────────────

/** Why a job cannot go on: the server's two held reasons, and the runner that is offline (owner's call 2026-09-29). */
export type WikiPlanHeld = WikiPlanJobHeldReason | 'runner_offline';

/** Why a draft or a revision is held (mock 21 ⑨, 22 ⑩). */
export const WIKI_PLAN_HELD_TEXT: Record<WikiPlanHeld, string> = {
  no_maintenance_workspace: 'No maintenance workspace is set up — a draft runs where maintenance runs.',
  maintenance_provider_unusable: 'No usable maintenance provider is set up — a draft runs on the provider maintenance uses.',
  runner_offline: 'The maintenance runner is offline — the draft starts once it’s back.',
};

/** Why the documents of a confirmed version are held: the same two reasons, said of the writing. */
export const WIKI_PLAN_BUILD_HELD_TEXT: Record<WikiPlanHeld, string> = {
  no_maintenance_workspace: 'No maintenance workspace is set up — documents are written where maintenance runs.',
  maintenance_provider_unusable: 'No usable maintenance provider is set up — documents are written on the provider maintenance uses.',
  runner_offline: 'The maintenance runner is offline — writing starts once it’s back.',
};

/** A held job's sentence, by what it does. */
export const wikiPlanHeldText = (job: Pick<WikiPlanJob, 'kind'>, held: WikiPlanHeld): string =>
  (job.kind === 'build' ? WIKI_PLAN_BUILD_HELD_TEXT : WIKI_PLAN_HELD_TEXT)[held];

/**
 * Why a job is held, if it is: what the server stored — or a job whose run has not started while the
 * maintenance workspace's runner is offline (`runnerOnline`, read from that runner; null when unknown).
 * Never the daily limit: the owner's draft and the build their confirmation asks for are not counted
 * against maintenance's runs a day (owner's call 2026-09-29).
 */
export function wikiPlanHeld(job: WikiPlanJob | null, runnerOnline: boolean | null): WikiPlanHeld | null {
  if (!job) return null;
  if (job.state === 'held') return job.held?.reason ?? 'no_maintenance_workspace';
  if ((job.state === 'running' || job.state === 'queued') && !job.startedAt && runnerOnline === false) return 'runner_offline';
  return null;
}

/**
 * The space's build — the documents of the version the owner confirmed, being written (contract
 * `plan.jobs`, kind `build`) — while it has not ended: queued behind the maintenance run that is going,
 * held with why, or running with how far it has got.
 */
export function wikiPlanBuildJob(state: Pick<WikiPlanState, 'job'>): WikiPlanJob | null {
  const job = state.job;
  return job && job.kind === 'build' && (job.state === 'queued' || job.state === 'held' || job.state === 'running') ? job : null;
}

/** A build of the version in force that ended failed, and nothing asked since: its documents are not all written. */
export function wikiPlanFailedBuild(state: Pick<WikiPlanState, 'job' | 'confirmed'>): WikiPlanJob | null {
  const job = state.job;
  return job && job.kind === 'build' && job.state === 'failed' && state.confirmed && job.version === state.confirmed.version ? job : null;
}

/**
 * How far the writing has got: the build's own count while it reports one (`progress`), else what the
 * directory counts as written of the version in force.
 */
export function wikiPlanBuildCounts(
  build: Pick<WikiPlanJob, 'progress'> | null,
  docs: { written: number; total: number } | null | undefined,
): { done: number; total: number } | null {
  if (build?.progress) return { done: build.progress.docs.done, total: build.progress.docs.total };
  return docs ? { done: docs.written, total: docs.total } : null;
}

/** The document a build is writing now, as the plan numbers it: `3.4 会话搜索`. */
export function wikiPlanWritingDoc(build: Pick<WikiPlanJob, 'progress'> | null, directory: WikiDocsDirectory | null | undefined): string | null {
  const current = build?.progress?.current;
  if (!current) return null;
  for (const category of directory?.categories ?? []) {
    const doc = category.docs.find((row) => row.slug === current.slug);
    if (doc) return `${doc.number} ${current.title || doc.title}`;
  }
  return current.title || current.slug;
}

export type WikiPlanJobLook = 'queued' | 'drafting' | 'held' | 'failed' | 'writing';

/** The job's card under the head: what it is doing, and the one thing to press. */
export interface WikiPlanJobCard {
  look: WikiPlanJobLook;
  title: string;
  text: string;
  /** run: the session of the run it waits for or runs; settings: the space's Maintenance; runners: the Runners page. */
  link: { label: string; to: 'run' | 'settings' | 'runners'; sessionId: string | null } | null;
  /** Writing: how far, and the document being written now. */
  progress: { done: number; total: number; now: string | null } | null;
}

export const WIKI_PLAN_QUEUED = 'Queued';
export const WIKI_PLAN_DRAFTING = 'Drafting';
export const WIKI_PLAN_HELD = 'Held';
export const WIKI_PLAN_FAILED = 'Didn’t pass the plan check';
export const WIKI_PLAN_PASSED = 'Passed the plan check';
export const WIKI_PLAN_WRITING = 'Writing documents';
export const WIKI_PLAN_JOB_FAILED = 'The draft didn’t finish';
export const WIKI_PLAN_BUILD_FAILED = 'Writing documents didn’t finish';
/** What stands after a queued job's title: it waits for the maintenance run that is going. */
export const WIKI_PLAN_QUEUED_TEXT = 'starts after the Wiki maintenance run that’s going now';

const attemptsOf = (job: WikiPlanJob): number => job.attempt ?? wikiPlanDraftReport(job)?.attempts.length ?? job.attemptsMax;

/** How many of the gate's four checks a failed draft's errors fall under. */
export const wikiPlanFailedChecks = (errors: readonly WikiPlanGateError[]): number => new Set(errors.map((error) => error.check)).size;

/** The run a job's card opens: the run it waits for while queued, its own once it has one. */
const runLink = (sessionId: string | null | undefined): WikiPlanJobCard['link'] =>
  sessionId ? { label: WIKI_PLAN_VIEW_RUN, to: 'run', sessionId } : null;

/**
 * The job's card (mock 21 ⑨, 22 ⑩): queued behind the maintenance run that is going, drafting with the
 * round it is on, held with why and what to do, failed with how — and, on the version in force, its
 * documents being written, with how many and the one being written now (the build its confirmation asked
 * for), or that the writing stopped short.
 *
 * `job` is the plan's job as read; `failed` the failed draft the page shows, if it shows one.
 */
export function wikiPlanJobCard(
  job: WikiPlanJob | null,
  context: {
    now: number;
    runnerOnline: boolean | null;
    failed?: WikiPlanJob | null;
    /** The version shown is the one in force: its writing is what the card says. */
    inForce?: boolean;
    directory?: WikiDocsDirectory | null;
  },
): WikiPlanJobCard | null {
  const draft = job && job.kind !== 'build' && (job.state === 'queued' || job.state === 'held' || job.state === 'running') ? job : null;
  const build = context.inForce ? wikiPlanBuildJob({ job }) : null;
  const open = draft ?? build;
  const held = wikiPlanHeld(open, context.runnerOnline);
  if (open && held) {
    return {
      look: 'held',
      title: WIKI_PLAN_HELD,
      text: wikiPlanHeldText(open, held),
      link: held === 'runner_offline' ? { label: WIKI_PLAN_VIEW_RUNNERS, to: 'runners', sessionId: null } : { label: WIKI_PLAN_SET_UP, to: 'settings', sessionId: null },
      progress: null,
    };
  }
  if (open?.state === 'queued') {
    const started = open.waitingFor?.startedAt ? ` (started ${wikiAgo(open.waitingFor.startedAt, context.now)})` : '';
    return { look: 'queued', title: WIKI_PLAN_QUEUED, text: `${WIKI_PLAN_QUEUED_TEXT}${started}`, link: runLink(open.waitingFor?.sessionId), progress: null };
  }
  if (draft?.state === 'running') {
    const who = draft.provider ?? WIKI_HISTORY_MAINTENANCE;
    const text = draft.startedAt
      ? `${who} · attempt ${draft.attempt ?? 1} of ${draft.attemptsMax} · started ${wikiAgo(draft.startedAt, context.now)}`
      : `${who} · waiting for its run to start`;
    return { look: 'drafting', title: WIKI_PLAN_DRAFTING, text, link: runLink(draft.sessionId), progress: null };
  }
  if (build?.state === 'running') {
    const counts = wikiPlanBuildCounts(build, context.directory?.plan ? context.directory.docs : null);
    const written = counts ? `${wikiCount(counts.done)} of ${wikiCount(counts.total)} written` : WIKI_PLAN_WRITING_SOON;
    return {
      look: 'writing',
      title: WIKI_PLAN_WRITING,
      text: build.startedAt ? `${written} · started ${wikiAgo(build.startedAt, context.now)}` : written,
      link: runLink(build.sessionId),
      progress: counts ? { done: counts.done, total: counts.total, now: wikiPlanWritingDoc(build, context.directory) } : null,
    };
  }
  const failed = context.failed ?? null;
  if (failed) {
    if (failed.errors.length === 0) {
      return { look: 'failed', title: WIKI_PLAN_JOB_FAILED, text: failed.error ?? 'Its run ended without a draft.', link: runLink(failed.sessionId), progress: null };
    }
    return {
      look: 'failed',
      title: WIKI_PLAN_FAILED,
      text: `${wikiPlanFailedChecks(failed.errors)} of ${WIKI_PLAN_GATE_CHECKS.length} checks failed · after ${plural(attemptsOf(failed), 'attempt', 'attempts')} · ${plural(failed.errors.length, 'error', 'errors')} listed below`,
      link: null,
      progress: null,
    };
  }
  const stopped = context.inForce && job && job.kind === 'build' && job.state === 'failed' ? job : null;
  if (stopped) {
    return { look: 'failed', title: WIKI_PLAN_BUILD_FAILED, text: wikiPlanBuildFailedText(stopped), link: runLink(stopped.sessionId), progress: null };
  }
  return null;
}

/** A build whose run has not reported a count yet. */
export const WIKI_PLAN_WRITING_SOON = 'waiting for its run to start';

/** Why the writing stopped short, and what writes the rest. */
export const wikiPlanBuildFailedText = (job: Pick<WikiPlanJob, 'error'>): string =>
  `${job.error ? `${job.error} · ` : ''}Wiki maintenance writes what’s left on its next run`;

/** The line under a writing card's bar, before the document being written: `Writing now: 3.4 会话搜索`. */
export const WIKI_PLAN_WRITING_NOW = 'Writing now:';

/**
 * The head of a job that has no version to show yet (mock 21 ⑨ B–D): `First draft · you asked Sep 29, 00:41`.
 */
export function wikiPlanJobHead(job: WikiPlanJob): string {
  const what = job.kind === 'revise' ? 'Redraft' : 'First draft';
  if (job.trigger === 'space_created') return `${what} · asked when the space was made`;
  return `${what} · you asked ${wikiMonthDayTime(job.requestedAt) ?? ''}`;
}

// ── The gate's report (mock 21 ①②) ───────────────────────────────────────────────────────────────

export const WIKI_PLAN_GATE_TITLES: Record<WikiPlanGateCheck, string> = {
  docCount: 'Documents',
  protected: 'Protected documents',
  references: 'References',
  schema: 'Fields',
};

/** The report's rows in the order the page lists them: what the reader weighs first, fields last. */
export const WIKI_PLAN_GATE_ORDER: readonly WikiPlanGateCheck[] = ['docCount', 'protected', 'references', 'schema'];

export interface WikiPlanGateRow {
  check: WikiPlanGateCheck;
  ok: boolean;
  title: string;
  text: string;
}

/** One reference the gate could not find (mock 21 ①'s table): where, what kind, what, and why. */
export interface WikiPlanRefRow {
  where: string;
  kind: string;
  ref: string;
  why: string;
}

export interface WikiPlanGate {
  passed: boolean;
  title: string;
  line: string;
  /** `local-vllm tried 3 times`, `attempt 2`. */
  aside: string | null;
  rows: WikiPlanGateRow[];
  /** The references not found, counted by kind (`23 symbols · 11 topics`), and listed. */
  refKinds: string[];
  refs: WikiPlanRefRow[];
}

/** How many of a failed draft's reference rows the report lists before `Show N more`. */
export const WIKI_PLAN_REFS_SHOWN = 6;
/** The phone's, which lists fewer. */
export const WIKI_PLAN_REFS_SHOWN_PHONE = 3;

/** The kind of reference a gate error's path points at, singular and plural: `.symbols[1]` is a symbol. */
function refKind(path: string): [string, string] {
  if (/\.sources\.code\[\d+\]\.symbols\[\d+\]$/u.test(path)) return ['Symbol', 'symbols'];
  if (/\.sources\.code\[\d+\](\.path)?$/u.test(path)) return ['Code path', 'code paths'];
  if (/\.sources\.docs\[\d+\]\.section$/u.test(path)) return ['Doc section', 'doc sections'];
  if (/\.sources\.docs\[\d+\](\.path)?$/u.test(path)) return ['Doc path', 'doc paths'];
  if (/\.sources\.contracts\[\d+\]/u.test(path)) return ['Contract', 'contracts'];
  if (/\.sessions\.projects\[\d+\]$/u.test(path)) return ['Project', 'projects'];
  if (/\.sessions\.topics\[\d+\]$/u.test(path)) return ['Topic', 'topics'];
  if (/\.sessions\.anchorPaths\[\d+\]$/u.test(path)) return ['Anchor path', 'anchor paths'];
  if (/\.sessions\.entryKinds\[\d+\]$/u.test(path)) return ['Entry kind', 'entry kinds'];
  if (/\.scopeOut\[\d+\]/u.test(path)) return ['Document', 'documents'];
  if (/\.category$/u.test(path)) return ['Category', 'categories'];
  return ['Reference', 'references'];
}

/** The document and section a gate error's path names: `plan.docs[12].sections[2]…` is `7.2 §3`. */
export function wikiPlanErrorWhere(shown: WikiPlanShown, path: string): { doc: WikiPlanShownDoc | null; where: string } {
  const doc = /(?:^|\.)docs\[(\d+)\]/u.exec(path);
  const section = /\.sections\[(\d+)\]/u.exec(path);
  const row = doc ? (shown.docs[Number(doc[1])] ?? null) : null;
  if (!row) return { doc: null, where: '—' };
  return { doc: row, where: section ? `${row.number} §${Number(section[1]) + 1}` : row.number };
}

/** The value at a gate error's path in the shown plan: the reference it could not find. */
function valueAt(shown: WikiPlanShown, path: string): string | null {
  const doc = /(?:^|\.)docs\[(\d+)\]/u.exec(path);
  const section = /\.sections\[(\d+)\]/u.exec(path);
  const row = doc ? shown.docs[Number(doc[1])] : undefined;
  const s = row && section ? row.sections[Number(section[1])] : undefined;
  if (!s) return null;
  let m: RegExpExecArray | null;
  if ((m = /\.sources\.code\[(\d+)\]\.symbols\[(\d+)\]$/u.exec(path))) {
    const code = s.sources.code[Number(m[1])];
    return code ? `${code.symbols[Number(m[2])] ?? ''} in ${code.path}` : null;
  }
  if ((m = /\.sources\.code\[(\d+)\]/u.exec(path))) return s.sources.code[Number(m[1])]?.path ?? null;
  if ((m = /\.sources\.docs\[(\d+)\]\.section$/u.exec(path))) {
    const source = s.sources.docs[Number(m[1])];
    return source ? `${source.path} § ${source.section ?? ''}` : null;
  }
  if ((m = /\.sources\.docs\[(\d+)\]/u.exec(path))) return s.sources.docs[Number(m[1])]?.path ?? null;
  if ((m = /\.sources\.contracts\[(\d+)\]/u.exec(path))) return s.sources.contracts[Number(m[1])]?.path ?? null;
  const sessions = s.sources.sessions;
  if (!sessions) return null;
  if ((m = /\.projects\[(\d+)\]$/u.exec(path))) return sessions.projects[Number(m[1])]?.title ?? null;
  if ((m = /\.topics\[(\d+)\]$/u.exec(path))) return sessions.topics[Number(m[1])] ?? null;
  if ((m = /\.anchorPaths\[(\d+)\]$/u.exec(path))) return sessions.anchorPaths[Number(m[1])] ?? null;
  if ((m = /\.entryKinds\[(\d+)\]$/u.exec(path))) return sessions.entryKinds[Number(m[1])] ?? null;
  return null;
}

/** The sections a protected document of the base lost in the shown draft, and where each went. */
export function wikiPlanLostSections(
  shown: WikiPlanShown,
  base: WikiPlanShown | null,
  slug: string,
): Array<{ number: number; title: string; movedTo: string | null }> {
  const before = base?.docs.find((doc) => doc.slug === slug);
  const now = shown.docs.find((doc) => doc.slug === slug);
  if (!before || !now || !before.protected) return [];
  const kept = new Set(now.sections.map((section) => section.title));
  return before.sections.flatMap((section, i) => {
    if (kept.has(section.title)) return [];
    const into = shown.docs.find((doc) => doc.slug !== slug && doc.sections.some((other) => other.title === section.title));
    return [{ number: i + 1, title: section.title, movedTo: into?.number ?? null }];
  });
}

const sameDoc = (a: WikiPlanShownDoc, b: WikiPlanShownDoc): boolean =>
  JSON.stringify([a.title, a.question, a.audience, a.scopeIn, a.scopeOut, a.length, a.sections.map((s) => [s.title, s.kind, s.covers, s.length])])
  === JSON.stringify([b.title, b.question, b.audience, b.scopeIn, b.scopeOut, b.length, b.sections.map((s) => [s.title, s.kind, s.covers, s.length])]);

/**
 * The protection row's sentence: each protected document of the base the draft changed, and how —
 * `3.1 lost §7 已知的坑 (moved to 11.3), §8 决策与理由 (moved to 11.1); 7.1 lost §7 … (moved to 11.3).
 * 4.2 is unchanged.` — or, when none changed, `3.1, 4.2 and 7.1 unchanged`.
 */
export function wikiPlanProtectedText(shown: WikiPlanShown, base: WikiPlanShown | null): string {
  const kept = (base?.docs ?? []).filter((doc) => doc.protected);
  if (kept.length === 0) return 'No document is protected';
  const changed: string[] = [];
  const unchanged: string[] = [];
  for (const doc of kept) {
    const now = shown.docs.find((row) => row.slug === doc.slug);
    const number = now?.number ?? doc.number;
    const lost = wikiPlanLostSections(shown, base, doc.slug);
    if (!now) changed.push(`${number} is left out`);
    else if (lost.length > 0) {
      changed.push(`${number} lost ${lost.map((s) => `§${s.number} ${s.title}${s.movedTo ? ` (moved to ${s.movedTo})` : ''}`).join(', ')}`);
    } else if (!sameDoc(doc, now)) changed.push(`${number} is changed`);
    else unchanged.push(number);
  }
  if (changed.length === 0) return `${wikiJoinAnd(unchanged)} unchanged`;
  const rest = unchanged.length > 0 ? ` ${wikiJoinAnd(unchanged)} ${unchanged.length === 1 ? 'is' : 'are'} unchanged.` : '';
  return `${changed.join('; ')}.${rest}`;
}

/**
 * The gate's report for what the page shows (mock 21 ①, E): a stored version passed it — its report says
 * what was checked, and the runner's repository check how many references were found — and a failed
 * draft carries the errors of its last round, each placed where it was found.
 */
export function wikiPlanGate(
  shown: WikiPlanShown,
  context: { base: WikiPlanShown | null; job: WikiPlanJob | null },
): WikiPlanGate {
  const sha = shown.repoCheck ? shortSha(shown.repoCheck.sha) : null;
  const at = sha ? ` · references checked at ${sha}` : '';
  if (shown.status !== 'failed') {
    const gate = shown.gate;
    const docs = gate?.docs ?? shown.docs.length;
    const target = gate?.target ?? shown.target;
    const skipped = gate?.checks.protected === 'skipped';
    const newFields = gate?.needsNewFields ?? [];
    const attempt = context.job?.version === shown.version && context.job.attempt ? `attempt ${context.job.attempt}` : null;
    return {
      passed: true,
      title: WIKI_PLAN_PASSED,
      line: `${WIKI_PLAN_GATE_CHECKS.length} checks${at}`,
      aside: attempt,
      rows: WIKI_PLAN_GATE_ORDER.map((check) => ({
        check,
        ok: true,
        title: WIKI_PLAN_GATE_TITLES[check],
        text:
          check === 'docCount'
            ? `${plural(docs, 'document', 'documents')} — within ${target.min}–${target.max}`
            : check === 'protected'
              ? skipped
                ? 'Not checked — the version is your own edit'
                : wikiPlanProtectedText(shown, context.base)
              : check === 'references'
                ? shown.repoCheck
                  ? `All ${wikiCount(shown.repoCheck.checked)} found at ${sha}`
                  : 'Every project and topic is this space’s'
                : newFields.length === 0
                  ? 'Every field is one the plan has'
                  : `${plural(newFields.length, 'field', 'fields')} to add: ${newFields.map((field) => `${field.name} (${field.at})`).join(', ')}`,
      })),
      refKinds: [],
      refs: [],
    };
  }

  const byCheck = new Map<WikiPlanGateCheck, WikiPlanGateError[]>();
  for (const error of shown.errors) byCheck.set(error.check, [...(byCheck.get(error.check) ?? []), error]);
  const refErrors = byCheck.get('references') ?? [];
  const kinds = new Map<string, number>();
  const refs: WikiPlanRefRow[] = refErrors.map((error) => {
    const [kind, many] = refKind(error.path);
    kinds.set(many, (kinds.get(many) ?? 0) + 1);
    const { where } = wikiPlanErrorWhere(shown, error.path);
    return { where, kind, ref: valueAt(shown, error.path) ?? error.path, why: error.message };
  });
  const checked = wikiPlanDraftReport(context.job)?.repo?.checked ?? null;
  const job = context.job;
  const rows = WIKI_PLAN_GATE_ORDER.map((check): WikiPlanGateRow => {
    const errors = byCheck.get(check) ?? [];
    const ok = errors.length === 0;
    let text: string;
    if (check === 'docCount') {
      text = `${plural(shown.docs.length, 'document', 'documents')} — ${ok ? 'within' : 'the plan asks for'} ${shown.target.min}–${shown.target.max}`;
    } else if (check === 'protected') {
      text = ok ? wikiPlanProtectedText(shown, context.base) : context.base ? wikiPlanProtectedText(shown, context.base) : errors.map((e) => e.message).join(' ');
    } else if (check === 'references') {
      text = ok
        ? checked !== null && sha
          ? `All ${wikiCount(checked)} found at ${sha}`
          : 'Every reference was found'
        : `${wikiCount(errors.length)}${checked !== null ? ` of ${wikiCount(checked)}` : ''} not found${sha ? ` at ${sha}` : ''} — files, symbols and headings on origin/main; projects and topics in this space`;
    } else {
      text = ok ? 'Every field is one the plan has' : `${plural(errors.length, 'field isn’t', 'fields aren’t')} the plan’s: ${errors.slice(0, 3).map((e) => `${e.path} ${e.message}`).join('; ')}`;
    }
    return { check, ok, title: WIKI_PLAN_GATE_TITLES[check], text };
  });
  const failedChecks = wikiPlanFailedChecks(shown.errors);
  return {
    passed: false,
    title: WIKI_PLAN_FAILED,
    line: `${failedChecks} of ${WIKI_PLAN_GATE_CHECKS.length} checks failed${at}`,
    aside: job ? `${shown.model ?? job.provider ?? WIKI_HISTORY_MAINTENANCE} tried ${plural(attemptsOf(job), 'time', 'times')}` : null,
    rows,
    refKinds: [...kinds.entries()].sort((a, b) => b[1] - a[1]).map(([many, count]) => `${wikiCount(count)} ${count === 1 ? many.replace(/ies$/u, 'y').replace(/s$/u, '') : many}`),
    refs,
  };
}

// ── Categories, documents and sections (mock 21 ③④, 22 ②–⑤) ─────────────────────────────────────

/** `1,200–2,000 chars`. */
export const wikiPlanChars = (length: { min: number; max: number }): string =>
  length.min === length.max ? `${wikiCount(length.min)} chars` : `${wikiCount(length.min)}–${wikiCount(length.max)} chars`;
/** A section's length: `~800 chars`. */
export const wikiPlanSectionChars = (length: number): string => `~${wikiCount(length)} chars`;

/** A category's line beside its title: `3 documents`. */
export const wikiPlanCategoryLine = (category: Pick<WikiPlanShownCategory, 'docs'>): string => plural(category.docs.length, 'document', 'documents');
/** A document's line: `5 sections · 1,200–2,000 chars`. */
export const wikiPlanDocLine = (doc: Pick<WikiPlanShownDoc, 'sections' | 'length'>): string =>
  `${plural(doc.sections.length, 'section', 'sections')} · ${wikiPlanChars(doc.length)}`;
export const wikiPlanErrorCount = (count: number): string => plural(count, 'error', 'errors');
export const wikiPlanChangeCount = (count: number): string => plural(count, 'change', 'changes');

/** The failed draft's errors that fall in one document. */
export function wikiPlanDocErrors(shown: WikiPlanShown, doc: Pick<WikiPlanShownDoc, 'index'>): WikiPlanGateError[] {
  const at = new RegExp(`(?:^|\\.)docs\\[${doc.index}\\](?:\\.|$)`, 'u');
  return shown.errors.filter((error) => at.test(error.path));
}

export const WIKI_PLAN_QUESTION = 'Question';
export const WIKI_PLAN_WRITTEN_FOR = 'Written for';
export const WIKI_PLAN_COVERS = 'Covers';
export const WIKI_PLAN_NOT_COVERED = 'Not covered';
export const WIKI_PLAN_LENGTH = 'Length';
export const WIKI_PLAN_PROTECTED = 'Protected';
export const WIKI_PLAN_DRAWS_ON = 'Draws on';
export const WIKI_PLAN_SECTIONS = 'Sections';
export const WIKI_PLAN_PROTECTED_NOTE = 'Protected — a redraft keeps it as it is; only you can change it';
export const WIKI_PLAN_NOT_PROTECTED_NOTE = 'Not protected — a redraft may change it';
export const wikiPlanSectionsHint = (count: number): string => `${wikiCount(count)} · each with where its material comes from`;

/** What a document's sections draw on, together (mock 21 ④): `3 design docs · 4 code paths · topics sessions, agent-tooling · 4 projects`. */
export function wikiPlanDrawsOn(doc: Pick<WikiPlanShownDoc, 'sections'>): string {
  const docs = new Set<string>();
  const code = new Set<string>();
  const contracts = new Set<string>();
  const topics = new Set<string>();
  const projects = new Set<string>();
  let sessions = false;
  for (const section of doc.sections) {
    section.sources.docs.forEach((source) => docs.add(source.path));
    section.sources.code.forEach((source) => code.add(source.path));
    section.sources.contracts.forEach((source) => contracts.add(source.path));
    if (section.sources.sessions) {
      sessions = true;
      section.sources.sessions.topics.forEach((topic) => topics.add(topic));
      section.sources.sessions.projects.forEach((project) => projects.add(project.id ?? project.title));
    }
  }
  const parts: string[] = [];
  if (docs.size > 0) parts.push(plural(docs.size, 'design doc', 'design docs'));
  if (code.size > 0) parts.push(plural(code.size, 'code path', 'code paths'));
  if (contracts.size > 0) parts.push(plural(contracts.size, 'contract', 'contracts'));
  if (topics.size > 0) parts.push(`topics ${[...topics].join(', ')}`);
  else if (sessions) parts.push('sessions');
  if (projects.size > 0) parts.push(plural(projects.size, 'project', 'projects'));
  return parts.length > 0 ? parts.join(' · ') : 'Nothing yet';
}

/** A section's sources in one line (mock 21 ④'s last column): `3 doc sections · 3 code files`, or `sessions`. */
export function wikiPlanSourcesSummary(section: Pick<WikiPlanShownSection, 'kind' | 'sources'>): string {
  const parts: string[] = [];
  if (section.sources.docs.length > 0) parts.push(plural(section.sources.docs.length, 'doc section', 'doc sections'));
  if (section.sources.code.length > 0) parts.push(plural(section.sources.code.length, 'code file', 'code files'));
  if (section.sources.contracts.length > 0) parts.push(plural(section.sources.contracts.length, 'contract', 'contracts'));
  if (section.sources.sessions) parts.push('sessions');
  if (parts.length > 0) return parts.join(' · ');
  return section.kind === 'overview' ? 'Sums up the sections after it' : 'No sources yet';
}

/** A section's second line on a phone (mock 22 ③): `Flow · ~800 chars · 3 doc sections · 3 code files`. */
export const wikiPlanSectionLine = (section: WikiPlanShownSection): string =>
  [wikiSectionKindLabel(section.kind), wikiPlanSectionChars(section.length), wikiPlanSourcesSummary(section)].join(' · ');

/** A section lost from a protected document, in the draft's own rows (mock 21 ④): `v1 §7 已知的坑`. */
export const wikiPlanLostLabel = (base: number, n: number, title: string): string => `v${base} §${n} ${title}`;
export const wikiPlanMovedTo = (number: string): string => `moved to ${number}`;
export const wikiPlanProtectedMove = (number: string): string => `${number} is protected — a redraft can’t move its sections out`;
/** The same on a phone, in one line: `Moved to 11.3 — 3.1 is protected`. */
export const wikiPlanProtectedMovePhone = (movedTo: string | null, number: string): string =>
  `${movedTo ? `Moved to ${movedTo}` : 'Moved out'} — ${number} is protected`;

/** A section's sources, opened (mock 21 ④, 22 ④⑤). */
export const WIKI_PLAN_SOURCE_DOCS = 'Design docs';
export const WIKI_PLAN_SOURCE_CODE = 'Code';
export const WIKI_PLAN_SOURCE_CONTRACTS = 'Contracts';
export const WIKI_PLAN_SOURCE_SESSIONS = 'Sessions — where to look for the words';
export const WIKI_PLAN_SOURCE_SESSIONS_SHORT = 'Where to look for the words';
export const WIKI_PLAN_SESSION_PROJECTS = 'Projects';
export const WIKI_PLAN_SESSION_TIME = 'Time';
export const WIKI_PLAN_SESSION_KEYWORDS = 'Keywords';
export const WIKI_PLAN_SESSION_ANCHORS = 'Anchor paths';
export const WIKI_PLAN_SESSION_KINDS = 'Entry kinds';
export const WIKI_PLAN_SESSION_TOPICS = 'Topics';
export const WIKI_PLAN_SESSION_EVIDENCE = 'Looking for';
export const WIKI_PLAN_FOUND = '✓ found';
export const WIKI_PLAN_NOT_FOUND = '✗ not found';

/** A session condition's window: `2026-08-19 → now`. */
export function wikiPlanTime(since: string | null, until: string | null): string {
  if (!since && !until) return 'any time';
  return `${since ?? 'the start'} → ${until ?? 'now'}`;
}

/** A section page's line under its title (mock 22 ④): `Flow · ~800 chars · references checked at 99cd3c4`. */
export function wikiPlanSectionMeta(shown: WikiPlanShown, section: WikiPlanShownSection): string {
  const parts = [wikiSectionKindLabel(section.kind), wikiPlanSectionChars(section.length)];
  if (section.sources.sessions && section.sources.docs.length + section.sources.code.length + section.sources.contracts.length === 0) {
    parts.push('sessions');
  } else if (shown.repoCheck) {
    parts.push(`references checked at ${shortSha(shown.repoCheck.sha)}`);
  }
  return parts.join(' · ');
}

/**
 * Whether a section's repository source was found: the runner's check says what it missed, at a path
 * (`docs[3].sections[2].code[0]`), and a failed draft's errors say where. Null for a version no runner
 * checked — an owner's edit — which the page then marks neither way.
 */
export function wikiPlanSourceFound(
  shown: WikiPlanShown,
  doc: Pick<WikiPlanShownDoc, 'index'>,
  section: number,
  kind: 'docs' | 'code' | 'contracts',
  at: number,
): boolean | null {
  const tail = `docs[${doc.index}].sections[${section}].sources.${kind}[${at}]`;
  const plain = `docs[${doc.index}].sections[${section}].${kind}[${at}]`;
  const missed =
    shown.errors.some((error) => error.check === 'references' && (error.path.includes(tail) || error.path.includes(plain)))
    || (shown.repoCheck?.missing ?? []).some((miss) => !!miss.at && (miss.at.includes(tail) || miss.at.includes(plain)));
  if (missed) return false;
  return shown.repoCheck ? true : null;
}

// ── The changes proposed (mock 21 ②⑩, 22 ⑥⑦) ─────────────────────────────────────────────────────

export const WIKI_PLAN_CHANGES = 'Changes to review';
export const wikiPlanChangesHint = (count: number): string => `${wikiCount(count)} · proposed by Wiki maintenance when what it learned fit no section`;
export const WIKI_PLAN_PROPOSED_BY = 'Proposed by';
export const WIKI_PLAN_WHY = 'Why';
export const WIKI_PLAN_CHANGE = 'Change';
export const WIKI_PLAN_SOURCES = 'Sources';
export const WIKI_PLAN_FROM = 'From';
export const WIKI_PLAN_CHECK = 'Check';
export const wikiPlanAndMore = (count: number): string => `and ${wikiCount(count)} more`;

export type WikiPlanChangeOp = 'addSection' | 'removeSection' | 'addDocument' | 'changeDocument';
export const WIKI_PLAN_OP_LABELS: Record<WikiPlanChangeOp, string> = {
  addSection: 'ADD SECTION',
  removeSection: 'REMOVE SECTION',
  addDocument: 'ADD DOCUMENT',
  changeDocument: 'CHANGE DOCUMENT',
};

/** One row of a change's section list: kept (for context), added or taken out. */
export interface WikiPlanChangeRow {
  mark: 'same' | 'add' | 'remove';
  /** `5`, `+6`, `−3`. */
  n: string;
  title: string;
  /** `Flow · ~600 chars` on an added row, the kind alone on a kept one. */
  note: string;
}

export interface WikiPlanChange {
  op: WikiPlanChangeOp;
  /** The document it changes, as the card's head names it: `7.4 Provider 与模型账号`. */
  target: string;
  /** The card's title: `Add §6 “自己的 Codex 池：…”`. */
  title: string;
  rows: WikiPlanChangeRow[];
  /** What the change does to the sections after it: `§6–10 become §7–11`. */
  renumber: string | null;
  /** The sections it adds: whose sources the card lists. */
  added: WikiPlanSectionInput[];
}

const sectionMatch = (a: { key?: string | null; title: string }, b: { key?: string | null; title: string }): boolean =>
  a.key && b.key ? a.key === b.key : a.title === b.title;

/**
 * What a proposal does to the plan it was proposed against (mock 21 ②): a section added to a document,
 * one taken out, a new document, or a document rewritten — and the rows the card shows of it, the
 * section before an addition kept for context, and what the addition does to the numbers after it.
 */
export function wikiPlanChange(proposal: Pick<WikiPlanProposal, 'change'>, base: WikiPlanShown | null): WikiPlanChange {
  const doc = proposal.change.doc;
  const before = base?.docs.find((row) => row.slug === doc.slug) ?? null;
  const sections = doc.sections ?? [];
  const note = (section: WikiPlanSectionInput): string => `${wikiSectionKindLabel(section.kind)} · ${wikiPlanSectionChars(section.length)}`;
  if (!before) {
    return {
      op: 'addDocument',
      target: doc.title,
      title: `Add document “${doc.title}”`,
      rows: sections.map((section, i) => ({ mark: 'add', n: `+${i + 1}`, title: section.title, note: note(section) })),
      renumber: null,
      added: sections,
    };
  }
  const target = `${before.number} ${before.title}`;
  const added = sections.map((section, i) => ({ section, i })).filter(({ section }) => !before.sections.some((old) => sectionMatch(section, old)));
  const removed = before.sections.map((section, i) => ({ section, i })).filter(({ section }) => !sections.some((now) => sectionMatch(now, section)));
  const count = before.sections.length;
  if (added.length > 0 && removed.length === 0) {
    const first = added[0];
    const rows: WikiPlanChangeRow[] = [];
    if (first.i > 0) {
      const prev = sections[first.i - 1];
      rows.push({ mark: 'same', n: String(first.i), title: prev.title, note: wikiSectionKindLabel(prev.kind) });
    }
    for (const { section, i } of added) rows.push({ mark: 'add', n: `+${i + 1}`, title: section.title, note: note(section) });
    const from = first.i + 1;
    const renumber = from <= count ? `§${from}–${count} become §${from + added.length}–${count + added.length}` : null;
    return {
      op: 'addSection',
      target,
      title: added.length === 1 ? `Add §${from} “${first.section.title}”` : `Add ${added.length} sections`,
      rows,
      renumber: renumber?.replace(/§(\d+)–\1 become §(\d+)–\2/u, '§$1 becomes §$2') ?? null,
      added: added.map(({ section }) => section),
    };
  }
  if (removed.length > 0 && added.length === 0) {
    const first = removed[0];
    const rows = removed.map(({ section, i }) => ({ mark: 'remove' as const, n: `−${i + 1}`, title: section.title, note: wikiSectionKindLabel(section.kind) }));
    const from = first.i + 2;
    const renumber = from <= count ? `§${from}–${count} become §${from - removed.length}–${count - removed.length}` : null;
    return {
      op: 'removeSection',
      target,
      title: removed.length === 1 ? `Remove §${first.i + 1} “${first.section.title}”` : `Remove ${removed.length} sections`,
      rows,
      renumber: renumber?.replace(/§(\d+)–\1 become §(\d+)–\2/u, '§$1 becomes §$2') ?? null,
      added: [],
    };
  }
  return {
    op: 'changeDocument',
    target,
    title: `Change “${before.title}”`,
    rows: [
      ...added.map(({ section, i }) => ({ mark: 'add' as const, n: `+${i + 1}`, title: section.title, note: note(section) })),
      ...removed.map(({ section, i }) => ({ mark: 'remove' as const, n: `−${i + 1}`, title: section.title, note: wikiSectionKindLabel(section.kind) })),
    ],
    renumber: null,
    added: added.map(({ section }) => section),
  };
}

/**
 * A section's sources as a change's card lists them (mock 21 ②): `Design doc docs/x.md § 2.2 网关`,
 * `Code src/x.ts · Symbol`, `Sessions in 「Codex 账号代管」 since 2026-09-28 · ChatGPT 登录 · 设备码`. A
 * proposal names projects by id; `projectTitle` is how the page reads them back.
 */
export function wikiPlanSourceLines(
  sources: WikiPlanSectionInput['sources'],
  projectTitle: (id: string) => string | null = () => null,
): string[] {
  const lines: string[] = [];
  for (const source of sources.docs ?? []) lines.push(`Design doc ${source.path}${source.section ? ` § ${source.section}` : ''}`);
  for (const source of sources.code ?? []) lines.push(`Code ${source.path}${source.symbols?.length ? ` · ${source.symbols.join(' · ')}` : ''}`);
  for (const source of sources.contracts ?? []) lines.push(`Contract ${source.path}`);
  const sessions = sources.sessions;
  if (sessions) {
    const projects = (sessions.projects ?? []).map((id) => `「${projectTitle(id) ?? id}」`);
    const words = [...(sessions.keywords ?? [])];
    lines.push(
      `Sessions${projects.length > 0 ? ` in ${projects.join(', ')}` : ''}${sessions.since ? ` since ${sessions.since}` : ''}${
        words.length > 0 ? ` · ${words.join(' · ')}` : ''
      }`,
    );
  }
  return lines;
}

/** The facts a change came from, the first few shown and the rest counted (mock 21 ②'s From). */
export const WIKI_PLAN_FACTS_SHOWN = 2;

/**
 * What pressing Accept will do, under the buttons (mock 21 ⑩): with no other draft waiting it accepts and
 * confirms in one press — two requests, the second only if the first passed the gate — and with a draft
 * waiting it adds the change to a new draft, which waits to be confirmed in turn.
 */
export function wikiPlanAcceptNote(state: Pick<WikiPlanState, 'confirmed' | 'draft'>, op: WikiPlanChangeOp): string {
  const next = wikiPlanNextVersion(state);
  if (state.draft) {
    return `Draft v${state.draft.version} is waiting for you — accepting adds this change to a new draft, v${next}, for you to confirm`;
  }
  return `Accepting confirms plan v${next} · Wiki maintenance writes the ${op === 'addDocument' || op === 'changeDocument' ? 'document' : 'section'} next`;
}

/** Whether Accept confirms too: only with no other unconfirmed draft (task 34WtVpkHCMNuDolv4K73K). */
export const wikiPlanAcceptConfirms = (state: Pick<WikiPlanState, 'draft'>): boolean => state.draft === null;

/** What the page says once a press has landed (mock 21 ⑩). */
export const wikiPlanConfirmed = (version: number): string => `Plan v${version} confirmed`;
export const wikiPlanChangeAdded = (version: number): string => `Change added to draft v${version}`;
export const WIKI_PLAN_CHANGE_REJECTED = 'Change rejected';
export const wikiPlanDraftSaved = (version: number): string => `Draft v${version} saved`;
export const WIKI_PLAN_REDRAFT_ASKED = 'Redraft asked for — it runs as a Wiki maintenance task';
export const WIKI_PLAN_REDRAFT_ALREADY = 'A draft is already on its way';
/** The gate refused an accepted change on the plan it now meets (the plan moved since it was proposed). */
export const WIKI_PLAN_ACCEPT_REFUSED = 'This change no longer passes the plan check, so nothing was confirmed:';

// ── Redraft… (mock 21 ⑧, 22 ⑧) ──────────────────────────────────────────────────────────────────

export const WIKI_PLAN_REDRAFT_TITLE = 'Redraft the plan';
export const WIKI_PLAN_REDRAFT_GO = 'Redraft';
export const WIKI_PLAN_REDRAFT_PLACEHOLDER = 'What should change: what to merge, split, move or leave out';

/** The dialog's sentence: what drafts it again, from which version, and how often it retries. */
export function wikiPlanRedraftNote(provider: string | null, from: { version: number; inForce: boolean } | null): string {
  const base = from ? (from.inForce ? ` from v${from.version}, the plan in force,` : ` from draft v${from.version},`) : '';
  return (
    `${provider ?? WIKI_HISTORY_MAINTENANCE} drafts it again${base} with what you write here. A draft that doesn’t pass the plan check is `
    + `redrafted with its errors, up to ${WIKI_PLAN_JOB_RULES.attemptsMax} times.`
  );
}

/** `Protected, kept as they are: 3.1 · 4.2 · 7.1`. */
export const wikiPlanProtectedKept = (numbers: readonly string[]): string => `Protected, kept as they are: ${numbers.join(' · ')}`;

// ── Edit (mock 21 ⑦, 22 ⑨) ───────────────────────────────────────────────────────────────────────

export const wikiPlanEditTitle = (number: string): string => `Edit ${number}`;
/** The drawer's first line: `Plan v2 · Draft · 3 会话`. */
export const wikiPlanEditHead = (shown: Pick<WikiPlanShown, 'version' | 'status'>, category: string): string =>
  `Plan v${shown.version} · ${WIKI_PLAN_STATUS_LABELS[shown.status]} · ${category}`;
export const WIKI_PLAN_EDIT_TITLE_FIELD = 'Title';
export const WIKI_PLAN_EDIT_KIND = 'Kind';
export const WIKI_PLAN_PROTECTED_SWITCH = 'A redraft keeps it as it is';
export const WIKI_PLAN_DRAG = 'drag to reorder';
export const WIKI_PLAN_ADD_SECTION = 'Add section';
export const WIKI_PLAN_SAVE_DRAFT = 'Save draft';
export const WIKI_PLAN_ONE_PER_LINE = 'One per line';
export const wikiPlanSaveNote = (next: number): string => `Saving makes draft v${next}; it goes through the plan check again.`;
export const wikiPlanEditSection = (n: number): string => `Edit §${n}`;

/** A section of the read, in the draft's shape: no id or position, projects by id. */
export function wikiPlanSectionInput(section: WikiPlanSection): WikiPlanSectionInput {
  const sessions = section.sources.sessions;
  const input: WikiPlanSectionInput = {
    key: section.key,
    title: section.title,
    kind: section.kind,
    covers: section.covers,
    length: section.length,
    sources: {
      docs: section.sources.docs.map((source) => ({ path: source.path, section: source.section })),
      code: section.sources.code.map((source) => ({ path: source.path, symbols: [...source.symbols] })),
      contracts: section.sources.contracts.map((source) => ({ path: source.path })),
      sessions: sessions
        ? {
            projects: sessions.projects.map((project) => project.id),
            since: sessions.since,
            until: sessions.until,
            keywords: [...sessions.keywords],
            anchorPaths: [...sessions.anchorPaths],
            entryKinds: [...sessions.entryKinds],
            topics: [...sessions.topics],
            evidence: sessions.evidence,
          }
        : null,
    },
  };
  if (Object.keys(section.extra ?? {}).length > 0) input.extra = section.extra;
  return input;
}

/** A document of the read, in the draft's shape (task 34WtVp5EjFkVmTvvJPWX5's delivery: edits carry the draft's). */
export function wikiPlanDocInput(doc: WikiPlanDoc): WikiPlanDocInput {
  const input: WikiPlanDocInput = {
    category: doc.category,
    slug: doc.slug,
    title: doc.title,
    question: doc.question,
    audience: [...doc.audience],
    scopeIn: [...doc.scopeIn],
    scopeOut: doc.scopeOut.map((out) => ({ text: out.text, docs: [...out.docs] })),
    length: { min: doc.length.min, max: doc.length.max },
    protected: doc.protected,
    sections: doc.sections.map(wikiPlanSectionInput),
  };
  if (Object.keys(doc.extra ?? {}).length > 0) input.extra = doc.extra;
  return input;
}

/** What the Edit drawer holds of a document. */
export interface WikiPlanDocForm {
  title: string;
  question: string;
  audience: string[];
  scopeIn: string[];
  length: { min: number; max: number };
  protected: boolean;
  /** In their new order. A row with a key is a section the document had; one without, a section added. */
  sections: Array<{ key: string | null; title: string; kind: WikiPlanSectionKind }>;
}

export function wikiPlanDocForm(doc: WikiPlanDoc): WikiPlanDocForm {
  return {
    title: doc.title,
    question: doc.question,
    audience: [...doc.audience],
    scopeIn: [...doc.scopeIn],
    length: { ...doc.length },
    protected: doc.protected,
    sections: doc.sections.map((section) => ({ key: section.key, title: section.title, kind: section.kind })),
  };
}

/** The length a section added in the drawer is written to until the owner says otherwise. */
export const WIKI_PLAN_NEW_SECTION_LENGTH = 500;

/**
 * The document the drawer sends: the form's fields over the document as it was — every section it kept
 * with its covers, length and sources as they were, and every section added covering what its title
 * says, with no sources yet, which the next maintenance run looks for.
 */
export function wikiPlanDocEdit(doc: WikiPlanDoc, form: WikiPlanDocForm): WikiPlanDocInput {
  const base = wikiPlanDocInput(doc);
  const byKey = new Map(base.sections.map((section) => [section.key, section]));
  const lines = (items: readonly string[]): string[] => items.map((item) => item.trim()).filter((item) => item !== '');
  return {
    ...base,
    title: form.title.trim(),
    question: form.question.trim(),
    audience: lines(form.audience),
    scopeIn: lines(form.scopeIn),
    length: { min: form.length.min, max: form.length.max },
    protected: form.protected,
    sections: form.sections.map((row) => {
      const kept = row.key ? byKey.get(row.key) : undefined;
      if (kept) return { ...kept, title: row.title.trim(), kind: row.kind };
      return { title: row.title.trim(), kind: row.kind, covers: row.title.trim(), length: WIKI_PLAN_NEW_SECTION_LENGTH, sources: {} };
    }),
  };
}

/** The request an edit is sent as (`POST …/plan/edits`): one document, over the newest version. */
export function wikiPlanEditBody(version: number, doc: WikiPlanDocInput, slug: string): { baseVersion: number; docSlug: string; doc: WikiPlanDocInput } {
  return { baseVersion: version, docSlug: slug, doc };
}

/** One section, as the phone's section page edits it (`{ baseVersion, docSlug, sectionKey, section }`). */
export function wikiPlanSectionEditBody(
  version: number,
  slug: string,
  section: WikiPlanSection,
  form: { title: string; kind: WikiPlanSectionKind; covers: string; length: number },
): { baseVersion: number; docSlug: string; sectionKey: string; section: WikiPlanSectionInput } {
  return {
    baseVersion: version,
    docSlug: slug,
    sectionKey: section.key,
    section: { ...wikiPlanSectionInput(section), title: form.title.trim(), kind: form.kind, covers: form.covers.trim(), length: form.length },
  };
}

/** A category a change would open, in the draft's shape. */
export type { WikiPlanCategoryInput };

// ── Compare with the version in force ───────────────────────────────────────────────────────────

export type WikiPlanDiff = 'new' | 'changed' | 'same';
export const WIKI_PLAN_DIFF_LABELS: Record<Exclude<WikiPlanDiff, 'same'>, string> = { new: 'New', changed: 'Changed' };

/** Each document of the shown plan against the version in force: new to it, changed, or the same. */
export function wikiPlanDiff(shown: WikiPlanShown, base: WikiPlanShown): { docs: Map<string, WikiPlanDiff>; removed: WikiPlanShownDoc[]; line: string } {
  const before = new Map(base.docs.map((doc) => [doc.slug, doc]));
  const docs = new Map<string, WikiPlanDiff>();
  for (const doc of shown.docs) {
    const old = before.get(doc.slug);
    docs.set(doc.slug, !old ? 'new' : sameDoc(old, doc) && old.category === doc.category ? 'same' : 'changed');
  }
  const removed = base.docs.filter((doc) => !shown.docs.some((row) => row.slug === doc.slug));
  const added = [...docs.values()].filter((d) => d === 'new').length;
  const changed = [...docs.values()].filter((d) => d === 'changed').length;
  return {
    docs,
    removed,
    line: `Against v${base.version}: ${wikiCount(added)} new · ${wikiCount(changed)} changed · ${wikiCount(removed.length)} left out`,
  };
}

// ── The plan on the home page (mocks 25 ③, 26 ③) ────────────────────────────────────────────────

/** What the home says of the plan, in the order the looks win: what waits on the owner first. */
export type WikiPlanLook = 'held' | 'draftFailed' | 'draftReady' | 'changes' | 'drafting' | 'queued' | 'writing' | 'noPlan';
export const WIKI_PLAN_LOOKS: readonly WikiPlanLook[] = ['held', 'draftFailed', 'draftReady', 'changes', 'drafting', 'queued', 'writing', 'noPlan'];

/**
 * The plan's look on the home (owner's call 2026-09-29: the card tops the desktop's right rail, the
 * phone's second banner): amber while something waits on the owner — a draft or the writing held, a
 * draft that failed, a draft to confirm, changes to review — blue while a draft is on its way or the
 * documents of the version in force are being written, an invitation while there is no plan. Null: a
 * plan in force, nothing waiting and nothing being written.
 */
export function wikiPlanLook(state: WikiPlanState, context: { runnerOnline: boolean | null }): WikiPlanLook | null {
  const open = wikiPlanOpenJob(state);
  const build = wikiPlanBuildJob(state);
  if (wikiPlanHeld(open ?? build, context.runnerOnline)) return 'held';
  if (wikiPlanFailedJob(state)) return 'draftFailed';
  if (state.draft) return 'draftReady';
  if (state.proposals.length > 0) return 'changes';
  if (open?.state === 'running') return 'drafting';
  if (open?.state === 'queued') return 'queued';
  if (build && state.confirmed) return 'writing';
  if (!state.confirmed && !open) return 'noPlan';
  return null;
}

/** How many things of the plan wait on the owner: the directory's amber count beside Plan. */
export function wikiPlanPending(state: WikiPlanState, runnerOnline: boolean | null): number {
  const held = wikiPlanHeld(wikiPlanOpenJob(state) ?? wikiPlanBuildJob(state), runnerOnline) ? 1 : 0;
  return held + (wikiPlanFailedJob(state) ? 1 : 0) + (state.draft ? 1 : 0) + state.proposals.length;
}

/** A phone's banner (mock 26 ③): one line in the look's colour, pressed into the plan — or into Maintenance, held. */
export interface WikiPlanBanner {
  text: string;
  tone: 'amber' | 'blue';
  to: 'plan' | 'settings';
}

/** The documents of the version in force, written of how many: the build's count, else the directory's. */
const writingCounts = (state: WikiPlanState, docs: { written: number; total: number } | null): { done: number; total: number } =>
  wikiPlanBuildCounts(wikiPlanBuildJob(state), docs) ?? { done: 0, total: 0 };

export function wikiPlanBanner(
  look: WikiPlanLook,
  state: WikiPlanState,
  context: { now: number; docs: { written: number; total: number } | null; runnerOnline: boolean | null },
): WikiPlanBanner {
  const job = wikiPlanOpenJob(state);
  switch (look) {
    case 'held': {
      const held = wikiPlanHeld(job ?? wikiPlanBuildJob(state), context.runnerOnline);
      const what = job ? 'Plan draft held' : 'Writing documents held';
      return held === 'runner_offline'
        ? { text: `${what} — the runner is offline`, tone: 'amber', to: 'plan' }
        : { text: `${what} — set up maintenance`, tone: 'amber', to: 'settings' };
    }
    case 'draftFailed':
      return { text: 'Plan draft didn’t pass the check', tone: 'amber', to: 'plan' };
    case 'draftReady':
      return { text: 'Plan draft ready to confirm', tone: 'amber', to: 'plan' };
    case 'changes':
      return { text: `${plural(state.proposals.length, 'plan change', 'plan changes')} to review`, tone: 'amber', to: 'plan' };
    case 'drafting':
      return { text: `Drafting the plan${job?.startedAt ? ` · started ${wikiAgo(job.startedAt, context.now)}` : ''}`, tone: 'blue', to: 'plan' };
    case 'queued':
      return { text: 'Plan draft queued', tone: 'blue', to: 'plan' };
    case 'writing': {
      const counts = writingCounts(state, context.docs);
      return { text: `Writing documents · ${wikiCount(counts.done)} of ${wikiCount(counts.total)}`, tone: 'blue', to: 'plan' };
    }
    case 'noPlan':
    default:
      return { text: 'No plan yet — draft one', tone: 'blue', to: 'plan' };
  }
}

/**
 * Activity's amber plan banners (design §12.3.3): the home's banner for each kind of thing of the plan
 * that waits on the owner, in the order the looks win — held, the draft that failed, the draft to
 * confirm, the changes — each with how many of `wikiPlanPending` it is, so a page's amber banners add
 * up to the number on the head's Activity badge. Empty when nothing waits.
 */
export function wikiPlanWaitingBanners(
  state: WikiPlanState,
  context: { now: number; docs: { written: number; total: number } | null; runnerOnline: boolean | null },
): Array<WikiPlanBanner & { look: WikiPlanLook; count: number }> {
  const held = wikiPlanHeld(wikiPlanOpenJob(state) ?? wikiPlanBuildJob(state), context.runnerOnline) ? 1 : 0;
  const waiting: Array<[WikiPlanLook, number]> = [
    ['held', held],
    ['draftFailed', wikiPlanFailedJob(state) ? 1 : 0],
    ['draftReady', state.draft ? 1 : 0],
    ['changes', state.proposals.length],
  ];
  return waiting
    .filter(([, count]) => count > 0)
    .map(([look, count]) => ({ ...wikiPlanBanner(look, state, context), look, count }));
}

/** The desktop's Plan card (mock 25 ③ and its A–G): its dot, count, sentence, rows, and what it offers. */
export interface WikiPlanCard {
  dot: 'amber' | 'blue' | 'grey' | null;
  count: number | null;
  /** The line under the title: `2 changes to review · v1 in force`. */
  sub: string | null;
  text: string | null;
  primary: { label: string; to: 'draft' | 'plan' | 'settings' };
  secondary: { label: string; to: 'plan' } | null;
  note: string | null;
}

export function wikiPlanCard(
  look: WikiPlanLook,
  state: WikiPlanState,
  context: { now: number; docs: { written: number; total: number } | null; runnerOnline: boolean | null; provider: string | null },
): WikiPlanCard {
  const open = wikiPlanOpenJob(state);
  const inForce = state.confirmed ? `v${state.confirmed.version}` : null;
  const topicArticles = state.confirmed ? '' : ' Until you confirm one, the Wiki shows its topic articles.';
  const planButton = { label: WIKI_PLAN_OPEN, to: 'plan' as const };
  switch (look) {
    case 'held': {
      const job = open ?? wikiPlanBuildJob(state);
      const held = wikiPlanHeld(job, context.runnerOnline) ?? 'no_maintenance_workspace';
      const text = job ? wikiPlanHeldText(job, held) : WIKI_PLAN_HELD_TEXT[held];
      return {
        dot: 'amber',
        count: 1,
        sub: null,
        text: `${open ? 'Draft held' : 'Writing held'} · ${text.charAt(0).toLowerCase()}${text.slice(1)}`,
        primary: { label: held === 'runner_offline' ? WIKI_PLAN_OPEN : WIKI_PLAN_SET_UP, to: held === 'runner_offline' ? 'plan' : 'settings' },
        secondary: held === 'runner_offline' ? null : { label: WIKI_PLAN_OPEN, to: 'plan' },
        note: null,
      };
    }
    case 'draftFailed': {
      const job = wikiPlanFailedJob(state)!;
      const version = wikiPlanNextVersion(state);
      const checks = wikiPlanFailedChecks(job.errors);
      const how = job.errors.length > 0 ? ` after ${plural(attemptsOf(job), 'attempt', 'attempts')} — ${checks} of ${WIKI_PLAN_GATE_CHECKS.length} checks failed` : '';
      return {
        dot: 'amber',
        count: 1,
        sub: null,
        text: `Draft v${version} didn’t pass the plan check${how}.${inForce ? ` ${inForce} stays in force.` : ''}`,
        primary: planButton,
        secondary: null,
        note: inForce ? `redraft of ${inForce}` : null,
      };
    }
    case 'draftReady': {
      const draft = state.draft!;
      return {
        dot: 'amber',
        count: 1,
        sub: null,
        text: `Draft v${draft.version} passed the plan check and waits for you. Documents are written once you confirm it.`,
        primary: planButton,
        secondary: null,
        note: `${plural(draft.categories.length, 'category', 'categories')} · ${plural(draft.docs.length, 'document', 'documents')}`,
      };
    }
    case 'changes':
      return {
        dot: 'amber',
        count: state.proposals.length,
        sub: `${plural(state.proposals.length, 'change', 'changes')} to review${inForce ? ` · ${inForce} in force` : ''}`,
        text: null,
        primary: planButton,
        secondary: null,
        note: context.docs ? `${wikiCount(context.docs.written)} of ${plural(context.docs.total, 'document', 'documents')} written` : null,
      };
    case 'drafting':
      return {
        dot: 'blue',
        count: null,
        sub: null,
        text: `Drafting the plan · ${open?.provider ?? WIKI_HISTORY_MAINTENANCE} · attempt ${open?.attempt ?? 1} of ${open?.attemptsMax ?? WIKI_PLAN_JOB_RULES.attemptsMax}${
          open?.startedAt ? ` · started ${wikiAgo(open.startedAt, context.now)}` : ''
        }.${topicArticles}`,
        primary: planButton,
        secondary: null,
        note: null,
      };
    case 'queued':
      return {
        dot: 'grey',
        count: null,
        sub: null,
        text: `Draft queued · ${WIKI_PLAN_QUEUED_TEXT}.`,
        primary: planButton,
        secondary: null,
        note: null,
      };
    case 'writing': {
      const counts = writingCounts(state, context.docs);
      return {
        dot: 'blue',
        count: null,
        sub: null,
        text: `${inForce} confirmed ${wikiMonthDay(state.confirmed?.confirmedAt ?? '') ?? ''} by you · ${WIKI_HISTORY_MAINTENANCE} is writing the documents: ${wikiCount(counts.done)} of ${wikiCount(counts.total)} written.`,
        primary: planButton,
        secondary: null,
        note: null,
      };
    }
    case 'noPlan':
    default:
      return {
        dot: null,
        count: null,
        sub: null,
        text: 'No plan yet. A plan lays out this wiki’s documents; until you confirm one, the Wiki shows its topic articles.',
        primary: { label: WIKI_PLAN_DRAFT, to: 'draft' },
        secondary: null,
        note: `${context.provider ?? WIKI_HISTORY_MAINTENANCE} · about 1–2 hours`,
      };
  }
}

/** A change's row on the home card (mock 25 ③): its op chip, `7.4 · 自己的 Codex 池…`, and how long ago. */
export function wikiPlanCardRow(proposal: WikiPlanProposal, base: WikiPlanShown | null): { op: string; text: string } {
  const change = wikiPlanChange(proposal, base);
  const doc = base?.docs.find((row) => row.slug === proposal.change.doc.slug);
  const what = change.added[0]?.title ?? proposal.change.doc.title;
  return { op: WIKI_PLAN_OP_LABELS[change.op], text: doc ? `${doc.number} · ${what}` : what };
}

// ── The page's order ────────────────────────────────────────────────────────────────────────────

/** The plan page's blocks, top to bottom — the web phone's order, and the one iOS draws (mock 22 ②). */
export const WIKI_PLAN_PAGE_SECTIONS = ['crumb', 'title', 'meta', 'actions', 'hint', 'job', 'gate', 'changes', 'documents'] as const;
/** A document's own page on a phone (mock 22 ③). */
export const WIKI_PLAN_DOC_SECTIONS = ['crumb', 'title', 'meta', 'fields', 'sections'] as const;
/** A section's own page on a phone (mock 22 ④⑤). */
export const WIKI_PLAN_SECTION_SECTIONS = ['crumb', 'title', 'meta', 'covers', 'sources'] as const;
/** A change's card, top to bottom (mock 21 ②, 22 ⑥). */
export const WIKI_PLAN_CHANGE_PARTS = ['head', 'title', 'why', 'change', 'sources', 'from', 'check', 'actions'] as const;
