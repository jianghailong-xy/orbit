import { useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeftOutlined,
  BranchesOutlined,
  CheckCircleFilled,
  ClockCircleOutlined,
  CloseCircleFilled,
  CloseOutlined,
  CloudUploadOutlined,
  CodeOutlined,
  DownOutlined,
  DownloadOutlined,
  FileTextOutlined,
  LoadingOutlined,
  LockOutlined,
  MoreOutlined,
  MessageOutlined,
  ProjectOutlined,
  ReloadOutlined,
  RightOutlined,
  SafetyCertificateOutlined,
  UnorderedListOutlined,
  UserOutlined,
} from '@ant-design/icons';
import type {
  IntegrationJobKind,
  IntegrationTimelineEntry,
  ProjectIntegrationLogPage,
  ProjectIntegrationView,
  ProjectPromotionView,
  SessionLandingView,
} from '@orbit/shared';
import { api, type SessionDetail } from '../api';
import {
  LANDING_PAGE_COPY,
  NO_LANDING_GATES,
  landingAttemptCard,
  landingCheckLabel,
  landingCheckPassed,
  landingTimelineText,
  scopedLandingEntries,
  landingEntryOk,
  landingGates,
  landingHeaderTitle,
  landingMenuItemList,
  landingMergeReceipt,
  landingNoReportBand,
  landingOutcomeCard,
  landingPushSentence,
  landingRefetchMs,
  landingTimeoutLine,
  type LandingGates,
  type LandingMenuAction,
  type LandingMenuItem,
  type LandingMergeReceipt,
} from '../lib/landingSession';
import {
  SESSION_LANDINGS_COPY,
  SESSION_PROJECT_COPY,
  landingsWindow,
  landingsWindowGroups,
  type LandingSessionRow,
  type LandingsWindowCard,
  type LandingsWindowRow,
} from '../lib/sessionProjects';
import {
  landingLogQuery,
  projectCoordinatorStatusQuery,
  projectDetailsQuery,
  projectIntegrationQuery,
  projectMergedPromotionsQuery,
  projectPromotionQuery,
  projectSessionsQuery,
  sessionQuery,
  type LandingLogSelectors,
} from '../lib/queries';
import { landingSteps, type LandingStep } from '../lib/landingSteps';
import {
  LANDING_SENTENCE_COPY,
  landingSentence,
  sentenceFacts,
  settledSentenceKind,
  stepsLabel,
  type SentencePart,
} from '../lib/landingSentence';
import { encodeId } from '../lib/idCodec';
import { projectTaskPath } from '../lib/projectTaskRoute';
import { RERUN_LANDING_CHECK_REASON, promotionOnPassLine } from '../lib/projectMerge';
import { mainBranchName } from '../lib/projectStart';
import { landingClock } from './ProjectPanoramaHeader';
import {
  ProjectPromotion,
  ProjectPromotionReceipt,
  promotionHeading,
} from './ProjectPromotionCard';
import { Menu, type MenuItem } from './ui/Menu';
import { Button } from './ui/Button';
import { Dialog } from './ui/Dialog';
import { Spinner } from './ui/Spinner';

/** How long a landing the window was opened on stays outlined (board 03 f). */
const FOCUS_OUTLINE_MS = 1_500;

/** What every landing in the window reads from the project: the facts the cards' heads and doors
 *  take beside each landing's own view (§7.2 V6, the coordinator, the round's candidate). */
interface WindowFacts {
  integration: ProjectIntegrationView | null;
  coordinatorId: string | null;
  /** The candidate a round still in hand is about (`promotions/current`). */
  promotion: ProjectPromotionView | null;
}

/**
 * A project's Landings window (owner 2026-10-27, docs/mocks/landings-one-window; contract §2.9 LS6
 * and §3.6, revision 28): every landing the project has had, read like a conversation — the settled
 * ones by day, oldest at the top, and the ones still in hand under `Now` at the bottom, where the
 * window opens. A landing session id opens this window on its landing (`focusId`): scrolled to,
 * opened and outlined for a moment.
 *
 * The window is the old landing session page's shell — `Landings` over the project's name, a ⋯
 * with the coordinator and the project, the read-only footer and no composer (LS6) — and each landing
 * in it carries what that page drew: a card still in hand is its status card, polled on §2.7a's
 * cadence; a settled row opens in place to its timeline, read once and never polled. The doors the
 * page's ⋯ held are each landing's own: its ⋯, or a right-click on it.
 *
 * It is drawn as a chat (owner 2026-11-02, docs/mocks/landings-chat-bubbles, option C): each day
 * under a centered chip, each settled landing one message bubble from Orbit, the ones Orbit sent close
 * together (`landingsWindowGroups`) one group, and the cards in hand Orbit's last group. Polished
 * 2026-11-10 (docs/mocks/landings-ui-polish): no avatars — every message here is Orbit's — a merge into
 * main is one centred event line, the head's second line is the project's name, and the read-only
 * footer is one plain line on the window's bottom edge.
 *
 * Nothing here is a new read: the two the project's sessions page already makes (its LANDING rows and
 * its merges into main), and each landing's own view when it is drawn as a card or opened.
 */
export function ProjectLandingsWindow({
  projectId,
  focusId = null,
  onOpenSession,
  onBack = null,
}: {
  projectId: string;
  /** The landing session to scroll to, open and outline — the id the window was opened on. */
  focusId?: string | null;
  /** Opens a conversation (the coordinator) in the shell, which owns the pane transition. */
  onOpenSession: (sessionId: string) => void;
  /** The phone's way back to the list; the wide shell keeps the list beside the window. */
  onBack?: (() => void) | null;
}): JSX.Element {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const openQ = useQuery({
    ...projectSessionsQuery({ projectId, view: 'open', includeLanding: true, priority: true }),
    refetchInterval: 15_000,
  });
  const completedQ = useQuery({
    ...projectSessionsQuery({ projectId, view: 'completed', includeLanding: true, priority: true }),
    refetchInterval: 15_000,
  });
  const mergedQ = useQuery({ ...projectMergedPromotionsQuery(projectId), refetchInterval: 60_000 });
  const coordinatorQ = useQuery(projectCoordinatorStatusQuery(projectId));
  const projectQ = useQuery(projectDetailsQuery(projectId));
  // The landing the window was opened on, read the way the shell read it: a landing whose row has not
  // been inserted yet (LS1's pre-generated id) is in no list, and still has its place here.
  const focusQ = useQuery({ ...sessionQuery(focusId), enabled: focusId != null });
  const focus = focusQ.data?.id === focusId ? focusQ.data : null;

  const rows = useMemo(() => {
    const byId = new Map<string, LandingSessionRow>();
    for (const row of [...(openQ.data ?? []), ...(completedQ.data ?? [])]) {
      if (row.sessionKind === 'LANDING' && row.landing) byId.set(row.id, row as LandingSessionRow);
    }
    const view = focus?.landing;
    if (focusId && view && view.projectId === projectId && !byId.has(focusId)) {
      byId.set(focusId, {
        id: focusId,
        title: focus.title ?? landingHeaderTitle(view, null),
        createdAt: view.openedAt,
        landing: {
          subject: view.subject,
          state: view.settledAt ? 'SETTLED' : 'IN_FLIGHT',
          settledAs: view.settledAs,
          settledAt: view.settledAt,
        },
      });
    }
    return [...byId.values()];
  }, [openQ.data, completedQ.data, focus, focusId, projectId]);
  const merges = useMemo(() => (Array.isArray(mergedQ.data) ? mergedQ.data : []), [mergedQ.data]);
  const landings = useMemo(() => landingsWindow(rows, merges, { now: new Date() }), [rows, merges]);

  const cards = landings.now;
  const integrationQ = useQuery({ ...projectIntegrationQuery(projectId), enabled: cards.length > 0 });
  const promotionQ = useQuery({
    ...projectPromotionQuery(projectId),
    enabled: cards.some((card) => card.subject === 'PROMOTION'),
    refetchInterval: 15_000,
  });
  const coordinatorId = coordinatorQ.data?.coordination?.sessionId ?? null;
  const facts: WindowFacts = {
    integration: integrationQ.data ?? null,
    coordinatorId,
    promotion: promotionQ.data ?? null,
  };
  const projectTitle = projectQ.data?.title
    ?? (openQ.data ?? []).find((row) => row.projectMembership?.projectTitle)?.projectMembership?.projectTitle
    ?? null;

  // Where the window stands: what is open, and the landing outlined for a moment.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set(focusId ? [focusId] : []));
  const [outlined, setOutlined] = useState<string | null>(null);
  const [scrollTo, setScrollTo] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const placed = useRef<string | null>(null);
  // Opened at its bottom, the window stays there while what it opened with fills in (each card's own
  // read, a record opening under the bottom card) — until the reader moves it.
  const stick = useRef(false);
  const loaded = openQ.isSuccess && completedQ.isSuccess;
  const toggle = (key: string): void => setExpanded((current) => {
    const next = new Set(current);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  });
  const entry = (key: string): HTMLElement | null =>
    [...(bodyRef.current?.querySelectorAll<HTMLElement>('[data-landing-entry]') ?? [])]
      .find((element) => element.getAttribute('data-landing-entry') === key) ?? null;
  // Placed once per landing it is opened on: at the bottom like a conversation, or on that landing —
  // opened first, then scrolled to, so what opening adds is under it and not over it.
  useLayoutEffect(() => {
    if (!loaded) return;
    const target = `${projectId}:${focusId ?? ''}`;
    if (placed.current === target) return;
    if (focusId) {
      if (!entry(focusId)) return;
      placed.current = target;
      stick.current = false;
      setExpanded((current) => new Set(current).add(focusId));
      setScrollTo(focusId);
      return;
    }
    placed.current = target;
    stick.current = true;
    const body = bodyRef.current;
    if (body) body.scrollTop = body.scrollHeight;
  });
  useEffect(() => {
    const body = bodyRef.current;
    const content = contentRef.current;
    if (!body || !content || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => {
      if (stick.current) body.scrollTop = body.scrollHeight;
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, []);
  const unstick = (): void => {
    stick.current = false;
  };
  useLayoutEffect(() => {
    if (!scrollTo) return;
    entry(scrollTo)?.scrollIntoView?.({ block: 'start' });
    setOutlined(scrollTo);
    setScrollTo(null);
  }, [scrollTo]);
  useEffect(() => {
    if (!outlined) return;
    const timer = setTimeout(() => setOutlined(null), FOCUS_OUTLINE_MS);
    return () => clearTimeout(timer);
  }, [outlined]);
  // A card that settled moves to its day at once: its own read saw it before the list's next one.
  const settled = (): void => {
    void qc.invalidateQueries({ queryKey: ['project-sessions', projectId] });
    void qc.invalidateQueries({ queryKey: projectMergedPromotionsQuery(projectId).queryKey });
  };

  const windowMenu: MenuItem[] = [
    ...(coordinatorId ? [{
      key: 'coordinator', label: LANDING_PAGE_COPY.OPEN_COORDINATOR, icon: <UserOutlined />,
      onSelect: () => onOpenSession(coordinatorId),
    }] : []),
    {
      key: 'project', label: SESSION_PROJECT_COPY.openProject, icon: <ProjectOutlined />,
      onSelect: () => navigate(`/projects/${encodeId(projectId)}`),
    },
  ];
  const [runs] = SESSION_LANDINGS_COPY.ORBIT_RUNS_THESE_LANDINGS.split(' — ');

  return (
    <div className="landing-page landings-window" data-project={projectId}>
      <div className="landing-page-head landings-window-head">
        {onBack ? (
          <button type="button" className="landings-window-back" aria-label="Back" onClick={onBack}>
            <ArrowLeftOutlined />
          </button>
        ) : null}
        <div className="landings-window-titles">
          <div className="landing-page-title">{SESSION_LANDINGS_COPY.TITLE}</div>
          <div className="landing-page-sub">
            {projectTitle || LANDING_PAGE_COPY.RUN_BY_ORBIT}
          </div>
        </div>
        <Menu
          side="bottom"
          align="end"
          trigger={(
            <button type="button" className="landing-page-more" aria-label="More actions" title="More actions">
              <MoreOutlined />
            </button>
          )}
          items={windowMenu}
        />
      </div>

      <div className="landing-page-body landings-window-body" ref={bodyRef}
        onPointerDown={unstick} onWheel={unstick} onKeyDown={unstick} onTouchStart={unstick}>
        <div ref={contentRef}>
        {!loaded ? (
          openQ.isError || completedQ.isError
            ? <div className="landing-page-note">{LANDING_PAGE_COPY.UPDATE_UNAVAILABLE}</div>
            : <div className="landings-window-loading"><Spinner size="small" /></div>
        ) : null}
        {/* Only an address opens a window with nothing in it: the sessions page draws no Landings row
            for a project that has never had a landing. */}
        {loaded && mergedQ.isFetched && landings.days.length === 0 && cards.length === 0 ? (
          <div className="landings-window-loading">
            <span className="landing-page-note">{SESSION_LANDINGS_COPY.NO_LANDINGS_YET}</span>
          </div>
        ) : null}
        {landings.days.map((day) => (
          <section key={day.title} className="landings-window-day" aria-label={day.title}>
            <div className="landings-window-day-head">{day.title}</div>
            {landingsWindowGroups(day.rows).map((group) => (
              <div key={group[0].key} className="landings-window-group">
                <div className="landings-window-column">
                  {group.map((row) => (
                    <LandingWindowRow
                      key={row.key}
                      row={row}
                      projectId={projectId}
                      facts={facts}
                      expanded={expanded.has(row.sessionId ?? row.key)}
                      outlined={outlined === (row.sessionId ?? row.key)}
                      onToggle={() => toggle(row.sessionId ?? row.key)}
                      onOpenSession={onOpenSession}
                    />
                  ))}
                </div>
              </div>
            ))}
          </section>
        ))}
        {cards.length > 0 ? (
          <section className="landings-window-day landings-window-now" aria-label={SESSION_LANDINGS_COPY.NOW}>
            <div className="landings-window-day-head">{SESSION_LANDINGS_COPY.NOW}</div>
            {/* What is still in hand is Orbit's last group of messages: its cards take the column's
                whole width, with no gutter on the right. */}
            <div className="landings-window-group">
              <div className="landings-window-column">
                {cards.map((card) => (
                  <LandingWindowCard
                    key={card.sessionId}
                    card={card}
                    projectId={projectId}
                    facts={facts}
                    expanded={expanded.has(card.sessionId)}
                    outlined={outlined === card.sessionId}
                    onToggle={() => toggle(card.sessionId)}
                    onOpenSession={onOpenSession}
                    onSettled={settled}
                  />
                ))}
              </div>
            </div>
          </section>
        ) : null}
        </div>
      </div>

      <div className="landing-page-foot">
        {/* What this window is and the way to who decides: nothing to type here (LS6). One plain line on
            the window's bottom edge — a lock and the sentence's first half, the coordinator's door at
            the end (docs/mocks/landings-ui-polish ③). */}
        <span className="landing-page-foot-line" title={SESSION_LANDINGS_COPY.ORBIT_RUNS_THESE_LANDINGS}>
          <LockOutlined aria-hidden="true" />
          <span className="sr-only">{SESSION_LANDINGS_COPY.ORBIT_RUNS_THESE_LANDINGS}</span>
          <span className="landing-page-foot-words" aria-hidden="true">{runs}</span>
        </span>
        {coordinatorId ? (
          <Button className="landing-page-foot-open" icon={<UserOutlined />}
            title={LANDING_PAGE_COPY.DECISIONS_THE_COORDINATOR}
            onClick={() => onOpenSession(coordinatorId)}>
            {LANDING_PAGE_COPY.OPEN_COORDINATOR_LINK}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/** The presses a landing's doors make, and the server's own sentence when one is refused. */
function useLandingPress(projectId: string, sessionId: string | null): {
  pressPath: (path: string, label: string, body?: Record<string, unknown>) => void;
  pending: boolean;
  refusal: string | null;
} {
  const qc = useQueryClient();
  const [refusal, setRefusal] = useState<string | null>(null);
  const press = useMutation({
    mutationFn: (press: { path: string; label: string; body?: Record<string, unknown> }) =>
      api(press.path, { method: 'POST', ...(press.body ? { body: press.body } : {}) })
        .then((answer) => ({ answer, label: press.label })),
    onSuccess: () => {
      setRefusal(null);
      void qc.invalidateQueries({ queryKey: ['project', projectId] });
      void qc.invalidateQueries({ queryKey: projectIntegrationQuery(projectId).queryKey });
      void qc.invalidateQueries({ queryKey: projectPromotionQuery(projectId).queryKey });
      void qc.invalidateQueries({ queryKey: projectMergedPromotionsQuery(projectId).queryKey });
      if (sessionId) void qc.invalidateQueries({ queryKey: sessionQuery(sessionId).queryKey });
    },
    onError: (error: Error, variables) => {
      // The server's own sentence, in the Landing card's `Retry failed — …` shape.
      setRefusal(`${variables.label} — ${error.message.replace(/[.\s]+$/, '')}.`);
    },
  });
  return {
    pressPath: (path, label, body) => press.mutate({ path, label, body }),
    pending: press.isPending,
    refusal,
  };
}

/**
 * What one landing's doors do (design §3, LS6): the ways to look at its work, which navigate, and the
 * owner doors, which press. The conditions they appear under are `landingGates` and
 * `landingMenuItemList`'s; nothing here opens a door they did not.
 */
function useLandingActions({
  projectId,
  landing,
  promotion,
  coordinatorId,
  onOpenSession,
  pressPath,
}: {
  projectId: string;
  landing: SessionLandingView | null;
  promotion: ProjectPromotionView | null;
  coordinatorId: string | null;
  onOpenSession: (sessionId: string) => void;
  pressPath: (path: string, label: string, body?: Record<string, unknown>) => void;
}): { run: (action: LandingMenuAction) => void; reviewOpen: boolean; closeReview: () => void } {
  const navigate = useNavigate();
  const [reviewOpen, setReviewOpen] = useState(false);
  const attempt = landing?.currentAttempt ?? null;
  const project = encodeURIComponent(projectId);
  const run = (action: LandingMenuAction): void => {
    switch (action) {
      case 'OPEN_TASK':
        if (landing?.taskId) navigate(projectTaskPath(projectId, landing.taskId));
        break;
      case 'OPEN_SOURCE_SESSION':
        if (attempt?.sourceSessionId) navigate(`/sessions/${encodeId(attempt.sourceSessionId)}`);
        break;
      case 'OPEN_COORDINATOR':
        if (coordinatorId) onOpenSession(coordinatorId);
        break;
      case 'REVIEW_CARD':
        if (promotion) setReviewOpen(true);
        break;
      case 'STOP':
        if (landing?.taskId && attempt) {
          pressPath(`/projects/${project}/tasks/${encodeURIComponent(landing.taskId)}/integration/stop`,
            LANDING_PAGE_COPY.STOP_FAILED);
        }
        break;
      case 'CANCEL':
        if (landing?.promotionId) {
          pressPath(`/projects/${project}/promotions/${encodeURIComponent(landing.promotionId)}/cancel`,
            LANDING_PAGE_COPY.CANCEL_FAILED);
        }
        break;
      case 'ABANDON':
        if (attempt) {
          pressPath(`/projects/${project}/integration/jobs/${encodeURIComponent(attempt.jobId)}/abandon`,
            LANDING_PAGE_COPY.ABANDON_FAILED);
        }
        break;
      case 'RETRY':
        if (attempt) {
          pressPath(`/projects/${project}/integration/jobs/${encodeURIComponent(attempt.jobId)}/retry`,
            LANDING_PAGE_COPY.RETRY_FAILED);
        }
        break;
      case 'RERUN_THE_CHECK':
        // The owner route requires a reason (RetryIntegrationDto.reason), and the sentence names this
        // window: the merge card's door records its own.
        if (landing?.promotionId) {
          pressPath(`/projects/${project}/promotions/${encodeURIComponent(landing.promotionId)}/integration/retry`,
            LANDING_PAGE_COPY.RERUN_FAILED, { reason: RERUN_LANDING_CHECK_REASON });
        }
        break;
    }
  };
  return { run, reviewOpen, closeReview: () => setReviewOpen(false) };
}

/** The menu a landing's ⋯ (or a right-click on it) opens: the old page's ⋯, row for row. */
function landingMenu(rows: readonly LandingMenuItem[], run: (action: LandingMenuAction) => void): MenuItem[] {
  const doors = new Set<LandingMenuAction>(['STOP', 'CANCEL', 'ABANDON', 'RETRY', 'RERUN_THE_CHECK']);
  const items: MenuItem[] = [];
  for (const row of rows) {
    // The ways to look at this work are one group, the doors another: a hairline between them, as
    // every menu on this console separates a destructive last row from the navigation above it.
    if (doors.has(row.action) && items.length > 0 && !items.some((item) => item.type === 'separator')) {
      items.push({ type: 'separator', key: 'doors' });
    }
    items.push({
      key: row.key,
      danger: row.danger,
      icon: menuIcon(row.action),
      label: row.sub ? menuLabel(row.label, row.sub) : row.label,
      onSelect: () => run(row.action),
    });
  }
  return items;
}

/** The merge round's own card, over the window: the live candidate while it is in hand, its receipt
 *  once it merged. */
function LandingReview({
  projectId,
  promotion,
  settled,
  onClose,
}: {
  projectId: string;
  promotion: ProjectPromotionView;
  settled: boolean;
  onClose: () => void;
}): JSX.Element {
  return (
    <Dialog open onClose={onClose} title={promotionHeading(promotion)} className="review-card-dialog" width={720}>
      <div className="review-card-content" data-review-open>
        {settled ? <ProjectPromotionReceipt promotion={promotion} /> : <ProjectPromotion projectId={projectId} bare />}
      </div>
    </Dialog>
  );
}

/** The ⋯ on a landing's card or row; a right-click anywhere on it opens the same menu. */
function LandingMore({
  items,
  open,
  onOpenChange,
}: {
  items: MenuItem[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): JSX.Element {
  return (
    <Menu
      side="bottom"
      align="end"
      open={open}
      onOpenChange={onOpenChange}
      trigger={(
        <button type="button" className="landings-window-more" aria-label="Landing actions" title="Landing actions">
          <MoreOutlined />
        </button>
      )}
      items={items}
    />
  );
}

/** `Open Task ›` and `Open Source Session ›`, under a task segment's open record (board 03 f). */
function LandingEntryLinks({ landing, run }: {
  landing: SessionLandingView;
  run: (action: LandingMenuAction) => void;
}): JSX.Element | null {
  if (landing.subject !== 'TASK') return null;
  const source = landing.currentAttempt?.sourceSessionId;
  if (!landing.taskId && !source) return null;
  return (
    <div className="landings-window-links">
      {landing.taskId ? (
        <button type="button" className="landing-page-link" onClick={() => run('OPEN_TASK')}>
          {`${LANDING_PAGE_COPY.OPEN_TASK} ›`}
        </button>
      ) : null}
      {source ? (
        <button type="button" className="landing-page-link" onClick={() => run('OPEN_SOURCE_SESSION')}>
          {`${LANDING_PAGE_COPY.OPEN_SOURCE_SESSION} ›`}
        </button>
      ) : null}
    </div>
  );
}

/** The receipt a merge row opens to (board 03 e): what is now on main, the check and the tree. */
function LandingReceiptBlock({ receipt }: { receipt: LandingMergeReceipt }): JSX.Element {
  return (
    <section className="landing-status-card is-settled landings-window-receipt">
      <div className="landing-card-heading">{receipt.heading}</div>
      {receipt.tasks.length > 0 ? (
        <ul className="landing-card-tasks">
          {receipt.tasks.map((title) => <li key={title}>{title}</li>)}
        </ul>
      ) : null}
      {receipt.checkLine ? <div className="landing-card-ok">{receipt.checkLine}</div> : null}
      {receipt.treeLine ? <div className="landing-card-line">{receipt.treeLine}</div> : null}
    </section>
  );
}

/**
 * One settled landing as a chat turn (owner 2026-11-11, docs/mocks/landings-chat-turns): its attempts on the chat's
 * steps lines, folded; one plain sentence that says how it ended — the reply; and the turn foot, its ⋯ and the moment it
 * settled. Pressing the sentence (or the newest steps line) opens the newest attempt's steps, with a merge's receipt first
 * and a task's two ways out under them. The record is read once — when the turn comes into view, or is opened, or its menu
 * is — and never again: a settled landing does not move, so it never polls.
 */
function LandingWindowRow({
  row,
  projectId,
  facts,
  expanded,
  outlined,
  onToggle,
  onOpenSession,
}: {
  row: LandingsWindowRow;
  projectId: string;
  facts: WindowFacts;
  expanded: boolean;
  outlined: boolean;
  onToggle: () => void;
  onOpenSession: (sessionId: string) => void;
}): JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false);
  const [log, setLog] = useState<LandingLogSelectors | null>(null);
  const [lineRef, seen] = useSeen<HTMLDivElement>();
  const session = useQuery({
    ...sessionQuery(row.sessionId),
    enabled: row.sessionId != null && (expanded || menuOpen || seen),
    staleTime: Number.POSITIVE_INFINITY,
  });
  const detail = session.data?.id === row.sessionId ? session.data : null;
  const landing = detail?.landing ?? null;
  const { pressPath, refusal } = useLandingPress(projectId, row.sessionId);
  const { run, reviewOpen, closeReview } = useLandingActions({
    projectId, landing, promotion: row.promotion, coordinatorId: facts.coordinatorId, onOpenSession, pressPath,
  });
  const menuRows: LandingMenuItem[] = landing
    ? landingMenuItemList(landing, NO_LANDING_GATES, {
      hasCoordinator: facts.coordinatorId != null,
      hasReview: row.promotion != null,
      nothingPushed: false,
    })
    : row.sessionId == null
      // A merge older than landing sessions has no view to read: its round's two ways in.
      ? [
        ...(facts.coordinatorId ? [{
          key: 'coordinator', action: 'OPEN_COORDINATOR' as const, label: LANDING_PAGE_COPY.OPEN_COORDINATOR,
          sub: null, danger: false,
        }] : []),
        ...(row.promotion ? [{
          key: 'review', action: 'REVIEW_CARD' as const, label: LANDING_PAGE_COPY.REVIEW_CARD, sub: null, danger: false,
        }] : []),
      ]
      : [];
  const items: MenuItem[] = menuRows.length > 0
    ? landingMenu(menuRows, run)
    : [{ key: 'loading', label: LANDING_PAGE_COPY.LOADING_LANDING, disabled: true }];
  const key = row.sessionId ?? row.key;
  const merge = row.tone === 'merge';
  // The reply: from the landing's own facts once its record is read (or the round's merged record); until then the row's
  // own words — how it ended, and the task.
  const sentence: SentencePart[] = merge
    ? landingSentence(sentenceFacts({ kind: 'MERGED', task: row.title, landing, promotion: row.promotion }))
    : landing
      ? landingSentence(sentenceFacts({ kind: settledSentenceKind(landing.settledAs), task: row.title, landing }))
      : [{ text: `${row.detail} ` }, { text: row.title, strong: true }, { text: '.' }];
  return (
    <div
      ref={lineRef}
      className={`landings-window-entry landings-window-turn${expanded ? ' is-open' : ''}${outlined ? ' is-outlined' : ''}`}
      data-landing-entry={key}
      data-tone={row.tone}
      onContextMenu={(event) => { event.preventDefault(); setMenuOpen(true); }}
    >
      {/* The sentence first, then the steps under it: the chat says what it is doing before its tool calls (owner 2026-11-11). */}
      <LandingReply parts={sentence} open={expanded} onToggle={onToggle} />
      {landing ? (
        <LandingSteps
          landing={landing}
          now={Date.now()}
          openLog={log}
          onOpenLog={setLog}
          sessionId={landing.sessionId}
          openLast={expanded}
          onToggleLast={onToggle}
        />
      ) : null}
      {expanded ? (
        <div className="landings-window-record">
          {merge ? <LandingReceiptBlock receipt={landingMergeReceipt(row.promotion, landing)} /> : null}
          {refusal ? <div className="landing-page-error" role="alert">{refusal}</div> : null}
          {row.sessionId == null ? null : landing ? (
            <LandingEntryLinks landing={landing} run={run} />
          ) : (
            <div className="landing-page-note">
              {session.isError ? LANDING_PAGE_COPY.UPDATE_UNAVAILABLE : LANDING_PAGE_COPY.LOADING_LANDING}
            </div>
          )}
        </div>
      ) : null}
      <LandingTurnFoot time={row.time} more={<LandingMore items={items} open={menuOpen} onOpenChange={setMenuOpen} />} />
      {reviewOpen && row.promotion ? (
        <LandingReview projectId={projectId} promotion={row.promotion} settled onClose={closeReview} />
      ) : null}
    </div>
  );
}

/** A landing's reply, as the chat draws an assistant's text: the sentence, the task in bold and the line and commit as code.
 *  Pressing it opens the landing's newest attempt, as its steps line does. */
function LandingReply({ parts, open, onToggle }: { parts: readonly SentencePart[]; open: boolean; onToggle: () => void }): JSX.Element {
  return (
    <div className="chat-msg chat-assistant landings-window-reply" role="button" tabIndex={0} aria-expanded={open}
      onClick={onToggle}
      onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onToggle(); } }}>
      <div className="md">
        <p>
          {parts.map((part, index) => part.strong ? <strong key={index}>{part.text}</strong>
            : part.code ? <code key={index}>{part.text}</code>
              : <span key={index}>{part.text}</span>)}
        </p>
      </div>
    </div>
  );
}

/** A landing turn's foot, as the chat's turn foot: its ⋯ (the landing's menu) and the time. */
function LandingTurnFoot({ time, more }: { time: string; more: ReactNode }): JSX.Element {
  return (
    <div className="chat-turn-divider chat-turn-foot landings-window-foot">
      {more}
      {time ? <span className="chat-time">{time}</span> : null}
    </div>
  );
}

/**
 * One landing still in hand, under `Now`: the old landing page's status card over its newest attempt
 * — V6's step clock, budget bar and liveness while it moves; what stopped it, and the doors to the
 * people who decide, while it waits — with the task's name under its head. It reads its own view on
 * §2.7a's cadence (RUNNING 4 s, QUEUED 15 s), the one part of the window that polls, and pressing its
 * head opens its record under it. Once its read says it settled, the window moves it into its day.
 */
function LandingWindowCard({
  card: entry,
  projectId,
  facts,
  expanded,
  outlined,
  onToggle,
  onOpenSession,
  onSettled,
}: {
  card: LandingsWindowCard;
  projectId: string;
  facts: WindowFacts;
  expanded: boolean;
  outlined: boolean;
  onToggle: () => void;
  onOpenSession: (sessionId: string) => void;
  onSettled: () => void;
}): JSX.Element {
  const sessionId = entry.sessionId;
  const session = useQuery({
    ...sessionQuery(sessionId),
    refetchInterval: (query) => {
      const view = (query.state.data as SessionDetail | undefined)?.landing;
      return view ? landingRefetchMs(view) : 15_000;
    },
  });
  const detail = session.data?.id === sessionId ? session.data : null;
  const landing = detail?.landing ?? null;
  const observation = {
    updatedAt: session.data ? session.dataUpdatedAt : undefined,
    failed: session.isError,
  };
  // The card's own second: its clocks move while it is on screen, and a read older than 90 s turns
  // them off (which needs a ticker to be noticed even when nothing is coming back).
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);
  const [menuOpen, setMenuOpen] = useState(false);
  const [log, setLog] = useState<LandingLogSelectors | null>(null);
  const settledAt = landing?.settledAt ?? null;
  useEffect(() => {
    if (settledAt) onSettled();
    // Once per settling: the window's lists are what move it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settledAt]);
  // The round's candidate: the one on offer while the round runs, its merged record once it settled.
  const merged = useQuery({
    ...projectMergedPromotionsQuery(projectId),
    enabled: landing?.subject === 'PROMOTION' && settledAt != null,
  });
  const currentPromotion = landing?.subject !== 'PROMOTION' ? null
    : settledAt
      ? (merged.data ?? []).find((candidate) => candidate.promotionId === landing.promotionId) ?? null
      : facts.promotion?.promotionId === landing.promotionId ? facts.promotion : null;
  const main = mainBranchName(facts.integration?.upstreamRef ?? currentPromotion?.upstreamRef);
  const attempt = landing?.currentAttempt ?? null;
  const liveJob = attempt && facts.integration
    ? (facts.integration.inFlightJobs ?? []).find((job) => job.jobId === attempt.jobId) ?? null
    : null;
  const gates: LandingGates = landing ? landingGates(landing, observation, now) : NO_LANDING_GATES;
  const { pressPath, pending, refusal } = useLandingPress(projectId, sessionId);
  const { run, reviewOpen, closeReview } = useLandingActions({
    projectId, landing, promotion: currentPromotion, coordinatorId: facts.coordinatorId, onOpenSession, pressPath,
  });

  const card = landing ? landingAttemptCard(landing, now, observation, {
    stepStartedAt: liveJob?.stepStartedAt ?? null,
    typicalMs: liveJob?.typicalMs ?? null,
    main,
  }) : null;
  const outcome = landing ? landingOutcomeCard(landing, currentPromotion) : null;
  const timedOut = card?.timedOut === true;
  const pushSentence = landing && timedOut && attempt ? landingPushSentence(landing, attempt) : null;
  const timeoutLine = landing && timedOut && attempt ? landingTimeoutLine(landing, attempt, main) : null;
  const menuRows = landing ? landingMenuItemList(landing, gates, {
    hasCoordinator: facts.coordinatorId != null,
    hasReview: currentPromotion != null,
    // J12: a check never pushes, and a v2 claim that recorded no PUSH proves none happened.
    nothingPushed: attempt?.kind === 'CHECK_PROMOTION'
      || pushSentence === LANDING_PAGE_COPY.NOTHING_PUSHED_SENTENCE,
  }) : [];
  const items: MenuItem[] = menuRows.length > 0
    ? landingMenu(menuRows, run)
    : [{ key: 'loading', label: LANDING_PAGE_COPY.LOADING_LANDING, disabled: true }];
  // A landing that waits for a decision carries the doors to the people who make it (board 02 d):
  // the coordinator, and the task (or the round's own card). A timed-out one has its own doors.
  const waiting = entry.state === 'AWAITING_DECISION' && !settledAt && !timedOut;
  const waitDoors = waiting && landing ? [
    ...(facts.coordinatorId ? ['OPEN_COORDINATOR' as const] : []),
    ...(landing.subject === 'TASK' && landing.taskId ? ['OPEN_TASK' as const] : []),
    ...(landing.subject === 'PROMOTION' && currentPromotion ? ['REVIEW_CARD' as const] : []),
  ] : [];
  const doorLabel = (action: LandingMenuAction): string => action === 'OPEN_COORDINATOR'
    ? LANDING_PAGE_COPY.OPEN_COORDINATOR
    : action === 'OPEN_TASK' ? LANDING_PAGE_COPY.OPEN_TASK : LANDING_PAGE_COPY.REVIEW_CARD;

  const running = card?.running === true && !settledAt;
  // A round's word (Merge check, Merge to main) says which of its jobs this is.
  const task = landing?.subject === 'PROMOTION' && card && !card.rightIsClock
    ? [card.word, entry.title].filter(Boolean).join(' · ') : entry.title;
  // The reply: how it ended once it settled; what stopped it while it waits; what it is doing while it runs or queues.
  const sentence: SentencePart[] = landingSentence(sentenceFacts({
    kind: outcome ? settledSentenceKind(settledAt ? landing?.settledAs : null)
      : running || !card ? 'RUNNING'
        : card.failure || card.stoppedOnFailure || timedOut || waiting ? 'NOT_LANDED' : 'RUNNING',
    task,
    landing,
    reason: card?.failure ?? null,
    nothingPushed: attempt != null && ['CHECK_FAILED', 'CONFLICT'].includes(attempt.state),
  }));
  const started = attempt?.startedAt ? Date.parse(attempt.startedAt) : Number.NaN;
  // A landing that runs keeps its steps open, as the chat keeps the turn in hand; any other opens with the press.
  const stepsOpen = expanded || running;
  const statusHead = outcome ? outcome.title
    : card ? [card.rightIsClock ? card.word : card.right, waiting ? SESSION_LANDINGS_COPY.WAITING : null].filter(Boolean).join(' · ')
      : session.isError ? LANDING_PAGE_COPY.UPDATE_UNAVAILABLE
        : landing ? LANDING_PAGE_COPY.QUEUED : LANDING_PAGE_COPY.LOADING_LANDING;
  const failedHead = !outcome && card != null && (card.stoppedOnFailure || timedOut);

  return (
    <div
      className={`landings-window-entry landings-window-turn is-card${stepsOpen ? ' is-open' : ''}${outlined ? ' is-outlined' : ''}`}
      data-landing-entry={sessionId}
      onContextMenu={(event) => { event.preventDefault(); setMenuOpen(true); }}
    >
      {/* A landing that runs is the chat's turn in hand: its Working for head over it. */}
      {running && Number.isFinite(started) ? (
        <div className="chat-turn-head">{`${WINDOW_COPY.WORKING_FOR} ${landingClock(Math.max(0, now - started))}`}</div>
      ) : null}
      <LandingReply parts={sentence} open={stepsOpen} onToggle={onToggle} />
      {running && card ? (
        <div className="landings-window-live">
          {card.detail ? <div className="landings-window-card-detail">{card.detail}</div> : null}
          {card.budget ? (
            <div className="landing-card-block">
              <div className="landing-card-budget"><span>{card.budget}</span></div>
              {card.progress != null ? (
                <div className="landing-card-meter" aria-hidden="true">
                  <i style={{ width: `${Math.round(card.progress * 100)}%` }} />
                  {card.usualProgress != null ? (
                    <b className="landing-card-meter-tick" style={{ left: `${Math.round(card.usualProgress * 100)}%` }} />
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}
          {card.live ? (
            <div className="landing-card-live">
              {card.fresh ? <span className="landing-live-dot" aria-hidden="true" /> : null}
              {card.live}
            </div>
          ) : null}
          {landing?.subject === 'PROMOTION' && !settledAt && attempt?.kind === 'CHECK_PROMOTION'
            && promotionOnPassLine(currentPromotion) ? (
            <div className="landing-card-on-pass">{promotionOnPassLine(currentPromotion)}</div>
          ) : null}
        </div>
      ) : null}
      {landing ? (
        <LandingSteps
          landing={landing}
          now={now}
          openLog={log}
          onOpenLog={setLog}
          sessionId={sessionId}
          openLast={stepsOpen}
          onToggleLast={onToggle}
        />
      ) : null}
      {/* What a landing in hand still carries — what stopped it, its clock, who decides and the doors — on the chat's own
          status card, under its steps. */}
      {running ? null : (
        <section
          className={`chat-status-card landings-window-card${failedHead ? ' is-failed' : ''}${timedOut ? ' is-timed-out' : ''}${settledAt ? ' is-settled' : ''}`}
          data-state={card?.state ?? outcome?.title ?? ''}
          role="status"
        >
          <div className="chat-status-head">
            <span className={`chat-status-icon landings-window-status-icon${failedHead ? ' is-failed' : ''}`} aria-hidden="true">
              {failedHead ? <CloseOutlined /> : outcome?.ok ? <CheckCircleFilled /> : <ClockCircleOutlined />}
            </span>
            <span className="landings-window-status-title">{statusHead}</span>
            {card?.rightIsClock ? <span className="landings-window-status-clock">{card.right}</span> : null}
          </div>
          <div className="landings-window-card-body">
            {outcome ? (
              <>
                {outcome.detail ? <div className="landing-card-line">{outcome.detail}</div> : null}
                {outcome.tasksHeading ? (
                  <div className="landing-card-block">
                    <div className="landing-card-heading">{outcome.tasksHeading}</div>
                    {outcome.tasks.length > 0 ? (
                      <ul className="landing-card-tasks">
                        {outcome.tasks.map((title) => <li key={title}>{title}</li>)}
                      </ul>
                    ) : null}
                  </div>
                ) : null}
                {outcome.checkLine ? <div className="landing-card-ok">{outcome.checkLine}</div> : null}
                {outcome.treeLine ? <div className="landing-card-line">{outcome.treeLine}</div> : null}
              </>
            ) : card ? (
              <>
                {card.detail ? <div className="landings-window-card-detail">{card.detail}</div> : null}
                {card.budget ? (
                  <div className="landing-card-block">
                    <div className="landing-card-budget"><span>{card.budget}</span></div>
                  </div>
                ) : null}
                {timeoutLine ? <div className="landing-card-line">{timeoutLine}</div> : null}
                {/* A timed-out check writes no push sentence at all (owner 2026-10-19): the line
                    above already says where the runner stopped. */}
                {pushSentence ? (
                  <div className="landing-card-line">
                    <b>{pushSentence.startsWith(LANDING_PAGE_COPY.NOTHING_WAS_PUSHED)
                      ? LANDING_PAGE_COPY.NOTHING_WAS_PUSHED
                      : LANDING_PAGE_COPY.MAY_HAVE_BEEN_PUSHED}</b>
                    {pushSentence.slice(pushSentence.indexOf(' —'))}
                  </div>
                ) : null}
                {/* The failure is the sentence's to say, above the card. */}
              </>
            ) : null}
            {card && timedOut ? (
              <div className="landing-card-actions">
                {gates.retry ? (
                  <Button variant="primary" loading={pending} onClick={() => run('RETRY')}>
                    {LANDING_PAGE_COPY.RETRY}
                  </Button>
                ) : null}
                {gates.recheck ? (
                  <Button variant="primary" loading={pending} onClick={() => run('RERUN_THE_CHECK')}>
                    {LANDING_PAGE_COPY.RERUN_THE_CHECK}
                  </Button>
                ) : null}
                {gates.abandon ? (
                  <Button danger loading={pending} onClick={() => run('ABANDON')}>
                    {LANDING_PAGE_COPY.ABANDON}
                  </Button>
                ) : null}
              </div>
            ) : null}
            {card?.timedOut && hintText(gates, pushSentence, attempt) ? (
              <div className="landing-card-hint">{hintText(gates, pushSentence, attempt)}</div>
            ) : null}
            {/* Who decides, and the doors to them, under what stopped it. */}
            {waitDoors.length > 0 ? (
              <div className="landings-window-wait">
                {facts.coordinatorId ? (
                  <div className="landings-window-wait-line">
                    <UserOutlined aria-hidden="true" />
                    <span>{LANDING_PAGE_COPY.DECISIONS_THE_COORDINATOR}</span>
                  </div>
                ) : null}
                <div className="landing-card-actions">
                  {waitDoors.map((action, index) => (
                    <Button key={action} variant={index === 0 ? 'primary' : undefined} onClick={() => run(action)}>
                      {doorLabel(action)}
                    </Button>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        </section>
      )}
      {refusal ? <div className="landing-page-error" role="alert">{refusal}</div> : null}
      {stepsOpen && landing ? <div className="landings-window-record"><LandingEntryLinks landing={landing} run={run} /></div> : null}
      <LandingTurnFoot time="" more={<LandingMore items={items} open={menuOpen} onOpenChange={setMenuOpen} />} />
      {reviewOpen && currentPromotion && landing ? (
        <LandingReview projectId={projectId} promotion={currentPromotion} settled={settledAt != null}
          onClose={closeReview} />
      ) : null}
    </div>
  );
}

/**
 * The one line under a timed-out card's doors, when the board has one to give: a check's Re-run
 * explains what it ends, a confirmed merge has no Retry to explain, and a task's Retry needs no
 * sentence when the push is already settled — only an older runner's may-have-been needs saying.
 */
function hintText(
  gates: LandingGates,
  pushSentence: string | null,
  attempt: SessionLandingView['currentAttempt'],
): string | null {
  if (gates.recheck) return `${LANDING_PAGE_COPY.RERUN_END} ${LANDING_PAGE_COPY.ABANDON_END}`;
  if (attempt?.kind === 'LAND_PROMOTION') return LANDING_PAGE_COPY.NO_RETRY_MERGE;
  if (gates.retry && pushSentence === LANDING_PAGE_COPY.MAY_HAVE_PUSHED_SENTENCE) {
    return LANDING_PAGE_COPY.LEGACY_PUSH_VARIANT;
  }
  return null;
}

/** The menu's own glyphs, as the board's web frame draws them. */
function menuIcon(action: LandingMenuAction): ReactNode {
  switch (action) {
    case 'OPEN_TASK': return <FileTextOutlined />;
    case 'OPEN_SOURCE_SESSION': return <MessageOutlined />;
    case 'OPEN_COORDINATOR': return <UserOutlined />;
    case 'REVIEW_CARD': return <SafetyCertificateOutlined />;
    case 'STOP':
    case 'CANCEL':
    case 'ABANDON': return <CloseOutlined />;
    case 'RETRY':
    case 'RERUN_THE_CHECK': return <ReloadOutlined />;
    default: return undefined;
  }
}

/** A menu row with its consequence under it — the shape the landing card's Retry error uses. */
function menuLabel(label: string, sub: string): ReactNode {
  return (
    <span className="landing-menu-row">
      <span>{label}</span>
      <span className="landing-menu-sub">{sub}</span>
    </span>
  );
}

/**
 * A landing's attempts as the session chat draws a turn's tool calls (owner 2026-11-11,
 * docs/mocks/landings-chat-turns): each attempt folds to the chat's steps line — `5 steps`, or
 * `Generation 2 · 5 steps` when there were several, with `· 1 failed` in red — that opens into its
 * steps (`landingSteps`), each one of the chat's tool rows. The newest attempt opens with the landing
 * ([openLast], pressed through [onToggleLast]); an older one opens on its own press. A step that
 * failed, or runs now, starts open.
 */
function LandingSteps({
  landing,
  sessionId,
  now,
  openLog,
  onOpenLog,
  openLast,
  onToggleLast,
}: {
  landing: SessionLandingView;
  sessionId: string;
  now: number;
  openLog: LandingLogSelectors | null;
  onOpenLog: (log: LandingLogSelectors | null) => void;
  openLast: boolean;
  onToggleLast: () => void;
}): JSX.Element | null {
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set());
  const timeline = landing.timeline;
  if (!timeline || (timeline.sections.length === 0 && timeline.facts.length === 0)) {
    return null;
  }
  const attempt = landing.currentAttempt;
  const currentJobId = attempt?.jobId ?? null;
  const noReport = landingNoReportBand(landing);
  // The current round's state is the sentence's and the status card's to say; the steps do not repeat it (05 c).
  const facts = timeline.facts.filter((fact) => fact.kind !== 'PROMOTION_STATE');
  const several = timeline.sections.length > 1;
  const lastIndex = timeline.sections.length - 1;
  return (
    <div className="landing-timeline landings-window-steps">
      {facts.map((fact, index) => (
        <div className="landing-timeline-fact" key={`fact-${fact.kind}-${index}`}>{fact.text}</div>
      ))}
      {timeline.sections.map((section, sectionIndex) => {
        const current = section.jobId === currentJobId;
        const steps = landingSteps(scopedLandingEntries(section.entries, landing, section.jobId), section.kind);
        const live = current && attempt?.state === 'RUNNING' && !attempt.timedOut;
        const statuses = steps.map((step, index): StepStatus => {
          const last = index === steps.length - 1;
          const failed = step.entries.some(({ entry, index: at }) =>
            entryGlyph(entry, section.kind, section.entries, at).tone === 'failed');
          return failed ? 'failed' : last && live ? 'running' : last && current && attempt?.state === 'QUEUED' ? 'pending' : 'ok';
        });
        const failedCount = statuses.filter((status) => status === 'failed').length;
        const isLast = sectionIndex === lastIndex;
        const open = isLast ? openLast : opened.has(section.jobId);
        const toggle = isLast ? onToggleLast : () => setOpened((was) => {
          const next = new Set(was);
          if (next.has(section.jobId)) next.delete(section.jobId); else next.add(section.jobId);
          return next;
        });
        return (
          <section
            key={section.jobId}
            className={`landing-timeline-section chat-steps${open ? ' is-open' : ''}${current ? ' is-current' : ''}`}
            data-job={section.jobId}
          >
            <button type="button" className="chat-steps-line landings-window-steps-line" aria-expanded={open} onClick={toggle}>
              {stepsLabel(steps, section, several)}
              {failedCount > 0 ? (
                <span className="chat-steps-failed">{` · ${failedCount} ${LANDING_SENTENCE_COPY.FAILED}`}</span>
              ) : null}
              <span className="chat-steps-caret">{open ? <DownOutlined /> : <RightOutlined />}</span>
            </button>
            {open ? (
              <div className="chat-steps-detail">
                {steps.map((step, index) => (
                  <LandingStepRow
                    key={step.key}
                    step={step}
                    status={statuses[index]}
                    kind={section.kind}
                    entries={section.entries}
                    jobId={section.jobId}
                    sessionId={sessionId}
                    openLog={openLog}
                    onOpenLog={onOpenLog}
                    // The check in hand, as the runner streams it (05 a, b), under the step it runs
                    // in — whichever step the timeline has reached when the stream starts.
                    live={statuses[index] === 'running' && attempt?.check
                      ? <LandingLiveCheck sessionId={sessionId} attempt={attempt} now={now} />
                      : null}
                  />
                ))}
                {/* A check streaming before its attempt wrote any line has no step to sit in. */}
                {steps.length === 0 && live && attempt?.check ? (
                  <LandingLiveCheck sessionId={sessionId} attempt={attempt} now={now} />
                ) : null}
                {/* The last word that never came, where the attempt stopped (05 e, f, i). */}
                {current && noReport ? (
                  <div className="landing-timeline-noreport">{noReport.text}</div>
                ) : null}
              </div>
            ) : null}
          </section>
        );
      })}
      {timeline.truncated ? (
        <div className="landing-timeline-fact">{LANDING_PAGE_COPY.OLDER_ATTEMPTS_HIDDEN}</div>
      ) : null}
    </div>
  );
}

type StepStatus = 'ok' | 'failed' | 'running' | 'pending';

const STEP_ICON: Record<string, ReactNode> = {
  queue: <UnorderedListOutlined />,
  claim: <DownloadOutlined />,
  sync: <BranchesOutlined />,
  'check:TASK_ACCEPTANCE': <CodeOutlined />,
  'check:MERGE_CHECK': <CodeOutlined />,
  'check:LANDING_CHECK': <CodeOutlined />,
  'check:BASELINE': <CodeOutlined />,
  push: <CloudUploadOutlined />,
};
const STEP_TONE: Record<string, string> = {
  queue: 'default', claim: 'read', sync: 'read', 'check:TASK_ACCEPTANCE': 'exec', 'check:MERGE_CHECK': 'exec', 'check:LANDING_CHECK': 'exec', 'check:BASELINE': 'exec', push: 'write',
};

/** One step as the chat's tool row: caret, icon, its name, its summary line and its mark — no time on the row, as the chat
 *  draws none; the lines it opens to carry theirs. */
function LandingStepRow({
  step,
  status,
  kind,
  entries,
  jobId,
  sessionId,
  openLog,
  onOpenLog,
  live,
}: {
  step: LandingStep;
  status: StepStatus;
  kind: IntegrationJobKind;
  entries: readonly IntegrationTimelineEntry[];
  jobId: string;
  sessionId: string;
  openLog: LandingLogSelectors | null;
  onOpenLog: (log: LandingLogSelectors | null) => void;
  live: ReactNode;
}): JSX.Element {
  const [manual, setManual] = useState<boolean | null>(null);
  const open = manual ?? (status === 'failed' || status === 'running');
  return (
    <div
      className={`chat-tool-card chat-tone-${STEP_TONE[step.key]}${open ? ' is-open' : ''} landing-step`}
      data-step={step.key}
    >
      <button type="button" className="chat-tool-row landing-step-row" aria-expanded={open}
        onClick={() => setManual(!open)}>
        <span className="chat-tool-caret">{open ? <DownOutlined /> : <RightOutlined />}</span>
        <span className="chat-tool-icon">{STEP_ICON[step.key]}</span>
        <span className="chat-tool-name">{step.name}</span>
        <span className="chat-tool-summary">{landingTimelineText(step.summary)}</span>
        {status === 'failed' ? <CloseCircleFilled className="chat-tool-status err" />
          : status === 'running' ? <LoadingOutlined className="chat-tool-status running" spin />
            : status === 'pending' ? <ClockCircleOutlined className="chat-tool-status pending" />
              : <CheckCircleFilled className="chat-tool-status ok" />}
      </button>
      {open ? (
        <div className="chat-tool-detail landing-step-detail">
          {step.entries.map(({ entry, index }) => (
            <TimelineLine
              key={entry.id ?? `${entry.kind}-${index}`}
              entry={entry}
              mark={entryGlyph(entry, kind, entries, index)}
              jobId={jobId}
              sessionId={sessionId}
              openLog={openLog}
              onOpenLog={onOpenLog}
            />
          ))}
          {live}
        </div>
      ) : null}
    </div>
  );
}

/** One of the server's lines, as it was: its time, its mark and its sentence; a finished check's
 *  `Log ›` and, when it failed, the tail it died on (05 g). */
function TimelineLine({
  entry,
  mark,
  jobId,
  sessionId,
  openLog,
  onOpenLog,
}: {
  entry: IntegrationTimelineEntry;
  mark: { glyph: string; tone: TimelineTone };
  jobId: string;
  sessionId: string;
  openLog: LandingLogSelectors | null;
  onOpenLog: (log: LandingLogSelectors | null) => void;
}): JSX.Element {
  const selectors = entry.kind === 'CHECK_FINISHED' && entry.check ? {
    jobId,
    claim: entry.claim,
    round: entry.round ?? undefined,
    check: entry.check.index,
  } : null;
  const logOpen = selectors != null && openLog != null && openLog.jobId === selectors.jobId
    && openLog.check === selectors.check && openLog.claim === selectors.claim && openLog.round === selectors.round;
  return (
    <div className="landing-timeline-entry">
      <span className="landing-timeline-time">{clockTime(entry.at)}</span>
      <span className={`landing-timeline-glyph is-${mark.tone}`} aria-hidden="true">{mark.glyph}</span>
      <span className="landing-timeline-body">
        <span className="landing-timeline-text">{landingTimelineText(entry)}</span>
        {entry.reason && !entry.text.includes(entry.reason)
          ? <span className="landing-timeline-sub">{entry.reason}</span>
          : null}
        {selectors ? (
          <button type="button" className="landing-timeline-log" onClick={() => onOpenLog(logOpen ? null : selectors)}>
            {`${LANDING_PAGE_COPY.LOG} ›`}
          </button>
        ) : null}
        {logOpen && selectors ? (
          <LandingCheckLog
            key={`${selectors.jobId}-${selectors.claim ?? 0}-${selectors.round ?? 0}-${selectors.check ?? 0}`}
            sessionId={sessionId}
            selectors={selectors}
          />
        ) : null}
        {selectors && !landingCheckPassed(entry) ? (
          <LandingInlineOutput
            key={`inline-${selectors.jobId}-${selectors.claim}-${selectors.round ?? 0}-${selectors.check}`}
            sessionId={sessionId}
            selectors={selectors}
          />
        ) : null}
      </span>
    </div>
  );
}

/** The window's own words, beyond the landing page's. CHECK and DETAILS are the native windows' (their settled line's chip and
 *  its way in), read from here by their parity tests until they draw turns too. */
const WINDOW_COPY = {
  CHECK: 'check',
  DETAILS: 'Details',
  WORKING_FOR: 'Working for',
} as const;

/**
 * Whether an element has come into view yet — once true it stays true. A settled line reads its
 * record when first seen, as the native windows do. Where there is no IntersectionObserver (a test
 * page) nothing is seen, and a record is read only when opened.
 */
function useSeen<T extends Element>(): [(node: T | null) => void, boolean] {
  const [seen, setSeen] = useState(false);
  const [node, setNode] = useState<T | null>(null);
  useEffect(() => {
    if (seen || !node || typeof IntersectionObserver === 'undefined') return undefined;
    const observer = new IntersectionObserver((records) => {
      if (records.some((record) => record.isIntersecting)) setSeen(true);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [node, seen]);
  return [setNode, seen];
}

/** What a timeline mark says, and the ink it says it in (mockups 05 a/e/i). */
type TimelineTone = 'queued' | 'running' | 'ok' | 'failed' | 'takeover';

function entryGlyph(
  entry: IntegrationTimelineEntry,
  kind: IntegrationJobKind,
  entries: readonly IntegrationTimelineEntry[],
  index: number,
): { glyph: string; tone: TimelineTone } {
  if (entry.data?.skipped === 'PATHS_EXEMPT') return { glyph: '≡', tone: 'queued' };
  switch (entry.kind) {
    case 'TAKEN_OVER':
      return { glyph: '↗', tone: 'takeover' };
    case 'CHECK_FINISHED':
    case 'RESULT':
    case 'RESULT_FALLBACK':
      return landingEntryOk(entry, kind) ? { glyph: '✓', tone: 'ok' } : { glyph: '✗', tone: 'failed' };
    case 'STOP_REQUESTED':
    case 'CANCELLED':
    case 'ABANDONED':
    case 'TIMED_OUT':
    case 'PUSH_REFUSED':
      return { glyph: '✗', tone: 'failed' };
    case 'ENQUEUED':
    case 'REQUEUED':
    case 'NEXT_GENERATION':
    case 'SKIPPED_CHECK':
    case 'FIX_TASK':
      return { glyph: '≡', tone: 'queued' };
    case 'RELEASED':
      return { glyph: '↩', tone: 'queued' };
    case 'STEP': {
      // A step line marks a step's START; once the attempt has moved on to another step, the one
      // before it is done — the board's green check on "Fetched · synced main" (05 i).
      const later = entries.slice(index + 1).some((next) =>
        next.kind === 'STEP' || next.kind === 'CHECK_STARTED' || next.kind === 'TAKEN_OVER'
        || next.kind === 'RESULT' || next.kind === 'CHECK_FINISHED'
        || next.kind === 'CANCELLED' || next.kind === 'TIMED_OUT');
      return later ? { glyph: '✓', tone: 'ok' } : { glyph: '↻', tone: 'running' };
    }
    case 'CLAIMED':
    case 'ROUND':
    case 'CHECK_STARTED':
    case 'RECHECK_ON_MOVED_MAIN':
    case 'RETRY':
    case 'HANDLING':
    case 'HANDED_TO':
    case 'AUTOMATIC_ATTEMPT':
    case 'CONFIRMATION':
      return { glyph: '↻', tone: 'running' };
    default:
      return { glyph: '≡', tone: 'queued' };
  }
}

/**
 * The check running now, inline (mockups 05 a, b, g, j): its name, how long it has been live, and
 * the tail of what it has printed. The output is the same landing-log read `Log ›` opens, polled
 * with the page while the check runs; nothing is composed from it but its last lines.
 */
function LandingLiveCheck({
  sessionId,
  attempt,
  now,
}: {
  sessionId: string;
  attempt: NonNullable<SessionLandingView['currentAttempt']>;
  now: number;
}): JSX.Element | null {
  const check = attempt.check;
  if (!check) return null;
  const page = useQuery({
    ...landingLogQuery(sessionId, {
      jobId: attempt.jobId,
      claim: attempt.claim,
      round: attempt.round ?? undefined,
      check: check.index,
    }),
    refetchInterval: 4_000,
  });
  const started = Date.parse(check.startedAt);
  const elapsed = Number.isFinite(started) ? landingClock(Math.max(0, now - started)) : '0m 0s';
  const lines = tailLines((page.data?.entries ?? []).map((entry) => entry.text).join(''));
  return (
    <div className="landing-timeline-live">
      <div className="landing-timeline-live-label">
        {`${landingCheckLabel(check.name)} · live ${elapsed}`}
      </div>
      {lines.length > 0 ? <pre className="landing-live-output">{lines.join('\n')}</pre> : null}
    </div>
  );
}

/** A finished check's last lines, inline: the failure's own words (05 g). */
function LandingInlineOutput({
  sessionId,
  selectors,
}: {
  sessionId: string;
  selectors: LandingLogSelectors;
}): JSX.Element | null {
  const page = useQuery(landingLogQuery(sessionId, selectors));
  const lines = tailLines((page.data?.entries ?? []).map((entry) => entry.text).join(''));
  if (lines.length === 0) return null;
  return <pre className="landing-live-output">{lines.join('\n')}</pre>;
}

/** The last few non-empty lines of a check's output, for the live block. */
function tailLines(text: string): string[] {
  return text
    .replace(/\r/g, '')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .slice(-6);
}

function clockTime(instant: string): string {
  const at = new Date(instant);
  if (Number.isNaN(at.getTime())) return '--:--';
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
}

/**
 * One check's output, read when its line is opened: the page of chunks the landing log answers,
 * continued by its cursor. Chunks arrive already redacted; a dropped middle is one line saying
 * how many bytes it took.
 */
function LandingCheckLog({
  sessionId,
  selectors,
}: {
  sessionId: string;
  selectors: LandingLogSelectors;
}): JSX.Element {
  const [cursor, setCursor] = useState<string | undefined>(selectors.cursor);
  const page = useQuery(landingLogQuery(sessionId, { ...selectors, cursor }));
  const data = page.data as ProjectIntegrationLogPage | undefined;
  if (page.isError) {
    return <div className="landing-log-error">{`${LANDING_PAGE_COPY.LOG_UNAVAILABLE} — ${page.error.message}`}</div>;
  }
  if (!data) {
    return <div className="landing-log"><span className="landing-log-loading">{LANDING_PAGE_COPY.LOADING_LOG}</span></div>;
  }
  return (
    <div className="landing-log">
      {data.entries.length === 0 ? (
        <span className="landing-log-empty">{LANDING_PAGE_COPY.LOG_EMPTY}</span>
      ) : (
        data.entries.map((entry, index) => (
          <span className="landing-log-chunk" key={`${entry.claim}-${entry.round}-${entry.check.index}-${entry.seq}-${index}`}>
            {entry.truncatedBytes > 0 ? (
              <span className="landing-log-omitted">{LANDING_PAGE_COPY.BYTES_OMITTED(entry.truncatedBytes)}</span>
            ) : null}
            {entry.text}
          </span>
        ))
      )}
      {data.nextCursor ? (
        <button type="button" className="landing-timeline-log" onClick={() => setCursor(data.nextCursor ?? undefined)}>
          {LANDING_PAGE_COPY.SHOW_MORE}
        </button>
      ) : null}
    </div>
  );
}
