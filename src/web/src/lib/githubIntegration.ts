import { queryOptions } from '@tanstack/react-query';
import type { GithubBranches, GithubInstallation, GithubIntegration, GithubRepositoryPage } from '@orbit/shared';
import { api } from '../api';

/** `GET /integrations/github` (docs/github-workspace-design.md §5.2). */
export const githubIntegrationQuery = () =>
  queryOptions({
    queryKey: ['integrations', 'github'] as const,
    meta: { entities: ['workspace'] },
    queryFn: () => api<GithubIntegration>('/integrations/github'),
  });

/** `GET /integrations/github/repos?q=` (§5.2): the repositories the person can pick, most recently pushed first. */
export const githubRepositoriesQuery = (q: string) =>
  queryOptions({
    queryKey: ['integrations', 'github', 'repos', q] as const,
    queryFn: () => api<GithubRepositoryPage>(`/integrations/github/repos${q ? `?q=${encodeURIComponent(q)}` : ''}`),
    staleTime: 30_000,
  });

/** `GET /integrations/github/repos/:id/branches?q=` (§5.2): asked only once Other branch is opened. */
export const githubBranchesQuery = (repoId: number, q: string) =>
  queryOptions({
    queryKey: ['integrations', 'github', 'branches', repoId, q] as const,
    queryFn: () => api<GithubBranches>(`/integrations/github/repos/${repoId}/branches${q ? `?q=${encodeURIComponent(q)}` : ''}`),
    staleTime: 30_000,
  });

/** How many repositories the App reaches for this person, over every installation; null when GitHub wasn't asked. */
export function repositoryCount(view: Pick<GithubIntegration, 'installations'>): number | null {
  return view.installations === null ? null : view.installations.reduce((sum, i) => sum + i.repositoryCount, 0);
}

export const GITHUB_ROW_HINT = 'Clone your repositories into workspaces, and land work back to them.';
export const GITHUB_NOT_SET_UP = 'Not set up on this Orbit — ask an administrator.';

/**
 * Open a connection and send the browser to GitHub. `returnTo` is the Orbit path the callback comes back to,
 * with `github=connected` or `github_error=<code>` added.
 */
export async function connectGithub(returnTo: string): Promise<void> {
  const { authorizationUrl } = await api<{ authorizationUrl: string }>(`/integrations/github/start?return=${encodeURIComponent(returnTo)}`);
  window.location.assign(authorizationUrl);
}

/** What the callback's `github_error` means, said to the person who came back with it. */
export function githubErrorText(code: string): string {
  switch (code) {
    case 'GITHUB_ACCOUNT_IN_USE':
      return 'That GitHub account is already connected to another Orbit account. Disconnect it there first, or sign in to GitHub as someone else.';
    case 'GITHUB_DENIED':
      return 'GitHub sign-in was cancelled.';
    case 'GITHUB_FLOW_EXPIRED':
      return 'The GitHub sign-in expired or was finished in another browser. Try again.';
    case 'GITHUB_NOT_CONFIGURED':
      return GITHUB_NOT_SET_UP;
    default:
      return "GitHub didn't confirm the sign-in. Try again.";
  }
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "Personal account · 3 selected repositories" or "Organization · All repositories (11)". */
export function installationText(installation: GithubInstallation): string {
  const kind = installation.type === 'Organization' ? 'Organization' : 'Personal account';
  const repositories = installation.repositorySelection === 'all'
    ? `All repositories (${installation.repositoryCount})`
    : plural(installation.repositoryCount, 'selected repository', 'selected repositories');
  return `${kind} · ${repositories}`;
}

/** Where an installation's repositories are chosen, on GitHub. */
export function installationSettingsUrl(installation: GithubInstallation): string {
  return installation.type === 'Organization'
    ? `https://github.com/organizations/${encodeURIComponent(installation.account)}/settings/installations/${installation.id}`
    : `https://github.com/settings/installations/${installation.id}`;
}
