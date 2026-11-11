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
 * The capability a runner declares when it reads a working directory that is not a git checkout as a folder
 * (docs/wiki-repo-tiers-design.md §4.3, contract `repoOps.folderCapability`). Its Go twin is `wikiRepoOpFolderCapabilityV1`
 * in `src/runner-go/wiki_repo_folder.go`. The server writes `allowFolder: true` into an operation's input only for a runner
 * that declares it; one that does not answers a folder not_git as before, and the run is on tier sessions.
 */
export const WIKI_REPO_OP_FOLDER_CAPABILITY = 'wiki-repo-op-folder/v1';

/**
 * The capability a runner declares when it answers the `probe` kind (docs/wiki-repo-tiers-design.md §7.3, contract
 * `repoOps.probeCapability`). Its Go twin is `wikiRepoOpProbeCapabilityV1` in `src/runner-go/wiki_repo_probe.go`. A runner
 * that does not declare it is asked nothing: an older one would fetch before it found it does not know the kind, so the
 * settings form says it could not check instead.
 */
export const WIKI_REPO_OP_PROBE_CAPABILITY = 'wiki-repo-op-probe/v1';

/** What the health line says of a folder that is not git when the runner cannot read folders yet (design §4.3). */
export const WIKI_REPO_UPGRADE_TO_READ_FOLDERS = 'Upgrade the runner to read folders';

/**
 * The folder tier's numbers and rules (contract `repoOps.folder`, docs/wiki-repo-tiers-design.md §2.3 and §4):
 *
 *   exclude         read before any .gitignore, and no .gitignore takes one back — secrets and build output;
 *   maxFiles        the most files a folder may have after its exclusions: more is no snapshot, `too_many_files`;
 *   minPathOverlap  a folder's snapshot shares at least this share of the last snapshot's paths, or it is another
 *                   directory's: not kept, and the run is on tier `wrong_repository` for `path_overlap`.
 */
export const WIKI_REPO_FOLDER = {
  exclude: [
    '.git/', '.env', '.env.*', '*.pem', '*.key', '*.p12', 'id_rsa*', 'id_ed25519*', '.ssh/', '.aws/', '.npmrc', '.netrc',
    'node_modules/', '.venv/', 'venv/', '__pycache__/', 'target/', 'dist/', 'build/', '.next/', '.gradle/', 'DerivedData/',
  ],
  maxFiles: 100_000,
  minPathOverlap: 0.5,
} as const;

/** What a snapshot was read from (`wiki_repo_snapshot.source`, migration 0521): a git commit, or a folder's tree hash. */
export const WIKI_REPO_SNAPSHOT_SOURCES = ['git', 'folder'] as const;
export type WikiRepoSnapshotSource = (typeof WIKI_REPO_SNAPSHOT_SOURCES)[number];

/**
 * How much of the last snapshot's paths a new one still has (design §2.3): |new ∩ last| / |last|. 1 when the last
 * snapshot had no paths, which nothing can be compared with.
 */
export function wikiRepoPathOverlap(last: Iterable<string>, next: Iterable<string>): number {
  const now = new Set(next);
  let total = 0;
  let shared = 0;
  for (const path of new Set(last)) {
    total += 1;
    if (now.has(path)) shared += 1;
  }
  return total === 0 ? 1 : shared / total;
}

/**
 * What a repository operation asks for (contract `repoOps.kinds`). Four questions a job asks, and the probe the
 * maintenance settings ask (P3): which tier a working directory would be read on, with no job behind it. A pipeline
 * that needs more than these changes this list first.
 */
export const WIKI_REPO_OP_KINDS = ['snapshot', 'read', 'diff', 'anchors', 'probe'] as const;
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

/**
 * How much of the repository a maintenance run read (contract `repoOps.tiers`, docs/wiki-repo-tiers-design.md §2):
 *
 *   git               a git checkout of the space's repository, read at origin/main as always;
 *   folder            a directory that is not a git checkout, scanned as it stands, named by its tree hash;
 *   sessions          nothing could be read: the run learns from the sessions alone, and the code checks wait;
 *   wrong_repository  what was read is another repository's: its origin, its first commit, or — a folder — its paths.
 *
 * The tier is what the run found, not a setting: the run row keeps it (`wiki_maintenance_run.repo_tier`).
 */
export const WIKI_REPO_TIERS = ['git', 'folder', 'sessions', 'wrong_repository'] as const;
export type WikiRepoTier = (typeof WIKI_REPO_TIERS)[number];

/**
 * Why a repository could not be read, and what that means (contract `repoOps.reasons`, docs/wiki-repo-tiers-design.md §6).
 *
 * A PREMISE is a fact about the space's machine or folder that asking again does not change: the run reads what it can
 * without the repository at once, tries nothing again, and asks the runner nothing more. The readiness the server reads
 * itself (`no_workspace`, `runner_*`), and what a runner's failed snapshot names: no working directory, a directory that
 * is not there, one that is not git (an old runner, or the folder tier not on), too many files to scan, another
 * repository's checkout (`wrong_repository`, `root_mismatch`, `path_overlap`), or a credential the remote refused.
 */
export const WIKI_REPO_PREMISE_REASONS = [
  'no_workspace', 'no_work_dir', 'not_found', 'not_git', 'too_many_files',
  'wrong_repository', 'root_mismatch', 'path_overlap', 'fetch_refused',
  'runner_offline', 'runner_missing', 'runner_upgrade',
] as const;

/**
 * A TRANSIENT failure is worth another try: the network's fetch (`fetch_failed`), an operation that did not settle within
 * the run's wait (`op_timeout`), a runner that went silent holding it (`runner_lost`), a folder that changed under a read
 * (`folder_moved`), and any failure a runner names no reason for (`op_failed`). It is tried again on the infra backoff, at
 * most `WIKI_REPO_PROBE.maxAttempts` times a run; then the run goes on without the repository, for the last one's reason.
 */
export const WIKI_REPO_TRANSIENT_REASONS = ['fetch_failed', 'op_timeout', 'runner_lost', 'folder_moved', 'op_failed'] as const;

/** The premises that say what was read is another repository's: the run is on tier `wrong_repository`, not `sessions`. */
export const WIKI_REPO_WRONG_REPOSITORY_REASONS = ['wrong_repository', 'root_mismatch', 'path_overlap'] as const;

/** Every reason a run reads less than git for (contract `repoOps.reasons`): the run row's `repo_reason`. */
export const WIKI_REPO_TIER_REASONS = [...WIKI_REPO_PREMISE_REASONS, ...WIKI_REPO_TRANSIENT_REASONS] as const;
export type WikiRepoTierReason = (typeof WIKI_REPO_TIER_REASONS)[number];

/**
 * How a maintenance run's probe is tried (contract `repoOps.probe`): a transient failure at most `maxAttempts` attempts.
 * `waitSeconds` is how long the settings' probe (`POST /api/wiki/spaces/:id/maintenance/probe`, and Turn on's check)
 * waits for the runner's answer before it says it could not check.
 */
export const WIKI_REPO_PROBE = { maxAttempts: 3, waitSeconds: 15 } as const;

/**
 * The words of a failure from a runner that names no reason — every runner before the reasons, and the server's own
 * closing of an operation whose runner went silent (`failAbandonedWikiRepoOps`) — read as the reason they say.
 */
const WIKI_REPO_REASON_WORDS: ReadonlyArray<readonly [RegExp, WikiRepoTierReason]> = [
  [/names no working directory/u, 'no_work_dir'],
  [/ is not a git checkout\b/u, 'not_git'],
  [/ is a clone of .*, not of the space's repository/u, 'wrong_repository'],
  [/does not start from the space's first commit/u, 'root_mismatch'],
  [/git authentication failed/u, 'fetch_refused'],
  [/could not fetch origin's default branch/u, 'fetch_failed'],
  [/the runner's claim has been silent since/u, 'runner_lost'],
];

/**
 * Why a failed repository operation failed: the reason its runner named when it is one of the contract's, else what its
 * words say (an old runner's), else `op_failed` — which is transient, so a failure nobody could name is tried again.
 */
export function wikiRepoFailureReason(reason: unknown, error: string | null | undefined): WikiRepoTierReason {
  if (typeof reason === 'string' && (WIKI_REPO_TIER_REASONS as readonly string[]).includes(reason)) return reason as WikiRepoTierReason;
  for (const [words, named] of WIKI_REPO_REASON_WORDS) if (words.test(error ?? '')) return named;
  return 'op_failed';
}

/** A reason is a premise: asking again does not change it (`WIKI_REPO_PREMISE_REASONS`). */
export function wikiRepoReasonIsPremise(reason: WikiRepoTierReason): boolean {
  return (WIKI_REPO_PREMISE_REASONS as readonly string[]).includes(reason);
}

/**
 * The reasons somebody has to set right (docs/wiki-repo-tiers-design.md §6, the red rows): another repository's folder,
 * or a credential the remote refused. The health line draws them red, and a streak of them tells the owner once
 * (contract `maintenance.health.notifyRepository`).
 */
export const WIKI_REPO_ATTENTION_REASONS = ['wrong_repository', 'root_mismatch', 'path_overlap', 'fetch_refused'] as const;

/** A reason is one somebody has to set right (`WIKI_REPO_ATTENTION_REASONS`). */
export function wikiRepoReasonNeedsAttention(reason: string | null | undefined): boolean {
  return (WIKI_REPO_ATTENTION_REASONS as readonly string[]).includes(reason ?? '');
}

/**
 * A working directory as a person reads it: a home directory as `~`, so the line says `~/work/app` and no account name.
 */
export function wikiRepoDirLabel(dir: string | null | undefined): string | null {
  const trimmed = (dir ?? '').trim();
  if (!trimmed) return null;
  return trimmed.replace(/^(?:\/Users|\/home)\/[^/]+(?=\/|$)/u, '~').replace(/^\/root(?=\/|$)/u, '~');
}

/**
 * Why a repository could not be read, as one English sentence (contract `maintenance.health.repo.detail`): what the
 * health line says after `Code checks paused:`, and the whole red part. `dir` is the workspace's working directory,
 * `runner` the machine's name, `said` the runner's own words, which name the other repository's address.
 */
export function wikiRepoDetail(
  reason: WikiRepoTierReason,
  where: { dir?: string | null; runner?: string | null; said?: string | null } = {},
): string {
  const dir = wikiRepoDirLabel(where.dir) ?? 'The folder';
  const runner = (where.runner ?? '').trim() || null;
  const on = runner ? ` on ${runner}` : '';
  switch (reason) {
    case 'no_workspace': return 'No workspace is chosen for maintenance';
    case 'no_work_dir': return 'The workspace has no working directory';
    case 'not_found': return `${dir} was not found${on}`;
    case 'not_git': return `${dir} is not a git checkout`;
    case 'too_many_files': return `${dir} has too many files to read`;
    case 'wrong_repository': {
      // A git checkout with no origin remote (design §2.1): nothing says which repository it is.
      if (/ has no origin remote, so it cannot be checked against /u.test(where.said ?? '')) {
        return `${dir} has no origin remote, so it cannot be checked against this wiki's repository`;
      }
      const clone = /is a clone of (\S+?),? not of/u.exec(where.said ?? '')?.[1];
      return clone
        ? `${dir} is a clone of ${clone}, not this wiki's repository`
        : `${dir} is not a clone of this wiki's repository`;
    }
    case 'root_mismatch': return `${dir} does not share this wiki's first commit`;
    case 'path_overlap': return `${dir} shares few files with the last snapshot`;
    case 'fetch_refused': return `The git remote refused the credentials${on}`;
    case 'runner_offline': return 'Waiting for the runner to come online';
    case 'runner_missing': return 'The workspace is not on a runner';
    case 'runner_upgrade': return 'Upgrade the runner to read the repository';
    case 'fetch_failed': return `Could not fetch from the git remote${on}`;
    case 'op_timeout': return `${runner ?? 'The runner'} did not answer in time`;
    case 'runner_lost': return `${runner ?? 'The runner'} stopped answering`;
    case 'folder_moved': return `${dir} changed while it was read`;
    case 'op_failed':
    default:
      return `Reading ${wikiRepoDirLabel(where.dir) ?? 'the folder'} failed`;
  }
}

/**
 * What the health line says of tier folder (contract `maintenance.health.repo.detail`): a folder that is not git, or a git
 * checkout with no origin remote, which a space with no repository address reads as a folder (design §2.1).
 */
export function wikiRepoFolderDetail(where: { dir?: string | null; noOrigin?: boolean } = {}): string {
  return where.noOrigin === true
    ? `${wikiRepoDirLabel(where.dir) ?? 'The folder'} has no origin remote, so it is read as a folder`
    : wikiRepoDetail('not_git', where);
}

// ── The settings' probe (docs/wiki-repo-tiers-design.md §7.3) ───────────────────────────────────

/**
 * How the settings form draws a probe's answer, under the workspace picker:
 *
 *   ok         green: a git checkout of the space's repository;
 *   folder     purple: a folder that is not git — read as it stands, commit anchors not checked;
 *   paused     amber: nothing can be read there now — maintenance learns from sessions, code checks wait;
 *   wrong      red: another repository's checkout — maintenance cannot be turned on with it;
 *   unchecked  grey: the runner could not be asked — offline, too old, or silent — and Turn on is still allowed.
 */
export const WIKI_REPO_PROBE_TONES = ['ok', 'folder', 'paused', 'wrong', 'unchecked'] as const;
export type WikiRepoProbeTone = (typeof WIKI_REPO_PROBE_TONES)[number];

/** The probe's fixed words (English, as every client draws them). */
export const WIKI_REPO_PROBE_COPY = {
  folderTitle: 'Folder, not git',
  folderNote: 'Entries and code checks work. Commit anchors are not checked.',
  pausedNote: 'Maintenance can still learn from sessions. Code checks wait until the folder is back.',
} as const;

/**
 * What `POST /api/wiki/spaces/:id/maintenance/probe` answers (contract `maintenance.probe`): the tier the workspace's
 * folder would be read on now — null when the runner could not be asked — why it would read less than git, the origin a
 * git checkout is a clone of, and the words the form draws. `canTurnOn` is false only for another repository's checkout.
 */
export interface WikiRepoProbeAnswer {
  workspaceId: string;
  tier: WikiRepoTier | null;
  reason: WikiRepoTierReason | null;
  origin: string | null;
  tone: WikiRepoProbeTone;
  title: string;
  note: string | null;
  canTurnOn: boolean;
  checkedAt: string;
}

/**
 * The probe's answer in words. `found` is what the runner answered — a tier, or the reason it failed with and its own
 * words (`said`, which name another repository's address) — or the reason the server did not ask it (`runner_offline`,
 * `runner_missing`, `runner_upgrade`, `no_workspace`, `op_timeout`). `where` names the folder and the machine.
 */
export function wikiRepoProbeAnswer(
  workspaceId: string,
  found: { tier: 'git' | 'folder'; origin?: string | null } | { reason: WikiRepoTierReason; said?: string | null },
  where: { dir?: string | null; runner?: string | null },
  checkedAt: Date,
): WikiRepoProbeAnswer {
  const base = { workspaceId, checkedAt: checkedAt.toISOString() };
  if ('tier' in found) {
    if (found.tier === 'folder') {
      return { ...base, tier: 'folder', reason: null, origin: null, tone: 'folder', title: WIKI_REPO_PROBE_COPY.folderTitle, note: WIKI_REPO_PROBE_COPY.folderNote, canTurnOn: true };
    }
    const origin = (found.origin ?? '').trim() || null;
    return {
      ...base, tier: 'git', reason: null, origin, tone: 'ok',
      title: origin ? `Git checkout of ${origin}` : 'Git checkout with no remote', note: null, canTurnOn: true,
    };
  }
  const { reason } = found;
  const runner = (where.runner ?? '').trim() || 'the runner';
  const unchecked = (title: string): WikiRepoProbeAnswer => ({ ...base, tier: null, reason, origin: null, tone: 'unchecked', title, note: null, canTurnOn: true });
  switch (reason) {
    case 'runner_offline': return unchecked(`Could not check: ${runner} is offline`);
    case 'runner_upgrade': return unchecked(`Could not check: upgrade ${runner} to check the folder`);
    case 'runner_missing': return unchecked('Could not check: the workspace is not on a runner');
    case 'op_timeout':
    case 'runner_lost':
    case 'op_failed':
      return unchecked(`Could not check: ${runner} did not answer`);
    default:
      break;
  }
  const title = wikiRepoDetail(reason, { dir: where.dir, runner: where.runner, said: found.said });
  if ((WIKI_REPO_WRONG_REPOSITORY_REASONS as readonly string[]).includes(reason)) {
    return { ...base, tier: 'wrong_repository', reason, origin: null, tone: 'wrong', title, note: null, canTurnOn: false };
  }
  return { ...base, tier: 'sessions', reason, origin: null, tone: 'paused', title, note: WIKI_REPO_PROBE_COPY.pausedNote, canTurnOn: true };
}

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
  /** Why it failed, as the contract names it (`repoOps.reasons`); absent from a runner before the reasons. */
  reason?: WikiRepoTierReason;
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
