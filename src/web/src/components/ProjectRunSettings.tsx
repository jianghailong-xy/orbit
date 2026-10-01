import { useEffect, useState, type JSX } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Input, InputNumber, Radio, Select, Spin, Switch } from 'antd';
import type { IntegrationLine, ProjectIntegrationView, ProjectPauseState } from '@orbit/shared';
import { api } from '../api';
import {
  RUN_APPLIES_FROM_NEXT_TASK,
  RUN_AT_MOST,
  RUN_AUTOMATIC,
  RUN_EXECUTION,
  RUN_ESCALATE_AFTER,
  RUN_ESCALATE_HINT,
  RUN_INTEGRATION,
  RUN_LINE_MAIN,
  RUN_LINE_MAIN_HINT,
  RUN_LINE_PROJECT_BRANCH,
  RUN_LINE_PROJECT_BRANCH_HINT,
  RUN_MERGE_CHECK,
  RUN_MERGE_CHECK_HINT,
  RUN_MERGE_CHECK_PLACEHOLDER,
  RUN_NO_MERGE_CHECK_WARNING,
  RUN_NOT_PAUSED,
  RUN_NOT_RESUMED,
  RUN_NOT_SAVED,
  RUN_PAUSE,
  RUN_PAUSE_HINT,
  RUN_RESUME,
  RUN_SAVE,
  RUN_SWITCH_OFF,
  RUN_SWITCH_ON,
  RUN_TASKS_LAND_ON,
  START_HOW_IT_RUNS,
  runAutomaticHint,
  runLineLocked,
  runMergeCheckMissing,
  runPausedSince,
  runTasksAtATime,
  shortBranch,
} from '../lib/projectStart';
import { projectIntegrationQuery } from '../lib/queries';
import { ago } from '../lib/watches';
import { START_MAX_CONCURRENT_TASKS } from './StartProjectCard';

/**
 * "How it runs" — every setting the start card set, in one block on the project page once the
 * project is started (mock board3 ③④): where its tasks land, Automatic, how many run at once, the
 * merge check, how long an exception waits on the coordinator, and Pause project.
 *
 * ONE PLACE PER QUESTION. The line, the merge check and the escalation window used to sit behind
 * the integration row's "Integration settings" disclosure — which was not drawn at all until a line
 * had been decided, so a line could not be chosen before the default rule chose it — and Automatic
 * sat at the foot of the coordinator card. A question the start card asked is changed here
 * afterwards, and nowhere else.
 *
 * THE LINE IS THE ONE THING THAT LOCKS. Once anything has integrated, moving the line would orphan
 * what is already on it — the server refuses it 409 `INTEGRATION_LINE_LOCKED`, and so does a
 * database trigger (L4) — so the choice is drawn read-only with the reason written out. Until then
 * it can be chosen, a line nobody has decided included.
 *
 * WHAT A SAVE WRITES, AND WHERE. The line, the merge check and the escalation window are the
 * integration door's (`PATCH /projects/:id/integration`); Automatic and the concurrency limit are
 * the authorization set (`PATCH /projects/:id` with `automatic` — the project's
 * `coordinator_enabled` and nothing else — and `maxConcurrentTasks`), fenced against the
 * `configRevision` this block was drawn from. Only what was changed is sent. Pause project is not a
 * setting but a press: it stops the project moving at once (`POST /projects/:id/pause`), and
 * Resume project undoes it.
 */

/** Seconds, as the escalation window is offered. The column's CHECK bounds it 300 to a week (§4.1);
 *  these are the points on that range worth a click, and a value outside them is shown as itself
 *  rather than snapped to the nearest one. */
const ESCALATION_CHOICES: ReadonlyArray<{ seconds: number; label: string }> = [
  { seconds: 1800, label: '30 minutes' },
  { seconds: 3600, label: '1 hour' },
  { seconds: 7200, label: '2 hours' },
  { seconds: 14400, label: '4 hours' },
  { seconds: 28800, label: '8 hours' },
  { seconds: 86400, label: '24 hours' },
];

/** The window in words, including a window nobody offered. */
function escalationLabel(seconds: number): string {
  const known = ESCALATION_CHOICES.find((choice) => choice.seconds === seconds);
  if (known) return known.label;
  if (seconds % 3600 === 0) {
    const hours = seconds / 3600;
    return `${hours} hour${hours === 1 ? '' : 's'}`;
  }
  const minutes = Math.round(seconds / 60);
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

/**
 * What `PATCH /projects/:id/integration` accepts (§1.2 L5). Sent as one object so the server
 * validates the whole choice at once.
 */
interface IntegrationSettingsBody {
  line?: IntegrationLine;
  mergeCheckCommand?: string | null;
  exceptionEscalationSeconds?: number;
}

function updateProjectIntegration(
  projectId: string,
  settings: IntegrationSettingsBody,
): Promise<ProjectIntegrationView> {
  return api<ProjectIntegrationView>(
    `/projects/${encodeURIComponent(projectId)}/integration`,
    { method: 'PATCH', body: settings },
  );
}

/** Automatic and the concurrency limit, as the project's own PATCH takes them: `automatic` rather
 *  than the older `coordinatorEnabled`, which an older client's off also pauses the project with. */
interface AuthorizationBody {
  automatic?: boolean;
  maxConcurrentTasks?: number;
  expectedConfigRevision: string;
}

function updateProjectAuthorization(projectId: string, body: AuthorizationBody): Promise<unknown> {
  return api(`/projects/${encodeURIComponent(projectId)}`, { method: 'PATCH', body });
}

/** `POST /projects/:id/pause` or `/resume` — the owner's alone. */
function moveProject(projectId: string, door: 'pause' | 'resume'): Promise<ProjectPauseState> {
  return api<ProjectPauseState>(`/projects/${encodeURIComponent(projectId)}/${door}`, { method: 'POST' });
}

/** The project document's half of the block: Automatic, the limit, the revision a Save fences
 *  against, and whether it is paused. */
export interface RunSettingsProject {
  coordinatorEnabled: boolean;
  maxConcurrentTasks: number;
  configRevision: string;
  pausedAt?: string | null;
}

/** The block as the reader edits it: the number box can be empty mid-edit, the text box is text,
 *  and a line nobody has decided is no line until somebody picks one. */
interface RunSettingsDraft {
  line: IntegrationLine | null;
  automatic: boolean;
  maxConcurrentTasks: number | null;
  mergeCheckCommand: string;
  escalationSeconds: number;
}

/** What is stored, as a draft: where the edits are measured from. */
function storedDraft(view: ProjectIntegrationView, project: RunSettingsProject): RunSettingsDraft {
  return {
    line: view.line,
    automatic: project.coordinatorEnabled,
    maxConcurrentTasks: project.maxConcurrentTasks,
    mergeCheckCommand: view.mergeCheckCommand ?? '',
    escalationSeconds: view.escalationSeconds,
  };
}

/** The two writes a Save makes, each holding only what changed; null for a door with nothing to
 *  say. The line only while it can still move: sending the value a locked line already holds is
 *  refused 409 by the trigger. */
function runSettingsWrites(
  view: Pick<ProjectIntegrationView, 'line' | 'locked' | 'mergeCheckCommand' | 'escalationSeconds'>,
  project: RunSettingsProject,
  draft: RunSettingsDraft,
): { integration: IntegrationSettingsBody | null; authorization: AuthorizationBody | null } {
  const check = draft.mergeCheckCommand.trim() === '' ? null : draft.mergeCheckCommand;
  const integration: IntegrationSettingsBody = {
    ...(!view.locked && draft.line !== null && draft.line !== view.line ? { line: draft.line } : {}),
    ...(check !== (view.mergeCheckCommand ?? null) ? { mergeCheckCommand: check } : {}),
    ...(draft.escalationSeconds !== view.escalationSeconds
      ? { exceptionEscalationSeconds: draft.escalationSeconds }
      : {}),
  };
  const authorization = {
    ...(draft.automatic !== project.coordinatorEnabled ? { automatic: draft.automatic } : {}),
    ...(draft.maxConcurrentTasks !== null && draft.maxConcurrentTasks !== project.maxConcurrentTasks
      ? { maxConcurrentTasks: draft.maxConcurrentTasks }
      : {}),
  };
  return {
    integration: Object.keys(integration).length > 0 ? integration : null,
    authorization: Object.keys(authorization).length > 0
      ? { ...authorization, expectedConfigRevision: project.configRevision }
      : null,
  };
}

export function ProjectRunSettings({
  projectId,
  project,
}: {
  projectId: string;
  project: RunSettingsProject;
}): JSX.Element {
  const qc = useQueryClient();
  // The same read the integration row above makes, by the same key: one request for both.
  const integration = useQuery({ ...projectIntegrationQuery(projectId), enabled: Boolean(projectId) });
  const view = integration.data ?? null;

  // The reader's changes, over what is stored. A background refetch that lands mid-edit must not
  // fight the typing, but must not leave the reader editing settings from before somebody else
  // changed them either: the edits go when anything stored moves, and an unchanged payload
  // re-renders without touching them.
  const [edits, setEdits] = useState<Partial<RunSettingsDraft>>({});
  const storedKey = view ? JSON.stringify(storedDraft(view, project)) : null;
  useEffect(() => setEdits((current) => (Object.keys(current).length > 0 ? {} : current)), [storedKey]);

  const reread = () => qc.invalidateQueries({ queryKey: ['project', projectId] });
  const save = useMutation({
    mutationFn: async (writes: ReturnType<typeof runSettingsWrites>) => {
      // The line first: it is the one a Save can find locked since the block was drawn, and a
      // refusal there leaves the rest unwritten rather than half of the reader's choice.
      if (writes.integration) await updateProjectIntegration(projectId, writes.integration);
      if (writes.authorization) await updateProjectAuthorization(projectId, writes.authorization);
    },
    onSettled: () => reread(),
  });
  const move = useMutation({
    mutationFn: (door: 'pause' | 'resume') => moveProject(projectId, door),
    onSettled: () => reread(),
  });

  const paused = Boolean(project.pausedAt);
  const head = (
    <header className="project-open-items-head">
      <span className="project-open-items-title">{START_HOW_IT_RUNS}</span>
      <span className="project-open-items-hint">{RUN_APPLIES_FROM_NEXT_TASK}</span>
    </header>
  );

  if (!view) {
    return (
      <section className="project-open-items project-run-settings" aria-label={START_HOW_IT_RUNS}>
        {head}
        {integration.isError ? (
          <Alert
            type="error"
            showIcon
            message="How it runs could not be loaded"
            description={integration.error instanceof Error ? integration.error.message : undefined}
          />
        ) : (
          <div className="project-run-settings-loading">
            <Spin size="small" />
          </div>
        )}
      </section>
    );
  }

  const stored = storedDraft(view, project);
  const draft: RunSettingsDraft = { ...stored, ...edits };
  const set = (patch: Partial<RunSettingsDraft>) => setEdits((current) => ({ ...current, ...patch }));
  const writes = runSettingsWrites(view, project, draft);
  const dirty = writes.integration !== null || writes.authorization !== null;
  const complete = draft.maxConcurrentTasks !== null;
  const missingCheck = draft.line !== null && runMergeCheckMissing({ ...draft, line: draft.line });
  const branch = view.line === 'PROJECT_BRANCH' && view.ref ? view.ref : `project/${projectId}`;
  const now = Date.now();

  return (
    <section className="project-open-items project-run-settings" aria-label={START_HOW_IT_RUNS}>
      {head}

      <div className="project-run-settings-summary">
        <span className="project-run-settings-summary-dot" aria-hidden="true" />
        <div>
          <strong>{RUN_AUTOMATIC} {draft.automatic ? RUN_SWITCH_ON : RUN_SWITCH_OFF}</strong>
          <span>
            {draft.line === null
              ? ''
              : draft.line === 'MAIN'
                ? RUN_LINE_MAIN
                : `${RUN_LINE_PROJECT_BRANCH} · ${shortBranch(branch)}`}
            {draft.line !== null && draft.maxConcurrentTasks !== null
              ? ` · ${draft.maxConcurrentTasks} ${runTasksAtATime(draft.maxConcurrentTasks)}`
              : ''}
          </span>
        </div>
      </div>

      <div className="project-run-settings-grid">
        <div className="project-run-settings-group">
          <div className="project-run-settings-group-head">{RUN_EXECUTION}</div>

          <div className="project-integration-setting">
            <div className="project-integration-setting-label">{RUN_TASKS_LAND_ON}</div>
            <div>
              <Radio.Group
                className="project-run-lines"
                aria-label={RUN_TASKS_LAND_ON}
                value={draft.line}
                disabled={view.locked}
                onChange={(event) => set({ line: event.target.value })}
              >
                <Radio value="PROJECT_BRANCH">
                  <b>{RUN_LINE_PROJECT_BRANCH}</b> · <code className="start-card-branch" title={branch}>{shortBranch(branch)}</code>
                  {/* What each line means, while it can still be chosen. Once it is locked the choice
                      is history, and the sentence under the two says why it cannot move. */}
                  {view.locked ? null : (
                    <div className="project-integration-setting-hint">{RUN_LINE_PROJECT_BRANCH_HINT}</div>
                  )}
                </Radio>
                <Radio value="MAIN">
                  <b>{RUN_LINE_MAIN}</b>
                  {view.locked ? null : (
                    <div className="project-integration-setting-hint">{RUN_LINE_MAIN_HINT}</div>
                  )}
                </Radio>
              </Radio.Group>
              {view.locked ? (
                <div className="project-integration-setting-hint">
                  {runLineLocked(view.startedAt ? ago(view.startedAt, now) : null)}
                </div>
              ) : null}
            </div>
          </div>

          <div className="project-integration-setting">
            <div className="project-integration-setting-label">{RUN_AUTOMATIC}</div>
            <div>
              <div className="start-card-inline">
                <Switch
                  checked={draft.automatic}
                  aria-label={RUN_AUTOMATIC}
                  onChange={(automatic) => set({ automatic })}
                />
                <span>{draft.automatic ? RUN_SWITCH_ON : RUN_SWITCH_OFF}</span>
              </div>
              {/* The start card's sentence, for the line the project is on — or the one being chosen:
                  what Automatic does with a merge into main depends on it. */}
              <div className="project-integration-setting-hint">{runAutomaticHint(draft.line ?? 'PROJECT_BRANCH')}</div>
            </div>
          </div>

          <div className="project-integration-setting">
            <div className="project-integration-setting-label">{RUN_AT_MOST}</div>
            <div className="start-card-inline">
              <InputNumber
                className="start-card-count"
                min={1}
                max={START_MAX_CONCURRENT_TASKS}
                precision={0}
                value={draft.maxConcurrentTasks}
                aria-label={RUN_AT_MOST}
                onChange={(value) => set({ maxConcurrentTasks: typeof value === 'number' ? value : null })}
              />
              <span>{runTasksAtATime(draft.maxConcurrentTasks)}</span>
            </div>
          </div>
        </div>

        <div className="project-run-settings-group">
          <div className="project-run-settings-group-head">{RUN_INTEGRATION}</div>

          <div className={missingCheck ? 'project-integration-setting is-warn' : 'project-integration-setting'}>
            <div className="project-integration-setting-label">{RUN_MERGE_CHECK}</div>
            <div>
              <Input
                className="start-card-mono"
                value={draft.mergeCheckCommand}
                placeholder={RUN_MERGE_CHECK_PLACEHOLDER}
                aria-label={RUN_MERGE_CHECK}
                status={missingCheck ? 'warning' : undefined}
                onChange={(event) => set({ mergeCheckCommand: event.target.value })}
              />
              <div className="project-integration-setting-hint">{RUN_MERGE_CHECK_HINT}</div>
              {missingCheck ? <div className="start-card-warn">{RUN_NO_MERGE_CHECK_WARNING}</div> : null}
            </div>
          </div>

          <div className="project-integration-setting">
            <div className="project-integration-setting-label">{RUN_ESCALATE_AFTER}</div>
            <div>
              <Select
                value={draft.escalationSeconds}
                style={{ width: 140 }}
                aria-label={RUN_ESCALATE_AFTER}
                onChange={(escalationSeconds) => set({ escalationSeconds })}
                options={(ESCALATION_CHOICES.some((choice) => choice.seconds === draft.escalationSeconds)
                  ? ESCALATION_CHOICES
                  : [...ESCALATION_CHOICES, { seconds: draft.escalationSeconds, label: escalationLabel(draft.escalationSeconds) }]
                ).map((choice) => ({ value: choice.seconds, label: choice.label }))}
              />
              <div className="project-integration-setting-hint">{RUN_ESCALATE_HINT}</div>
            </div>
          </div>
        </div>
      </div>

      <div className="project-integration-setting-actions">
        <Button
          type="primary"
          size="small"
          disabled={!dirty || !complete}
          loading={save.isPending}
          onClick={() => save.mutate(writes)}
        >
          {RUN_SAVE}
        </Button>
        <Button
          size="small"
          className="project-run-pause"
          loading={move.isPending}
          onClick={() => move.mutate(paused ? 'resume' : 'pause')}
        >
          {paused ? RUN_RESUME : RUN_PAUSE}
        </Button>
      </div>
      <div className="project-integration-setting-hint project-run-pause-hint">
        {paused && project.pausedAt
          ? `${runPausedSince(ago(project.pausedAt, now))} ${RUN_PAUSE_HINT}`
          : RUN_PAUSE_HINT}
      </div>

      {/* A refused press, in the door's own words: a 409 STALE_CONFIG_REVISION is not a Retry —
          the settings moved under the reader, and the block has been read again to show where. */}
      {save.error ? (
        <Alert
          className="project-run-settings-error"
          type="error"
          showIcon
          message={RUN_NOT_SAVED}
          description={save.error.message}
        />
      ) : null}
      {move.error ? (
        <Alert
          className="project-run-settings-error"
          type="error"
          showIcon
          message={move.variables === 'resume' ? RUN_NOT_RESUMED : RUN_NOT_PAUSED}
          description={move.error.message}
        />
      ) : null}
    </section>
  );
}
