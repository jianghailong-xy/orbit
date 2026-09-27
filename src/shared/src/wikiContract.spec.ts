import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  KIND_SPECS,
  WIKI_ANCHOR_SPECS,
  WIKI_ANCHOR_STATES,
  WIKI_ANCHOR_TYPES,
  WIKI_AUTHOR_KINDS,
  WIKI_CHANGESET_ORIGINS,
  WIKI_CHANGESET_STATUSES,
  WIKI_CONTRACT_VERSION,
  WIKI_DECIDE_ACTIONS,
  WIKI_DEFAULT_SPACE_SETTINGS,
  WIKI_EFFECT_POLICY,
  WIKI_ENTRY_KINDS,
  WIKI_ENTRY_STATUSES,
  WIKI_EXPOSURE_CHANNELS,
  WIKI_KINDS,
  WIKI_LIMITS,
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
  WIKI_VERIFICATION_VERDICTS,
  validateWikiEntryDraft,
  validateWikiSources,
  wikiOpEffect,
  wikiReviewEffect,
  wikiSpaceSettings,
  wikiTieredBasis,
  wikiVerdictTrust,
} from './wiki';

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
        // The floors, in every mode: a tainted op, and a change to what the owner wrote or confirmed.
        expect(effect({ origin, mode, tainted: true }).effect, `${mode}: tainted`).toBe('pending');
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
    // The two owner actions are routes of the owner's door, and of no other.
    expect(CONTRACT.agentSurface.doors.user.routes).toContain(modes.revert.route);
    expect(CONTRACT.agentSurface.doors.user.routes).toContain(modes.entryReject.route);
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
    expect(edges).toEqual(['proposed->active', 'proposed->rejected', 'active->superseded', 'active->retired', 'active->rejected']);
    expect(keysOf(entry.born)).toEqual(entry.initial);
    // Only pending and verifying wait — for the owner, and for a verdict — and auto_applied is left only
    // by the owner's Reject of an add the review mode applied; every other decision is final, and the
    // three an op is recorded with are the initial ones.
    const op = CONTRACT.states.op;
    expect(op.values.filter((v: string) => !op.terminal.includes(v))).toEqual(['pending', 'auto_applied', 'verifying']);
    expect(op.transitions.filter((t: { from: string }) => t.from === 'auto_applied').map((t: { to: string }) => t.to)).toEqual(['rejected']);
    expect(op.initial).toEqual(['pending', 'auto_applied', 'verifying']);
    // Pushable trust is what the push reads, and proposed never is.
    expect(CONTRACT.trust.pushable).toEqual([...WIKI_PUSHABLE_TRUST]);
    expect(CONTRACT.push.eligible.trust).toEqual([...WIKI_PUSHABLE_TRUST]);
    expect(WIKI_PUSHABLE_TRUST).not.toContain('proposed');
    // What a review mode applies is pushed as auto, and never as unreviewed.
    expect(WIKI_PUSHABLE_TRUST).toContain('auto');
    expect(WIKI_PUSHABLE_TRUST).not.toContain('unreviewed');
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
});
