import { useQuery } from '@tanstack/react-query';
import type { RunnerEngineHealth } from '@orbit/shared';
import { api, getToken } from '../../api';
import { meQuery, runnersQuery, workspacesQuery } from '../queries';
import { PROVIDERS_BASE, PROVIDERS_LIST_KEY, type ProviderRow } from '../providerAdmin';
import { providerPoolsQuery } from '../providerPools';
import { runnerIsOffline } from '../runnerAttention';
import { byRecentUse } from '../../components/settings/SettingsLayout';
import type { GetStartedAccount } from './getStarted';
import type { HelpLinkAccount } from './helpContent';

type RunnerRow = {
  id: string;
  name: string;
  displayName?: string | null;
  online?: boolean;
  lastHeartbeatAt?: string | null;
  engines?: RunnerEngineHealth[];
};
type WorkspaceRow = { id: string; name: string; lastActiveAt?: string | null };

/** GET /tasks/page with status=DONE and one row: whether the account has any done task. */
const doneTaskQuery = () => ({
  queryKey: ['help', 'get-started', 'done-task'] as const,
  meta: { entities: ['task'] },
  queryFn: () => api<{ items: unknown[] }>('/tasks/page?status=DONE&limit=1&counts=none'),
});

/**
 * What the help pages read about the reader's account: who they are, for resolving `orbit:/` links, and the
 * Get started checklist's facts. Signed out it reads nothing and answers null — every account request would be
 * a 401 — so an article reads the same for anyone with no link buttons.
 */
export function useHelpAccount(options: { checklist?: boolean } = {}): {
  signedIn: boolean;
  links: HelpLinkAccount | null;
  checklist: GetStartedAccount | null;
} {
  const signedIn = !!getToken();
  const me = useQuery({ ...meQuery(), enabled: signedIn });
  const runners = useQuery({ ...runnersQuery(), enabled: signedIn });
  const workspaces = useQuery({ ...workspacesQuery(), enabled: signedIn });
  const wantChecklist = signedIn && options.checklist === true;
  const keys = useQuery({
    queryKey: PROVIDERS_LIST_KEY,
    meta: { entities: ['provider'] },
    queryFn: () => api<ProviderRow[]>(PROVIDERS_BASE),
    enabled: wantChecklist,
  });
  const pools = useQuery({ ...providerPoolsQuery(), enabled: wantChecklist });
  const done = useQuery({ ...doneTaskQuery(), enabled: wantChecklist });

  if (!signedIn) return { signedIn, links: null, checklist: null };
  const runnerRows = (runners.data ?? []) as RunnerRow[];
  const workspaceRows = byRecentUse((workspaces.data ?? []) as WorkspaceRow[]);
  const now = Date.now();
  const links: HelpLinkAccount = {
    admin: me.data?.role === 'ADMIN',
    machines: runnerRows.map((r) => ({ id: r.id, offline: runnerIsOffline(r, now) })),
    workspaces: workspaceRows,
  };
  const ready = runners.isSuccess && workspaces.isSuccess && keys.isFetched && pools.isFetched && done.isSuccess;
  const doneRows = done.data?.items ?? [];
  const checklist: GetStartedAccount | null =
    wantChecklist && ready
      ? {
          machines: runnerRows.map((r) => ({
            name: r.displayName?.trim() || r.name,
            online: !runnerIsOffline(r, now),
            engines: r.engines,
          })),
          keys: keys.data ?? [],
          pools: pools.data ?? [],
          workspaces: workspaceRows,
          hasDoneTask: doneRows.length > 0,
        }
      : null;
  return { signedIn, links, checklist };
}
