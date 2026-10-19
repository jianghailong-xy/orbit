import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ExclamationCircleOutlined, RightOutlined } from '@ant-design/icons';
import {
  WIKI_MAINTENANCE_DAILY_RUN_LIMIT,
  WIKI_MAINTENANCE_LOOKBACK_DAYS,
  wikiSpaceSettings,
  type WikiMaintenanceSettings,
  type WikiReviewMode,
  type WikiSystemModelStatus,
} from '@orbit/shared';
import { wikiSystemModelQuery, workspacesQuery } from '../lib/queries';
import { useToast } from '../lib/toast';
import { WIKI_SETTINGS_SAVED, WIKI_TITLE, wikiSpacePath, type WikiSpaceRow } from '../lib/wiki';
import {
  WIKI_CANCEL,
  WIKI_DAILY_LIMIT,
  WIKI_DAILY_LIMIT_NOTE,
  WIKI_DEFAULT_REVIEW_MODE,
  WIKI_FLOORS_LEAD,
  WIKI_FLOORS_NOTE,
  WIKI_LOOKBACK,
  WIKI_LOOKBACK_CHOICES,
  WIKI_LOOKBACK_NOTE,
  WIKI_LOOKBACK_UNIT,
  WIKI_MAINTENANCE,
  WIKI_MAINTENANCE_EDIT,
  WIKI_MAINTENANCE_NAME,
  WIKI_MAINTENANCE_NOTE_SERVER,
  WIKI_MODE_DEFAULT,
  WIKI_MODE_LABELS,
  WIKI_MODE_NOTES,
  WIKI_MODE_ORDER,
  WIKI_MODEL,
  WIKI_MODEL_NOTE,
  WIKI_NO_WORKSPACE,
  WIKI_OFF,
  WIKI_ON,
  WIKI_REPO_FROM,
  WIKI_REPO_FROM_NOTE,
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
  wikiLookbackChoice,
  wikiLookbackDays,
  wikiLookbackDaysOffered,
  wikiLookbackLabel,
  wikiModeFallback,
  wikiRunsADay,
  wikiWorkspaceLabel,
  type WikiLookbackChoice,
} from '../lib/wikiReviewMode';
import { updateWikiSpace, useWikiWrite, type WikiSpaceUpdate } from '../lib/wikiWrites';
import { WikiModelLine, WikiPrivacyNote } from './WikiSystemModel';
import { Button } from './ui/Button';
import { Card } from './ui/Card';
import { Dialog } from './ui/Dialog';
import { NumberInput } from './ui/NumberInput';
import { Radio, RadioGroup } from './ui/Radio';
import { Select } from './ui/Select';
import { Switch } from './ui/Switch';

/**
 * Wiki settings (criterion 8, mocks 19–20): which review mode the space runs in, whether Automatic
 * sends spot checks, and the space's Wiki maintenance run.
 *
 * THE APP'S OWN SETTINGS PAGE, not a new one: one centred column of the app's cards, a sentence on the
 * left and its control on the right (`SettingsPage.tsx`). What differs is only that these settings
 * belong to one space, which is why the page lives under `/wiki/:space`.
 *
 * EVERY CONTROL WRITES AT ONCE, through the owner's door (`PATCH /wiki/spaces/:id`), which refuses any
 * request that carries a session header — the mode that decides what an agent's writes do is never an
 * agent's to set. The page then reads the space again, so what it shows is what the server kept.
 *
 * THE SERVER EXECUTES THE WIKI (mock 35 ①②), so there is no provider to pick: the workspace is where the repository
 * is read from, and while `GET /wiki/system-model`'s `executor` says the server executes the account's wiki,
 * maintenance names the deployment's System model, read-only with its state, and one sentence says where the
 * wiki's material goes. A read that does not say so — still loading, or a control plane from before it — draws
 * neither.
 */
export function WikiSettingsPage({ space }: { space: WikiSpaceRow }) {
  const settings = wikiSpaceSettings(space.settings);
  const toast = useToast();
  const write = useWikiWrite((body: WikiSpaceUpdate) => updateWikiSpace(space.id, body));
  const [setUp, setSetUp] = useState(false);

  const save = async (body: WikiSpaceUpdate) => {
    try {
      await write.mutateAsync(body);
      toast.success(WIKI_SETTINGS_SAVED);
    } catch (error) {
      toast.error("Couldn't save the wiki settings", error instanceof Error ? error.message : undefined);
    }
  };

  const fallback = wikiModeFallback(settings);
  const mode = settings.reviewMode;
  const systemModel = useQuery(wikiSystemModelQuery());
  const server = systemModel.data?.executor?.serverExecutes ? systemModel.data : null;

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
        <RadioGroup
          className="wk-modes"
          value={mode}
          disabled={write.isPending}
          onValueChange={(value) => void save({ reviewMode: value as WikiReviewMode })}
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
                    onCheckedChange={(checked) => void save({ automaticSpotChecks: checked })}
                  />
                </div>
              )}
            </div>
          ))}
        </RadioGroup>
        <div className="aa-ask wk-floors">
          <b>{WIKI_FLOORS_LEAD}</b> {WIKI_FLOORS_NOTE}
        </div>
      </Card>

      <Card className="wk-settings-card" title={WIKI_MAINTENANCE}>
        {settings.maintenance.enabled ? (
          <MaintenanceOn
            maintenance={settings.maintenance}
            server={server}
            busy={write.isPending}
            onEdit={() => setSetUp(true)}
            onTurnOff={() => void save({ maintenance: { enabled: false } })}
          />
        ) : (
          <>
            <div className="wk-maint-off">
              <div>
                <div className="wk-maint-t">{WIKI_MAINTENANCE_NAME}</div>
                <div className="wk-maint-d">{WIKI_MAINTENANCE_NOTE_SERVER}</div>
              </div>
              <span className="wk-maint-state">
                <span className="wk-dot proposed" aria-hidden="true" /> {WIKI_OFF}
              </span>
              <Button onClick={() => setSetUp(true)}>{WIKI_SET_UP}</Button>
            </div>
            {server && <WikiPrivacyNote />}
          </>
        )}
      </Card>

      {setUp && (
        <MaintenanceSetUp
          maintenance={settings.maintenance}
          server={server}
          spaceSlug={space.slug}
          onClose={() => setSetUp(false)}
          onSubmit={async (maintenance) => {
            await write.mutateAsync({ maintenance });
            toast.success(WIKI_SETTINGS_SAVED);
          }}
        />
      )}
    </div>
  );
}

/**
 * Maintenance once it is on: where it reads the repository from, the System model, and how often it may — then
 * Edit and Turn off, with the privacy note.
 */
function MaintenanceOn({
  maintenance,
  server,
  busy,
  onEdit,
  onTurnOff,
}: {
  maintenance: WikiMaintenanceSettings;
  server: WikiSystemModelStatus | null;
  busy: boolean;
  onEdit: () => void;
  onTurnOff: () => void;
}) {
  const workspaces = useQuery(workspacesQuery());
  const workspace = (workspaces.data ?? []).find((row) => row.id === maintenance.workspaceId);
  const where = workspace ? wikiWorkspaceLabel(workspace) : (maintenance.workspaceId ?? '—');
  return (
    <>
      <div className="wk-maint-rows">
        <span className="k">{WIKI_STATUS}</span>
        <span className="v">
          <span className="wk-dot on" aria-hidden="true" /> {WIKI_ON}
        </span>
        <span className="k">{WIKI_REPO_FROM}</span>
        <span className="v">{where}</span>
        {server && (
          <>
            <span className="k">{WIKI_MODEL}</span>
            <span className="v">
              <WikiModelLine model={server} />
            </span>
          </>
        )}
        <span className="k">{WIKI_DAILY_LIMIT}</span>
        <span className="v">{wikiRunsADay(maintenance.dailyRunLimit)}</span>
        <span className="k">{WIKI_LOOKBACK}</span>
        <span className="v">{wikiLookbackLabel(maintenance.lookbackDays)}</span>
      </div>
      {server && <WikiPrivacyNote />}
      <div className="wk-maint-foot">
        <Button onClick={onEdit} disabled={busy}>
          {WIKI_MAINTENANCE_EDIT}
        </Button>
        <Button variant="text" danger onClick={onTurnOff} disabled={busy}>
          {WIKI_TURN_OFF}
        </Button>
      </div>
    </>
  );
}

/**
 * Set up maintenance: the workspace it reads the repository from, the System model, how many runs a day it may
 * start and how far back it starts reading — then Turn on (or Save, for one already on).
 *
 * THERE IS NO PROVIDER TO PIN (mock 35 ②): the System model is shown, read-only, nothing writes `provider` —
 * whatever a space named before server execution stays as it was, and the server drops it from any write
 * (contract `space.settings.maintenance.keys.provider`) — and the form ends on where the wiki's material goes.
 */
function MaintenanceSetUp({
  maintenance,
  server,
  spaceSlug,
  onClose,
  onSubmit,
}: {
  maintenance: WikiMaintenanceSettings;
  server: WikiSystemModelStatus | null;
  spaceSlug: string;
  onClose: () => void;
  onSubmit: (maintenance: NonNullable<WikiSpaceUpdate['maintenance']>) => Promise<void>;
}) {
  const workspaces = useQuery(workspacesQuery());
  const rows = (workspaces.data ?? []) as Array<{ id: string; name?: string; runner?: { name?: string; displayName?: string } }>;
  // A space names a codebase, and so does a workspace's name more often than not: the one called
  // what the space is called is where its runs most likely belong, so it is the first offered.
  const [workspaceId, setWorkspaceId] = useState<string | null>(
    () => maintenance.workspaceId ?? rows.find((row) => row.name === spaceSlug)?.id ?? null,
  );
  const [limit, setLimit] = useState(maintenance.dailyRunLimit);
  const [lookback, setLookback] = useState(() => wikiLookbackChoice(maintenance.lookbackDays));
  const [days, setDays] = useState(() => wikiLookbackDaysOffered(maintenance.lookbackDays));
  const [saving, setSaving] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const chosen = workspaceId ?? rows.find((row) => row.name === spaceSlug)?.id ?? null;

  const submit = async () => {
    if (!chosen) return;
    setSaving(true);
    setRefusal(null);
    try {
      await onSubmit({
        enabled: true,
        workspaceId: chosen,
        dailyRunLimit: limit,
        lookbackDays: wikiLookbackDays(lookback, days),
      });
      onClose();
    } catch (error) {
      setSaving(false);
      setRefusal(error instanceof Error ? error.message : 'The server refused it');
    }
  };

  return (
    <Dialog
      open
      title={WIKI_SET_UP_TITLE}
      onClose={onClose}
      className="wk-setup-dialog"
      footer={
        <>
          <Button onClick={onClose}>{WIKI_CANCEL}</Button>
          <Button variant="primary" disabled={!chosen} loading={saving} onClick={() => void submit()}>
            {maintenance.enabled ? WIKI_SAVE : WIKI_TURN_ON}
          </Button>
        </>
      }
    >
      <p className="wk-modal-note">{WIKI_MAINTENANCE_NOTE_SERVER}</p>
      <div className="wk-setup">
        <label className="wk-setup-k" htmlFor="wk-setup-workspace">
          {WIKI_REPO_FROM}
        </label>
        <Select
          id="wk-setup-workspace"
          value={chosen}
          placeholder={WIKI_NO_WORKSPACE}
          onValueChange={(value) => setWorkspaceId(value)}
          options={rows.map((row) => ({ value: row.id, label: wikiWorkspaceLabel(row) }))}
          loading={workspaces.isLoading}
        />
        <div className="wk-setup-d">{WIKI_REPO_FROM_NOTE}</div>

        {server && (
          <>
            <span className="wk-setup-k">{WIKI_MODEL}</span>
            <div className="wk-setup-model">
              <WikiModelLine model={server} />
            </div>
            <div className="wk-setup-d">{WIKI_MODEL_NOTE}</div>
          </>
        )}

        <label className="wk-setup-k" htmlFor="wk-setup-limit">
          {WIKI_DAILY_LIMIT}
        </label>
        <div className="wk-setup-limit">
          <NumberInput
            id="wk-setup-limit"
            min={WIKI_MAINTENANCE_DAILY_RUN_LIMIT.min}
            max={WIKI_MAINTENANCE_DAILY_RUN_LIMIT.max}
            precision={0}
            value={limit}
            onValueChange={(value) => setLimit(typeof value === 'number' ? value : maintenance.dailyRunLimit)}
          />
          <span>{WIKI_RUNS_A_DAY}</span>
        </div>
        <div className="wk-setup-d">{WIKI_DAILY_LIMIT_NOTE}</div>

        <label className="wk-setup-k" htmlFor="wk-setup-lookback">
          {WIKI_LOOKBACK}
        </label>
        <Select<WikiLookbackChoice>
          id="wk-setup-lookback"
          value={lookback}
          onValueChange={(value) => {
            if (value !== null) setLookback(value);
          }}
          options={WIKI_LOOKBACK_CHOICES.map((choice) => ({ value: choice, label: wikiLookbackLabel(wikiLookbackDays(choice, days)) }))}
        />
        {lookback === 'days' && (
          <div className="wk-setup-limit wk-setup-days">
            <NumberInput
              aria-label={WIKI_LOOKBACK_UNIT}
              min={1}
              max={WIKI_MAINTENANCE_LOOKBACK_DAYS.max}
              precision={0}
              value={days}
              onValueChange={(value) => setDays(typeof value === 'number' ? value : days)}
            />
            <span>{WIKI_LOOKBACK_UNIT}</span>
          </div>
        )}
        <div className="wk-setup-d">{WIKI_LOOKBACK_NOTE}</div>
      </div>
      {server && <WikiPrivacyNote />}
      {refusal && (
        <div className="wk-warn wk-setup-refusal" role="alert">
          <ExclamationCircleOutlined className="ic" />
          <span>{refusal}</span>
        </div>
      )}
    </Dialog>
  );
}
