/**
 * Orbit Wiki's wire vocabulary, and the schema of every kind of entry. Transcribed from
 * `contracts/wiki.contract.json`, which stays the authority — see `docs/wiki-contract.md`.
 * `wikiContract.spec.ts` holds every constant below to that file and runs the contract's vectors
 * through the validators here, so a change the contract did not make first goes red.
 *
 * The canonical store is the entry (`wiki_entry`, migration 0307). Pages, the decision log and the
 * agent's slice are views of entries; nothing here describes a page.
 */

export const WIKI_CONTRACT_VERSION = 1;

// ── Closed sets. Each is a CHECK constraint in 0307, admitting exactly these values. ─────────────

/** The kinds a phase-1 door writes. */
export const WIKI_KINDS = ['principle', 'convention', 'decision', 'pitfall', 'recipe', 'concept'] as const;
export type WikiKind = (typeof WIKI_KINDS)[number];

/** Kinds storage admits ahead of the phase that writes them. Every phase-1 door refuses them
 *  (`WIKI_SCHEMA` on `kind`), and none has a {@link KIND_SPECS} entry yet. */
export const WIKI_RESERVED_KINDS = ['assumption'] as const;
export type WikiReservedKind = (typeof WIKI_RESERVED_KINDS)[number];

/** Every kind a stored entry can carry. A client meeting one it has no view for shows it generically. */
export type WikiEntryKind = WikiKind | WikiReservedKind;
export const WIKI_ENTRY_KINDS: readonly WikiEntryKind[] = [...WIKI_KINDS, ...WIKI_RESERVED_KINDS];

/** proposed → active → superseded | retired; proposed → rejected; and an entry the review mode
 *  applied at once, active → rejected when the owner rejects it. The last three are terminal. */
export const WIKI_ENTRY_STATUSES = ['proposed', 'active', 'superseded', 'retired', 'rejected'] as const;
export type WikiEntryStatus = (typeof WIKI_ENTRY_STATUSES)[number];

/** `auto` and `unreviewed` are what a space's review mode leaves an entry it applied at once:
 *  `auto` is pushed, `unreviewed` is shown and never pushed (contract `reviewModes`). */
export const WIKI_TRUST_LEVELS = ['owner', 'confirmed', 'auto', 'unreviewed', 'proposed', 'external'] as const;
export type WikiTrust = (typeof WIKI_TRUST_LEVELS)[number];
/** Only these reach a session's `<orbit_wiki_context>`. */
export const WIKI_PUSHABLE_TRUST: readonly WikiTrust[] = ['owner', 'confirmed', 'auto'];
/** The trust an entry carries while the review mode's write of it is still nobody's but the machine's:
 *  what the owner can Reject from the entry itself, and what a lineage-ending op never applies to at once. */
export const WIKI_MACHINE_TRUST: readonly WikiTrust[] = ['auto', 'unreviewed'];
/** The trust a person gave: the owner wrote it, or confirmed it. An entry that rests on a web-derived
 *  record (`tainted`) reaches an agent — the push, `wiki_search`, `wiki_get` — only with one of these
 *  (contract `reviewModes.floors.taintedWaits`). */
export const WIKI_VOUCHED_TRUST: readonly WikiTrust[] = ['owner', 'confirmed'];

/** First-hand records only. A wiki entry or any view of entries is never a source. */
export const WIKI_SOURCE_KINDS = [
  'turn',
  'event',
  'tool_call',
  'task',
  'task_comment',
  'approval',
  'evidence',
  'owner_decision',
  'merge_receipt',
  'criterion',
  'commit',
  'note',
  'url',
] as const;
export type WikiSourceKind = (typeof WIKI_SOURCE_KINDS)[number];

/** live → trashed → live | deleted; live → deleted. A deleted source has lost its quote. */
export const WIKI_SOURCE_STATES = ['live', 'trashed', 'deleted'] as const;
export type WikiSourceState = (typeof WIKI_SOURCE_STATES)[number];

export const WIKI_ANCHOR_TYPES = ['path', 'symbol', 'commit', 'criterion', 'merge_evidence', 'command', 'record'] as const;
export type WikiAnchorType = (typeof WIKI_ANCHOR_TYPES)[number];

export const WIKI_ANCHOR_STATES = ['unchecked', 'verified', 'changed', 'missing'] as const;
export type WikiAnchorState = (typeof WIKI_ANCHOR_STATES)[number];

export const WIKI_OPS = ['add', 'reinforce', 'amend', 'supersede', 'retire', 'challenge'] as const;
export type WikiOp = (typeof WIKI_OPS)[number];

/** An op is recorded `pending`, `auto_applied` or — in an Automatic space — `verifying`, which waits
 *  for its verdict (contract `reviewModes.verification`); every decision but those three is final. */
export const WIKI_OP_DECISIONS = [
  'pending',
  'accepted',
  'edited',
  'rejected',
  'auto_applied',
  'conflict',
  'expired',
  'withdrawn',
  'verifying',
] as const;
export type WikiOpDecision = (typeof WIKI_OP_DECISIONS)[number];

/**
 * What the owner does with one pending op in Review. The last three answer a challenge and nothing
 * else (contract `anchorRules.verify.answers`): Re-confirm, Amend or Retire the entry it names.
 */
export const WIKI_DECIDE_ACTIONS = ['accept', 'edit', 'reject', 'reconfirm', 'amend', 'retire'] as const;
export type WikiDecideAction = (typeof WIKI_DECIDE_ACTIONS)[number];

/** The decide actions that answer a challenge op, and only a challenge op. */
export const WIKI_CHALLENGE_ANSWERS = ['reconfirm', 'amend', 'retire'] as const;
export type WikiChallengeAnswer = (typeof WIKI_CHALLENGE_ANSWERS)[number];

/** A rejection names one of these; the labels are the words Review shows. */
export const WIKI_REJECT_REASONS = ['not_true', 'not_useful', 'duplicate', 'too_specific'] as const;
export type WikiRejectReason = (typeof WIKI_REJECT_REASONS)[number];
export const WIKI_REJECT_REASON_LABELS: Readonly<Record<WikiRejectReason, string>> = {
  not_true: 'Not true',
  not_useful: 'Not useful',
  duplicate: 'Duplicate',
  too_specific: 'Too specific',
};

/** Who submitted a changeset. `maintenance` and `import` arrive in phase 2, `watch` in phase 3. */
export const WIKI_CHANGESET_ORIGINS = ['owner', 'agent', 'maintenance', 'import', 'watch'] as const;
export type WikiChangesetOrigin = (typeof WIKI_CHANGESET_ORIGINS)[number];

/** pending while any of its ops waits for the owner, settled once none does. */
export const WIKI_CHANGESET_STATUSES = ['pending', 'settled'] as const;
export type WikiChangesetStatus = (typeof WIKI_CHANGESET_STATUSES)[number];

export const WIKI_AUTHOR_KINDS = ['owner', 'agent', 'maintenance', 'system'] as const;
export type WikiAuthorKind = (typeof WIKI_AUTHOR_KINDS)[number];

export const WIKI_EXPOSURE_CHANNELS = ['push', 'search', 'get'] as const;
export type WikiExposureChannel = (typeof WIKI_EXPOSURE_CHANNELS)[number];

/** Why a search returned an entry. `semantic` stays empty until phase 2 turns that leg on. */
export const WIKI_SEARCH_MATCHES = ['keyword', 'semantic', 'path'] as const;
export type WikiSearchMatch = (typeof WIKI_SEARCH_MATCHES)[number];

export const WIKI_REFUSAL_CODES = [
  'WIKI_DISABLED',
  'WIKI_SPACE_UNBOUND',
  'WIKI_SCHEMA',
  'WIKI_KIND_OWNER_ONLY',
  'WIKI_SOURCE_UNRESOLVED',
  'WIKI_QUOTE_NOT_FOUND',
  'WIKI_REVISION_CONFLICT',
  'WIKI_QUOTA',
  'WIKI_REVIEW_QUEUE_FULL',
  'WIKI_PROBE_REFUSED',
  'WIKI_OWNER_CHANNEL_ONLY',
  'WIKI_NOT_MAINTENANCE_SESSION',
  'WIKI_SESSION_EXCLUDED',
  'WIKI_IDEMPOTENCY_KEY_REUSED',
  'WIKI_CURSOR_BEHIND',
  'WIKI_CURSOR_INVALID',
  'WIKI_ARTICLE_STALE',
  'WIKI_PLAN_GATE',
  'WIKI_PLAN_STALE',
  'WIKI_PLAN_UNCONFIRMED',
  'WIKI_DOC_INVALID',
] as const;
export type WikiRefusalCode = (typeof WIKI_REFUSAL_CODES)[number];

export const WIKI_LIMITS = {
  titleMaxChars: 120,
  summaryMaxChars: 280,
  topicsMax: 3,
  aliasesMax: 8,
  aliasMaxChars: 80,
  /** A quote is at most this many characters, redacted before it is stored. */
  quoteMaxChars: 300,
  slugMaxChars: 64,
  /** Every text inside `fields`, an anchor or a source. */
  fieldTextMaxChars: 4_000,
  /** Every list inside `fields`, and an entry's anchors and an op's sources. */
  listMaxItems: 20,
  /** Ops that WAIT FOR THE OWNER one request may record, and one session in its whole life. An op
   *  that applies at once counts toward neither: `opsPerChangeset` and the circuit breaker bound it. */
  opsPerTurn: 5,
  opsPerSession: 15,
  /** Ops one changeset may hold, whatever becomes of them. */
  opsPerChangeset: 30,
  /** Pending ops a space may hold; an op that applies at once never counts. */
  pendingOpsPerSpace: 30,
  /** A pending op expires after this many days. */
  pendingExpiryDays: 14,
  searchLimitMax: 10,
  getIdsMax: 10,
} as const;

/**
 * `orbit wiki import` (contract `import`, criterion 1): each file it reads is one `note` source, and a
 * local model's entries from it are proposed with origin `import`, taking effect as the space's review
 * mode says. The note's CHECKs in migration 0316 are the first two numbers.
 */
export const WIKI_IMPORT_RULES = {
  /** A note's text, redacted, is at most this many characters: a longer file is not imported. */
  noteMaxChars: 100_000,
  /** The path a note was read from, at most this many characters. */
  notePathMaxChars: 500,
  /** The entries the model is asked for, at most, from one file. */
  entriesPerNote: 6,
  /** The ops one run of the import proposes at most. */
  opsPerRun: 30,
} as const;

/** A space's and a topic's slug. */
export const WIKI_SLUG_PATTERN = '^[a-z0-9]+(?:-[a-z0-9]+)*$';

// ── The effect policy (design §4.2): what a submitted op does before anyone reviews it. ─────────

/** `appliedUnlessOff`: applied unless the space turned `autoAcceptReinforce` off, then pending. */
export type WikiOpEffect = 'applied' | 'pending' | 'appliedUnlessOff';

const AGENT_ROW: Readonly<Record<WikiOp, WikiOpEffect>> = {
  add: 'pending',
  reinforce: 'appliedUnlessOff',
  amend: 'pending',
  supersede: 'pending',
  retire: 'pending',
  challenge: 'applied',
};

export const WIKI_EFFECT_POLICY: {
  readonly origins: Readonly<Record<WikiChangesetOrigin, Readonly<Record<WikiOp, WikiOpEffect>>>>;
  /** Replaces the origin's row for a tainted op of any origin but owner. */
  readonly tainted: Readonly<Record<WikiOp, WikiOpEffect>>;
} = {
  origins: {
    owner: {
      add: 'applied',
      reinforce: 'applied',
      amend: 'applied',
      supersede: 'applied',
      retire: 'applied',
      challenge: 'applied',
    },
    agent: AGENT_ROW,
    maintenance: AGENT_ROW,
    import: AGENT_ROW,
    watch: AGENT_ROW,
  },
  tainted: {
    add: 'pending',
    reinforce: 'pending',
    amend: 'pending',
    supersede: 'pending',
    retire: 'pending',
    challenge: 'applied',
  },
};

/** Whether an op that passed every check applies at once or waits for the owner. */
export function wikiOpEffect(input: {
  origin: WikiChangesetOrigin;
  op: WikiOp;
  tainted: boolean;
  autoAcceptReinforce: boolean;
}): 'applied' | 'pending' {
  const row =
    input.tainted && input.origin !== 'owner' ? WIKI_EFFECT_POLICY.tainted : WIKI_EFFECT_POLICY.origins[input.origin];
  const effect = row[input.op];
  if (effect === 'appliedUnlessOff') return input.autoAcceptReinforce ? 'applied' : 'pending';
  return effect;
}

// ── Review modes (contract `reviewModes`): which of what waits above the space lets apply at once. ──

/**
 * Manual is the effect policy above and nothing more. Tiered applies an add or an amend at once —
 * `auto` when it is the owner's own words or machine-verified, `unreviewed` otherwise — and
 * Automatic sends every one that passed the checks to its verification, whose verdict decides it
 * ({@link wikiVerdictTrust}). The floors hold in every mode.
 */
export const WIKI_REVIEW_MODES = ['manual', 'tiered', 'automatic'] as const;
export type WikiReviewMode = (typeof WIKI_REVIEW_MODES)[number];

/**
 * What a space whose settings name no review mode is: every space made before review modes existed.
 * A space made since is written with `WIKI_DEFAULT_SPACE_SETTINGS.reviewMode`, so none of the old
 * ones changes behaviour until its owner can see the setting and chooses another.
 */
export const WIKI_UNSET_REVIEW_MODE: WikiReviewMode = 'manual';

/** The numbers the review modes are held to. Decided (criterion 7), not tuned. */
export const WIKI_REVIEW_RULES = {
  /** Tiered: a pitfall is machine-verified when its anchors verified and its sources span this many sessions. */
  pitfallMinSessions: 2,
  /** One in this many ops the review mode applies at once is drawn into Review as a spot check. */
  spotCheckEvery: 10,
  /** The reject rate is read over this many of the latest answered spot checks. */
  spotCheckWindow: 10,
  /** More than this percent of that window rejected sends the space back to Manual. */
  spotCheckMaxRejectPercent: 30,
  /** The circuit breaker: one changeset may change at most this percent of the active entries … */
  breakerMaxChangedPercent: 10,
  /** … once the space holds at least this many. Below it there is no breaker, so an empty space fills. */
  breakerMinActiveEntries: 100,
  /** Automatic, with `automaticSpotChecks` on: one in this many ops a verdict applies is drawn as a spot check. */
  automaticSpotCheckEvery: 200,
  /** Automatic's fallback: the unsupported rate is read over this many of the latest verdicts … */
  verificationWindow: 50,
  /** … and more than this percent of that window unsupported sends the space back to Tiered. */
  verificationMaxUnsupportedPercent: 30,
  /** A verdict's reason, redacted, and the id of the model that gave it, at most these many characters. */
  verificationReasonMaxChars: 500,
  verificationModelMaxChars: 200,
  /** How many ops one read of the verification list answers with at most. */
  verificationListMax: 50,
  /** How much of one source's record the verification list hands a verifier. */
  verificationSourceMaxChars: 8_000,
} as const;

/** What a verification can say of an op (contract `reviewModes.verification.verdicts`). */
export const WIKI_VERIFICATION_VERDICTS = ['supported', 'partial', 'unsupported', 'duplicate'] as const;
export type WikiVerificationVerdict = (typeof WIKI_VERIFICATION_VERDICTS)[number];

/**
 * The trust a verdict applies its op with, or null when it applies none: supported is Auto and
 * pushed, partial is Unreviewed — shown, never pushed — and an unsupported or duplicate op is
 * rejected rather than applied (contract `reviewModes.verification.verdicts`).
 */
export function wikiVerdictTrust(verdict: WikiVerificationVerdict): 'auto' | 'unreviewed' | null {
  if (verdict === 'supported') return 'auto';
  if (verdict === 'partial') return 'unreviewed';
  return null;
}

/** What the verifier could read of an op's sources when its verdict was recorded (contract
 *  `reviewModes.verification.evidence`): the text of at least one of them, or of none. */
export const WIKI_VERIFICATION_EVIDENCE = ['readable', 'unreadable'] as const;
export type WikiVerificationEvidence = (typeof WIKI_VERIFICATION_EVIDENCE)[number];

/**
 * What a verdict does to its op once the server has held it to what the verifier could read and to
 * the tainted floor (contract `reviewModes.verification.evidence` and `floors.taintedWaits`): the
 * trust it applies with, or null for a rejection; whether a duplicate's sources are added to the
 * entry it names (the space's autoAcceptReinforce still decides that); and whether the verdict counts
 * toward the fallback's window.
 *
 * A verdict given when no source could be read is no verdict about the claim: supported, partial and
 * unsupported all apply it as unreviewed, a duplicate still adds its sources, and none of them is
 * counted. A tainted op is never more than unreviewed, and its duplicate adds nothing — what a session
 * that read the web cites must not change whether an entry already in the space is pushed.
 */
export function wikiVerdictEffect(input: {
  verdict: WikiVerificationVerdict;
  tainted: boolean;
  evidence: WikiVerificationEvidence;
}): { trust: 'auto' | 'unreviewed' | null; reinforce: boolean; counted: boolean } {
  const counted = input.evidence === 'readable';
  if (input.verdict === 'duplicate') return { trust: null, reinforce: !input.tainted, counted };
  if (!counted) return { trust: 'unreviewed', reinforce: false, counted };
  const trust = wikiVerdictTrust(input.verdict);
  return { trust: input.tainted && trust === 'auto' ? 'unreviewed' : trust, reinforce: false, counted };
}

/** Why tiered applies an op as `auto`. Anything else it applies is `unreviewed`. */
export type WikiTieredBasis = 'owner_words' | 'machine_verified';

/**
 * Tiered's classification (contract `reviewModes.tiered`).
 *
 * - The owner's own words: a decision or a convention one of whose sources is the owner's message,
 *   steer or AskUserQuestion answer, with its quote verified against that record.
 * - Machine-verified: a recipe whose verify command a maintenance run re-ran green, or a pitfall
 *   whose anchors re-verified and whose sources span `pitfallMinSessions` independent sessions.
 */
export function wikiTieredBasis(input: {
  kind: WikiEntryKind;
  ownerWords: boolean;
  anchorState: WikiAnchorState;
  sessions: number;
  recipeVerified: boolean;
}): WikiTieredBasis | null {
  if ((input.kind === 'decision' || input.kind === 'convention') && input.ownerWords) return 'owner_words';
  if (input.kind === 'recipe' && input.recipeVerified) return 'machine_verified';
  if (input.kind === 'pitfall' && input.anchorState === 'verified' && input.sessions >= WIKI_REVIEW_RULES.pitfallMinSessions) {
    return 'machine_verified';
  }
  return null;
}

/**
 * What the review mode made of an op: the effect, and — when the MODE took it — which mode. Tiered
 * applies what it takes at once, with the trust it names; Automatic sends it to its verification
 * (`verifying`), and the verdict names the trust later ({@link wikiVerdictTrust}).
 */
export interface WikiReviewEffect {
  effect: 'applied' | 'pending' | 'verifying';
  byMode: { mode: 'tiered'; trust: 'auto' | 'unreviewed' } | { mode: 'automatic'; trust: null } | null;
}

/**
 * The effect of an op that passed every check, under the space's review mode.
 *
 * The effect policy decides first, and whatever it applies (the owner's own write, a reinforce, a
 * challenge) is untouched by the mode. What it holds back, a mode other than Manual may take — only
 * an add or an amend, because only those can be undone (a revert retires the add and restores the
 * revision the amend replaced; a supersede or a retire ends a lineage for good), and only an amend
 * of an entry the machine wrote. The floors hold in every mode: a tainted op waits — for the owner in
 * Manual and Tiered, and in Automatic for a verification whose verdict can leave it no more than
 * unreviewed ({@link wikiVerdictEffect}) — and an amend of anything the owner wrote or confirmed waits
 * for the owner. What Automatic takes is not applied here at all: it waits for its verification, and
 * nothing of it is live until a verdict says so.
 */
export function wikiReviewEffect(input: {
  mode: WikiReviewMode;
  origin: WikiChangesetOrigin;
  op: WikiOp;
  tainted: boolean;
  autoAcceptReinforce: boolean;
  /** An amend's entry: the owner wrote or confirmed it, and it is live with machine trust. */
  target: { ownerVouched: boolean; machineWritten: boolean } | null;
  /** Tiered's classification of what the op leaves ({@link wikiTieredBasis}). */
  basis: WikiTieredBasis | null;
}): WikiReviewEffect {
  const effect = wikiOpEffect(input);
  if (effect === 'applied' || input.mode === 'manual') return { effect, byMode: null };
  const held: WikiReviewEffect = { effect: 'pending', byMode: null };
  if (input.tainted && input.mode !== 'automatic') return held;
  if (input.op !== 'add' && input.op !== 'amend') return held;
  if (input.op === 'amend' && (!input.target || input.target.ownerVouched || !input.target.machineWritten)) return held;
  if (input.mode === 'automatic') return { effect: 'verifying', byMode: { mode: 'automatic', trust: null } };
  return { effect: 'applied', byMode: { mode: 'tiered', trust: input.basis !== null ? 'auto' : 'unreviewed' } };
}

// ── Field schemas: the language `KIND_SPECS` and the contract's `kinds` are both written in. ─────

/**
 * One field. `text` is a non-blank string of at most `fieldTextMaxChars` characters (matching
 * `pattern` when there is one); a list holds at most `listMaxItems`; `atLeastOneOf` asks that one
 * of the named fields hold a non-empty list or a text.
 */
export type WikiFieldSchema =
  | { readonly type: 'text'; readonly required: boolean; readonly pattern?: string }
  | { readonly type: 'textList'; readonly required: boolean; readonly minItems?: number }
  | { readonly type: 'date'; readonly required: boolean }
  | { readonly type: 'integer'; readonly required: boolean; readonly min?: number; readonly max?: number }
  | {
      readonly type: 'object';
      readonly required: boolean;
      readonly fields: WikiFieldSchemas;
      readonly atLeastOneOf?: readonly string[];
    }
  | { readonly type: 'objectList'; readonly required: boolean; readonly minItems?: number; readonly fields: WikiFieldSchemas };

export interface WikiFieldSchemas {
  readonly [name: string]: WikiFieldSchema;
}

/** One failed field, named by its path: `fields.alternatives[0].whyRejected`, `anchors[2].sha`. */
export interface WikiFieldError {
  path: string;
  message: string;
}

/** Whether an entry of the kind reaches the push: every one that is eligible, by relevance, or never. */
export type WikiPushRule = 'always' | 'relevance' | 'never';

export interface WikiKindSpec<K extends WikiKind = WikiKind> {
  readonly kind: K;
  readonly fields: WikiFieldSchemas;
  /** Ops only the owner may submit for this kind; anyone else is refused `WIKI_KIND_OWNER_ONLY`. */
  readonly ownerOnlyOps: readonly WikiOp[];
  /** false: an entry of this kind is only ever superseded (an amend is refused `WIKI_SCHEMA`). */
  readonly amendable: boolean;
  readonly push: WikiPushRule;
  /** The entry's `fields` checked against this kind's schema. Paths start at `path`. */
  validate(fields: unknown, path?: string): WikiFieldError[];
}

export interface WikiPrincipleFields {
  statement: string;
  rationale: string;
}
export interface WikiConventionFields {
  rule: string;
  /** Path globs the rule holds for. */
  scope: string[];
  exceptions?: string;
}
export interface WikiDecisionFields {
  context: string;
  decision: string;
  alternatives: { option: string; whyRejected: string }[];
  consequences: string;
  /** ISO 8601 date. */
  decidedAt: string;
}
export interface WikiPitfallFields {
  trigger: { paths: string[]; commands: string[]; errorSignature?: string };
  symptom: string;
  cause: string;
  fix: string;
  detector?: string;
}
export interface WikiRecipeFields {
  steps: string[];
  verify: { command: string; expectedExit: number };
}
export interface WikiConceptFields {
  definition: string;
  boundaries: string;
  notToConfuseWith?: string;
}
export interface WikiKindFields {
  principle: WikiPrincipleFields;
  convention: WikiConventionFields;
  decision: WikiDecisionFields;
  pitfall: WikiPitfallFields;
  recipe: WikiRecipeFields;
  concept: WikiConceptFields;
}

function kindSpec<K extends WikiKind>(
  kind: K,
  fields: WikiFieldSchemas,
  rules: { ownerOnlyOps: readonly WikiOp[]; amendable: boolean; push: WikiPushRule },
): WikiKindSpec<K> {
  return {
    kind,
    fields,
    ...rules,
    validate(value: unknown, path = 'fields') {
      const errors: WikiFieldError[] = [];
      checkObject(fields, undefined, value, path, errors);
      return errors;
    },
  };
}

/** Every phase-1 kind: its fields, who may write it, and how it reaches the push. */
export const KIND_SPECS: { readonly [K in WikiKind]: WikiKindSpec<K> } = {
  principle: kindSpec(
    'principle',
    {
      statement: { type: 'text', required: true },
      rationale: { type: 'text', required: true },
    },
    { ownerOnlyOps: ['add', 'amend', 'supersede'], amendable: true, push: 'always' },
  ),
  convention: kindSpec(
    'convention',
    {
      rule: { type: 'text', required: true },
      scope: { type: 'textList', required: true, minItems: 1 },
      exceptions: { type: 'text', required: false },
    },
    { ownerOnlyOps: [], amendable: true, push: 'always' },
  ),
  decision: kindSpec(
    'decision',
    {
      context: { type: 'text', required: true },
      decision: { type: 'text', required: true },
      alternatives: {
        type: 'objectList',
        required: true,
        minItems: 1,
        fields: {
          option: { type: 'text', required: true },
          whyRejected: { type: 'text', required: true },
        },
      },
      consequences: { type: 'text', required: true },
      decidedAt: { type: 'date', required: true },
    },
    { ownerOnlyOps: [], amendable: false, push: 'relevance' },
  ),
  pitfall: kindSpec(
    'pitfall',
    {
      trigger: {
        type: 'object',
        required: true,
        atLeastOneOf: ['paths', 'commands', 'errorSignature'],
        fields: {
          paths: { type: 'textList', required: true },
          commands: { type: 'textList', required: true },
          errorSignature: { type: 'text', required: false },
        },
      },
      symptom: { type: 'text', required: true },
      cause: { type: 'text', required: true },
      fix: { type: 'text', required: true },
      detector: { type: 'text', required: false },
    },
    { ownerOnlyOps: [], amendable: true, push: 'relevance' },
  ),
  recipe: kindSpec(
    'recipe',
    {
      steps: { type: 'textList', required: true, minItems: 1 },
      verify: {
        type: 'object',
        required: true,
        fields: {
          command: { type: 'text', required: true },
          expectedExit: { type: 'integer', required: true, min: 0, max: 255 },
        },
      },
    },
    { ownerOnlyOps: [], amendable: true, push: 'relevance' },
  ),
  concept: kindSpec(
    'concept',
    {
      definition: { type: 'text', required: true },
      boundaries: { type: 'text', required: true },
      notToConfuseWith: { type: 'text', required: false },
    },
    { ownerOnlyOps: [], amendable: true, push: 'never' },
  ),
};

/** Each anchor type's own keys (beside `type`), and the states a check of it can report. */
export const WIKI_ANCHOR_SPECS: {
  readonly [T in WikiAnchorType]: { readonly fields: WikiFieldSchemas; readonly states: readonly WikiAnchorState[] };
} = {
  path: {
    fields: { path: { type: 'text', required: true } },
    states: ['verified', 'missing'],
  },
  symbol: {
    fields: {
      path: { type: 'text', required: true },
      symbol: { type: 'text', required: true },
      regionSha256: { type: 'text', required: false, pattern: '^[0-9a-f]{64}$' },
    },
    states: ['verified', 'changed', 'missing'],
  },
  commit: {
    fields: { sha: { type: 'text', required: true, pattern: '^[0-9a-f]{40}$' } },
    states: ['verified', 'missing'],
  },
  criterion: {
    fields: {
      criterionId: { type: 'text', required: true },
      semanticHash: { type: 'text', required: false, pattern: '^[0-9a-f]{64}$' },
    },
    states: ['verified', 'changed'],
  },
  merge_evidence: {
    fields: { contentHash: { type: 'text', required: true, pattern: '^[0-9a-f]{64}$' } },
    states: ['verified', 'missing'],
  },
  command: {
    fields: {
      command: { type: 'text', required: true },
      expectedExit: { type: 'integer', required: true, min: 0, max: 255 },
    },
    states: ['verified', 'changed'],
  },
  record: {
    fields: { ref: { type: 'text', required: true, pattern: '^orbit-(task|session|project|list):[0-9A-Za-z-]+$' } },
    states: ['verified', 'missing'],
  },
};

// ── Wire types ─────────────────────────────────────────────────────────────────────────────────

/** An anchor as a proposer writes it. */
export type WikiAnchorInput =
  | { type: 'path'; path: string }
  | { type: 'symbol'; path: string; symbol: string; regionSha256?: string }
  | { type: 'commit'; sha: string }
  | { type: 'criterion'; criterionId: string; semanticHash?: string }
  | { type: 'merge_evidence'; contentHash: string }
  | { type: 'command'; command: string; expectedExit: number }
  | { type: 'record'; ref: string };

/** An anchor as the server keeps it: what was proposed, and its last check. A proposer never sends `check`. */
export type WikiAnchor = WikiAnchorInput & {
  check?: WikiAnchorCheck;
};

/**
 * An anchor's last check, as the server keeps it beside the anchor (contract `anchorRules.verify.check`).
 * A symbol the check found carries the hash of its region then, and the hash it is held to: its own
 * `regionSha256`, or — for a symbol anchor that names none — the region its first check found.
 */
export interface WikiAnchorCheck {
  state: WikiAnchorState;
  ref: string | null;
  at: string | null;
  regionSha256?: string;
  baselineSha256?: string;
}

/** A source as a proposer cites it. `{ kind: 'turn', session: 'self' }` is the calling session. */
export interface WikiSourceInput {
  kind: WikiSourceKind;
  ref?: string;
  session?: 'self';
  seq?: number;
  locator?: Record<string, unknown>;
  quote?: string;
}

/** A source as stored, on the revision it supports. `quote` is NULL once the record it cites is deleted. */
export interface WikiSource {
  id: string;
  kind: WikiSourceKind;
  ref: string;
  locator: Record<string, unknown>;
  quote: string | null;
  quoteVerified: boolean;
  state: WikiSourceState;
  tainted: boolean;
  createdAt: string;
}

/** What an add or a supersede proposes: a whole entry of one kind. */
export type WikiEntryDraft = {
  [K in WikiKind]: {
    kind: K;
    title: string;
    summary: string;
    fields: WikiKindFields[K];
    topics?: string[];
    aliases?: string[];
    anchors?: WikiAnchorInput[];
  };
}[WikiKind];

/** What an amend (or the owner's edit in Review) changes: each key given replaces that key whole,
 *  each key omitted carries over. The kind never changes. */
export interface WikiEntryChanges {
  title?: string;
  summary?: string;
  fields?: WikiKindFields[WikiKind];
  topics?: string[];
  aliases?: string[];
  anchors?: WikiAnchorInput[];
}

export type WikiOpInput =
  | { op: 'add'; entry: WikiEntryDraft; sources?: WikiSourceInput[] }
  | { op: 'reinforce'; entryId: string; sources: WikiSourceInput[] }
  | { op: 'amend'; entryId: string; baseRevision: number; changes: WikiEntryChanges; sources?: WikiSourceInput[] }
  | { op: 'supersede'; entryId: string; baseRevision: number; entry: WikiEntryDraft; sources?: WikiSourceInput[] }
  | { op: 'retire'; entryId: string; baseRevision: number; reason: string; sources?: WikiSourceInput[] }
  | { op: 'challenge'; entryId: string; reason: string; sources?: WikiSourceInput[] };

/** `wiki_propose`'s arguments, and the body of `POST /api/runner/wiki/changesets`. */
export interface WikiProposeRequest {
  ops: WikiOpInput[];
  rationale: string;
  /** The owner's: the same key with the same request replays the recorded answer; with another
   *  request it is refused `WIKI_IDEMPOTENCY_KEY_REUSED`. */
  idempotencyKey: string;
  /** Check every op and answer as the request would, recording nothing. */
  dryRun?: boolean;
}

export interface WikiRefusal {
  code: WikiRefusalCode;
  message: string;
  /** `WIKI_SCHEMA`: every field that failed; `WIKI_PLAN_GATE`: everything the plan's gate found, each
   *  also naming its check (`WikiPlanGateError`); `WIKI_DOC_INVALID`: everything wrong with a document write. */
  errors?: WikiFieldError[];
}

/** A near neighbour of a proposed entry. A rejected one says why it was rejected. */
export interface WikiSimilar {
  id: string;
  kind: WikiEntryKind;
  title: string;
  status: WikiEntryStatus;
  trust: WikiTrust;
  score: number;
  rejectedReason?: WikiRejectReason;
  /** A verification rejected it: the verifier's own reason, beside the closed-set one above. */
  rejectedBecause?: string;
}

/** One op's answer, by its 0-based position in `ops`. A dry run records nothing, so its ids are null. */
export type WikiOpOutcome =
  | {
      seq: number;
      status: 'pending';
      opId: string | null;
      entryId: string | null;
      similar?: WikiSimilar[];
      /** Set when an Automatic space's verification, not the owner, decides it (contract
       *  `reviewModes.verification.waits`). Absent, the op waits for the owner. */
      waitsFor?: 'verification';
    }
  | {
      seq: number;
      status: 'applied';
      opId: string | null;
      entryId: string | null;
      revision: number | null;
      similar?: WikiSimilar[];
    }
  | {
      seq: number;
      status: 'conflict';
      entryId: string;
      baseRevision: number;
      currentRevision: number;
      current: WikiEntryChanges;
      diff: string;
    }
  | { seq: number; status: 'refused'; reasons: WikiRefusal[] };

export interface WikiProposeResult {
  /** Null when nothing was recorded: a dry run, or every op refused. */
  changesetId: string | null;
  /** The recorded answer to an earlier request under the same idempotency key. */
  replayed: boolean;
  ops: WikiOpOutcome[];
}

/** `wiki_search` returns entries, and nothing else (contract `agentSurface.toolSpecs.wiki_search`
 *  `returns`: id, kind, title, summary, trust, anchorState, match, score). A session is bound to one
 *  space, so a hit there needs nothing about where it lives — and a search that quietly grew the
 *  whole entry back onto every hit is the RAG collapse `wiki-retrieval.ts` refuses on purpose. */
export interface WikiSearchHit {
  id: string;
  kind: WikiEntryKind;
  title: string;
  summary: string;
  trust: WikiTrust;
  anchorState: WikiAnchorState;
  match: WikiSearchMatch[];
  score: number;
}

/**
 * The extra fields a caller can ASK a hit for (`GET /wiki/search?include=…`, the API's own
 * `?include=` convention — `getSpaceView`'s `usage`, `getEntry`'s `sources,history,exposure`).
 *
 * For the one caller that OPENS what it finds: the owner's ⌘K. An entry's page is
 * `/wiki/<space>/e/<id>` — a space AND an id, while the id alone names no page — and the row under
 * the title says which topic it is filed under and what the last anchor check found. None of them
 * is part of a hit's answer, which is why they arrive only when named.
 */
export interface WikiSearchRowAdditions {
  /** The space the entry is filed in, whose slug its page is reached under. */
  spaceSlug?: string;
  /** The entry's topic slugs, as the Wiki's own pages spell them. */
  topics?: string[];
  /** The ref the entry's anchors were last checked at, for the `✓ <ref>` mark. */
  anchorCheckedRef?: string | null;
}

export type WikiSearchRow = WikiSearchHit & WikiSearchRowAdditions;

export interface WikiSpaceSettings {
  push: boolean;
  autoAcceptReinforce: boolean;
  /** The owner's, on the owner channel only. A space the spot checks sent back is `manual` again,
   *  and an Automatic one its verification sent back is `tiered`. */
  reviewMode: WikiReviewMode;
  /** The owner's, on the owner channel only: whether Automatic draws spot checks at all
   *  (`WIKI_REVIEW_RULES.automaticSpotCheckEvery`). Tiered draws its own whatever this says. */
  automaticSpotChecks: boolean;
  /** Server-written: when the mode last changed, and who changed it. Absent until it first does. */
  reviewModeChangedAt?: string;
  reviewModeChangedBy?: 'owner' | 'spot_checks' | 'verification';
  /** The space's Wiki maintenance run (contract `space.settings.maintenance`): off by default. */
  maintenance: WikiMaintenanceSettings;
}

/**
 * The Wiki maintenance run of a space (design §8.2, contract `space.settings.maintenance`). The
 * owner's alone, on the owner channel only, like the review mode.
 */
export type WikiMaintenanceSettings = {
  /** Off until the owner turns it on: in a space that is off, no fact starts a maintenance task. */
  enabled: boolean;
  /** The workspace the maintenance task runs in, which decides the runner. Required to turn it on. */
  workspaceId: string | null;
  /** The provider the run is pinned to, with no fallback. */
  provider: string;
  /** How many maintenance tasks the space may make in one UTC day, within {@link WIKI_MAINTENANCE_DAILY_RUN_LIMIT}. */
  dailyRunLimit: number;
  /** Server-written, never taken from a request: the space's hidden «Wiki maintenance» task list,
   *  made the first time maintenance is turned on and kept when it is turned off. A maintenance
   *  session is a session whose task is in it. */
  listId: string | null;
};

/** The bounds of `dailyRunLimit` (contract `space.settings.maintenance.bounds.dailyRunLimit`). */
export const WIKI_MAINTENANCE_DAILY_RUN_LIMIT = { min: 1, max: 48 } as const;

export const WIKI_DEFAULT_MAINTENANCE_SETTINGS: Readonly<WikiMaintenanceSettings> = {
  enabled: false,
  workspaceId: null,
  provider: 'local-vllm',
  dailyRunLimit: 8,
  listId: null,
};

/** The title of a space's hidden maintenance list (UI copy is English). */
export const WIKI_MAINTENANCE_LIST_TITLE = 'Wiki maintenance';

/** Stored maintenance settings as they read: every absent or malformed key its default. */
export function wikiMaintenanceSettings(stored: unknown): WikiMaintenanceSettings {
  const raw = (stored !== null && typeof stored === 'object' && !Array.isArray(stored) ? stored : {}) as Record<string, unknown>;
  const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value : null);
  const limit = raw.dailyRunLimit;
  return {
    enabled: raw.enabled === true,
    workspaceId: text(raw.workspaceId),
    provider: text(raw.provider) ?? WIKI_DEFAULT_MAINTENANCE_SETTINGS.provider,
    dailyRunLimit: typeof limit === 'number' && Number.isInteger(limit)
      && limit >= WIKI_MAINTENANCE_DAILY_RUN_LIMIT.min && limit <= WIKI_MAINTENANCE_DAILY_RUN_LIMIT.max
      ? limit
      : WIKI_DEFAULT_MAINTENANCE_SETTINGS.dailyRunLimit,
    listId: text(raw.listId),
  };
}

/** What a space is created with. A stored space whose settings lack `reviewMode` reads as
 *  {@link WIKI_UNSET_REVIEW_MODE} instead — see {@link wikiSpaceSettings}. */
export const WIKI_DEFAULT_SPACE_SETTINGS: Readonly<WikiSpaceSettings> = {
  push: true,
  autoAcceptReinforce: true,
  reviewMode: 'tiered',
  automaticSpotChecks: false,
  maintenance: WIKI_DEFAULT_MAINTENANCE_SETTINGS,
};

/** A stored space's settings as they read: every absent key its default, and an absent or unknown
 *  review mode the one a space had before review modes existed. */
export function wikiSpaceSettings(stored: unknown): WikiSpaceSettings {
  const raw = (stored !== null && typeof stored === 'object' && !Array.isArray(stored) ? stored : {}) as Partial<WikiSpaceSettings>;
  const reviewMode = (WIKI_REVIEW_MODES as readonly unknown[]).includes(raw.reviewMode) ? raw.reviewMode! : WIKI_UNSET_REVIEW_MODE;
  return { ...WIKI_DEFAULT_SPACE_SETTINGS, ...raw, reviewMode, maintenance: wikiMaintenanceSettings(raw.maintenance) };
}

// ── Wiki maintenance: the dossier and the cursor (contract `maintenance`, criterion 2) ──────────

/**
 * The numbers the dossier and the cursor run by (contract `maintenance.rules`). The token budget is
 * the demo's: 8k a session recalled more than 16k did.
 */
export const WIKI_MAINTENANCE_RULES = {
  /** A session's dossier, estimated with {@link wikiEstimateTokens}, never passes this. */
  dossierMaxTokens: 8_000,
  /** Sessions a dossier page carries when the caller names no limit, and the most it may name. */
  pageSessionsDefault: 20,
  pageSessionsMax: 50,
  /** How long a fact is left to commit before a page may hand it out. */
  settleGraceSeconds: 120,
  /** A tool error signature is a cluster once this many sessions of the space share it… */
  errorClusterMinSessions: 3,
  /** …counting the sessions that came to rest in this many days. */
  errorClusterLookbackDays: 14,
  /** Tasks of one project (or list) that share a title template make it a batch project. */
  batchTemplateMinTasks: 20,
  /** A settled task's agent comments, the newest this many, are what its dossier carries. */
  commentTail: 3,
  /** The two conditions a maintenance task is due on (criterion 3 reads them): this many sessions
   *  with a fact after the watermark… */
  backlogThreshold: 20,
  /** …or a fact after it older than this, when a new fact arrives. */
  maxPendingAgeHours: 24,
} as const;

/** The committed facts each of which adds one to a space's backlog (contract `maintenance.cursor.factKinds`). */
export const WIKI_CURSOR_FACT_KINDS = [
  'session_settled',
  'task_terminal',
  'approval_answered',
  'merge_receipt',
  'criterion_revised',
] as const;
export type WikiCursorFactKind = (typeof WIKI_CURSOR_FACT_KINDS)[number];

/** How a maintenance run ended, as `orbit wiki cursor advance` reports it. Only `succeeded` moves the cursor. */
export const WIKI_CURSOR_OUTCOMES = ['succeeded', 'failed', 'truncated'] as const;
export type WikiCursorOutcome = (typeof WIKI_CURSOR_OUTCOMES)[number];

/**
 * Tokens a text is counted as: ASCII characters at 3.4 a token, every other character at 1.25, plus
 * one. The demo's estimate (`pack.py`), kept because the 8k budget was measured with it.
 */
export function wikiEstimateTokens(text: string): number {
  if (!text) return 0;
  let ascii = 0;
  let other = 0;
  for (const ch of text) {
    if (ch.codePointAt(0)! < 128) ascii += 1;
    else other += 1;
  }
  return Math.floor(ascii / 3.4 + other / 1.25) + 1;
}

/**
 * Where one line's words are in its record (criterion 2, revision 2; contract `maintenance.dossier.spans`):
 * `[start, end)` in code points of the record's text — the text a quote of it is checked against, redacted —
 * and the words found there.
 */
export interface WikiDossierSpan {
  start: number;
  end: number;
  /** The record's redacted text from `start` to `end`, verbatim. Handed out, never stored. */
  text: string;
}

/** One line's first-hand record: what a proposal made from the dossier cites (contract `sourceKinds`). */
export interface WikiDossierSource {
  /** The line's short name in the dossier text, `L1`, `L2`, … */
  ref: string;
  kind: WikiSourceKind;
  id: string;
  /**
   * The pieces of the record the line was made from, in order. A line copied whole is one span; a line the
   * dossier compressed — a tool call to its command and its result's first and last line, a message cut short, a
   * thought to its signal sentences — has a span for each piece of its record it kept.
   */
  spans: WikiDossierSpan[];
}

/**
 * One session's dossier. Its text is never stored: only `sources` — each span's position, never its words — and
 * `hash` are (wiki_dossier).
 */
export interface WikiDossier {
  sessionId: string;
  taskId: string | null;
  title: string;
  text: string;
  tokens: number;
  /** The session's whole timeline did not fit in the budget, and lines were left out or cut. */
  truncated: boolean;
  /** A session that read the web: what it says is external until the owner confirms it. */
  tainted: boolean;
  sources: WikiDossierSource[];
  /** sha256 of the text and the sources: the same records give the same hash. */
  hash: string;
  /** The same hash was handed out on a page the cursor has since advanced past. */
  unchanged: boolean;
}

/** A batch project's sessions, which get these counts and no dossier each (contract `maintenance.dossier.batchProjects`). */
export interface WikiDossierBatch {
  projectId: string | null;
  listId: string | null;
  template: string;
  /** Every task of the project (or list) under this template, and how many are in each status. */
  tasks: number;
  byStatus: Record<string, number>;
  /** The sessions of this page the batch stands for. */
  sessions: number;
  errors: Array<{ tool: string; signature: string; count: number }>;
}

/** One tool error signature that sessions of the space share (contract `maintenance.dossier.errorClusters`). */
export interface WikiErrorCluster {
  tool: string;
  signature: string;
  sessions: number;
  occurrences: number;
  examples: Array<{ toolCallId: string; sessionId: string; firstLine: string }>;
}

/** Where a space's maintenance stands (the `wiki_cursor` row and what is after it). */
export interface WikiCursorState {
  spaceId: string;
  /** The watermark as a token, or null before the first advance. */
  position: string | null;
  backlog: number;
  byKind: Record<WikiCursorFactKind, number>;
  pendingSessions: number;
  oldestPendingAt: string | null;
  lagSeconds: number | null;
  lastOkAt: string | null;
  lastRunAt: string | null;
  lastOutcome: WikiCursorOutcome | null;
  consecutiveFailures: number;
  lastError: string | null;
  /** The two due conditions: rules.backlogThreshold sessions pending, or the oldest fact past rules.maxPendingAgeHours. */
  due: { backlog: boolean; age: boolean };
  /**
   * Why the last fact that found the space due made no task, and when (contract `maintenance.job.held`):
   * null once a task is made.
   */
  held: { reason: 'daily_limit_reached' | 'review_queue_full'; at: string } | null;
}

/** `GET /api/runner/wiki/spaces/:id/dossiers`. */
export interface WikiDossierPage {
  spaceId: string;
  /** Advance to this once every dossier of the page was processed. */
  cursor: string;
  /** Facts past this page remain. */
  more: boolean;
  facts: number;
  dossiers: WikiDossier[];
  batches: WikiDossierBatch[];
  errorClusters: WikiErrorCluster[];
  state: WikiCursorState;
}

// ── Wiki maintenance: the run a maintenance session is claimed with (contract `maintenance.run`) ──

/**
 * The guardrails of a maintenance run (design §8.2): every maintenance session is claimed with these,
 * whatever its workspace or its owner's defaults say. Tools a run may not have are named even when the
 * clean start leaves them out anyway: a runtime that ignored the one would still meet the other.
 */
export const WIKI_MAINTENANCE_RUN = {
  /** Model turns the run's opening prompt may take; a run cut short by it failed. */
  maxTurns: 120,
  /** Sub-agents (Task, Agent) and the web (WebFetch, WebSearch). */
  disallowedTools: ['Task', 'Agent', 'WebFetch', 'WebSearch'],
  /** Nobody watches a maintenance run: what is not pre-approved is refused, never asked. */
  permissionMode: 'dontAsk',
  /** The one runtime whose clean start and disallowedTools hold (the codex path ignores disallowedTools). */
  runtime: 'claude',
} as const;

/**
 * What a runner declares to be handed maintenance sessions. A runner that does not is never sent one —
 * it would start the session as an ordinary one, without the clean start or the turn limit.
 */
export const WIKI_MAINTENANCE_RUN_V1 = 'wiki-maintenance-run/v1';

/** `wikiMaintenance` on a claimed or reclaimed session: present on a maintenance session only. */
export interface WikiMaintenanceRun {
  /** The space the session maintains. */
  spaceId: string;
  /** The space's maintenance settings, as the run was claimed under them. */
  workspaceId: string | null;
  provider: string;
  /** Always empty: a maintenance run falls back to no other provider. */
  providerFallbacks: [];
  maxTurns: number;
  disallowedTools: string[];
  /** Start the engine clean (contract `maintenance.run.cleanStart`). */
  cleanStart: true;
  /** Why the run may not start, when it may not: the runner ends it FAILED with this and starts no engine. */
  refusal?: string;
}

// ── Anchor re-verification (criterion 4, contract `anchorRules.verify`) ────────────────────────

/** The anchor types a maintenance run re-verifies with git, on origin/main (design §4.4). */
export const WIKI_GIT_ANCHOR_TYPES = ['path', 'symbol', 'commit'] as const;
export type WikiGitAnchorType = (typeof WIKI_GIT_ANCHOR_TYPES)[number];

/** The numbers the anchor re-verification runs by (contract `anchorRules.verify.rules`). */
export const WIKI_ANCHOR_RULES = {
  /** A symbol's region: the line the symbol is found on and the lines after it, this many in all. */
  symbolRegionLines: 20,
  /** Entries one read of the anchors list carries when the caller names no limit, and the most it may name. */
  listEntriesDefault: 50,
  listEntriesMax: 200,
  /** Entries one report carries at most. */
  reportEntriesMax: 50,
} as const;

/** One git anchor of an entry, as the anchors list hands it to the runner that re-verifies it. */
export interface WikiDueAnchor {
  /** Its place in the entry's `anchors`: what the report names it by. */
  index: number;
  type: WikiGitAnchorType;
  path?: string;
  symbol?: string;
  sha?: string;
  /** A symbol's baseline: the hash its region is held to, or null before its first check found one. */
  regionSha256?: string | null;
}

/** An active entry with git anchors, at the revision its report must name. */
export interface WikiAnchorDueEntry {
  entryId: string;
  revision: number;
  anchors: WikiDueAnchor[];
}

/** `GET /api/runner/wiki/spaces/:id/anchors`. */
export interface WikiAnchorList {
  spaceId: string;
  /** The work directory of the space's workspace on this runner, as stored (`~/orbit` is not expanded). */
  repo: { workspaceId: string; workDir: string } | null;
  entries: WikiAnchorDueEntry[];
  /** The last entryId of this page, to read the next; null on the last page. */
  next: string | null;
}

/** One anchor's check, as the runner reports it. */
export interface WikiAnchorCheckInput {
  index: number;
  type: WikiGitAnchorType;
  state: 'verified' | 'changed' | 'missing';
  /** A symbol found: the sha256 of its region on the checked ref. */
  regionSha256?: string;
}

/** `POST /api/runner/wiki/spaces/:id/anchor-checks`. */
export interface WikiAnchorReport {
  /** The commit origin/main named after the fetch: the 40-character sha every check was made on. */
  ref: string;
  entries: Array<{ entryId: string; revision: number; checks: WikiAnchorCheckInput[] }>;
}

/** What one entry's report became. */
export type WikiAnchorOutcome =
  | {
      entryId: string;
      status: 'recorded';
      anchorState: WikiAnchorState;
      trust: WikiTrust;
      challenged: boolean;
      /** The system challenge this report filed, or null when it filed none. */
      challengeOpId: string | null;
    }
  | { entryId: string; status: 'stale'; message: string }
  | { entryId: string; status: 'refused'; httpStatus: number; code?: WikiRefusalCode; message: string };

export interface WikiAnchorReportResult {
  spaceId: string;
  ref: string;
  outcomes: WikiAnchorOutcome[];
}

export interface WikiSpace {
  id: string;
  slug: string;
  title: string;
  repoUrlNorm: string | null;
  rootCommitSha: string | null;
  settings: WikiSpaceSettings;
  createdAt: string;
  updatedAt: string;
}

export interface WikiTopic {
  id: string;
  spaceId: string;
  slug: string;
  title: string;
  description: string | null;
  /** An entry anchored under one of these belongs to the topic. */
  pathPrefixes: string[];
}

/** One lineage, as its current revision says. Its id never changes across revisions: it is what
 *  `orbit-wiki:<id>` names. */
export interface WikiEntry {
  id: string;
  spaceId: string;
  kind: WikiEntryKind;
  status: WikiEntryStatus;
  trust: WikiTrust;
  currentRevision: number;
  title: string;
  summary: string;
  /** Shaped by the kind's schema ({@link WikiKindFields}). */
  fields: Record<string, unknown>;
  topics: string[];
  aliases: string[];
  anchors: WikiAnchor[];
  anchorState: WikiAnchorState;
  anchorCheckedRef: string | null;
  anchorCheckedAt: string | null;
  /** Web-derived content is among its sources. */
  tainted: boolean;
  /** A challenge is open against it. */
  challenged: boolean;
  /** Every first-hand source it had was deleted. */
  unsupported: boolean;
  pinned: boolean;
  supersedesId: string | null;
  supersededById: string | null;
  /** World time: when what it says became, and stopped being, true. */
  validFrom: string;
  validTo: string | null;
  /** System time: when it was recorded, and when it left the live set. */
  recordedAt: string;
  retiredAt: string | null;
}

export interface WikiEntryRevision {
  id: string;
  entryId: string;
  revision: number;
  title: string;
  summary: string;
  fields: Record<string, unknown>;
  topics: string[];
  aliases: string[];
  anchors: WikiAnchor[];
  contentSha256: string;
  authorKind: WikiAuthorKind;
  authorUserId: string | null;
  authorSessionId: string | null;
  authorToolCallId: string | null;
  changesetOpId: string | null;
  createdAt: string;
  sources?: WikiSource[];
}

export interface WikiChangesetOp {
  id: string;
  changesetId: string;
  seq: number;
  op: WikiOp;
  /** The entry the op is about; null for an add. */
  entryId: string | null;
  baseRevision: number | null;
  payload: Record<string, unknown>;
  similar: WikiSimilar[];
  tainted: boolean;
  decision: WikiOpDecision;
  decisionReason: WikiRejectReason | null;
  decisionNote: string | null;
  resultEntryId: string | null;
  resultRevision: number | null;
  decidedAt: string | null;
  /** The review mode that applied this op, or null when the effect policy decided it — and, in an
   *  Automatic space, null until a verdict applies it. */
  appliedByMode: Exclude<WikiReviewMode, 'manual'> | null;
  /** An op the review mode applied, drawn into Review for the owner to check after the fact. */
  spotCheck: boolean;
  /** The verdict an Automatic space's verification gave it, and who gave it when; null until one
   *  arrives, and for every op no verification decides (contract `reviewModes.verification.trail`). */
  verification?: WikiOpVerification | null;
  /** The trail of every earlier verdict of an op that was reopened, oldest first; empty for every
   *  other op (contract `reviewModes.verification.reopen`). */
  verificationHistory?: WikiOpVerificationHistory[];
}

/** One op's verification trail, as the op reads it back. */
export interface WikiOpVerification {
  verdict: WikiVerificationVerdict;
  /** The verifier's reason, in one sentence, redacted. */
  reason: string;
  /** The model that gave the verdict. */
  model: string;
  /** When the server recorded it. */
  at: string;
  /** The entry a duplicate named; null for every other verdict. */
  duplicateOf: string | null;
  /** What the verifier could read when the verdict was recorded; `unreadable` capped it at Unreviewed.
   *  Null for a verdict recorded before the server kept the mark (migration 0314). */
  evidence?: WikiVerificationEvidence | null;
}

/** An earlier verdict of a reopened op: its trail, what it decided, and when it was reopened. */
export interface WikiOpVerificationHistory extends WikiOpVerification {
  decision: WikiOpDecision;
  decisionReason: WikiRejectReason | null;
  decidedAt: string | null;
  reopenedAt: string;
}

/**
 * One op that waits for its verification, as `GET /api/runner/wiki/spaces/:id/verifications`
 * lists it: everything a verifier needs and nothing it does not (contract
 * `reviewModes.verification.list`).
 */
export interface WikiVerificationItem {
  opId: string;
  changesetId: string;
  op: 'add' | 'amend';
  /** An amend's entry; null for an add, whose lineage waits proposed. */
  entryId: string | null;
  /** The entry as it would read once applied: an add's draft, an amend's changes laid over its entry. */
  entry: { kind: WikiEntryKind; title: string; summary: string; fields: Record<string, unknown>; topics: string[]; aliases: string[] };
  /** Each source the op cites, with its record's text read now and redacted. */
  sources: Array<{
    kind: WikiSourceKind;
    ref: string;
    quote: string | null;
    /** Null when this database holds no text for the record (a commit), or it is gone. */
    text: string | null;
    /** The text was cut at `WIKI_REVIEW_RULES.verificationSourceMaxChars`. */
    truncated: boolean;
  }>;
  /** Whether any source above has text (contract `reviewModes.verification.evidence`). With none, a
   *  verdict would be about the claim alone: the server records whatever it says as no more than
   *  Unreviewed and keeps it out of the fallback's count. */
  evidence: WikiVerificationEvidence;
  /** The neighbours recorded with the op, each as it reads now: what a duplicate may name. */
  similar: WikiSimilar[];
}

/** What `reviewModes.verification.reopen` did in one space. */
export interface WikiReopenResult {
  spaceId: string;
  mode: WikiReviewMode;
  /** Ops an unsupported verdict rejected while none of their sources could be read, waiting for
   *  their verification again; each earlier verdict kept in the op's `verificationHistory`. */
  reopened: string[];
  /** Tainted ops that waited for the owner in an automatic space, now waiting for their verification. */
  toVerification: string[];
  /** Ops that qualified and were left as they are, with why. */
  skipped: Array<{ opId: string; reason: string }>;
}

export interface WikiVerificationList {
  spaceId: string;
  /** A verdict is recorded only while this is `automatic` (contract `reviewModes.verification.notAutomatic`). */
  mode: WikiReviewMode;
  items: WikiVerificationItem[];
  /** Pass as `after` for the next page; null when this page is the last. */
  next: string | null;
}

/** One verdict, as `POST /api/runner/wiki/spaces/:id/verifications` takes it. */
export interface WikiVerdictInput {
  opId: string;
  verdict: WikiVerificationVerdict;
  reason: string;
  model: string;
  /** Required for a duplicate: one of the op's own similar[], or an amend's own entry. */
  duplicateOf?: string;
}

/** What one verdict did. */
export type WikiVerificationOutcome =
  | {
      opId: string;
      status: 'applied' | 'rejected' | 'reinforced' | 'conflict';
      verdict: WikiVerificationVerdict;
      entryId: string | null;
      /** applied: the trust it applied with. */
      trust?: 'auto' | 'unreviewed';
      /** applied: drawn as a spot check (`settings.automaticSpotChecks`). */
      spotCheck?: boolean;
      /** reinforced: false when the space's autoAcceptReinforce held the sources back. */
      reinforced?: boolean;
      /** An op already verified the same way: its recorded answer, and nothing written. */
      replayed?: boolean;
    }
  | {
      opId: string;
      status: 'refused';
      /** What the door would have answered for this verdict alone: 400, 404 or 409. */
      httpStatus: number;
      /** The contract's code, when the refusal has one (WIKI_SCHEMA). */
      code?: WikiRefusalCode;
      message: string;
    };

export interface WikiVerificationReport {
  outcomes: WikiVerificationOutcome[];
  /** The space's mode after these verdicts: `tiered` when the fallback tripped on one of them. */
  mode: WikiReviewMode;
}

export interface WikiChangeset {
  id: string;
  spaceId: string;
  origin: WikiChangesetOrigin;
  sessionId: string | null;
  toolCallId: string | null;
  rationale: string | null;
  status: WikiChangesetStatus;
  createdAt: string;
  decidedAt: string | null;
  expiresAt: string | null;
  ops: WikiChangesetOp[];
}

/** What one changeset did, counted the way its page says it (contract `reviewModes.run.counts`). */
export interface WikiChangesetCounts {
  /** Ops whose effect stands from the changeset itself: what its mode applied, and what needed nobody. */
  applied: number;
  /** Of the applied adds and amends, those whose entry is now active with trust `auto`… */
  auto: number;
  /** …and with trust `unreviewed`. */
  unreviewed: number;
  /** Ops an `unsupported` or `duplicate` verdict rejected. */
  rejectedByCheck: number;
  /** Ops waiting for the owner in Review: its spot checks, and what the floors kept for the owner. */
  toReview: number;
}

/** What `POST /api/wiki/changesets/:id/revert` would undo if it were called now (contract `reviewModes.revert`). */
export interface WikiRevertPlan {
  /** Adds whose entry is still active: each is withdrawn. */
  adds: number;
  /** Entries an amend changed and nobody has changed since: each goes back to its previous revision. */
  amends: number;
}

/**
 * `GET /api/wiki/changesets/:id` — one changeset as a run's page reads it, whether or not anything of
 * it still waits in Review (contract `reviewModes.run`).
 */
export interface WikiChangesetView extends WikiChangeset {
  /** The review mode that applied any of its ops — `automatic` over `tiered` — or null when no mode
   *  applied any: a changeset that is no run. */
  appliedByMode: Exclude<WikiReviewMode, 'manual'> | null;
  /** Every entry its ops name, as it stands now. */
  entries: WikiEntry[];
  counts: WikiChangesetCounts;
  /** Whether Revert run… would take anything back now. */
  revertible: boolean;
  /** What it would take back; null when it would take back nothing. */
  revert: WikiRevertPlan | null;
}

/**
 * Where an entry's current revision came from, as `GET /api/wiki/entries/:id` adds it (contract
 * `reviewModes.run.entry`): the changeset whose op wrote it, the review mode that applied that op, and
 * that op's verdict. Each is null when there is none — a revision no op wrote, an op no mode applied,
 * an op no verification decided.
 */
export interface WikiEntryAppliedBy {
  changesetId: string | null;
  appliedByMode: Exclude<WikiReviewMode, 'manual'> | null;
  verification: WikiOpVerification | null;
}

/** The owner's answer to one pending op. `reject` names a reason; `edit` carries the owner's version. */
export interface WikiOpDecisionInput {
  opId: string;
  action: WikiDecideAction;
  edited?: WikiEntryChanges;
  reason?: WikiRejectReason;
  note?: string;
}

/** `POST /api/wiki/changesets/:id/decide` — the owner channel only. */
export interface WikiDecideRequest {
  decisions: WikiOpDecisionInput[];
}

/** Which session received which revision of which entry, and how. */
export interface WikiExposure {
  sessionId: string | null;
  entryId: string;
  revision: number;
  channel: WikiExposureChannel;
  at: string;
}

// ── Validation. Every check below reports every failing field, by path, and throws nothing. ──────

const ENTRY_KEYS = ['kind', 'title', 'summary', 'fields', 'topics', 'aliases', 'anchors'] as const;
const CHANGE_KEYS = ['title', 'summary', 'fields', 'topics', 'aliases', 'anchors'] as const;
const SOURCE_KEYS = ['kind', 'ref', 'session', 'seq', 'locator', 'quote'] as const;

/**
 * An add's or a supersede's entry: its kind, the common fields, its anchors, and its kind's fields.
 * Fields are not checked against a kind that does not exist or is reserved; only `kind` is reported.
 */
export function validateWikiEntryDraft(draft: unknown, path = ''): WikiFieldError[] {
  const errors: WikiFieldError[] = [];
  if (!isObject(draft)) {
    errors.push({ path, message: 'must be an object' });
    return errors;
  }
  unknownKeys(draft, ENTRY_KEYS, path, errors);
  const kind = checkKind(draft.kind, join(path, 'kind'), errors);
  checkCommon(draft, path, errors, true);
  if (absent(draft.fields)) errors.push({ path: join(path, 'fields'), message: 'is required' });
  else if (kind) errors.push(...KIND_SPECS[kind].validate(draft.fields, join(path, 'fields')));
  return errors;
}

/** An amend's changes, or the owner's edit in Review, for an entry of `kind`. */
export function validateWikiEntryChanges(changes: unknown, kind: WikiKind, path = 'changes'): WikiFieldError[] {
  const errors: WikiFieldError[] = [];
  if (!isObject(changes)) {
    errors.push({ path, message: 'must be an object' });
    return errors;
  }
  unknownKeys(changes, CHANGE_KEYS, path, errors);
  if (!CHANGE_KEYS.some((key) => !absent(changes[key]))) {
    errors.push({ path, message: `must change at least one of ${CHANGE_KEYS.join(', ')}` });
  }
  checkCommon(changes, path, errors, false);
  if (!absent(changes.fields)) errors.push(...KIND_SPECS[kind].validate(changes.fields, join(path, 'fields')));
  return errors;
}

/** An op's sources, as a proposer cites them. Whether each one resolves is the server's to check. */
export function validateWikiSources(sources: unknown, path = 'sources'): WikiFieldError[] {
  const errors: WikiFieldError[] = [];
  if (!Array.isArray(sources)) {
    errors.push({ path, message: 'must be a list' });
    return errors;
  }
  if (sources.length > WIKI_LIMITS.listMaxItems) {
    errors.push({ path, message: `must hold at most ${WIKI_LIMITS.listMaxItems} items` });
  }
  sources.forEach((source, i) => checkSource(source, `${path}[${i}]`, errors));
  return errors;
}

function checkKind(value: unknown, path: string, errors: WikiFieldError[]): WikiKind | null {
  if (typeof value === 'string' && (WIKI_KINDS as readonly string[]).includes(value)) return value as WikiKind;
  if (typeof value === 'string' && (WIKI_RESERVED_KINDS as readonly string[]).includes(value)) {
    errors.push({ path, message: `${value} is reserved for a later phase and is not written yet` });
  } else if (absent(value)) {
    errors.push({ path, message: 'is required' });
  } else {
    errors.push({ path, message: `must be one of ${WIKI_KINDS.join(', ')}` });
  }
  return null;
}

function checkCommon(value: Record<string, unknown>, path: string, errors: WikiFieldError[], required: boolean): void {
  checkText(value.title, join(path, 'title'), errors, { required, maxChars: WIKI_LIMITS.titleMaxChars });
  checkText(value.summary, join(path, 'summary'), errors, { required, maxChars: WIKI_LIMITS.summaryMaxChars });
  if (!absent(value.topics)) {
    const topics = join(path, 'topics');
    checkList(value.topics, topics, errors, WIKI_LIMITS.topicsMax, 0, (topic, at) =>
      checkText(topic, at, errors, { required: true, maxChars: WIKI_LIMITS.slugMaxChars, pattern: WIKI_SLUG_PATTERN }),
    );
  }
  if (!absent(value.aliases)) {
    checkList(value.aliases, join(path, 'aliases'), errors, WIKI_LIMITS.aliasesMax, 0, (alias, at) =>
      checkText(alias, at, errors, { required: true, maxChars: WIKI_LIMITS.aliasMaxChars }),
    );
  }
  if (!absent(value.anchors)) {
    checkList(value.anchors, join(path, 'anchors'), errors, WIKI_LIMITS.listMaxItems, 0, (anchor, at) =>
      checkAnchor(anchor, at, errors),
    );
  }
}

function checkAnchor(anchor: unknown, path: string, errors: WikiFieldError[]): void {
  if (!isObject(anchor)) {
    errors.push({ path, message: 'must be an object' });
    return;
  }
  const type = anchor.type;
  if (typeof type !== 'string' || !(WIKI_ANCHOR_TYPES as readonly string[]).includes(type)) {
    errors.push({ path: join(path, 'type'), message: `must be one of ${WIKI_ANCHOR_TYPES.join(', ')}` });
    return;
  }
  const fields = WIKI_ANCHOR_SPECS[type as WikiAnchorType].fields;
  unknownKeys(anchor, ['type', ...Object.keys(fields)], path, errors);
  for (const [key, schema] of Object.entries(fields)) checkField(schema, anchor[key], join(path, key), errors);
}

function checkSource(source: unknown, path: string, errors: WikiFieldError[]): void {
  if (!isObject(source)) {
    errors.push({ path, message: 'must be an object' });
    return;
  }
  unknownKeys(source, SOURCE_KEYS, path, errors);
  const kind = source.kind;
  if (typeof kind !== 'string' || !(WIKI_SOURCE_KINDS as readonly string[]).includes(kind)) {
    errors.push({
      path: join(path, 'kind'),
      message: `must be one of ${WIKI_SOURCE_KINDS.join(', ')}; a wiki entry is never a source`,
    });
  }
  const self = source.session === 'self';
  if (!absent(source.session) && (!self || kind !== 'turn')) {
    errors.push({ path: join(path, 'session'), message: "only a turn cites a session, and only as 'self'" });
  }
  if (self && kind === 'turn') {
    if (!absent(source.ref)) {
      errors.push({ path: join(path, 'ref'), message: "a turn of the calling session is named by session 'self', not by ref" });
    }
  } else {
    checkText(source.ref, join(path, 'ref'), errors, { required: true, maxChars: WIKI_LIMITS.fieldTextMaxChars });
  }
  if (!absent(source.seq)) {
    if (!self) errors.push({ path: join(path, 'seq'), message: "only sits beside session 'self'" });
    else checkInteger(source.seq, join(path, 'seq'), errors, 0, undefined);
  }
  if (!absent(source.locator) && !isObject(source.locator)) {
    errors.push({ path: join(path, 'locator'), message: 'must be an object' });
  }
  checkText(source.quote, join(path, 'quote'), errors, { required: false, maxChars: WIKI_LIMITS.quoteMaxChars });
}

function checkObject(
  schemas: WikiFieldSchemas,
  atLeastOneOf: readonly string[] | undefined,
  value: unknown,
  path: string,
  errors: WikiFieldError[],
): void {
  if (!isObject(value)) {
    errors.push({ path, message: 'must be an object' });
    return;
  }
  unknownKeys(value, Object.keys(schemas), path, errors);
  for (const [key, schema] of Object.entries(schemas)) checkField(schema, value[key], join(path, key), errors);
  if (atLeastOneOf && !atLeastOneOf.some((key) => holdsSomething(value[key]))) {
    errors.push({ path, message: `needs at least one of ${atLeastOneOf.join(', ')}` });
  }
}

function checkField(schema: WikiFieldSchema, value: unknown, path: string, errors: WikiFieldError[]): void {
  if (absent(value)) {
    if (schema.required) errors.push({ path, message: 'is required' });
    return;
  }
  switch (schema.type) {
    case 'text':
      checkText(value, path, errors, { required: true, maxChars: WIKI_LIMITS.fieldTextMaxChars, pattern: schema.pattern });
      return;
    case 'textList':
      checkList(value, path, errors, WIKI_LIMITS.listMaxItems, schema.minItems ?? 0, (item, at) =>
        checkText(item, at, errors, { required: true, maxChars: WIKI_LIMITS.fieldTextMaxChars }),
      );
      return;
    case 'date':
      if (typeof value !== 'string' || !isIsoDate(value)) {
        errors.push({ path, message: 'must be an ISO 8601 date (YYYY-MM-DD) that exists' });
      }
      return;
    case 'integer':
      checkInteger(value, path, errors, schema.min, schema.max);
      return;
    case 'object':
      checkObject(schema.fields, schema.atLeastOneOf, value, path, errors);
      return;
    case 'objectList':
      checkList(value, path, errors, WIKI_LIMITS.listMaxItems, schema.minItems ?? 0, (item, at) =>
        checkObject(schema.fields, undefined, item, at, errors),
      );
      return;
  }
}

function checkText(
  value: unknown,
  path: string,
  errors: WikiFieldError[],
  rule: { required: boolean; maxChars: number; pattern?: string },
): void {
  if (absent(value)) {
    if (rule.required) errors.push({ path, message: 'is required' });
    return;
  }
  if (typeof value !== 'string') {
    errors.push({ path, message: 'must be text' });
  } else if (value.trim() === '') {
    errors.push({ path, message: 'must not be blank' });
  } else if ([...value].length > rule.maxChars) {
    errors.push({ path, message: `must be at most ${rule.maxChars} characters` });
  } else if (rule.pattern !== undefined && !new RegExp(rule.pattern, 'u').test(value)) {
    errors.push({ path, message: `must match ${rule.pattern}` });
  }
}

function checkList(
  value: unknown,
  path: string,
  errors: WikiFieldError[],
  maxItems: number,
  minItems: number,
  each: (item: unknown, path: string) => void,
): void {
  if (!Array.isArray(value)) {
    errors.push({ path, message: 'must be a list' });
    return;
  }
  if (value.length > maxItems) errors.push({ path, message: `must hold at most ${maxItems} items` });
  if (value.length < minItems) errors.push({ path, message: `must hold at least ${minItems} item${minItems === 1 ? '' : 's'}` });
  value.forEach((item, i) => each(item, `${path}[${i}]`));
}

function checkInteger(value: unknown, path: string, errors: WikiFieldError[], min?: number, max?: number): void {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    errors.push({ path, message: 'must be a whole number' });
  } else if ((min !== undefined && value < min) || (max !== undefined && value > max)) {
    errors.push({ path, message: `must be between ${min ?? '-∞'} and ${max ?? '∞'}` });
  }
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2}))?$/u;

function isIsoDate(value: string): boolean {
  const m = ISO_DATE.exec(value);
  if (!m) return false;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return false;
  if (m[4] === undefined) return true;
  return Number(m[4]) <= 23 && Number(m[5]) <= 59 && (m[6] === undefined || Number(m[6]) <= 59);
}

function holdsSomething(value: unknown): boolean {
  return Array.isArray(value) ? value.length > 0 : typeof value === 'string' && value.trim() !== '';
}

function unknownKeys(value: Record<string, unknown>, known: readonly string[], path: string, errors: WikiFieldError[]): void {
  for (const key of Object.keys(value)) {
    if (!known.includes(key)) errors.push({ path: join(path, key), message: 'is not a field here' });
  }
}

/** null reads as absent, so a client that spells "no value" as null is not refused for it. */
function absent(value: unknown): boolean {
  return value === undefined || value === null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function join(path: string, key: string): string {
  return path === '' ? key : `${path}.${key}`;
}
