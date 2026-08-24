/**
 * What a git remote URL says about the checkout Orbit is about to make from it.
 *
 * Two questions, one parse:
 *  - WHERE it goes. The repos-root convention is `<reposRoot>/<owner>-<repo>`, so the directory
 *    name has to come out of the URL — the user pastes a URL and never types a path, which is the
 *    whole product point of creating a workspace from a repository.
 *  - WHICH repository it is. `git@github.com:o/r.git` and `https://github.com/o/r` are the same
 *    repo written two ways, and a machine that already has one has the other; comparing the raw
 *    strings would offer to clone a second copy of a checkout that is already there.
 *
 * Deliberately not a validator. A URL that parses here can still be unreachable, private, or
 * misspelled — that answer belongs to git on the runner, reported back as its own stderr
 * (docs: never rewrite git's errors). This refuses only what Orbit itself cannot act on: a URL it
 * cannot derive a directory name from.
 */
export interface ParsedRepoUrl {
  /** `<owner>-<repo>`: the single directory name a clone of this remote lands under. */
  dirName: string;
  /** `<host>/<owner>/<repo>`, lowercased — what two spellings of the same remote share. */
  identity: string;
  /** The repository's own name, for a workspace nobody named. */
  repo: string;
}

/** One path or host segment we are willing to build a directory name out of. Anything with a
 *  slash, a backslash, a `..`, or a leading dot is refused rather than sanitized: this string
 *  becomes a path on someone else's disk, and a "cleaned up" traversal is still a caller who
 *  asked for one. */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** `scheme://[user[:pass]@]host[:port]/path` and git's scp-like `[user@]host:path`. */
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/:]+)(?::\d+)?\/(.+)$/;
const SCP = /^(?:[^@/]+@)?([^/:]+):(.+)$/;

export function parseRepoUrl(raw: string): ParsedRepoUrl | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const match = SCHEME.exec(trimmed) ?? SCP.exec(trimmed);
  if (!match) return null;
  const host = match[1];
  // A deeper path than owner/repo is a GitLab-style group nesting. The last two segments are the
  // ones that name the repository; the groups above them are dropped from the directory name
  // rather than flattened into it, so `a/b/c/repo` is `c-repo` and stays readable.
  const segments = match[2]
    .replace(/\.git$/i, '')
    .split('/')
    .filter((s) => s.length > 0);
  if (segments.length < 2) return null;
  // A `..` anywhere in the path is refused rather than dropped. It cannot escape the repos root
  // — only the last two segments are used, and both are checked below — but silently
  // reinterpreting a malformed URL as a different repository is how a user ends up staring at a
  // checkout of something they did not ask for.
  if (segments.some((s) => s === '.' || s === '..')) return null;
  const [owner, repo] = segments.slice(-2);
  if (!SEGMENT.test(host) || !SEGMENT.test(owner) || !SEGMENT.test(repo)) return null;
  return {
    dirName: `${owner}-${repo}`,
    // Lowercased whole: hosts are case-insensitive, and so is every forge anyone clones from in
    // practice. Treating `Owner/Repo` as a different repository from `owner/repo` would mean
    // offering to clone a second copy of a checkout the machine already has.
    identity: `${host}/${owner}/${repo}`.toLowerCase(),
    repo,
  };
}

/** Where a clone of `repoUrl` lands on a machine that reported `reposRoot`. Null when the URL
 *  yields no directory name — the caller has nothing to ask the runner for. */
export function cloneTargetDir(reposRoot: string, repoUrl: string): string | null {
  const parsed = parseRepoUrl(repoUrl);
  if (!parsed) return null;
  return `${reposRoot.replace(/\/+$/, '')}/${parsed.dirName}`;
}

/** Whether two remote URLs name the same repository. Unparseable input falls back to comparing
 *  what the user actually typed: an exact match is still an answer, and inventing an identity for
 *  a URL we could not read would be a guess. */
export function sameRepo(left: string, right: string): boolean {
  const a = parseRepoUrl(left);
  const b = parseRepoUrl(right);
  if (!a || !b) return left.trim() === right.trim();
  return a.identity === b.identity;
}
