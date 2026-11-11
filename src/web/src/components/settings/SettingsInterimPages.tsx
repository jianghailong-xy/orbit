import { useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { routeId } from '../../lib/idCodec';
import { workspacesQuery } from '../../lib/queries';
import { MachineWorkspacesEditor } from './MachineWorkspacesEditor';
import { Spinner } from '../ui/Spinner';

/*
 * TODO(s5, task 34vULVKvcdivsOtyXTP72): Settings' Workspaces rows open the old inline workspace editor
 * in Settings' right-hand column until the Workspaces page replaces it.
 */

/**
 * /settings/workspaces/:id — its machine's workspaces with this one's editor open; and
 * /settings/workspaces/new?machine=<id>, the create form on that machine.
 */
export function SettingsWorkspacePage() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const workspaces = useQuery(workspacesQuery());
  if (id === 'new') {
    const machine = params.get('machine');
    if (!machine) return <p className="settings-empty">Pick a machine for the new workspace first.</p>;
    return <MachineWorkspacesEditor key={`new:${machine}`} runnerId={machine} workspaceId="new" />;
  }
  const wanted = routeId(id);
  const workspace = (workspaces.data as Array<{ id: string; runnerId?: string | null }> | undefined)?.find(
    (w) => w.id === wanted,
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
  return <MachineWorkspacesEditor key={workspace.id} runnerId={workspace.runnerId} workspaceId={workspace.id} />;
}
