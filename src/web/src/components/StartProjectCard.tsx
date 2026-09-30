import { useEffect, useId, useState, type JSX } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Input, InputNumber, Radio, Switch } from 'antd';
import type {
  ProjectOpenItemRow,
  ProjectStartRequest,
  ProjectStartSettings,
  StartProjectRequestBody,
} from '@orbit/shared';
import { api } from '../api';
import { acceptanceConfirmationKey, acceptanceConfirmationQuery } from '../lib/acceptanceConfirmation';
import { projectDependencyGraphQuery, projectOpenItemsQuery } from '../lib/queries';
import {
  RUN_AT_MOST,
  RUN_AUTOMATIC,
  RUN_LINE_MAIN,
  RUN_LINE_MAIN_HINT,
  RUN_LINE_PROJECT_BRANCH,
  RUN_LINE_PROJECT_BRANCH_HINT,
  RUN_MERGE_CHECK,
  RUN_MERGE_CHECK_HINT,
  RUN_MERGE_CHECK_PLACEHOLDER,
  RUN_NO_MERGE_CHECK_WARNING,
  RUN_SWITCH_OFF,
  RUN_SWITCH_ON,
  RUN_TASKS_LAND_ON,
  START_HOW_IT_RUNS,
  START_NOT_RECORDED,
  START_PROJECT_ACTION,
  START_PROJECT_TITLE,
  START_REQUEST_GONE,
  START_SUGGESTED_BY_COORDINATOR,
  START_VIEW_TASKS,
  planOrderLine,
  projectStarted,
  runAutomaticHint,
  runMergeCheckMissing,
  runTasksAtATime,
  startCardMeta,
  startCheckedLine,
  startCoordinatorSays,
  startDoneWhenHead,
  startExplanation,
  startPlanHead,
  startProject,
  startWarningLines,
  type PlanTask,
} from '../lib/projectStart';
import {
  ACCEPTANCE_PROVENANCE_TITLE,
  ACCEPTANCE_SHOW_LESS_LABEL,
  CONFIRMATION_UNREAD_EXPLANATION,
  acceptanceReadLabel,
  type ConfirmationCriterion,
  type ConfirmationProjectDocument,
  type SettlementPlanChat,
} from './AcceptanceConfirmationCard';
import { AppLink } from './AppLink';
import { CardActionButton, CardActions } from './CardAction';
import { ENTER_HINT, SHORTCUT_HINT, useDecisionCardKeys } from './CardHotkey';
import { PROVENANCE_LABEL, shortSeal } from './CriteriaDecisionCard';
import { OWNER_SEND_BACK_ACTION } from './OwnerConfirmationCard';
import { ago } from '../lib/watches';

/**
 * "Start this project?" — the one card on which the account owner starts a project: the criteria
 * it will be judged by, the plan its coordinator filed, and how it runs, pressed once.
 *
 * ASKED, NEVER INFERRED
 * ---------------------
 * The card is drawn once the coordinator has asked (`project_request_start`) and the plan passed
 * Orbit's ready check — the open `START_REQUEST` item, served beside the project's open items. It
 * used to be inferred from a project holding one task, and arrived in the middle of a coordinator
 * still deciding how to split the work. A request whose plan moved is superseded by the server on
 * that same read, so a card is never drawn for a plan that is no longer there.
 *
 * ONE PRESS, ONE WRITE
 * --------------------
 * Start sends `POST /projects/:id/start`: the seal of the criteria the coordinator asked about —
 * which the card only offers while it is the seal standing now, so it is also the version on
 * screen — and every setting as the card shows it. The settings arrive as the coordinator
 * suggested them and are the owner's to change on the card; what changed is the server's to
 * record (`differsFromRequest`), against the request this press names. A seal that moved, or a
 * project started at another end, is a 409 that writes nothing: the refusal is drawn over the
 * door's own words and the reads come round again before anything can be pressed.
 *
 * DELIVERED ONCE, AND STALE IN PLACE
 * ----------------------------------
 * A card a reader has in front of them does not vanish because the coordinator's request did: a
 * plan that moved leaves it on screen with Start dead and the reason above it, which is the moment
 * somebody who just pressed Start most needs to read why nothing happened. A new request replaces
 * it — with its own suggestions, whatever was edited on the old one — and a start made anywhere
 * takes it away, because the record of that start is drawn in the conversation where it happened
 * (`AcceptanceConfirmationReceipt`).
 *
 * The words are `lib/projectStart.ts`'s, where OrbitKit's copy-parity tests read them.
 */

/** The settings as the card edits them: the number box can be empty mid-edit, the text box is text. */
export interface StartSettingsDraft {
  line: ProjectStartSettings['line'];
  automatic: boolean;
  maxConcurrentTasks: number | null;
  mergeCheckCommand: string;
}

/** The most tasks a project may run at once, as the door bounds it (`MAX_PROJECT_CONCURRENT_TASKS`). */
export const START_MAX_CONCURRENT_TASKS = 100;

/** The card's draft of what a suggestion says. */
export function startDraftOf(settings: ProjectStartSettings): StartSettingsDraft {
  return {
    line: settings.line,
    automatic: settings.automatic,
    maxConcurrentTasks: settings.maxConcurrentTasks,
    mergeCheckCommand: settings.mergeCheckCommand ?? '',
  };
}

/** Whether the draft is a set of settings the door would take: a whole number of tasks in range. */
export function startDraftComplete(draft: StartSettingsDraft): boolean {
  const count = draft.maxConcurrentTasks;
  return count !== null && Number.isInteger(count) && count >= 1 && count <= START_MAX_CONCURRENT_TASKS;
}

/**
 * The body a press sends: the seal, every setting, and the request it answers. The branch the
 * coordinator named rides only with a project branch — the door refuses a branch name on a line
 * that has none — and an empty merge check is none.
 */
export function startBody(
  request: Pick<ProjectStartRequest, 'criteriaDigest' | 'settings'>,
  draft: StartSettingsDraft,
  requestId: string | null,
): StartProjectRequestBody {
  const branch = request.settings.projectBranchName;
  return {
    criteriaDigest: request.criteriaDigest,
    line: draft.line,
    ...(draft.line === 'PROJECT_BRANCH' && branch ? { projectBranchName: branch } : {}),
    automatic: draft.automatic,
    maxConcurrentTasks: draft.maxConcurrentTasks ?? request.settings.maxConcurrentTasks,
    mergeCheckCommand: draft.mergeCheckCommand.trim() || null,
    requestId,
  };
}

/** The plan as the card reads it: how many tasks, their order in one line, and the warnings. */
export interface StartPlanView {
  count: number;
  /** Null when the plan is too big to say in a line (the graph came back folded). */
  order: string | null;
  warnings: string[];
}

export function StartProjectCard({
  projectTitle,
  askedAt,
  request,
  criteria,
  plan,
  branch,
  draft,
  stale = null,
  busy = false,
  error = null,
  keys = false,
  projectHref,
  onDraft,
  onStart,
  onChatAbout,
  onViewTasks,
}: {
  projectTitle: string;
  /** When the coordinator asked; null for a card nobody asked for. */
  askedAt: string | null;
  /** What the coordinator asked for: the settings it suggests, why, what the check found. */
  request: ProjectStartRequest;
  /** The stated criteria, or null when the project document could not be read. */
  criteria: ConfirmationCriterion[] | null;
  plan: StartPlanView;
  /** The project branch as the first option names it. */
  branch: string;
  draft: StartSettingsDraft;
  /** Why Start is dead, or null while it is live. */
  stale?: string | null;
  /** A press is on its way to the door, or the re-read after a refusal is. */
  busy?: boolean;
  /** The door's refusal of the last press. */
  error?: Error | null;
  /** Whether this card holds the keyboard — see `CardHotkey.ts`. */
  keys?: boolean;
  /** Where "View tasks" goes when there is nothing on this page to open. */
  projectHref: string;
  onDraft: (next: StartSettingsDraft) => void;
  onStart: () => void;
  onChatAbout: () => void;
  /** Opens the tasks this conversation created, below the card. */
  onViewTasks?: () => void;
}): JSX.Element {
  const listId = useId();
  const [criteriaOpen, setCriteriaOpen] = useState(false);
  const items = [...(criteria ?? [])].sort((a, b) => a.ordinal - b.ordinal);
  const startable = !busy && stale === null && startDraftComplete(draft);
  const editable = !busy && stale === null;
  const missingCheck = runMergeCheckMissing(draft);
  const set = (patch: Partial<StartSettingsDraft>) => onDraft({ ...draft, ...patch });
  return (
    <div className="approval-card settlement-card start-card">
      <div className="approval-head settlement-card-head">
        <span className="settlement-card-heading">{START_PROJECT_TITLE}</span>
        <span className="criteria-provenance prov-brand" title={ACCEPTANCE_PROVENANCE_TITLE}>
          {PROVENANCE_LABEL}
        </span>
      </div>
      <div className="approval-body is-questions settlement-card-body">
        <div className="settlement-card-meta">
          {startCardMeta(projectTitle, askedAt ? ago(askedAt, Date.now()) : null, shortSeal(request.criteriaDigest))}
        </div>
        {stale ? <p className="settlement-card-stale">{stale}</p> : null}

        {/* The criteria, open: what a press confirms, each clamped to two lines, the toggle taking
            the clamp off — the older card's rule, for its reason. */}
        <div className="start-card-section">{startDoneWhenHead(items.length)}</div>
        {items.length > 0 ? (
          <>
            <ol
              id={listId}
              className={criteriaOpen ? 'settlement-card-criteria is-open' : 'settlement-card-criteria'}
            >
              {items.map((item) => (
                <li key={item.id} value={item.ordinal}>
                  <span className="settlement-card-criterion">{item.text}</span>
                </li>
              ))}
            </ol>
            <button
              type="button"
              className="settlement-card-read"
              aria-expanded={criteriaOpen}
              aria-controls={listId}
              onClick={() => setCriteriaOpen((open) => !open)}
            >
              {criteriaOpen ? ACCEPTANCE_SHOW_LESS_LABEL : acceptanceReadLabel(items.length)}
            </button>
          </>
        ) : null}

        <div className="start-card-section">{startPlanHead(plan.count)}</div>
        <div className="start-card-plan">
          {plan.order ? <span>{plan.order}</span> : null}
          {onViewTasks ? (
            <button type="button" className="start-card-link" onClick={onViewTasks}>
              {START_VIEW_TASKS}
            </button>
          ) : (
            <AppLink className="start-card-link" to={projectHref}>{START_VIEW_TASKS}</AppLink>
          )}
        </div>
        {plan.warnings.map((warning) => (
          <div key={warning} className="start-card-warn">{`⚠ ${warning}`}</div>
        ))}

        {/* How it runs: the integration settings card's own rows, prefilled with the coordinator's
            suggestion and the owner's to change before the press. */}
        <div className="start-card-section">
          <span>{START_HOW_IT_RUNS}</span>
          <span className="start-card-section-aside">{START_SUGGESTED_BY_COORDINATOR}</span>
        </div>
        <div className="start-card-settings">
          <div className="project-integration-setting">
            <div className="project-integration-setting-label">{RUN_TASKS_LAND_ON}</div>
            <Radio.Group
              className="start-card-lines"
              aria-label={RUN_TASKS_LAND_ON}
              value={draft.line}
              disabled={!editable}
              onChange={(event) => set({ line: event.target.value })}
            >
              <Radio value="PROJECT_BRANCH">
                <b>{RUN_LINE_PROJECT_BRANCH}</b> · <code className="start-card-branch">{branch}</code>
                <div className="project-integration-setting-hint start-card-option-hint">
                  {RUN_LINE_PROJECT_BRANCH_HINT}
                </div>
              </Radio>
              <Radio value="MAIN">
                <b>{RUN_LINE_MAIN}</b>
                <div className="project-integration-setting-hint start-card-option-hint">
                  {RUN_LINE_MAIN_HINT}
                </div>
              </Radio>
            </Radio.Group>
          </div>
          <div className="project-integration-setting">
            <div className="project-integration-setting-label">{RUN_AUTOMATIC}</div>
            <div>
              <div className="start-card-inline">
                <Switch
                  checked={draft.automatic}
                  disabled={!editable}
                  aria-label={RUN_AUTOMATIC}
                  onChange={(automatic) => set({ automatic })}
                />
                <span>{draft.automatic ? RUN_SWITCH_ON : RUN_SWITCH_OFF}</span>
              </div>
              <div className="project-integration-setting-hint">{runAutomaticHint(draft.line)}</div>
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
                disabled={!editable}
                aria-label={RUN_AT_MOST}
                onChange={(value) => set({ maxConcurrentTasks: typeof value === 'number' ? value : null })}
              />
              <span>{runTasksAtATime(draft.maxConcurrentTasks)}</span>
            </div>
          </div>
          <div className={missingCheck ? 'project-integration-setting is-warn' : 'project-integration-setting'}>
            <div className="project-integration-setting-label">{RUN_MERGE_CHECK}</div>
            <div>
              <Input
                className="start-card-mono"
                value={draft.mergeCheckCommand}
                placeholder={RUN_MERGE_CHECK_PLACEHOLDER}
                disabled={!editable}
                aria-label={RUN_MERGE_CHECK}
                status={missingCheck ? 'warning' : undefined}
                onChange={(event) => set({ mergeCheckCommand: event.target.value })}
              />
              <div className="project-integration-setting-hint">{RUN_MERGE_CHECK_HINT}</div>
              {missingCheck ? <div className="start-card-warn">{RUN_NO_MERGE_CHECK_WARNING}</div> : null}
            </div>
          </div>
        </div>
        {request.why ? <p className="start-card-note">{startCoordinatorSays(request.why)}</p> : null}

        <p className="start-card-checked">
          <span className="start-card-tick" aria-hidden="true">✓</span>
          <span>{startCheckedLine(request.repository)}</span>
        </p>
        <p className="settlement-card-explains">{startExplanation(items.length)}</p>
        {error ? (
          <Alert
            className="settlement-card-error"
            type="error"
            showIcon
            message={START_NOT_RECORDED}
            description={error.message}
          />
        ) : null}
      </div>
      <CardActions className="approval-actions settlement-card-actions">
        <CardActionButton tone="primary" disabled={!startable} onClick={onStart}>
          {START_PROJECT_ACTION}
          {keys && startable && <span className="approval-kbd">{ENTER_HINT}</span>}
        </CardActionButton>
        <CardActionButton tone="secondary" disabled={criteria === null} onClick={onChatAbout}>
          {OWNER_SEND_BACK_ACTION}
          {keys && criteria !== null && <span className="approval-kbd">{SHORTCUT_HINT}</span>}
        </CardActionButton>
      </CardActions>
    </div>
  );
}

/** The plan, off the project's dependency graph: the tasks nothing cancelled, their order, and the
 *  check's warnings in the order line's names. A folded graph is a plan too big for one line, and
 *  says only how many tasks it holds. */
export function startPlanView(
  graph: {
    marks: Array<{ kind: string; id: string; taskId?: string; title: string; status?: string }>;
    edges: Array<{ sourceMarkId: string; targetMarkId: string }>;
    taskCount: number;
    folded: boolean;
    truncated: boolean;
  } | null,
  request: Pick<ProjectStartRequest, 'warnings'>,
  fallbackCount: number,
): StartPlanView {
  if (!graph || graph.folded || graph.truncated) {
    return {
      count: graph?.taskCount ?? fallbackCount,
      order: null,
      warnings: startWarningLines(request.warnings, []),
    };
  }
  // Unfolded, every mark is one task. Cancelled ones are not part of the plan, and settled ones
  // run nothing, so neither is given a place in the order.
  const tasks = graph.marks.filter((mark) => mark.kind === 'TASK' && mark.status !== 'CANCELLED');
  const planned: PlanTask[] = tasks
    .filter((mark) => mark.status !== 'DONE')
    .map((mark) => ({
      id: mark.id,
      title: mark.title,
      after: graph.edges.filter((edge) => edge.targetMarkId === mark.id).map((edge) => edge.sourceMarkId),
    }));
  return {
    count: tasks.length,
    order: planned.length === 0 ? null : planOrderLine(planned),
    warnings: startWarningLines(
      request.warnings,
      tasks.map((mark) => ({ id: mark.taskId ?? mark.id, title: mark.title })),
    ),
  };
}

/**
 * The wired card for one conversation: the coordinator's open request, the criteria it names and
 * the plan it is about, read on every render; the press; and the keys.
 */
export function SessionStartProjectCard({
  projectId,
  onOpen,
  onChatAbout,
  onViewTasks,
}: {
  /** The project this conversation coordinates. Ordinary conversations have none and get no card. */
  projectId: string | null | undefined;
  /** Told whether the card is on screen, each time that changes, and `false` when it goes. A
   *  stable function. */
  onOpen?: (open: boolean) => void;
  /** Arms the composer to talk about this plan. Nothing here is a door, and the card stays. */
  onChatAbout?: (plan: SettlementPlanChat) => void;
  onViewTasks?: () => void;
}): JSX.Element | null {
  const qc = useQueryClient();
  const project = projectId ?? '';
  const enabled = Boolean(projectId);
  const standingRead = useQuery({ ...acceptanceConfirmationQuery(project), enabled });
  const documentRead = useQuery({
    queryKey: ['project', project],
    queryFn: () => api<ConfirmationProjectDocument>(`/projects/${encodeURIComponent(project)}`),
    enabled,
    refetchInterval: 20_000,
  });
  // A read that failed is not an answer, whatever an earlier read said.
  const standing = standingRead.isError ? null : (standingRead.data ?? null);
  const document = documentRead.isError ? null : (documentRead.data ?? null);
  const started = document === null ? null : projectStarted(document);
  // The request is asked for only while there is a project nobody has started: once one is, the
  // card has nothing to ask.
  const itemsRead = useQuery({
    ...projectOpenItemsQuery(project),
    enabled: enabled && started === false,
    refetchInterval: 20_000,
  });
  const openRow = itemsRead.isError ? null : (itemsRead.data?.startRequest ?? null);
  const live: ProjectOpenItemRow | null = started === false && openRow?.startRequest ? openRow : null;

  // The request the card was drawn for, kept while the reader has it in front of them.
  const [delivered, setDelivered] = useState<ProjectOpenItemRow | null>(null);
  useEffect(() => {
    if (live && live.itemId !== delivered?.itemId) setDelivered(live);
  }, [live, delivered]);
  const shown = live ?? (started === true ? null : delivered);
  const request = shown?.startRequest ?? null;

  // The owner's edits belong to the request they were made on: a new request arrives with its own
  // suggestions.
  const [edited, setEdited] = useState<{ itemId: string; draft: StartSettingsDraft } | null>(null);
  const draft = shown && request
    ? (edited?.itemId === shown.itemId ? edited.draft : startDraftOf(request.settings))
    : null;

  const graphRead = useQuery({
    ...projectDependencyGraphQuery(project),
    enabled: enabled && shown !== null,
  });

  const reread = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: acceptanceConfirmationKey(project) }),
      qc.invalidateQueries({ queryKey: ['project', project], exact: true }),
      qc.invalidateQueries({ queryKey: projectOpenItemsQuery(project).queryKey }),
    ]);
  const start = useMutation({
    mutationFn: (body: StartProjectRequestBody) => startProject(project, body),
    // The record of the start is drawn by the conversation from the confirmation read, and the
    // project read is what says it is started: both come round again.
    onSuccess: () => reread(),
    // Returned rather than fired off, so the button stays dead until the reads it re-derives from
    // have caught up with the refusal.
    onError: () => reread(),
  });
  const answeredHere = start.isSuccess && start.variables?.requestId === (shown?.itemId ?? null);

  // Why Start is dead, if it is: a read that failed names no version to start on, and a request
  // that no longer stands — superseded, or naming a seal the criteria have moved past — starts
  // nothing a reader agreed to.
  const unread = standingRead.isError || documentRead.isError || itemsRead.isError;
  const gone = request !== null && (
    live === null || (standing !== null && standing.currentVersion.digest !== request.criteriaDigest)
  );
  const stale = unread ? CONFIRMATION_UNREAD_EXPLANATION : gone ? START_REQUEST_GONE : null;

  const criteria = document?.acceptanceCriteriaItems ?? null;
  const title = document?.title || project;
  const onScreen = shown !== null && request !== null && !answeredHere;
  useEffect(() => {
    onOpen?.(onScreen);
  }, [onOpen, onScreen]);
  useEffect(() => () => onOpen?.(false), [onOpen]);

  const press = (): void => {
    if (!shown || !request || !draft || stale !== null || !startDraftComplete(draft)) return;
    start.mutate(startBody(request, draft, shown.itemId));
  };
  const talkAbout = (): void => {
    if (!request || criteria === null) return;
    onChatAbout?.({
      projectId: project,
      criteriaDigest: request.criteriaDigest,
      projectTitle: title,
      criteria: [...criteria].sort((a, b) => a.ordinal - b.ordinal).map((item) => item.text),
      question: 'START',
    });
  };
  const keys = useDecisionCardKeys({
    confirmEnabled: onScreen && !start.isPending && stale === null && draft !== null && startDraftComplete(draft),
    chatEnabled: onScreen && criteria !== null,
    onConfirm: press,
    onChatAbout: talkAbout,
  });

  if (!onScreen || !shown || !request || !draft) return null;
  const branchRef = request.settings.projectBranchName ?? `refs/heads/project/${project}`;
  return (
    <StartProjectCard
      key={shown.itemId}
      projectTitle={title}
      askedAt={shown.waitingSince}
      request={request}
      criteria={criteria}
      plan={startPlanView(graphRead.data ?? null, request, document?._count?.tasks ?? 0)}
      branch={branchRef.replace(/^refs\/heads\//u, '')}
      draft={draft}
      stale={stale}
      busy={start.isPending}
      // The refusal of a press on THIS request: a newer request starts with a clean card.
      error={start.isError && start.variables?.requestId === shown.itemId ? start.error : null}
      keys={keys}
      projectHref={`/projects/${encodeURIComponent(project)}`}
      onDraft={(next) => setEdited({ itemId: shown.itemId, draft: next })}
      onStart={press}
      onChatAbout={talkAbout}
      onViewTasks={onViewTasks}
    />
  );
}
