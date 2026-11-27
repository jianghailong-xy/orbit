import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { useLiveTerminalRequests } from '../TerminalRequests';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  ApiOutlined,
  GithubOutlined,
  BellOutlined,
  BlockOutlined,
  CloudOutlined,
  CodeOutlined,
  DatabaseOutlined,
  FolderOutlined,
  HolderOutlined,
  KeyOutlined,
  LockOutlined,
  LeftOutlined,
  LinkOutlined,
  OrderedListOutlined,
  PlusOutlined,
  SearchOutlined,
  SettingOutlined,
  SunOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { MANAGED_RUNNER_COPY, type ManagedRunnerRow } from '@orbit/shared';
import { api } from '../../api';
import { routeId } from '../../lib/idCodec';
import { machineName } from '../../lib/machineSetup';
import { MachineOsIcon } from '../../lib/machineOs';
import { MANAGED_UPDATE_ROW_LABEL, MANAGED_UPDATE_ROW_TITLE } from '../../lib/runnerCopy';
import { managedRowOf, useManagedRunner, useManagedRunnerId } from '../../lib/managedRunner';
import { Spinner } from '../ui/Spinner';
import { Tooltip, TEXT_TOOLTIP_DELAY_MS } from '../ui/Tooltip';
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
import { useToast } from '../../lib/toast';
import { getWebPushConfig } from '../../lib/webPush';
import { useMediaQuery } from '../../lib/useMediaQuery';
import { INTEGRATION_PAGES, MODEL_ROUTING_PAGE, PERSONAL_PAGES } from '../../pages/settings/settingsIndex';
import { ControlPlaneProvider } from '../../lib/useControlPlane';
import { ImpersonationBanner } from '../ImpersonationBanner';
import { HelpDrawer } from '../HelpDrawer';

import type { Runner } from '../TasksSidePanel';
import { SettingChangedLine, SettingChangedLineSlot } from './SettingChangedLine';
import { around, searchSettings, type SettingsHit, type SettingsHitGroup } from './settingsSearch';
import './Settings.css';
import { sidebarWidthStyle } from '../../lib/sidebarWidth';

/** Personal's rows' icons; the rows themselves, in the board's order, are the Settings index's pages. */
const PERSONAL_ICONS: Record<(typeof PERSONAL_PAGES)[number]['path'], ReactNode> = {
  '/settings/general': <SettingOutlined />,
  '/settings/notifications': <BellOutlined />,
  '/settings/appearance': <SunOutlined />,
  '/settings/profile': <UserOutlined />,
  '/settings/shared-links': <LinkOutlined />,
  '/settings/access-tokens': <KeyOutlined />,
  '/settings/secrets': <LockOutlined />,
};

/** Integrations' rows' icons, one per connected service. */
const INTEGRATION_ICONS: Record<(typeof INTEGRATION_PAGES)[number]['path'], ReactNode> = {
  '/settings/integrations/feishu': <ApiOutlined />,
  '/settings/integrations/github': <GithubOutlined />,
};

/** Below this width (board-6) the nav is a page of its own at /settings, and each page opens full width. */
export const NARROW_SETTINGS_QUERY = '(max-width: 759.98px)';

/** How long a row search opened stays lit. */
export const FOUND_ROW_MS = 2000;

type MachineState = 'online' | 'attention' | 'offline';
const MACHINE_STATE_LABEL: Record<MachineState, string> = {
  online: 'Online',
  attention: 'Needs you',
  offline: 'Offline',
};

type SettingsWorkspace = AttentionWorkspace & {
  runnerId?: string | null;
  runner?: { id: string; name?: string; displayName?: string | null } | null;
  /** When a conversation last started or took a turn there (null = never). */
  lastActiveAt?: string | null;
};

/** Most recently used first; never used last, in the list's own order. */
export function byRecentUse<T extends { lastActiveAt?: string | null }>(workspaces: readonly T[]): T[] {
  const at = (w: T) => (w.lastActiveAt ? Date.parse(w.lastActiveAt) || 0 : 0);
  return workspaces
    .map((w, index) => ({ w, index }))
    .sort((a, b) => at(b.w) - at(a.w) || a.index - b.index)
    .map(({ w }) => w);
}

/**
 * The Settings window (owner's choice A1): Settings takes over the whole window, the app's own sidebar
 * gone, with a nav of five groups on the left — Personal, Integrations, Machines, Providers, Workspaces — and the
 * chosen page in a centred column on the right. "Back to Orbit" and Esc go back to the page Settings
 * was opened from; Esc clears a search first.
 *
 * Narrower than 760px (board-6) the two stop sitting side by side: /settings is the nav alone, and a
 * page opens full width with "‹ Settings" above it to go back to the list.
 */
export function SettingsLayout() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const narrow = useMediaQuery(NARROW_SETTINGS_QUERY);
  const atList = pathname.replace(/\/+$/, '') === '/settings';
  const [query, setQuery] = useState('');
  useFoundRowFlash();

  // Esc clears the search, then leaves Settings, unless something drawn over it (a dialog, a drawer,
  // an open menu) takes the key.
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return;
      const overlay = document.querySelector(
        '[role="dialog"], [role="alertdialog"], [aria-modal="true"], [role="menu"], [role="listbox"]',
      );
      if (overlay) return;
      if (query) {
        setQuery('');
        return;
      }
      navigate(settingsReturnPath());
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [navigate, query]);

  return (
    <ControlPlaneProvider>
      <ImpersonationBanner />
      <div className={narrow ? 'settings-shell settings-shell--narrow' : 'settings-shell'}>
        {(!narrow || atList) && <SettingsNav query={query} onQuery={setQuery} />}
        {/* At /settings in a narrow window the list is the page: the index route, which opens General
            beside the nav, is not drawn until the window is wide again. */}
        {(!narrow || !atList) && (
          <main className="settings-main">
            <div className="settings-column">
              {narrow && (
                <button type="button" className="settings-back settings-back--list" onClick={() => navigate('/settings')}>
                  <LeftOutlined />
                  <span>Settings</span>
                </button>
              )}
              <SettingChangedLineSlot.Provider value={SettingChangedLine}>
                <Outlet />
              </SettingChangedLineSlot.Provider>
            </div>
          </main>
        )}
        <HelpDrawer />
      </div>
    </ControlPlaneProvider>
  );
}

/**
 * A page opened from a search result is told which row matched (`state.settingsAnchor`): when that row
 * is drawn — at once, or when the page's data arrives — it is scrolled into view and lit for a moment.
 */
function useFoundRowFlash(): void {
  const location = useLocation();
  const anchor = (location.state as { settingsAnchor?: string } | null)?.settingsAnchor;
  useEffect(() => {
    if (!anchor) return undefined;
    let lit: HTMLElement | null = null;
    let unlight: ReturnType<typeof setTimeout> | undefined;
    const find = (): boolean => {
      const row = [...document.querySelectorAll<HTMLElement>('[data-setting-anchor]')].find(
        (element) => element.dataset.settingAnchor === anchor,
      );
      if (!row) return false;
      row.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
      row.classList.add('settings-row--found');
      lit = row;
      unlight = setTimeout(() => row.classList.remove('settings-row--found'), FOUND_ROW_MS);
      return true;
    };
    // Not drawn yet: watch for it a few seconds, then give up.
    const observer = new MutationObserver(() => {
      if (find()) observer.disconnect();
    });
    const giveUp = setTimeout(() => observer.disconnect(), 5000);
    if (!find()) observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      clearTimeout(giveUp);
      clearTimeout(unlight);
      lit?.classList.remove('settings-row--found');
    };
  }, [anchor, location.key]);
}

function SettingsNav({ query, onQuery }: { query: string; onQuery: (query: string) => void }) {
  const navigate = useNavigate();
  const runners = (useQuery(runnersQuery()).data ?? []) as Runner[];
  const workspaces = (useQuery(workspacesQuery()).data ?? []) as SettingsWorkspace[];
  const latestVersion = latestRunnerVersion(useQuery(publishedRunnerVersionQuery()).data, runners);
  const providers = useQuery({
    queryKey: PROVIDERS_LIST_KEY,
    meta: { entities: ['provider'] },
    queryFn: () => api<ProviderRow[]>(PROVIDERS_BASE),
  });
  const pools = useQuery(providerPoolsQuery());
  // The account's managed runner (docs/managed-runner-existing-account-entry-design.md): an entry while the
  // server offers one, then its own machine row in the shared state words. Nothing is read with the feature off.
  const { managed } = useManagedRunner();
  const managedRowFor = (runner: Runner): ManagedRunnerRow | null => managedRowOf(managed, runner.id);
  // Which runner is Orbit Cloud: its row's `managed`, else the status's runnerId (an older server).
  const managedRunnerId = useManagedRunnerId();
  const nowMs = Date.now();
  // The keys page is every key, or one vendor's (/settings/providers/:vendor); not a key's own pages.
  const { pathname } = useLocation();
  const keysPage = /^\/settings\/providers(\/(?!(new|keys|pools|routing)(\/|$))[^/]+)?\/?$/.test(pathname);

  // A terminal on a machine asking to be approved lights that machine's dot (docs/mocks/waiting-on-you-removal/02 ①).
  const terminalRequests = useLiveTerminalRequests();
  const stateOf = (runner: Runner): MachineState => {
    if (runnerIsOffline(runner, nowMs)) return 'offline';
    if (terminalRequests.some((request) => routeId(request.runnerId) === routeId(runner.id))) return 'attention';
    const items = runnerAttention({
      runner,
      workspaces: workspaces.filter((workspace) => workspace.runnerId === runner.id),
      nowMs,
      latestVersion,
      managed: runner.managed === true || !!managedRowFor(runner),
    });
    return items.length > 0 ? 'attention' : 'online';
  };

  // Asked only once there is a query: the This browser row exists, and is found, only where the server sends web push.
  const webPush = useQuery({
    queryKey: ['push', 'web-config'],
    queryFn: getWebPushConfig,
    retry: false,
    enabled: query.trim() !== '',
  });

  const keyCount = providers.data?.length ?? 0;
  const poolCount = pools.data?.length ?? 0;

  const machineOf = (workspace: SettingsWorkspace): string | null => {
    const runner = runners.find((r) => r.id === workspace.runnerId) ?? workspace.runner;
    return runner ? machineName(runner, managedRunnerId) || null : null;
  };

  // New workspace starts by picking its machine; with no machine at all, registering one comes first.
  const addWorkspace = () => navigate(runners.length > 0 ? '/settings/workspaces/new' : '/settings/machines/new');

  return (
    <nav className="settings-nav autohide-scrollbar" aria-label="Settings" style={sidebarWidthStyle()}>
      <button type="button" className="settings-back" onClick={() => navigate(settingsReturnPath())}>
        <LeftOutlined />
        <span>Back to Orbit</span>
      </button>
      <h1 className="settings-title">Settings</h1>
      <SettingsSearch
        query={query}
        onQuery={onQuery}
        groups={searchSettings(query, {
          runners,
          managedRunnerId,
          keys: providers.data ?? [],
          workspaces: workspaces.map((workspace) => ({ ...workspace, machine: machineOf(workspace) })),
          webPush: Boolean(webPush.data),
        })}
      />
      {/* While there is a query its results are the nav; the groups stay mounted, as they were left. */}
      <div className="settings-nav-groups" hidden={query.trim() !== ''}>
        <NavGroup title="Personal">
          {PERSONAL_PAGES.map((page) => (
            <NavRow key={page.path} to={page.path} icon={PERSONAL_ICONS[page.path]} label={page.label} />
          ))}
        </NavGroup>

        <NavGroup title="Integrations">
          {INTEGRATION_PAGES.map((page) => (
            <NavRow key={page.path} to={page.path} icon={INTEGRATION_ICONS[page.path]} label={page.label} />
          ))}
        </NavGroup>

        <NavGroup
          title="Machines"
          add={{ label: 'Register a machine', onClick: () => navigate('/settings/machines/new') }}
          empty={runners.length === 0 && !managed?.display.ensure}
        >
          {managed?.display.ensure && (
            <NavRow
              to="/settings/machines/managed"
              icon={<PlusOutlined />}
              label={MANAGED_RUNNER_COPY.entry.title}
              trailing={<span className="settings-nav-meta">{MANAGED_RUNNER_COPY.entry.action}</span>}
            />
          )}
          {runners.length === 0 ? (
            // With no machine at all, the group is the one way to register one, as Providers does.
            <NavRow to="/settings/machines/new" icon={<PlusOutlined />} label="Register a machine" />
          ) : (
            <MachineRows
              runners={runners}
              managedId={managedRunnerId}
              stateOf={stateOf}
              managedRowOf={managedRowFor}
              cloudUpdate={managed?.status.update?.phase === 'available'}
            />
          )}
        </NavGroup>

        <NavGroup
          title="Providers"
          add={{ label: 'Connect a provider', onClick: () => navigate('/settings/providers/new') }}
          empty={keyCount === 0 && poolCount === 0}
        >
          {keyCount === 0 && poolCount === 0 ? (
            // With no key and no pool at all, the group is the one way to connect a provider.
            <>
              <NavRow to="/settings/providers/new" icon={<PlusOutlined />} label="Connect a provider" />
              {/* The built-in engines have model tiers with no key at all. */}
              <NavRow to={MODEL_ROUTING_PAGE.path} icon={<OrderedListOutlined />} label={MODEL_ROUTING_PAGE.label} />
            </>
          ) : (
            <>
              {/* Two rows however many vendors are connected (choice A, docs/mocks/settings-providers-compact):
                  the keys page holds them all, and stays lit on a vendor's own address. */}
              <NavRow
                to="/settings/providers"
                icon={<CloudOutlined />}
                label="API keys"
                active={keysPage}
                trailing={keyCount > 0 ? <span className="settings-nav-meta">{keyCount}</span> : undefined}
              />
              <NavRow
                to="/settings/providers/pools"
                icon={<BlockOutlined />}
                label="Account pools"
                trailing={poolCount > 0 ? <span className="settings-nav-meta">{poolCount}</span> : undefined}
              />
              {/* Every model's tier, keys' and built-in engines', beside how its runs went: Model tiers and the
                  Routing report on one page. */}
              <NavRow to={MODEL_ROUTING_PAGE.path} icon={<OrderedListOutlined />} label={MODEL_ROUTING_PAGE.label} />
            </>
          )}
        </NavGroup>

        <NavGroup title="Workspaces" add={{ label: 'New workspace', onClick: addWorkspace }} empty={workspaces.length === 0}>
          <WorkspaceRows workspaces={workspaces} machineOf={machineOf} />
        </NavGroup>
      </div>
    </nav>
  );
}

/**
 * The search box and, while it holds a query, its results in place of the nav: grouped as the nav is,
 * the matching words marked. A click, or Enter on the chosen one (the arrows move it, the first to
 * start with), opens the page at the row that matched.
 */
function SettingsSearch({
  query,
  onQuery,
  groups,
}: {
  query: string;
  onQuery: (query: string) => void;
  groups: SettingsHitGroup[];
}) {
  const navigate = useNavigate();
  const [chosen, setChosen] = useState(0);
  const hits = groups.flatMap((group) => group.hits);
  const at = Math.min(chosen, Math.max(hits.length - 1, 0));
  const open = (hit: SettingsHit) => {
    onQuery('');
    navigate(hit.to, { state: hit.anchor ? { settingsAnchor: hit.anchor } : null });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (hits.length > 0) setChosen((at + (event.key === 'ArrowDown' ? 1 : hits.length - 1)) % hits.length);
    } else if (event.key === 'Enter' && hits[at]) {
      event.preventDefault();
      open(hits[at]);
    }
  };
  const searching = query.trim() !== '';
  return (
    <>
      <label className="settings-search">
        <SearchOutlined />
        <input
          type="search"
          placeholder="Search settings"
          aria-label="Search settings"
          value={query}
          onChange={(event) => {
            onQuery(event.target.value);
            setChosen(0);
          }}
          onKeyDown={onKeyDown}
        />
      </label>
      {searching && hits.length === 0 && <div className="settings-nav-none">Nothing in Settings matches.</div>}
      {searching &&
        groups.map((group) => (
          <div key={group.title} className="settings-nav-group" role="group" aria-label={`${group.title} results`}>
            <div className="settings-nav-heading">
              <span>{group.title}</span>
            </div>
            {group.hits.map((hit) => (
              <button
                key={hit.key}
                type="button"
                className={hit === hits[at] ? 'settings-search-hit chosen' : 'settings-search-hit'}
                onClick={() => open(hit)}
              >
                <span className="settings-search-hit-label">
                  <Marked text={hit.label} query={query} />
                </span>
                {hit.detail && (
                  <span className="settings-search-hit-detail">
                    <Marked text={around(hit.detail, query)} query={query} />
                  </span>
                )}
              </button>
            ))}
          </div>
        ))}
    </>
  );
}

/** The text with each place it says the query marked. */
function Marked({ text, query }: { text: string; query: string }) {
  const needle = query.trim().toLowerCase();
  if (!needle) return <>{text}</>;
  const parts: ReactNode[] = [];
  const lower = text.toLowerCase();
  let from = 0;
  for (let at = lower.indexOf(needle); at >= 0; at = lower.indexOf(needle, from)) {
    if (at > from) parts.push(text.slice(from, at));
    parts.push(<mark key={at}>{text.slice(at, at + needle.length)}</mark>);
    from = at + needle.length;
  }
  if (from < text.length) parts.push(text.slice(from));
  return <>{parts}</>;
}

/**
 * The Machines group's rows, in the order every runner list uses, and dragged into a new one: by the
 * row itself with a mouse, or by the grip that shows on hover or focus, which a keyboard picks up with
 * Space or Enter and moves with the arrows. The new order shows at once and goes back if the server
 * refuses it. A press that never moves stays a click, and opens the machine's page.
 * Orbit Cloud is pinned above them and never moves (docs/mocks/orbit-cloud-pinned, A).
 */
function MachineRows({
  runners: all,
  managedId,
  stateOf,
  managedRowOf,
  cloudUpdate = false,
}: {
  runners: Runner[];
  /** A newer build waits for Orbit Cloud (managed.status.update): its row carries the update dot. */
  cloudUpdate?: boolean;
  /** Which runner is Orbit Cloud, if any. */
  managedId: string | null;
  stateOf: (runner: Runner) => MachineState;
  managedRowOf: (runner: Runner) => ManagedRunnerRow | null;
}) {
  const cloud = (managedId && all.find((runner) => routeId(runner.id) === routeId(managedId))) || null;
  const runners = cloud ? all.filter((runner) => runner !== cloud) : all;
  const qc = useQueryClient();
  const message = useToast();
  const reorderMut = useMutation({
    mutationFn: (ids: string[]) => api<Runner[]>('/runners/reorder', { method: 'POST', body: { ids } }),
    // Moved at once, and put back if the server refuses: a row that waited for the round trip
    // would jump back under the pointer first.
    onMutate: async (ids) => {
      await qc.cancelQueries({ queryKey: runnersQuery().queryKey });
      const previous = qc.getQueryData<Runner[]>(runnersQuery().queryKey);
      if (previous) {
        const rank = new Map(ids.map((id, index) => [id, index]));
        qc.setQueryData<Runner[]>(
          runnersQuery().queryKey,
          [...previous]
            .sort(
              (a, b) =>
                (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER),
            )
            .map((runner, position) => ({ ...runner, position })),
        );
      }
      return { previous };
    },
    onError: (e: Error, _ids, context) => {
      if (context?.previous) qc.setQueryData(runnersQuery().queryKey, context.previous);
      message.error("Couldn't reorder the machines", e.message);
    },
    onSuccess: (data) => qc.setQueryData(runnersQuery().queryKey, data),
    onSettled: () => void qc.invalidateQueries({ queryKey: runnersQuery().queryKey }),
  });
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id || reorderMut.isPending) return;
    const from = runners.findIndex((runner) => runner.id === active.id);
    const to = runners.findIndex((runner) => runner.id === over.id);
    if (from < 0 || to < 0) return;
    // Orbit Cloud stays first in the saved order too, for a client that does not pin it.
    reorderMut.mutate([...(cloud ? [cloud] : []), ...arrayMove(runners, from, to)].map((runner) => runner.id));
  };
  return (
    <>
      {cloud && (
        <div className="settings-nav-cloud">
          <NavRow
            to={`/settings/machines/${cloud.id}`}
            icon={<CloudOutlined />}
            label={machineName(cloud, cloud.id)}
            trailing={<MachineRowState state={stateOf(cloud)} managedRow={managedRowOf(cloud)} update={cloudUpdate} />}
          />
          {runners.length > 0 && <div className="settings-nav-divider" role="separator" />}
        </div>
      )}
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={runners.map((runner) => runner.id)} strategy={verticalListSortingStrategy}>
          {runners.map((runner) => (
            <MachineRow
              key={runner.id}
              runner={runner}
              state={stateOf(runner)}
              managedRow={managedRowOf(runner)}
              dragDisabled={reorderMut.isPending}
            />
          ))}
        </SortableContext>
      </DndContext>
    </>
  );
}

/** A machine row's state: the managed runner's shared short label, else a dot. */
function MachineRowState({
  state,
  managedRow,
  update,
}: {
  state: MachineState;
  managedRow: ManagedRunnerRow | null;
  update?: boolean;
}) {
  return managedRow ? (
    <ManagedRowState row={managedRow} update={update} />
  ) : (
    <Tooltip content={MACHINE_STATE_LABEL[state]} delay={TEXT_TOOLTIP_DELAY_MS}>
      <span
        className={`settings-dot settings-dot--${state}`}
        role="img"
        aria-label={MACHINE_STATE_LABEL[state]}
      />
    </Tooltip>
  );
}

function MachineRow({
  runner,
  state,
  managedRow,
  dragDisabled,
}: {
  runner: Runner;
  state: MachineState;
  /** The account's managed runner: its shared short label in place of Online/Offline (D4). */
  managedRow: ManagedRunnerRow | null;
  dragDisabled: boolean;
}) {
  const { attributes, listeners, setActivatorNodeRef, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: runner.id, disabled: dragDisabled });
  // The managed runner (the one with a managed row) is Orbit Cloud.
  const name = machineName(runner, managedRow ? runner.id : null);
  // The click a drag ends with is the drag's, not the link's. dnd-kit stops that click at the
  // document, before React's handlers, which leaves the browser to follow the link's href with a
  // full page load to the machine just moved; the window sees it first, and cancels it.
  const node = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!isDragging) return;
    let giveUp: ReturnType<typeof setTimeout> | undefined;
    const remove = () => {
      clearTimeout(giveUp);
      window.removeEventListener('click', swallow, true);
    };
    const swallow = (event: MouseEvent) => {
      remove();
      if (node.current?.contains(event.target as Node)) event.preventDefault();
    };
    window.addEventListener('click', swallow, true);
    return () => {
      // The click follows pointerup even when React's work between them is delayed. Keep a generous
      // cap only so a synthetic or cancelled drag that produces no click cannot leave the listener.
      giveUp = setTimeout(remove, 1000);
    };
  }, [isDragging]);
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    // A finger on the row scrolls the nav; only the grip drags by touch.
    if (event.pointerType === 'touch' && !(event.target as Element).closest('.settings-nav-grip')) return;
    listeners?.onPointerDown?.(event);
  };
  return (
    <div
      ref={(element) => {
        node.current = element;
        setNodeRef(element);
      }}
      className={`settings-nav-sortable${isDragging ? ' dragging' : ''}`}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      onPointerDown={onPointerDown}
    >
      <NavRow
        to={`/settings/machines/${runner.id}`}
        icon={<MachineOsIcon runner={runner} />}
        label={name}
        trailing={<MachineRowState state={state} managedRow={managedRow} />}
      />
      <Tooltip content="Drag to reorder" disabled={isDragging}>
        <button
          ref={setActivatorNodeRef}
          type="button"
          className="settings-nav-grip"
          disabled={dragDisabled}
          {...attributes}
          aria-label={`Reorder ${name}`}
          onKeyDown={(event) => listeners?.onKeyDown?.(event)}
        >
          <HolderOutlined />
        </button>
      </Tooltip>
    </div>
  );
}

/** The managed runner's state on its machine row: a spinner while it moves, else a dot, and the short label. */
export function ManagedRowState({ row, update }: { row: ManagedRunnerRow; update?: boolean }) {
  // A newer build waits (managed.status.update): the same update dot and word a self-managed machine's row gets.
  if (update && row.tone === 'ready') {
    return (
      <Tooltip content={MANAGED_UPDATE_ROW_TITLE} delay={TEXT_TOOLTIP_DELAY_MS}>
        <span className="settings-managed-state" data-kind={row.kind} data-update>
          <span className="settings-dot settings-dot--update" aria-hidden />
          <span className="settings-nav-meta settings-nav-meta--update">{MANAGED_UPDATE_ROW_LABEL}</span>
        </span>
      </Tooltip>
    );
  }
  return (
    <Tooltip content={row.detail ?? row.label} delay={TEXT_TOOLTIP_DELAY_MS}>
      <span className="settings-managed-state" data-kind={row.kind}>
        {row.tone === 'progress' ? (
          <Spinner size="small" aria-hidden />
        ) : (
          <span className={`settings-dot settings-dot--${MANAGED_DOT[row.tone]}`} aria-hidden />
        )}
        <span className="settings-nav-meta">{row.label}</span>
      </span>
    </Tooltip>
  );
}

const MANAGED_DOT: Record<ManagedRunnerRow['tone'], MachineState> = {
  ready: 'online',
  progress: 'online',
  idle: 'offline',
  attention: 'attention',
};

/**
 * The Workspaces group's rows: every workspace, most recently used first, each with its machine in
 * grey (two workspaces of one name on two machines stay apart). The owner asked for no fold here.
 */
function WorkspaceRows({
  workspaces,
  machineOf,
}: {
  workspaces: SettingsWorkspace[];
  machineOf: (workspace: SettingsWorkspace) => string | null;
}) {
  return (
    <>
      {byRecentUse(workspaces).map((workspace) => {
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
    </>
  );
}

export function NavGroup({
  title,
  add,
  empty,
  children,
}: {
  title: string;
  add?: { label: string; onClick: () => void };
  /** Nothing in the group yet: its + stays in sight, not only under the pointer. */
  empty?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={empty ? 'settings-nav-group settings-nav-group--empty' : 'settings-nav-group'} role="group" aria-label={title}>
      <div className="settings-nav-heading">
        <span>{title}</span>
        {add && (
          <Tooltip content={add.label} align="end">
            <button type="button" className="settings-nav-add" aria-label={add.label} onClick={add.onClick}>
              <PlusOutlined />
            </button>
          </Tooltip>
        )}
      </div>
      {children}
    </div>
  );
}

export function NavRow({
  to,
  icon,
  label,
  trailing,
  active,
}: {
  to: string;
  icon: ReactNode;
  label: string;
  trailing?: ReactNode;
  /** Lit on more addresses than its own, where it is given. */
  active?: boolean;
}) {
  return (
    // Not a native drag: a row a pointer drags is the Machines group's reorder (MachineRows).
    <NavLink
      to={to}
      draggable={false}
      className={({ isActive }) => `settings-nav-row${(active ?? isActive) ? ' active' : ''}`}
    >
      <span className="settings-nav-icon">{icon}</span>
      <span className="settings-nav-label">{label}</span>
      {trailing}
    </NavLink>
  );
}
