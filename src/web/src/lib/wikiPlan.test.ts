// @vitest-environment jsdom
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WikiDocsDirectory, WikiPlanJob, WikiPlanProposal, WikiPlanState, WikiPlanVersion, WikiPlanVersionSummary } from '@orbit/shared';
import { wikiPlanStateOf } from './queries';
import * as P from './wikiPlan';
import { acceptWikiPlanProposal, wikiPlanGateErrors } from './wikiWrites';

/**
 * The plan's words and readings (criterion 10 revised and criterion 11, mocks 21, 22, 25, 26), proved
 * against the `plan` half of `src/shared/src/wiki-docs.fixture.json` — the cases OrbitKit's
 * `WikiPlanCopyParityTests` reads too: every state the page and the home say something different of (no
 * plan, queued, drafting, held, a draft waiting or failed, changes, the documents being written, held or
 * stopped), the gate's report, the documents, a document's and a section's pages, the changes proposed,
 * and an edit's request in the draft's shape.
 */

interface StateCase {
  spec: { confirmed: 'v1' | null; draft: 'v2' | null; proposals: boolean; job: string | null; runnerOnline: boolean | null };
  look: P.WikiPlanLook | null;
  pending: number;
  banner: P.WikiPlanBanner | null;
  open: string | null;
  build: string | null;
  failed: string | null;
  nextVersion: number;
  shown: { version: number; status: string; label: string; statusLabel: string } | null;
  head: string | null;
  meta: string[] | null;
  hint: string | null;
  jobCard: P.WikiPlanJobCard | null;
  gate: Omit<P.WikiPlanGate, never> | null;
  categories: unknown[];
  acceptConfirms: boolean;
}

interface PlanFixture {
  words: Record<string, unknown>;
  orders: { page: string[]; doc: string[]; section: string[]; change: string[]; looks: string[] };
  versions: { v1: WikiPlanVersion; v2: WikiPlanVersion };
  proposals: WikiPlanProposal[];
  jobs: Record<string, WikiPlanJob>;
  states: Record<string, StateCase>;
  versionRows: { versions: WikiPlanVersionSummary[]; failed: { version: number; at: string }; rows: P.WikiPlanVersionRow[] };
  docPages: Array<Record<string, unknown> & { version: number; slug: string }>;
  changes: Array<Record<string, unknown> & { proposal: string }>;
  counts: Record<string, Array<Record<string, unknown> & { says: string }>>;
  edit: {
    stored: WikiPlanVersion['docs'][number];
    input: unknown;
    form: P.WikiPlanDocForm;
    body: unknown;
    section: { index: number; form: { title: string; kind: 'interface'; covers: string; length: number }; body: unknown };
  };
}

function readFixture(): { timeZone: string; now: string; docs: { directory: { read: WikiDocsDirectory } }; plan: PlanFixture } {
  const candidates = [
    resolve(process.cwd(), '../shared/src/wiki-docs.fixture.json'),
    resolve(process.cwd(), 'src/shared/src/wiki-docs.fixture.json'),
  ];
  const path = candidates.find((candidate) => existsSync(candidate));
  if (!path) throw new Error(`wiki-docs.fixture.json not found from ${process.cwd()}`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Run `fn` with the process in `tz`: Node re-reads `process.env.TZ` on the next Date call. */
function inTimeZone<T>(tz: string, fn: () => T): T {
  const before = process.env.TZ;
  process.env.TZ = tz;
  try {
    return fn();
  } finally {
    if (before === undefined) delete process.env.TZ;
    else process.env.TZ = before;
  }
}

const fixture = readFixture();
const plan = fixture.plan;
const now = Date.parse(fixture.now);

/** A state, whole, from its spec in the fixture: its versions, proposals and job, each by name. */
function stateOf(spec: StateCase['spec']): WikiPlanState {
  return {
    spaceId: 'sp1',
    confirmed: spec.confirmed ? plan.versions[spec.confirmed] : null,
    draft: spec.draft ? plan.versions[spec.draft] : null,
    proposals: spec.proposals ? plan.proposals : [],
    job: spec.job ? plan.jobs[spec.job] : null,
  };
}

/** What the page shows first, and what it is held against, as `WikiPlanPage` reads them. */
function shownOf(state: WikiPlanState) {
  const shown = P.wikiPlanDefault(state);
  const newest = P.wikiPlanNewest(state);
  const base = shown
    ? shown.status === 'failed'
      ? newest
        ? P.wikiPlanFromVersion(newest)
        : null
      : shown.status === 'draft' && state.confirmed
        ? P.wikiPlanFromVersion(state.confirmed)
        : null
    : null;
  return { shown, base };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the plan's words", () => {
  it('are the fixture’s, every one', () => {
    const w = plan.words;
    const pairs: Array<[unknown, unknown]> = [
      [P.WIKI_PLAN_TITLE, w.title],
      [P.WIKI_PLAN_REDRAFT, w.redraft],
      [P.WIKI_PLAN_CONFIRM, w.confirm],
      [P.WIKI_PLAN_DRAFT, w.draft],
      [P.WIKI_PLAN_OPEN, w.open],
      [P.WIKI_PLAN_EDIT, w.edit],
      [P.WIKI_PLAN_ACCEPT, w.accept],
      [P.WIKI_PLAN_REJECT, w.reject],
      [P.WIKI_PLAN_CANCEL, w.cancel],
      [P.WIKI_PLAN_VIEW_RUN, w.viewRun],
      [P.WIKI_PLAN_SET_UP, w.setUp],
      [P.WIKI_PLAN_VIEW_RUNNERS, w.viewRunners],
      [P.WIKI_PLAN_NONE, w.none],
      [P.WIKI_PLAN_EMPTY_TITLE, w.emptyTitle],
      [P.WIKI_PLAN_DOCUMENTS, w.documents],
      [P.WIKI_PLAN_IN_FORCE, w.inForce],
      [P.WIKI_PLAN_QUEUED, w.queued],
      [P.WIKI_PLAN_DRAFTING, w.drafting],
      [P.WIKI_PLAN_HELD, w.held],
      [P.WIKI_PLAN_FAILED, w.failed],
      [P.WIKI_PLAN_PASSED, w.passed],
      [P.WIKI_PLAN_WRITING, w.writing],
      [P.WIKI_PLAN_WRITING_NOW, w.writingNow],
      [P.WIKI_PLAN_JOB_FAILED, w.jobFailed],
      [P.WIKI_PLAN_BUILD_FAILED, w.buildFailed],
      [P.WIKI_PLAN_QUESTION, w.question],
      [P.WIKI_PLAN_WRITTEN_FOR, w.writtenFor],
      [P.WIKI_PLAN_COVERS, w.covers],
      [P.WIKI_PLAN_NOT_COVERED, w.notCovered],
      [P.WIKI_PLAN_LENGTH, w.length],
      [P.WIKI_PLAN_PROTECTED, w.protected],
      [P.WIKI_PLAN_DRAWS_ON, w.drawsOn],
      [P.WIKI_PLAN_SECTIONS, w.sections],
      [P.WIKI_PLAN_SOURCE_DOCS, w.sourceDocs],
      [P.WIKI_PLAN_SOURCE_CODE, w.sourceCode],
      [P.WIKI_PLAN_SOURCE_CONTRACTS, w.sourceContracts],
      [P.WIKI_PLAN_SOURCE_SESSIONS_SHORT, w.sourceSessions],
      [P.WIKI_PLAN_SESSION_PROJECTS, w.sessionProjects],
      [P.WIKI_PLAN_SESSION_TIME, w.sessionTime],
      [P.WIKI_PLAN_SESSION_KEYWORDS, w.sessionKeywords],
      [P.WIKI_PLAN_SESSION_ANCHORS, w.sessionAnchors],
      [P.WIKI_PLAN_SESSION_KINDS, w.sessionKinds],
      [P.WIKI_PLAN_SESSION_TOPICS, w.sessionTopics],
      [P.WIKI_PLAN_SESSION_EVIDENCE, w.sessionEvidence],
      [P.WIKI_PLAN_FOUND, w.found],
      [P.WIKI_PLAN_NOT_FOUND, w.notFound],
      [P.WIKI_PLAN_CHANGES, w.changes],
      [P.WIKI_PLAN_PROPOSED_BY, w.proposedBy],
      [P.WIKI_PLAN_WHY, w.why],
      [P.WIKI_PLAN_CHANGE, w.change],
      [P.WIKI_PLAN_SOURCES, w.sources],
      [P.WIKI_PLAN_FROM, w.from],
      [P.WIKI_PLAN_CHECK, w.check],
      [P.WIKI_PLAN_CHANGE_REJECTED, w.changeRejected],
      [P.WIKI_PLAN_REDRAFT_ASKED, w.redraftAsked],
      [P.WIKI_PLAN_REDRAFT_ALREADY, w.redraftAlready],
      [P.WIKI_PLAN_ACCEPT_REFUSED, w.acceptRefused],
      [P.WIKI_PLAN_REDRAFT_TITLE, w.redraftTitle],
      [P.WIKI_PLAN_REDRAFT_GO, w.redraftGo],
      [P.WIKI_PLAN_REDRAFT_PLACEHOLDER, w.redraftPlaceholder],
      [P.WIKI_PLAN_EDIT_TITLE_FIELD, w.editTitleField],
      [P.WIKI_PLAN_EDIT_KIND, w.editKind],
      [P.WIKI_PLAN_PROTECTED_SWITCH, w.protectedSwitch],
      [P.WIKI_PLAN_ADD_SECTION, w.addSection],
      [P.WIKI_PLAN_SAVE_DRAFT, w.saveDraft],
      [P.WIKI_PLAN_PROTECTED_NOTE, w.protectedNote],
      [P.WIKI_PLAN_NOT_PROTECTED_NOTE, w.notProtectedNote],
      [P.WIKI_PLAN_STATUS_LABELS, w.statusLabels],
      [P.WIKI_PLAN_OP_LABELS, w.opLabels],
      [P.WIKI_PLAN_GATE_TITLES, w.gateTitles],
      [[...P.WIKI_PLAN_GATE_ORDER], w.gateOrder],
      [P.WIKI_PLAN_HELD_TEXT, w.heldText],
      [P.WIKI_PLAN_BUILD_HELD_TEXT, w.buildHeldText],
      [P.WIKI_PLAN_REFS_SHOWN_PHONE, w.refsShownPhone],
      [P.WIKI_PLAN_FACTS_SHOWN, w.factsShown],
      [P.WIKI_PLAN_NEW_SECTION_LENGTH, w.newSectionLength],
    ];
    for (const [ours, theirs] of pairs) expect(ours).toEqual(theirs);
  });

  it('never say the daily limit: the owner’s drafts and builds are not held by it (owner’s call 2026-09-29)', () => {
    const said = JSON.stringify([P.WIKI_PLAN_HELD_TEXT, P.WIKI_PLAN_BUILD_HELD_TEXT]);
    expect(said).not.toMatch(/daily|limit/iu);
    expect(Object.keys(P.WIKI_PLAN_HELD_TEXT).sort()).toEqual(['maintenance_provider_unusable', 'no_maintenance_workspace', 'runner_offline']);
  });

  it('count and date as the fixture says', () => {
    const c = plan.counts;
    for (const row of c.chars) expect(P.wikiPlanChars(row.length as { min: number; max: number })).toBe(row.says);
    for (const row of c.sectionChars) expect(P.wikiPlanSectionChars(row.n as number)).toBe(row.says);
    for (const row of c.errors) expect(P.wikiPlanErrorCount(row.n as number)).toBe(row.says);
    for (const row of c.changesCount) expect(P.wikiPlanChangeCount(row.n as number)).toBe(row.says);
    for (const row of c.time) expect(P.wikiPlanTime(row.since as string | null, row.until as string | null)).toBe(row.says);
    for (const row of c.redraftNotes) {
      expect(P.wikiPlanRedraftNote(row.provider as string | null, row.from as { version: number; inForce: boolean } | null)).toBe(row.says);
    }
    for (const row of c.protectedKept) expect(P.wikiPlanProtectedKept(row.numbers as string[])).toBe(row.says);
    for (const row of c.emptyText) expect(P.wikiPlanEmptyText(row.provider as string | null)).toBe(row.says);
    for (const row of c.emptyNote) expect(P.wikiPlanEmptyNote(row.where as string | null, row.provider as string | null)).toBe(row.says);
    for (const row of c.saveNote) expect(P.wikiPlanSaveNote(row.n as number)).toBe(row.says);
    for (const row of c.editTitle) expect(P.wikiPlanEditTitle(row.number as string)).toBe(row.says);
    for (const row of c.confirmed) expect(P.wikiPlanConfirmed(row.n as number)).toBe(row.says);
    for (const row of c.changeAdded) expect(P.wikiPlanChangeAdded(row.n as number)).toBe(row.says);
    for (const row of c.draftSaved) expect(P.wikiPlanDraftSaved(row.n as number)).toBe(row.says);
    for (const row of c.andMore) expect(P.wikiPlanAndMore(row.n as number)).toBe(row.says);
    for (const row of c.failedHint) expect(P.wikiPlanFailedHint(row.inForce as number | null)).toBe(row.says);
  });

  it('are drawn in the fixture’s orders: the page, a document’s, a section’s, a change’s card, and the home’s looks', () => {
    expect([...P.WIKI_PLAN_PAGE_SECTIONS]).toEqual(plan.orders.page);
    expect([...P.WIKI_PLAN_DOC_SECTIONS]).toEqual(plan.orders.doc);
    expect([...P.WIKI_PLAN_SECTION_SECTIONS]).toEqual(plan.orders.section);
    expect([...P.WIKI_PLAN_CHANGE_PARTS]).toEqual(plan.orders.change);
    expect([...P.WIKI_PLAN_LOOKS]).toEqual(plan.orders.looks);
  });
});

describe('every state of the plan', () => {
  for (const [name, expected] of Object.entries(plan.states)) {
    it(`${name}: the home's look and banner, the page's version, head, job and gate`, () => {
      const state = stateOf(expected.spec);
      const runnerOnline = expected.spec.runnerOnline;
      const look = P.wikiPlanLook(state, { runnerOnline });
      expect(look).toBe(expected.look);
      expect(P.wikiPlanPending(state, runnerOnline)).toBe(expected.pending);
      expect(P.wikiPlanOpenJob(state)?.id ?? null).toBe(expected.open);
      expect(P.wikiPlanBuildJob(state)?.id ?? null).toBe(expected.build);
      expect(P.wikiPlanFailedJob(state)?.id ?? null).toBe(expected.failed);
      expect(P.wikiPlanNextVersion(state)).toBe(expected.nextVersion);
      expect(P.wikiPlanAcceptConfirms(state)).toBe(expected.acceptConfirms);
      const docs = state.confirmed ? { written: 3, total: 5 } : null;
      inTimeZone(fixture.timeZone, () => {
        expect(look ? P.wikiPlanBanner(look, state, { now, docs, runnerOnline }) : null).toEqual(expected.banner);
        const { shown, base } = shownOf(state);
        expect(shown ? { version: shown.version, status: shown.status, label: P.wikiPlanVersionLabel(shown.version), statusLabel: P.WIKI_PLAN_STATUS_LABELS[shown.status] } : null).toEqual(
          expected.shown,
        );
        const open = P.wikiPlanOpenJob(state);
        const failed = P.wikiPlanFailedJob(state);
        const inForce = shown?.status === 'confirmed' && state.confirmed?.version === shown.version;
        expect(!shown && open ? P.wikiPlanJobHead(open) : null).toBe(expected.head);
        expect(shown ? P.wikiPlanMeta(shown, { job: shown.status === 'failed' ? failed : (open ?? state.job), docs: inForce ? docs : null }) : null).toEqual(expected.meta);
        expect(shown?.status === 'failed' ? P.wikiPlanFailedHint(state.confirmed?.version ?? null) : null).toBe(expected.hint);
        const directory = state.confirmed ? fixture.docs.directory.read : null;
        expect(P.wikiPlanJobCard(state.job, { now, runnerOnline, failed: shown?.status === 'failed' ? failed : null, inForce, directory })).toEqual(expected.jobCard);
        const gate = shown && (shown.status === 'draft' || shown.status === 'failed') ? P.wikiPlanGate(shown, { base, job: shown.status === 'failed' ? failed : state.job }) : null;
        expect(gate).toEqual(expected.gate);
        expect(
          shown
            ? shown.categories.map((category) => ({
                key: category.key,
                number: category.number,
                title: category.title,
                line: P.wikiPlanCategoryLine(category),
                docs: category.docs.map((doc) => {
                  const errors = P.wikiPlanDocErrors(shown, doc).length;
                  return { slug: doc.slug, number: doc.number, title: doc.title, protected: doc.protected, errors, errorLabel: errors > 0 ? P.wikiPlanErrorCount(errors) : null, line: P.wikiPlanDocLine(doc) };
                }),
              }))
            : [],
        ).toEqual(expected.categories);
      });
    });
  }

  it('holds a draft whose run never started while the maintenance runner is offline, and says so without the daily limit', () => {
    const offline = plan.states.noneOffline;
    expect(offline.jobCard?.look).toBe('held');
    expect(offline.jobCard?.link?.to).toBe('runners');
    expect(offline.banner?.tone).toBe('amber');
  });
});

describe('the version menu, a document’s and a section’s pages', () => {
  it('lists every version with a failed draft over them', () => {
    inTimeZone(fixture.timeZone, () => {
      expect(P.wikiPlanVersionRows(plan.versionRows.versions, plan.versionRows.failed)).toEqual(plan.versionRows.rows);
    });
  });

  it('reads a document of the shown version as its page does, with the sections a protected document lost', () => {
    for (const expected of plan.docPages) {
      const state = expected.version === 1 ? stateOf(plan.states.inForce.spec) : stateOf(plan.states.draftFailed.spec);
      const { shown, base } = shownOf(state);
      const doc = shown!.docs.find((row) => row.slug === expected.slug)!;
      const numbers = new Map(shown!.docs.map((row) => [row.slug, row.number]));
      const errors = P.wikiPlanDocErrors(shown!, doc).length;
      expect({
        version: shown!.version,
        slug: doc.slug,
        title: doc.title,
        number: doc.number,
        protected: doc.protected,
        head: [`${P.wikiPlanVersionLabel(shown!.version)} · ${P.WIKI_PLAN_STATUS_LABELS[shown!.status]}`, ...(errors > 0 ? [P.wikiPlanErrorCount(errors)] : []), P.wikiPlanDocLine(doc)],
        length: P.wikiPlanChars(doc.length),
        protectedNote: doc.protected ? P.WIKI_PLAN_PROTECTED_NOTE : P.WIKI_PLAN_NOT_PROTECTED_NOTE,
        drawsOn: P.wikiPlanDrawsOn(doc),
        scopeOut: doc.scopeOut.map((out) => ({ text: out.text, see: out.docs.map((target) => `→ ${numbers.get(target) ?? target}`) })),
        sections: doc.sections.map((section, index) => ({
          n: index + 1,
          title: section.title,
          line: P.wikiPlanSectionLine(section),
          meta: P.wikiPlanSectionMeta(shown!, section),
          sources: {
            docs: section.sources.docs.map((source, k) => ({ path: source.path, section: source.section, found: P.wikiPlanSourceFound(shown!, doc, index, 'docs', k) })),
            code: section.sources.code.map((source, k) => ({ path: source.path, symbols: source.symbols, found: P.wikiPlanSourceFound(shown!, doc, index, 'code', k) })),
            contracts: section.sources.contracts.map((source, k) => ({ path: source.path, found: P.wikiPlanSourceFound(shown!, doc, index, 'contracts', k) })),
            sessions: section.sources.sessions
              ? {
                  projects: section.sources.sessions.projects.map((project) => project.title),
                  time: P.wikiPlanTime(section.sources.sessions.since, section.sources.sessions.until),
                  keywords: section.sources.sessions.keywords,
                  anchorPaths: section.sources.sessions.anchorPaths,
                  entryKinds: section.sources.sessions.entryKinds.join(' · '),
                  topics: section.sources.sessions.topics.join(' · '),
                  evidence: section.sources.sessions.evidence,
                }
              : null,
          },
        })),
        lost: P.wikiPlanLostSections(shown!, base, doc.slug).map((row) => ({
          number: row.number,
          label: P.wikiPlanLostLabel(base?.version ?? 0, row.number, row.title),
          why: P.wikiPlanProtectedMovePhone(row.movedTo, doc.number),
        })),
      }).toEqual(expected);
    }
  });
});

describe('the changes proposed', () => {
  it('say what each does to the version in force, where its sections come from, and what Accept will do', () => {
    const base = P.wikiPlanFromVersion(plan.versions.v1);
    const titles: Record<string, string> = { pr9: 'Codex 账号代管' };
    for (const expected of plan.changes) {
      const proposal = plan.proposals.find((row) => row.id === expected.proposal)!;
      const change = P.wikiPlanChange(proposal, base);
      expect({
        proposal: proposal.id,
        op: change.op,
        opLabel: P.WIKI_PLAN_OP_LABELS[change.op],
        target: change.target,
        title: change.title,
        rows: change.rows,
        renumber: change.renumber,
        sources: change.added.flatMap((section) => P.wikiPlanSourceLines(section.sources, (id) => titles[id] ?? null)),
        facts: proposal.facts.slice(0, P.WIKI_PLAN_FACTS_SHOWN).map((fact) => fact.id),
        more: proposal.facts.length > P.WIKI_PLAN_FACTS_SHOWN ? P.wikiPlanAndMore(proposal.facts.length - P.WIKI_PLAN_FACTS_SHOWN) : null,
        acceptNote: P.wikiPlanAcceptNote(stateOf(plan.states.changes.spec), change.op),
        acceptNoteWithDraft: P.wikiPlanAcceptNote(stateOf(plan.states.draftReady.spec), change.op),
      }).toEqual(expected);
    }
  });
});

describe('an edit', () => {
  it('sends the draft’s shape, not the read’s: no ids or positions, a session condition’s projects by id', () => {
    const { edit } = plan;
    expect(P.wikiPlanDocInput(edit.stored)).toEqual(edit.input);
    expect(P.wikiPlanEditBody(2, P.wikiPlanDocEdit(edit.stored, edit.form), edit.stored.slug)).toEqual(edit.body);
    expect(P.wikiPlanSectionEditBody(2, edit.stored.slug, edit.stored.sections[edit.section.index], edit.section.form)).toEqual(edit.section.body);
    const flat = JSON.stringify(edit.body);
    expect(flat).not.toMatch(/"id":|"position":/u);
    const sessions = (edit.body as { doc: { sections: Array<{ sources: { sessions?: { projects: unknown[] } | null } }> } }).doc.sections
      .map((section) => section.sources.sessions)
      .filter(Boolean);
    for (const condition of sessions) for (const project of condition!.projects) expect(typeof project).toBe('string');
  });
});

describe('accepting a change', () => {
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  it('with no other draft waiting, accepts and then confirms the draft it made: two requests', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push(`${init?.method ?? 'GET'} ${url}`);
        if (url.endsWith('/plan-proposals/pp1/decide')) return reply(200, { proposal: plan.proposals[0], draft: { ...plan.versions.v2, version: 2 } });
        if (url.endsWith('/plan/versions/2/confirm')) return reply(200, { ...plan.versions.v2, status: 'confirmed' });
        return reply(404, {});
      }),
    );
    const answer = await acceptWikiPlanProposal('sp1', 'pp1', true);
    expect(answer.confirmed?.status).toBe('confirmed');
    expect(calls).toEqual(['POST /api/wiki/plan-proposals/pp1/decide', 'POST /api/wiki/spaces/sp1/plan/versions/2/confirm']);
  });

  it('when the gate refuses the change, confirms nothing and hands back the errors', async () => {
    const calls: string[] = [];
    const errors = [{ check: 'references', path: 'plan.docs[1].sections[2].sources.code[0]', message: 'no such file' }];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push(`${init?.method ?? 'GET'} ${String(input)}`);
        return reply(422, { code: 'WIKI_PLAN_GATE', message: '1 error', errors });
      }),
    );
    const refused = await acceptWikiPlanProposal('sp1', 'pp1', true).catch((error: unknown) => error);
    expect(wikiPlanGateErrors(refused)).toEqual(errors);
    expect(calls).toEqual(['POST /api/wiki/plan-proposals/pp1/decide']);
  });

  it('with a draft waiting, accepts only, and stays on the new draft', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push(`${init?.method ?? 'GET'} ${String(input)}`);
        return reply(200, { proposal: plan.proposals[0], draft: { ...plan.versions.v2, version: 3 } });
      }),
    );
    const answer = await acceptWikiPlanProposal('sp1', 'pp1', P.wikiPlanAcceptConfirms(stateOf(plan.states.draftReady.spec)));
    expect(answer).toMatchObject({ confirmed: null, draft: { version: 3 } });
    expect(calls).toEqual(['POST /api/wiki/plan-proposals/pp1/decide']);
  });
});

describe("the plan's read", () => {
  it('is null for an answer that is not one, and fills in a field left out', () => {
    expect(wikiPlanStateOf([])).toBeNull();
    expect(wikiPlanStateOf(null)).toBeNull();
    expect(wikiPlanStateOf({ spaceId: 'sp1' })).toEqual({ spaceId: 'sp1', confirmed: null, draft: null, proposals: [], job: null });
  });
});
