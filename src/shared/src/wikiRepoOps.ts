// The repository operations the wiki's server-side pipelines ask a runner to perform (contracts/wiki.contract.json
// `repoOps`, docs/wiki-server-execution-design.md §4.3 and §7): the server never touches a repository — the
// credentials live on the runners — so a job that needs to know what the repository says asks the machine its
// space's workspace runs on, and gets an answer back through a row. wikiContract.spec.ts holds every constant
// below to the contract JSON.

/**
 * The capability a runner declares before it is handed any repository operation (design §7). Its Go twin is
 * `wikiRepoOpCapabilityV1` in `src/runner-go/wiki_repo_ops.go`: a runner that does not declare this is handed
 * nothing, the step that needs the repository waits, and the space's health line says to upgrade it.
 */
export const WIKI_REPO_OP_CAPABILITY = 'wiki-repo-op/v1';

/**
 * What a repository operation asks for (contract `repoOps.kinds`). Four questions, and no fifth: a pipeline
 * that needs more than these changes this list first.
 */
export const WIKI_REPO_OP_KINDS = ['snapshot', 'read', 'diff', 'anchors'] as const;
export type WikiRepoOpKind = (typeof WIKI_REPO_OP_KINDS)[number];

/** Where an operation is (contract `repoOps.states`). A settled row is terminal; the row is the record. */
export const WIKI_REPO_OP_STATES = ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const;
export type WikiRepoOpState = (typeof WIKI_REPO_OP_STATES)[number];

/** The states a runner may report; the other three are the server's own. */
export const WIKI_REPO_OP_RESULT_STATES = ['succeeded', 'failed'] as const;
export type WikiRepoOpResultState = (typeof WIKI_REPO_OP_RESULT_STATES)[number];

/**
 * The numbers the repository operations are dispatched, read, chunked and cached by (contract `repoOps`).
 *
 * The read limits are the ones the pipelines already read by on the runner side, kept as they are
 * (`src/runner-go/wiki_docs_build.go`): one design-document section is 4,200 characters, one contract file
 * 2,500, and one request — one section's material — is 22,000 in all. A footnote check reads a whole file
 * instead of a section, which is its own case and its own limit: one file may fill the whole 22,000.
 */
export const WIKI_REPO_OPS = {
  /** Operations one heartbeat may claim. Two, for the reason the integration queue takes two per beat. */
  perHeartbeat: 2,
  /**
   * How long a claim is good for without a heartbeat. A runner renews its operation's `heartbeat_at` while it
   * works, so a row silent for longer than this belongs to a process that stopped — and another process on
   * the same machine may take it over under a new generation.
   */
  staleSeconds: 60,
  /** The body the API accepts, and therefore the largest one request may be (`src/apiserver/src/main.ts`). */
  apiBodyBytes: 10 * 1024 * 1024,
  /** Above this, a snapshot travels in fragments rather than inside the result. */
  inlineBytes: 4 * 1024 * 1024,
  /** One fragment's payload. Small enough that its JSON body stays far below `apiBodyBytes`. */
  fragmentBytes: 2 * 1024 * 1024,
  /** The most one snapshot may be, fragments and all; larger ones are refused (nothing asks for one). */
  maxSnapshotBytes: 64 * 1024 * 1024,
  /** A design-document section, as a docs build reads one. */
  docSectionChars: 4200,
  /** A contract file, as a docs build reads one. */
  contractChars: 2500,
  /** One request's whole material — one section — and the most one item may ask for. */
  sectionChars: 22000,
  /** A whole file, as a footnote check reads one: its own case, its own limit. */
  wholeFileChars: 22000,
  /** How often a job waiting on an operation polls, when no announcement reached it. */
  pollSeconds: 2,
} as const;

/**
 * What the space's repository steps depend on, as the health line reads it (contract `repoOps`,
 * design §2.2): the steps run on the server, which holds no repository, so they ask the machine the
 * space's workspace runs on — and this is whether that machine can be asked.
 *
 *   ready            the workspace's runner is there, beating, and has declared the capability;
 *   no_workspace     the space names no workspace, or the one it names is gone or has no working directory;
 *   runner_missing   the workspace is not bound to a machine;
 *   runner_offline   the machine is not beating;
 *   runner_upgrade   the machine is beating but is too old to be given repository work — upgrade it.
 */
export const WIKI_REPO_LOOKS = [
  'ready',
  'no_workspace',
  'runner_missing',
  'runner_offline',
  'runner_upgrade',
] as const;
export type WikiRepoLook = (typeof WIKI_REPO_LOOKS)[number];

/** What one `read` item asks for (contract `repoOps.kinds.read`). */
export interface WikiRepoOpReadItem {
  /** The path at the sha. */
  path: string;
  /** One section of it, by heading, as the plan's and the docs' gates name one; absent reads the file. */
  section?: string;
  /** The most characters of it to answer with; absent gets the path's default. */
  maxChars?: number;
}

/** The most characters one read item gets when it names no limit: a contract's 2,500, anything else 4,200. */
export function wikiRepoOpDefaultChars(path: string): number {
  return path.startsWith('contracts/') || path.endsWith('.json')
    ? WIKI_REPO_OPS.contractChars
    : WIKI_REPO_OPS.docSectionChars;
}

/**
 * What a snapshot answers with, in the result: the commit it read and the payload's shape. The payload itself
 * is the space's snapshot cache and is not echoed back (design §9: it is the owner's data, and the pipeline
 * that asked reads it from the cache).
 */
export interface WikiRepoOpSnapshotResult {
  sha: string;
  /** The payload's size in bytes, and its sha256 — what the fragments reassemble to. */
  bytes: number;
  digest: string;
  /** How many fragments carried it; 1 when it travelled inside the result. */
  fragments: number;
  /** The payload itself, when it fitted (`inlineBytes`). */
  index?: string;
  /** True when the server already held this sha, so nothing was built and nothing was sent. */
  skipped?: boolean;
}

/** The heartbeat's half of the queue: one repository operation a runner has just claimed. */
export interface WikiRepoOpCommand {
  /** The row's UUID, echoed byte-for-byte (never a public id). */
  id: string;
  kind: WikiRepoOpKind;
  /** Increases on every claim or takeover; results are fenced to (leaseOwner, claimGeneration). An
   *  integer, not a bigint spelled as a string: it counts claims of one row, and the runner hands the
   *  same number back. */
  claimGeneration: number;
  /** The process this claim belongs to: the heartbeat's own `leaseOwner`. */
  leaseOwner: string;
  /** The checkout to read: the workspace's working directory, `~` and all, expanded by the runner. */
  workDir: string;
  /** The space's repository as it is recorded, for the check every operation makes before it reads (design §7). */
  repoUrlNorm: string | null;
  rootCommitSha: string | null;
  /** What the kind reads — a snapshot's `{ skipSha? }`, a read's `{ sha, items }`, and so on. */
  input: Record<string, unknown>;
}

/** Runner → control plane: the renewal of a long operation (POST /runner/wiki/repo-ops/:id/progress). */
export interface WikiRepoOpProgressRequest {
  claimGeneration: number;
  leaseOwner: string;
}

/** Runner → control plane: one fragment of a snapshot too large to travel inside the result. */
export interface WikiRepoOpFragmentRequest {
  claimGeneration: number;
  leaseOwner: string;
  /** The commit the fragments are of, repeated on each so a reassembled payload names its sha. */
  sha: string;
  index: number;
  total: number;
  content: string;
}

/** Runner → control plane: what the operation came to (POST /runner/wiki/repo-ops/:id/result). */
export interface WikiRepoOpResultRequest {
  claimGeneration: number;
  leaseOwner: string;
  state: WikiRepoOpResultState;
  /** The kind's answer; absent on a failure. */
  result?: Record<string, unknown> | null;
  /** Why it failed, in the runner's words — a repository that is not the space's, a git that refused. */
  error?: string | null;
}

/** Control plane → runner: the result was taken. */
export interface WikiRepoOpResultResponse {
  accepted: boolean;
  state: WikiRepoOpState;
}

/**
 * What a waiting job last read about its operation, and the reason it stopped waiting. The worker's wait
 * resolves with this: `WAITING` never resolves (the caller's own timeout does), the rest are answers.
 */
export interface WikiRepoOpWaitResult {
  state: WikiRepoOpState;
  result: Record<string, unknown> | null;
  error: string | null;
}
