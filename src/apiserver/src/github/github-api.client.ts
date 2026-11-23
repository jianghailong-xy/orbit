import { Logger } from '@nestjs/common';
import { createPrivateKey, createSign } from 'node:crypto';

/**
 * GitHub, as far as GitHub-backed workspaces reach it (docs/github-workspace-design.md §3, §5.1, §5.2).
 * Fixed addresses: neither a setting nor a request can point a call anywhere else. It speaks with the
 * global `fetch` unless handed another, which is how the specs put a fake GitHub in its place.
 */
export const GITHUB_WEB = 'https://github.com';
export const GITHUB_API = 'https://api.github.com';

/** A call's budget: a page or a save waits on it, and a GitHub that does not answer is a failure. */
const REQUEST_TIMEOUT_MS = 15_000;

/** The repositories one listing reads at most, across every installation: 10 pages of 100 each. */
export const MAX_LISTED_REPOSITORIES = 1_000;

/** The branches one listing reads at most: 10 pages of 100. */
export const MAX_LISTED_BRANCHES = 1_000;

/** GitHub answered, but not with what was asked: a refusal (`status` 4xx) or a failure. */
export class GithubCallError extends Error {
  constructor(
    readonly status: number,
    readonly githubError: string | null,
  ) {
    super(`GitHub answered ${status}${githubError ? ` ${githubError}` : ''}`);
  }
}

/** What GET /app answers that Orbit reads. */
export interface GithubApp {
  id: number;
  slug: string;
  clientId: string;
  /** The repository and account permissions the App asks for, as GitHub reports them (`pull_requests: 'write'`). */
  permissions: Record<string, string>;
  /** The webhook events the App subscribes to. */
  events: string[];
}

/**
 * What an installation must have granted before its landings go through pull requests
 * (docs/design/protected-branch-landing.md §3 rule 3, §10): open, merge and read Orbit's pull request, and read the
 * head's checks and statuses. Contents: write the App always had. Until the installation's owner accepts these, its
 * workspaces land exactly as before.
 */
export const PULL_REQUEST_LANDING_PERMISSIONS: Readonly<Record<string, 'read' | 'write'>> = {
  pull_requests: 'write',
  checks: 'read',
  statuses: 'read',
};

/** One installation as the App itself reads it (GET /app/installations/{id}): its account and what it granted. */
export interface GithubInstallationGrant {
  id: number;
  account: string;
  /** `User` | `Organization`. */
  type: string;
  permissions: Record<string, string>;
}

/** One pull request, as GET /repos/{repo}/pulls lists it or POST creates it. */
export interface GithubPullRequestRef {
  number: number;
  url: string;
  headSha: string;
}

/** A required check on a pull request's head, folded to what a landing needs (§4.3). */
export interface GithubPullRequestCheck {
  name: string;
  required: boolean;
  /** PASSED (success, neutral, skipped), FAILED, or PENDING (not finished, or expected and not reported). */
  state: 'PASSED' | 'FAILED' | 'PENDING';
  url: string | null;
  /** GitHub's own word, lower case: a check run's conclusion, or a commit status's state; null while running. */
  conclusion: string | null;
  /** A check run GitHub Actions ran: its job id, whose log Orbit downloads for a failure (§4.5). Null otherwise. */
  actionsJobId: number | null;
  /** What the check said about itself: a check run's title, summary and text, or a status's description. */
  summary: string | null;
}

/** One read of a pull request in full (§4.3): what GitHub says now, which is all Orbit acts on. */
export interface GithubPullRequestReading {
  number: number;
  url: string;
  /** OPEN | CLOSED | MERGED. */
  state: string;
  merged: boolean;
  mergedBy: string | null;
  mergeCommitSha: string | null;
  mergeCommitTreeSha: string | null;
  headSha: string;
  baseRef: string;
  /** The base branch's tip as GitHub has it now. */
  baseSha: string | null;
  /** MERGEABLE | CONFLICTING | UNKNOWN. */
  mergeable: string;
  /** BEHIND | BLOCKED | CLEAN | DIRTY | DRAFT | HAS_HOOKS | UNKNOWN | UNSTABLE. */
  mergeStateStatus: string;
  /** APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED, or null when the branch requires no review. */
  reviewDecision: string | null;
  inMergeQueue: boolean;
  mergeQueueEnabled: boolean;
  /** Who closed it, for one closed without merging (§4.2 J-T19); null when GitHub does not say. */
  closedBy: string | null;
  checks: GithubPullRequestCheck[];
  /** The merge methods the repository allows. */
  allowed: { merge: boolean; rebase: boolean; squash: boolean };
}

/** The one read of a pull request (§4.3), with every fact the decision needs in one answer. */
export const PULL_REQUEST_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    mergeCommitAllowed
    rebaseMergeAllowed
    squashMergeAllowed
    pullRequest(number: $number) {
      number
      url
      state
      merged
      mergedBy { login }
      mergeCommit { oid tree { oid } }
      headRefOid
      baseRefName
      baseRef { target { oid } }
      mergeable
      mergeStateStatus
      reviewDecision
      isInMergeQueue
      isMergeQueueEnabled
      timelineItems(last: 1, itemTypes: [CLOSED_EVENT]) { nodes { ... on ClosedEvent { actor { login } } } }
      commits(last: 1) {
        nodes {
          commit {
            statusCheckRollup {
              contexts(first: 100) {
                nodes {
                  __typename
                  ... on CheckRun {
                    name status conclusion detailsUrl databaseId title summary text isRequired(pullRequestNumber: $number)
                    checkSuite { app { slug } }
                  }
                  ... on StatusContext { context state targetUrl description isRequired(pullRequestNumber: $number) }
                }
              }
            }
          }
        }
      }
    }
  }
}`;

/** A check run's or a status's answer, folded (§4.3): what failed, what passed, and what is not done yet. */
function checkState(node: Record<string, unknown>): GithubPullRequestCheck['state'] {
  if (node.__typename === 'StatusContext') {
    const state = String(node.state ?? '');
    if (state === 'SUCCESS') return 'PASSED';
    if (state === 'ERROR' || state === 'FAILURE') return 'FAILED';
    return 'PENDING';
  }
  if (node.status !== 'COMPLETED') return 'PENDING';
  const conclusion = String(node.conclusion ?? '');
  if (conclusion === 'SUCCESS' || conclusion === 'NEUTRAL' || conclusion === 'SKIPPED') return 'PASSED';
  return conclusion === '' ? 'PENDING' : 'FAILED';
}

/** One context of the head's status rollup, folded (§4.3, §4.5). */
function checkOf(node: Record<string, unknown>): GithubPullRequestCheck {
  const status = node.__typename === 'StatusContext';
  const text = (value: unknown) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null);
  const app = (node.checkSuite as { app?: { slug?: unknown } | null } | null | undefined)?.app?.slug;
  const said = status
    ? [text(node.description)]
    : [text(node.title), text(node.summary), text(node.text)];
  const conclusion = status ? text(node.state) : text(node.conclusion);
  return {
    name: String(status ? node.context ?? '' : node.name ?? ''),
    required: node.isRequired === true,
    state: checkState(node),
    url: typeof (node.detailsUrl ?? node.targetUrl) === 'string' ? String(node.detailsUrl ?? node.targetUrl) : null,
    conclusion: conclusion ? conclusion.toLowerCase() : null,
    actionsJobId: !status && app === 'github-actions' && typeof node.databaseId === 'number' ? node.databaseId : null,
    summary: said.filter((line): line is string => line !== null).join('\n\n') || null,
  };
}

/** The login of whoever closed the pull request, from its last CLOSED_EVENT. */
function closedByOf(timeline: unknown): string | null {
  const nodes = (timeline as { nodes?: Array<{ actor?: { login?: unknown } | null } | null> } | null | undefined)?.nodes ?? [];
  const login = nodes[nodes.length - 1]?.actor?.login;
  return typeof login === 'string' && login !== '' ? login : null;
}

/** A user-to-server token, as GitHub hands it out. Null expiries: the App's user tokens do not expire. */
export interface GithubUserTokens {
  accessToken: string;
  refreshToken: string | null;
  accessExpiresAt: Date | null;
  refreshExpiresAt: Date | null;
}

export interface GithubInstallation {
  id: number;
  account: string;
  /** `User` | `Organization`. */
  type: string;
  /** `all` | `selected`. */
  repositorySelection: string;
}

export interface GithubRepository {
  id: number;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  installationId: number;
  pushedAt: string | null;
}

/** The App's own credential for GET /app (§5.1): an RS256 JWT, issued a minute back for clock drift, valid nine. */
export function appJwt(appId: string, privateKeyPem: string, now = Date.now()): string {
  const seconds = Math.floor(now / 1000);
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${part({ alg: 'RS256', typ: 'JWT' })}.${part({ iat: seconds - 60, exp: seconds + 540, iss: appId })}`;
  const signature = createSign('RSA-SHA256').update(unsigned).sign(createPrivateKey(privateKeyPem)).toString('base64url');
  return `${unsigned}.${signature}`;
}

/** Whether a PEM is a private key node can sign with; never says why not. */
export function isPrivateKey(pem: string): boolean {
  try {
    return createPrivateKey(pem).asymmetricKeyType === 'rsa';
  } catch {
    return false;
  }
}

/** An object of string values out of an answer, anything else dropped. */
function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}

/** A pull request out of GitHub's REST answer, or null when it is not one. */
function pullRequestRef(row: Record<string, unknown>): GithubPullRequestRef | null {
  const head = (row?.head ?? {}) as { sha?: unknown };
  if (typeof row?.number !== 'number' || typeof row.html_url !== 'string') return null;
  return { number: row.number, url: row.html_url, headSha: typeof head.sha === 'string' ? head.sha : '' };
}

const expiry = (seconds: unknown, now: number): Date | null =>
  typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0 ? new Date(now + seconds * 1000) : null;

export class GithubClient {
  private readonly log = new Logger('GitHub');

  constructor(private readonly request: typeof fetch = fetch) {}

  /** §5.2: the authorization page, with the state and GitHub's side of PKCE. No scope: a GitHub App has none. */
  authorizationUrl(input: { clientId: string; redirectUri: string; state: string; codeChallenge: string }): string {
    const query = new URLSearchParams({
      client_id: input.clientId,
      redirect_uri: input.redirectUri,
      state: input.state,
      code_challenge: input.codeChallenge,
      code_challenge_method: 'S256',
    });
    return `${GITHUB_WEB}/login/oauth/authorize?${query}`;
  }

  /** GET /app with the App's JWT (§5.1). A 401 is a key that is not this App's. */
  async app(appId: string, privateKeyPem: string): Promise<GithubApp> {
    const answer = await this.api<{ id?: unknown; slug?: unknown; client_id?: unknown; permissions?: unknown; events?: unknown }>(
      'GET', '/app', `Bearer ${appJwt(appId, privateKeyPem)}`,
    );
    if (typeof answer.id !== 'number' || typeof answer.slug !== 'string') throw new GithubCallError(502, 'unexpected answer');
    return {
      id: answer.id,
      slug: answer.slug,
      clientId: typeof answer.client_id === 'string' ? answer.client_id : '',
      permissions: stringRecord(answer.permissions),
      events: Array.isArray(answer.events) ? answer.events.filter((event): event is string => typeof event === 'string') : [],
    };
  }

  /**
   * GET /app/installations/{id} with the App's JWT (docs/design/protected-branch-landing.md §10 step 3): the
   * permissions this installation granted, which are the old ones until its owner accepts the new ones.
   */
  async installationGrant(input: { appId: string; privateKey: string; installationId: string }): Promise<GithubInstallationGrant> {
    const answer = await this.api<{ id?: unknown; account?: { login?: unknown; type?: unknown }; permissions?: unknown }>(
      'GET', `/app/installations/${encodeURIComponent(input.installationId)}`, `Bearer ${appJwt(input.appId, input.privateKey)}`,
    );
    if (typeof answer.id !== 'number') throw new GithubCallError(502, 'unexpected answer');
    return {
      id: answer.id,
      account: typeof answer.account?.login === 'string' ? answer.account.login : '',
      type: typeof answer.account?.type === 'string' ? answer.account.type : 'User',
      permissions: stringRecord(answer.permissions),
    };
  }

  /**
   * The server's own installation token for one repository's pull request (§12): contents, pull requests, checks
   * and commit statuses, nothing an agent ever sees. Never answered to any runner route; GitHub refuses it (422)
   * for an installation that has not granted these.
   */
  async pullRequestToken(input: {
    appId: string; privateKey: string; installationId: string; repoId: string;
    /** The installation granted Workflows: write (D4): a pull request that changes a workflow file merges only so. */
    workflows?: boolean;
  }): Promise<{ token: string; expiresAt: Date }> {
    const answer = await this.api<{ token?: unknown; expires_at?: unknown }>(
      'POST',
      `/app/installations/${encodeURIComponent(input.installationId)}/access_tokens`,
      `Bearer ${appJwt(input.appId, input.privateKey)}`,
      {
        repository_ids: [Number(input.repoId)],
        permissions: {
          contents: 'write', metadata: 'read', ...PULL_REQUEST_LANDING_PERMISSIONS,
          ...(input.workflows ? { workflows: 'write' } : {}),
        },
      },
    );
    const expiresAt = typeof answer.expires_at === 'string' ? new Date(answer.expires_at) : null;
    if (typeof answer.token !== 'string' || answer.token === '' || !expiresAt || Number.isNaN(expiresAt.getTime())) {
      throw new GithubCallError(502, 'unexpected answer');
    }
    return { token: answer.token, expiresAt };
  }

  /** GET /repositories/{id}: the repository's name now, which a rename or a transfer changes and its id does not. */
  async repositoryById(token: string, repoId: string): Promise<{ fullName: string; defaultBranch: string }> {
    const answer = await this.api<{ full_name?: unknown; default_branch?: unknown }>(
      'GET', `/repositories/${encodeURIComponent(repoId)}`, `Bearer ${token}`,
    );
    if (typeof answer.full_name !== 'string' || answer.full_name === '') throw new GithubCallError(502, 'unexpected answer');
    return { fullName: answer.full_name, defaultBranch: typeof answer.default_branch === 'string' ? answer.default_branch : '' };
  }

  /** The open pull requests from `head` (a branch of this repository) into `base`. */
  async openPullRequests(token: string, fullName: string, head: string, base: string): Promise<GithubPullRequestRef[]> {
    const owner = fullName.split('/')[0] ?? '';
    const query = new URLSearchParams({ state: 'open', head: `${owner}:${head}`, base, per_page: '10' });
    const answer = await this.api<Array<Record<string, unknown>>>('GET', `/repos/${fullName}/pulls?${query}`, `Bearer ${token}`);
    return (Array.isArray(answer) ? answer : []).map(pullRequestRef).filter((ref): ref is GithubPullRequestRef => ref !== null);
  }

  /** POST /repos/{repo}/pulls: Orbit's pull request from `head` into `base`, opened as the App (§4.4 Approvals). */
  async createPullRequest(token: string, fullName: string, input: { head: string; base: string; title: string; body: string }): Promise<GithubPullRequestRef> {
    const answer = await this.api<Record<string, unknown>>('POST', `/repos/${fullName}/pulls`, `Bearer ${token}`, {
      title: input.title, head: input.head, base: input.base, body: input.body, maintainer_can_modify: false, draft: false,
    });
    const ref = pullRequestRef(answer);
    if (!ref) throw new GithubCallError(502, 'unexpected answer');
    return ref;
  }

  /** The pull request read in full, in one GraphQL answer (§4.3). A pull request GitHub does not find is a 404. */
  async pullRequest(token: string, fullName: string, number: number): Promise<GithubPullRequestReading> {
    const [owner, name] = fullName.split('/');
    const answer = await this.api<{ data?: { repository?: Record<string, unknown> | null }; errors?: Array<{ type?: unknown; message?: unknown }> }>(
      'POST', '/graphql', `Bearer ${token}`, { query: PULL_REQUEST_QUERY, variables: { owner, name, number } },
    );
    const repository = answer.data?.repository ?? null;
    const pr = (repository?.pullRequest ?? null) as Record<string, unknown> | null;
    if (!repository || !pr) {
      const notFound = (answer.errors ?? []).some((error) => error.type === 'NOT_FOUND');
      throw new GithubCallError(notFound ? 404 : 502, notFound ? 'not found' : 'unexpected answer');
    }
    const commits = ((pr.commits as { nodes?: unknown[] } | undefined)?.nodes ?? []) as Array<{ commit?: { statusCheckRollup?: { contexts?: { nodes?: unknown[] } } | null } }>;
    const contexts = (commits[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? []) as Array<Record<string, unknown>>;
    const mergeCommit = pr.mergeCommit as { oid?: unknown; tree?: { oid?: unknown } } | null;
    const baseTarget = (pr.baseRef as { target?: { oid?: unknown } } | null)?.target;
    return {
      number: Number(pr.number),
      url: String(pr.url ?? ''),
      state: String(pr.state ?? ''),
      merged: pr.merged === true,
      mergedBy: typeof (pr.mergedBy as { login?: unknown } | null)?.login === 'string' ? (pr.mergedBy as { login: string }).login : null,
      mergeCommitSha: typeof mergeCommit?.oid === 'string' ? mergeCommit.oid : null,
      mergeCommitTreeSha: typeof mergeCommit?.tree?.oid === 'string' ? mergeCommit.tree.oid : null,
      headSha: String(pr.headRefOid ?? ''),
      baseRef: String(pr.baseRefName ?? ''),
      baseSha: typeof baseTarget?.oid === 'string' ? baseTarget.oid : null,
      mergeable: String(pr.mergeable ?? 'UNKNOWN'),
      mergeStateStatus: String(pr.mergeStateStatus ?? 'UNKNOWN'),
      reviewDecision: typeof pr.reviewDecision === 'string' ? pr.reviewDecision : null,
      inMergeQueue: pr.isInMergeQueue === true,
      mergeQueueEnabled: pr.isMergeQueueEnabled === true,
      closedBy: closedByOf(pr.timelineItems),
      checks: contexts.map(checkOf),
      allowed: {
        merge: repository.mergeCommitAllowed !== false,
        rebase: repository.rebaseMergeAllowed !== false,
        squash: repository.squashMergeAllowed !== false,
      },
    };
  }

  /**
   * PUT /repos/{repo}/pulls/{n}/merge with `sha` = the commit Orbit pushed (§4.1 step 8): GitHub merges only that
   * head, so a commit somebody else pushed meanwhile is refused (409) rather than merged. A method the repository does
   * not allow, or a pull request GitHub will not merge yet, is 405.
   */
  async mergePullRequest(token: string, fullName: string, number: number, input: { sha: string; method: 'merge' | 'rebase' | 'squash' }): Promise<{ sha: string }> {
    const answer = await this.api<{ sha?: unknown; merged?: unknown }>(
      'PUT', `/repos/${fullName}/pulls/${number}/merge`, `Bearer ${token}`, { sha: input.sha, merge_method: input.method },
    );
    if (answer.merged !== true || typeof answer.sha !== 'string') throw new GithubCallError(502, 'unexpected answer');
    return { sha: answer.sha };
  }

  /**
   * GET /repos/{repo}/actions/jobs/{id}/logs: the plain-text log of the GitHub Actions job behind a failed check run
   * (§4.5, Actions: read). GitHub answers with a redirect to a short-lived download, which is followed; the
   * authorization header is not sent across that redirect. Only the last `maxBytes` are kept.
   */
  async actionsJobLog(token: string, fullName: string, jobId: number, maxBytes = 262_144): Promise<string> {
    const route = `/repos/${fullName}/actions/jobs/${encodeURIComponent(String(jobId))}/logs`;
    let response: Response;
    try {
      response = await this.request(`${GITHUB_API}${route}`, {
        method: 'GET',
        headers: { authorization: `Bearer ${token}`, 'user-agent': 'Orbit', 'x-github-api-version': '2022-11-28' },
        redirect: 'follow',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new GithubCallError(502, 'unreachable');
    }
    if (!response.ok) throw new GithubCallError(response.status, null);
    const text = await response.text();
    return text.length > maxBytes ? text.slice(text.length - maxBytes) : text;
  }

  /** DELETE the landing branch once its pull request merged (§4.8). Already gone (404, 422) is done too. */
  async deleteBranch(token: string, fullName: string, branch: string): Promise<void> {
    try {
      await this.api('DELETE', `/repos/${fullName}/git/refs/heads/${branch.split('/').map(encodeURIComponent).join('/')}`, `Bearer ${token}`);
    } catch (error) {
      if (error instanceof GithubCallError && (error.status === 404 || error.status === 422)) return;
      throw error;
    }
  }

  /** Trade the callback's code for the user's tokens (§5.2). */
  exchangeCode(input: { clientId: string; clientSecret: string; redirectUri: string; code: string; codeVerifier: string }): Promise<GithubUserTokens> {
    return this.token({
      client_id: input.clientId,
      client_secret: input.clientSecret,
      code: input.code,
      redirect_uri: input.redirectUri,
      code_verifier: input.codeVerifier,
    });
  }

  /** Trade a refresh token for a new pair; GitHub retires the one presented. */
  refresh(input: { clientId: string; clientSecret: string; refreshToken: string }): Promise<GithubUserTokens> {
    return this.token({
      client_id: input.clientId,
      client_secret: input.clientSecret,
      grant_type: 'refresh_token',
      refresh_token: input.refreshToken,
    });
  }

  async user(accessToken: string): Promise<{ id: number; login: string }> {
    const answer = await this.api<{ id?: unknown; login?: unknown }>('GET', '/user', `Bearer ${accessToken}`);
    if (typeof answer.id !== 'number' || typeof answer.login !== 'string') throw new GithubCallError(502, 'unexpected answer');
    return { id: answer.id, login: answer.login };
  }

  /** The App's installations this user can reach. */
  async installations(accessToken: string): Promise<GithubInstallation[]> {
    const answer = await this.api<{ installations?: Array<Record<string, unknown>> }>(
      'GET', '/user/installations?per_page=100', `Bearer ${accessToken}`,
    );
    return (answer.installations ?? []).map((row) => {
      const account = (row.account ?? {}) as { login?: unknown; type?: unknown };
      return {
        id: Number(row.id),
        account: typeof account.login === 'string' ? account.login : '',
        type: typeof account.type === 'string' ? account.type : 'User',
        repositorySelection: row.repository_selection === 'all' ? 'all' : 'selected',
      };
    });
  }

  /** The repositories of one installation this user can reach, up to `limit`, with how many there are. */
  async installationRepositories(accessToken: string, installationId: number, limit: number): Promise<{ total: number; repositories: GithubRepository[] }> {
    const repositories: GithubRepository[] = [];
    let total = 0;
    for (let page = 1; repositories.length < limit; page += 1) {
      const answer = await this.api<{ total_count?: unknown; repositories?: Array<Record<string, unknown>> }>(
        'GET', `/user/installations/${installationId}/repositories?per_page=100&page=${page}`, `Bearer ${accessToken}`,
      );
      total = typeof answer.total_count === 'number' ? answer.total_count : 0;
      const rows = answer.repositories ?? [];
      for (const row of rows) {
        repositories.push({
          id: Number(row.id),
          fullName: String(row.full_name ?? ''),
          private: row.private === true,
          defaultBranch: String(row.default_branch ?? ''),
          installationId,
          pushedAt: typeof row.pushed_at === 'string' ? row.pushed_at : null,
        });
      }
      if (rows.length < 100 || repositories.length >= total) break;
    }
    return { total, repositories: repositories.slice(0, limit) };
  }

  /**
   * A repository's branch names, up to MAX_LISTED_BRANCHES. GitHub answers them by name, 100 a page, so a
   * repository with many branches has its default one on a later page: every page is read until one is short.
   */
  async branches(accessToken: string, fullName: string): Promise<string[]> {
    const names: string[] = [];
    for (let page = 1; names.length < MAX_LISTED_BRANCHES; page += 1) {
      const answer = await this.api<Array<{ name?: unknown }>>('GET', `/repos/${fullName}/branches?per_page=100&page=${page}`, `Bearer ${accessToken}`);
      const rows = Array.isArray(answer) ? answer : [];
      names.push(...rows.map((row) => String(row.name ?? '')).filter((name) => name !== ''));
      if (rows.length < 100) break;
    }
    return names.slice(0, MAX_LISTED_BRANCHES);
  }

  /**
   * An installation token for one repository (§5.4): `repository_ids: [repoId]` and `contents: write`,
   * `metadata: read`, nothing else, signed for with the App's JWT. GitHub answers 404 for an installation
   * that is gone and 422 for a repository it no longer covers.
   */
  async installationToken(input: { appId: string; privateKey: string; installationId: string; repoId: string }): Promise<{ token: string; expiresAt: Date }> {
    const answer = await this.api<{ token?: unknown; expires_at?: unknown }>(
      'POST',
      `/app/installations/${encodeURIComponent(input.installationId)}/access_tokens`,
      `Bearer ${appJwt(input.appId, input.privateKey)}`,
      { repository_ids: [Number(input.repoId)], permissions: { contents: 'write', metadata: 'read' } },
    );
    const expiresAt = typeof answer.expires_at === 'string' ? new Date(answer.expires_at) : null;
    if (typeof answer.token !== 'string' || answer.token === '' || !expiresAt || Number.isNaN(expiresAt.getTime())) {
      throw new GithubCallError(502, 'unexpected answer');
    }
    return { token: answer.token, expiresAt };
  }

  /** Revoke a user token (§5.2 DELETE). Already revoked or expired (404) is done too. */
  async revoke(input: { clientId: string; clientSecret: string; accessToken: string }): Promise<void> {
    const basic = Buffer.from(`${input.clientId}:${input.clientSecret}`).toString('base64');
    try {
      await this.api('DELETE', `/applications/${encodeURIComponent(input.clientId)}/token`, `Basic ${basic}`, { access_token: input.accessToken });
    } catch (error) {
      if (error instanceof GithubCallError && error.status === 404) return;
      throw error;
    }
  }

  private async token(form: Record<string, string>): Promise<GithubUserTokens> {
    let status: number;
    let answer: Record<string, unknown> | null;
    try {
      const response = await this.request(`${GITHUB_WEB}/login/oauth/access_token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', 'user-agent': 'Orbit' },
        body: new URLSearchParams(form).toString(),
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      status = response.status;
      answer = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    } catch {
      this.log.warn("GitHub's token endpoint could not be reached");
      throw new GithubCallError(502, 'unreachable');
    }
    // GitHub answers a refused code or refresh token 200 with an `error`.
    const error = typeof answer?.error === 'string' ? answer.error.slice(0, 64) : null;
    if (status < 200 || status > 299 || error !== null || typeof answer?.access_token !== 'string') {
      this.log.warn(`GitHub's token endpoint refused: ${status}${error ? ` ${error}` : ''}`);
      throw new GithubCallError(status >= 400 ? status : 400, error);
    }
    const now = Date.now();
    return {
      accessToken: answer.access_token,
      refreshToken: typeof answer.refresh_token === 'string' && answer.refresh_token !== '' ? answer.refresh_token : null,
      accessExpiresAt: expiry(answer.expires_in, now),
      refreshExpiresAt: expiry(answer.refresh_token_expires_in, now),
    };
  }

  private async api<T>(method: string, route: string, authorization: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await this.request(`${GITHUB_API}${route}`, {
        method,
        headers: {
          accept: 'application/vnd.github+json',
          authorization,
          'user-agent': 'Orbit',
          'x-github-api-version': '2022-11-28',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'follow',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      this.log.warn(`GitHub could not be reached: ${method} ${route.split('?')[0]}`);
      throw new GithubCallError(502, 'unreachable');
    }
    if (response.status === 204) return undefined as T;
    const answer = (await response.json().catch(() => null)) as T & { message?: unknown };
    if (!response.ok) {
      const message = typeof answer?.message === 'string' ? answer.message.slice(0, 120) : null;
      this.log.warn(`GitHub refused ${method} ${route.split('?')[0]}: ${response.status}${message ? ` ${message}` : ''}`);
      throw new GithubCallError(response.status, message);
    }
    return answer;
  }
}
