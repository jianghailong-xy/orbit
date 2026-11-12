import { useEffect, useState, type JSX } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { DeliveryMode, IntegrationLine, ProjectIntegrationView, ProjectPauseState, PromotionState } from '@orbit/shared';
import { api } from '../api';
import {
  DEFAULT_MAIN_BRANCH,
  RUN_AGENT_PUSH_CANCEL,
  RUN_AGENT_PUSH_CONFIRM,
  RUN_APPLIES_FROM_NEXT_TASK,
  RUN_AT_MOST,
  RUN_AUTOMATIC,
  RUN_DELIVERY,
  RUN_DELIVERY_AGENT_PUSH,
  RUN_DELIVERY_ANCHOR,
  RUN_DELIVERY_PLATFORM,
  RUN_EXECUTION,
  RUN_ESCALATE_AFTER,
  RUN_ESCALATE_HINT,
  RUN_INTEGRATION,
  RUN_LINE_PROJECT_BRANCH,
  RUN_LINE_PROJECT_BRANCH_HINT,
  RUN_MAIN_BRANCH,
  RUN_MAIN_BRANCH_HINT,
  RUN_MERGE_CHECK,
  RUN_MERGE_CHECK_PLACEHOLDER,
  RUN_NOT_PAUSED,
  RUN_NOT_RESUMED,
  RUN_NOT_SAVED,
  RUN_PAUSE,
  RUN_RESUME,
  RUN_SAVE,
  RUN_SWITCH_OFF,
  RUN_SWITCH_ON,
  RUN_TASKS_LAND_ON,
  START_HOW_IT_RUNS,
  mainBranchName,
  mainBranchRef,
  runAgentPushConfirmBody,
  runAgentPushConfirmTitle,
  runAutomaticHint,
  runAutomaticHintAgentPush,
  runAutomaticHintMainNoDelivery,
  runDeliveryAgentPushHint,
  runDeliveryNeedsMainLine,
  runDeliveryPlatformHint,
  runLineLocked,
  runLineMain,
  runLineMainHint,
  runLineMainHintAgentPush,
  runMainBranchLocked,
  runMainBranchRemembers,
  runMergeCheckHint,
  runMergeCheckHintAgentPush,
  runMergeCheckMissing,
  runNoMergeCheckWarning,
  runPauseHint,
  runPausedSince,
  revealRunDelivery,
  runTasksAtATime,
  shortBranch,
} from '../lib/projectStart';
import {
  NON_CODE_ANCHOR,
  NON_CODE_BADGE,
  RUN_DELIVERS,
  RUN_DELIVERS_CODE,
  RUN_DELIVERS_CODE_HINT,
  RUN_DELIVERS_NOT_CODE,
  RUN_DELIVERS_NOT_CODE_HINT,
  RUN_LANDING,
  RUN_LANDING_OFF_HINT,
  RUN_TO_CODE,
  RUN_TO_NOT_CODE,
  formatDoneDateTime,
  nonCodeProvenance,
  nonCodeReasonLine,
} from '../lib/projectDone';
import { projectIntegrationQuery, projectPromotionQuery } from '../lib/queries';
import { ago } from '../lib/watches';
import { MainBranchSelect } from './MainBranchSelect';
import { START_MAX_CONCURRENT_TASKS } from './StartProjectCard';
import { Alert } from './ui/Alert';
import { Button } from './ui/Button';
import { useConfirm } from './ui/ConfirmDialog';
import { Input } from './ui/Input';
import { NumberInput } from './ui/NumberInput';
import { Radio, RadioGroup } from './ui/Radio';
import { Select } from './ui/Select';
import { Spinner } from './ui/Spinner';
import { Switch } from './ui/Switch';

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
 * HOW THE WORK REACHES MAIN DOES NOT LOCK (§10.5 O-L1). Orbit lands it, or the agent pushes it there
 * itself — which only a main line takes: on a project branch, or a line nobody decided, the agent's
 * way is drawn but not offered, with the reason (the door's 409 `DELIVERY_MODE_NEEDS_MAIN_LINE`), and a
 * line moved off main takes the delivery back to Orbit's in the same write.
 *
 * WHAT A SAVE WRITES, AND WHERE. The line, the merge check, the delivery mode and the escalation
 * window are the integration door's (`PATCH /projects/:id/integration`); Automatic and the
 * concurrency limit are the authorization set (`PATCH /projects/:id` with `automatic` — the project's
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

/** A merge into main the owner may still be asked, or has answered and is under way: what switching
 *  to the agent's way leaves standing, and so the one case the switch asks first. */
const LIVE_PROMOTION_STATES: readonly PromotionState[] = ['CHECKING', 'READY', 'CONFIRMED', 'RECHECKING'];

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
  /** The main branch as a full ref; sent only while the line can still move (L4 locks both). */
  upstreamRef?: string;
  mergeCheckCommand?: string | null;
  exceptionEscalationSeconds?: number;
  /** How the work reaches main (§10.5 O-L1); AGENT_PUSH only with a main line. */
  deliveryMode?: DeliveryMode;
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
  /** The explicit non-code mark and who set it, when (migration 0535). Absent from an older server. */
  nonCode?: boolean;
  nonCodeSetBy?: 'OWNER' | 'COORDINATOR' | null;
  nonCodeSetAt?: string | null;
  /** The short reason given with the mark (0555). */
  nonCodeReason?: string | null;
}

/** The block as the reader edits it: the number box can be empty mid-edit, the text box is text,
 *  and a line nobody has decided is no line until somebody picks one. */
interface RunSettingsDraft {
  line: IntegrationLine | null;
  /** The main branch by name; null for a project with no repository, which has none to choose. */
  upstream: string | null;
  automatic: boolean;
  maxConcurrentTasks: number | null;
  mergeCheckCommand: string;
  escalationSeconds: number;
  /** How the work reaches main, as last chosen in this block; it counts only on a main line. */
  deliveryMode: DeliveryMode;
  /** Delivers: Code (false) or Not code (true). */
  nonCode: boolean;
}

/** The main branch the project stands on, by name — before it is bound to its repository, the one
 *  binding gives it: the owner's last choice there, else main (L6) — and null for a project with no
 *  repository. */
function storedUpstream(
  view: Pick<ProjectIntegrationView, 'repository' | 'upstreamRef' | 'lastMainBranch'>,
): string | null {
  return view.repository ? mainBranchName(view.upstreamRef ?? view.lastMainBranch?.branch) : null;
}

/** What is stored, as a draft: where the edits are measured from. */
function storedDraft(view: ProjectIntegrationView, project: RunSettingsProject): RunSettingsDraft {
  return {
    line: view.line,
    upstream: storedUpstream(view),
    automatic: project.coordinatorEnabled,
    maxConcurrentTasks: project.maxConcurrentTasks,
    mergeCheckCommand: view.mergeCheckCommand ?? '',
    escalationSeconds: view.escalationSeconds,
    deliveryMode: view.deliveryMode ?? 'PLATFORM',
    nonCode: project.nonCode === true,
  };
}

/** The delivery a draft stands for: the agent pushes only on a main line (O-L1), so on any other —
 *  a project branch, or none decided — it is Orbit's, whatever was chosen while the line was main. */
function draftDelivery(draft: Pick<RunSettingsDraft, 'line' | 'deliveryMode'>): DeliveryMode {
  return draft.line === 'MAIN' ? draft.deliveryMode : 'PLATFORM';
}

/** The two writes a Save makes, each holding only what changed; null for a door with nothing to
 *  say. The line and the main branch only while they can still move: sending the value a locked
 *  line already holds is refused 409 by the trigger. A main branch saved here is the owner's choice,
 *  and the one their next project in the repository starts with. */
function runSettingsWrites(
  view: Pick<
    ProjectIntegrationView,
    'line' | 'repository' | 'upstreamRef' | 'lastMainBranch' | 'locked' | 'mergeCheckCommand' | 'escalationSeconds'
    | 'deliveryMode'
  >,
  project: RunSettingsProject,
  draft: RunSettingsDraft,
): { integration: IntegrationSettingsBody | null; authorization: AuthorizationBody | null; nonCode: boolean | null } {
  const check = draft.mergeCheckCommand.trim() === '' ? null : draft.mergeCheckCommand;
  const integration: IntegrationSettingsBody = {
    ...(!view.locked && draft.line !== null && draft.line !== view.line ? { line: draft.line } : {}),
    ...(!view.locked && draft.upstream !== null && draft.upstream !== storedUpstream(view)
      ? { upstreamRef: mainBranchRef(draft.upstream) }
      : {}),
    ...(check !== (view.mergeCheckCommand ?? null) ? { mergeCheckCommand: check } : {}),
    ...(draft.escalationSeconds !== view.escalationSeconds
      ? { exceptionEscalationSeconds: draft.escalationSeconds }
      : {}),
    // Only to a server that reads it, and only when it moves — in the same write as the line that
    // moves it, which is what the door asks of a line leaving main.
    ...(view.deliveryMode !== undefined && draftDelivery(draft) !== view.deliveryMode
      ? { deliveryMode: draftDelivery(draft) }
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
    // The mark, written by the owner's PATCH and only when it moves. A project marked non-code keeps
    // its line settings untouched, so switching back to Code brings them back as they were.
    nonCode: draft.nonCode !== (project.nonCode === true) ? draft.nonCode : null,
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
  // The merge on offer, read only where the Delivery row is drawn: switching to the agent's way while
  // one is live asks first (owner decision 2026-11-10). Same key as the card's own read.
  const promotion = useQuery({
    ...projectPromotionQuery(projectId),
    enabled: Boolean(projectId) && view?.deliveryMode !== undefined,
  });
  const [confirm, confirmation] = useConfirm();

  // The reader's changes, over what is stored. A background refetch that lands mid-edit must not
  // fight the typing, but must not leave the reader editing settings from before somebody else
  // changed them either: the edits go when anything stored moves, and an unchanged payload
  // re-renders without touching them.
  const [edits, setEdits] = useState<Partial<RunSettingsDraft>>({});
  const storedKey = view ? JSON.stringify(storedDraft(view, project)) : null;
  useEffect(() => setEdits((current) => (Object.keys(current).length > 0 ? {} : current)), [storedKey]);
  // Arrived from the merge card's "Let the agent push instead…" on another page: once the block is
  // drawn, the Delivery row is brought into view.
  const drawn = view !== null;
  useEffect(() => {
    if (drawn && window.location.hash === `#${RUN_DELIVERY_ANCHOR}`) revealRunDelivery();
    // Arrived from the done card's Change: the Delivers row is brought into view.
    if (drawn && window.location.hash === `#${NON_CODE_ANCHOR}`) {
      document.getElementById(NON_CODE_ANCHOR)?.scrollIntoView?.({ block: 'center' });
    }
  }, [drawn]);

  const reread = () => qc.invalidateQueries({ queryKey: ['project', projectId] });
  const save = useMutation({
    mutationFn: async (writes: ReturnType<typeof runSettingsWrites>) => {
      // The line first: it is the one a Save can find locked since the block was drawn, and a
      // refusal there leaves the rest unwritten rather than half of the reader's choice.
      if (writes.integration) await updateProjectIntegration(projectId, writes.integration);
      if (writes.authorization) await updateProjectAuthorization(projectId, writes.authorization);
      if (writes.nonCode !== null) {
        await api(`/projects/${encodeURIComponent(projectId)}`, { method: 'PATCH', body: { nonCode: writes.nonCode } });
      }
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
            title="How it runs could not be loaded"
            description={integration.error instanceof Error ? integration.error.message : undefined}
          />
        ) : (
          <div className="project-run-settings-loading">
            <Spinner size="small" aria-busy="true" />
          </div>
        )}
      </section>
    );
  }

  const stored = storedDraft(view, project);
  const draft: RunSettingsDraft = { ...stored, ...edits };
  const set = (patch: Partial<RunSettingsDraft>) => setEdits((current) => ({ ...current, ...patch }));
  const writes = runSettingsWrites(view, project, draft);
  const dirty = writes.integration !== null || writes.authorization !== null || writes.nonCode !== null;
  const provenance = nonCodeProvenance(project, formatDoneDateTime);
  const reason = nonCodeReasonLine(project);
  const complete = draft.maxConcurrentTasks !== null;
  const missingCheck = draft.line !== null && runMergeCheckMissing({ ...draft, line: draft.line });
  const branch = view.line === 'PROJECT_BRANCH' && view.ref ? view.ref : `project/${projectId}`;
  const now = Date.now();
  // The branch the sentences about where work goes name: the one being chosen, or main for a project
  // with no repository. Pausing is about the project as it stands, so its sentence names that one.
  const main = draft.upstream ?? DEFAULT_MAIN_BRANCH;
  const repository = view.repository || null;
  const delivery = draftDelivery(draft);
  // Moving a project Orbit lands for to the agent's way, while a merge into main is live, asks first:
  // the waiting card stays, and the reader is told so. Cancel leaves the choice where it was.
  const chooseDelivery = async (deliveryMode: DeliveryMode) => {
    const live = promotion.data != null && LIVE_PROMOTION_STATES.includes(promotion.data.state);
    if (deliveryMode === 'AGENT_PUSH' && view.deliveryMode === 'PLATFORM' && live) {
      const confirmed = await confirm({
        title: runAgentPushConfirmTitle(main),
        description: runAgentPushConfirmBody(main),
        confirmText: RUN_AGENT_PUSH_CONFIRM,
        cancelText: RUN_AGENT_PUSH_CANCEL,
        onConfirm: () => undefined,
      });
      if (!confirmed) return;
    }
    set({ deliveryMode });
  };

  return (
    <section className="project-open-items project-run-settings" aria-label={START_HOW_IT_RUNS}>
      {head}

      <div className="project-run-settings-summary">
        <span className="project-run-settings-summary-dot" aria-hidden="true" />
        <div>
          <strong>{RUN_AUTOMATIC} {draft.automatic ? RUN_SWITCH_ON : RUN_SWITCH_OFF}</strong>
          <span>
            {draft.nonCode
              ? NON_CODE_BADGE
              : draft.line === null
              ? ''
              : draft.line === 'MAIN'
                ? runLineMain(main)
                : `${RUN_LINE_PROJECT_BRANCH} · ${shortBranch(branch)}`}
            {(draft.nonCode || draft.line !== null) && draft.maxConcurrentTasks !== null
              ? ` · ${draft.maxConcurrentTasks} ${runTasksAtATime(draft.maxConcurrentTasks)}`
              : ''}
          </span>
        </div>
      </div>

      <div className="project-run-settings-grid">
        <div className="project-run-settings-group">
          <div className="project-run-settings-group-head">{RUN_EXECUTION}</div>

          {/* What the project delivers (board 01 A–C), first because it decides whether the landing
              settings under it mean anything. The choice is its own Change; its provenance says who
              set it and when. */}
          <div className="project-integration-setting" id={NON_CODE_ANCHOR} tabIndex={-1}>
            <div className="project-integration-setting-label">{RUN_DELIVERS}</div>
            <div>
              <RadioGroup<'CODE' | 'NOT_CODE'>
                className="project-run-lines project-run-delivers"
                aria-label={RUN_DELIVERS}
                value={draft.nonCode ? 'NOT_CODE' : 'CODE'}
                onValueChange={(value) => set({ nonCode: value === 'NOT_CODE' })}
              >
                <Radio value="CODE">
                  <b>{RUN_DELIVERS_CODE}</b>
                  <div className="project-integration-setting-hint">{RUN_DELIVERS_CODE_HINT.replace('{main}', main)}</div>
                </Radio>
                <Radio value="NOT_CODE">
                  <b>{RUN_DELIVERS_NOT_CODE}</b>
                  <div className="project-integration-setting-hint">{RUN_DELIVERS_NOT_CODE_HINT}</div>
                </Radio>
              </RadioGroup>
              {provenance && draft.nonCode ? (
                <div className="project-integration-setting-hint project-run-non-code-by">
                  {provenance}
                  {reason && project.nonCode ? <div className="project-run-non-code-reason">{reason}</div> : null}
                </div>
              ) : null}
            </div>
          </div>

          {draft.nonCode ? null : (<>
          <div className="project-integration-setting">
            <div className="project-integration-setting-label">{RUN_TASKS_LAND_ON}</div>
            <div>
              {/* An empty value checks neither line: the project has not decided one. */}
              <RadioGroup<IntegrationLine | ''>
                className="project-run-lines"
                aria-label={RUN_TASKS_LAND_ON}
                value={draft.line ?? ''}
                disabled={view.locked}
                onValueChange={(line) => set({ line: line || null })}
              >
                <Radio value="PROJECT_BRANCH">
                  <b>{RUN_LINE_PROJECT_BRANCH}</b> · <code className="start-card-branch" title={branch}>{shortBranch(branch)}</code>
                  {/* What each line means, while it can still be chosen. Once it is locked the choice
                      is history, and the sentence under the two — or under Main branch, on a project
                      that shows one — says why it cannot move. */}
                  {view.locked ? null : (
                    <div className="project-integration-setting-hint">{RUN_LINE_PROJECT_BRANCH_HINT}</div>
                  )}
                </Radio>
                <Radio value="MAIN">
                  <b>{runLineMain(main)}</b>
                  {/* While the agent pushes, no merge into main asks anybody (O-L2): its own words. */}
                  {view.locked ? null : delivery === 'AGENT_PUSH' ? (
                    <div className="project-integration-setting-hint">{runLineMainHintAgentPush(main)}</div>
                  ) : (
                    <div className="project-integration-setting-hint">{runLineMainHint(main)}</div>
                  )}
                </Radio>
              </RadioGroup>
              {view.locked && repository === null ? (
                <div className="project-integration-setting-hint">
                  {runLineLocked(view.startedAt ? ago(view.startedAt, now) : null)}
                </div>
              ) : null}
            </div>
          </div>

          {/* How the work reaches main (§10.5 O-L1): a choice only a main line has, and one that does not
              lock. A server that predates it reports no mode, and draws no row. */}
          {view.deliveryMode !== undefined ? (
            <div className="project-integration-setting" id={RUN_DELIVERY_ANCHOR} tabIndex={-1}>
              <div className="project-integration-setting-label">{RUN_DELIVERY}</div>
              <div>
                <RadioGroup<DeliveryMode>
                  className="project-run-lines project-run-delivery"
                  aria-label={RUN_DELIVERY}
                  value={delivery}
                  onValueChange={(deliveryMode) => void chooseDelivery(deliveryMode)}
                >
                  <Radio value="PLATFORM">
                    <b>{RUN_DELIVERY_PLATFORM}</b>
                    <div className="project-integration-setting-hint">{runDeliveryPlatformHint(main)}</div>
                  </Radio>
                  <Radio value="AGENT_PUSH" disabled={draft.line !== 'MAIN'}>
                    <b>{RUN_DELIVERY_AGENT_PUSH}</b>
                    <div className="project-integration-setting-hint">
                      {draft.line === 'MAIN' ? runDeliveryAgentPushHint(main) : runDeliveryNeedsMainLine(main)}
                    </div>
                  </Radio>
                </RadioGroup>
              </div>
            </div>
          ) : null}

          {/* Which branch "main" is for this project: where its tasks start and its work ends up. It
              locks with the line — both are what landed work stands on — so once they lock, the
              sentence saying why sits under the second of the two. A project with no repository has
              no branch to name, and no row. */}
          {repository !== null && draft.upstream !== null ? (
            <div className="project-integration-setting">
              <div className="project-integration-setting-label">{RUN_MAIN_BRANCH}</div>
              <div>
                <MainBranchSelect
                  value={draft.upstream}
                  branches={view.branches ?? null}
                  remembered={view.lastMainBranch?.branch ?? null}
                  disabled={view.locked}
                  onChange={(upstream) => set({ upstream })}
                />
                <div className="project-integration-setting-hint">
                  {view.locked
                    ? runMainBranchLocked(view.startedAt ? ago(view.startedAt, now) : null, main)
                    : `${RUN_MAIN_BRANCH_HINT} ${runMainBranchRemembers(repository)}`}
                </div>
              </div>
            </div>
          ) : null}

          </>)}

          <div className="project-integration-setting">
            <div className="project-integration-setting-label">{RUN_AUTOMATIC}</div>
            <div>
              <div className="start-card-inline">
                <Switch
                  checked={draft.automatic}
                  aria-label={RUN_AUTOMATIC}
                  onCheckedChange={(automatic) => set({ automatic })}
                />
                <span>{draft.automatic ? RUN_SWITCH_ON : RUN_SWITCH_OFF}</span>
              </div>
              {/* The start card's sentence, for the line the project is on — or the one being chosen:
                  what Automatic does with a merge into main depends on it, and on who delivers the work. */}
              {delivery === 'AGENT_PUSH' ? (
                <div className="project-integration-setting-hint">{runAutomaticHintAgentPush(main)}</div>
              ) : view.deliveryMode === undefined && draft.line === 'MAIN' ? (
                // A server with no Delivery row: there is nowhere to point the reader, so the older
                // sentence stands.
                <div className="project-integration-setting-hint">{runAutomaticHintMainNoDelivery(main)}</div>
              ) : (
                <div className="project-integration-setting-hint">{runAutomaticHint(draft.line ?? 'PROJECT_BRANCH', main)}</div>
              )}
            </div>
          </div>

          <div className="project-integration-setting">
            <div className="project-integration-setting-label">{RUN_AT_MOST}</div>
            <div className="start-card-inline">
              <NumberInput
                className="start-card-count"
                min={1}
                max={START_MAX_CONCURRENT_TASKS}
                precision={0}
                value={draft.maxConcurrentTasks}
                aria-label={RUN_AT_MOST}
                onValueChange={(value) => set({ maxConcurrentTasks: value })}
              />
              <span>{runTasksAtATime(draft.maxConcurrentTasks)}</span>
            </div>
          </div>
        </div>

        <div className="project-run-settings-group">
          <div className="project-run-settings-group-head">{RUN_INTEGRATION}</div>

          {draft.nonCode ? (
            <div className="project-integration-setting project-run-landing-off">
              <div className="project-integration-setting-label">{RUN_LANDING}</div>
              <div className="project-integration-setting-hint">{RUN_LANDING_OFF_HINT}</div>
            </div>
          ) : (
          <div className={missingCheck ? 'project-integration-setting is-warn' : 'project-integration-setting'}>
            <div className="project-integration-setting-label">{RUN_MERGE_CHECK}</div>
            <div>
              <Input
                className="start-card-mono"
                value={draft.mergeCheckCommand}
                placeholder={RUN_MERGE_CHECK_PLACEHOLDER}
                aria-label={RUN_MERGE_CHECK}
                warning={missingCheck}
                onChange={(event) => set({ mergeCheckCommand: event.target.value })}
              />
              {/* While the agent pushes, Orbit runs no check: the agent runs it before it pushes. */}
              {delivery === 'AGENT_PUSH' ? (
                <div className="project-integration-setting-hint">{runMergeCheckHintAgentPush(main)}</div>
              ) : (
                <div className="project-integration-setting-hint">{runMergeCheckHint(main)}</div>
              )}
              {missingCheck ? <div className="start-card-warn">{runNoMergeCheckWarning(main)}</div> : null}
            </div>
          </div>
          )}

          <div className="project-integration-setting">
            <div className="project-integration-setting-label">{RUN_ESCALATE_AFTER}</div>
            <div>
              <Select
                value={String(draft.escalationSeconds)}
                style={{ width: 140 }}
                aria-label={RUN_ESCALATE_AFTER}
                onValueChange={(seconds) => { if (seconds !== null) set({ escalationSeconds: Number(seconds) }); }}
                options={(ESCALATION_CHOICES.some((choice) => choice.seconds === draft.escalationSeconds)
                  ? ESCALATION_CHOICES
                  : [...ESCALATION_CHOICES, { seconds: draft.escalationSeconds, label: escalationLabel(draft.escalationSeconds) }]
                ).map((choice) => ({ value: String(choice.seconds), label: choice.label }))}
              />
              <div className="project-integration-setting-hint">{RUN_ESCALATE_HINT}</div>
            </div>
          </div>
        </div>
      </div>

      {/* Web's How it runs saves rather than asking at the press, so what a change of Delivers does is
          said here, above Save (board 01 ⑤). */}
      {writes.nonCode !== null ? (
        <div className="project-integration-setting-hint project-run-non-code-consequence">
          {writes.nonCode ? RUN_TO_NOT_CODE.replace('{branch}', shortBranch(branch)) : RUN_TO_CODE}
        </div>
      ) : null}
      <div className="project-integration-setting-actions">
        <Button
          variant="primary"
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
          ? `${runPausedSince(ago(project.pausedAt, now))} ${runPauseHint(stored.upstream ?? DEFAULT_MAIN_BRANCH)}`
          : runPauseHint(stored.upstream ?? DEFAULT_MAIN_BRANCH)}
      </div>

      {/* A refused press, in the door's own words: a 409 STALE_CONFIG_REVISION is not a Retry —
          the settings moved under the reader, and the block has been read again to show where. */}
      {save.error ? (
        <Alert
          className="project-run-settings-error"
          type="error"
          title={RUN_NOT_SAVED}
          description={save.error.message}
        />
      ) : null}
      {move.error ? (
        <Alert
          className="project-run-settings-error"
          type="error"
          title={move.variables === 'resume' ? RUN_NOT_RESUMED : RUN_NOT_PAUSED}
          description={move.error.message}
        />
      ) : null}
      {confirmation}
    </section>
  );
}
