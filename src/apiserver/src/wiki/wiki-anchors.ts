import { Prisma } from '@prisma/client';
import {
  WIKI_ANCHOR_RULES,
  WIKI_ANCHOR_SPECS,
  WIKI_GIT_ANCHOR_TYPES,
  WIKI_LIMITS,
  toUuid,
  wikiMaintenanceSettings,
  type WikiAnchor,
  type WikiAnchorCheck,
  type WikiAnchorCheckInput,
  type WikiAnchorInput,
  type WikiAnchorList,
  type WikiAnchorState,
  type WikiDueAnchor,
  type WikiFieldError,
  type WikiGitAnchorType,
} from '@orbit/shared';

/**
 * The anchor re-verification's side of the server (design §4.4, contracts/wiki.contract.json
 * `anchorRules.verify`, criterion 4): which anchors a Wiki maintenance run re-verifies, what a report
 * of them may say, and what the entry's anchors read as afterwards.
 *
 * GIT RUNS ON THE RUNNER, NEVER HERE. A path, a symbol and a commit are checked by `orbit wiki anchors
 * verify` in the runner's own checkout, on the commit origin/main names after a fetch; this file hands
 * that command the anchors and reads back what it found. What the server decides for itself is what a
 * finding MEANS: a symbol is held to its baseline — its own `regionSha256`, or the region its first
 * check found — so a region that moved reads `changed` whatever the runner thought, and only the
 * owner's Re-confirm moves the baseline.
 *
 * WHAT IS WRITTEN, AND BY WHOM. Everything here is pure or a read. The check itself, the entry's
 * `anchor_state` and the system challenge a broken anchor files are written by `WikiService`
 * (`recordAnchorChecks`, through `applyOp` and `recordChangeset`), which is the one writer of an
 * entry (design §3); this file does not import it, so the service can import this one.
 */

/** Reads the anchors list needs: the entries, the space's settings, its bindings and their workspaces. */
type AnchorReader = Pick<Prisma.TransactionClient, '$queryRaw' | 'session' | 'wikiSpace' | 'wikiSpaceWorkspace' | 'workspace'>;

const GIT_TYPES: ReadonlySet<string> = new Set(WIKI_GIT_ANCHOR_TYPES);

/** A 40-character lowercase commit sha: what `ref` must be. */
const COMMIT_SHA = /^[0-9a-f]{40}$/u;
const REGION_SHA = /^[0-9a-f]{64}$/u;

// ── What an anchor is, and what its checks make of it ───────────────────────────────────────────

/** An entry's anchors as the column holds them: a list of objects, whatever else was stored. */
export function storedAnchors(value: unknown): WikiAnchor[] {
  return Array.isArray(value) ? (value.filter((anchor) => anchor !== null && typeof anchor === 'object') as WikiAnchor[]) : [];
}

/**
 * The region hash a symbol anchor is held to: its own `regionSha256` when the proposer gave one, else
 * the one its first check found (kept as the check's `baselineSha256`). Null before any check found it.
 */
export function symbolBaseline(anchor: WikiAnchor): string | null {
  if (anchor.type !== 'symbol') return null;
  return anchor.regionSha256 ?? anchor.check?.baselineSha256 ?? null;
}

/** The git anchors of one entry, each with its place in the entry's list, as the runner is handed them. */
export function dueAnchors(anchors: readonly WikiAnchor[]): WikiDueAnchor[] {
  const due: WikiDueAnchor[] = [];
  anchors.forEach((anchor, index) => {
    if (anchor.type === 'path') due.push({ index, type: 'path', path: anchor.path });
    else if (anchor.type === 'symbol') {
      due.push({ index, type: 'symbol', path: anchor.path, symbol: anchor.symbol, regionSha256: symbolBaseline(anchor) });
    } else if (anchor.type === 'commit') due.push({ index, type: 'commit', sha: anchor.sha });
  });
  return due;
}

/**
 * An entry's anchor state from its anchors' last checks (contract `anchorRules.verify.aggregate`):
 * `missing` when any is missing, else `changed` when any changed, else `unchecked` when any anchor has
 * no check yet — or the entry has none at all — else `verified`.
 */
export function entryAnchorState(anchors: readonly WikiAnchor[]): WikiAnchorState {
  const states = anchors.map((anchor) => anchor.check?.state ?? 'unchecked');
  if (states.includes('missing')) return 'missing';
  if (states.includes('changed')) return 'changed';
  if (states.length === 0 || states.some((state) => state !== 'verified')) return 'unchecked';
  return 'verified';
}

/**
 * An entry's anchors with one report's checks laid over them: each reported anchor's last check
 * replaced, every other anchor as it was.
 *
 * A check is laid on the anchor its index names only when the identity it carries is that anchor's
 * (`anchorIdentityMatches`): a check naming another anchor — another path, another symbol, another
 * commit — is not written at all, and a caller that must not lose it reports it instead of passing
 * it here silently.
 *
 * A path or a commit is what the runner found. A symbol the runner found is held to its baseline here,
 * not there: equal is `verified`, anything else `changed` — and a symbol that has no baseline yet
 * takes the region this check found as one (`baselineSha256`), which is how an anchor nobody hashed
 * by hand gets held to something. A `missing` or `changed` check keeps the baseline where it was:
 * only the owner's Re-confirm moves it.
 */
export function anchorsChecked(
  anchors: readonly WikiAnchor[],
  checks: readonly WikiAnchorCheckInput[],
  ref: string,
  at: string,
): WikiAnchor[] {
  const next = anchors.map((anchor) => ({ ...anchor }) as WikiAnchor);
  for (const reported of checks) {
    const anchor = next[reported.index];
    if (!anchor || !anchorIdentityMatches(anchor, reported)) continue;
    let check: WikiAnchorCheck;
    if (anchor.type !== 'symbol') {
      check = { state: reported.state === 'verified' ? 'verified' : 'missing', ref, at };
    } else {
      // Kept only while the baseline is one a check adopted: an anchor that names its own is held to that.
      const adopted = anchor.regionSha256 ? null : (anchor.check?.baselineSha256 ?? null);
      const found = reported.state !== 'missing' ? reported.regionSha256 ?? null : null;
      if (found === null) {
        check = { state: 'missing', ref, at, ...(adopted ? { baselineSha256: adopted } : {}) };
      } else {
        const baseline = anchor.regionSha256 ?? adopted ?? found;
        check = {
          state: found === baseline ? 'verified' : 'changed',
          ref,
          at,
          regionSha256: found,
          ...(anchor.regionSha256 ? {} : { baselineSha256: baseline }),
        };
      }
    }
    next[reported.index] = { ...anchor, check } as WikiAnchor;
  }
  return next;
}

/**
 * Whether a reported check is the check of the anchor it would be laid on: the type is the anchor's,
 * and every identity field the check carries equals the anchor's own — a path anchor's `path`, a
 * symbol's `path` and `symbol`, a commit's `sha`. A check that carries no identity at all (the
 * runner's own CLI reports none) matches on the type alone; one that carries a wrong identity
 * matches nothing, and the server refuses the entry rather than write it on the wrong anchor
 * (contract `anchorRules.verify.identity`).
 */
export function anchorIdentityMatches(anchor: WikiAnchor | undefined, check: WikiAnchorCheckInput): boolean {
  if (!anchor || anchor.type !== check.type) return false;
  switch (anchor.type) {
    case 'path':
      return check.path === undefined || check.path === anchor.path;
    case 'symbol':
      return (check.path === undefined || check.path === anchor.path)
        && (check.symbol === undefined || check.symbol === anchor.symbol);
    case 'commit':
      return check.sha === undefined || check.sha === anchor.sha;
    default:
      return false;
  }
}

/**
 * The anchors Re-confirm leaves an entry with (contract `anchorRules.verify.answers.reconfirm`): the
 * entry as it stands on the ref it was last checked on. A symbol whose region changed is held to the
 * region that check found, written into the anchor as its own `regionSha256`; an anchor that check
 * found missing is dropped, because there is nothing left for it to hold to; every other anchor is
 * kept as it is, last check and all. `changed` says whether any of that was needed.
 */
export function rebaselinedAnchors(anchors: readonly WikiAnchor[]): { anchors: WikiAnchor[]; changed: boolean } {
  let changed = false;
  const kept: WikiAnchor[] = [];
  for (const anchor of anchors) {
    const check = anchor.check;
    if (check?.state === 'missing') {
      changed = true;
      continue;
    }
    if (anchor.type === 'symbol' && check?.state === 'changed' && check.regionSha256) {
      changed = true;
      kept.push({
        ...anchor,
        regionSha256: check.regionSha256,
        check: { state: 'verified', ref: check.ref, at: check.at, regionSha256: check.regionSha256 },
      });
      continue;
    }
    kept.push(anchor);
  }
  return { anchors: kept, changed };
}

/** Anchors as a revision stores them and a proposer writes them: without the server's last check. */
export function anchorsWithoutChecks(anchors: unknown): WikiAnchorInput[] {
  return storedAnchors(anchors).map((anchor) => {
    const { check: _check, ...input } = anchor;
    return input as WikiAnchorInput;
  });
}

/**
 * Why a system challenge was filed, as Review shows it beside the entry: each anchor that no longer
 * holds, and the commit it was checked on.
 */
export function anchorChallengeReason(anchors: readonly WikiAnchor[], ref: string): string {
  const broken = anchors
    .filter((anchor) => anchor.check?.state === 'changed' || anchor.check?.state === 'missing')
    .map((anchor) => `${describeAnchor(anchor)} ${anchor.check?.state === 'changed' ? 'has changed' : 'is missing'}`);
  const text = `Anchor re-verification on origin/main at ${ref}: ${broken.join('; ')}. `
    + 'Agents stop getting this entry until it is re-confirmed, amended or retired.';
  const chars = [...text];
  return chars.length <= WIKI_LIMITS.fieldTextMaxChars ? text : `${chars.slice(0, WIKI_LIMITS.fieldTextMaxChars - 1).join('')}…`;
}

function describeAnchor(anchor: WikiAnchor): string {
  switch (anchor.type) {
    case 'path':
      return `path ${anchor.path}`;
    case 'symbol':
      return `symbol ${anchor.symbol} in ${anchor.path}`;
    case 'commit':
      return `commit ${anchor.sha}`;
    default:
      return `${anchor.type} anchor`;
  }
}

// ── What a report may say (contract `anchorRules.verify.report`) ────────────────────────────────

/** One entry of a report, as the service records it. */
export interface AnchorReportEntry {
  entryId: string;
  revision: number;
  checks: WikiAnchorCheckInput[];
}

/**
 * The report as a whole: the ref every check was made on, and the entries, at most
 * `rules.reportEntriesMax` of them. Anything else is refused before an entry is read.
 */
export function anchorReportShape(body: unknown): { ref: string; entries: unknown[] } | { errors: WikiFieldError[] } {
  const value = (body ?? {}) as Record<string, unknown>;
  const errors: WikiFieldError[] = [];
  if (typeof value.ref !== 'string' || !COMMIT_SHA.test(value.ref)) {
    errors.push({ path: 'ref', message: 'is required: the 40-character sha origin/main named when the anchors were checked' });
  }
  if (!Array.isArray(value.entries) || value.entries.length === 0) {
    errors.push({ path: 'entries', message: 'must hold at least one entry' });
  } else if (value.entries.length > WIKI_ANCHOR_RULES.reportEntriesMax) {
    errors.push({ path: 'entries', message: `must hold at most ${WIKI_ANCHOR_RULES.reportEntriesMax}: report the rest in another` });
  }
  return errors.length > 0 ? { errors } : { ref: value.ref as string, entries: value.entries as unknown[] };
}

/** One entry of a report, checked for the shape the contract gives it; every failing field is named. */
export function anchorReportEntry(raw: unknown, index: number): AnchorReportEntry | { errors: WikiFieldError[] } {
  const at = (field: string): string => `entries[${index}]${field === '' ? '' : `.${field}`}`;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { errors: [{ path: at(''), message: 'must be an object' }] };
  const value = raw as Record<string, unknown>;
  const errors: WikiFieldError[] = [];
  let entryId = '';
  if (typeof value.entryId !== 'string') errors.push({ path: at('entryId'), message: 'is required' });
  else {
    try {
      entryId = toUuid(value.entryId);
    } catch {
      errors.push({ path: at('entryId'), message: 'names no entry: hand back the entryId the anchors list gave' });
    }
  }
  if (typeof value.revision !== 'number' || !Number.isInteger(value.revision) || value.revision < 1) {
    errors.push({ path: at('revision'), message: 'is required: the revision the anchors list gave with the entry' });
  }
  const checks: WikiAnchorCheckInput[] = [];
  if (!Array.isArray(value.checks) || value.checks.length === 0) {
    errors.push({ path: at('checks'), message: 'must hold at least one check' });
  } else if (value.checks.length > WIKI_LIMITS.listMaxItems) {
    errors.push({ path: at('checks'), message: `must hold at most ${WIKI_LIMITS.listMaxItems}: an entry has no more anchors than that` });
  } else {
    const seen = new Set<number>();
    value.checks.forEach((rawCheck, n) => {
      const where = (field: string): string => at(`checks[${n}]${field === '' ? '' : `.${field}`}`);
      if (rawCheck === null || typeof rawCheck !== 'object' || Array.isArray(rawCheck)) {
        errors.push({ path: where(''), message: 'must be an object' });
        return;
      }
      const check = rawCheck as Record<string, unknown>;
      const before = errors.length;
      if (typeof check.index !== 'number' || !Number.isInteger(check.index) || check.index < 0) {
        errors.push({ path: where('index'), message: 'is required: the anchor\'s place in the entry, as the list gave it' });
      } else if (seen.has(check.index)) {
        errors.push({ path: where('index'), message: 'names an anchor this entry already reported' });
      } else {
        seen.add(check.index);
      }
      const type = typeof check.type === 'string' && GIT_TYPES.has(check.type) ? (check.type as WikiGitAnchorType) : null;
      if (!type) errors.push({ path: where('type'), message: `must be one of ${WIKI_GIT_ANCHOR_TYPES.join(', ')}` });
      const states = type ? WIKI_ANCHOR_SPECS[type].states : [];
      if (typeof check.state !== 'string' || !(states as readonly string[]).includes(check.state)) {
        errors.push({ path: where('state'), message: `must be one of the states a ${type ?? 'git'} anchor has: ${states.join(', ')}` });
      }
      const found = type === 'symbol' && check.state !== 'missing';
      if (found && (typeof check.regionSha256 !== 'string' || !REGION_SHA.test(check.regionSha256))) {
        errors.push({ path: where('regionSha256'), message: 'is required of a symbol found: the sha256 of its region, in lowercase hex' });
      } else if (!found && check.regionSha256 !== undefined && check.regionSha256 !== null) {
        errors.push({ path: where('regionSha256'), message: 'is only for a symbol that was found' });
      }
      // The identity the check says it belongs to: only the fields its type names, each only when it
      // is the right shape. The server applies the check to the anchor this names and to no other
      // (`anchorIdentityMatches`); a report may leave the identity out, and is then held to the type
      // at the index alone.
      if (check.path !== undefined && typeof check.path !== 'string') {
        errors.push({ path: where('path'), message: 'must be a string: the path of the anchor this check says it checked' });
      }
      if (check.symbol !== undefined && typeof check.symbol !== 'string') {
        errors.push({ path: where('symbol'), message: 'must be a string: the symbol of the anchor this check says it checked' });
      }
      if (check.sha !== undefined && (typeof check.sha !== 'string' || !COMMIT_SHA.test(check.sha))) {
        errors.push({ path: where('sha'), message: 'must be the 40-character sha of the commit anchor this check says it checked' });
      }
      if (type === 'path' && (check.symbol !== undefined || check.sha !== undefined)) {
        errors.push({ path: where(''), message: 'a path check names a path and nothing else' });
      } else if (type === 'symbol' && check.sha !== undefined) {
        errors.push({ path: where('sha'), message: 'a symbol check names no sha' });
      } else if (type === 'commit' && (check.path !== undefined || check.symbol !== undefined)) {
        errors.push({ path: where(''), message: 'a commit check names a sha and nothing else' });
      }
      if (errors.length > before) return;
      checks.push({
        index: check.index as number,
        type: type!,
        state: check.state as WikiAnchorCheckInput['state'],
        ...(found ? { regionSha256: check.regionSha256 as string } : {}),
        ...(typeof check.path === 'string' ? { path: check.path } : {}),
        ...(typeof check.symbol === 'string' ? { symbol: check.symbol } : {}),
        ...(typeof check.sha === 'string' ? { sha: check.sha } : {}),
      });
    });
  }
  return errors.length > 0 ? { errors } : { entryId, revision: value.revision as number, checks };
}

// ── The list a maintenance run re-verifies (contract `anchorRules.verify.list`) ──────────────────

/**
 * One page of the space's active entries that carry a git anchor, in id order, each with its current
 * revision and its git anchors; and the checkout the space's workspace names on this runner.
 *
 * Only ACTIVE entries: they are what the push reads and what a challenge takes out of it. A proposal
 * waiting in Review is checked once it applies.
 */
export async function listWikiAnchors(
  reader: AnchorReader,
  input: { ownerId: string; runnerId: string; spaceId: string; sessionId: string; after: string | null; limit: number | null },
): Promise<WikiAnchorList> {
  const limit = Math.min(Math.max(input.limit ?? WIKI_ANCHOR_RULES.listEntriesDefault, 1), WIKI_ANCHOR_RULES.listEntriesMax);
  const page = await anchorPage(reader, input, limit);
  return { spaceId: input.spaceId, repo: await anchorRepoOf(reader, input), entries: page.entries, next: page.next };
}

/**
 * The same page for the server's own maintenance run (contract `maintenance.job.server`, P8): there is no
 * session and no runner on this side — the checks travel as a `wiki_repo_op` the space's workspace routes,
 * and this returns the entries alone, with no checkout for the caller to name. The entries are exactly the
 * runner's list's: active, git-anchored, in id order, one page at a time.
 */
export async function listWikiAnchorsForJob(
  reader: AnchorReader,
  input: { ownerId: string; spaceId: string; after: string | null; limit: number | null },
): Promise<{ spaceId: string; entries: WikiAnchorList['entries']; next: string | null }> {
  const limit = Math.min(Math.max(input.limit ?? WIKI_ANCHOR_RULES.listEntriesDefault, 1), WIKI_ANCHOR_RULES.listEntriesMax);
  const page = await anchorPage(reader, input, limit);
  return { spaceId: input.spaceId, entries: page.entries, next: page.next };
}

/** The page's rows as entries: the one read both lists above make. */
async function anchorPage(
  reader: AnchorReader,
  input: { ownerId: string; spaceId: string; after: string | null },
  limit: number,
): Promise<Pick<WikiAnchorList, 'entries' | 'next'>> {
  const rows = await reader.$queryRaw<Array<{ id: string; currentRevision: number; anchors: unknown }>>`
    SELECT e."id" AS "id", e."current_revision" AS "currentRevision", e."anchors" AS "anchors"
      FROM "wiki_entry" e
     WHERE e."owner_id" = ${input.ownerId}::uuid
       AND e."space_id" = ${input.spaceId}::uuid
       AND e."status" = 'active'
       AND (${input.after}::uuid IS NULL OR e."id" > ${input.after}::uuid)
       AND EXISTS (SELECT 1 FROM jsonb_array_elements(e."anchors") AS a("value")
                    WHERE a."value"->>'type' IN (${Prisma.join([...WIKI_GIT_ANCHOR_TYPES])}))
     ORDER BY e."id" ASC
     LIMIT ${limit + 1}::int`;
  const page = rows.slice(0, limit);
  return {
    entries: page.map((row) => ({
      entryId: row.id,
      revision: Number(row.currentRevision),
      anchors: dueAnchors(storedAnchors(row.anchors)),
    })),
    next: rows.length > limit ? page[page.length - 1].id : null,
  };
}

/**
 * The checkout a run re-verifies in when it names none (contract `anchorRules.verify.repo`): the work
 * directory of a workspace bound to the space — the calling session's own when it is one of them, else
 * the space's maintenance workspace, else the first bound workspace that lives on this runner — as the
 * workspace stores it. A leading `~` is the runner's to expand: this server does not know its home.
 */
async function anchorRepoOf(
  reader: AnchorReader,
  input: { ownerId: string; runnerId: string; spaceId: string; sessionId: string },
): Promise<WikiAnchorList['repo']> {
  const bound = await reader.wikiSpaceWorkspace.findMany({
    where: { spaceId: input.spaceId, ownerId: input.ownerId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { workspaceId: true },
  });
  if (bound.length === 0) return null;
  const session = await reader.session.findFirst({ where: { id: input.sessionId, ownerId: input.ownerId }, select: { workspaceId: true } });
  const space = await reader.wikiSpace.findFirst({ where: { id: input.spaceId, ownerId: input.ownerId }, select: { settings: true } });
  const settings = (space?.settings ?? {}) as Record<string, unknown>;
  const maintained = wikiMaintenanceSettings(settings.maintenance).workspaceId;
  const ids = bound.map((row) => row.workspaceId);
  const order = [...new Set([session?.workspaceId, maintained, ...ids].filter((id): id is string => !!id && ids.includes(id)))];
  const workspaces = await reader.workspace.findMany({
    where: { id: { in: order }, ownerId: input.ownerId, deletedAt: null },
    select: { id: true, workDir: true, runnerId: true, targetRunnerId: true },
  });
  const byId = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
  for (const id of order) {
    const workspace = byId.get(id);
    const workDir = workspace?.workDir?.trim();
    if (!workspace || !workDir) continue;
    // The session runs here, so its own workspace does; any other has to say it lives on this runner.
    const here = id === session?.workspaceId || workspace.runnerId === input.runnerId || workspace.targetRunnerId === input.runnerId;
    if (here) return { workspaceId: workspace.id, workDir };
  }
  return null;
}
