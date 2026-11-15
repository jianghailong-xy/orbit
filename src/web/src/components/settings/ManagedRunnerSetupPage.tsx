import { useQuery } from '@tanstack/react-query';
import { MANAGED_RUNNER_COPY } from '@orbit/shared';
import { Navigate, useNavigate } from 'react-router-dom';
import { encodeId } from '../../lib/idCodec';
import { useManagedRunner } from '../../lib/managedRunner';
import { runnersQuery, workspacesQuery } from '../../lib/queries';
import { ManagedRunnerNotice } from '../ManagedRunnerNotice';
import { Spinner } from '../ui/Spinner';
import { SettingsHeader } from './SettingsBlocks';

/**
 * /settings/machines/managed: the Machines group's "Managed runner · Set up" entry
 * (docs/managed-runner-existing-account-entry-design.md, board 2). The existing notice and one sentence;
 * Set up asks first on an account that already has a runner or a workspace, and its answer replaces this
 * address with the runner's own machine page, so Back does not return to Set up. With nothing to set up —
 * the feature off, nothing offered — it is Register a machine; with a mapping, the runner's page.
 */
export function ManagedRunnerSetupPage() {
  const navigate = useNavigate();
  const { managed, settled } = useManagedRunner();
  const runners = useQuery(runnersQuery()).data ?? [];
  const workspaces = useQuery(workspacesQuery()).data ?? [];
  if (!settled) {
    return (
      <div style={{ padding: 48, textAlign: 'center' }}>
        <Spinner />
      </div>
    );
  }
  const runnerId = managed?.status.runnerId;
  if (managed && !managed.display.ensure && runnerId) {
    return <Navigate to={`/settings/machines/${encodeId(runnerId)}`} replace />;
  }
  if (!managed?.display.ensure) return <Navigate to="/settings/machines/new" replace />;
  return (
    <div className="managed-runner-setup">
      <SettingsHeader title={MANAGED_RUNNER_COPY.entry.title} />
      <ManagedRunnerNotice
        managed={managed}
        confirmEnsure={runners.length > 0 || workspaces.length > 0}
        onEnsured={(status) => {
          if (status.runnerId) navigate(`/settings/machines/${encodeId(status.runnerId)}`, { replace: true });
        }}
      />
      <p className="managed-runner-setup-note">{MANAGED_RUNNER_COPY.entry.page}</p>
    </div>
  );
}
