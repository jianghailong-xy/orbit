import { useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeftOutlined,
  CloseOutlined,
  FileTextOutlined,
  MoreOutlined,
  MessageOutlined,
  ProjectOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  UpOutlined,
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
  landingEntryOk,
  landingGates,
  landingHeaderTitle,
  landingMenuItemList,
  landingMergeReceipt,
  landingNoReportBand,
  landingOutcomeCard,
  landingPushSentence,
  landingRefetchMs,
  landingSectionState,
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
import { encodeId } from '../lib/idCodec';
import { projectTaskPath } from '../lib/projectTaskRoute';
import { RERUN_LANDING_CHECK_REASON, promotionOnPassLine } from '../lib/projectMerge';
import { mainBranchName } from '../lib/projectStart';
import { LandingHead, landingClock } from './ProjectPanoramaHeader';
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
 * The window is the old landing session page's shell — `Landings`, `Run by Orbit · <project>`, a ⋯
 * with the coordinator and the project, the read-only footer and no composer (LS6) — and each landing
 * in it carries what that page drew: a card still in hand is its status card, polled on §2.7a's
 * cadence; a settled row opens in place to its timeline, read once and never polled. The doors the
 * page's ⋯ held are each landing's own: its ⋯, or a right-click on it.
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
    ...projectSessionsQuery({ projectId, view: 'open', includeLanding: true }),
    refetchInterval: 15_000,
  });
  const completedQ = useQuery({
    ...projectSessionsQuery({ projectId, view: 'completed', includeLanding: true }),
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
  const [runs, typeHere] = SESSION_LANDINGS_COPY.ORBIT_RUNS_THESE_LANDINGS.split(' — ');

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
            {projectTitle ? `${LANDING_PAGE_COPY.RUN_BY_ORBIT} · ${projectTitle}` : LANDING_PAGE_COPY.RUN_BY_ORBIT}
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
        {landings.days.map((day) => (
          <section key={day.title} className="landings-window-day" aria-label={day.title}>
            <div className="landings-window-day-head">{day.title}</div>
            {day.rows.map((row) => (
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
          </section>
        ))}
        {cards.length > 0 ? (
          <section className="landings-window-day landings-window-now" aria-label={SESSION_LANDINGS_COPY.NOW}>
            <div className="landings-window-day-head">{SESSION_LANDINGS_COPY.NOW}</div>
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
          </section>
        ) : null}
        </div>
      </div>

      <div className="landing-page-foot">
        {/* What this window is, who decides, and the way to them: nothing to type here (LS6). */}
        <div className="landing-page-foot-line">
          <span>{`${runs} — `}</span><b>{typeHere}</b>
        </div>
        <div className="landing-page-foot-line">
          <span>{LANDING_PAGE_COPY.DECISIONS_THE_COORDINATOR}</span>
          {coordinatorId ? (
            <>
              <span> · </span>
              <button type="button" className="landing-page-link" onClick={() => onOpenSession(coordinatorId)}>
                {`${LANDING_PAGE_COPY.OPEN_COORDINATOR_LINK} ›`}
              </button>
            </>
          ) : null}
        </div>
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
 * One settled landing: a row with the merged line's head — the mark that says how it ended, the
 * task's name, the moment it settled and one line under them — that opens in place to its record. A
 * merge into main opens to its receipt first. The record is read when the row is opened (or its menu
 * is), once: a settled landing does not move, so its row never polls.
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
  const session = useQuery({
    ...sessionQuery(row.sessionId),
    enabled: row.sessionId != null && (expanded || menuOpen),
    staleTime: Number.POSITIVE_INFINITY,
  });
  const detail = session.data?.id === row.sessionId ? session.data : null;
  const landing = detail?.landing ?? null;
  const { pressPath, refusal } = useLandingPress(projectId, row.sessionId);
  const { run, reviewOpen, closeReview } = useLandingActions({
    projectId, landing, promotion: row.promotion, coordinatorId: facts.coordinatorId, onOpenSession, pressPath,
  });
  const main = mainBranchName(row.promotion?.upstreamRef ?? facts.integration?.upstreamRef);
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
  const mark = row.tone === 'ok' ? '✓' : row.tone === 'merge' ? '⇢' : '◌';
  const key = row.sessionId ?? row.key;
  return (
    <div
      className={`landings-window-entry${expanded ? ' is-open' : ''}${outlined ? ' is-outlined' : ''}`}
      data-landing-entry={key}
      onContextMenu={(event) => { event.preventDefault(); setMenuOpen(true); }}
    >
      <div className="landings-window-row-line">
        <button type="button" className="session-row session-project-merge-row session-project-landing-row landings-window-row"
          aria-expanded={expanded} onClick={onToggle}>
          <span className={`session-project-landing-mark is-${row.tone}`} aria-hidden="true">{mark}</span>
          <span className="session-project-merge-row-body">
            <span className="session-project-merge-row-head">
              <span className="session-project-merge-row-title">{row.title}</span>
              {row.time ? <span className="session-time">{row.time}</span> : null}
              {expanded ? <UpOutlined className="landings-window-up" aria-hidden /> : null}
            </span>
            <span className="session-project-merge-row-detail">{row.detail}</span>
          </span>
        </button>
        <LandingMore items={items} open={menuOpen} onOpenChange={setMenuOpen} />
      </div>
      {expanded ? (
        <div className="landings-window-record">
          {row.tone === 'merge' ? <LandingReceiptBlock receipt={landingMergeReceipt(row.promotion, landing)} /> : null}
          {refusal ? <div className="landing-page-error" role="alert">{refusal}</div> : null}
          {row.sessionId == null ? null : landing ? (
            <>
              <LandingTimeline
                landing={landing}
                main={main}
                now={Date.now()}
                openLog={log}
                onOpenLog={setLog}
                sessionId={row.sessionId}
              />
              <LandingEntryLinks landing={landing} run={run} />
            </>
          ) : (
            <div className="landing-page-note">
              {session.isError ? LANDING_PAGE_COPY.UPDATE_UNAVAILABLE : LANDING_PAGE_COPY.LOADING_LANDING}
            </div>
          )}
        </div>
      ) : null}
      {reviewOpen && row.promotion ? (
        <LandingReview projectId={projectId} promotion={row.promotion} settled onClose={closeReview} />
      ) : null}
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

  return (
    <div
      className={`landings-window-entry is-card${expanded ? ' is-open' : ''}${outlined ? ' is-outlined' : ''}`}
      data-landing-entry={sessionId}
      onContextMenu={(event) => { event.preventDefault(); setMenuOpen(true); }}
    >
      <section
        className={`landing-status-card landings-window-card${timedOut ? ' is-timed-out' : ''}${settledAt ? ' is-settled' : ''}`}
        data-state={card?.state ?? outcome?.title ?? ''}
      >
        <div className="landings-window-card-top">
          <button type="button" className="landings-window-card-press" aria-expanded={expanded} onClick={onToggle}>
            {outcome ? (
              <LandingHead
                title={outcome.title}
                head={{ right: outcome.right, isClock: false, detail: outcome.detail ?? '' }}
                running={false}
                timedOut={false}
                done={outcome.ok}
              />
            ) : card ? (
              <LandingHead
                title={card.word}
                head={{ right: card.right, isClock: card.rightIsClock, detail: card.detail }}
                running={card.running}
                timedOut={card.timedOut}
                failed={card.stoppedOnFailure}
              />
            ) : (
              <span className="landing-page-note">
                {session.isError ? LANDING_PAGE_COPY.UPDATE_UNAVAILABLE
                  : landing ? LANDING_PAGE_COPY.QUEUED : LANDING_PAGE_COPY.LOADING_LANDING}
              </span>
            )}
            {entry.title ? <span className="landings-window-card-task">{entry.title}</span> : null}
          </button>
          <LandingMore items={items} open={menuOpen} onOpenChange={setMenuOpen} />
        </div>
        {outcome ? (
          <>
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
            {card.budget ? (
              <div className="landing-card-block">
                <div className="landing-card-budget">
                  <span>{card.budget}</span>
                </div>
                {card.progress != null ? (
                  <div className="landing-card-meter" aria-hidden="true">
                    <i style={{ width: `${Math.round(card.progress * 100)}%` }} />
                    {card.usualProgress != null ? (
                      <b className="landing-card-meter-tick"
                        style={{ left: `${Math.round(card.usualProgress * 100)}%` }} />
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
            {landing?.subject === 'PROMOTION' && !settledAt && card.running
              && attempt?.kind === 'CHECK_PROMOTION' && promotionOnPassLine(currentPromotion) ? (
              <div className="landing-card-on-pass">{promotionOnPassLine(currentPromotion)}</div>
            ) : null}
            {card.failure ? <div className="landing-card-line">{card.failure}</div> : null}
            {timedOut ? (
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
            {card.timedOut && hintText(gates, pushSentence, attempt) ? (
              <div className="landing-card-hint">{hintText(gates, pushSentence, attempt)}</div>
            ) : null}
          </>
        ) : null}
        {waitDoors.length > 0 ? (
          <div className="landing-card-actions">
            {waitDoors.map((action, index) => (
              <Button key={action} variant={index === 0 ? 'primary' : undefined} onClick={() => run(action)}>
                {doorLabel(action)}
              </Button>
            ))}
          </div>
        ) : null}
      </section>
      {refusal ? <div className="landing-page-error" role="alert">{refusal}</div> : null}
      {expanded && landing ? (
        <div className="landings-window-record">
          <LandingTimeline
            landing={landing}
            main={main}
            now={now}
            openLog={log}
            onOpenLog={setLog}
            sessionId={sessionId}
          />
          <LandingEntryLinks landing={landing} run={run} />
        </div>
      ) : null}
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
 * The server's timeline, laid out: one section per attempt (a task segment's generation, or a
 * merge round's check and merge), each section's facts in the ledger's own order. The words are
 * the server's `text` — this draws them and never composes one — and the check a finished line
 * names opens its output.
 */
function LandingTimeline({
  landing,
  main,
  sessionId,
  now,
  openLog,
  onOpenLog,
}: {
  landing: SessionLandingView;
  main: string;
  sessionId: string;
  now: number;
  openLog: LandingLogSelectors | null;
  onOpenLog: (log: LandingLogSelectors | null) => void;
}): JSX.Element | null {
  const timeline = landing.timeline;
  if (!timeline || (timeline.sections.length === 0 && timeline.facts.length === 0)) {
    return null;
  }
  const attempt = landing.currentAttempt;
  const currentJobId = attempt?.jobId ?? null;
  const noReport = landingNoReportBand(landing);
  // The current round's state is the status card's to say; the board's timeline does not repeat it
  // as a fact above the sections (05 c).
  const facts = timeline.facts.filter((fact) => fact.kind !== 'PROMOTION_STATE');
  return (
    <div className="landing-timeline">
      {facts.map((fact, index) => (
        <div className="landing-timeline-fact" key={`fact-${fact.kind}-${index}`}>{fact.text}</div>
      ))}
      {timeline.sections.map((section) => {
        const current = section.jobId === currentJobId;
        return (
          <section
            key={section.jobId}
            className={`landing-timeline-section${current ? ' is-current' : ''}`}
            data-job={section.jobId}
          >
            <div className="landing-timeline-heading">
              <span>{section.title}</span>
              {landingSectionState(section.state) ? (
                <span className="landing-timeline-state">{landingSectionState(section.state)}</span>
              ) : null}
            </div>
            {section.entries.map((entry, index) => {
              const mark = entryGlyph(entry, section.kind, section.entries, index);
              return (
                <div className="landing-timeline-entry" key={entry.id ?? `${entry.kind}-${index}`}>
                  <span className="landing-timeline-time">{clockTime(entry.at)}</span>
                  <span className={`landing-timeline-glyph is-${mark.tone}`} aria-hidden="true">
                    {mark.glyph}
                  </span>
                  <span className="landing-timeline-body">
                    <span className="landing-timeline-text">{entry.text}</span>
                    {entry.reason && !entry.text.includes(entry.reason)
                      ? <span className="landing-timeline-sub">{entry.reason}</span>
                      : null}
                    {entry.kind === 'CHECK_FINISHED' && entry.check && section.jobId ? (
                      <button
                        type="button"
                        className="landing-timeline-log"
                        onClick={() => onOpenLog(openLog?.jobId === section.jobId
                          && openLog.claim === entry.claim
                          && openLog.round === (entry.round ?? undefined)
                          && openLog.check === entry.check!.index
                          ? null
                          : {
                            jobId: section.jobId,
                            claim: entry.claim,
                            round: entry.round ?? undefined,
                            check: entry.check!.index,
                          })}
                      >
                        {`${LANDING_PAGE_COPY.LOG} ›`}
                      </button>
                    ) : null}
                    {openLog && openLog.jobId === section.jobId
                      && entry.kind === 'CHECK_FINISHED' && entry.check
                      && openLog.check === entry.check.index
                      && openLog.claim === entry.claim
                      && openLog.round === (entry.round ?? undefined) ? (
                        <LandingCheckLog
                          key={`${openLog.jobId}-${openLog.claim ?? 0}-${openLog.round ?? 0}-${openLog.check ?? 0}`}
                          sessionId={sessionId}
                          selectors={openLog}
                        />
                      ) : null}
                    {/* A check that failed shows the tail it died on, inline (05 g); a passed one
                        keeps its Log › and stays one line. */}
                    {entry.kind === 'CHECK_FINISHED' && entry.check && section.jobId
                      && !landingCheckPassed(entry) ? (
                        <LandingInlineOutput
                          key={`inline-${section.jobId}-${entry.claim}-${entry.round ?? 0}-${entry.check.index}`}
                          sessionId={sessionId}
                          selectors={{
                            jobId: section.jobId,
                            claim: entry.claim,
                            round: entry.round ?? undefined,
                            check: entry.check.index,
                          }}
                        />
                      ) : null}
                  </span>
                </div>
              );
            })}
            {/* The check in hand, as the runner streams it: the live row and its tail (05 a, b). */}
            {current && attempt?.state === 'RUNNING' && !attempt.timedOut && attempt.check ? (
              <LandingLiveCheck sessionId={sessionId} attempt={attempt} now={now} />
            ) : null}
            {/* The last word that never came, where the attempt stopped (05 e, f, i). */}
            {current && noReport ? (
              <div className="landing-timeline-noreport">{noReport.text}</div>
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

/** What a timeline mark says, and the ink it says it in (mockups 05 a/e/i). */
type TimelineTone = 'queued' | 'running' | 'ok' | 'failed' | 'takeover';

function entryGlyph(
  entry: IntegrationTimelineEntry,
  kind: IntegrationJobKind,
  entries: readonly IntegrationTimelineEntry[],
  index: number,
): { glyph: string; tone: TimelineTone } {
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
