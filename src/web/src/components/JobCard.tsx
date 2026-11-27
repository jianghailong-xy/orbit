import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  CheckCircleFilled,
  CloseCircleFilled,
  ConsoleSqlOutlined,
  DownOutlined,
  LoadingOutlined,
  MinusCircleOutlined,
  RightOutlined,
} from '@ant-design/icons';
import type { BackgroundJobTailResponse, BgShell } from '@orbit/shared';
import { ApiError, getBackgroundJobTail, stopBackgroundJob } from '../api';
import { stripAnsi } from '../lib/ansi';
import {
  elapsedText,
  jobOutput,
  jobState,
  killedByLine,
  lastLines,
  type JobPhase,
  type JobWakeSeen,
} from '../lib/bgJobCard';
import { PHONE_QUERY, useMediaQuery } from '../lib/useMediaQuery';
import { formatSpan } from '../lib/watches';
import { SubagentWakeQueued } from './SubagentCardEnd';
import { ExportCtx, Pre } from './ToolBlocks';
import { Popconfirm } from './ui/Popconfirm';
import { Tooltip } from './ui/Tooltip';

/**
 * A `bg_run` job as one card from start to end (the owner's job-card board, choices A1 B1 C1 D1 E1 F1, rulings
 * R1-R4 of 2026-11-21). It stands where the call was: the terminal icon, the job's description, its kind and
 * how long it has run; folded, a spinner and the newest output line while it runs, then how it ended and its
 * last lines. Opened: the command, where it ran, the last 40 lines and every time it woke the agent. The turns
 * those wakes opened draw nothing (Transcript): the card says it.
 */

/** Where the card can ask about its job: the session it runs in. Absent on a share link and an export. */
export interface BgJobHost {
  sessionId: string;
  /** GET /sessions/:id/background: the complete list, which alone says whether a job can be stopped. */
  serverShells: readonly BgShell[];
  /** Where the session runs: its workspace, named on an opened card's metadata line. */
  where?: string | null;
}
export const BgJobHostCtx = createContext<BgJobHost | null>(null);

/** The session's bg_run jobs as the Background list holds them, by job id (built by `Transcript`). */
export const JobShellsCtx = createContext<ReadonlyMap<string, BgShell>>(new Map());

/** The wake turns loaded in this transcript, by job id, oldest first (built by `Transcript`). */
export const JobWakesCtx = createContext<ReadonlyMap<string, JobWakeSeen[]>>(new Map());

/** The wake turns still on the queue, by job id: each one's `Don't send`, which takes it off the queue. */
export const JobQueuedWakesCtx = createContext<ReadonlyMap<string, () => void>>(new Map());

/** The pace the tail route documents (sessions.controller `backgroundJobTail`). */
export const TAIL_PACE_MS = 5_000;
export const TAIL_RETRY_MS = 30_000;
/** How many of the output's lines an opened card shows before the reader asks for the rest. */
const OPEN_LINES = 40;

/** Whether `ref` is on screen, kept current. Without an IntersectionObserver it counts as on screen. */
function useOnScreen(ref: React.RefObject<HTMLElement | null>): boolean {
  const [onScreen, setOnScreen] = useState(() => typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return undefined;
    const io = new IntersectionObserver((entries) => {
      for (const entry of entries) setOnScreen(entry.isIntersecting);
    });
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);
  return onScreen;
}

function useDocumentHidden(): boolean {
  const [hidden, setHidden] = useState(() => typeof document !== 'undefined' && document.hidden);
  useEffect(() => {
    const onChange = () => setHidden(document.hidden);
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);
  return hidden;
}

/**
 * The job's newest lines, read while its card is on screen and the job runs (R2), at the route's pace: at once,
 * then 5 s after each answer, one request at a time; 30 s after a 503/504; never again after a 404/409 (a runner
 * too old to read it, or output that is gone). Once the job ends it is read once more, for its final lines.
 */
export function useJobTail(
  sessionId: string | null,
  jobId: string | null,
  running: boolean,
  ref: React.RefObject<HTMLElement | null>,
): BackgroundJobTailResponse | null {
  const onScreen = useOnScreen(ref);
  const hidden = useDocumentHidden();
  const [tail, setTail] = useState<BackgroundJobTailResponse | null>(null);
  const [gone, setGone] = useState(false);
  const polled = useRef(false);
  const lastStatus = useRef<string | null>(null);
  const active = !!sessionId && !!jobId && running && onScreen && !hidden && !gone;
  useEffect(() => {
    if (!active || !sessionId || !jobId) return undefined;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      let wait = TAIL_PACE_MS;
      try {
        const answer = await getBackgroundJobTail(sessionId, jobId);
        if (cancelled) return;
        polled.current = true;
        lastStatus.current = answer.status;
        setTail(answer);
        if (answer.status !== 'running') return;
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && (err.status === 404 || err.status === 409)) {
          setGone(true);
          return;
        }
        wait = TAIL_RETRY_MS;
      }
      timer = setTimeout(() => void read(), wait);
    };
    void read();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [active, sessionId, jobId]);
  // The job's end arrived from elsewhere (its report, its wake): one more read for the lines it ended on.
  const wasRunning = useRef(running);
  useEffect(() => {
    const ended = wasRunning.current && !running;
    wasRunning.current = running;
    if (!ended || !polled.current || gone || !sessionId || !jobId || lastStatus.current !== 'running') return;
    lastStatus.current = null;
    getBackgroundJobTail(sessionId, jobId).then(setTail, () => undefined);
  }, [running, gone, sessionId, jobId]);
  return tail;
}

/** Now, every second while `ticking`. */
function useNow(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);
  return now;
}

const clock = (iso: string): string =>
  new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });

const ms = (iso: string | null | undefined): number | null => {
  const t = iso ? new Date(iso).getTime() : NaN;
  return Number.isFinite(t) ? t : null;
};

/** The row's mark: a spinner while it runs, then how it ended. */
function JobMark({ phase }: { phase: JobPhase }) {
  if (phase === 'running') return <LoadingOutlined className="chat-tool-status running" spin aria-label="running" />;
  if (phase === 'done') return <CheckCircleFilled className="chat-tool-status ok" aria-label="done" />;
  if (phase === 'failed') return <CloseCircleFilled className="chat-tool-status err" aria-label="failed" />;
  if (phase === 'killed') return <span className="chat-tool-status stopped" role="img" aria-label="killed" />;
  return <MinusCircleOutlined className="chat-tool-status pending" />;
}

/** The Stop control, behind the app's confirm (R3). */
function StopJob({ onStop, className }: { onStop: () => Promise<unknown>; className: string }) {
  return (
    <span className={className} onClick={(event) => event.stopPropagation()}>
      <Popconfirm
        title="Stop this job?"
        confirmText="Stop"
        danger
        onConfirm={onStop}
        trigger={
          <button type="button" className="chat-subagent-link chat-job-stop-btn">
            Stop
          </button>
        }
      />
    </span>
  );
}

/** One time the job woke its agent: when, what it said, when the agent read it, and what it read. */
function WakeRow({ wake }: { wake: JobWakeSeen }) {
  const { job } = wake;
  const what = job.stall
    ? `quiet ${formatSpan(job.stall.quietForMs ?? 0)}`
    : !job.ended
      ? 'new output'
      : job.status === 'killed'
        ? 'killed'
        : job.exitCode !== null
          ? `exit ${job.exitCode}`
          : job.status;
  const parts = [wake.ts ? clock(wake.ts) : null, what, wake.readAt ? `read by the agent at ${clock(wake.readAt)}` : null];
  return (
    <li className="chat-job-wake">
      <div>{parts.filter(Boolean).join(' · ')}</div>
      <details className="chat-subagent-end-raw">
        <summary>What the agent read</summary>
        <pre>{wake.text}</pre>
      </details>
    </li>
  );
}

export function JobCard({
  seq,
  input,
  jobId,
  startedAt,
  live,
}: {
  seq: number;
  /** The bg_run call's own input: what to run, what it is called, and what kind of process it is. */
  input: { command?: unknown; description?: unknown; kind?: unknown } | undefined;
  /** The job the call started, once its receipt names it. */
  jobId: string | null;
  startedAt: string | null;
  live?: boolean;
}) {
  const exp = useContext(ExportCtx);
  const host = useContext(BgJobHostCtx);
  const shell = useContext(JobShellsCtx).get(jobId ?? '');
  const wakes = useContext(JobWakesCtx).get(jobId ?? '') ?? NO_WAKES;
  const dontSend = useContext(JobQueuedWakesCtx).get(jobId ?? '');
  const phone = useMediaQuery(PHONE_QUERY);
  const ref = useRef<HTMLDivElement>(null);
  const [manualOpen, setManualOpen] = useState<boolean | null>(null);
  const [allLines, setAllLines] = useState(false);
  const open = manualOpen ?? !!exp;

  const command = typeof input?.command === 'string' ? input.command : '';
  const description = typeof input?.description === 'string' ? input.description.trim() : '';
  const kind = typeof input?.kind === 'string' && input.kind ? input.kind : 'job';
  const title = description || command;

  // A first guess without the tail read, so the read itself knows whether the job runs.
  const known = jobState({ shell, wakes, live: !!live });
  const tail = useJobTail(host?.sessionId ?? null, jobId, known.phase === 'running', ref);
  const state = tail ? jobState({ shell, wakes, tail, live: !!live }) : known;
  const { phase } = state;
  const running = phase === 'running';
  const output = stripAnsi(jobOutput({ phase, shell, wakes, tail }));

  const now = useNow(running);
  const start = ms(startedAt) ?? ms(shell?.startedTs);
  const end = running ? now : ms(state.endedAt);
  const elapsed = start !== null && end !== null ? elapsedText(end - start) : null;

  const stoppable = running && !!host && !!shell?.stoppable && !!jobId;
  const stop = () => stopBackgroundJob(host!.sessionId, jobId!);
  const killedBy = phase === 'killed' ? killedByLine(state.reason) : null;
  const ended = phase === 'done' || phase === 'failed' || phase === 'killed';

  // Folded: the newest line while it runs; the last two once it ended.
  const folded = lastLines(output, running ? 1 : 2);
  const lines = output.trim() === '' ? [] : output.replace(/\s+$/, '').split('\n');
  const shown = allLines || exp ? lines : lines.slice(-OPEN_LINES);

  const kindChip = <span className="chat-tool-tag chat-job-kind">{kind}</span>;
  const elapsedChip = elapsed && <span className="chat-tool-meta chat-job-elapsed">{elapsed}</span>;
  const quietChip = running && state.quietMs !== null && (
    <span className="chat-subagent-end-chip chat-job-chip is-quiet">quiet {formatSpan(state.quietMs)}</span>
  );
  const endChip =
    phase === 'failed' && state.exitCode !== null ? (
      <span className="chat-subagent-end-chip is-failed">exit {state.exitCode}</span>
    ) : phase === 'killed' ? (
      <span className="chat-subagent-end-chip is-stopped">killed</span>
    ) : null;
  const showFull = (
    <button type="button" className="chat-subagent-link" onClick={(event) => { event.stopPropagation(); setManualOpen(true); }}>
      Show full output
    </button>
  );
  const toggle = () => setManualOpen((prev) => !(prev ?? !!exp));

  let foldedBody: ReactNode = null;
  if (running && folded.length > 0) {
    foldedBody = <div className="chat-tool-live chat-job-line">{folded[0]}</div>;
  } else if (phase === 'killed') {
    foldedBody = killedBy && <div className="chat-job-ending is-stopped">{killedBy}</div>;
  } else if (ended && folded.length > 0) {
    foldedBody = (
      <div className={`chat-job-ending is-${phase}`}>
        <pre className="chat-job-tail">{folded.join('\n')}</pre>
        {showFull}
      </div>
    );
  }

  return (
    <div
      ref={ref}
      data-seq={seq}
      // Where the Background list finds the card a job row scrolls to (BackgroundShellsTray).
      data-bg-job={jobId ?? undefined}
      className={`chat-tool-card chat-tone-exec chat-job-card is-${phase}${open ? ' is-open' : ''}`}
    >
      <div className="chat-tool-row" onClick={toggle}>
        <span className="chat-tool-caret">{open ? <DownOutlined /> : <RightOutlined />}</span>
        <span className="chat-tool-icon">
          <ConsoleSqlOutlined />
        </span>
        <Tooltip content={title} truncatedOnly>
          <span className="chat-tool-summary chat-job-title">
            {title}
          </span>
        </Tooltip>
        {!phone && kindChip}
        {!phone && elapsedChip}
        {quietChip}
        {endChip}
        {stoppable && !open && <StopJob onStop={stop} className="chat-job-stop is-hover" />}
        <JobMark phase={phase} />
      </div>
      {phone && (
        <div className="chat-job-sub">
          {kindChip}
          {elapsedChip}
        </div>
      )}
      {!open && foldedBody}
      {open && (
        <div className="chat-tool-detail">
          <div className="chat-tool-body chat-job-detail">
          {command && <Pre text={command} prompt />}
          <div className="chat-job-meta">
            {[
              jobId,
              kind,
              start !== null ? `started ${clock(new Date(start).toISOString())}` : null,
              ended && elapsed ? `ran ${elapsed}` : null,
              host?.where ? `on ${host.where}` : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </div>
          {killedBy && <div className="chat-job-ending is-stopped">{killedBy}</div>}
          {shown.length > 0 && (
            <div className={`chat-job-output is-${phase}`}>
              <pre className="chat-pre">{shown.join('\n')}</pre>
              {shown.length < lines.length && (
                <button type="button" className="chat-subagent-link" onClick={() => setAllLines(true)}>
                  Show all {lines.length} lines
                </button>
              )}
            </div>
          )}
          {stoppable && <StopJob onStop={stop} className="chat-job-stop" />}
          {wakes.length > 0 && (
            <div className="chat-subagent-end chat-job-wakes">
              <div className="chat-subagent-end-head">
                Woke the agent {wakes.length} {wakes.length === 1 ? 'time' : 'times'}
              </div>
              <ul className="chat-job-wake-list">
                {wakes.map((wake, i) => (
                  <WakeRow key={`${wake.ts ?? ''}:${i}`} wake={wake} />
                ))}
              </ul>
            </div>
          )}
          </div>
        </div>
      )}
      {/* Its wake still on the queue: the agent has not read it, and the reader can keep it back (E1). */}
      {dontSend && <SubagentWakeQueued onDontSend={dontSend} />}
    </div>
  );
}

const NO_WAKES: JobWakeSeen[] = [];
