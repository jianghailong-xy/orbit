import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
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
  WIKI_MAINTENANCE_LIST_TITLE,
  WIKI_MAINTENANCE_RULES,
  WIKI_MAINTENANCE_RUN,
  WIKI_MAINTENANCE_RUN_V1,
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
  WIKI_DEFAULT_TOPICS,
  wikiArticleChars,
  type WikiArticleView,
} from './wikiArticles';
import {
  WIKI_MAINTENANCE_DUE,
  WIKI_MAINTENANCE_HELD_REASONS,
  WIKI_MAINTENANCE_JOB,
  wikiMaintenanceCheckCommand,
  wikiMaintenanceRunSessions,
} from './wikiMaintain';
import { WIKI_MAINTENANCE_HEALTH, WIKI_MAINTENANCE_LOOKS, wikiMaintenanceLook } from './wikiHealth';

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
      ...CONTRACT.agentSurface.doors.runner.maintenanceRoutes,
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
    // The verifier's own call thinks only when asked to.
    expect(CONTRACT.agentSurface.verify.thinking).toMatch(/CLAUDE_CODE_EFFORT_LEVEL=unset and MAX_THINKING_TOKENS=0/u);
    expect(CONTRACT.agentSurface.verify.cleanClaudeCode).not.toMatch(/CLAUDE_CODE_EFFORT_LEVEL/u);
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
    // The verifier reports only for the session that proposed, over the runner door.
    const runner = CONTRACT.agentSurface.doors.runner;
    expect(runner.verificationRoutes).toEqual([verification.routes.list, verification.routes.report]);
    expect(CONTRACT.agentSurface.verify.cli).toBe('orbit wiki verify');
    expect(CONTRACT.agentSurface.verify.cleanClaudeCode).toMatch(/--bare --tools "" --strict-mcp-config/u);
    expect(CONTRACT.agentSurface.verify.unreadable).toMatch(/is not a verdict/u);
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
      .toEqual({ enabled: true, workspaceId: 'w', provider: 'local-vllm', dailyRunLimit: 5, listId: 'l' });
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

    const maintenance = CONTRACT.maintenance;
    expect(maintenance.rules).toEqual(WIKI_MAINTENANCE_RULES);
    // The demo's numbers: 8k a session recalled more than 16k; twenty sessions or a day makes a run due.
    expect(WIKI_MAINTENANCE_RULES.dossierMaxTokens).toBe(8_000);
    expect(WIKI_MAINTENANCE_RULES.errorClusterMinSessions).toBe(3);
    expect(WIKI_MAINTENANCE_RULES.backlogThreshold).toBe(20);
    expect(WIKI_MAINTENANCE_RULES.maxPendingAgeHours).toBe(24);
    expect(maintenance.list.title).toBe(WIKI_MAINTENANCE_LIST_TITLE);
    expect(maintenance.list.hidden).toBe(true);
    expect(keysOf(maintenance.cursor.factKinds)).toEqual([...WIKI_CURSOR_FACT_KINDS]);
    expect(maintenance.cursor.advance.outcomes).toEqual([...WIKI_CURSOR_OUTCOMES]);
    // Both maintenance routes this side serves are the runner door's maintenance routes.
    const routes: string[] = CONTRACT.agentSurface.doors.runner.maintenanceRoutes;
    expect(routes).toContain(maintenance.dossier.route);
    expect(routes).toContain(maintenance.cursor.advance.route);
    // The refusals the cursor answers are declared, with their statuses.
    const status = (code: string) => CONTRACT.refusals.find((r: { code: string }) => r.code === code)?.httpStatus;
    expect(status('WIKI_CURSOR_BEHIND')).toBe(409);
    expect(status('WIKI_CURSOR_INVALID')).toBe(400);
    expect(status('WIKI_NOT_MAINTENANCE_SESSION')).toBe(403);
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

  it('ships the maintenance job the contract states: its trigger, its task, its run and its check', () => {
    // Criterion 3: a committed fact makes the task, its run proposes as maintenance, and its check judges it.
    const job = CONTRACT.maintenance.job;
    expect(job.rules).toEqual(WIKI_MAINTENANCE_JOB);
    // The demo's A2+6: at most six entries from one 8k dossier, and never more than twenty sessions a run.
    expect(WIKI_MAINTENANCE_JOB.entriesPerSessionMax).toBe(6);
    expect(WIKI_MAINTENANCE_JOB.runSessionsMax).toBe(WIKI_MAINTENANCE_RULES.backlogThreshold);
    expect(job.trigger.due).toEqual([...WIKI_MAINTENANCE_DUE]);
    expect(job.held.reasons).toEqual([...WIKI_MAINTENANCE_HELD_REASONS]);
    for (const reason of WIKI_MAINTENANCE_HELD_REASONS) expect(job.held[reason]).toBeTruthy();
    // The due threshold counts sessions (design §8.2's «20 个会话»), and no clock starts a task.
    expect(CONTRACT.maintenance.cursor.due).toMatch(/sessions have a fact after the watermark/u);
    expect(job.trigger.conditions).toMatch(/No clock starts a task/u);
    // The task's one criterion is the check, in exactly the shape the server writes it.
    expect(job.task.completionCriterion).toBe('EXECUTABLE');
    expect(job.task.acceptanceCommand).toBe(wikiMaintenanceCheckCommand('<id>', '<token>'));
    expect(job.task.acceptanceExpectedExitCode).toBe(0);
    expect(job.cli.check).toMatch(/^orbit wiki check --space <id> --expect-cursor <token>/u);
    expect(job.cli.maintain).toMatch(/^orbit wiki maintain --space <id>/u);
    // Every route of the job is a runner-door maintenance route.
    const routes: string[] = CONTRACT.agentSurface.doors.runner.maintenanceRoutes;
    for (const route of Object.values(job.routes) as string[]) expect(routes).toContain(route);
    expect(job.check.route).toBe(job.routes.check);
    expect(CONTRACT.maintenance.dossier.query.until).toMatch(/does not go past/u);
    expect(job.tables).toEqual(['wiki_maintenance_run']);
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

  it('reads a space\'s health the way the contract states it, and tells the owner once a streak', () => {
    // Criterion 5: the Wiki home's status line reads the space's entries and its maintenance run's health.
    const health = CONTRACT.maintenance.health;
    expect(health.criterion).toBe(5);
    expect(CONTRACT.agentSurface.doors.user.routes).toContain(health.route);
    expect(health.route).toBe('GET /api/wiki/spaces/:id/health');
    expect(health.looks).toEqual([...WIKI_MAINTENANCE_LOOKS]);
    expect(keysOf(health.maintenance)).toEqual([
      'enabled', 'look', 'lastOkAt', 'lastRunAt', 'consecutiveFailures', 'backlog', 'oldestPendingAt', 'lagSeconds',
      'dailyLimitReached', 'held', 'running', 'lastRun',
    ]);
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

  it('ships the run a maintenance session is claimed with, as the contract states it', () => {
    // Design §8.2's guardrails, which the claim writes into every maintenance session's agent config.
    const run = CONTRACT.maintenance.run;
    expect(run.maxTurns).toBe(WIKI_MAINTENANCE_RUN.maxTurns);
    expect(WIKI_MAINTENANCE_RUN.maxTurns).toBe(120);
    expect(run.disallowedTools).toEqual([...WIKI_MAINTENANCE_RUN.disallowedTools]);
    expect([...WIKI_MAINTENANCE_RUN.disallowedTools]).toEqual(['Task', 'Agent', 'WebFetch', 'WebSearch']);
    expect(run.permissionMode).toBe(WIKI_MAINTENANCE_RUN.permissionMode);
    expect(run.runtime).toBe(WIKI_MAINTENANCE_RUN.runtime);
    expect(run.providerFallbacks).toEqual([]);
    // Only a runner that declares the capability is handed one; the runner side pins the same string.
    expect(run.capability).toBe(WIKI_MAINTENANCE_RUN_V1);
    // The clean start is the runner's; what the server promises of it is the shape of the field it sends.
    expect(run.field).toMatch(/providerFallbacks, maxTurns, disallowedTools, cleanStart, refusal\?/u);
    expect(run.cleanStart.flags).toEqual(expect.arrayContaining(['--bare', '--strict-mcp-config', '--max-turns 120']));
    expect(run.cleanStart.thinking).toMatch(/CLAUDE_CODE_EFFORT_LEVEL=unset and MAX_THINKING_TOKENS=0/u);
    expect(run.cleanStart.auth).toMatch(/apiKeyHelper/u);
  });

  it('re-verifies the anchors git can check, on the routes and by the rules the contract states', () => {
    // Criterion 4: a maintenance run re-verifies paths, symbols and commits on origin/main.
    const verify = CONTRACT.anchorRules.verify;
    expect(verify.types).toEqual([...WIKI_GIT_ANCHOR_TYPES]);
    for (const type of WIKI_GIT_ANCHOR_TYPES) expect(keysOf(CONTRACT.anchorTypes)).toContain(type);
    expect(verify.rules).toEqual(WIKI_ANCHOR_RULES);
    expect(WIKI_ANCHOR_RULES.symbolRegionLines).toBe(20);
    expect(WIKI_ANCHOR_RULES.reportEntriesMax).toBeLessThanOrEqual(WIKI_ANCHOR_RULES.listEntriesMax);
    // Both routes are the runner door's maintenance routes: no other session reaches them.
    const routes: string[] = CONTRACT.agentSurface.doors.runner.maintenanceRoutes;
    expect(routes).toContain(verify.list.route);
    expect(routes).toContain(verify.report.route);
    expect(verify.who).toMatch(/WIKI_NOT_MAINTENANCE_SESSION/u);
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

    // Its doors: the owner's three reads on the user door, a maintenance run's three routes on the runner door.
    const routes = articles.routes;
    const user: string[] = CONTRACT.agentSurface.doors.user.routes;
    const maintenanceRoutes: string[] = CONTRACT.agentSurface.doors.runner.maintenanceRoutes;
    for (const read of [routes.directory, routes.article, routes.part, routes.index]) expect(user).toContain(read);
    for (const write of [routes.plan, routes.input, routes.write]) expect(maintenanceRoutes).toContain(write);
    expect(user.some((route) => route.startsWith('POST') && route.includes('/articles'))).toBe(false);
    // A view: never a source, never pushed, never an agent's answer.
    expect(CONTRACT.sourceRules.firstHand).toMatch(/topic summary or any other view is never a source/u);
    expect(articles.view.push).toMatch(/Never in <orbit_wiki_context>/u);
    expect(articles.view.agents).toMatch(/wiki_search or wiki_get/u);
    expect(articles.who.write).toMatch(/isWikiMaintenanceSession/u);
    const status = (code: string) => CONTRACT.refusals.find((r: { code: string }) => r.code === code)?.httpStatus;
    expect(status('WIKI_ARTICLE_STALE')).toBe(409);
    expect(CONTRACT.realtime.publishedWhen.some((when: string) => /articles were written/u.test(when))).toBe(true);
    expect(articles.cli.tool).toMatch(/^none/u);
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
    // Design §5.4's twelve are all here; anything more is marked as this contract's own addition.
    const design = [
      'WIKI_DISABLED', 'WIKI_SPACE_UNBOUND', 'WIKI_SCHEMA', 'WIKI_KIND_OWNER_ONLY', 'WIKI_SOURCE_UNRESOLVED',
      'WIKI_QUOTE_NOT_FOUND', 'WIKI_REVISION_CONFLICT', 'WIKI_QUOTA', 'WIKI_REVIEW_QUEUE_FULL', 'WIKI_PROBE_REFUSED',
      'WIKI_OWNER_CHANNEL_ONLY', 'WIKI_NOT_MAINTENANCE_SESSION',
    ];
    for (const code of design) expect(codes).toContain(code);
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
    const user: string[] = surface.doors.user.routes;
    const runner: string[] = [
      ...surface.doors.runner.routes,
      ...surface.doors.runner.maintenanceRoutes,
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
    // Its two routes are the runner door's, and neither decides anything.
    const runner = CONTRACT.agentSurface.doors.runner;
    expect(runner.importRoutes).toEqual([imports.note.route, imports.propose.route]);
    for (const route of runner.importRoutes) expect(route).toMatch(/^POST \/api\/runner\/wiki\/spaces\/:id\/(notes|imports)$/u);
    expect(imports.note.redaction).toMatch(/BEFORE anything is stored or hashed/u);
    // A CLI verb with no tool beside it, whose description leads with what its reader must not do.
    expect(imports.cli.command).toMatch(/^orbit wiki import --from <dir\|file> --space <id>/u);
    expect(imports.cli.tool).toMatch(/^none/u);
    expect(imports.cli.precondition).toMatch(/never write an entry yourself/u);
    expect(CONTRACT.agentSurface.tools).not.toContain('wiki_import');
  });
});
