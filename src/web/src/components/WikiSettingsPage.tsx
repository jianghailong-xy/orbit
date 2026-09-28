import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ExclamationCircleOutlined, RightOutlined } from '@ant-design/icons';
import { App, Button, Card, InputNumber, Modal, Radio, Select, Switch } from 'antd';
import {
  WIKI_DEFAULT_MAINTENANCE_SETTINGS,
  WIKI_MAINTENANCE_DAILY_RUN_LIMIT,
  wikiSpaceSettings,
  type WikiMaintenanceSettings,
  type WikiReviewMode,
} from '@orbit/shared';
import { providersQuery, workspacesQuery } from '../lib/queries';
import { WIKI_TITLE, wikiSpacePath, type WikiSpaceRow } from '../lib/wiki';
import {
  WIKI_CANCEL,
  WIKI_DAILY_LIMIT,
  WIKI_DAILY_LIMIT_NOTE,
  WIKI_DEFAULT_REVIEW_MODE,
  WIKI_FLOORS_LEAD,
  WIKI_FLOORS_NOTE,
  WIKI_MAINTENANCE,
  WIKI_MAINTENANCE_EDIT,
  WIKI_MAINTENANCE_NAME,
  WIKI_MAINTENANCE_NOTE,
  WIKI_MODE_DEFAULT,
  WIKI_MODE_LABELS,
  WIKI_MODE_NOTES,
  WIKI_MODE_ORDER,
  WIKI_NO_WORKSPACE,
  WIKI_OFF,
  WIKI_ON,
  WIKI_PINNED_NO_FALLBACK,
  WIKI_PROVIDER,
  WIKI_PROVIDER_NOTE,
  WIKI_REVIEW_MODE,
  WIKI_REVIEW_MODE_HINT,
  WIKI_REVIEW_MODE_LEAD,
  WIKI_RUNS_A_DAY,
  WIKI_SAVE,
  WIKI_SETTINGS,
  WIKI_SETTINGS_TITLE,
  WIKI_SET_UP,
  WIKI_SET_UP_TITLE,
  WIKI_SPOT_CHECK,
  WIKI_SPOT_CHECK_NOTE,
  WIKI_STATUS,
  WIKI_TURN_OFF,
  WIKI_TURN_ON,
  WIKI_WORKSPACE,
  WIKI_WORKSPACE_NOTE,
  wikiModeFallback,
  wikiProviderLabel,
  wikiRunsADay,
  wikiWorkspaceLabel,
} from '../lib/wikiReviewMode';
import { updateWikiSpace, useWikiWrite, type WikiSpaceUpdate } from '../lib/wikiWrites';
import type { ConfiguredProvider } from '../lib/workspaceDefaults';

/**
 * Wiki settings (criterion 8, mocks 19–20): which review mode the space runs in, whether Automatic
 * sends spot checks, and the space's Wiki maintenance run.
 *
 * THE APP'S OWN SETTINGS PAGE, not a new one: one centred column of AntD cards, a sentence on the
 * left and its control on the right (`SettingsPage.tsx`). What differs is only that these settings
 * belong to one space, which is why the page lives under `/wiki/:space`.
 *
 * EVERY CONTROL WRITES AT ONCE, through the owner's door (`PATCH /wiki/spaces/:id`), which refuses any
 * request that carries a session header — the mode that decides what an agent's writes do is never an
 * agent's to set. The page then reads the space again, so what it shows is what the server kept.
 */
export function WikiSettingsPage({ space }: { space: WikiSpaceRow }) {
  const settings = wikiSpaceSettings(space.settings);
  const { message } = App.useApp();
  const write = useWikiWrite((body: WikiSpaceUpdate) => updateWikiSpace(space.id, body));
  const [setUp, setSetUp] = useState(false);

  const save = async (body: WikiSpaceUpdate) => {
    try {
      await write.mutateAsync(body);
      message.success('Saved');
    } catch (error) {
      message.error(error instanceof Error ? error.message : 'The server refused it');
    }
  };

  const fallback = wikiModeFallback(settings);
  const mode = settings.reviewMode;

  return (
    <div className="wk-settings">
      <div className="wk-crumb">
        <Link to={wikiSpacePath(space.slug)}>{WIKI_TITLE}</Link>
        <RightOutlined className="ic" />
        <span>{WIKI_SETTINGS}</span>
      </div>
      <h1 className="page-title">{WIKI_SETTINGS_TITLE}</h1>
      <div className="wk-settings-sub">
        {space.slug}
        {space.repoUrlNorm ? ` · ${space.repoUrlNorm}` : ''}
      </div>

      <Card
        className="wk-settings-card"
        title={WIKI_REVIEW_MODE}
        extra={<span className="wk-settings-hint">{WIKI_REVIEW_MODE_HINT}</span>}
      >
        {fallback && (
          <div className="wk-warn" role="status">
            <ExclamationCircleOutlined className="ic" />
            <span>{fallback}</span>
          </div>
        )}
        <div className="wk-settings-lead">{WIKI_REVIEW_MODE_LEAD}</div>
        <Radio.Group
          className="wk-modes"
          value={mode}
          disabled={write.isPending}
          onChange={(event) => void save({ reviewMode: event.target.value as WikiReviewMode })}
        >
          {WIKI_MODE_ORDER.map((value) => (
            <div className={`wk-mode${value === mode ? ' on' : ''}`} key={value}>
              <Radio value={value}>
                <span className="wk-mode-t">{WIKI_MODE_LABELS[value]}</span>
                {value === WIKI_DEFAULT_REVIEW_MODE && <span className="wk-mode-tag">{WIKI_MODE_DEFAULT}</span>}
              </Radio>
              <div className="wk-mode-d">{WIKI_MODE_NOTES[value]}</div>
              {value === 'automatic' && (
                <div className={`wk-spot${mode === 'automatic' ? '' : ' off'}`}>
                  <div>
                    <div className="wk-spot-t">{WIKI_SPOT_CHECK}</div>
                    <div className="wk-spot-d">{WIKI_SPOT_CHECK_NOTE}</div>
                  </div>
                  <Switch
                    aria-label={WIKI_SPOT_CHECK}
                    checked={settings.automaticSpotChecks}
                    disabled={mode !== 'automatic' || write.isPending}
                    onChange={(checked) => void save({ automaticSpotChecks: checked })}
                  />
                </div>
              )}
            </div>
          ))}
        </Radio.Group>
        <div className="aa-ask wk-floors">
          <b>{WIKI_FLOORS_LEAD}</b> {WIKI_FLOORS_NOTE}
        </div>
      </Card>

      <Card className="wk-settings-card" title={WIKI_MAINTENANCE}>
        {settings.maintenance.enabled ? (
          <MaintenanceOn
            maintenance={settings.maintenance}
            busy={write.isPending}
            onEdit={() => setSetUp(true)}
            onTurnOff={() => void save({ maintenance: { enabled: false } })}
          />
        ) : (
          <div className="wk-maint-off">
            <div>
              <div className="wk-maint-t">{WIKI_MAINTENANCE_NAME}</div>
              <div className="wk-maint-d">{WIKI_MAINTENANCE_NOTE}</div>
            </div>
            <span className="wk-maint-state">
              <span className="wk-dot proposed" aria-hidden="true" /> {WIKI_OFF}
            </span>
            <Button onClick={() => setSetUp(true)}>{WIKI_SET_UP}</Button>
          </div>
        )}
      </Card>

      {setUp && (
        <MaintenanceSetUp
          maintenance={settings.maintenance}
          spaceSlug={space.slug}
          onClose={() => setSetUp(false)}
          onSubmit={async (maintenance) => {
            await write.mutateAsync({ maintenance });
            message.success('Saved');
          }}
        />
      )}
    </div>
  );
}

/** Maintenance once it is on: where it runs, on what, and how often it may — then Edit and Turn off. */
function MaintenanceOn({
  maintenance,
  busy,
  onEdit,
  onTurnOff,
}: {
  maintenance: WikiMaintenanceSettings;
  busy: boolean;
  onEdit: () => void;
  onTurnOff: () => void;
}) {
  const workspaces = useQuery(workspacesQuery());
  const workspace = (workspaces.data ?? []).find((row) => row.id === maintenance.workspaceId);
  return (
    <>
      <div className="wk-maint-rows">
        <span className="k">{WIKI_STATUS}</span>
        <span className="v">
          <span className="wk-dot on" aria-hidden="true" /> {WIKI_ON}
        </span>
        <span className="k">{WIKI_WORKSPACE}</span>
        <span className="v">{workspace ? wikiWorkspaceLabel(workspace) : (maintenance.workspaceId ?? '—')}</span>
        <span className="k">{WIKI_PROVIDER}</span>
        <span className="v">
          {maintenance.provider} <span className="dim">· {WIKI_PINNED_NO_FALLBACK}</span>
        </span>
        <span className="k">{WIKI_DAILY_LIMIT}</span>
        <span className="v">{wikiRunsADay(maintenance.dailyRunLimit)}</span>
      </div>
      <div className="wk-maint-foot">
        <Button onClick={onEdit} disabled={busy}>
          {WIKI_MAINTENANCE_EDIT}
        </Button>
        <Button type="text" danger onClick={onTurnOff} disabled={busy}>
          {WIKI_TURN_OFF}
        </Button>
      </div>
    </>
  );
}

/**
 * Set up maintenance: the workspace it runs in, the provider it is pinned to and how many runs a day
 * it may start — then Turn on (or Save, for one already on).
 *
 * THE PROVIDERS ARE THE ONES THE SERVER TAKES: configured providers on the Claude Code runtime, since
 * a maintenance run starts a clean Claude Code (contract `space.settings.maintenance.provider`). The
 * one the space already names stays in the list even when this account has not configured it yet —
 * the server takes a name it does not know, and refuses the run that finds it still missing.
 */
function MaintenanceSetUp({
  maintenance,
  spaceSlug,
  onClose,
  onSubmit,
}: {
  maintenance: WikiMaintenanceSettings;
  spaceSlug: string;
  onClose: () => void;
  onSubmit: (maintenance: NonNullable<WikiSpaceUpdate['maintenance']>) => Promise<void>;
}) {
  const workspaces = useQuery(workspacesQuery());
  const providers = useQuery(providersQuery());
  const rows = (workspaces.data ?? []) as Array<{ id: string; name?: string; runner?: { name?: string; displayName?: string } }>;
  // A space names a codebase, and so does a workspace's name more often than not: the one called
  // what the space is called is where its runs most likely belong, so it is the first offered.
  const [workspaceId, setWorkspaceId] = useState<string | null>(
    () => maintenance.workspaceId ?? rows.find((row) => row.name === spaceSlug)?.id ?? null,
  );
  const [provider, setProvider] = useState(maintenance.provider || WIKI_DEFAULT_MAINTENANCE_SETTINGS.provider);
  const [limit, setLimit] = useState(maintenance.dailyRunLimit);
  const [saving, setSaving] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const chosen = workspaceId ?? rows.find((row) => row.name === spaceSlug)?.id ?? null;

  const providerOptions = useMemo(() => {
    const claude = ((providers.data ?? []) as ConfiguredProvider[]).filter((row) => row.runtime === 'claude');
    const options = claude.map((row) => ({
      value: row.slug,
      label: wikiProviderLabel(row.slug, row.defaultModel ?? row.models[0]?.value ?? null),
    }));
    if (!options.some((option) => option.value === provider)) options.unshift({ value: provider, label: provider });
    return options;
  }, [providers.data, provider]);

  const submit = async () => {
    if (!chosen) return;
    setSaving(true);
    setRefusal(null);
    try {
      await onSubmit({ enabled: true, workspaceId: chosen, provider, dailyRunLimit: limit });
      onClose();
    } catch (error) {
      setSaving(false);
      setRefusal(error instanceof Error ? error.message : 'The server refused it');
    }
  };

  return (
    <Modal
      open
      title={WIKI_SET_UP_TITLE}
      onCancel={onClose}
      onOk={submit}
      okText={maintenance.enabled ? WIKI_SAVE : WIKI_TURN_ON}
      cancelText={WIKI_CANCEL}
      okButtonProps={{ disabled: !chosen }}
      confirmLoading={saving}
      destroyOnHidden
    >
      <p className="wk-modal-note">{WIKI_MAINTENANCE_NOTE}</p>
      <div className="wk-setup">
        <label className="wk-setup-k" htmlFor="wk-setup-workspace">
          {WIKI_WORKSPACE}
        </label>
        <Select
          id="wk-setup-workspace"
          value={chosen ?? undefined}
          placeholder={WIKI_NO_WORKSPACE}
          onChange={(value: string) => setWorkspaceId(value)}
          options={rows.map((row) => ({ value: row.id, label: wikiWorkspaceLabel(row) }))}
          loading={workspaces.isLoading}
        />
        <div className="wk-setup-d">{WIKI_WORKSPACE_NOTE}</div>

        <label className="wk-setup-k" htmlFor="wk-setup-provider">
          {WIKI_PROVIDER}
        </label>
        <Select
          id="wk-setup-provider"
          value={provider}
          onChange={(value: string) => setProvider(value)}
          options={providerOptions}
          loading={providers.isLoading}
        />
        <div className="wk-setup-d">{WIKI_PROVIDER_NOTE}</div>

        <label className="wk-setup-k" htmlFor="wk-setup-limit">
          {WIKI_DAILY_LIMIT}
        </label>
        <div className="wk-setup-limit">
          <InputNumber
            id="wk-setup-limit"
            min={WIKI_MAINTENANCE_DAILY_RUN_LIMIT.min}
            max={WIKI_MAINTENANCE_DAILY_RUN_LIMIT.max}
            precision={0}
            value={limit}
            onChange={(value) => setLimit(typeof value === 'number' ? value : maintenance.dailyRunLimit)}
          />
          <span>{WIKI_RUNS_A_DAY}</span>
        </div>
        <div className="wk-setup-d">{WIKI_DAILY_LIMIT_NOTE}</div>
      </div>
      {refusal && (
        <div className="wk-warn wk-setup-refusal" role="alert">
          <ExclamationCircleOutlined className="ic" />
          <span>{refusal}</span>
        </div>
      )}
    </Modal>
  );
}
