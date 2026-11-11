import { useEffect, type ReactNode } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  ApiOutlined,
  BellOutlined,
  BlockOutlined,
  CloudOutlined,
  DatabaseOutlined,
  FolderOutlined,
  HddOutlined,
  KeyOutlined,
  LeftOutlined,
  LinkOutlined,
  PlusOutlined,
  SearchOutlined,
  SettingOutlined,
  SunOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { api } from '../../api';
import { publishedRunnerVersionQuery, runnersQuery, workspacesQuery } from '../../lib/queries';
import { PROVIDERS_BASE, PROVIDERS_LIST_KEY, type ProviderRow } from '../../lib/providerAdmin';
import { providerPoolsQuery } from '../../lib/providerPools';
import {
  latestRunnerVersion,
  runnerAttention,
  runnerIsOffline,
  type AttentionWorkspace,
} from '../../lib/runnerAttention';
import { settingsReturnPath } from '../../lib/settingsReturn';
import { ControlPlaneProvider } from '../../lib/useControlPlane';
import { ImpersonationBanner } from '../ImpersonationBanner';
import { vendorName, vendorOf } from '../ProviderGallery';
import type { Runner } from '../TasksSidePanel';
import './Settings.css';

/** Personal's rows, in the board's order (docs/mocks/settings-redesign, board-2). */
const PERSONAL: ReadonlyArray<{ to: string; label: string; icon: ReactNode }> = [
  { to: '/settings/general', label: 'General', icon: <SettingOutlined /> },
  { to: '/settings/notifications', label: 'Notifications', icon: <BellOutlined /> },
  { to: '/settings/appearance', label: 'Appearance', icon: <SunOutlined /> },
  { to: '/settings/profile', label: 'Profile', icon: <UserOutlined /> },
  { to: '/settings/storage', label: 'Storage', icon: <DatabaseOutlined /> },
  { to: '/settings/shared-links', label: 'Shared links', icon: <LinkOutlined /> },
  { to: '/settings/access-tokens', label: 'Access tokens', icon: <KeyOutlined /> },
  { to: '/settings/integrations/feishu', label: 'Feishu', icon: <ApiOutlined /> },
];

type MachineState = 'online' | 'attention' | 'offline';
const MACHINE_STATE_LABEL: Record<MachineState, string> = {
  online: 'Online',
  attention: 'Needs you',
  offline: 'Offline',
};

type SettingsWorkspace = AttentionWorkspace & {
  runnerId?: string | null;
  runner?: { id: string; name?: string; displayName?: string | null } | null;
};

const runnerName = (runner: Pick<Runner, 'name' | 'displayName'>): string =>
  runner.displayName?.trim() || runner.name;

/**
 * The Settings window (owner's choice A1): Settings takes over the whole window, the app's own sidebar
 * gone, with a nav of four groups on the left — Personal, Machines, Providers, Workspaces — and the
 * chosen page in a centred column on the right. "Back to Orbit" and Esc go back to the page Settings
 * was opened from.
 */
export function SettingsLayout() {
  const navigate = useNavigate();

  // Esc leaves Settings, unless something drawn over it (a dialog, a drawer, an open menu) takes the key.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return;
      const overlay = document.querySelector(
        '[role="dialog"], [role="alertdialog"], [aria-modal="true"], [role="menu"], [role="listbox"]',
      );
      if (overlay) return;
      navigate(settingsReturnPath());
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [navigate]);

  return (
    <ControlPlaneProvider>
      <ImpersonationBanner />
      <div className="settings-shell">
        <SettingsNav />
        <main className="settings-main">
          <div className="settings-column">
            <Outlet />
          </div>
        </main>
      </div>
    </ControlPlaneProvider>
  );
}

function SettingsNav() {
  const navigate = useNavigate();
  const runners = (useQuery(runnersQuery()).data ?? []) as Runner[];
  const workspaces = (useQuery(workspacesQuery()).data ?? []) as SettingsWorkspace[];
  const latestVersion = latestRunnerVersion(useQuery(publishedRunnerVersionQuery()).data, runners);
  const providers = useQuery({ queryKey: PROVIDERS_LIST_KEY, queryFn: () => api<ProviderRow[]>(PROVIDERS_BASE) });
  const pools = useQuery(providerPoolsQuery());
  const nowMs = Date.now();

  const stateOf = (runner: Runner): MachineState => {
    if (runnerIsOffline(runner, nowMs)) return 'offline';
    const items = runnerAttention({
      runner,
      workspaces: workspaces.filter((workspace) => workspace.runnerId === runner.id),
      nowMs,
      latestVersion,
    });
    return items.length > 0 ? 'attention' : 'online';
  };

  // A row per vendor, in the order of each vendor's first key.
  const vendors = new Map<string, number>();
  for (const row of providers.data ?? []) {
    const vendor = vendorOf(row.presetSlug);
    vendors.set(vendor, (vendors.get(vendor) ?? 0) + 1);
  }
  const poolCount = pools.data?.length ?? 0;

  const machineOf = (workspace: SettingsWorkspace): string | null => {
    const runner = runners.find((r) => r.id === workspace.runnerId) ?? workspace.runner;
    return runner ? runner.displayName?.trim() || runner.name || null : null;
  };

  // Until Settings has its own new-workspace page, + opens a machine's Add workspace: the first one
  // online, else the first one; with no machine at all, registering one comes first.
  const addWorkspace = () => {
    const runner = runners.find((r) => !runnerIsOffline(r, nowMs)) ?? runners[0];
    navigate(runner ? `/settings/workspaces/new?machine=${runner.id}` : '/runners/register');
  };

  return (
    <nav className="settings-nav" aria-label="Settings">
      <button type="button" className="settings-back" onClick={() => navigate(settingsReturnPath())}>
        <LeftOutlined />
        <span>Back to Orbit</span>
      </button>
      <h1 className="settings-title">Settings</h1>
      <label className="settings-search">
        <SearchOutlined />
        <input type="search" placeholder="Search settings" aria-label="Search settings" />
      </label>

      <NavGroup title="Personal">
        {PERSONAL.map((item) => (
          <NavRow key={item.to} to={item.to} icon={item.icon} label={item.label} />
        ))}
      </NavGroup>

      <NavGroup title="Machines" add={{ label: 'Register a machine', onClick: () => navigate('/runners/register') }}>
        {runners.map((runner) => {
          const state = stateOf(runner);
          return (
            <NavRow
              key={runner.id}
              to={`/settings/machines/${runner.id}`}
              icon={<HddOutlined />}
              label={runnerName(runner)}
              trailing={
                <span
                  className={`settings-dot settings-dot--${state}`}
                  role="img"
                  aria-label={MACHINE_STATE_LABEL[state]}
                  title={MACHINE_STATE_LABEL[state]}
                />
              }
            />
          );
        })}
      </NavGroup>

      <NavGroup title="Providers" add={{ label: 'Connect a provider', onClick: () => navigate('/settings/providers/new') }}>
        {vendors.size === 0 && poolCount === 0 ? (
          // With no key and no pool at all, the group is the one way to connect a provider.
          <NavRow to="/settings/providers/new" icon={<PlusOutlined />} label="Connect a provider" />
        ) : (
          <>
            {[...vendors].map(([vendor, count]) => (
              <NavRow
                key={vendor}
                to={`/settings/providers/${vendor}`}
                icon={<CloudOutlined />}
                label={vendorName(vendor)}
                trailing={<span className="settings-nav-meta">{count === 1 ? '1 key' : `${count} keys`}</span>}
              />
            ))}
            <NavRow
              to="/settings/providers/pools"
              icon={<BlockOutlined />}
              label="Account pools"
              trailing={poolCount > 0 ? <span className="settings-nav-meta">{poolCount}</span> : undefined}
            />
          </>
        )}
      </NavGroup>

      <NavGroup title="Workspaces" add={{ label: 'Add a workspace', onClick: addWorkspace }}>
        {workspaces.map((workspace) => {
          const machine = machineOf(workspace);
          return (
            <NavRow
              key={workspace.id}
              to={`/settings/workspaces/${workspace.id}`}
              icon={<FolderOutlined />}
              label={workspace.name}
              trailing={machine ? <span className="settings-nav-meta">{machine}</span> : undefined}
            />
          );
        })}
      </NavGroup>
    </nav>
  );
}

function NavGroup({
  title,
  add,
  children,
}: {
  title: string;
  add?: { label: string; onClick: () => void };
  children: ReactNode;
}) {
  return (
    <div className="settings-nav-group" role="group" aria-label={title}>
      <div className="settings-nav-heading">
        <span>{title}</span>
        {add && (
          <button type="button" className="settings-nav-add" aria-label={add.label} title={add.label} onClick={add.onClick}>
            <PlusOutlined />
          </button>
        )}
      </div>
      {children}
    </div>
  );
}

function NavRow({ to, icon, label, trailing }: { to: string; icon: ReactNode; label: string; trailing?: ReactNode }) {
  return (
    <NavLink to={to} className={({ isActive }) => `settings-nav-row${isActive ? ' active' : ''}`}>
      <span className="settings-nav-icon">{icon}</span>
      <span className="settings-nav-label">{label}</span>
      {trailing}
    </NavLink>
  );
}
