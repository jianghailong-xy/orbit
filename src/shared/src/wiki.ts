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

/** proposed → active → superseded | retired; proposed → rejected. The last three are terminal. */
export const WIKI_ENTRY_STATUSES = ['proposed', 'active', 'superseded', 'retired', 'rejected'] as const;
export type WikiEntryStatus = (typeof WIKI_ENTRY_STATUSES)[number];

export const WIKI_TRUST_LEVELS = ['owner', 'confirmed', 'proposed', 'external'] as const;
export type WikiTrust = (typeof WIKI_TRUST_LEVELS)[number];
/** Only these reach a session's `<orbit_wiki_context>`. */
export const WIKI_PUSHABLE_TRUST: readonly WikiTrust[] = ['owner', 'confirmed'];

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

/** An op is recorded `pending` or `auto_applied`; every other decision is final. */
export const WIKI_OP_DECISIONS = [
  'pending',
  'accepted',
  'edited',
  'rejected',
  'auto_applied',
  'conflict',
  'expired',
  'withdrawn',
] as const;
export type WikiOpDecision = (typeof WIKI_OP_DECISIONS)[number];

/** What the owner does with one pending op in Review. */
export const WIKI_DECIDE_ACTIONS = ['accept', 'edit', 'reject'] as const;
export type WikiDecideAction = (typeof WIKI_DECIDE_ACTIONS)[number];

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
  /** Ops one session may record in one turn, and in its whole life. */
  opsPerTurn: 5,
  opsPerSession: 15,
  /** Pending ops a space may hold; an op that applies at once never counts. */
  pendingOpsPerSpace: 30,
  /** A pending op expires after this many days. */
  pendingExpiryDays: 14,
  searchLimitMax: 10,
  getIdsMax: 10,
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
  check?: { state: WikiAnchorState; ref: string | null; at: string | null };
};

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
  /** `WIKI_SCHEMA`: every field that failed. */
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
}

/** One op's answer, by its 0-based position in `ops`. A dry run records nothing, so its ids are null. */
export type WikiOpOutcome =
  | { seq: number; status: 'pending'; opId: string | null; entryId: string | null; similar?: WikiSimilar[] }
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
}
export const WIKI_DEFAULT_SPACE_SETTINGS: Readonly<WikiSpaceSettings> = { push: true, autoAcceptReinforce: true };

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
