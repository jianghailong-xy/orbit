import { useQuery } from '@tanstack/react-query';
import type { WikiSpace } from '@orbit/shared';
import { encodeId } from './idCodec';
import { runnersQuery, workspacesQuery } from './queries';
import { wikiWorkspaceLabel } from './wikiReviewMode';

/**
 * Where a space's maintenance runs and on what, as the plan's empty page and its Held card say it —
 * `orbit · wikova`, `local-vllm` — and whether that workspace's runner is online: a plan job whose task
 * was made and never started, on a runner that is offline, is held (owner's call 2026-09-29).
 *
 * Ids are compared in their public spelling: the space's settings keep the workspace's id as it was
 * stored, and the workspace list and the runner list answer in the other spelling.
 */
export function useWikiMaintenanceWhere(space: WikiSpace | undefined): {
  where: string | null;
  provider: string | null;
  runnerOnline: boolean | null;
} {
  const workspaces = useQuery(workspacesQuery());
  const runners = useQuery(runnersQuery());
  const maintenance = space?.settings?.maintenance;
  const workspace = maintenance?.workspaceId
    ? ((workspaces.data ?? []) as Array<{ id: string; name?: string; runner?: { id?: string; name?: string; displayName?: string } | null }>).find(
        (row) => encodeId(row.id) === encodeId(maintenance.workspaceId!),
      )
    : undefined;
  const runnerId = workspace?.runner?.id;
  const runner = runnerId
    ? ((runners.data ?? []) as Array<{ id: string; online?: boolean }>).find((row) => encodeId(row.id) === encodeId(runnerId))
    : undefined;
  return {
    where: workspace ? wikiWorkspaceLabel(workspace) : null,
    provider: maintenance?.provider ?? null,
    runnerOnline: runner ? runner.online === true : null,
  };
}
