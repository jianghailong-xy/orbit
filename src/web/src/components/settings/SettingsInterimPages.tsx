import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { workspacesQuery } from '../../lib/queries';
import { RunnerDetailPage } from '../../pages/RunnerDetailPage';
import { Spinner } from '../ui/Spinner';

/*
 * Settings' Machines and Workspaces rows open the pages that manage them today, in Settings' right-hand
 * column, until each group has its own page (the project's later tasks replace these).
 */

/** /settings/machines/:id — the machine's page, drawn afresh for each machine. */
export function SettingsMachinePage() {
  const { id } = useParams();
  return <RunnerDetailPage key={id} />;
}

/** /settings/workspaces/:id — its machine's page, with this workspace's editor open. */
export function SettingsWorkspacePage() {
  const { id } = useParams();
  const workspaces = useQuery(workspacesQuery());
  const workspace = (workspaces.data as Array<{ id: string; runnerId?: string | null }> | undefined)?.find(
    (w) => w.id === id,
  );
  if (workspaces.isPending) {
    return (
      <div style={{ padding: 24, textAlign: 'center' }}>
        <Spinner />
      </div>
    );
  }
  if (!workspace) return <p className="settings-empty">This workspace doesn't exist, or isn't yours.</p>;
  if (!workspace.runnerId) {
    return <p className="settings-empty">This workspace isn't on any machine.</p>;
  }
  return <RunnerDetailPage key={workspace.id} runnerId={workspace.runnerId} workspaceId={workspace.id} />;
}
