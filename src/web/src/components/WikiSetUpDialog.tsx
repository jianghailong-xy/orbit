import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ExclamationCircleOutlined } from '@ant-design/icons';
import {
  WIKI_MAINTENANCE_DAILY_RUN_LIMIT,
  WIKI_MAINTENANCE_LOOKBACK_DAYS,
  wikiMaintenanceSettings,
  wikiSpaceSettings,
  type WikiMaintenanceSettings,
  type WikiRepoProbeAnswer,
} from '@orbit/shared';
import { encodeId } from '../lib/idCodec';
import { runnersQuery, wikiSpacesQuery, wikiSpaceWorkspacesQuery, wikiSystemModelQuery, workspacesQuery } from '../lib/queries';
import { useToast } from '../lib/toast';
import { WIKI_SETTINGS_SAVED, wikiSpacePath, type WikiSpaceRow } from '../lib/wiki';
import {
  WIKI_CANCEL,
  WIKI_DAILY_LIMIT,
  WIKI_DAILY_LIMIT_NOTE,
  WIKI_LOOKBACK,
  WIKI_LOOKBACK_CHOICES,
  WIKI_LOOKBACK_NOTE,
  WIKI_LOOKBACK_UNIT,
  WIKI_MAINTENANCE_NOTE_SERVER,
  WIKI_MODEL,
  WIKI_MODEL_NOTE,
  WIKI_NO_WORKSPACE,
  WIKI_REPO_FROM,
  WIKI_REPO_FROM_NOTE,
  WIKI_RUNS_A_DAY,
  WIKI_SAVE,
  WIKI_SET_UP_TITLE,
  WIKI_TURN_ON,
  wikiLookbackChoice,
  wikiLookbackDays,
  wikiLookbackDaysOffered,
  wikiLookbackLabel,
  wikiWorkspaceLabel,
  type WikiLookbackChoice,
} from '../lib/wikiReviewMode';
import { readWikiFromWorkspace } from '../lib/wikiSpace';
import {
  WIKI_CREATE,
  WIKI_CREATE_NOTE,
  WIKI_WORKSPACE_OFFLINE,
  wikiCreateRepositoryNote,
  wikiRepositoryGroups,
  wikiRepositoryName,
  wikiRepositoryTitle,
  wikiWorkspaceChoicesInOrder,
  wikiWorkspaceDefault,
  type WikiWorkspaceChoice,
} from '../lib/wikiStart';
import { createWikiSpace, probeWikiMaintenance, updateWikiSpace, useWikiWrite, type WikiSpaceUpdate } from '../lib/wikiWrites';
import { WIKI_PROBE_CHECKING, WIKI_PROBE_FAILED } from '../lib/wikiRepoCard';
import { WikiModelLine, WikiPrivacyNote } from './WikiSystemModel';
import { Button } from './ui/Button';
import { Dialog } from './ui/Dialog';
import { NumberInput } from './ui/NumberInput';
import { Select, type SelectOptions } from './ui/Select';

/** Ids are compared in their public spelling: a space's settings keep a workspace's id as it was stored. */
const sameId = (a: string | null, b: string | null): boolean => a !== null && b !== null && encodeId(a) === encodeId(b);

/**
 * Every workspace as the two forms offer it: its name and runner, its repository, and whether that runner is
 * offline. `read` says the list is in: until it is, what it leaves out says nothing about the account.
 */
export function useWikiWorkspaceChoices(): { choices: WikiWorkspaceChoice[]; loading: boolean; read: boolean } {
  const workspaces = useQuery(workspacesQuery());
  const runners = useQuery(runnersQuery());
  const choices = useMemo(() => {
    const rows = (workspaces.data ?? []) as Array<{
      id: string;
      name?: string;
      repoUrl?: string | null;
      runner?: { id?: string; name?: string; displayName?: string } | null;
    }>;
    const machines = (runners.data ?? []) as Array<{ id: string; online?: boolean }>;
    return rows.map((row) => {
      const runner = row.runner?.id ? machines.find((machine) => sameId(machine.id, row.runner!.id!)) : undefined;
      return {
        id: row.id,
        label: wikiWorkspaceLabel(row),
        repository: wikiRepositoryName(row.repoUrl),
        repoUrl: row.repoUrl ?? null,
        online: runner ? runner.online === true : true,
      };
    });
  }, [workspaces.data, runners.data]);
  return { choices, loading: workspaces.isLoading, read: workspaces.isSuccess };
}

/**
 * Set up maintenance: the workspace it reads the repository from, the System model, how many runs a day it may
 * start and how far back it starts reading. The home's first step opens it where the reader is, and Wiki settings
 * open it from the Maintenance card.
 *
 * THE WORKSPACES ARE THIS WIKI'S (mock 41): a wiki describes one repository, so only its own are offered, the one
 * the reader came from picked for them when its runner is up — the workspaces of another repository could only
 * read the wrong code. A wiki with no workspace in it yet offers them all.
 */
export function WikiSetUpDialog({ space, onClose }: { space: WikiSpaceRow; onClose: () => void }) {
  const toast = useToast();
  const { maintenance } = wikiSpaceSettings(space.settings);
  const { choices, loading } = useWikiWorkspaceChoices();
  const members = useQuery(wikiSpaceWorkspacesQuery(space.id));
  const write = useWikiWrite((body: WikiSpaceUpdate) => updateWikiSpace(space.id, body));
  const [picked, setPicked] = useState<string | null>(null);

  const inWiki = (members.data?.workspaces ?? []).filter((row) => row.inWiki);
  const offered = wikiWorkspaceChoicesInOrder(
    inWiki.length === 0 ? choices : choices.filter((choice) => sameId(choice.id, maintenance.workspaceId) || inWiki.some((row) => sameId(row.id, choice.id))),
  );
  const current = choices.find((choice) => sameId(choice.id, maintenance.workspaceId))?.id ?? maintenance.workspaceId;
  const chosen = picked ?? wikiWorkspaceDefault(offered, { current, from: fromWorkspace(offered) });
  // The workspace's folder, asked of its runner as it is chosen (docs/wiki-repo-tiers-design.md §7.3): never retried — an
  // answer that does not come is said, and Turn on stays open.
  const probe = useQuery({
    queryKey: ['wiki', 'space', space.id, 'probe', chosen] as const,
    queryFn: () => probeWikiMaintenance(space.id, chosen!),
    enabled: chosen !== null,
    retry: false,
    staleTime: 0,
    gcTime: 0,
  });

  return (
    <MaintenanceForm
      title={WIKI_SET_UP_TITLE}
      note={WIKI_MAINTENANCE_NOTE_SERVER}
      submit={maintenance.enabled ? WIKI_SAVE : WIKI_TURN_ON}
      maintenance={maintenance}
      options={offered.map(optionOf)}
      offline={offered}
      workspaceId={chosen}
      onWorkspace={setPicked}
      workspaceNote={WIKI_REPO_FROM_NOTE}
      probe={chosen === null ? null : { answer: probe.data ?? null, checking: probe.isFetching && !probe.data, failed: probe.isError }}
      loading={loading}
      onClose={onClose}
      onSubmit={async (next) => {
        await write.mutateAsync({ maintenance: next });
        toast.success(WIKI_SETTINGS_SAVED);
      }}
    />
  );
}

/**
 * The form that makes a wiki (mock 41): the same one, its workspaces under their repositories. Choosing the
 * workspace chooses the repository, so there is no second field; a workspace on no repository has nothing to
 * describe and is not offered. The server makes the space, turns maintenance on and asks for the plan's first
 * draft in the one request (`POST /wiki/spaces`), which is what the home then shows.
 */
export function WikiCreateDialog({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const client = useQueryClient();
  const { choices, loading } = useWikiWorkspaceChoices();
  const write = useWikiWrite(createWikiSpace);
  const [picked, setPicked] = useState<string | null>(null);

  const groups = wikiRepositoryGroups(choices);
  const offered = groups.flatMap((group) => group.choices);
  const chosen = picked ?? wikiWorkspaceDefault(offered, { current: null, from: fromWorkspace(offered) });
  const choice = offered.find((row) => row.id === chosen) ?? null;

  return (
    <MaintenanceForm
      title={WIKI_CREATE}
      note={WIKI_CREATE_NOTE}
      submit={WIKI_CREATE}
      maintenance={wikiMaintenanceSettings(undefined)}
      options={groups.map((group) => ({ label: group.repository, options: group.choices.map(optionOf) }))}
      offline={offered}
      workspaceId={chosen}
      onWorkspace={setPicked}
      workspaceNote={choice?.repository ? wikiCreateRepositoryNote(choice.repository) : WIKI_REPO_FROM_NOTE}
      loading={loading}
      onClose={onClose}
      onSubmit={async (maintenance) => {
        const space = await write.mutateAsync({
          title: wikiRepositoryTitle(choice!.repository!),
          repoUrl: choice!.repoUrl!,
          maintenance,
        });
        // `/wiki/:space` finds its space in this list: read it before going there, or it says there is no such wiki.
        await client.refetchQueries({ queryKey: wikiSpacesQuery().queryKey });
        navigate(wikiSpacePath(space.slug));
      }}
    />
  );
}

const optionOf = (choice: WikiWorkspaceChoice) => ({ value: choice.id, label: choice.label });

/** The workspace this tab came from, as the forms spell it, when it is one they offer. */
function fromWorkspace(offered: readonly WikiWorkspaceChoice[]): string | null {
  const from = readWikiFromWorkspace();
  return offered.find((choice) => sameId(choice.id, from))?.id ?? null;
}

/**
 * The fields both forms share, then Turn on, Save or Create wiki.
 *
 * THERE IS NO PROVIDER TO PIN (mock 35 ②): the System model is shown, read-only, nothing writes `provider` —
 * whatever a space named before server execution stays as it was, and the server drops it from any write
 * (contract `space.settings.maintenance.keys.provider`) — and the form ends on where the wiki's material goes.
 */
function MaintenanceForm({
  title,
  note,
  submit: submitLabel,
  maintenance,
  options,
  offline,
  workspaceId,
  onWorkspace,
  workspaceNote,
  probe = null,
  loading,
  onClose,
  onSubmit,
}: {
  title: string;
  note: string;
  submit: string;
  maintenance: WikiMaintenanceSettings;
  options: SelectOptions;
  /** The choices on offer, which say which runners are offline. */
  offline: readonly WikiWorkspaceChoice[];
  workspaceId: string | null;
  onWorkspace: (workspaceId: string) => void;
  workspaceNote: string;
  /** What the chosen workspace's folder would be read as (the settings' probe); null where nothing is asked. */
  probe?: { answer: WikiRepoProbeAnswer | null; checking: boolean; failed: boolean } | null;
  loading: boolean;
  onClose: () => void;
  onSubmit: (maintenance: NonNullable<WikiSpaceUpdate['maintenance']> & { enabled: true; workspaceId: string }) => Promise<void>;
}) {
  const systemModel = useQuery(wikiSystemModelQuery());
  const server = systemModel.data?.executor?.serverExecutes ? systemModel.data : null;
  const [limit, setLimit] = useState(maintenance.dailyRunLimit);
  const [lookback, setLookback] = useState(() => wikiLookbackChoice(maintenance.lookbackDays));
  const [days, setDays] = useState(() => wikiLookbackDaysOffered(maintenance.lookbackDays));
  const [saving, setSaving] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

  const submit = async () => {
    if (!workspaceId) return;
    setSaving(true);
    setRefusal(null);
    try {
      await onSubmit({
        enabled: true,
        workspaceId,
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
      title={title}
      onClose={onClose}
      className="wk-setup-dialog"
      footer={
        <>
          <Button onClick={onClose}>{WIKI_CANCEL}</Button>
          <Button variant="primary" disabled={!workspaceId || probe?.answer?.canTurnOn === false} loading={saving} onClick={() => void submit()}>
            {submitLabel}
          </Button>
        </>
      }
    >
      <p className="wk-modal-note">{note}</p>
      <div className="wk-setup">
        <label className="wk-setup-k" htmlFor="wk-setup-workspace">
          {WIKI_REPO_FROM}
        </label>
        <Select
          id="wk-setup-workspace"
          value={workspaceId}
          placeholder={WIKI_NO_WORKSPACE}
          onValueChange={(value) => {
            if (value !== null) onWorkspace(value);
          }}
          options={options}
          loading={loading}
          renderOption={(option) => (
            <span className="wk-setup-option">
              <span>{option.label}</span>
              {offline.some((choice) => choice.id === option.value && !choice.online) && <span className="off">{WIKI_WORKSPACE_OFFLINE}</span>}
            </span>
          )}
        />
        {probe && <WikiProbeAnswer {...probe} />}
        <div className="wk-setup-d">{workspaceNote}</div>

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

const PROBE_GLYPH: Record<WikiRepoProbeAnswer['tone'], string> = { ok: '✓', folder: '▣', paused: '!', wrong: '!', unchecked: '?' };

/**
 * The probe's answer under the workspace picker (mock 44 ⑤): green for git, purple for a folder, amber for a folder that
 * is not there, red for another repository's — Turn on is off then — and grey when the runner could not be asked.
 */
function WikiProbeAnswer({ answer, checking, failed }: { answer: WikiRepoProbeAnswer | null; checking: boolean; failed: boolean }) {
  if (!answer) {
    if (!checking && !failed) return null;
    return (
      <div className="wk-probe unchecked" role="status">
        <span className="g" aria-hidden="true">{checking ? '…' : '?'}</span>
        <span>{checking ? WIKI_PROBE_CHECKING : WIKI_PROBE_FAILED}</span>
      </div>
    );
  }
  return (
    <div className={`wk-probe ${answer.tone}`} role="status">
      <span className="g" aria-hidden="true">{PROBE_GLYPH[answer.tone]}</span>
      <span>
        <b>{answer.title}</b>
        {answer.note && (
          <>
            <br />
            {answer.note}
          </>
        )}
      </span>
    </div>
  );
}
