import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { DownOutlined } from '@ant-design/icons';
import { publishedRunnerVersionQuery, runnersQuery, workspacesQuery } from '../lib/queries';
import { latestRunnerVersion, runnerAttention, type AttentionWorkspace } from '../lib/runnerAttention';
import { RunnerEngines } from '../components/RunnerEngines';
import { Button } from '../components/ui/Button';
import { Menu, type MenuItem } from '../components/ui/Menu';
import type { Runner } from '../components/TasksSidePanel';

/**
 * Where the user's agents run, and whose model quota they spend — what the Runners and Providers
 * pages used to split between them, on one page (docs/mocks/infrastructure-page), centred on what the
 * user brought themselves: their machines, then their keys (docs/mocks/infrastructure-focus).
 *
 * First the machines (RunnerEngines), each with the engines signed in on it: a subscription there is
 * spent only by sessions on that machine and needs nothing pasted, which is what most sessions
 * actually run on. Each card's head says what its sessions can run on, an engine signed out there with
 * the way to sign it in again, and the card is also where its machine is renamed, reordered and deleted.
 *
 * The API keys on the account and the account pools are Settings' Providers pages now
 * (docs/mocks/settings-redesign, board-4: SettingsProviderPages), and `#keys` / `#pools` land there
 * (App.tsx). The head's Add still makes any of the three. `/runners` lands here.
 */
export function InfrastructurePage() {
  const navigate = useNavigate();
  const runners = useQuery(runnersQuery());
  const machines = (runners.data ?? []) as Runner[];
  const online = machines.filter((runner) => runner.online);
  const busySlots = online.reduce((n, runner) => n + (runner.activeSessions ?? 0), 0);
  const allSlots = online.reduce((n, runner) => n + (runner.maxConcurrent ?? 0), 0);
  // What each machine's card says it needs a person for: read from the machine's workspaces, and the
  // newest release anyone can see.
  const workspaces = (useQuery(workspacesQuery()).data ?? []) as Array<
    AttentionWorkspace & { runnerId?: string | null }
  >;
  const latestVersion = latestRunnerVersion(useQuery(publishedRunnerVersionQuery()).data, machines);
  const nowMs = Date.now();
  const attentionOf = (runner: Runner) =>
    runnerAttention({
      runner,
      workspaces: workspaces.filter((workspace) => workspace.runnerId === runner.id),
      nowMs,
      latestVersion,
    });
  const addItems: MenuItem[] = [
    {
      key: 'machine',
      textValue: 'Register a machine',
      label: (
        <span className="infra-add">
          <b>Register a machine</b>
          <span>Run agents on a computer you own, on its subscriptions</span>
        </span>
      ),
      onSelect: () => navigate('/runners/register'),
    },
    {
      key: 'key',
      textValue: 'Connect an API key',
      label: (
        <span className="infra-add">
          <b>Connect an API key</b>
          <span>Usable from every machine, billed per token</span>
        </span>
      ),
      onSelect: () => navigate('/settings/providers/new'),
    },
    {
      key: 'pool',
      textValue: 'New account pool',
      label: (
        <span className="infra-add">
          <b>New account pool</b>
          <span>Several accounts behind one name</span>
        </span>
      ),
      onSelect: () => navigate('/settings/providers/pools'),
    },
  ];

  return (
    <div style={{ maxWidth: 900, margin: '0 auto' }}>
      {/* The page is Settings' (docs/mocks/machines-and-models, 02): no sidebar row is lit on it, so the
          way back is named here, as the pages under this one name it. */}
      <Link className="provider-back" to="/settings" style={{ marginBottom: 8 }}>
        ‹ Settings
      </Link>
      <div className="prov-page-head">
        <h1 className="page-title" style={{ marginBottom: 0 }}>
          Machines &amp; models
        </h1>
        <Menu
          align="end"
          items={addItems}
          trigger={
            <Button variant="primary">
              Add <DownOutlined />
            </Button>
          }
        />
        <div className="prov-page-sub">
          Where your agents run, and whose model quota they spend.
        </div>
      </div>

      <div id="machines">
        <RunnerEngines
          attentionOf={attentionOf}
          head={
            <div className="re-sec-head">
              <h3>Machines</h3>
              <span className="re-sec-sub">
                Subscriptions signed in here are spent only by sessions on that machine.
              </span>
              {machines.length > 0 && (
                <span className="re-sec-count">
                  {machines.length} machine{machines.length === 1 ? '' : 's'} · {busySlots} / {allSlots} slots busy
                </span>
              )}
            </div>
          }
        />
      </div>
    </div>
  );
}
