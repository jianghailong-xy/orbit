import { useEffect, useState, type JSX, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import {
  CloseOutlined,
  FileTextOutlined,
  MoreOutlined,
  MessageOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  UserOutlined,
} from '@ant-design/icons';
import type {
  IntegrationTimelineEntry,
  ProjectIntegrationLogPage,
  SessionLandingView,
} from '@orbit/shared';
import { api, type SessionDetail } from '../api';
import {
  LANDING_PAGE_COPY,
  landingAttemptCard,
  landingCheckLabel,
  landingFooter,
  landingGates,
  landingHeaderSub,
  landingHeaderTitle,
  landingMenuItemList,
  landingNoReportBand,
  landingOutcomeCard,
  landingPushSentence,
  landingRefetchMs,
  landingSectionState,
  landingTimeoutLine,
  type LandingGates,
  type LandingMenuAction,
} from '../lib/landingSession';
import {
  landingLogQuery,
  projectMergedPromotionsQuery,
  projectCoordinatorStatusQuery,
  projectIntegrationQuery,
  projectPromotionQuery,
  sessionQuery,
  type LandingLogSelectors,
} from '../lib/queries';
import { encodeId } from '../lib/idCodec';
import { projectTaskPath } from '../lib/projectTaskRoute';
import { promotionOnPassLine } from '../lib/projectMerge';
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

/**
 * The landing session page (contract §2.9 LS1/LS6/LS7; design §3; mockups v4
 * `docs/mocks/landing-session/v4/05-landing-session-page`): a session the platform drives, drawn
 * as its own reader — the status card over the newest attempt, the server's timeline, the check
 * output a line opens, and the owner doors the landing view's facts allow.
 *
 * It is a reading surface, not a conversation: no composer, no engine, no model, no rename, fork,
 * share or merge bar (LS6). The one way out that matters — the coordinator, or the merge card
 * that decides a round — is named in the footer.
 *
 * `detail` is what `GET /sessions/:id` already answered in the shell. The view reads the same
 * session on its own cadence (§2.7a: RUNNING 4 s, QUEUED 15 s, nothing once settled), because the
 * shell's poll is a conversation's and a landing's phases move at their own speed.
 */
export function LandingSessionView({
  sessionId,
  detail,
  onOpenCoordinator,
}: {
  sessionId: string;
  detail: SessionDetail;
  /** Opens the project's coordinator conversation in the shell (it owns the pane transition). */
  onOpenCoordinator: (sessionId: string) => void;
}): JSX.Element {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const session = useQuery({
    ...sessionQuery(sessionId),
    refetchInterval: (query) =>
      landingRefetchMs((query.state.data as SessionDetail | undefined)?.landing ?? detail.landing),
  });
  const row = session.data ?? detail;
  const landing = row.landing ?? null;
  const observation = {
    updatedAt: session.data ? session.dataUpdatedAt : undefined,
    failed: session.isError,
  };
  // The page's own second: the clocks move while it is open, and a read older than 90 s turns
  // them off (which needs a ticker to be noticed even when nothing is coming back).
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [log, setLog] = useState<LandingLogSelectors | null>(null);

  const projectId = landing?.projectId ?? null;
  // The project's line answers the V6 facts (the step's start, the usual duration), and it is
  // read only while the landing is open: a settled page draws from its own outcome and must stop
  // polling (§2.7a), not move the sweep to another read.
  const integration = useQuery({
    ...projectIntegrationQuery(projectId ?? ''),
    enabled: projectId != null && !landing?.settledAt,
  });
  const coordinator = useQuery({
    ...projectCoordinatorStatusQuery(projectId ?? ''),
    enabled: projectId != null && !landing?.settledAt,
  });
  const promotion = useQuery({
    ...projectPromotionQuery(projectId ?? ''),
    enabled: projectId != null && landing?.subject === 'PROMOTION' && !landing?.settledAt,
    refetchInterval: landing && !landing.settledAt ? landingRefetchMs(landing) : false,
  });
  const merged = useQuery({
    ...projectMergedPromotionsQuery(projectId ?? ''),
    enabled: projectId != null && landing?.subject === 'PROMOTION' && landing?.settledAt != null,
  });
  const settledPromotion = landing?.settledAt && merged.data
    ? merged.data.find((candidate) => candidate.promotionId === landing.promotionId) ?? null
    : null;
  const currentPromotion = landing?.settledAt ? settledPromotion : (promotion.data ?? null);
  const main = mainBranchName(integration.data?.upstreamRef ?? currentPromotion?.upstreamRef);
  const attempt = landing?.currentAttempt ?? null;
  const liveJob = attempt && integration.data
    ? (integration.data.inFlightJobs ?? []).find((job) => job.jobId === attempt.jobId) ?? null
    : null;
  const gates: LandingGates = landing
    ? landingGates(landing, observation, now)
    : { stop: false, cancel: false, abandon: false, retry: false, recheck: false };
  const coordinatorId = coordinator.data?.coordination.sessionId ?? null;
  // The pre-generated id answers before the session row exists (LS1), and that payload has no
  // title: a task segment's own title is the task's, read once for the header.
  const taskTitleId = landing?.subject === 'TASK' && !row.title && landing.taskId ? landing.taskId : null;
  const taskTitle = useQuery({
    queryKey: ['task-title', taskTitleId ?? ''] as const,
    queryFn: () => api<{ title?: string }>(`/tasks/${encodeURIComponent(taskTitleId!)}`),
    enabled: taskTitleId != null,
    staleTime: 60_000,
  });

  const press = useMutation({
    mutationFn: (press: { path: string; label: string }) =>
      api(press.path, { method: 'POST' }).then((answer) => ({ answer, label: press.label })),
    onSuccess: () => {
      setRefusal(null);
      if (projectId) {
        void qc.invalidateQueries({ queryKey: ['project', projectId] });
        void qc.invalidateQueries({ queryKey: projectIntegrationQuery(projectId).queryKey });
        void qc.invalidateQueries({ queryKey: projectPromotionQuery(projectId).queryKey });
        void qc.invalidateQueries({ queryKey: projectMergedPromotionsQuery(projectId).queryKey });
      }
      void qc.invalidateQueries({ queryKey: sessionQuery(sessionId).queryKey });
    },
    onError: (error: Error, variables) => {
      // The server's own sentence, in the Landing card's `Retry failed — …` shape.
      setRefusal(`${variables.label} — ${error.message.replace(/[.\s]+$/, '')}.`);
    },
  });
  const pressPath = (path: string, label: string): void => press.mutate({ path, label });

  if (!landing) {
    return (
      <div className="landing-page">
        <div className="landing-page-head">
          <div className="landing-page-title">{row.title ?? LANDING_PAGE_COPY.CHIP}</div>
          <div className="landing-page-sub">{landingHeaderSub(null)}</div>
        </div>
        <div className="landing-page-body">
          <div className="landing-status-card is-unavailable">
            <div className="landing-page-note">
              {session.isError ? LANDING_PAGE_COPY.UPDATE_UNAVAILABLE : LANDING_PAGE_COPY.LOADING_LANDING}
            </div>
          </div>
        </div>
      </div>
    );
  }

  const card = landingAttemptCard(landing, now, observation, {
    stepStartedAt: liveJob?.stepStartedAt ?? null,
    typicalMs: liveJob?.typicalMs ?? null,
    main,
  });
  const outcome = landingOutcomeCard(landing, currentPromotion);
  const footer = landingFooter(landing, currentPromotion?.onPass ?? null);
  const timedOut = card?.timedOut === true;
  const pushSentence = timedOut && attempt ? landingPushSentence(landing, attempt) : null;
  const timeoutLine = timedOut && attempt ? landingTimeoutLine(landing, attempt, main) : null;

  const stop = (): void => {
    if (!projectId || !landing.taskId || !attempt) return;
    pressPath(
      `/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(landing.taskId)}/integration/stop`,
      LANDING_PAGE_COPY.STOP_FAILED,
    );
  };
  const cancelMerge = (): void => {
    if (!projectId || !landing.promotionId) return;
    pressPath(
      `/projects/${encodeURIComponent(projectId)}/promotions/${encodeURIComponent(landing.promotionId)}/cancel`,
      LANDING_PAGE_COPY.CANCEL_FAILED,
    );
  };
  const abandon = (): void => {
    if (!projectId || !attempt) return;
    pressPath(
      `/projects/${encodeURIComponent(projectId)}/integration/jobs/${encodeURIComponent(attempt.jobId)}/abandon`,
      LANDING_PAGE_COPY.ABANDON_FAILED,
    );
  };
  const retry = (): void => {
    if (!projectId || !attempt) return;
    pressPath(
      `/projects/${encodeURIComponent(projectId)}/integration/jobs/${encodeURIComponent(attempt.jobId)}/retry`,
      LANDING_PAGE_COPY.RETRY_FAILED,
    );
  };
  const recheck = (): void => {
    if (!projectId || !landing.promotionId) return;
    pressPath(
      `/projects/${encodeURIComponent(projectId)}/promotions/${encodeURIComponent(landing.promotionId)}/integration/retry`,
      LANDING_PAGE_COPY.RERUN_FAILED,
    );
  };

  const menuRows = landingMenuItemList(landing, gates, {
    hasCoordinator: coordinatorId != null,
    hasReview: currentPromotion != null,
    // J12: a check never pushes, and a v2 claim that recorded no PUSH proves none happened.
    nothingPushed: attempt?.kind === 'CHECK_PROMOTION'
      || pushSentence === LANDING_PAGE_COPY.NOTHING_PUSHED_SENTENCE,
  });
  const run = (action: LandingMenuAction): void => {
    switch (action) {
      case 'OPEN_TASK':
        if (landing.taskId && projectId) navigate(projectTaskPath(projectId, landing.taskId));
        break;
      case 'OPEN_SOURCE_SESSION':
        if (attempt?.sourceSessionId) navigate(`/sessions/${encodeId(attempt.sourceSessionId)}`);
        break;
      case 'OPEN_COORDINATOR':
        if (coordinatorId) onOpenCoordinator(coordinatorId);
        break;
      case 'REVIEW_CARD':
        setReviewOpen(true);
        break;
      case 'STOP':
        stop();
        break;
      case 'CANCEL':
        cancelMerge();
        break;
      case 'ABANDON':
        abandon();
        break;
      case 'RETRY':
        retry();
        break;
      case 'RERUN_THE_CHECK':
        recheck();
        break;
    }
  };
  const doors = new Set<LandingMenuAction>(['STOP', 'CANCEL', 'ABANDON', 'RETRY', 'RERUN_THE_CHECK']);
  const items: MenuItem[] = [];
  for (const row of menuRows) {
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

  return (
    <div className="landing-page">
      <div className="landing-page-head">
        <div className="landing-page-title-line">
          <span className="landing-page-title">
            {landingHeaderTitle(landing, row.title, taskTitle.data?.title ?? null)}
          </span>
          <span className="landing-page-chip">
            <span className="landing-page-chip-glyph" aria-hidden="true">↻</span>
            {LANDING_PAGE_COPY.CHIP}
          </span>
          {items.length > 0 ? (
            <Menu
              side="bottom"
              align="end"
              trigger={(
                <button type="button" className="landing-page-more" aria-label="More actions" title="More actions">
                  <MoreOutlined />
                </button>
              )}
              items={items}
            />
          ) : null}
        </div>
        <div className="landing-page-sub">{landingHeaderSub(landing)}</div>
      </div>

      <div className="landing-page-body">
        <section
          className={`landing-status-card${timedOut ? ' is-timed-out' : ''}${landing.settledAt ? ' is-settled' : ''}`}
          data-state={card?.state ?? outcome?.title ?? ''}
        >
          {outcome ? (
            <>
              <LandingHead
                title={outcome.title}
                head={{ right: outcome.right, isClock: false, detail: outcome.detail ?? '' }}
                running={false}
                timedOut={false}
                done={outcome.ok}
              />
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
              <LandingHead
                title={card.word}
                head={{ right: card.right, isClock: card.rightIsClock, detail: card.detail }}
                running={card.running}
                timedOut={card.timedOut}
              />
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
              {landing.subject === 'PROMOTION' && !landing.settledAt && card.running
                && attempt?.kind === 'CHECK_PROMOTION' && promotionOnPassLine(currentPromotion) ? (
                <div className="landing-card-on-pass">{promotionOnPassLine(currentPromotion)}</div>
              ) : null}
              {card.failure ? <div className="landing-card-line">{card.failure}</div> : null}
              {timedOut ? (
                <div className="landing-card-actions">
                  {gates.retry ? (
                    <Button variant="primary" loading={press.isPending} onClick={retry}>
                      {LANDING_PAGE_COPY.RETRY}
                    </Button>
                  ) : null}
                  {gates.recheck ? (
                    <Button variant="primary" loading={press.isPending} onClick={recheck}>
                      {LANDING_PAGE_COPY.RERUN_THE_CHECK}
                    </Button>
                  ) : null}
                  {gates.abandon ? (
                    <Button danger loading={press.isPending} onClick={abandon}>
                      {LANDING_PAGE_COPY.ABANDON}
                    </Button>
                  ) : null}
                </div>
              ) : null}
              {card.timedOut && hintText(gates, pushSentence, attempt) ? (
                <div className="landing-card-hint">{hintText(gates, pushSentence, attempt)}</div>
              ) : null}
            </>
          ) : (
            <div className="landing-page-note">{LANDING_PAGE_COPY.QUEUED}</div>
          )}
        </section>
        {refusal ? <div className="landing-page-error" role="alert">{refusal}</div> : null}

        <LandingTimeline
          landing={landing}
          main={main}
          now={now}
          openLog={log}
          onOpenLog={setLog}
          sessionId={sessionId}
        />
      </div>

      <div className="landing-page-foot">
        {/* One line while it fits, as the board draws it: what this page is, who decides, and the
            way to them. */}
        <div className="landing-page-foot-line">
          {footer.line.split(' — ').map((part, index) =>
            index === 0 ? <span key={part}>{part} — </span> : <b key={part}>{part} </b>)}
          {footer.detail ? <span>{footer.detail}</span> : null}
          {footer.link && (footer.link === 'COORDINATOR' ? coordinatorId : currentPromotion) ? (
            <>
              <span> · </span>
              <button
                type="button"
                className="landing-page-link"
                onClick={() => (footer.link === 'COORDINATOR' && coordinatorId
                  ? onOpenCoordinator(coordinatorId)
                  : setReviewOpen(true))}
              >
                {footer.link === 'COORDINATOR'
                  ? `${LANDING_PAGE_COPY.OPEN_COORDINATOR_LINK} ›`
                  : `${LANDING_PAGE_COPY.REVIEW_CARD} ›`}
              </button>
            </>
          ) : null}
        </div>
        {footer.next ? <div className="landing-page-foot-line">{footer.next}</div> : null}
      </div>

      {reviewOpen && currentPromotion ? (
        <Dialog
          open
          onClose={() => setReviewOpen(false)}
          title={promotionHeading(currentPromotion)}
          className="review-card-dialog"
          width={720}
        >
          <div className="review-card-content" data-review-open>
            {landing.settledAt ? (
              <ProjectPromotionReceipt promotion={currentPromotion} />
            ) : (
              <ProjectPromotion projectId={landing.projectId} bare />
            )}
          </div>
        </Dialog>
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
              const mark = entryGlyph(entry, section.entries, index);
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
                      && !entry.text.includes('passed') ? (
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
  entries: readonly IntegrationTimelineEntry[],
  index: number,
): { glyph: string; tone: TimelineTone } {
  switch (entry.kind) {
    case 'TAKEN_OVER':
      return { glyph: '↗', tone: 'takeover' };
    case 'CHECK_FINISHED':
    case 'RESULT':
    case 'RESULT_FALLBACK':
      return entry.text.includes('passed') || /^(Landed|Already|Nothing to push|Merged)/.test(entry.text)
        ? { glyph: '✓', tone: 'ok' }
        : { glyph: '✗', tone: 'failed' };
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
