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
 * The capability a runner declares when its `read` answers with whole files (owner 2026-10-08, design §7). Its
 * Go twin is `wikiRepoOpReadCapabilityV1` in `src/runner-go/wiki_repo_ops.go`. A runner that declares only
 * `wiki-repo-op/v1` still reads, but with the old window: at most `WIKI_REPO_OPS.boundedChars` characters an
 * item, its end marked truncated — and the space's health line gives the same runner-upgrade reason it gives a
 * machine with no repository capability at all.
 */
export const WIKI_REPO_OP_READ_CAPABILITY = 'wiki-repo-op-read/v1';

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
 * WHAT IS A READ LIMIT AND WHAT IS A CUTTING RULE. A read answers with the whole file at the sha (owner
 * 2026-10-08): one file may be `wholeFileBytes` (2 MB), and anything larger is missing with the reason
 * `too_large`. The numbers a pipeline gives the model — one design-document section is `docSectionChars`
 * (4,200), one contract file `contractChars` (2,500), one section's material `sectionChars` (22,000) — are
 * cutting rules the server applies to the text it holds, not read limits. A runner that has not declared
 * `wiki-repo-op-read/v1` answers with the old window instead: `boundedChars` (22,000) an item and
 * `sectionChars` a request.
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
  /** A design-document section, as a server-side cut of a whole file gives one to a model. */
  docSectionChars: 4200,
  /** A contract file, as a server-side cut of a whole file gives one to a model. */
  contractChars: 2500,
  /** One section's whole material — what the server cuts, and what one bounded (old-runner) request answers. */
  sectionChars: 22000,
  /** The most one read item may answer with: the whole file, up to this. Larger is `too_large`. */
  wholeFileBytes: 2 * 1024 * 1024,
  /** The window a runner without `wiki-repo-op-read/v1` answers with: the old `wholeFileChars`. */
  boundedChars: 22000,
  /** How much material one read operation is packed with, by the sizes the snapshot gives. */
  operationBytes: 4 * 1024 * 1024,
  /** How often a job waiting on an operation polls, when no announcement reached it. */
  pollSeconds: 2,
  /**
   * How long a running operation's claim may stay silent before the worker's sweep settles it `failed`. A
   * runner renews a claim only by staging fragments; its fetch is bounded at five minutes, every other git
   * command at two, and it reports a result inside that window and no further — this many seconds counted
   * from the claim, less a 30-second guard, with no send started outside it (src/runner-go/wiki_repo_op_retry.go);
   * no job waits longer than 300 seconds for one operation. A claim silent for fifteen minutes belongs to a
   * runner that gave up on it or is gone, and the answer of one still working would reach nobody: its late
   * result is answered with the row's state.
   */
  abandonedSeconds: 900,
} as const;

/**
 * How the server keeps a text it was handed (contract `repoOps.storedText`): `text` as it is, or `base64` — the
 * text's UTF-8 bytes in base64 — when Postgres cannot hold it as it is. `text` and `jsonb` both refuse U+0000
 * (a file with a NUL in it, 2026-10-09: 22P05), so a file's text that has one is kept as its bytes, and read
 * back byte for byte. The column or the key beside the text says which (`wiki_repo_file.content_encoding`,
 * the model queue's `request.encoding`).
 */
export const WIKI_STORED_TEXT_ENCODINGS = ['text', 'base64'] as const;
export type WikiStoredTextEncoding = (typeof WIKI_STORED_TEXT_ENCODINGS)[number];

/**
 * What one file's text is, as the server holds it at a (space, sha, path) — the read cache
 * (`wiki_repo_file`, contract `repoOps.cache`).
 *
 *   found      the whole file, as the runner answered it;
 *   cut        the first whole lines of the old window (`boundedChars`), from a runner without the whole-file
 *              capability: enough for that path, and a miss for a runner that can read the whole file;
 *   missing    the commit has no such path;
 *   too_large  the file is over `wholeFileBytes`: missing, with the reason kept.
 */
export const WIKI_REPO_FILE_STATES = ['found', 'cut', 'missing', 'too_large'] as const;
export type WikiRepoFileState = (typeof WIKI_REPO_FILE_STATES)[number];

/** One cached file, as a pipeline reads it back. */
export interface WikiRepoFileRead {
  path: string;
  state: WikiRepoFileState;
  /** The text, for `found` and `cut`; empty otherwise. */
  text: string;
  /** The file's size in bytes at the sha, as the runner answered it. */
  sizeBytes: number;
}


/**
 * What the space's repository steps depend on, as the health line reads it (contract `repoOps`,
 * design §2.2): the steps run on the server, which holds no repository, so they ask the machine the
 * space's workspace runs on — and this is whether that machine can be asked.
 *
 *   ready            the workspace's runner is there, beating, and has declared the capability;
 *   no_workspace     the space names no workspace, or the one it names is gone or has no working directory;
 *   runner_missing   the workspace is not bound to a machine;
 *   runner_offline   the machine is not beating;
 *   runner_upgrade   the machine is beating but has to be upgraded — it cannot be handed repository work at
 *                    all without `wiki-repo-op/v1`, and with only that it reads the old bounded window
 *                    (`WIKI_REPO_OPS.boundedChars`) instead of whole files.
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
  /**
   * The most characters of it to answer with. Absent (the whole-file read) answers the whole file, up to
   * `WIKI_REPO_OPS.wholeFileBytes`; a number is the bounded read an older control plane asks for, and a runner
   * without the whole-file capability cuts there whatever it is asked (`WIKI_REPO_OPS.boundedChars`).
   */
  maxChars?: number;
}

/**
 * The most characters one item of a BOUNDED read gets when it names no limit: a contract's 2,500, anything else
 * 4,200 — the numbers the runner's own default uses. A whole-file runner ignores the default: with no `maxChars`
 * its answer is the whole file.
 */
export function wikiRepoOpDefaultChars(path: string): number {
  return path.startsWith('contracts/') || path.endsWith('.json')
    ? WIKI_REPO_OPS.contractChars
    : WIKI_REPO_OPS.docSectionChars;
}

/**
 * What a read answers with: the commit it read at and what it made of each item. Above `WIKI_REPO_OPS.inlineBytes`
 * the answer travels in fragments instead, and the result names the payload's shape — `sha`, `bytes`, `digest`
 * and `fragments` — with the items inside the payload.
 */
export interface WikiRepoOpReadAnswer {
  sha: string;
  items: WikiRepoOpReadPiece[];
  chars: number;
}

/** One item of a read's answer, as the runner wrote it. */
export interface WikiRepoOpReadPiece {
  path: string;
  section?: string;
  /** The file is at the sha and within `wholeFileBytes` (or cut to the bounded window). */
  found: boolean;
  /** Why it is not: `too_large` for a file over `wholeFileBytes`. Absent when there is no reason to give. */
  reason?: string;
  /** The file's size in bytes at the sha, as the runner read it. */
  size?: number;
  text?: string;
  /** The answer was cut at the bounded window, so its end is not the file's. */
  truncated?: boolean;
  chars: number;
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
