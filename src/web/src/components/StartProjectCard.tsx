import { useEffect, useId, useRef, useState, type JSX, type Ref } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Input, InputNumber, Modal, Radio, Spin, Switch } from 'antd';
import type {
  ProjectIntegrationView,
  ProjectOpenItemRow,
  ProjectStartRequest,
  ProjectStartSettings,
  StartProjectRequestBody,
} from '@orbit/shared';
import { api } from '../api';
import { acceptanceConfirmationKey, acceptanceConfirmationQuery } from '../lib/acceptanceConfirmation';
import { markStatus, type ProjectDependencyGraphResponse } from '../lib/projectDependencyGraph';
import {
  projectDependencyGraphQuery,
  projectIntegrationQuery,
  projectOpenItemsQuery,
} from '../lib/queries';
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
import { ENTER_HINT, useDecisionCardKeys } from './CardHotkey';
import { PROVENANCE_LABEL, shortSeal } from './CriteriaDecisionCard';
import { OWNER_SEND_BACK_ACTION } from './OwnerConfirmationCard';
import { ago } from '../lib/watches';
import { ReviewCard } from './ReviewCard';
import { useIsMobile } from '../lib/useMediaQuery';
import { Drawer } from './ui/Drawer';

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
  ref,
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
  /** The card's own element, which is where its keyboard claim says it is drawn (`CardHotkey.ts`). */
  ref?: Ref<HTMLDivElement>;
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
  /** Arms a conversation's composer. Absent where there is no conversation to talk in — the card
   *  opened over the project page — and then the press is not drawn. */
  onChatAbout?: () => void;
  /** Opens the tasks this conversation created, below the card. */
  onViewTasks?: () => void;
}): JSX.Element {
  const listId = useId();
  const [criteriaOpen, setCriteriaOpen] = useState(false);
  const items = [...(criteria ?? [])].sort((a, b) => a.ordinal - b.ordinal);
  // A card nobody asked for — the owner's own "Start…" on the project page — carries the default
  // rule's settings rather than a suggestion, and no ready check ran on its plan, so it claims
  // neither.
  const asked = askedAt !== null;
  const startable = !busy && stale === null && startDraftComplete(draft);
  const editable = !busy && stale === null;
  const missingCheck = runMergeCheckMissing(draft);
  const set = (patch: Partial<StartSettingsDraft>) => onDraft({ ...draft, ...patch });
  return (
    <div ref={ref} className="approval-card settlement-card start-card">
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
          {asked ? <span className="start-card-section-aside">{START_SUGGESTED_BY_COORDINATOR}</span> : null}
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

        {asked ? (
          <p className="start-card-checked">
            <span className="start-card-tick" aria-hidden="true">✓</span>
            <span>{startCheckedLine(request.repository)}</span>
          </p>
        ) : null}
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
        {onChatAbout ? (
          <CardActionButton tone="secondary" disabled={criteria === null} onClick={onChatAbout}>
            {OWNER_SEND_BACK_ACTION}
          </CardActionButton>
        ) : null}
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
 *
 * `bare` draws the same card for the project's sessions page, inside its start dialog
 * (`ProjectStartDialog` with `asked`): no review wrapper around it, Chat about this only when there
 * is a composer to hand it to, and a word in place of the card while the request is still being
 * read or has stopped standing.
 */
export function SessionStartProjectCard({
  projectId,
  bare = false,
  onOpen,
  onStarted,
  onChatAbout,
  onViewTasks,
}: {
  /** The project this conversation coordinates. Ordinary conversations have none and get no card. */
  projectId: string | null | undefined;
  bare?: boolean;
  /** Told once a press went through, after the reads it changed have come round. */
  onStarted?: () => void;
  /** Told whether the card is on screen, each time that changes, and `false` when it goes. A
   *  stable function. */
  onOpen?: (open: boolean) => void;
  /** Arms the composer to talk about this plan. Nothing here is a door, and the card stays. */
  onChatAbout?: (plan: SettlementPlanChat) => void;
  onViewTasks?: () => void;
}): JSX.Element | null {
  const [reviewOpen, setReviewOpen] = useState(false);
  const narrow = useIsMobile();
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
      // The project rows say whether it started too: the sessions page's start row reads them.
      qc.invalidateQueries({ queryKey: ['projects'] }),
    ]);
  const start = useMutation({
    mutationFn: (body: StartProjectRequestBody) => startProject(project, body),
    // The record of the start is drawn by the conversation from the confirmation read, and the
    // project read is what says it is started: both come round again.
    onSuccess: async () => {
      await reread();
      onStarted?.();
    },
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
    setReviewOpen(false);
    onChatAbout?.({
      projectId: project,
      criteriaDigest: request.criteriaDigest,
      projectTitle: title,
      criteria: [...criteria].sort((a, b) => a.ordinal - b.ordinal).map((item) => item.text),
      question: 'START',
    });
  };
  const anchor = useRef<HTMLDivElement>(null);
  const keys = useDecisionCardKeys({
    confirmEnabled: (!narrow || reviewOpen || bare) && onScreen && !start.isPending && stale === null && draft !== null && startDraftComplete(draft),
    onConfirm: press,
    anchor,
  });

  if (!onScreen || !shown || !request || !draft) {
    if (!bare || answeredHere) return null;
    // In the dialog, nothing at all would read as a dialog that broke: say what is happening.
    const reading = standingRead.isPending || documentRead.isPending || (started === false && itemsRead.isPending);
    return reading ? (
      <div className="start-card-dialog-loading">
        <Spin />
      </div>
    ) : (
      <Alert type="info" showIcon message={unread ? CONFIRMATION_UNREAD_EXPLANATION : START_REQUEST_GONE} />
    );
  }
  const branchRef = request.settings.projectBranchName ?? `refs/heads/project/${project}`;
  const card = (
    <StartProjectCard
      ref={anchor}
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
      onChatAbout={onChatAbout ? talkAbout : undefined}
      onViewTasks={onViewTasks ? () => { setReviewOpen(false); onViewTasks(); } : undefined}
    />
  );
  if (bare) return card;
  return (
    <ReviewCard id="settlement-preview" title={START_PROJECT_TITLE} summary={title}
      meta={stale ?? `${criteria?.length ?? 0} criteria · ${document?._count?.tasks ?? 0} tasks`}
      open={reviewOpen} onOpenChange={setReviewOpen}>
      {card}
    </ReviewCard>
  );
}

/**
 * The settings a start takes when nobody suggested any — the rule the older confirmation door
 * starts a project by (`defaultStartLine`), read off what the project page holds: the line the
 * project is already on or its owner chose, else a project branch when its tasks wait on one
 * another and main when they do not; Automatic on; the concurrency it has; the merge check it has.
 *
 * The line half is the page's reading of that rule — over the dependency graph, where the server
 * counts its code tasks — and where the two differ (a project with no repository, where no branch
 * can exist) the start door says so, on the card, and the owner picks again.
 */
export function defaultStartSettings(
  view: Pick<ProjectIntegrationView, 'line' | 'ref' | 'mergeCheckCommand'>,
  project: { maxConcurrentTasks?: number },
  graph: Pick<ProjectDependencyGraphResponse, 'marks' | 'edges'> | null,
): ProjectStartSettings {
  const line = view.line ?? (graph && planHasDependencies(graph) ? 'PROJECT_BRANCH' : 'MAIN');
  return {
    line,
    ...(view.line === 'PROJECT_BRANCH' && view.ref ? { projectBranchName: `refs/heads/${view.ref}` } : {}),
    automatic: true,
    maxConcurrentTasks: project.maxConcurrentTasks ?? 1,
    mergeCheckCommand: view.mergeCheckCommand ?? null,
  };
}

/** Whether any live task of the plan waits on another. A run the server folded is a chain. */
function planHasDependencies(graph: Pick<ProjectDependencyGraphResponse, 'marks' | 'edges'>): boolean {
  const live = new Set(
    graph.marks.filter((mark) => markStatus(mark) !== 'CANCELLED').map((mark) => mark.id),
  );
  return graph.marks.some((mark) => mark.kind === 'RUN')
    || graph.edges.some((edge) => live.has(edge.sourceMarkId) && live.has(edge.targetMarkId));
}

/** The project document, as the owner's own start reads it. */
interface OwnerStartDocument extends ConfirmationProjectDocument {
  maxConcurrentTasks?: number;
}

/**
 * "Start…" — the start card over the project page, for a project whose coordinator has not asked
 * (D2): the same card, set by the default rule (`defaultStartSettings`), pressed at the same door
 * with no request to answer. Its criteria, seal and plan are read here as the conversation's card
 * reads them; a press that the door refuses is said on the card, over its words, and the reads come
 * round again.
 */
function OwnerStartProjectCard({
  projectId,
  onStarted,
  onViewTasks,
}: {
  projectId: string;
  onStarted: () => void;
  onViewTasks?: () => void;
}): JSX.Element | null {
  const qc = useQueryClient();
  const standingRead = useQuery(acceptanceConfirmationQuery(projectId));
  const documentRead = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api<OwnerStartDocument>(`/projects/${encodeURIComponent(projectId)}`),
  });
  const integrationRead = useQuery(projectIntegrationQuery(projectId));
  const graphRead = useQuery(projectDependencyGraphQuery(projectId));
  const standing = standingRead.isError ? null : (standingRead.data ?? null);
  const document = documentRead.isError ? null : (documentRead.data ?? null);
  const view = integrationRead.isError ? null : (integrationRead.data ?? null);
  const graph = graphRead.data ?? null;

  const defaults = view && document ? defaultStartSettings(view, document, graph) : null;
  const request: ProjectStartRequest | null = defaults && standing
    ? {
      settings: defaults,
      why: '',
      criteriaDigest: standing.currentVersion.digest,
      planDigest: '',
      repository: null,
      warnings: [],
    }
    : null;
  // The owner's edits, once there are any; until then the defaults, as the reads resolve them.
  const [edited, setEdited] = useState<StartSettingsDraft | null>(null);
  const draft = edited ?? (defaults ? startDraftOf(defaults) : null);

  const reread = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ['project', projectId] }),
      qc.invalidateQueries({ queryKey: ['projects'] }),
    ]);
  const start = useMutation({
    mutationFn: (body: StartProjectRequestBody) => startProject(projectId, body),
    onSuccess: async () => {
      await reread();
      onStarted();
    },
    onError: () => reread(),
  });

  const unread = standingRead.isError || documentRead.isError || integrationRead.isError;
  const stale = unread ? CONFIRMATION_UNREAD_EXPLANATION : null;
  if (!request || !draft) {
    return unread ? (
      <Alert type="error" showIcon message={CONFIRMATION_UNREAD_EXPLANATION} />
    ) : (
      <div className="start-card-dialog-loading">
        <Spin />
      </div>
    );
  }
  const criteria = document?.acceptanceCriteriaItems ?? null;
  const branchRef = request.settings.projectBranchName ?? `refs/heads/project/${projectId}`;
  return (
    <StartProjectCard
      projectTitle={document?.title || projectId}
      askedAt={null}
      request={request}
      criteria={criteria}
      plan={startPlanView(graph, request, document?._count?.tasks ?? 0)}
      branch={branchRef.replace(/^refs\/heads\//u, '')}
      draft={draft}
      stale={stale}
      busy={start.isPending}
      error={start.isError ? start.error : null}
      projectHref={`/projects/${encodeURIComponent(projectId)}`}
      onDraft={setEdited}
      onStart={() => {
        if (stale !== null || !startDraftComplete(draft)) return;
        start.mutate(startBody(request, draft, null));
      }}
      onViewTasks={onViewTasks}
    />
  );
}

/** The start card over a page: the owner's own "Start…", or — `asked` — the coordinator's request,
 *  answered here (the project's sessions page, docs/mocks/project-start-sessions-page). A dialog on a
 *  wide screen and a sheet from the bottom on a phone, as iOS puts it up. Mounted only while open, so
 *  a page nobody starts from never reads the plan's graph for it. */
export function ProjectStartDialog({
  projectId,
  open,
  onClose,
  onViewTasks,
  asked = false,
}: {
  projectId: string;
  open: boolean;
  onClose: () => void;
  /** Where the card's "View tasks" goes: the page's own task list, under the dialog. */
  onViewTasks?: () => void;
  asked?: boolean;
}): JSX.Element {
  const narrow = useIsMobile();
  const card = !open ? null : asked ? (
    <SessionStartProjectCard projectId={projectId} bare onStarted={onClose} onViewTasks={onViewTasks} />
  ) : (
    <OwnerStartProjectCard projectId={projectId} onStarted={onClose} onViewTasks={onViewTasks} />
  );
  return narrow ? (
    <Drawer open={open} onClose={onClose} title={START_PROJECT_TITLE} placement="bottom" height="92%"
      className="start-card-sheet">
      {card}
    </Drawer>
  ) : (
    <Modal open={open} onCancel={onClose} footer={null} width={640} className="start-card-dialog">
      {card}
    </Modal>
  );
}
