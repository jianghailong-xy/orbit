import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PUBLIC_ID_FIELDS } from './codec';
import { WIKI_IMPORT_RULES } from './wiki';
import {
  KIND_SPECS,
  WIKI_ANCHOR_SPECS,
  WIKI_ANCHOR_STATES,
  WIKI_ANCHOR_TYPES,
  WIKI_ANCHOR_RULES,
  WIKI_AUTHOR_KINDS,
  WIKI_CHALLENGE_ANSWERS,
  WIKI_CHANGESET_ORIGINS,
  WIKI_CHANGESET_STATUSES,
  WIKI_CONTRACT_VERSION,
  WIKI_CURSOR_FACT_KINDS,
  WIKI_CURSOR_OUTCOMES,
  WIKI_DECIDE_ACTIONS,
  WIKI_DEFAULT_MAINTENANCE_SETTINGS,
  WIKI_DEFAULT_SPACE_SETTINGS,
  WIKI_EFFECT_POLICY,
  WIKI_ENTRY_KINDS,
  WIKI_ENTRY_STATUSES,
  WIKI_EXPOSURE_CHANNELS,
  WIKI_GIT_ANCHOR_TYPES,
  WIKI_KINDS,
  WIKI_LIMITS,
  WIKI_MAINTENANCE_DAILY_RUN_LIMIT,
  WIKI_MAINTENANCE_LOOKBACK_DAYS,
  WIKI_MAINTENANCE_RULES,
  WIKI_OPS,
  WIKI_OP_DECISIONS,
  WIKI_PUSHABLE_TRUST,
  WIKI_REFUSAL_CODES,
  WIKI_REJECT_REASONS,
  WIKI_REJECT_REASON_LABELS,
  WIKI_RESERVED_KINDS,
  WIKI_REVIEW_MODES,
  WIKI_REVIEW_RULES,
  WIKI_SEARCH_MATCHES,
  WIKI_SLUG_PATTERN,
  WIKI_SOURCE_KINDS,
  WIKI_SOURCE_REFS,
  WIKI_SOURCE_ROW_ID_KINDS,
  WIKI_SOURCE_STATES,
  WIKI_TRUST_LEVELS,
  WIKI_UNSET_REVIEW_MODE,
  WIKI_VERIFICATION_EVIDENCE,
  WIKI_VERIFICATION_VERDICTS,
  WIKI_VOUCHED_TRUST,
  validateWikiEntryDraft,
  validateWikiSources,
  type WikiChangeset,
  type WikiChangesetCounts,
  type WikiChangesetView,
  type WikiDossierSource,
  type WikiDossierSpan,
  type WikiEntryAppliedBy,
  wikiEstimateTokens,
  wikiMaintenanceSettings,
  wikiOpEffect,
  wikiReviewEffect,
  wikiSpaceSettings,
  wikiTieredBasis,
  wikiVerdictEffect,
  wikiVerdictTrust,
} from './wiki';
import {
  WIKI_ARTICLE_CATEGORIES,
  WIKI_ARTICLE_CATEGORY_KEYS,
  WIKI_ARTICLE_ENTRIES_LISTED,
  WIKI_ARTICLE_KINDS,
  WIKI_ARTICLE_RULES,
  WIKI_ARTICLES_JOB,
  WIKI_DEFAULT_TOPICS,
  wikiArticleChars,
  type WikiArticleView,
} from './wikiArticles';
import {
  WIKI_MAINTENANCE_CATCH_UP,
  WIKI_MAINTENANCE_CATCH_UP_STATES,
  WIKI_MAINTENANCE_DOCS_RULES,
  WIKI_MAINTENANCE_DOCS_SKIPPED,
  WIKI_MAINTENANCE_DUE,
  WIKI_MAINTENANCE_FAILURE_KINDS,
  WIKI_MAINTENANCE_HELD_REASONS,
  WIKI_MAINTAIN_JOB,
  WIKI_MAINTENANCE_JOB,
  wikiMaintenanceBehind,
  wikiMaintenanceRunSessions,
  type WikiMaintenanceReport,
} from './wikiMaintain';
import {
  WIKI_REPO_OPS,
  WIKI_REPO_LOOKS,
  WIKI_REPO_OP_CAPABILITY,
  WIKI_REPO_OP_KINDS,
  WIKI_REPO_OP_READ_CAPABILITY,
  WIKI_REPO_OP_STATES,
  WIKI_STORED_TEXT_ENCODINGS,
} from './wikiRepoOps';
import { WIKI_MAINTENANCE_HEALTH, WIKI_MAINTENANCE_LOOKS, wikiMaintenanceLook } from './wikiHealth';
import {
  WIKI_DOC_BLOCK_KINDS,
  WIKI_DOC_BUILD_RULES,
  WIKI_DOC_CHECKERS,
  WIKI_DOC_DISPOSITION_ACTIONS,
  WIKI_DOC_FOOTNOTE_KINDS,
  WIKI_DOC_LEAD_RULES,
  WIKI_DOC_MATERIAL_RULES,
  WIKI_DOC_MATERIAL_WEIGHTS,
  WIKI_DOC_RECORD_KINDS,
  WIKI_DOC_REPO_KINDS,
  WIKI_DOC_RULES,
  WIKI_DOC_SCHEMA,
  WIKI_DOC_SENTENCE_STATUSES,
  WIKI_DOC_STATUSES,
  WIKI_DOC_VERDICTS,
  WIKI_DOC_WITHDRAW_REASONS,
  WIKI_DOCS_AFFECTED_RULES,
  WIKI_DOCS_BUILD_JOB,
} from './wikiDocs';
import {
  WIKI_SYSTEM_MODEL,
  WIKI_SYSTEM_MODEL_ENV,
  WIKI_SYSTEM_MODEL_ERROR_KINDS,
  WIKI_SYSTEM_MODEL_READ_STATES,
  WIKI_SYSTEM_MODEL_STATES,
  wikiWorkerRunning,
  type WikiSystemModelRead,
} from './wikiSystemModel';
import {
  WIKI_EXECUTOR_MODES,
  WIKI_EXECUTOR_READ,
  WIKI_IMPORT_JOB,
  WIKI_JOB,
  WIKI_JOB_FAILURE_KINDS,
  WIKI_JOB_KINDS,
  WIKI_JOB_STATES,
  WIKI_JOB_WAITING_FOR,
  WIKI_JOBS_READ,
  WIKI_MODEL_QUEUE,
  WIKI_MODEL_REQUEST_STATES,
  type WikiExecutorView,
  type WikiJobCallView,
  type WikiJobView,
  wikiJobRetryDelaySeconds,
  wikiModelCallBudgetSeconds,
  wikiModelRetryDelaySeconds,
  wikiModelWaitLimitSeconds,
} from './wikiJobs';
import {
  WIKI_PLAN_FACT_KINDS,
  WIKI_PLAN_GATE_CHECKS,
  WIKI_PLAN_JOB_HELD_REASONS,
  WIKI_PLAN_JOB_KINDS,
  WIKI_PLAN_JOB_OUTCOMES,
  WIKI_PLAN_JOB_RULES,
  WIKI_PLAN_JOB_STATES,
  WIKI_PLAN_JOB_STORED_STATES,
  WIKI_PLAN_JOB_TRIGGERS,
  WIKI_PLAN_NEW_FIELD_LEVELS,
  WIKI_PLAN_ORIGINS,
  WIKI_PLAN_PROPOSAL_ACTIONS,
  WIKI_PLAN_PROPOSAL_STATUSES,
  WIKI_PLAN_REBUILD,
  WIKI_PLAN_REPO_REF_KINDS,
  WIKI_PLAN_RULES,
  WIKI_PLAN_SCHEMA,
  WIKI_PLAN_SECTION_KINDS,
  WIKI_PLAN_SERVER_JOB,
  WIKI_PLAN_STATUSES,
} from './wikiPlan';

/**
 * Holds `src/shared/src/wiki.ts` to `contracts/wiki.contract.json`, the hand-written authority
 * `docs/wiki-contract.md` explains: every closed set, every limit, the effect policy and each kind's
 * field schema are read from the file and compared with what TypeScript ships, and the contract's
 * vectors are run through the validators here. A change the contract did not make first goes red.
 */

const ROOT = path.resolve(__dirname, '../../..');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const CONTRACT: any = JSON.parse(readFileSync(path.join(ROOT, 'contracts/wiki.contract.json'), 'utf8'));

/** The object-valued keys of a contract map, in the order the file writes them. */
const keysOf = (map: Record<string, unknown>): string[] => Object.keys(map);

/**
 * Every key an object of `text` (valid JSON) writes twice, as `$.path.key`. JSON.parse keeps only the last of
 * two, so the first is never read; this walks the text key by key, as Python's object_pairs_hook would.
 */
function duplicateKeys(text: string): string[] {
  const found: string[] = [];
  let i = 0;
  const space = (): void => {
    while (/\s/.test(text[i] ?? '')) i += 1;
  };
  const string = (): string => {
    const start = i;
    i += 1;
    while (text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
    i += 1;
    return JSON.parse(text.slice(start, i)) as string;
  };
  const value = (at: string): void => {
    space();
    if (text[i] === '{') {
      i += 1;
      const keys = new Set<string>();
      space();
      while (text[i] !== '}') {
        const key = string();
        if (keys.has(key)) found.push(`${at}.${key}`);
        keys.add(key);
        space();
        i += 1;
        value(`${at}.${key}`);
        space();
        if (text[i] === ',') i += 1;
        space();
      }
      i += 1;
    } else if (text[i] === '[') {
      i += 1;
      space();
      for (let n = 0; text[i] !== ']'; n += 1) {
        value(`${at}[${n}]`);
        space();
        if (text[i] === ',') i += 1;
        space();
      }
      i += 1;
    } else if (text[i] === '"') {
      string();
    } else {
      while (i < text.length && !/[,\]}\s]/.test(text[i])) i += 1;
    }
  };
  value('$');
  return found;
}

describe('wiki contract', () => {
  it('is version 1 of orbit.wiki, and every file it points at exists', () => {
    expect(CONTRACT.name).toBe('orbit.wiki');
    expect(CONTRACT.contractVersion).toBe(WIKI_CONTRACT_VERSION);
    expect(CONTRACT.phase).toBe(1);
    for (const file of [
      CONTRACT.doc,
      CONTRACT.design,
      CONTRACT.storage.migration,
      CONTRACT.storage.reviewModeMigration,
      CONTRACT.storage.verificationMigration,
      CONTRACT.storage.evidenceMigration,
    ]) {
      expect(existsSync(path.join(ROOT, file)), `${file} does not exist`).toBe(true);
    }
  });

  it('writes each key of an object once, so no sentence is lost to the one after it', () => {
    // 2026-10-09 to 10-19: docs.build.server held two "nul" keys, and nobody read the first sentence.
    expect(duplicateKeys(readFileSync(path.join(ROOT, 'contracts/wiki.contract.json'), 'utf8'))).toEqual([]);
    expect(duplicateKeys('{"a": {"b": 1, "b": [2, {"c": "\\"}", "c": 3}]}, "d": [{"c": 4}]}')).toEqual([
      '$.a.b',
      '$.a.b[1].c',
    ]);
  });

  it('stores the wiki in the nine tables the project names', () => {
    expect(CONTRACT.storage.tables).toEqual([
      'wiki_space',
      'wiki_space_workspace',
      'wiki_topic',
      'wiki_entry',
      'wiki_entry_revision',
      'wiki_source',
      'wiki_changeset',
      'wiki_changeset_op',
      'wiki_exposure',
    ]);
  });

  it('holds the repository operations to the contract, number for number', () => {
    const repoOps = CONTRACT.repoOps;
    expect(repoOps.table).toBe('wiki_repo_op');
    expect(repoOps.capability).toBe(WIKI_REPO_OP_CAPABILITY);
    expect(repoOps.readCapability).toBe(WIKI_REPO_OP_READ_CAPABILITY);
    expect(repoOps.kinds).toEqual([...WIKI_REPO_OP_KINDS]);
    expect(repoOps.states).toEqual([...WIKI_REPO_OP_STATES]);
    expect(repoOps.looks).toEqual([...WIKI_REPO_LOOKS]);
    expect(repoOps.migration).toBe('src/apiserver/prisma/migrations/0402_wiki_repo_op/migration.sql');
    expect(existsSync(path.join(ROOT, repoOps.migration)), `${repoOps.migration} does not exist`).toBe(true);
    // The read cache's table is the whole-file read's own migration, named where the contract names it.
    expect(repoOps.fileMigration).toBe('src/apiserver/prisma/migrations/0406_wiki_repo_file/migration.sql');
    expect(existsSync(path.join(ROOT, repoOps.fileMigration)), `${repoOps.fileMigration} does not exist`).toBe(true);
    // The numbers the dispatch, the fragments and the reads are held to, each read from the file the
    // runner-side constants are read from too.
    expect(repoOps.dispatch.perHeartbeat).toBe(WIKI_REPO_OPS.perHeartbeat);
    expect(repoOps.dispatch.staleSeconds).toBe(WIKI_REPO_OPS.staleSeconds);
    expect(repoOps.fragments.inlineBytes).toBe(WIKI_REPO_OPS.inlineBytes);
    expect(repoOps.fragments.fragmentBytes).toBe(WIKI_REPO_OPS.fragmentBytes);
    expect(repoOps.fragments.maxSnapshotBytes).toBe(WIKI_REPO_OPS.maxSnapshotBytes);
    expect(repoOps.read).toEqual({
      docSectionChars: WIKI_REPO_OPS.docSectionChars,
      contractChars: WIKI_REPO_OPS.contractChars,
      sectionChars: WIKI_REPO_OPS.sectionChars,
      wholeFileBytes: WIKI_REPO_OPS.wholeFileBytes,
      boundedChars: WIKI_REPO_OPS.boundedChars,
      operationBytes: WIKI_REPO_OPS.operationBytes,
    });
    // The cache is the snapshot's two tables and the files read at a sha.
    expect(repoOps.cache.tables).toEqual(['wiki_repo_snapshot', 'wiki_repo_snapshot_fragment', 'wiki_repo_file']);
    // Every kind says what it answers with, and every kind the contract names is one of the four.
    expect(Object.keys(repoOps.kindRuns).sort()).toEqual([...WIKI_REPO_OP_KINDS].sort());
    // The two routes the runner writes back through are named where the doors are.
    expect(repoOps.routes.result).toMatch(/POST \/runner\/wiki\/repo-ops\/:id\/result/u);
    expect(repoOps.routes.fragments).toMatch(/POST \/runner\/wiki\/repo-ops\/:id\/fragments/u);
    // A text Postgres cannot hold as it is — a file with a U+0000 in it (2026-10-09) — is kept as its bytes, and
    // the migration that lets a row say so exists; a write that is refused ends its operation; and the sweep's
    // window is the constant the worker reads.
    expect(repoOps.storedText.encodings).toEqual([...WIKI_STORED_TEXT_ENCODINGS]);
    expect(existsSync(path.join(ROOT, repoOps.storedText.migration)), `${repoOps.storedText.migration} does not exist`).toBe(true);
    expect(readFileSync(path.join(ROOT, repoOps.storedText.migration), 'utf8')).toContain('"content_encoding" TEXT NOT NULL DEFAULT \'text\'');
    expect(repoOps.unsettled.rule).toMatch(/INVALID_RESULT, 400.*UNSTORABLE_RESULT, 422/u);
    expect(repoOps.abandoned.seconds).toBe(WIKI_REPO_OPS.abandonedSeconds);
  });

  it('ships every closed set exactly as the contract lists it', () => {
    const kinds = Object.entries<{ phase: number }>(CONTRACT.kinds);
    expect(kinds.filter(([, k]) => k.phase === 1).map(([name]) => name)).toEqual([...WIKI_KINDS]);
    expect(kinds.filter(([, k]) => k.phase > 1).map(([name]) => name)).toEqual([...WIKI_RESERVED_KINDS]);
    expect(keysOf(CONTRACT.kinds)).toEqual([...WIKI_ENTRY_KINDS]);

    expect(CONTRACT.states.entry.values).toEqual([...WIKI_ENTRY_STATUSES]);
    expect(CONTRACT.states.op.values).toEqual([...WIKI_OP_DECISIONS]);
    expect(CONTRACT.states.changeset.values).toEqual([...WIKI_CHANGESET_STATUSES]);
    expect(CONTRACT.sourceStates.values).toEqual([...WIKI_SOURCE_STATES]);
    expect(CONTRACT.trust.values).toEqual([...WIKI_TRUST_LEVELS]);
    expect(keysOf(CONTRACT.trust.meaning)).toEqual([...WIKI_TRUST_LEVELS]);
    expect(keysOf(CONTRACT.sourceKinds)).toEqual([...WIKI_SOURCE_KINDS]);
    expect(keysOf(CONTRACT.anchorTypes)).toEqual([...WIKI_ANCHOR_TYPES]);
    expect(keysOf(CONTRACT.anchorStates)).toEqual([...WIKI_ANCHOR_STATES]);
    expect(keysOf(CONTRACT.ops)).toEqual([...WIKI_OPS]);
    expect(keysOf(CONTRACT.rejectReasons)).toEqual([...WIKI_REJECT_REASONS]);
    expect(CONTRACT.rejectReasons).toEqual(WIKI_REJECT_REASON_LABELS);
    expect(keysOf(CONTRACT.changesetOrigins)).toEqual([...WIKI_CHANGESET_ORIGINS]);
    expect(keysOf(CONTRACT.authorKinds)).toEqual([...WIKI_AUTHOR_KINDS]);
    expect(keysOf(CONTRACT.exposureChannels)).toEqual([...WIKI_EXPOSURE_CHANNELS]);
    expect(keysOf(CONTRACT.searchMatches)).toEqual([...WIKI_SEARCH_MATCHES]);
    expect(CONTRACT.effectPolicy.decide.actions).toEqual([...WIKI_DECIDE_ACTIONS]);
    expect(CONTRACT.refusals.map((r: { code: string }) => r.code)).toEqual([...WIKI_REFUSAL_CODES]);
    expect(CONTRACT.space.slug.pattern).toBe(WIKI_SLUG_PATTERN);
  });

  it('says what the spaces list adds to a row, and holds its plan count to the vectors the clients count by', () => {
    const list = CONTRACT.space.list;
    expect(CONTRACT.agentSurface.doors.user.routes).toContain(list.route);
    for (const field of ['pendingOps', 'planWaiting', 'workspaceIds', 'docs']) expect(list.row).toContain(field);
    expect(list.planWaiting).toMatch(/web wikiPlanPending and OrbitKit WikiPlanLogic\.pending/u);
    expect(list.planWaiting).toMatch(/src\/shared\/src\/wiki-docs\.fixture\.json plan\.states/u);
    expect(existsSync(path.join(ROOT, 'src/shared/src/wiki-docs.fixture.json'))).toBe(true);
    // Public ids on the user door: the codec rewrites the field only because it is on its list.
    expect(list.workspaceIds).toMatch(/public ids/u);
    expect(PUBLIC_ID_FIELDS.has('workspaceIds')).toBe(true);
  });

  it('ships the limits the contract sets, and the design set the ones it names', () => {
    expect(CONTRACT.limits).toEqual(WIKI_LIMITS);
    // Design §2.2 and §4.1, and the task that froze this contract: these numbers are decided, not tuned.
    expect(WIKI_LIMITS).toMatchObject({
      titleMaxChars: 120,
      summaryMaxChars: 280,
      topicsMax: 3,
      aliasesMax: 8,
      quoteMaxChars: 300,
      opsPerTurn: 5,
      opsPerSession: 15,
      opsPerChangeset: 30,
      pendingOpsPerSpace: 30,
      pendingExpiryDays: 14,
    });
    const notes = CONTRACT.limitNotes;
    expect([...notes.fromTheDesign, ...notes.addedByThisContract].sort()).toEqual(keysOf(CONTRACT.limits).sort());
  });

  it('gives each phase-1 kind the schema, authorship and push rule KIND_SPECS ships', () => {
    expect(keysOf(KIND_SPECS)).toEqual([...WIKI_KINDS]);
    for (const kind of WIKI_KINDS) {
      const declared = CONTRACT.kinds[kind];
      const spec = KIND_SPECS[kind];
      expect(spec.kind).toBe(kind);
      expect(spec.fields, `${kind}'s fields`).toEqual(declared.fields);
      expect(spec.ownerOnlyOps, `${kind}'s owner-only ops`).toEqual(declared.ownerOnlyOps);
      expect(spec.amendable, `${kind} amendable`).toBe(declared.amendable);
      expect(spec.push, `${kind}'s push rule`).toBe(declared.push);
      for (const op of spec.ownerOnlyOps) expect(WIKI_OPS).toContain(op);
      // Every field is written in the contract's field language, and nothing else.
      const walk = (fields: Record<string, { type: string; fields?: Record<string, never> }>) => {
        for (const [name, field] of Object.entries(fields)) {
          expect(keysOf(CONTRACT.fieldTypes), `${kind}.${name}`).toContain(field.type);
          if (field.fields) walk(field.fields);
        }
      };
      walk(declared.fields);
    }
    // A reserved kind is a placeholder: no schema yet, so nothing can be written under it.
    for (const kind of WIKI_RESERVED_KINDS) {
      expect(CONTRACT.kinds[kind].placeholder).toBe(true);
      expect(CONTRACT.kinds[kind].fields).toBeUndefined();
      expect(kind in KIND_SPECS).toBe(false);
    }
    // Design §2.2: only the owner writes a principle, and a decision is superseded, never rewritten.
    expect(KIND_SPECS.principle.ownerOnlyOps).toEqual(['add', 'amend', 'supersede']);
    expect(KIND_SPECS.decision.amendable).toBe(false);
    expect(KIND_SPECS.concept.push).toBe('never');
  });

  it('gives each anchor type the keys and states WIKI_ANCHOR_SPECS ships', () => {
    for (const type of WIKI_ANCHOR_TYPES) {
      expect(WIKI_ANCHOR_SPECS[type].fields, type).toEqual(CONTRACT.anchorTypes[type].fields);
      expect(WIKI_ANCHOR_SPECS[type].states, type).toEqual(CONTRACT.anchorTypes[type].states);
      for (const state of WIKI_ANCHOR_SPECS[type].states) expect(WIKI_ANCHOR_STATES).toContain(state);
      // A check never reports "unchecked": that is only the state before the first one.
      expect(WIKI_ANCHOR_SPECS[type].states).not.toContain('unchecked');
    }
  });

  it('ships the effect policy the contract states, and it keeps the design\'s promises', () => {
    const policy = CONTRACT.effectPolicy;
    expect(policy.origins).toEqual(WIKI_EFFECT_POLICY.origins);
    expect(policy.tainted).toEqual(WIKI_EFFECT_POLICY.tainted);
    const effects = keysOf(policy.effects);
    const rows: Array<[string, Record<string, string>]> = [...Object.entries<Record<string, string>>(policy.origins), ['tainted', policy.tainted]];
    for (const [row, table] of rows) {
      expect(keysOf(table), `${row} does not say what every op does`).toEqual([...WIKI_OPS]);
      for (const effect of Object.values(table)) expect(effects, row).toContain(effect);
      // A challenge only raises the flag that takes an entry out of the push, from every origin, tainted or not.
      expect(table.challenge, `${row}'s challenge`).toBe('applied');
    }
    for (const op of WIKI_OPS) expect(policy.origins.owner[op], `the owner's ${op}`).toBe('applied');
    for (const origin of WIKI_CHANGESET_ORIGINS.filter((o) => o !== 'owner')) {
      // Nothing an agent writes becomes knowledge without the owner: only the two safe ops skip Review.
      for (const op of ['add', 'amend', 'supersede', 'retire'] as const) {
        expect(policy.origins[origin][op], `${origin}'s ${op}`).toBe('pending');
      }
    }
    for (const op of WIKI_OPS.filter((o) => o !== 'challenge')) expect(policy.tainted[op], `a tainted ${op}`).toBe('pending');

    expect(wikiOpEffect({ origin: 'agent', op: 'reinforce', tainted: false, autoAcceptReinforce: true })).toBe('applied');
    expect(wikiOpEffect({ origin: 'agent', op: 'reinforce', tainted: false, autoAcceptReinforce: false })).toBe('pending');
    expect(wikiOpEffect({ origin: 'agent', op: 'reinforce', tainted: true, autoAcceptReinforce: true })).toBe('pending');
    expect(wikiOpEffect({ origin: 'agent', op: 'challenge', tainted: true, autoAcceptReinforce: false })).toBe('applied');
    // The tainted row is for proposals: the owner's own write is never held back by it.
    expect(wikiOpEffect({ origin: 'owner', op: 'add', tainted: true, autoAcceptReinforce: false })).toBe('applied');
    expect(CONTRACT.space.settings.autoAcceptReinforce.default).toBe(WIKI_DEFAULT_SPACE_SETTINGS.autoAcceptReinforce);
    expect(CONTRACT.space.settings.push.default).toBe(WIKI_DEFAULT_SPACE_SETTINGS.push);
  });

  it('ships the review modes the contract states, and none of them loosens a floor', () => {
    const modes = CONTRACT.reviewModes;
    expect(modes.values).toEqual([...WIKI_REVIEW_MODES]);
    expect(keysOf(modes.meaning)).toEqual([...WIKI_REVIEW_MODES]);
    expect(modes.rules).toEqual(WIKI_REVIEW_RULES);
    // Criterion 7's numbers: decided, not tuned.
    expect(WIKI_REVIEW_RULES).toEqual({
      pitfallMinSessions: 2,
      spotCheckEvery: 10,
      spotCheckWindow: 10,
      spotCheckMaxRejectPercent: 30,
      breakerMaxChangedPercent: 10,
      breakerMinActiveEntries: 100,
      // Revision 3: Automatic verifies first, draws a spot check only when the owner asks, one in 200,
      // and goes back to Tiered once more than 30% of its latest 50 verdicts are unsupported.
      automaticSpotCheckEvery: 200,
      verificationWindow: 50,
      verificationMaxUnsupportedPercent: 30,
      verificationReasonMaxChars: 500,
      verificationModelMaxChars: 200,
      verificationListMax: 50,
      verificationSourceMaxChars: 8_000,
    });
    // A new space is Tiered; a stored one that names no mode predates the setting and stays Manual.
    const setting = CONTRACT.space.settings.reviewMode;
    expect(setting.default).toBe(WIKI_DEFAULT_SPACE_SETTINGS.reviewMode);
    expect(setting.default).toBe('tiered');
    expect(setting.unset).toBe(WIKI_UNSET_REVIEW_MODE);
    expect(setting.unset).toBe('manual');
    expect(wikiSpaceSettings({}).reviewMode).toBe('manual');
    expect(wikiSpaceSettings({ reviewMode: 'sometimes' }).reviewMode).toBe('manual');
    expect(wikiSpaceSettings({ ...WIKI_DEFAULT_SPACE_SETTINGS }).reviewMode).toBe('tiered');
    expect(wikiSpaceSettings({ reviewMode: 'automatic', push: false })).toMatchObject({ reviewMode: 'automatic', push: false, autoAcceptReinforce: true });
    // Automatic sends the owner no spot-check card unless they ask for them.
    expect(CONTRACT.space.settings.automaticSpotChecks.default).toBe(WIKI_DEFAULT_SPACE_SETTINGS.automaticSpotChecks);
    expect(WIKI_DEFAULT_SPACE_SETTINGS.automaticSpotChecks).toBe(false);
    expect(wikiSpaceSettings({ reviewMode: 'automatic' }).automaticSpotChecks).toBe(false);
    expect(wikiSpaceSettings({ reviewMode: 'automatic', automaticSpotChecks: true }).automaticSpotChecks).toBe(true);
    expect(CONTRACT.space.settings.reviewModeChangedBy.type).toBe('owner | spot_checks | verification');

    const effect = (over: Partial<Parameters<typeof wikiReviewEffect>[0]>) =>
      wikiReviewEffect({
        mode: 'automatic', origin: 'agent', op: 'add', tainted: false, autoAcceptReinforce: true, target: null, basis: null, ...over,
      });
    const machine = { ownerVouched: false, machineWritten: true };
    for (const origin of WIKI_CHANGESET_ORIGINS.filter((o) => o !== 'owner')) {
      // Manual is the effect policy, word for word.
      for (const op of WIKI_OPS) {
        const expected = wikiOpEffect({ origin, op, tainted: false, autoAcceptReinforce: true });
        expect(effect({ mode: 'manual', origin, op, target: machine }), `manual ${origin} ${op}`).toEqual({ effect: expected, byMode: null });
      }
      // What the modes take: an add, and an amend of an entry the machine wrote. Tiered applies it at
      // once; Automatic sends it to its verification, and nothing of it applies without a verdict.
      expect(effect({ origin, mode: 'automatic' })).toEqual({ effect: 'verifying', byMode: { mode: 'automatic', trust: null } });
      expect(effect({ origin, mode: 'automatic', basis: 'owner_words' })).toEqual({ effect: 'verifying', byMode: { mode: 'automatic', trust: null } });
      expect(effect({ origin, mode: 'tiered' })).toEqual({ effect: 'applied', byMode: { mode: 'tiered', trust: 'unreviewed' } });
      expect(effect({ origin, mode: 'tiered', basis: 'owner_words' })).toEqual({ effect: 'applied', byMode: { mode: 'tiered', trust: 'auto' } });
      expect(effect({ origin, op: 'amend', target: machine })).toEqual({ effect: 'verifying', byMode: { mode: 'automatic', trust: null } });
      for (const mode of ['tiered', 'automatic'] as const) {
        // The floors, in every mode: a tainted op never applies on a mode's word — Tiered holds it for the
        // owner, Automatic sends it to a verification that leaves it no more than unreviewed (revision 4) —
        // and a change to what the owner wrote or confirmed waits for the owner.
        const tainted = mode === 'automatic' ? { effect: 'verifying', byMode: { mode, trust: null } } : { effect: 'pending', byMode: null };
        expect(effect({ origin, mode, tainted: true }), `${mode}: tainted`).toEqual(tainted);
        expect(effect({ origin, mode, tainted: true, op: 'amend', target: machine }), `${mode}: a tainted amend`).toEqual(tainted);
        expect(effect({ origin, mode, tainted: true, op: 'amend', target: { ownerVouched: true, machineWritten: true } }).effect).toBe('pending');
        expect(effect({ origin, mode, tainted: true, op: 'reinforce', target: machine }).effect, `${mode}: a tainted reinforce`).toBe('pending');
        for (const op of ['supersede', 'retire'] as const) expect(effect({ origin, mode, tainted: true, op, target: machine }).effect).toBe('pending');
        expect(effect({ origin, mode, op: 'amend', target: { ownerVouched: true, machineWritten: false } }).effect).toBe('pending');
        expect(effect({ origin, mode, op: 'amend', target: { ownerVouched: true, machineWritten: true } }).effect).toBe('pending');
        // A lineage-ender can be undone by nothing, so it always waits.
        for (const op of ['supersede', 'retire'] as const) {
          expect(effect({ origin, mode, op, target: machine }).effect, `${mode}: ${op}`).toBe('pending');
        }
        // And what the effect policy already applies, it applies as before: no mode is recorded against it.
        expect(effect({ origin, mode, op: 'reinforce', target: machine })).toEqual({ effect: 'applied', byMode: null });
        expect(effect({ origin, mode, op: 'challenge', target: machine })).toEqual({ effect: 'applied', byMode: null });
        expect(effect({ origin, mode, op: 'reinforce', autoAcceptReinforce: false }).effect).toBe('pending');
      }
    }
    // The owner's own write is the effect policy's in every mode, and the mode records nothing against it.
    for (const mode of WIKI_REVIEW_MODES) {
      for (const op of WIKI_OPS) expect(effect({ mode, origin: 'owner', op, tainted: true })).toEqual({ effect: 'applied', byMode: null });
    }

    // Tiered's classification: the owner's words for a decision or a convention, a verification for the other two.
    const basis = (over: Partial<Parameters<typeof wikiTieredBasis>[0]>) =>
      wikiTieredBasis({ kind: 'pitfall', ownerWords: false, anchorState: 'unchecked', sessions: 0, recipeVerified: false, ...over });
    for (const kind of WIKI_KINDS) {
      const words = ['decision', 'convention'].includes(kind) ? 'owner_words' : null;
      expect(basis({ kind, ownerWords: true }), `${kind} in the owner's words`).toBe(words);
    }
    expect(basis({ kind: 'recipe', recipeVerified: true })).toBe('machine_verified');
    expect(basis({ kind: 'recipe', recipeVerified: false, anchorState: 'verified', sessions: 5 })).toBeNull();
    expect(basis({ kind: 'pitfall', anchorState: 'verified', sessions: 2 })).toBe('machine_verified');
    expect(basis({ kind: 'pitfall', anchorState: 'verified', sessions: 1 })).toBeNull();
    expect(basis({ kind: 'pitfall', anchorState: 'unchecked', sessions: 3 })).toBeNull();
    expect(basis({ kind: 'concept', ownerWords: true, anchorState: 'verified', sessions: 3, recipeVerified: true })).toBeNull();
    // The floors the contract names are the five criterion 7 names.
    expect(keysOf(modes.floors).filter((key) => key !== 'why')).toEqual([
      'principleOwnerOnly', 'taintedWaits', 'ownerVouchedWaits', 'circuitBreaker', 'opsPerChangeset',
    ]);
    expect(KIND_SPECS.principle.ownerOnlyOps).toEqual(['add', 'amend', 'supersede']);
    // The owner's actions are routes of the owner's door, and of no other.
    expect(CONTRACT.agentSurface.doors.user.routes).toContain(modes.revert.route);
    expect(CONTRACT.agentSurface.doors.user.routes).toContain(modes.entryReject.route);
    expect(CONTRACT.agentSurface.doors.user.routes).toContain(modes.entryConfirm.route);
    expect(CONTRACT.agentSurface.doors.user.routes).toContain(modes.verification.reopen.route);
    expect(modes.entryConfirm.door).toMatch(/WIKI_OWNER_CHANNEL_ONLY/u);
    expect(modes.verification.reopen.door).toMatch(/WIKI_OWNER_CHANNEL_ONLY/u);
    expect(modes.verification.reopen.door).toMatch(/Never the runner door/u);
    // What rests on the web reaches an agent only once a person has vouched for it.
    expect(CONTRACT.push.eligible.taintedOnlyWithTrust).toEqual([...WIKI_VOUCHED_TRUST]);
    expect(WIKI_VOUCHED_TRUST).toEqual(['owner', 'confirmed']);
    expect(CONTRACT.trust.onApply.entryConfirmed).toBe('confirmed');
  });

  it('names every run: the changeset on the timeline, one run\'s read, and where an entry\'s revision came from (criterion 8)', () => {
    const run = CONTRACT.reviewModes.run;
    const user: string[] = CONTRACT.agentSurface.doors.user.routes;
    const runner: string[] = [
      ...CONTRACT.agentSurface.doors.runner.routes,
      ...CONTRACT.agentSurface.doors.runner.verificationRoutes,
    ];
    // The run's read is the owner's, on the owner's door, and nowhere an agent can reach.
    expect(run.read.route).toBe('GET /api/wiki/changesets/:id');
    expect(user).toContain(run.read.route);
    expect(runner.some((route) => /\/changesets\/:id$/u.test(route))).toBe(false);
    expect(run.read.door).toMatch(/WIKI_OWNER_CHANNEL_ONLY/u);
    expect(run.read.door).toMatch(/plain 404/u);
    // What it answers: a changeset, with what it did counted in the words the clients say it.
    const counts: WikiChangesetCounts = { applied: 0, auto: 0, unreviewed: 0, rejectedByCheck: 0, toReview: 0 };
    expect(keysOf(run.counts)).toEqual(Object.keys(counts));
    const view: Omit<WikiChangesetView, keyof WikiChangeset> = {
      appliedByMode: null, entries: [], counts, revertible: false, revert: null,
    };
    for (const key of keysOf(view)) expect(run.read.answers, `answers names ${key}`).toMatch(new RegExp(`\\b${key}\\b`, 'u'));
    // Revert run… is offered exactly when the revert would do something, by the revert's own rules.
    expect(run.revertible).toMatch(/revert\.does, revert\.skipped/u);
    expect(run.revertible).toMatch(/revert:<changeset id>/u);
    expect(run.revertible).toMatch(/exactly when revertible is true/u);
    expect(CONTRACT.reviewModes.revert.how).toMatch(/revert:<changeset id>/u);
    // The timeline names each op's changeset; an entry's read says where its current revision came from.
    expect(run.timeline).toMatch(/changesetId/u);
    expect(run.timeline).toMatch(/changesetAppliedByMode/u);
    expect(user).toContain('GET /api/wiki/spaces/:id/timeline');
    const appliedBy: WikiEntryAppliedBy = { changesetId: null, appliedByMode: null, verification: null };
    for (const key of Object.keys(appliedBy)) expect(run.entry).toMatch(new RegExp(`\\b${key}\\b`, 'u'));
    expect(run.entry).toMatch(/runner door's read adds none of them/u);
    // An article's read names the entries it was written from, and lists the first entriesListed of them.
    expect(CONTRACT.articles.reads.entriesListed).toBe(WIKI_ARTICLE_ENTRIES_LISTED);
    const pool: Pick<WikiArticleView, 'entryIds' | 'entries'> = { entryIds: [], entries: [] };
    for (const key of keysOf(pool)) expect(CONTRACT.articles.reads.article).toMatch(new RegExp(`\\(${key}\\b`, 'u'));
  });

  it('holds a verdict to what its verifier could read, and a tainted op to unreviewed (revision 4)', () => {
    const evidence = CONTRACT.reviewModes.verification.evidence;
    expect(evidence.values).toEqual([...WIKI_VERIFICATION_EVIDENCE]);
    expect(evidence.column).toBe('verification_evidence');
    expect(evidence.function).toMatch(/wikiVerdictEffect/u);
    // Empty is not text, and what the verifier reads is what the quote check reads.
    expect(evidence.text).toMatch(/Empty or blank text is none/u);
    expect(evidence.text).toMatch(/the same text a submission's quote is checked against/u);
    const verdictEffect = (verdict: (typeof WIKI_VERIFICATION_VERDICTS)[number], tainted: boolean, readable: boolean) =>
      wikiVerdictEffect({ verdict, tainted, evidence: readable ? 'readable' : 'unreadable' });
    // Readable and not tainted: revision 3, word for word.
    expect(verdictEffect('supported', false, true)).toEqual({ trust: 'auto', reinforce: false, counted: true });
    expect(verdictEffect('partial', false, true)).toEqual({ trust: 'unreviewed', reinforce: false, counted: true });
    expect(verdictEffect('unsupported', false, true)).toEqual({ trust: null, reinforce: false, counted: true });
    expect(verdictEffect('duplicate', false, true)).toEqual({ trust: null, reinforce: true, counted: true });
    // Nothing readable: whatever it says, no more than unreviewed, a duplicate still a reinforce, none counted.
    for (const tainted of [false, true]) {
      for (const verdict of ['supported', 'partial', 'unsupported'] as const) {
        expect(verdictEffect(verdict, tainted, false), `${verdict}, unreadable`).toEqual({ trust: 'unreviewed', reinforce: false, counted: false });
      }
    }
    expect(verdictEffect('duplicate', false, false)).toEqual({ trust: null, reinforce: true, counted: false });
    // Tainted: never past unreviewed, unsupported still rejected, and its duplicate adds nothing.
    expect(verdictEffect('supported', true, true)).toEqual({ trust: 'unreviewed', reinforce: false, counted: true });
    expect(verdictEffect('partial', true, true)).toEqual({ trust: 'unreviewed', reinforce: false, counted: true });
    expect(verdictEffect('unsupported', true, true)).toEqual({ trust: null, reinforce: false, counted: true });
    expect(verdictEffect('duplicate', true, true)).toEqual({ trust: null, reinforce: false, counted: true });
    expect(verdictEffect('duplicate', true, false)).toEqual({ trust: null, reinforce: false, counted: false });
    for (const verdict of WIKI_VERIFICATION_VERDICTS) {
      expect(WIKI_PUSHABLE_TRUST, `a tainted ${verdict}`).not.toContain(verdictEffect(verdict, true, true).trust);
    }
    // The fallback leaves out what could not be read; the reopening sends it back, and is nobody's but the owner's and the import's.
    expect(CONTRACT.reviewModes.verification.fallback).toMatch(/out of the window altogether/u);
    const reopen = CONTRACT.reviewModes.verification.reopen;
    expect(reopen.rejected).toMatch(/verification_history/u);
    expect(reopen.tainted).toMatch(/automatic/u);
  });

  it('verifies before Automatic applies: four verdicts, a trail, a fallback, and no clock', () => {
    const verification = CONTRACT.reviewModes.verification;
    expect(keysOf(verification.verdicts)).toEqual([...WIKI_VERIFICATION_VERDICTS]);
    // Supported is pushed, partial is shown and never pushed, the other two apply nothing.
    expect(wikiVerdictTrust('supported')).toBe('auto');
    expect(wikiVerdictTrust('partial')).toBe('unreviewed');
    expect(wikiVerdictTrust('unsupported')).toBeNull();
    expect(wikiVerdictTrust('duplicate')).toBeNull();
    expect(WIKI_PUSHABLE_TRUST).toContain(wikiVerdictTrust('supported'));
    expect(WIKI_PUSHABLE_TRUST).not.toContain(wikiVerdictTrust('partial'));
    // The op waits in a state of its own, which only a verdict, a revert or its entry's end leaves.
    expect(WIKI_OP_DECISIONS).toContain('verifying');
    expect(CONTRACT.states.op.initial).toContain('verifying');
    expect(CONTRACT.states.op.terminal).not.toContain('verifying');
    const out = (CONTRACT.states.op.transitions as Array<{ from: string; to: string }>)
      .filter((t) => t.from === 'verifying').map((t) => t.to).sort();
    expect(out).toEqual(['auto_applied', 'conflict', 'pending', 'rejected', 'withdrawn']);
    // Nothing a clock does moves it.
    expect(verification.noClock).toMatch(/no clock expires, withdraws or applies it/u);
    expect(verification.trail.columns).toEqual([
      'verification_verdict', 'verification_reason', 'verification_model', 'verified_at', 'verification_duplicate_of',
    ]);
    // Spot-check cards and verifying ops leave the 30-op queue to what the owner has to decide.
    expect(CONTRACT.limitNotes.quota).toMatch(/a spot-check card does not count/u);
    expect(CONTRACT.reviewModes.spotChecks.card).toMatch(/does NOT count toward pendingOpsPerSpace/u);
    // The session that proposed asks for its ops' verification over the runner door, and reports no verdict.
    const runner = CONTRACT.agentSurface.doors.runner;
    expect(runner.verificationRoutes).toEqual([verification.routes.list, verification.routes.request]);
    expect(CONTRACT.agentSurface.verify.cli).toBe('orbit wiki verify');
    expect(CONTRACT.agentSurface.verify.unreadable).toMatch(/is not a verdict/u);
  });

  it('hands what ended sessions left waiting to the next maintenance run, and to nobody else', () => {
    // The 71 ops three failed runs left waiting: no proposer is left to verify them, so the space's
    // maintenance run adopts them, through no door.
    const verification = CONTRACT.reviewModes.verification;
    const adoption = verification.adoption;
    expect(verification.who.maintenance).toMatch(/adoption/u);
    expect(adoption.who).toMatch(/The space's maintenance run — its maintain job \(maintenance\.job\.server, 2026-10-11\) — and nobody else: no door reaches it/u);
    expect(adoption.who).toMatch(/SUCCEEDED, FAILED or CANCELLED, or it was completed or deleted/u);
    // At most so many a run — one page of the list — and one left without a verdict waits for the next.
    expect(WIKI_MAINTENANCE_JOB.adoptOpsMax).toBe(50);
    expect(WIKI_MAINTENANCE_JOB.adoptOpsMax).toBeLessThanOrEqual(WIKI_REVIEW_RULES.verificationListMax);
    expect(adoption.run).toMatch(/rules\.adoptOpsMax/u);
    expect(adoption.run).toMatch(/does not fail the run/u);
    expect(CONTRACT.maintenance.job.run.steps.find((step: string) => step.startsWith('verify:'))).toMatch(/adoption/u);
    // What a later op made live is offered as a duplicate, and never goes live twice.
    expect(adoption.list).toMatch(/neighbours its draft has now/u);
    expect(adoption.twin).toMatch(/same kind, title and summary/u);
    expect(adoption.twin).toMatch(/No verdict makes a second live copy/u);
    // Every floor as it was.
    for (const floor of [/nothing applies without a verdict/u, /never more than unreviewed/u, /counts toward the fallback/u]) {
      expect(adoption.floors).toMatch(floor);
    }
    // The report counts them apart from the run's own ops.
    const adopted: NonNullable<NonNullable<WikiMaintenanceReport['verification']>['adopted']> = { ops: 0, verified: 0, failed: 0 };
    expect(CONTRACT.maintenance.job.report).toMatch(new RegExp(`adopted \\{${Object.keys(adopted).join(', ')}\\}`, 'u'));
    // The run adopts as its wiki job, and besides what ended sessions left, what the space's ended runs left
    // (2026-10-11): never its own job's, never a job's that has not ended, never another space's. The writer holds it.
    expect(adoption.who).toMatch(/It adopts, in the worker, through WikiService\.listVerifications and recordVerifications with adopt/u);
    expect(adoption.who).toMatch(/whose job succeeded, failed or was cancelled and is not the adopting one/u);
    expect(adoption.who).toMatch(/never those of a job still queued, running or waiting; never another space's/u);
    expect(adoption.who).toMatch(/records a verdict for such an op from the space's maintain job alone/u);
    for (const state of ['succeeded', 'failed', 'cancelled']) expect(WIKI_JOB_STATES).toContain(state);
    expect(adoption.run).toMatch(/once its job has ended \(maintenance\.job\.server\.verify\), the next run adopts it/u);
    expect(adoption.run).toMatch(/one list, the ended sessions' ops and the ended jobs' together, oldest first/u);
    expect(verification.who.maintenance).toMatch(/what ended sessions and the space's ended runs left waiting/u);
  });

  it('leaves an op the verification got no verdict for to the next run, and fails nothing', () => {
    // 2026-09-30 and 10-01: one op in eighty-nine, then four in seventy-nine, without a verdict failed every run,
    // and the cursor never moved. The run's own ops now wait as an adopted op does.
    const job = CONTRACT.maintenance.job;
    const verify: string = job.run.steps.find((step: string) => step.startsWith('verify:'));
    expect(verify).toMatch(/says why the model's last answer was not a verdict and lists the numbers duplicateOf may be/u);
    expect(verify).toMatch(/read as strictly as the first/u);
    expect(verify).toMatch(/one of the run's own after both passes, or an adopted one — is not live/u);
    expect(verify).toMatch(/fails nothing: the run goes on, succeeds and advances the cursor, and the next run adopts the op/u);
    expect(verify).toMatch(/An error from the server still ends the run failed/u);
    expect(job.run.failure).toMatch(/Nor does an op the verification left without a verdict/u);
    expect(CONTRACT.reviewModes.verification.adoption.run).toMatch(/An op of the run's own that its two passes left without a verdict waits the same way/u);
    // The report counts what waits for the next run apart.
    expect(job.report).toMatch(/verification \{verified, failed, waitingForNextRun — /u);
    // orbit wiki verify still exits non-zero when its wait ends with an op left without a verdict; a run, which verifies
    // in its own process, fails nothing for one.
    expect(CONTRACT.agentSurface.verify.does).toMatch(/The command exits non-zero when the wait runs out with ops still without a verdict/u);
    expect(CONTRACT.agentSurface.verify.unreadable).toMatch(/A maintenance run verifies its own ops in its own process, asks once more about those left without a verdict, and what is still without one fails nothing/u);
  });

  it('has the local model name a duplicate by a number of its own, never by an id it would copy wrong', () => {
    // 09-30 to 10-02: asked to copy a 21-character id, the local model wrote 34XhYj76NhjjOJTEFEtFE as 34XhYj76NhjjOJTEFE
    // run after run, and its op never got a verdict. It is shown numbers, answers with one, and the command maps it back.
    const verify = CONTRACT.agentSurface.verify;
    expect(verify.prompt).toMatch(/each by a number of its own, E1 to En in the order listed, and never by its id/u);
    expect(verify.prompt).toMatch(/"duplicateOf": the number of the neighbour it duplicates, for a duplicate\}, and the verdict reported names the id that number stands for/u);
    // Read as strictly as ever: a number is one the prompt listed, and an id is none, whole or cut short.
    expect(verify.unreadable).toMatch(/A number is one the prompt listed, exactly: an id, whole or cut short, is none, and nothing is guessed from a prefix/u);
    expect(verify.unreadable).toMatch(/as plan\.gate\.values reads a closed-set value/u);
    const step: string = CONTRACT.maintenance.job.run.steps.find((s: string) => s.startsWith('verify:'));
    expect(step).toMatch(/lists the numbers duplicateOf may be/u);
    expect(step).not.toMatch(/lists the ids/u);
    // A revision hands the model its documents' projects by title, as every drafting prompt names a project.
    expect(CONTRACT.plan.jobs.run.revise).toMatch(/name their session conditions' projects by title, as every drafting prompt names a project, and never by an id the model would have to copy/u);
  });

  it('names what the plan gate refuses as a JSON string, and reads a closed-set value as what its wrapping holds', () => {
    // 10-01 10:40Z: «`decision` is no kind of entry: one of principle, convention, decision, …» read as decision refused
    // for being decision, and the model wrote it the same way three rounds running.
    const values: string = CONTRACT.plan.gate.values;
    expect(values).toMatch(/writes it as a JSON string — in double quotes, every character that would not show .* written as \\uXXXX/u);
    expect(values).toMatch(/so a backtick, an invisible character and a space at either end all show/u);
    for (const field of ["a section's kind", "a session condition's entryKinds and topics", "a declared new field's at", "a fact's kind"]) {
      expect(values).toContain(field);
    }
    expect(values).toMatch(/a pair counting as a wrapping only with no more of either inside; nothing else is read loosely/u);
    expect(values).toMatch(/Decision, decisions and decision with a zero-width space after it are none/u);
    expect(values).toMatch(/The plan job's own gate \(plan\.jobs\.run\) and a maintenance run's check of its proposal read and write values the same way/u);
    // The fields it names are the plan's closed sets.
    expect(CONTRACT.plan.gate.checks).toEqual([...WIKI_PLAN_GATE_CHECKS]);
    expect(keysOf(CONTRACT.plan.sectionKinds)).toEqual([...WIKI_PLAN_SECTION_KINDS]);
  });

  it.each(['entry', 'op', 'changeset', 'source'])('has a consistent %s state machine', (name) => {
    const sm = name === 'source' ? CONTRACT.sourceStates : CONTRACT.states[name];
    const values: string[] = sm.values;
    for (const state of [...sm.initial, ...sm.terminal]) expect(values, `${name}: ${state}`).toContain(state);
    for (const t of sm.transitions) {
      expect(values, `${name}: unknown from-state ${t.from}`).toContain(t.from);
      expect(values, `${name}: unknown to-state ${t.to}`).toContain(t.to);
      expect(t.trigger, `${name}: ${t.from}->${t.to} has no trigger`).toBeTruthy();
    }
    // A terminal state is one nothing leaves.
    for (const terminal of sm.terminal) {
      expect(sm.transitions.filter((t: { from: string }) => t.from === terminal), `${name}: ${terminal} is left`).toEqual([]);
    }
    // Every state is reachable, or it is vocabulary nothing can produce.
    const reached = new Set<string>(sm.initial);
    for (let i = 0; i < values.length; i += 1) {
      for (const t of sm.transitions) if (reached.has(t.from)) reached.add(t.to);
    }
    expect([...values].sort(), `${name}: unreachable states`).toEqual([...reached].sort());
  });

  it('pins the entry lifecycle the design draws, and how an op is decided', () => {
    const entry = CONTRACT.states.entry;
    const edges = entry.transitions.map((t: { from: string; to: string }) => `${t.from}->${t.to}`);
    expect(edges).toEqual([
      'proposed->active', 'proposed->rejected', 'active->superseded', 'active->retired', 'active->rejected',
      // Revision 4: the one way back out of a rejection, a verdict reopened because nothing could be read.
      'rejected->proposed',
    ]);
    expect(keysOf(entry.born)).toEqual(entry.initial);
    // Ended is what a reader no longer gets: every terminal state, and a rejected lineage besides.
    expect(entry.ended).toEqual([...entry.terminal, 'rejected']);
    // Only pending and verifying wait — for the owner, and for a verdict — auto_applied is left only by
    // the owner's Reject or Confirm from the entry, and rejected only by a reopened verdict; every other
    // decision is final, and the three an op is recorded with are the initial ones.
    const op = CONTRACT.states.op;
    expect(op.values.filter((v: string) => !op.terminal.includes(v))).toEqual(['pending', 'rejected', 'auto_applied', 'verifying']);
    expect(op.transitions.filter((t: { from: string }) => t.from === 'auto_applied').map((t: { to: string }) => t.to)).toEqual(['rejected', 'accepted']);
    expect(op.transitions.filter((t: { from: string }) => t.from === 'rejected').map((t: { to: string }) => t.to)).toEqual(['verifying']);
    expect(op.transitions.filter((t: { to: string }) => t.to === 'verifying').map((t: { from: string }) => t.from)).toEqual(['pending', 'rejected']);
    expect(op.initial).toEqual(['pending', 'auto_applied', 'verifying']);
    // Pushable trust is what the push reads, and proposed never is.
    expect(CONTRACT.trust.pushable).toEqual([...WIKI_PUSHABLE_TRUST]);
    expect(CONTRACT.push.eligible.trust).toEqual([...WIKI_PUSHABLE_TRUST]);
    expect(WIKI_PUSHABLE_TRUST).not.toContain('proposed');
    // What a review mode applies is pushed as auto, and never as unreviewed.
    expect(WIKI_PUSHABLE_TRUST).toContain('auto');
    expect(WIKI_PUSHABLE_TRUST).not.toContain('unreviewed');
  });

  it('ships the maintenance run the contract states: off by default, its rules, its facts and its cursor', () => {
    // Criterion 2 and the settings beside it: a space's maintenance is off until its owner turns it on.
    const setting = CONTRACT.space.settings.maintenance;
    expect(setting.default).toEqual(WIKI_DEFAULT_MAINTENANCE_SETTINGS);
    expect(WIKI_DEFAULT_MAINTENANCE_SETTINGS.enabled).toBe(false);
    expect(keysOf(setting.keys)).toEqual(Object.keys(WIKI_DEFAULT_MAINTENANCE_SETTINGS));
    expect(setting.channel).toMatch(/WIKI_OWNER_CHANNEL_ONLY/u);
    expect(WIKI_DEFAULT_SPACE_SETTINGS.maintenance).toEqual(WIKI_DEFAULT_MAINTENANCE_SETTINGS);
    expect(CONTRACT.space.settings.reservedForPhase2).not.toContain('maintenance');
    expect(wikiSpaceSettings({}).maintenance).toEqual(WIKI_DEFAULT_MAINTENANCE_SETTINGS);
    expect(wikiSpaceSettings({ maintenance: { enabled: 'yes', dailyRunLimit: -1, provider: '' } }).maintenance)
      .toEqual(WIKI_DEFAULT_MAINTENANCE_SETTINGS);
    expect(wikiMaintenanceSettings({ enabled: true, workspaceId: 'w', listId: 'l', dailyRunLimit: 5 }))
      .toEqual({ enabled: true, workspaceId: 'w', provider: 'local-vllm', dailyRunLimit: 5, lookbackDays: 14, listId: 'l' });
    // A day's runs are counted, not its tokens: 8 by default, 1 to 48, and anything else reads as the default —
    // a value out of bounds, one that is not a whole number, and the token budget this setting replaced.
    expect(WIKI_DEFAULT_MAINTENANCE_SETTINGS.dailyRunLimit).toBe(8);
    expect(setting.bounds.dailyRunLimit).toEqual(WIKI_MAINTENANCE_DAILY_RUN_LIMIT);
    expect(WIKI_MAINTENANCE_DAILY_RUN_LIMIT).toEqual({ min: 1, max: 48 });
    for (const [stored, reads] of [[1, 1], [48, 48], [0, 8], [49, 8], [2.5, 8], ['12', 8]] as const) {
      expect(wikiMaintenanceSettings({ dailyRunLimit: stored }).dailyRunLimit).toBe(reads);
    }
    expect(wikiMaintenanceSettings({ dailyTokenBudget: 2_000_000 })).toEqual(WIKI_DEFAULT_MAINTENANCE_SETTINGS);
    expect(setting.channel).toMatch(/dailyRunLimit/u);
    // How far back a cursor starts when maintenance is turned on: 14 days by default, 0 to 365, and null —
    // all of history — kept as the choice it is, where an absent or malformed value reads as the default.
    expect(WIKI_DEFAULT_MAINTENANCE_SETTINGS.lookbackDays).toBe(14);
    expect(setting.bounds.lookbackDays).toEqual(WIKI_MAINTENANCE_LOOKBACK_DAYS);
    expect(WIKI_MAINTENANCE_LOOKBACK_DAYS).toEqual({ min: 0, max: 365 });
    for (const [stored, reads] of [[0, 0], [1, 1], [365, 365], [null, null], [-1, 14], [366, 14], [2.5, 14], ['7', 14], [undefined, 14]] as const) {
      expect(wikiMaintenanceSettings({ lookbackDays: stored }).lookbackDays, String(stored)).toBe(reads);
    }
    expect(setting.channel).toMatch(/lookbackDays null is a value \(all history\)/u);
    // The start is written once, where the cursor has no position, and moves no cursor that has one.
    const start: string = CONTRACT.maintenance.cursor.start;
    expect(start).toMatch(/turns maintenance on \(enabled false to true\) and the space's cursor has no position yet/u);
    expect(start).toMatch(/lookbackDays null writes nothing/u);
    expect(start).toMatch(/A cursor that has a position is never moved by it/u);

    const maintenance = CONTRACT.maintenance;
    expect(maintenance.rules).toEqual(WIKI_MAINTENANCE_RULES);
    // The demo's numbers: 8k a session recalled more than 16k; twenty sessions or a day makes a run due.
    expect(WIKI_MAINTENANCE_RULES.dossierMaxTokens).toBe(8_000);
    expect(WIKI_MAINTENANCE_RULES.errorClusterMinSessions).toBe(3);
    expect(WIKI_MAINTENANCE_RULES.backlogThreshold).toBe(20);
    expect(WIKI_MAINTENANCE_RULES.maxPendingAgeHours).toBe(24);
    expect(keysOf(maintenance.cursor.factKinds)).toEqual([...WIKI_CURSOR_FACT_KINDS]);
    expect(maintenance.cursor.advance.outcomes).toEqual([...WIKI_CURSOR_OUTCOMES]);
    // The refusals the cursor answers are declared, with their statuses.
    const status = (code: string) => CONTRACT.refusals.find((r: { code: string }) => r.code === code)?.httpStatus;
    expect(status('WIKI_CURSOR_BEHIND')).toBe(409);
    expect(status('WIKI_CURSOR_INVALID')).toBe(400);
    // The token estimate the budget was measured with: ASCII at 3.4 a token, the rest at 1.25, plus one.
    expect(maintenance.dossier.budget).toMatch(/wikiEstimateTokens/u);
    expect(wikiEstimateTokens('')).toBe(0);
    expect(wikiEstimateTokens('abcdefghij')).toBe(Math.floor(10 / 3.4) + 1);
    expect(wikiEstimateTokens('案卷与游标')).toBe(Math.floor(5 / 1.25) + 1);
    // The dossier's text is never stored: the one table that keeps anything of it keeps its sources and hash.
    expect(maintenance.tables).toEqual(['wiki_cursor', 'wiki_dossier']);
    expect(maintenance.dossier.storage).toMatch(/text is never stored/u);
  });

  it("says where each dossier line's words are in its record, and a run quotes the record there (criterion 2, revision 2)", () => {
    const dossier = CONTRACT.maintenance.dossier;
    // A line's source here has the contract's fields, every one of them required: its record and its spans.
    const span: Required<WikiDossierSpan> = { start: 0, end: 4, text: 'done' };
    const source: Required<WikiDossierSource> = { ref: 'L1', kind: 'turn', id: 'turn-1', spans: [span] };
    expect(keysOf(source)).toEqual(dossier.sourceFields);
    expect(keysOf(span)).toEqual(dossier.spans.fields);
    // Counted in code points of the one text a record has, redacted — and stored as where, never as the words.
    expect(dossier.spans.unit).toMatch(/code points of the record's text/u);
    expect(dossier.spans.unit).toMatch(/reviewModes\.verification\.evidence\.text/u);
    expect(dossier.spans.unit).toMatch(/redacted/u);
    expect(dossier.spans.stored).toMatch(/start and end alone/u);
    expect(dossier.storage).toMatch(/never the words in them/u);
    // The hash is the text and the records, as it was: spans do not make a dossier a run has read new.
    expect(dossier.determinism).toMatch(/the sources' ref, kind and id as JSON/u);
    // The text a span counts in is the text a quote is checked against and a verifier reads, part for part.
    const text = CONTRACT.reviewModes.verification.evidence.text;
    expect(text).toMatch(/a dossier line's spans count in/u);
    for (const part of [
      'background_task, its command and its summary', 'turn_end, its subtype', "A tool call's row is the call and its result together",
      'for an ExitPlanMode the plan it decided',
    ]) expect(text).toContain(part);
    // A run cites the record's own words at a span, and where they are; the dossier's shorthand, with neither.
    expect(CONTRACT.maintenance.job.citation.locator).toEqual(['start', 'end']);
    expect(CONTRACT.maintenance.job.citation.rule).toMatch(/no quote and no locator/u);
    expect(CONTRACT.maintenance.job.run.steps.find((step: string) => step.startsWith('extract:'))).toMatch(/locator \{start, end\}/u);
  });

  it('ships the maintenance job the contract states: its trigger and its run', () => {
    // Criterion 3: a committed fact makes the run, and the run proposes as maintenance.
    const job = CONTRACT.maintenance.job;
    expect(job.rules).toEqual(WIKI_MAINTENANCE_JOB);
    // The demo's A2+6: at most six entries from one 8k dossier, and never more than twenty sessions a run.
    expect(WIKI_MAINTENANCE_JOB.entriesPerSessionMax).toBe(6);
    expect(WIKI_MAINTENANCE_JOB.runSessionsMax).toBe(WIKI_MAINTENANCE_RULES.backlogThreshold);
    expect(job.trigger.due).toEqual([...WIKI_MAINTENANCE_DUE]);
    expect(job.held.reasons).toEqual([...WIKI_MAINTENANCE_HELD_REASONS]);
    for (const reason of WIKI_MAINTENANCE_HELD_REASONS) expect(job.held[reason]).toBeTruthy();
    // The due threshold counts sessions (design §8.2's «20 个会话»), and no clock starts a run.
    expect(CONTRACT.maintenance.cursor.due).toMatch(/sessions have a fact after the watermark/u);
    expect(job.trigger.conditions).toMatch(/No clock starts a run/u);
    // One run of a space at a time: none is made while its maintain job has not ended, read again under the space's lock.
    const notMade: string[] = job.trigger.notMade;
    expect(notMade.some((why) => why.startsWith('a maintain job of the space has not ended (queued, running or waiting): one run of a space at a time'))).toBe(true);
    expect(job.trigger.lock).toMatch(/a lock on the space's row, after the space's unfinished maintain jobs and the day's count are read again under it/u);
    // Whose a failed run's failure was, and how many times the run started.
    expect(job.recovery.failureKinds).toEqual([...WIKI_MAINTENANCE_FAILURE_KINDS]);
    expect(job.recovery.attempts).toMatch(/startedAt, never written again/u);
    expect(job.recovery.migration).toMatch(/0356_wiki_maintenance_run_attempts/u);
    expect(CONTRACT.maintenance.cursor.advance.body.failureKind).toMatch(/when it is not said, read off its error/u);
    expect(CONTRACT.maintenance.dossier.query.until).toMatch(/does not go past/u);
    expect(job.tables).toEqual(['wiki_maintenance_run']);
    // Criterion 3, revision 3: the run writes only the plan's sections its facts touched, and no topic article.
    const steps: string[] = job.run.steps;
    expect(steps.some((step) => step.startsWith('articles:'))).toBe(false);
    const docsStep = steps.find((step) => step.startsWith('docs:'));
    expect(docsStep).toMatch(/only the sections the run's facts touched/u);
    expect(docsStep).toMatch(/no_confirmed_plan/u);
    expect(steps.indexOf(docsStep!)).toBe(steps.findIndex((step) => step.startsWith('anchors:')) + 1);
    expect(job.docs.rules).toEqual(WIKI_MAINTENANCE_DOCS_RULES);
    expect(job.docs.skipped).toEqual([...WIKI_MAINTENANCE_DOCS_SKIPPED]);
    expect(job.docs.byRepo).toMatch(/never the whole repository/u);
    expect(job.docs.unplaced).toMatch(/docs\/mocks and docs\/evidence/u);
    expect(job.docs.proposal).toMatch(/One plan proposal a run at most/u);
    expect(job.docs.report).toMatch(/WikiMaintenanceDocsReport/u);
    expect(job.report).toMatch(/docs \(maintenance\.job\.docs\.report\)/u);
    // A run's size fits its guardrails at six entries a session.
    const size = (mode: 'manual' | 'tiered' | 'automatic', activeEntries: number, pendingInSpace = 0) =>
      wikiMaintenanceRunSessions({ mode, activeEntries, pendingInSpace });
    expect(size('tiered', 0)).toBe(WIKI_MAINTENANCE_JOB.runSessionsMax);
    expect(size('automatic', WIKI_REVIEW_RULES.breakerMinActiveEntries - 1)).toBe(WIKI_MAINTENANCE_JOB.runSessionsMax);
    expect(size('tiered', 100)).toBe(1);
    expect(size('automatic', 600)).toBe(10);
    expect(size('tiered', 100_000)).toBe(WIKI_MAINTENANCE_JOB.runSessionsMax);
    expect(size('manual', 0)).toBe(Math.floor(WIKI_LIMITS.opsPerSession / 6));
    expect(size('manual', 0, WIKI_LIMITS.pendingOpsPerSpace - 5)).toBe(0);
  });

  it('ships criterion 3 revision 4: the cursor moves once the ops are recorded, and a space behind catches up', () => {
    const job = CONTRACT.maintenance.job;
    // The step order of revision 4: … propose → cursor advance (past the sessions whose ops were recorded) → verify →
    // anchors → docs, and a failure after the advance still fails the run.
    const steps: string[] = job.run.steps;
    const at = (name: string) => steps.findIndex((step) => step.startsWith(`${name}:`));
    expect(at('advance')).toBe(at('propose') + 1);
    expect(at('verify')).toBe(at('advance') + 1);
    expect(steps[at('advance')]).toMatch(/the cursor's advance \(WikiMaintenance\.advanceRecorded\)/u);
    expect(steps[at('advance')]).toMatch(/the next run does not read those sessions again/u);
    expect(job.run.failure).toMatch(/Before the ops are recorded — any step up to propose — the cursor does not move/u);
    expect(job.run.failure).toMatch(/the run still ends failed, and the report says so \(cursorAdvanced\)/u);
    expect(job.report).toMatch(/cursorAdvanced/u);
    const report: WikiMaintenanceReport = { sessions: 0, dossiers: 0, unchanged: 0, offTopic: 0,
      entries: { extracted: 0, kept: 0, dropped: 0, foreign: 0, principles: 0 },
      ops: { proposed: 0, recorded: 0, refused: 0, selfCheckDropped: 0, heldBack: 0, heldBackByBreaker: 0, applied: 0, waiting: 0 },
      tokens: { input: 0, output: 0, calls: 0 }, seconds: 0, stoppedAt: 'anchors', cursorAdvanced: true };
    expect(report.cursorAdvanced).toBe(true);

    // Catch-up: its numbers, its states, its migration, and the rules the trigger, the day and the documents follow.
    const catchUp = job.catchUp;
    expect(catchUp.rules).toEqual(WIKI_MAINTENANCE_CATCH_UP);
    expect(catchUp.states).toEqual([...WIKI_MAINTENANCE_CATCH_UP_STATES]);
    expect(WIKI_MAINTENANCE_CATCH_UP.behindHours).toBe(24);
    expect(WIKI_MAINTENANCE_CATCH_UP.pauseAfterFailures).toBe(3);
    expect(catchUp.migration).toMatch(/0357_wiki_maintenance_catch_up/u);
    expect(existsSync(path.join(__dirname, '../../..', catchUp.migration))).toBe(true);
    expect(catchUp.behind).toMatch(/no clock starts anything/u);
    expect(catchUp.trigger).toMatch(/The end of a run makes the next one only as maintenance\.job\.server\.trigger says — when it queued the space's articles job, which a run made in catch-up never does — so while catch-up is active the next run is made by the space's next fact/u);
    expect(catchUp.dailyLimit).toMatch(/not counted against settings\.maintenance\.dailyRunLimit when it ran on a local endpoint \(localEndpoint\) or when it failed/u);
    expect(catchUp.dailyLimit).toMatch(/one on a public endpoint that did not fail counts/u);
    expect(catchUp.paused).toMatch(/last rules\.pauseAfterFailures runs that ended all failed/u);
    expect(catchUp.docs).toMatch(/docs\.skipped catching_up/u);
    expect(job.docs.skipped).toContain('catching_up');
    expect(steps[at('docs')]).toMatch(/docs\.skipped catching_up/u);
    const notMade: string[] = job.trigger.notMade;
    expect(notMade.some((why) => why.includes("the end of a run that queued the space's articles job asks with no fact (maintenance.job.server.trigger)"))).toBe(true);
    expect(notMade.some((why) => why.includes("held: the day's runs are used up (maintenance.job.catchUp.dailyLimit)"))).toBe(true);
    expect(job.held.daily_limit_reached).toMatch(/maintenance\.job\.catchUp\.dailyLimit/u);
    expect(CONTRACT.space.settings.maintenance.keys.dailyRunLimit).toMatch(/maintenance\.job\.catchUp\.dailyLimit/u);
    expect(CONTRACT.maintenance.health.maintenance.dailyLimitReached).toMatch(/maintenance\.job\.catchUp\.dailyLimit/u);

    // Behind: the oldest pending fact older than the hours — not at them — and nothing pending is never behind.
    const now = new Date('2026-10-02T06:36:00.000Z');
    const hoursAgo = (hours: number, ms = 0) => new Date(now.getTime() - hours * 3_600_000 - ms);
    expect(wikiMaintenanceBehind(null, now)).toBe(false);
    expect(wikiMaintenanceBehind(hoursAgo(WIKI_MAINTENANCE_CATCH_UP.behindHours), now)).toBe(false);
    expect(wikiMaintenanceBehind(hoursAgo(WIKI_MAINTENANCE_CATCH_UP.behindHours, 1), now)).toBe(true);
    expect(wikiMaintenanceBehind(hoursAgo(13 * 24), now)).toBe(true);

    // A local endpoint: this machine or a private network, judged by the host the System model's address names, when the
    // worker starts the run.
    expect(catchUp.localEndpoint).toContain(`The System model's address (${WIKI_SYSTEM_MODEL_ENV.baseUrl}) is local when its host is this machine or a private network`);
    expect(catchUp.localEndpoint).toMatch(/The worker judges it when it starts the run and keeps it on the run's row as local_endpoint/u);
  });

  it('reads a space\'s health the way the contract states it, and tells the owner once a streak', () => {
    // Criterion 5: the Wiki home's status line reads the space's entries and its maintenance run's health.
    const health = CONTRACT.maintenance.health;
    expect(health.criterion).toBe(5);
    expect(CONTRACT.agentSurface.doors.user.routes).toContain(health.route);
    expect(health.route).toBe('GET /api/wiki/spaces/:id/health');
    expect(health.looks).toEqual([...WIKI_MAINTENANCE_LOOKS]);
    expect(keysOf(health.maintenance)).toEqual([
      'enabled', 'look', 'lastOkAt', 'lastRunAt', 'consecutiveFailures', 'backlog', 'oldestPendingAt', 'lagSeconds',
      'dailyLimitReached', 'held', 'running', 'lastRun', 'lastFailure',
    ]);
    // Whose the last failure was, so a client can tell the platform failing from the run failing.
    expect(health.maintenance.lastFailure).toMatch(/\{kind, reason, at, sessionId\}/u);
    expect(health.maintenance.lastFailure).toMatch(/maintenance\.job\.recovery\.failureKinds/u);
    expect(health.notify.afterFailures).toBe(WIKI_MAINTENANCE_HEALTH.notifyAfterFailures);
    expect(health.notify.once).toMatch(/exactly afterFailures/u);
    expect(health.notify.reset).toMatch(/back to 0/u);
    // The looks win in the order the contract lists them.
    const now = new Date('2026-09-28T12:00:00.000Z');
    const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 3_600_000).toISOString();
    const base = { enabled: true, consecutiveFailures: 0, running: null, oldestPendingAt: null };
    const running = { sessionId: 's', startedAt: hoursAgo(0.1) };
    const late = hoursAgo(WIKI_MAINTENANCE_RULES.maxPendingAgeHours + 2);
    expect(wikiMaintenanceLook({ ...base, enabled: false, consecutiveFailures: 3, running, oldestPendingAt: late }, now)).toBe('off');
    expect(wikiMaintenanceLook({ ...base, consecutiveFailures: 1, running, oldestPendingAt: late }, now)).toBe('failing');
    expect(wikiMaintenanceLook({ ...base, running, oldestPendingAt: late }, now)).toBe('running');
    expect(wikiMaintenanceLook({ ...base, oldestPendingAt: late }, now)).toBe('behind');
    expect(wikiMaintenanceLook({ ...base, oldestPendingAt: hoursAgo(WIKI_MAINTENANCE_RULES.maxPendingAgeHours - 1) }, now)).toBe('ok');
    expect(wikiMaintenanceLook(base, now)).toBe('ok');
    expect(health.look).toMatch(/maintenance\.rules\.maxPendingAgeHours/u);
    expect(health.client).toMatch(/wiki-health\.fixture\.json/u);
  });

  it('re-verifies the anchors git can check, by the rules the contract states', () => {
    // Criterion 4: a maintenance run re-verifies paths, symbols and commits on origin/main.
    const verify = CONTRACT.anchorRules.verify;
    expect(verify.types).toEqual([...WIKI_GIT_ANCHOR_TYPES]);
    for (const type of WIKI_GIT_ANCHOR_TYPES) expect(keysOf(CONTRACT.anchorTypes)).toContain(type);
    expect(verify.rules).toEqual(WIKI_ANCHOR_RULES);
    expect(WIKI_ANCHOR_RULES.symbolRegionLines).toBe(20);
    expect(WIKI_ANCHOR_RULES.reportEntriesMax).toBeLessThanOrEqual(WIKI_ANCHOR_RULES.listEntriesMax);
    // The space's maintenance run lists and reports them, and nothing else: no door does.
    expect(verify.who).toMatch(/the server's maintain job \(maintenance\.job\.server\.anchors\) — and nothing else: no door lists a space's anchors or takes a report/u);
    // A commit that is not an ancestor of origin/main is missing, never verified.
    expect(verify.checks.commit).toMatch(/not an ancestor/u);
    expect(verify.checks.commit).toMatch(/missing/u);
    // What takes an entry out of the push is what a broken anchor leaves behind.
    expect(CONTRACT.push.eligible.anchorStateNot).toEqual(['changed', 'missing']);
    expect(verify.challenge).toMatch(/one system challenge/u);
    // The owner answers a challenge with the three the challenge op names, on the decide route alone.
    expect(keysOf(verify.answers).filter((key) => key !== 'only')).toEqual([...WIKI_CHALLENGE_ANSWERS]);
    for (const answer of WIKI_CHALLENGE_ANSWERS) expect(WIKI_DECIDE_ACTIONS).toContain(answer);
    expect(CONTRACT.ops.challenge.does).toMatch(/Re-confirm, Amend or Retire/u);
    expect(CONTRACT.effectPolicy.decide.challengeAnswers).toMatch(/anchorRules\.verify\.answers/u);
    // Tiered's pitfall reads what a check writes.
    expect(CONTRACT.reviewModes.tiered.auto.machineVerified.pitfall).toMatch(/anchor_state verified/u);
    expect(verify.tiered).toMatch(/pitfallMinSessions/u);
  });

  it('ships the articles the contract states: six categories, three kinds, the rules, the default topics, and their doors', () => {
    // Criterion 9: a topic has a display name and a category, and its articles are a view of its entries.
    const articles = CONTRACT.articles;
    expect(articles.categories).toEqual(WIKI_ARTICLE_CATEGORIES.map((c) => ({ ...c })));
    expect(WIKI_ARTICLE_CATEGORY_KEYS).toEqual(['platform', 'runner', 'clients', 'data', 'engineering', 'collaboration']);
    expect(keysOf(articles.kinds)).toEqual([...WIKI_ARTICLE_KINDS]);
    expect(articles.rules).toEqual(WIKI_ARTICLE_RULES);
    // The two problems the demo showed, as numbers: 400-900 characters an article (the demo averaged 1,052).
    expect(WIKI_ARTICLE_RULES.minChars).toBe(400);
    expect(WIKI_ARTICLE_RULES.maxChars).toBe(900);
    expect(wikiArticleChars('数据库与 Prisma')).toBe(11);
    expect(articles.tables).toEqual(['wiki_topic_summary']);
    expect(articles.migration).toMatch(/0317_wiki_topic_articles/u);
    expect(existsSync(path.join(ROOT, articles.migration))).toBe(true);
    // Paths decide first; the words only when neither the paths nor a named slug do.
    expect(articles.membership.order.map((step: string) => step.split(':')[0])).toEqual(['paths', 'declared', 'text']);

    // The default topics: the demo's 22, each filed under a category the contract lists, in the directory's order.
    expect(articles.defaultTopics).toEqual(WIKI_DEFAULT_TOPICS.map((t) => ({ ...t, pathPrefixes: [...t.pathPrefixes] })));
    expect(WIKI_DEFAULT_TOPICS).toHaveLength(22);
    const slugs = WIKI_DEFAULT_TOPICS.map((t) => t.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const topic of WIKI_DEFAULT_TOPICS) {
      expect(topic.slug).toMatch(new RegExp(WIKI_SLUG_PATTERN, 'u'));
      expect(WIKI_ARTICLE_CATEGORY_KEYS).toContain(topic.category);
      expect(topic.title.trim()).not.toBe('');
      // No catch-all: nothing claims the whole API server, the demo's rule that filed a database write under sessions.
      expect(topic.pathPrefixes).not.toContain('src/apiserver/');
      expect(topic.pathPrefixes).not.toContain('src/apiserver/src/');
    }
    const order = WIKI_ARTICLE_CATEGORY_KEYS.map((key) => WIKI_DEFAULT_TOPICS.filter((t) => t.category === key).map((t) => t.slug));
    expect(order.flat()).toEqual(slugs);

    // Its doors: the owner's four reads on the user door, and no route on the runner door.
    const routes = articles.routes;
    const user: string[] = CONTRACT.agentSurface.doors.user.routes;
    for (const read of [routes.directory, routes.article, routes.part, routes.index]) expect(user).toContain(read);
    expect(Object.values<string>(routes).some((route) => route.includes('/api/runner/'))).toBe(false);
    expect(user.some((route) => route.startsWith('POST') && route.includes('/articles'))).toBe(false);
    // A view: never a source, never pushed, never an agent's answer.
    expect(CONTRACT.sourceRules.firstHand).toMatch(/topic summary or any other view is never a source/u);
    expect(articles.view.push).toMatch(/Never in <orbit_wiki_context>/u);
    expect(articles.view.agents).toMatch(/wiki_search or wiki_get/u);
    expect(articles.who.write).toMatch(/No door builds either, and the user door has no write route: any other caller is an error of the server's own code \(WikiArticles\.assertWriter\)/u);
    const status = (code: string) => CONTRACT.refusals.find((r: { code: string }) => r.code === code)?.httpStatus;
    expect(status('WIKI_ARTICLE_STALE')).toBe(409);
    // Server execution (P4): the job's numbers and its kind.
    expect(articles.job).toEqual({ ...WIKI_ARTICLES_JOB });
    expect(CONTRACT.jobs.kinds).toContain('articles');
    expect(CONTRACT.jobs.kindRuns.articles).toMatch(/articles\.serverExecution/u);
    expect(articles.regeneration).toMatch(/owner's decision of 2026-10-08/u);
    expect(existsSync(path.join(ROOT, 'src/shared/src/wiki-article-writer.fixture.json'))).toBe(true);
    expect(CONTRACT.realtime.publishedWhen.some((when: string) => /articles were written/u.test(when))).toBe(true);
  });

  it('ships the plan the contract states: its closed sets, rules and schema, its tables, its gate and its doors', () => {
    // Criterion 11: a plan drafted by the model, held by a gate the server runs, confirmed by the owner.
    const plan = CONTRACT.plan;
    expect(plan.phase).toBe(2);
    expect(plan.tables).toEqual(['wiki_plan', 'wiki_plan_doc', 'wiki_plan_section', 'wiki_plan_proposal']);
    expect(plan.migration).toMatch(/0325_wiki_plan/u);
    expect(keysOf(plan.statuses)).toEqual([...WIKI_PLAN_STATUSES]);
    expect(keysOf(plan.origins)).toEqual([...WIKI_PLAN_ORIGINS]);
    expect(keysOf(plan.sectionKinds)).toEqual([...WIKI_PLAN_SECTION_KINDS]);
    expect(keysOf(plan.proposals.statuses)).toEqual([...WIKI_PLAN_PROPOSAL_STATUSES]);
    expect(plan.proposals.actions).toEqual([...WIKI_PLAN_PROPOSAL_ACTIONS]);
    expect(plan.proposals.factKinds).toEqual([...WIKI_PLAN_FACT_KINDS]);
    expect(plan.gate.checks).toEqual([...WIKI_PLAN_GATE_CHECKS]);
    expect(plan.newFields.levels).toEqual([...WIKI_PLAN_NEW_FIELD_LEVELS]);
    expect(plan.rules).toEqual(WIKI_PLAN_RULES);
    expect(plan.schema).toEqual(Object.fromEntries(Object.entries(WIKI_PLAN_SCHEMA).map(([level, keys]) => [level, [...keys]])));
    // The target a draft is held to by default is the one the owner named: 20 to 35 documents.
    expect([WIKI_PLAN_RULES.docsMin, WIKI_PLAN_RULES.docsMax]).toEqual([20, 35]);
    // Every level that may hold a declared field carries `extra`, and declares nothing else by that name.
    for (const level of WIKI_PLAN_NEW_FIELD_LEVELS) expect(WIKI_PLAN_SCHEMA[level]).toContain('extra');
    for (const kind of WIKI_PLAN_REPO_REF_KINDS) expect(plan.gate.repo).toContain(kind);

    // The migration's CHECKs are the contract's closed sets and numbers.
    const sql = readFileSync(path.join(ROOT, plan.migration), 'utf8');
    const quoted = (values: readonly string[]) => values.map((v) => `'${v}'`).join(', ');
    expect(sql).toContain(`"status" IN (${quoted(WIKI_PLAN_STATUSES)})`);
    expect(sql).toContain(`"origin" IN (${quoted(WIKI_PLAN_ORIGINS)})`);
    expect(sql.replace(/\s+/gu, ' ')).toContain(`"kind" IN ( ${quoted(WIKI_PLAN_SECTION_KINDS)})`);
    expect(sql).toContain(`"status" IN (${quoted(WIKI_PLAN_PROPOSAL_STATUSES)})`);
    expect(sql).toContain(`"docs_max" <= ${WIKI_PLAN_RULES.docsCeiling}`);
    expect(sql).toContain(`char_length("title") <= ${WIKI_PLAN_RULES.titleMaxChars}`);
    expect(sql).toContain(`char_length("question") <= ${WIKI_PLAN_RULES.questionMaxChars}`);
    expect(sql).toContain(`char_length("covers") <= ${WIKI_PLAN_RULES.coversMaxChars}`);
    expect(sql).toContain(`char_length("reason") <= ${WIKI_PLAN_RULES.reasonMaxChars}`);
    expect(sql).toContain(`"length_max" <= ${WIKI_PLAN_RULES.lengthMaxChars}`);
    // A space has one draft and one confirmed version at a time.
    expect(sql).toMatch(/UNIQUE INDEX IF NOT EXISTS "wiki_plan_space_id_draft_key" ON "wiki_plan" \("space_id"\) WHERE "status" = 'draft'/u);
    expect(sql).toMatch(/UNIQUE INDEX IF NOT EXISTS "wiki_plan_space_id_confirmed_key" ON "wiki_plan" \("space_id"\) WHERE "status" = 'confirmed'/u);

    // Its doors: the owner's six on the user door, no route on the runner door, and none that takes a draft or a proposal.
    const routes = plan.routes;
    const user: string[] = CONTRACT.agentSurface.doors.user.routes;
    for (const route of [routes.state, routes.versions, routes.version, routes.edit, routes.confirm, routes.decide]) expect(user).toContain(route);
    expect(Object.values<string>(routes).some((route) => route.includes('/api/runner/'))).toBe(false);
    expect(plan.who.owner).toMatch(/WIKI_OWNER_CHANNEL_ONLY/u);
    expect(plan.who.draft).toMatch(/in process: no door takes a draft or a proposal, nor answers a read of the plan to a session/u);
    expect(plan.guard).toMatch(/^requireConfirmedPlan\(/u);
    expect(plan.guard).toMatch(/WIKI_PLAN_UNCONFIRMED/u);
    const status = (code: string) => CONTRACT.refusals.find((r: { code: string }) => r.code === code)?.httpStatus;
    expect(status('WIKI_PLAN_GATE')).toBe(422);
    expect(status('WIKI_PLAN_STALE')).toBe(409);
    expect(status('WIKI_PLAN_UNCONFIRMED')).toBe(409);
    expect(CONTRACT.realtime.publishedWhen.some((when: string) => /plan was stored or confirmed/u.test(when))).toBe(true);
    // No tool: confirming and deciding are the owner's (hard constraint 2).
    expect(plan.tool).toMatch(/^none/u);
    for (const tool of CONTRACT.agentSurface.tools) expect(tool).not.toMatch(/plan/u);

    // A draft under an idempotency key (0339): the same draft landing again is answered with the version
    // it stored, before WIKI_PLAN_STALE could refuse it; another request under the key is a 409.
    expect(plan.requests.draft).toContain('idempotencyKey?');
    expect(plan.versions).toMatch(/plan\.idempotency/u);
    expect(plan.idempotency.replay).toMatch(/replayed: true/u);
    expect(plan.idempotency.replay).toMatch(/before WIKI_PLAN_STALE/u);
    expect(plan.idempotency.reused).toMatch(/WIKI_IDEMPOTENCY_KEY_REUSED \(409\)/u);
    expect(status('WIKI_IDEMPOTENCY_KEY_REUSED')).toBe(409);
    expect(plan.idempotency.runner).toMatch(/wikiPlanServerDraftKey/u);
    const keyed = readFileSync(path.join(ROOT, plan.idempotency.migration), 'utf8').replace(/\s+/gu, ' ');
    expect(plan.idempotency.migration).toMatch(/0339_wiki_plan_idempotency/u);
    expect(keyed).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "wiki_plan_owner_idempotency_key" ON "wiki_plan" ("owner_id", "idempotency_key")');
    expect(keyed).toContain('CHECK (("idempotency_key" IS NULL) = ("request_sha256" IS NULL)');
  });

  it('ships the plan\'s jobs the contract states: kinds, triggers, states, held reasons, rules and routes', () => {
    // Criterion 11: a draft or a revision of a space's plan, run as a job of the wiki-worker.
    const jobs = CONTRACT.plan.jobs;
    expect(jobs.phase).toBe(2);
    expect(jobs.tables).toEqual(['wiki_plan_job']);
    expect(jobs.migration).toMatch(/0338_wiki_plan_job/u);
    expect(keysOf(jobs.kinds)).toEqual([...WIKI_PLAN_JOB_KINDS]);
    expect(keysOf(jobs.triggers)).toEqual([...WIKI_PLAN_JOB_TRIGGERS]);
    expect(keysOf(jobs.states)).toEqual([...WIKI_PLAN_JOB_STATES]);
    expect(jobs.storedStates).toEqual([...WIKI_PLAN_JOB_STORED_STATES]);
    expect(jobs.held.reasons).toEqual([...WIKI_PLAN_JOB_HELD_REASONS]);
    for (const reason of WIKI_PLAN_JOB_HELD_REASONS) expect(jobs.held[reason]).toBeTruthy();
    expect(jobs.rules).toEqual(WIKI_PLAN_JOB_RULES);
    // Three rounds: the first, and two more with every error handed back.
    expect(WIKI_PLAN_JOB_RULES.attemptsMax).toBe(3);
    // The build writes the documents of a confirmed version; the owner's confirmation asks for it.
    expect(jobs.kinds.build).toMatch(/^the documents of a confirmed version written section by section \(wiki_job docs_build, docs\.build\.server\), which the owner's confirmation asks for/u);
    expect(jobs.triggers.owner).toMatch(/plan\/versions\/:version\/confirm/u);
    expect(jobs.request).toMatch(/A build is asked for by the owner's confirmation/u);
    expect(jobs.progress).toMatch(/\{ docs: \{ done, total \}, current: \{ slug, title \} \| null \}/u);
    expect(jobs.buildReport).toMatch(/WikiPlanBuildReport/u);
    // One build of a space waits at a time, and a build names its version from the start (migration 0340).
    const buildSql = readFileSync(path.join(ROOT, jobs.buildMigration), 'utf8').replace(/\s+/gu, ' ');
    expect(buildSql).toContain(`"wiki_plan_job_space_id_waiting_build_key" ON "wiki_plan_job" ("space_id") WHERE "kind" = 'build' AND "state" IN ('queued', 'held')`);
    expect(buildSql).toContain(`CHECK ("kind" <> 'build' OR "version" IS NOT NULL)`);
    // A fact asks for a job, and what moves it on is a fact too — never a clock.
    expect(jobs.means).toMatch(/never a clock/u);
    expect(jobs.trigger).toMatch(/No clock asks anything/u);
    // A job and the space's maintenance runs are wiki jobs of their own, one of a space at a time: a request makes a
    // job at once, and the owner's change to the settings asks one that waits again.
    expect(jobs.staggered).toMatch(/A job does not wait for the space's maintenance runs, nor they for it: each is a wiki_job of its own, and the worker runs one job of a space at a time/u);
    expect(jobs.states.queued).toMatch(/recorded and not made yet: a request makes it at once/u);
    expect(jobs.trigger).toMatch(/the owner's change to a space's maintenance settings asks its held and queued jobs again/u);
    expect(jobs.notAMaintenanceRun).toMatch(/wikiMaintenanceRunsToday/u);

    // The migration's CHECKs are these closed sets.
    const sql = readFileSync(path.join(ROOT, jobs.migration), 'utf8');
    const quoted = (values: readonly string[]) => values.map((v) => `'${v}'`).join(', ');
    expect(sql).toContain(`"kind" IN (${quoted(WIKI_PLAN_JOB_KINDS)})`);
    // 0338 wrote the first two facts; 0429 restated the CHECK with the third, an administrator's (rebuild).
    expect(sql).toContain(`"trigger" IN (${quoted(WIKI_PLAN_JOB_TRIGGERS.filter((trigger) => trigger !== 'support'))})`);
    const triggers = readFileSync(path.join(ROOT, jobs.rebuild.migration), 'utf8');
    expect(triggers).toContain(`CHECK ("trigger" IN (${quoted(WIKI_PLAN_JOB_TRIGGERS)}))`);
    expect(sql).toContain(`"state" IN (${quoted(WIKI_PLAN_JOB_STORED_STATES)})`);
    expect(sql).toContain(`"held_reason" IN (${quoted(WIKI_PLAN_JOB_HELD_REASONS)})`);
    expect(sql).toContain(`"outcome" IN (${quoted(WIKI_PLAN_JOB_OUTCOMES)})`);
    expect(sql).toContain(`char_length("instructions") <= ${WIKI_PLAN_JOB_RULES.instructionsMaxChars}`);
    expect(sql).toContain(`char_length("error") <= ${WIKI_PLAN_JOB_RULES.errorMaxChars}`);
    // One draft or revision of a space that has not ended.
    expect(sql.replace(/\s+/gu, ' ')).toContain(
      `"wiki_plan_job_space_id_open_draft_key" ON "wiki_plan_job" ("space_id") WHERE "kind" IN ('draft', 'revise') AND "state" IN ('queued', 'held', 'made')`,
    );

    // The owner's route is on the user door, and none is on the runner door.
    const user: string[] = CONTRACT.agentSurface.doors.user.routes;
    expect(CONTRACT.plan.routes.redraft).toBe(jobs.routes.redraft);
    expect(user).toContain(jobs.routes.redraft);
    expect(Object.values<string>(jobs.routes).some((route) => route.includes('/api/runner/'))).toBe(false);
    expect(jobs.who.redraft).toMatch(/WIKI_OWNER_CHANNEL_ONLY/u);
  });

  it('ships the documents of the version in force asked for again: the owner\'s route, the support route, and their rules', () => {
    // Owner's call 2026-10-17 (plan.jobs.rebuild): the owner, and an administrator for support, may ask for the build
    // of the version in force again — the server's path alone.
    const jobs = CONTRACT.plan.jobs;
    const rebuild = jobs.rebuild;
    expect(rebuild.migration).toMatch(/0429_wiki_plan_job_support_trigger/u);
    expect(existsSync(path.join(ROOT, rebuild.migration))).toBe(true);
    expect(rebuild.rules).toEqual({ reasonMaxChars: WIKI_PLAN_REBUILD.reasonMaxChars });
    expect(rebuild.activity).toBe(WIKI_PLAN_REBUILD.activity);
    // The routes: the owner's on the user door beside confirm, the administrator's two in the admin area.
    expect(rebuild.routes.owner).toBe('POST /api/wiki/spaces/:id/plan/versions/:version/build');
    expect(CONTRACT.plan.routes.build).toBe(rebuild.routes.owner);
    expect(jobs.routes.build).toBe(rebuild.routes.owner);
    expect(CONTRACT.agentSurface.doors.user.routes).toContain(rebuild.routes.owner);
    expect(rebuild.routes.support).toBe('POST /api/admin/wiki/spaces/:id/plan/build');
    expect(jobs.routes.supportBuild).toBe(rebuild.routes.support);
    expect(rebuild.routes.supportSpaces).toBe('GET /api/admin/wiki/users/:id/spaces');
    expect(jobs.routes.supportSpaces).toBe(rebuild.routes.supportSpaces);
    // An administrator's request is the third fact that asks for a job.
    expect(WIKI_PLAN_JOB_TRIGGERS).toContain('support');
    expect(jobs.triggers.support).toMatch(/POST \/api\/admin\/wiki\/spaces\/:id\/plan\/build/u);
    expect(jobs.triggers.owner).toMatch(/plan\/versions\/:version\/build/u);
    // Who: the owner channel, never a token; an administrator, never a token nor while viewing another account.
    expect(rebuild.who).toMatch(/WIKI_OWNER_CHANNEL_ONLY/u);
    expect(rebuild.who).toMatch(/OWNER_INTERACTIVE/u);
    expect(jobs.who.support).toMatch(/PatForbidden ADMIN/u);
    expect(jobs.who.support).toMatch(/IMPERSONATION_FORBIDDEN/u);
    // Whenever the owner asks: the server executes every account's wiki.
    expect(rebuild.when).toMatch(/Whenever the owner asks, of the version in force: the server executes every account's wiki/u);
    // The version in force alone, one build of it on its way, and neither counted nor held back by the day's limit.
    expect(rebuild.version).toMatch(/WIKI_PLAN_UNCONFIRMED/u);
    expect(rebuild.version).toMatch(/WIKI_PLAN_STALE/u);
    expect(rebuild.idempotent).toMatch(/FOR NO KEY UPDATE/u);
    expect(rebuild.idempotent).toMatch(/created false/u);
    expect(rebuild.limits).toMatch(/dailyRunLimit, nor held back by it/u);
    expect(jobs.notAMaintenanceRun).toMatch(/A build asked for again \(rebuild\)/u);
    expect(rebuild.makes).toMatch(/docs_build wiki_job/u);
    expect(rebuild.makes).toMatch(/no task, no session/u);
    // The audit: the job's row for everybody, an Activity row in the same transaction for an administrator.
    expect(rebuild.audit).toMatch(/requested_by_user_id/u);
    expect(rebuild.support).toMatch(/In the same transaction as the job, one Activity row/u);
    expect(rebuild.support).toMatch(/\{ userId, spaceId, version, planJobId, created, reason \}/u);
    expect(rebuild.support).toMatch(/No CLI/u);
  });

  it('ships the documents the contract states: their closed sets, rules and schema, their tables, the withdrawal and their doors', () => {
    // Criterion 9 (revised 2026-09-28): written from the confirmed plan, footnoted to first-hand originals.
    const docs = CONTRACT.docs;
    expect(docs.phase).toBe(2);
    expect(docs.tables).toEqual(['wiki_doc', 'wiki_doc_section', 'wiki_doc_sentence', 'wiki_doc_footnote']);
    expect(docs.migration).toMatch(/0326_wiki_docs/u);
    expect(existsSync(path.join(ROOT, docs.migration))).toBe(true);
    expect(keysOf(docs.statuses)).toEqual([...WIKI_DOC_STATUSES]);
    expect(keysOf(docs.sentenceStatuses)).toEqual([...WIKI_DOC_SENTENCE_STATUSES]);
    expect(keysOf(docs.footnoteKinds)).toEqual([...WIKI_DOC_FOOTNOTE_KINDS]);
    expect(docs.repoKinds).toEqual([...WIKI_DOC_REPO_KINDS]);
    expect(docs.recordKinds).toEqual([...WIKI_DOC_RECORD_KINDS]);
    expect(keysOf(docs.verdicts)).toEqual([...WIKI_DOC_VERDICTS]);
    expect(keysOf(docs.checkers)).toEqual([...WIKI_DOC_CHECKERS]);
    expect(docs.withdrawReasons).toEqual([...WIKI_DOC_WITHDRAW_REASONS]);
    expect(keysOf(docs.blockKinds)).toEqual([...WIKI_DOC_BLOCK_KINDS]);
    expect(docs.rules).toEqual(WIKI_DOC_RULES);
    // A written document's two lines on the home, which the directory carries.
    expect(docs.lead.rules).toEqual(WIKI_DOC_LEAD_RULES);
    expect(docs.reads.directory).toMatch(/\blead\b/u);
    expect(docs.schema).toEqual(Object.fromEntries(Object.entries(WIKI_DOC_SCHEMA).map(([level, keys]) => [level, [...keys]])));
    // What became of each piece of a section's material is written with it, and kept (migration 0337).
    expect(keysOf(docs.dispositionActions)).toEqual([...WIKI_DOC_DISPOSITION_ACTIONS]);
    expect(WIKI_DOC_SCHEMA.section).toContain('dispositions');
    expect(docs.requests.write).toMatch(/dispositions\?: \[\{ material, kind, ref, action, into, reason \}\]/u);
    expect(docs.dispositionsMigration).toMatch(/0337_wiki_doc_dispositions/u);
    expect(existsSync(path.join(ROOT, docs.dispositionsMigration))).toBe(true);
    expect(readFileSync(path.join(ROOT, docs.dispositionsMigration), 'utf8')).toContain(`CHECK (jsonb_typeof("dispositions") = 'array')`);
    // The server's half of a section's material, and the build over both halves.
    expect(keysOf(docs.material.weights)).toEqual([...WIKI_DOC_MATERIAL_WEIGHTS]);
    expect(docs.material.rules).toEqual(WIKI_DOC_MATERIAL_RULES);
    expect(docs.material.records).toMatch(/sourceText/u);
    expect(docs.material.records).toMatch(/redacted/u);
    // A condition's projects are ids whichever way the plan reached its reader: stored ids, or a read's { id, title } (2026-10-09).
    expect(docs.material.projects).toMatch(/\{ id, title \}/u);
    expect(docs.material.projects).toMatch(/22P02/u);
    expect(docs.build.rules).toEqual(WIKI_DOC_BUILD_RULES);
    expect(docs.build.templates).toMatch(/Orbit has not recorded it done/u);
    // More than 5% marks a document; a whole document fits one write.
    expect(WIKI_DOC_RULES.needsReviewAbove).toBe(0.05);
    expect(WIKI_DOC_RULES.sectionsPerWrite).toBe(CONTRACT.plan.rules.sectionsMax);
    // A record a footnote names is a first-hand record a source may name too; a document is not one.
    for (const kind of WIKI_DOC_RECORD_KINDS) expect(WIKI_SOURCE_KINDS).toContain(kind);
    for (const kind of WIKI_DOC_REPO_KINDS) expect(WIKI_SOURCE_KINDS as readonly string[]).not.toContain(kind);
    // Every section keeps the origin/main commit it was generated at, for a run to compare with origin/main.
    expect(WIKI_DOC_SCHEMA.write).toContain('repoSha');
    expect(docs.repoSha).toMatch(/origin\/main/u);
    expect(docs.reads.writerState).toMatch(/repoSha/u);
    // A repository footnote needs its sha; a record's is the server's own check.
    expect(WIKI_DOC_SCHEMA.repoFootnote).toContain('sha');
    expect(WIKI_DOC_SCHEMA.recordFootnote).not.toContain('verified');
    expect(docs.verification.repository).toMatch(/sha/u);
    expect(docs.verification.records).toMatch(/runEventText/u);
    // A session record's footnote is read back with its session beside its id: the deep link needs both.
    expect(docs.links.sessionRecord).toMatch(/recordId/u);
    expect(docs.links.sessionRecord).toMatch(/sessionId/u);
    expect(docs.links.sessionRecord).toMatch(/around=<recordId>/u);
    expect(docs.reads.doc).toMatch(/sessionId/u);
    // The withdrawal hangs on the entry's single state writer, not on a writer of its own.
    expect(docs.withdrawal).toMatch(/recomputeFlags/u);
    expect(docs.withdrawal).toMatch(/applyOp/u);
    // A repository file gone from origin/main withdraws what cites it, as its anchor gone missing, naming the path.
    expect(docs.withdrawalPaths).toMatch(/anchor_missing/u);
    expect(WIKI_DOC_WITHDRAW_REASONS).toContain('anchor_missing');
    const withdrawalSql = readFileSync(path.join(ROOT, docs.withdrawalMigration), 'utf8').replace(/\s+/gu, ' ');
    expect(withdrawalSql).toContain(`"withdrawn_path" IS NULL OR ("withdrawn_reason" = 'anchor_missing'`);
    expect(withdrawalSql).toContain(`("withdrawn_entry_id" IS NULL OR "withdrawn_path" IS NULL)`);
    // What a maintenance run writes again: the sections an entry that fits them changed since, by the rule the material picks by.
    expect(docs.affected.rules).toEqual(WIKI_DOCS_AFFECTED_RULES);
    expect(docs.affected.fit).toMatch(/material\.entries picks a section's entries by the same rule/u);
    expect(docs.material.entries).toMatch(/affected\.fit/u);
    expect(docs.reads.affected).toMatch(/WikiDocsAffected/u);
    expect(docs.requests.withdraw).toMatch(/withdrawPathsMax/u);

    // The migration's CHECKs are the contract's closed sets.
    const sql = readFileSync(path.join(ROOT, docs.migration), 'utf8');
    const quoted = (values: readonly string[]) => values.map((v) => `'${v}'`).join(', ');
    expect(sql).toContain(`"status" IN (${quoted(WIKI_DOC_STATUSES)})`);
    expect(sql).toContain(`"status" IN (${quoted(WIKI_DOC_SENTENCE_STATUSES)})`);
    expect(sql.replace(/\s+/gu, ' ')).toContain(`"kind" IN ( ${quoted(WIKI_DOC_FOOTNOTE_KINDS)})`);
    expect(sql).toContain(`"verdict" IN (${quoted(WIKI_DOC_VERDICTS)})`);
    expect(sql).toContain(`"checked_by" IN (${quoted(WIKI_DOC_CHECKERS)})`);
    expect(sql.replace(/\s+/gu, ' ')).toContain(`"withdrawn_reason" IN (${quoted(WIKI_DOC_WITHDRAW_REASONS)})`);
    expect(sql).toContain(`char_length("quote") <= ${WIKI_DOC_RULES.quoteMaxChars}`);
    expect(sql).toContain(`char_length("excerpt") <= ${WIKI_DOC_RULES.excerptMaxChars}`);
    expect(sql).toContain(`CONSTRAINT "wiki_doc_section_repo_sha_chk" CHECK ("repo_sha" ~ '^[0-9a-f]{40}$')`);

    // Its doors: the owner's three reads on the user door, and no route on the runner door.
    const routes = docs.routes;
    const user: string[] = CONTRACT.agentSurface.doors.user.routes;
    for (const read of [routes.directory, routes.doc, routes.index]) expect(user).toContain(read);
    expect(Object.values<string>(routes).some((route) => route.includes('/api/runner/'))).toBe(false);
    expect(user.some((route) => route.startsWith('POST') && route.includes('/docs'))).toBe(false);
    expect(docs.who.write).toMatch(/no door builds either, and the user door has no write route: any other caller is an error of the server's own code \(WikiDocs\.assertWriter\)/u);
    expect(docs.who.write).toMatch(/WIKI_PLAN_UNCONFIRMED/u);
    // A view: never a source, never pushed, never an agent's answer.
    expect(docs.view.push).toMatch(/Never in <orbit_wiki_context>/u);
    expect(docs.view.source).toMatch(/WIKI_SOURCE_UNRESOLVED/u);
    expect(docs.view.agents).toMatch(/wiki_search or wiki_get/u);
    const status = (code: string) => CONTRACT.refusals.find((r: { code: string }) => r.code === code)?.httpStatus;
    expect(status('WIKI_DOC_INVALID')).toBe(422);
    expect(status('WIKI_PLAN_STALE')).toBe(409);
    expect(CONTRACT.realtime.publishedWhen.some((when: string) => /document's sections were written/u.test(when))).toBe(true);
    expect(docs.tool).toMatch(/^none/u);
    for (const tool of CONTRACT.agentSurface.tools) expect(tool).not.toMatch(/doc/u);
    // The topic articles stay until the clients have moved over.
    expect(docs.means).toMatch(/wiki_topic_summary/u);
    expect(CONTRACT.articles.tables).toEqual(['wiki_topic_summary']);
  });

  it('declares every refusal once, with a status and a scope, and names no code it does not declare', () => {
    const codes: string[] = CONTRACT.refusals.map((r: { code: string }) => r.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const r of CONTRACT.refusals) {
      expect(r.httpStatus, r.code).toBeGreaterThanOrEqual(400);
      expect(r.httpStatus, r.code).toBeLessThan(500);
      expect(['request', 'op'], r.code).toContain(r.scope);
      expect(r.when, r.code).toBeTruthy();
    }
    // Design §5.4's twelve are all here but WIKI_NOT_MAINTENANCE_SESSION, which went with the maintenance sessions (P11);
    // anything more is marked as this contract's own addition.
    const design = [
      'WIKI_DISABLED', 'WIKI_SPACE_UNBOUND', 'WIKI_SCHEMA', 'WIKI_KIND_OWNER_ONLY', 'WIKI_SOURCE_UNRESOLVED',
      'WIKI_QUOTE_NOT_FOUND', 'WIKI_REVISION_CONFLICT', 'WIKI_QUOTA', 'WIKI_REVIEW_QUEUE_FULL', 'WIKI_PROBE_REFUSED',
      'WIKI_OWNER_CHANNEL_ONLY',
    ];
    for (const code of design) expect(codes).toContain(code);
    expect(codes).not.toContain('WIKI_NOT_MAINTENANCE_SESSION');
    for (const r of CONTRACT.refusals.filter((x: { code: string }) => !design.includes(x.code))) {
      expect(r.addedByThisContract, `${r.code} is not in design §5.4 and does not say it was added`).toBe(true);
    }
    // A code mentioned anywhere in the prose is a declared one: a typo here would be a refusal nobody sends.
    // An environment variable that merely contains one (`ORBIT_WIKI_CANARY_OWNERS`) is not a code.
    const mentioned = new Set(JSON.stringify(CONTRACT).match(/(?<![A-Z_])WIKI_[A-Z_]+/gu));
    for (const code of mentioned) expect(codes, `${code} is mentioned but not declared`).toContain(code);
    // Tenancy and the owner channel keep their answers.
    const status = (code: string) => CONTRACT.refusals.find((r: { code: string }) => r.code === code).httpStatus;
    expect(status('WIKI_DISABLED')).toBe(404);
    expect(status('WIKI_REVISION_CONFLICT')).toBe(409);
    expect(status('WIKI_OWNER_CHANNEL_ONLY')).toBe(403);
  });

  it('gives agents three tools and two doors, and no way to decide', () => {
    const surface = CONTRACT.agentSurface;
    expect(surface.tools).toEqual(['wiki_search', 'wiki_get', 'wiki_propose']);
    expect(keysOf(surface.toolSpecs)).toEqual(surface.tools);
    expect(keysOf(surface.cli)).toEqual(surface.tools);
    expect(surface.toolSpecs.wiki_search.readOnly).toBe(true);
    expect(surface.toolSpecs.wiki_get.readOnly).toBe(true);
    expect(surface.toolSpecs.wiki_propose.readOnly).toBe(false);
    expect(surface.toolSpecs.wiki_propose.destructive).toBe(false);
    for (const tool of surface.tools) expect(tool).not.toMatch(/accept|confirm|decide|delete/u);

    expect(keysOf(surface.doors)).toEqual(['user', 'runner']);
    // No maintenance session is left to serve: the runner door has no maintenance routes.
    expect(surface.doors.runner).not.toHaveProperty('maintenanceRoutes');
    const user: string[] = surface.doors.user.routes;
    const runner: string[] = [
      ...surface.doors.runner.routes,
      ...surface.doors.runner.verificationRoutes,
    ];
    for (const route of user) expect(route).toMatch(/^(GET|POST|PATCH) \/api\/wiki\//u);
    for (const route of runner) expect(route).toMatch(/^(GET|POST) \/api\/runner\/wiki\//u);
    // Deciding is the owner's, on the owner's door, and nowhere an agent can reach.
    expect(user).toContain(surface.decide.route);
    expect(surface.decide.route).toBe(CONTRACT.effectPolicy.decide.route);
    expect(runner.some((route) => /decide/u.test(route))).toBe(false);
    expect(surface.decide.sessionHeader).toMatch(/WIKI_OWNER_CHANNEL_ONLY/u);
    expect(surface.proposeDescription).toMatch(/waits for the owner's review/u);
  });

  it('announces a change by the space\'s id alone', () => {
    expect(CONTRACT.realtime.event).toBe('wiki.changed');
    expect(CONTRACT.realtime.payload).toEqual(['id']);
    expect(CONTRACT.realtime.notPublishedWhen).toContain('an idempotent replay');
    expect(CONTRACT.realtime.correctness).toMatch(/Nothing depends on it/u);
  });

  it("says what each source kind takes as its ref, and refuses a row's ref that is no id by its path", () => {
    // One phrase per kind, the words a refusal of a ref that names nothing says too (sourceInput.refs).
    expect(keysOf(CONTRACT.sourceInput.refs)).toEqual([...WIKI_SOURCE_KINDS]);
    expect(CONTRACT.sourceInput.refs).toEqual(WIKI_SOURCE_REFS);
    // The kinds whose ref can only be a row's id: a tool_call takes a tool_use_id too, and a commit is a sha.
    expect(CONTRACT.sourceInput.rowIdKinds).toEqual([...WIKI_SOURCE_ROW_ID_KINDS]);
    for (const kind of WIKI_SOURCE_ROW_ID_KINDS) expect(WIKI_SOURCE_KINDS).toContain(kind);
    expect(WIKI_SOURCE_ROW_ID_KINDS).not.toContain('tool_call');
    expect(WIKI_SOURCE_ROW_ID_KINDS).not.toContain('commit');
    expect(WIKI_SOURCE_REFS.tool_call).toMatch(/tool_use_id/u);
    expect(CONTRACT.sourceInput.toolUseId).toMatch(/that two sessions carry, is unresolved/u);

    // A tool_use_id where a task's id goes is refused by its path, saying what goes there instead. As a
    // tool_call's ref it is a tool_use_id, which only the lookup can judge.
    const toolUseId = 'toolu_0195URa2d9G6F4AKQoGfVprN';
    const errors = validateWikiSources([{ kind: 'tool_call', ref: toolUseId }, { kind: 'task', ref: toolUseId }], 'ops[0].sources');
    expect(errors.map((e) => e.path)).toEqual(['ops[0].sources[1].ref']);
    expect(errors[0]!.message).toContain(WIKI_SOURCE_REFS.task);
    expect(errors[0]!.message).toMatch(/the UUID, or the short public id/u);
    // Both spellings of an id are one id.
    expect(validateWikiSources([
      { kind: 'task', ref: '0199aaaa-0000-7000-8000-000000000000' },
      { kind: 'task', ref: '34UuAT0pwUgBln9yRlAZF' },
    ])).toEqual([]);

    // A dry run is answered with the status the request itself would be.
    expect(CONTRACT.refusalRules.dryRun).toMatch(/under the status the request would be answered with/u);
    const status = (code: string) => CONTRACT.refusals.find((r: { code: string }) => r.code === code)?.httpStatus;
    expect(status('WIKI_SCHEMA')).toBe(400);
    expect(status('WIKI_SOURCE_UNRESOLVED')).toBe(422);
  });

  it('carries uniquely named vectors with reasons, a valid and an invalid one for every kind', () => {
    const vectors: Array<{ id: string; why: string; draft?: { kind: string }; sources?: unknown[]; expect: { errors: string[] } }> =
      CONTRACT.vectors;
    const ids = vectors.map((v) => v.id);
    expect(new Set(ids).size, 'vector ids are not unique').toBe(ids.length);
    for (const v of vectors) {
      expect(v.why, `${v.id} does not say why it matters`).toBeTruthy();
      expect(Array.isArray(v.expect.errors), `${v.id} expects no error list`).toBe(true);
      expect((v.draft === undefined) !== (v.sources === undefined), `${v.id} gives neither or both`).toBe(true);
    }
    for (const kind of WIKI_KINDS) {
      const of = vectors.filter((v) => v.draft?.kind === kind);
      expect(of.some((v) => v.expect.errors.length === 0), `no valid ${kind} vector`).toBe(true);
      expect(of.some((v) => v.expect.errors.length > 0), `no invalid ${kind} vector`).toBe(true);
    }
  });

  it.each((CONTRACT.vectors as Array<{ id: string }>).map((v) => [v.id, v]))(
    'vector %s: the validators name exactly the fields it expects',
    (_id, vector) => {
      const v = vector as { draft?: unknown; sources?: unknown; expect: { errors: string[] } };
      const errors = v.draft !== undefined ? validateWikiEntryDraft(v.draft) : validateWikiSources(v.sources);
      for (const error of errors) expect(error.message, error.path).toBeTruthy();
      expect(errors.map((e) => e.path).sort()).toEqual([...v.expect.errors].sort());
    },
  );

  it('imports a file as a note, and proposes from it as an agent would', () => {
    const imports = CONTRACT.import;
    expect(imports.phase).toBe(2);
    expect(imports.rules).toEqual({ ...WIKI_IMPORT_RULES });
    expect(imports.tables).toEqual(['wiki_note']);
    // The note's CHECKs are the rules' own numbers.
    const sql = readFileSync(path.join(ROOT, imports.migration), 'utf8');
    expect(sql).toContain(`char_length("text") <= ${WIKI_IMPORT_RULES.noteMaxChars}`);
    expect(sql).toContain(`char_length("path") <= ${WIKI_IMPORT_RULES.notePathMaxChars}`);
    expect(sql).toMatch(/UNIQUE INDEX IF NOT EXISTS "wiki_note_space_id_content_sha256_key"\s+ON "wiki_note" \("space_id", "content_sha256"\)/u);
    // A note is a source kind, and an import an origin, that phase 1 already declared; what an import
    // proposes is held to exactly what an agent's proposal is.
    expect(WIKI_SOURCE_KINDS).toContain('note');
    expect(WIKI_CHANGESET_ORIGINS).toContain('import');
    expect(WIKI_EFFECT_POLICY.origins.import).toEqual(WIKI_EFFECT_POLICY.origins.agent);
    expect(imports.source).toMatch(/never the owner's own words/u);
    // A run is one changeset's worth.
    expect(WIKI_IMPORT_RULES.opsPerRun).toBe(WIKI_LIMITS.opsPerChangeset);
    // Its one route is the runner door's, and decides nothing: it registers a note.
    const runner = CONTRACT.agentSurface.doors.runner;
    expect(runner.importRoutes).toEqual([imports.note.route]);
    for (const route of runner.importRoutes) expect(route).toMatch(/^POST \/api\/runner\/wiki\/spaces\/:id\/notes$/u);
    expect(imports.note.redaction).toMatch(/BEFORE anything is stored or hashed/u);
    // A CLI verb with no tool beside it, whose description leads with what its reader must not do.
    expect(imports.cli.command).toMatch(/^orbit wiki import --from <dir\|file> --space <id>/u);
    expect(imports.cli.tool).toMatch(/^none/u);
    expect(imports.cli.precondition).toMatch(/never write an entry yourself/u);
    expect(CONTRACT.agentSurface.tools).not.toContain('wiki_import');
  });

  it('reads an import on the server, under the same rules (server execution P5)', () => {
    const server = CONTRACT.import.server;
    // The job's numbers and words are the shared constants the worker and the door run by.
    expect(server.priority).toBe(WIKI_IMPORT_JOB.priority);
    expect(server.steps).toEqual({ ...WIKI_IMPORT_JOB.steps });
    expect(server.maxTokens).toBe(WIKI_IMPORT_JOB.maxTokens);
    expect([server.defaultConcurrency, server.maxConcurrency, server.maxNotes])
      .toEqual([WIKI_IMPORT_JOB.defaultConcurrency, WIKI_IMPORT_JOB.maxConcurrency, WIKI_IMPORT_JOB.maxNotes]);
    expect(server.systemPrompt).toBe(WIKI_IMPORT_JOB.systemPrompt);
    expect(server.snapshot.waitSeconds).toBe(WIKI_IMPORT_JOB.snapshotWaitSeconds);
    // Both of a note's calls are the import's to wait for and to run: its wait limit, the default budget.
    for (const step of Object.values(WIKI_IMPORT_JOB.steps)) {
      expect(wikiModelWaitLimitSeconds(step)).toBe(WIKI_MODEL_QUEUE.waitLimitSeconds.import);
      expect(wikiModelCallBudgetSeconds(step)).toBe(WIKI_MODEL_QUEUE.defaultCallBudgetSeconds);
    }
    // Three routes on the runner door, beside the note route the import has always had, and none of them decides anything.
    const runner = CONTRACT.agentSurface.doors.runner;
    expect(runner.importJobRoutes).toEqual([WIKI_IMPORT_JOB.routes.executor, WIKI_IMPORT_JOB.routes.create, WIKI_IMPORT_JOB.routes.read]);
    expect([server.executor.route, server.create.route, server.read.route]).toEqual(runner.importJobRoutes);
    for (const route of runner.importJobRoutes) expect(route).toMatch(/^(GET|POST) \/api\/runner\/wiki\/spaces\/:id\/import(-jobs(\/:jobId)?)?$/u);
    // The note route takes only a note the server reads: a command that would read it with the session's own model is
    // refused before anything is registered.
    expect(server.door).toMatch(/is refused WIKI_SERVER_EXECUTES before anything is registered/u);
    expect(CONTRACT.refusals.find((r: { code: string }) => r.code === 'WIKI_SERVER_EXECUTES')?.httpStatus).toBe(409);
    // A job of its own kind, which the worker runs, held to the answers the runner's reading gave (the fixture its Go
    // test wrote).
    expect(WIKI_JOB_KINDS).toContain('import');
    expect(CONTRACT.jobs.kindRuns.import).toMatch(/import\.server/u);
    expect(server.propose).toMatch(/origin import/u);
    expect(server.deterministic).toContain('src/shared/src/wiki-import.fixture.json');
    for (const file of ['src/shared/src/wiki-import.fixture.json', 'src/apiserver/src/wiki-worker/wiki-import-golden.spec.ts']) {
      expect(existsSync(path.join(ROOT, file)), `${file} does not exist`).toBe(true);
    }
  });

  it('builds the documents on the server, as the runner built them (server execution P7)', () => {
    const server = CONTRACT.docs.build.server;
    // The job's numbers and words are the shared constants the worker runs by.
    expect(server.priority).toBe(WIKI_DOCS_BUILD_JOB.priority);
    expect(server.steps).toEqual({ ...WIKI_DOCS_BUILD_JOB.steps });
    // A file is shown only once its read landed, a read another section started included (2026-10-09).
    expect(server.shown).toMatch(/waits for that read/u);
    // A path holding a wildcard is read as the runner's git show read it, a pathspec: an empty file (2026-10-10).
    expect(server.wildcard).toMatch(/pathspec/u);
    expect(CONTRACT.docs.build.repository).toMatch(/server\.wildcard/u);
    expect([server.maxTokens, server.repoWaitSeconds, server.readsInFlight, server.readAttempts])
      .toEqual([WIKI_DOCS_BUILD_JOB.maxTokens, WIKI_DOCS_BUILD_JOB.repoWaitSeconds, WIKI_DOCS_BUILD_JOB.readsInFlight, WIKI_DOCS_BUILD_JOB.readAttempts]);
    // Owner-initiated: above background maintenance (jobs.priority), as the import is.
    expect(WIKI_DOCS_BUILD_JOB.priority).toBeGreaterThan(WIKI_ARTICLES_JOB.priority);
    // Every call is the documents' to wait for and to run: their wait limit, and their call budget.
    for (const step of Object.values(WIKI_DOCS_BUILD_JOB.steps)) {
      expect(wikiModelWaitLimitSeconds(step)).toBe(WIKI_MODEL_QUEUE.waitLimitSeconds.docs);
      expect(wikiModelCallBudgetSeconds(step)).toBe(WIKI_MODEL_QUEUE.callBudgetSeconds.docs);
    }
    // A job of its own kind, which the worker runs; the plan job is how the plan page sees it.
    expect(WIKI_JOB_KINDS).toContain(WIKI_DOCS_BUILD_JOB.kind);
    expect(CONTRACT.jobs.kindRuns.docs_build).toMatch(/docs\.build\.server/u);
    expect(CONTRACT.plan.jobs.server.build).toMatch(/`docs_build` wiki_job/u);
    expect(CONTRACT.docs.who.write).toMatch(/docs_build and maintain jobs/u);
    expect(CONTRACT.repoOps.waiting).toMatch(/docs\.build\.server\.repository/u);
    expect(server.repository).toMatch(/wholeFileBytes/u);
    expect(server.repository).toMatch(/boundedChars/u);
    // A whole file fits one item; a request is packed well under the API's body cap.
    expect(WIKI_REPO_OPS.wholeFileBytes).toBeLessThanOrEqual(WIKI_REPO_OPS.operationBytes);
    expect(WIKI_REPO_OPS.operationBytes).toBeLessThanOrEqual(WIKI_REPO_OPS.apiBodyBytes);
    // The runner's prompts and steps, held to the one fixture its Go test wrote.
    expect(server.calls).toContain('src/shared/src/wiki-docs-build.fixture.json');
    for (const file of ['src/shared/src/wiki-docs-build.fixture.json', 'src/apiserver/src/wiki-worker/wiki-docs-build-golden.spec.ts']) {
      expect(existsSync(path.join(ROOT, file)), `${file} does not exist`).toBe(true);
    }
  });

  it('drafts and revises the plan on the server, under the same rules (server execution P6)', () => {
    const server = CONTRACT.plan.jobs.server;
    // The job's numbers and words are the shared constants the worker and the trigger run by.
    expect(server.kinds).toEqual({ ...WIKI_PLAN_SERVER_JOB.kinds });
    expect(server.priority).toBe(WIKI_PLAN_SERVER_JOB.priority);
    expect([server.maxTokens, server.formatTries, server.concurrency])
      .toEqual([WIKI_PLAN_SERVER_JOB.maxTokens, WIKI_PLAN_SERVER_JOB.formatTries, WIKI_PLAN_SERVER_JOB.concurrency]);
    expect([server.snapshotWaitSeconds, server.readWaitSeconds]).toEqual([WIKI_PLAN_SERVER_JOB.snapshotWaitSeconds, WIKI_PLAN_SERVER_JOB.readWaitSeconds]);
    expect(server.systemPrompt).toBe(WIKI_PLAN_SERVER_JOB.systemPrompt);
    expect(server.materialCaps).toEqual(JSON.parse(JSON.stringify(WIKI_PLAN_SERVER_JOB.materialCaps)));
    expect(server.steps).toEqual({ ...WIKI_PLAN_SERVER_JOB.steps });
    // The runner's numbers: 32,000 tokens a call; the structure 26–32k, the documents' tree 30–45k, the overview 8–14k.
    expect(WIKI_PLAN_SERVER_JOB.maxTokens).toBe(32_000);
    expect(WIKI_PLAN_SERVER_JOB.materialCaps.layout).toEqual({ full: 32_000, detail: 26_000 });
    expect(WIKI_PLAN_SERVER_JOB.materialCaps.docsTree).toEqual({ full: 45_000, detail: 30_000 });
    expect(WIKI_PLAN_SERVER_JOB.materialCaps.overview).toEqual({ full: 14_000, detail: 10_000, doc: 8_000 });
    // Every call is the plan's to wait for and to run: twenty minutes queued at most, sixty running.
    for (const step of Object.values(WIKI_PLAN_SERVER_JOB.steps)) {
      expect(step).toMatch(/^plan_[a-z_]+$/u);
      expect(wikiModelWaitLimitSeconds(step)).toBe(WIKI_MODEL_QUEUE.waitLimitSeconds.plan);
      expect(wikiModelCallBudgetSeconds(step)).toBe(WIKI_MODEL_QUEUE.callBudgetSeconds.plan);
    }
    expect(WIKI_MODEL_QUEUE.callBudgetSeconds.plan).toBe(3600);
    // Two kinds of job, which the worker runs; owner-initiated, above background maintenance.
    for (const kind of Object.values(WIKI_PLAN_SERVER_JOB.kinds)) {
      expect(WIKI_JOB_KINDS).toContain(kind);
      expect(CONTRACT.jobs.kindRuns[kind]).toMatch(/plan\.jobs\.server/u);
    }
    expect(WIKI_PLAN_SERVER_JOB.priority).toBeGreaterThan(0);
    expect(CONTRACT.jobs.make).toMatch(/since P6 a plan job is made as a `plan_draft` or `plan_revise` job/u);
    // A build is the documents' pipeline, the server's since P7.
    expect(server.build).toMatch(/docs\.build\.server/u);
    // A replay drafts from what its first run read, and one fixture holds the server's drafting to the runner's answers.
    expect(server.materials).toMatch(/wiki_plan_job\.materials/u);
    for (const file of [server.migration, 'src/shared/src/wiki-plan.fixture.json', 'src/runner-go/wiki_plan_fixture_test.go',
      'src/apiserver/src/wiki-worker/wiki-plan-golden.spec.ts']) {
      expect(existsSync(path.join(ROOT, file)), `${file} does not exist`).toBe(true);
    }
    expect(server.deterministic).toContain('src/shared/src/wiki-plan.fixture.json');
    const sql = readFileSync(path.join(ROOT, server.migration), 'utf8').replace(/\s+/gu, ' ');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "author_job_id" UUID');
    expect(sql).toContain('("author_session_id" IS NOT NULL) <> ("author_job_id" IS NOT NULL)');
    expect(sql).toContain('("state" IN (\'made\', \'ended\')) = ("task_id" IS NOT NULL OR "job_id" IS NOT NULL)');
  });

  it('calls the System model from the wiki-worker alone, and reads back its name and state only (server execution P1a)', () => {
    const model = CONTRACT.systemModel;
    for (const file of [model.service.entry, model.status.migration]) {
      expect(existsSync(path.join(ROOT, file)), `${file} does not exist`).toBe(true);
    }
    // The worker's four variables, and none of them a name an agent session's environment carries.
    expect(model.env).toEqual({ ...WIKI_SYSTEM_MODEL_ENV });
    for (const name of Object.values(WIKI_SYSTEM_MODEL_ENV)) expect(name).toMatch(/^ORBIT_WIKI_MODEL(_[A-Z]+)*$/u);
    expect(model.envRules.defaultConcurrency).toBe(WIKI_SYSTEM_MODEL.defaultConcurrency);
    // A call: the Messages API, streamed, the version pinned, the key as a Bearer, five events read.
    expect(model.request.route).toBe(`POST {baseUrl}${WIKI_SYSTEM_MODEL.messagesPath}`);
    expect(model.request.headers).toEqual({
      authorization: 'Bearer {apiKey}',
      'anthropic-version': WIKI_SYSTEM_MODEL.anthropicVersion,
      'content-type': 'application/json',
    });
    expect(model.request.body).toMatch(/stream: true/u);
    expect(model.request.body).toMatch(/no tools/u);
    expect(model.request.events).toEqual(['message_start', 'content_block_delta', 'message_delta', 'message_stop', 'error']);
    expect(model.request.idleTimeoutSeconds).toBe(WIKI_SYSTEM_MODEL.idleTimeoutSeconds);
    expect(keysOf(model.request.errors)).toEqual([...WIKI_SYSTEM_MODEL_ERROR_KINDS]);
    // The probe.
    expect(model.health.route).toBe(`GET {baseUrl}${WIKI_SYSTEM_MODEL.healthPath}`);
    expect(model.health.upStatuses).toEqual([...WIKI_SYSTEM_MODEL.healthUpStatuses]);
    expect(model.health.authFailedStatuses).toEqual([401]);
    expect(model.health.intervalSeconds).toBe(WIKI_SYSTEM_MODEL.probeIntervalSeconds);
    expect(model.health.timeoutSeconds).toBe(WIKI_SYSTEM_MODEL.probeTimeoutSeconds);
    // The one row, and the migration that makes it: every column, and the states as a CHECK.
    expect(model.status.states).toEqual([...WIKI_SYSTEM_MODEL_STATES]);
    expect(keysOf(model.status.meaning)).toEqual([...WIKI_SYSTEM_MODEL_STATES]);
    expect(model.status.workerStaleSeconds).toBe(WIKI_SYSTEM_MODEL.workerStaleSeconds);
    const sql = readFileSync(path.join(ROOT, model.status.migration), 'utf8');
    expect(sql).toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS "${model.status.table}"`, 'u'));
    for (const column of model.status.columns) expect(sql).toContain(`"${column}"`);
    expect(sql).toContain(`CHECK ("state" IN (${WIKI_SYSTEM_MODEL_STATES.map((state) => `'${state}'`).join(', ')}))`);
    expect(sql).toContain('CHECK ("id" = 1)');
    // The read: on the user door; the stored states and worker_not_running; its fields, and not the address or the key.
    expect(CONTRACT.agentSurface.doors.user.routes).toContain(model.read.route);
    expect(model.read.states).toEqual([...WIKI_SYSTEM_MODEL_READ_STATES]);
    const status: WikiSystemModelRead = {
      state: 'up', model: null, since: null, checkedAt: null, workerSeenAt: null, executor: { mode: 'runner', serverExecutes: false },
    };
    expect(model.read.fields).toEqual(Object.keys(status));
    expect(model.read.executor).toMatch(/jobs\.executor\.read/u);
    expect(model.read.never).toMatch(/address, its key, and last_error/u);
    // A heartbeat older than workerStaleSeconds, or none, is a worker that is not running.
    const now = new Date('2026-10-07T12:00:00.000Z');
    const ago = (seconds: number) => new Date(now.getTime() - seconds * 1000);
    expect(wikiWorkerRunning(ago(WIKI_SYSTEM_MODEL.workerStaleSeconds), now)).toBe(true);
    expect(wikiWorkerRunning(ago(WIKI_SYSTEM_MODEL.workerStaleSeconds + 1).toISOString(), now)).toBe(false);
    expect(wikiWorkerRunning(null, now)).toBe(false);
    // The metrics name the same states.
    expect(keysOf(model.metrics.series)).toEqual([
      'orbit_wiki_model_state',
      'orbit_wiki_worker_heartbeat_age_seconds',
      'orbit_wiki_model_calls_total',
      'orbit_wiki_model_call_duration_seconds',
    ]);
  });

  it('runs the maintenance pipeline on the server: the job, its numbers and its identity (server execution P8)', () => {
    // The run is the server's: a `maintain` wiki job, the System model, and the repository through `wiki_repo_op` alone.
    const server = CONTRACT.maintenance.job.server;
    expect(existsSync(path.join(ROOT, server.migration)), `${server.migration} does not exist`).toBe(true);
    const sql = readFileSync(path.join(ROOT, server.migration), 'utf8').replace(/\s+/gu, ' ');
    // One nullable `job_id` on a changeset, and one author column beside the session's on a proposal.
    expect(sql).toContain('ALTER TABLE "wiki_changeset" ADD COLUMN IF NOT EXISTS "job_id" UUID');
    expect(sql).toContain('ALTER TABLE "wiki_plan_proposal" ADD COLUMN IF NOT EXISTS "author_job_id" UUID');
    expect(sql).toContain('ALTER TABLE "wiki_plan_proposal" ALTER COLUMN "author_session_id" DROP NOT NULL');
    expect(sql).toContain('("author_session_id" IS NULL) <> ("author_job_id" IS NULL)');
    // The numbers are the runner's, kept in one place: WIKI_MAINTAIN_JOB, held to this block.
    expect(server.rules.kind).toBe(WIKI_MAINTAIN_JOB.kind);
    expect(server.rules.priority).toMatch(/^0:/u);
    expect(server.rules.steps).toEqual(WIKI_MAINTAIN_JOB.steps);
    expect(server.rules.extractMaxTokens).toBe(WIKI_MAINTAIN_JOB.extractMaxTokens);
    expect(server.rules.planMaxTokens).toBe(WIKI_MAINTAIN_JOB.planMaxTokens);
    expect(server.rules.pageSessions).toBe(WIKI_MAINTAIN_JOB.pageSessions);
    expect(server.rules.opsPerChangeset).toBe(WIKI_MAINTAIN_JOB.opsPerChangeset);
    expect(server.rules.opsPerTurn).toBe(WIKI_MAINTAIN_JOB.opsPerTurn);
    expect(server.rules.quoteMaxChars).toBe(WIKI_MAINTAIN_JOB.quoteMaxChars);
    expect(server.rules.aboutMaxChars).toBe(WIKI_MAINTAIN_JOB.aboutMaxChars);
    expect(server.rules.proposalRoundsMax).toBe(WIKI_MAINTAIN_JOB.proposalRoundsMax);
    expect(server.rules.proposalItemsMax).toBe(WIKI_MAINTAIN_JOB.proposalItemsMax);
    expect(server.rules.repoWaitSeconds).toBe(WIKI_MAINTAIN_JOB.repoWaitSeconds);
    expect(server.rules.anchorDiffsMax).toBe(WIKI_MAINTAIN_JOB.anchorDiffsMax);
    expect(server.rules.docsExcluded).toEqual([...WIKI_MAINTAIN_JOB.docsExcluded]);
    // The batch sizes are the contract's own limits, and the entry cap the maintenance job's.
    expect(WIKI_MAINTAIN_JOB.opsPerChangeset).toBe(WIKI_LIMITS.opsPerChangeset);
    expect(WIKI_MAINTAIN_JOB.opsPerTurn).toBe(WIKI_LIMITS.opsPerTurn);
    expect(WIKI_MAINTAIN_JOB.extractMaxTokens).toBeLessThanOrEqual(WIKI_MAINTAIN_JOB.planMaxTokens);
    // The pipeline the kind runs is stated, and no provider is in it.
    expect(CONTRACT.jobs.kindRuns.maintain).toMatch(/maintenance\.job\.server/u);
    expect(server.trigger).toMatch(/MaintenanceJobWriter/u);
    // A run's end that queued the articles asks for the next round at once (2026-10-10): its own job set aside.
    expect(server.trigger).toMatch(/A run's end asks too \(the owner's decision of 2026-10-10/u);
    expect(server.identity).toMatch(/wiki_changeset\.job_id/u);
    // The run's own ops are its job's, whichever attempt recorded them, and the second pass asks under units of its own
    // (2026-10-10): a replay verifies what a stop left waiting, and the retry suffix reaches the model.
    expect(server.verify).toMatch(/^The run's own ops are its job's \(identity\), whichever attempt recorded them/u);
    expect(server.verify).toMatch(/under a unit of its own, <opId>#retry, as the extraction's retry is asked under <sessionId>#retry/u);
    expect(server.verify).toMatch(/Its prompt is the second pass's: the op's prompt as the list reads it now, with wikiVerifyRetrySuffix when the first answer was no verdict/u);
    // What both passes leave without a verdict is the space's next server run's to adopt once the job has ended (2026-10-11),
    // where no later run used to take it up.
    expect(server.verify).toMatch(/once the job has ended the space's next server run adopts it \(reviewModes\.verification\.adoption\.who\)/u);
    expect(server.verify).not.toMatch(/adoption takes no ended job's ops/u);
    expect(server.identity).toMatch(/the space's next run adopts what it left waiting through it once the job has ended/u);
    expect(server.skip).toMatch(/catch-up active or paused/u);
    expect(server.failureKinds).toMatch(/nothing is counted/u);
    // The database failing under the run is the platform's (2026-10-17): a P2028 at the anchors step failed the canary's
    // runs 6e62f826 and 34cadf93 as content, where it is retried and counted against nothing.
    expect(server.failureKinds).toMatch(/^infra: [^]*the database failing under the run — a transaction it could not start in time or that its timeout closed \(P2028\), no connection in time \(P2024\)[^]*\. The run is not ended and nothing is counted[^]* content: /u);
    expect(readFileSync(path.join(ROOT, 'docs/wiki-contract.md'), 'utf8')).toContain('事务没能按时开始、或被自己的超时关掉（P2028），按时拿不到连接（P2024）');
  });

  it('runs wiki jobs on the server: the table, the kinds, the lease, the retry and the executor (server execution P1b)', () => {
    const jobs = CONTRACT.jobs;
    expect(existsSync(path.join(ROOT, jobs.migration)), `${jobs.migration} does not exist`).toBe(true);
    const sql = readFileSync(path.join(ROOT, jobs.migration), 'utf8').replace(/\s+/gu, ' ');
    expect(sql).toContain(`CREATE TABLE IF NOT EXISTS "${jobs.table}"`);
    for (const column of jobs.columns) expect(sql).toContain(`"${column}"`);
    expect(jobs.kinds).toEqual([...WIKI_JOB_KINDS]);
    expect(jobs.states).toEqual([...WIKI_JOB_STATES]);
    expect(jobs.waitingFor).toEqual([...WIKI_JOB_WAITING_FOR]);
    expect(jobs.failureKinds).toEqual([...WIKI_JOB_FAILURE_KINDS]);
    for (const kind of Object.keys(jobs.kindRuns)) expect(jobs.kinds).toContain(kind);
    expect(jobs.lease.seconds).toBe(WIKI_JOB.leaseSeconds);
    expect(jobs.lease.renewSeconds).toBe(WIKI_JOB.renewSeconds);
    expect(jobs.retry.backoffSeconds).toEqual([...WIKI_JOB.retryBackoffSeconds]);
    // The retry limit (2026-10-09): no job is put back for ever, and an unexpected error gets the smaller limit.
    expect(jobs.retry.maxAttempts).toBe(WIKI_JOB.maxAttempts);
    expect(jobs.retry.unexpectedMaxAttempts).toBe(WIKI_JOB.unexpectedMaxAttempts);
    expect(WIKI_JOB.unexpectedMaxAttempts).toBeLessThan(WIKI_JOB.maxAttempts);
    expect(jobs.retry.limit).toMatch(/settleWikiJobRows/u);
    expect(jobs.lease.claim).toContain('attempts < retry.maxAttempts');
    // Maintenance first, an articles job yields one round at most (2026-10-10): a space's own order, no priority moved.
    expect(jobs.priority).toMatch(/an articles job yields one round at most \(the owner's decision of 2026-10-10\)/u);
    expect(WIKI_ARTICLES_JOB.priority).toBe(WIKI_MAINTAIN_JOB.priority);
    expect(jobs.concurrencyPerWorker).toBe(WIKI_JOB.maxConcurrentPerWorker);
    expect(jobs.pollSeconds).toBe(WIKI_JOB.pollSeconds);
    // The one-job-per-space rule is the claim's and the database's: a partial unique index over space_id.
    expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "wiki_job_space_running_key" ON "wiki_job" ("space_id") WHERE "state" = \'running\'');
    // The maker columns and the CHECKs that require exactly one of the two, per started row.
    expect(sql).toContain('ALTER TABLE "wiki_maintenance_run" ALTER COLUMN "task_id" DROP NOT NULL');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "job_id" UUID');
    expect(sql).toContain('("task_id" IS NOT NULL) <> ("job_id" IS NOT NULL)');
    expect(jobs.runRows.count).toMatch(/count the run rows the space's maintain jobs made since midnight UTC/u);
    // No switch: the server executes every account, and nothing of the switch is left but the modes a read may name.
    expect(jobs.executor.removed).toMatch(/the server executes every account's wiki, and there is no switch/u);
    for (const key of ['env', 'default', 'rules', 'mistyped', 'rollback']) expect(jobs.executor, key).not.toHaveProperty(key);
    expect(jobs.executor.modes).toEqual([...WIKI_EXECUTOR_MODES]);
    // What a read tells the account that asks: the mode and whether the server executes its wiki — for every account, the server.
    const view: WikiExecutorView = { mode: 'canary', serverExecutes: true };
    expect(jobs.executor.read.fields).toEqual(Object.keys(view));
    expect(WIKI_EXECUTOR_READ).toEqual({ mode: 'server', serverExecutes: true });
    expect(jobs.executor.read.rule).toContain(`{ mode: ${WIKI_EXECUTOR_READ.mode}, serverExecutes: ${WIKI_EXECUTOR_READ.serverExecutes} }, the same for every account since P11`);
  });

  it('reports the whole job, its hand-backs and replays included: what a replay carries, kind by kind (2026-10-10)', () => {
    const carry = CONTRACT.jobs.carry;
    // Where a running attempt keeps what it finished: the job's own report, which no read shows before the end.
    expect(CONTRACT.jobs.columns).toContain('report');
    expect(carry.where).toMatch(/^wiki_job\.report, as \{ carry \}, while the job has not ended/u);
    expect(carry.where).toMatch(/Activity's jobs read reads no report at all \(read\.never\)/u);
    expect(CONTRACT.jobs.read.never).toMatch(/the job's input and report/u);
    // Every kind says what its replay is carried, or why nothing needs to be.
    expect(keysOf(carry.kinds).sort()).toEqual([...WIKI_JOB_KINDS].sort());
    for (const kind of ['import', 'plan_draft', 'plan_revise', 'smoke']) expect(carry.kinds[kind]).toMatch(/^Nothing/u);
    for (const kind of ['articles', 'verify', 'docs_build', 'maintain']) expect(carry.kinds[kind]).not.toMatch(/^Nothing/u);
    // Only finished work is carried, so a job ends and writes as it would have; the report alone changes.
    expect(carry.rule).toMatch(/only finished work is carried, so a job ends as it would have and writes what it would have/u);
    expect(carry.write).toMatch(/a compare-and-set on the claim's generation/u);
    expect(carry.write).toMatch(/The job's end writes the report over it/u);
    expect(CONTRACT.jobs.progress).toMatch(/until then holds only what its attempts carry to a replay \(carry\)/u);
    expect(CONTRACT.jobs.lease.handBack).toMatch(/is on its row already \(carry\)/u);
    // The calls and usage are the job's own requests, each once; a call failed on its wait limit is none.
    expect(carry.calls).toMatch(/each once \(wikiJobModelCalls\)/u);
    expect(carry.calls).toMatch(/never one failed on its step's wait limit/u);
    expect(carry.calls).toMatch(/Since it asks under units of its own \(maintenance\.job\.server\.verify\), its requests are calls like any other/u);
    // The pipelines that say what their report is say it is the whole job's.
    expect(CONTRACT.articles.serverExecution.ends).toMatch(/Its report is the whole job's \(jobs\.carry\)/u);
    expect(CONTRACT.docs.build.server.end).toMatch(/are the whole build's \(jobs\.carry\)/u);
    // A replay on the same commit leaves alone what an earlier attempt of the run checked, and the report counts it the run's.
    expect(CONTRACT.maintenance.job.server.anchors).toMatch(/An entry an earlier attempt of the run checked, which a replay on the same commit leaves alone, is the run's and counted in them, not in skipped/u);
    expect(CONTRACT.maintenance.job.server.anchors).toMatch(/so a second run on the commit an earlier run checked reports entries 0/u);
    expect(carry.articlesAfterRun).toMatch(/of the whole run's report/u);
  });

  it('reads a space\'s server runs and their calls for Activity, their metadata alone (server execution P9)', () => {
    const read = CONTRACT.jobs.read;
    expect(CONTRACT.agentSurface.doors.user.routes).toContain(read.route);
    expect(read.route).toBe('GET /api/wiki/spaces/:id/jobs');
    expect(read.limits).toEqual({ ...WIKI_JOBS_READ });
    const job: WikiJobView = {
      id: '', kind: 'verify', state: 'queued', waitingFor: null, priority: 0, attempts: 0, createdAt: '', updatedAt: '',
      startedAt: null, endedAt: null, nextAttemptAt: null, failureKind: null, error: null, ahead: null, progress: null,
      calls: { total: 0, queued: 0, running: 0, succeeded: 0, failed: 0, cancelled: 0, inputTokens: 0, outputTokens: 0 },
      nextCall: null, requests: [],
    };
    expect(read.job).toEqual(Object.keys(job));
    expect(keysOf(read.jobRules)).toEqual(['ahead', 'progress', 'calls', 'nextCall', 'requests']);
    const call: WikiJobCallView = {
      id: '', step: '', unit: '', attempt: 1, attempts: 0, state: 'queued', enqueuedAt: '', startedAt: null, endedAt: null,
      inputTokens: null, outputTokens: null, httpStatus: null, error: null, errorKind: null, ahead: null,
    };
    expect(read.request).toEqual(Object.keys(call));
    // The call log is metadata: none of the columns that carry the call or its answer is read out.
    for (const column of ['request', 'request_sha256', 'answer', 'partial', 'lease_owner', 'lease_generation']) {
      expect(CONTRACT.modelQueue.columns).toContain(column);
    }
    for (const field of ['request', 'answer', 'partial', 'system', 'prompt']) expect(read.request).not.toContain(field);
    expect(read.never).toMatch(/system prompt, prompt, max_tokens\), its request_sha256, answer and partial/u);
    expect(read.never).toMatch(/address or key/u);
    expect(read.requestRules.ahead).toMatch(/priority DESC, enqueued_at, id/u);
    expect(read.jobRules.ahead).toMatch(/priority DESC, created_at, id/u);
  });

  it('queues every model call: the identity, the claim, the lease, the retry and the limits (server execution P1b)', () => {
    const queue = CONTRACT.modelQueue;
    expect(existsSync(path.join(ROOT, queue.migration)), `${queue.migration} does not exist`).toBe(true);
    const sql = readFileSync(path.join(ROOT, queue.migration), 'utf8').replace(/\s+/gu, ' ');
    expect(sql).toContain(`CREATE TABLE IF NOT EXISTS "${queue.table}"`);
    for (const column of queue.columns) expect(sql).toContain(`"${column}"`);
    expect(queue.identity).toMatch(/\(job_id, step, unit, attempt\) is unique/u);
    // A call whose text has a U+0000 is kept as its bytes (repoOps.storedText), and the digest stays the call's; so is
    // an answer or a partial, in the columns the stored-text migration adds; and what a job writes out of an answer
    // goes to the shared writer without one, as the runner gate's strip-nul does.
    expect(queue.requestEncoding).toMatch(/`encoding: "base64"`/u);
    expect(queue.requestEncoding).toMatch(/`request_sha256` is the call's/u);
    expect(queue.answerEncoding).toMatch(/`answer_encoding` \/ `partial_encoding`/u);
    const stored = readFileSync(path.join(ROOT, CONTRACT.repoOps.storedText.migration), 'utf8');
    for (const column of ['answer_encoding', 'partial_encoding']) expect(stored).toContain(`ADD COLUMN IF NOT EXISTS "${column}" TEXT NOT NULL DEFAULT 'text'`);
    expect(CONTRACT.jobs.serverWrites).toMatch(/src\/apiserver\/src\/runner-api\/strip-nul\.ts/u);
    expect(existsSync(path.join(ROOT, 'src/apiserver/src/runner-api/strip-nul.ts'))).toBe(true);
    expect(sql).toContain('CONSTRAINT "wiki_model_request_unit_key" UNIQUE ("job_id", "step", "unit", "attempt")');
    // The claim's order and its lock are the statement's, in the worker; the queue's sets and numbers are here.
    expect(queue.states).toEqual([...WIKI_MODEL_REQUEST_STATES]);
    expect(queue.concurrency.env).toBe(WIKI_SYSTEM_MODEL_ENV.concurrency);
    expect(queue.concurrency.default).toBe(WIKI_SYSTEM_MODEL.defaultConcurrency);
    expect(queue.concurrency.claim).toMatch(/pg_advisory_xact_lock/u);
    expect(queue.concurrency.claim).toMatch(/FOR UPDATE SKIP LOCKED/u);
    expect(queue.concurrency.perJob).toBe(WIKI_MODEL_QUEUE.maxInFlightPerJob);
    expect(queue.lease.seconds).toBe(WIKI_MODEL_QUEUE.leaseSeconds);
    expect(queue.lease.renewSeconds).toBe(WIKI_MODEL_QUEUE.renewSeconds);
    expect(queue.lease.partialSeconds).toBe(WIKI_MODEL_QUEUE.partialSeconds);
    expect(queue.retry.backoffSeconds).toEqual([...WIKI_MODEL_QUEUE.retryBackoffSeconds]);
    expect(queue.waitLimit.defaultSeconds).toBe(WIKI_MODEL_QUEUE.defaultWaitLimitSeconds);
    expect(queue.waitLimit.byStep).toEqual({ ...WIKI_MODEL_QUEUE.waitLimitSeconds });
    expect(queue.callBudget.defaultSeconds).toBe(WIKI_MODEL_QUEUE.defaultCallBudgetSeconds);
    expect(queue.callBudget.byStep).toEqual({ ...WIKI_MODEL_QUEUE.callBudgetSeconds });
    // The limits a step is looked up by, as the worker's own helpers read them.
    for (const [key, seconds] of Object.entries(WIKI_MODEL_QUEUE.waitLimitSeconds)) {
      expect(wikiModelWaitLimitSeconds(key)).toBe(seconds);
      expect(wikiModelWaitLimitSeconds(`${key}_draft`)).toBe(seconds);
    }
    expect(wikiModelWaitLimitSeconds('verify')).toBe(WIKI_MODEL_QUEUE.defaultWaitLimitSeconds);
    for (const [key, seconds] of Object.entries(WIKI_MODEL_QUEUE.callBudgetSeconds)) {
      expect(wikiModelCallBudgetSeconds(key)).toBe(seconds);
      expect(wikiModelCallBudgetSeconds(`${key}_draft`)).toBe(seconds);
    }
    expect(wikiModelCallBudgetSeconds('verify')).toBe(WIKI_MODEL_QUEUE.defaultCallBudgetSeconds);
    // The retry schedule, as both the queue and the job read it.
    expect([0, 1, 2, 9].map((attempts) => wikiModelRetryDelaySeconds(attempts))).toEqual([0, 10, 30, 30]);
    expect([0, 1, 2, 9].map((attempts) => wikiJobRetryDelaySeconds(attempts))).toEqual([0, 10, 30, 30]);
    // The pause, the shutdown and the wake-up are stated, and the metrics name the queue's series.
    expect(queue.pause.when).toMatch(/not up/u);
    expect(queue.shutdown.plan).toMatch(/^A, the owner's decision of 2026-10-07/u);
    expect(queue.notify.channel).toBe('wiki_model_request');
    expect(keysOf(queue.metrics.series)).toEqual([
      'orbit_wiki_model_calls_total',
      'orbit_wiki_model_call_duration_seconds',
      'orbit_wiki_model_queue_depth',
      'orbit_wiki_model_requests_in_flight',
      'orbit_wiki_model_request_wait_seconds',
      'orbit_wiki_model_request_run_seconds',
      'orbit_wiki_model_request_tokens_total',
      'orbit_wiki_model_request_errors_total',
    ]);
  });
});
