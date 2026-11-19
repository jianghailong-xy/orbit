import type { BranchCommit } from '@orbit/shared';

/** The most commits, and files per commit, stored for one session: the runner's own caps
 *  (branch_commits.go), held here too so an older or misbehaving reporter cannot grow the row. */
const MAX_COMMITS = 100;
const MAX_FILES = 100;
const MAX_TEXT = 4100;

/**
 * The `branchCommits` a runner report carries, as the session row stores them (`branch_commits`):
 * `undefined` when the report did not carry a list (an older runner, or one that could not read the
 * branch), which leaves the stored list as it was. A list is kept to the fields the bar reads, with
 * every string NUL-free (Postgres jsonb refuses U+0000) and capped.
 */
export function storableBranchCommits(value: unknown): BranchCommit[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const commits: BranchCommit[] = [];
  for (const raw of value.slice(0, MAX_COMMITS)) {
    if (!raw || typeof raw !== 'object') continue;
    const c = raw as Record<string, unknown>;
    if (typeof c.sha !== 'string' || !/^[0-9a-f]{7,64}$/.test(c.sha)) continue;
    const files = Array.isArray(c.files) ? c.files : [];
    commits.push({
      sha: c.sha,
      subject: text(c.subject),
      ...(text(c.body) ? { body: text(c.body) } : {}),
      committedAt: text(c.committedAt),
      ...(text(c.savedBy) ? { savedBy: text(c.savedBy).slice(0, 32) } : {}),
      files: files.slice(0, MAX_FILES).flatMap((f: unknown) => {
        if (!f || typeof f !== 'object') return [];
        const file = f as Record<string, unknown>;
        if (typeof file.path !== 'string' || !file.path) return [];
        return [{ path: text(file.path), additions: count(file.additions), deletions: count(file.deletions) }];
      }),
      ...(c.filesTruncated === true || files.length > MAX_FILES ? { filesTruncated: true } : {}),
    });
  }
  return commits;
}

function text(v: unknown): string {
  return typeof v === 'string' ? v.replace(/\u0000/g, '').slice(0, MAX_TEXT) : '';
}

function count(v: unknown): number {
  return typeof v === 'number' && Number.isInteger(v) && v >= -1 ? v : -1;
}
