/**
 * The SOURCE chain's wire vocabulary — which commit a run starts from.
 *
 * `docs/project-source-contract.md` v1 is the single authority for every spelling here; this file
 * is the one place the control plane, the runner and the clients read it from, so that the
 * contract's "two implementations quoting the same contract" is a shared module rather than a
 * hope. Nothing below infers anything: a value that is not in the contract has no business being
 * in this file, and the contract self-check plus `source-protocol.spec.ts` assert both directions.
 */

/**
 * §6.1's four states. `UNBOUND` IS the Legacy path (SR45) and is the database column's default, so
 * every session that existed before migration 0231 reads it without being touched.
 */
export type SourceState = 'UNBOUND' | 'SELECTED' | 'PINNED' | 'REFUSED';

/** §4.1's five selector kinds — which of the priority table's rows produced this selector. */
export type SourceKind =
  | 'VERIFICATION_SUBJECT'
  | 'PINNED_REVISION'
  | 'TASK_KNOWN_GOOD'
  | 'DEPENDENCY_CLOSURE'
  | 'PROJECT_UPSTREAM';

/**
 * Where a ref → SHA resolution COUNTS (§2). Not "which machine runs it": authority is what decides
 * whether two runners resolve the same ref to the same commit (SR40).
 */
export type SourceRefAuthority = 'REMOTE' | 'RUNNER_LOCAL';

/**
 * §10.1's frozen table, in the table's own order. There is no "degrade silently" member, which is
 * the whole point: a refusal that cannot be named becomes a run that started somewhere nobody chose.
 */
export const SOURCE_REFUSAL_CODES = [
  'PROJECT_CODEBASE_UNBOUND',
  'BASE_REPO_MISMATCH',
  'SOURCE_AUTHORITY_UNREACHABLE',
  'BASE_REF_NOT_FOUND',
  'BASE_SHA_UNAVAILABLE',
  'DEPENDENCY_BASE_NOT_LANDED',
  'WORKTREE_REQUIRED',
  'SOURCE_PROTOCOL_UNSUPPORTED',
  'SOURCE_PIN_IMMUTABLE',
  'CODEBASE_AUTHORITY_INVALID',
] as const;

export type SourceRefusalCode = (typeof SOURCE_REFUSAL_CODES)[number];

/** §10.1's sixth column, closed (SR49): every value is something a person can actually do. */
export type SourceFixAction =
  | 'BIND_CODEBASE'
  | 'FIX_WORKSPACE_REPO'
  | 'RETRY_OR_FIX_CREDENTIALS'
  | 'FIX_REF'
  | 'RESTORE_COMMIT'
  | 'LAND_PREREQUISITE'
  | 'ENABLE_ISOLATION'
  | 'UPGRADE_RUNNER'
  | 'START_NEW_RUN'
  | 'FIX_CODEBASE_CONFIG';

/** Code → the one executable next step §10.1 pairs it with. */
export const SOURCE_FIX_ACTIONS: Readonly<Record<SourceRefusalCode, SourceFixAction>> = {
  PROJECT_CODEBASE_UNBOUND: 'BIND_CODEBASE',
  BASE_REPO_MISMATCH: 'FIX_WORKSPACE_REPO',
  SOURCE_AUTHORITY_UNREACHABLE: 'RETRY_OR_FIX_CREDENTIALS',
  BASE_REF_NOT_FOUND: 'FIX_REF',
  BASE_SHA_UNAVAILABLE: 'RESTORE_COMMIT',
  DEPENDENCY_BASE_NOT_LANDED: 'LAND_PREREQUISITE',
  WORKTREE_REQUIRED: 'ENABLE_ISOLATION',
  SOURCE_PROTOCOL_UNSUPPORTED: 'UPGRADE_RUNNER',
  SOURCE_PIN_IMMUTABLE: 'START_NEW_RUN',
  CODEBASE_AUTHORITY_INVALID: 'FIX_CODEBASE_CONFIG',
};

/**
 * SR35's capability token, spelled exactly as the contract spells it.
 *
 * A runner that does not declare it is never handed a session whose `sourceState` is anything but
 * `UNBOUND`. That is the entire compatibility story and it has to be a REFUSAL rather than a
 * negotiation: an older runner would receive `source`, not understand the field, and start from the
 * workDir's HEAD — which is precisely the silent baseline this contract exists to remove. Unlike
 * `allowOrchestration`, there is no half of this feature that can be turned off and still be safe.
 */
export const SESSION_SOURCE_PIN_V1 = 'source-pin/v1';

/**
 * What the runner is told when it claims a session whose SOURCE was resolved (§6.3 step 1).
 *
 * The nine selector fields are the INTENT, frozen in the same INSERT as the session row (SR28); the
 * pin is the FACT and is absent until the first claim froze it. A runner reading `state: 'PINNED'`
 * must use `baseSha` and resolve nothing (SR29) — that is what makes resume, reclaim and takeover
 * land on the same commit as the original run.
 */
export interface SessionSourceSnapshot {
  state: SourceState;
  kind: SourceKind;
  /** The `ProjectCodebase` this resolved against, as it was AT resolution (no foreign key). */
  codebaseId: string;
  /** Repository identity (§7.1), denormalised and frozen: editing the binding cannot reach here. */
  repoUrl: string;
  /** Second half of the identity. Absent when the repository's root commit is not observed yet. */
  rootCommitSha?: string;
  /** Full-name ref for a ref-valued selector. Exactly one of `ref` / `revisionSha` is present. */
  ref?: string;
  /** The commit for a SHA-valued selector (`VERIFICATION_SUBJECT`, `TASK_KNOWN_GOOD`, a pinned SHA). */
  revisionSha?: string;
  /** The binding's configuration version at resolution — a counter, never a git object (SR6). */
  configRevision: string;
  refAuthority: SourceRefAuthority;
  /** Remote to ask when `refAuthority` is `REMOTE`. */
  remoteName?: string;
  /** The machine whose local checkout is authoritative when `refAuthority` is `RUNNER_LOCAL`. */
  authorityRunnerId?: string;
  /** Commits the baseline MUST contain (gate G5). Empty until the dependency closure fills it. */
  requiredContains: string[];
  /** The pin, once frozen. Present exactly when `state` is `PINNED`. */
  baseSha?: string;
  resolvedAt?: string;
  resolvedByRunnerId?: string;
  /** Present exactly when `state` is `REFUSED`. */
  refusalCode?: SourceRefusalCode;
}

/**
 * Runner → control plane, §6.3 step 3: the answer the machine that owns the repository reached.
 *
 * Exactly one half is sent. `baseSha` asks for the compare-and-set that freezes the pin; `refusal`
 * reports that the admission gate stopped, and carries the code that says which level did.
 */
export interface SourcePinRequest {
  /** The resolved commit — full 40-hex, lowercase. Rejected in any other shape. */
  baseSha?: string;
  refusal?: {
    code: SourceRefusalCode;
    /** Structured diagnosis (§10.1's fifth column). Display only; never an input to a decision. */
    detail?: Record<string, unknown>;
  };
}

/**
 * Control plane → runner: what is frozen NOW, which is not always what this runner asked for.
 *
 * A loser of the compare-and-set receives the WINNER's pin with `wonRace: false` (SR30) — a
 * worktree already exists on that commit, so adopting it is the only answer that keeps one session
 * to one baseline. The runner logs the divergence and uses `baseSha` regardless.
 */
export interface SourcePinResponse {
  state: SourceState;
  baseSha?: string;
  resolvedAt?: string;
  resolvedByRunnerId?: string;
  refusalCode?: SourceRefusalCode;
  /** False when this request lost the race (or arrived at an already-frozen session). */
  wonRace: boolean;
}
