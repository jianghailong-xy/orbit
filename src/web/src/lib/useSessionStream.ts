import type { SessionTurnPlacement } from '@orbit/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type ActiveSessionTurn,
  type ApprovalInfo,
  getBackgroundShells,
  getSessionEventFull,
  getSessionEventPage,
  getSessionEventPageAfter,
  getSessionEventPageAround,
  listApprovals,
  listQueuedTurns,
  sessionEventsUrl,
  type TranscriptAroundPage,
  type TurnCards,
} from '../api';
import type { TaskActivity } from '../components/Transcript';
import {
  acceptedUserTurnEvent,
  acceptedUserTurnLanded,
  clearAcceptedUserTurnsForSession,
  clearAcceptedUserTurnsForTurn,
  queuedTurnsOutsideTranscript,
  reconcileAcceptedUserTurnSnapshot,
  reconcileQueuedTurnSnapshot,
  transcriptEventsWithDurableDeliveryReceipts,
  turnCardsOf,
  type AcceptedUserTurn,
} from './acceptedUserTurn';
import type { BgShell } from './backgroundShells';
import { deriveBackgroundShells, mergeBackgroundShells } from './backgroundShells';
import { memoizeEventFull } from './eventFull';
import {
  EMPTY_LIVE_TASK_PROGRESS,
  reduceLiveTaskProgress,
  type SessionLiveTaskProgress,
} from './liveTaskProgress';
import {
  clearLiveToolOutputsForSession,
  EMPTY_LIVE_TOOL_OUTPUTS,
  reduceLiveToolOutputs,
  type SessionLiveToolOutputs,
} from './liveToolOutputs';
import { reseedWithActiveSnapshot } from './reseedActiveSnapshot';
import { supersedesLiveDrafts } from './steerDelivery';
import { streamAnchorAfter } from './streamAnchor';
import { settleThinking } from './thinkingDraft';
import { useToast } from './toast';
import { RECORD_NOT_FOUND } from './transcriptDeepLink';
import { firstPaintSlice } from './transcriptPaint';
import { loadTranscript, saveTranscript } from './transcriptStore';
import { turnPlacementOf } from './turnPlacement';

export interface RunEvent {
  seq: number;
  type: string;
  payload: any;
  turnId?: string | null;
  ts?: string;
}

// A user message accepted while a turn is running: it sits in the inbox (PENDING)
// until the current turn finishes. Tracked locally so the composer can show it and
// offer to withdraw it before the runner picks it up. A `!cmd` shell turn queues the
// same way, so it gets a bubble too — rendered as the command it will run.
//
// The cards it is drawn as (`TurnCards`) are the ones the active snapshot carried, exactly as the
// accepted-turn placeholder holds them: the queued tail draws the card the transcript will, rather
// than a bubble it replaces when the runner takes the turn.
export interface QueuedTurn extends TurnCards {
  turnId: string;
  content: string;
  shell?: boolean;
  /** Server receipt only: current-turn/next-turn is never inferred from local status. */
  placement: Extract<SessionTurnPlacement, 'steer' | 'queued'>;
  /** For a steer, the executable turn it was written into. */
  targetTurnId?: string;
  delivery?: 'failed' | 'unconfirmed';
  deliveryCode?: string;
  deliveryReason?: string;
  // Server-side image refs (id + mime), so a reopened/reloaded queue can still render an
  // image-only follow-up turn — the local turnImages previews don't survive a reload.
  attachments?: { id: string; mimeType: string }[];
  /** When the server queued it — the receipt's own timestamp, as an accepted turn's `acceptedAt`. */
  createdAt?: string;
  /** The control plane wrote this turn itself, so nobody typed it (`ActiveSessionTurn.authoredByOrbit`). */
  authoredByOrbit?: true;
}

/** Map one authoritative active-snapshot receipt into the pending-tail renderer. `accepted` is
 * represented by the optimistic/transcript bridge instead, so it deliberately has no queue row. */
export function queuedTurnFromActiveSnapshot(row: ActiveSessionTurn): QueuedTurn | null {
  const placement = turnPlacementOf(row);
  if (placement === 'accepted') return null;
  return {
    ...row,
    shell: row.kind === 'shell',
    placement,
  };
}

// Delay the SSE (re)connect on a session switch so holding the arrow keys to scrub
// the list doesn't open-then-immediately-close a connection per session skipped past.
const SWITCH_DEBOUNCE_MS = 150;
// Cap on cached transcripts (mount-scoped), so a long browsing session can't grow
// the cache without bound. Least-recently-selected entries are evicted first.
const TRANSCRIPT_CACHE_MAX = 20;
// Tail-first lazy loading: open a fresh transcript with only its newest page (so a long
// session lands straight at the latest message instead of replaying its whole history), then
// prepend older pages as the user scrolls up. TAIL_PAGE is deliberately large enough to fill
// any viewport in one shot, so no auto-load fires until the user actually scrolls up.
const TAIL_PAGE = 200;
const OLDER_PAGE = 200;
// A link to one record (`?at=`, lib/transcriptDeepLink) opens on the page around it instead: half
// before the record and half after, the same size as a tail page so it fills the view as well.
const AROUND_PAGE = 200;
// Consecutive reconnects that fail to move the resume cursor before the transcript stops trying to
// resume and re-seeds from a tail page instead. Three is past any single dropped connection while
// still costing ~12s of the backoff below — short enough that a wedged tab recovers on its own,
// long enough that an ordinary redeploy blip never throws away a loaded window. See reseed().
const RESEED_AFTER_STALLED_RECONNECTS = 3;
// Twelve quick retries ride out a redeploy; past them the stream is asked for once a minute rather
// than given up on. The control plane learned this the expensive way (useControlPlane, 2026-10-20);
// here the shape it dies in most is a laptop asleep and awake with the socket half-open, where the
// person comes back to a console whose events stopped arriving and stays that way until a reload.
const QUICK_RECONNECTS = 12;
const SLOW_RECONNECT_MS = 60_000;
// The server pings ~every 20s (sessions.controller KEEPALIVE_MS); 45s of total silence means the
// socket went half-dead without firing `onerror`. EventSource has no read timeout, so we watch for
// it — the same watchdog the control-plane stream runs. Without one a slept-on socket is never
// noticed at all: nothing arrives, nothing errors, and no reconnect is ever attempted.
const WATCHDOG_SILENCE_MS = 45_000;
const WATCHDOG_TICK_MS = 15_000;
// How long a cached /background scan stays fresh. `/background` scans the session's whole
// tool-event history, so re-opening a session (or scrubbing the list) within this window paints
// the cached shells instead of re-running that scan — see bgCacheRef.
const BG_TTL_MS = 30_000;

interface TranscriptCacheEntry {
  events: RunEvent[];
  oldestSeq: number | null; // seq of the earliest loaded event (null = nothing loaded)
  hasMoreOlder: boolean; // older events exist before oldestSeq on the server
}

export interface SessionStreamOptions {
  /** The session on screen, or null when none is. */
  sessionId: string | null;
  /** A landing: platform work with no transcript (contract §2.9 LS1/LS6). It opens no event stream
   *  and reads no event page. */
  landingSession?: boolean;
  /** The record the session's link names (`?at=`, lib/transcriptDeepLink), in its public spelling,
   *  or null. The session opens at it, and a later one is followed in place. */
  recordAt?: string | null;
  /** Whether the session's row says it is live: a stream that a `final` event paused re-opens then. */
  live: boolean;
  /** The polled run status, and whether the run is terminal: the fallback for idleness when the
   *  stream's turn_end or `final` was missed. */
  runStatus: string | undefined;
  runTerminal: boolean;
  /** Bring the record at `seq` of `sessionId` into view once its row has rendered: a window was
   *  opened at it, or a link named one already loaded. */
  revealRecord?: (sessionId: string, seq: number) => void;
  /** A window opened at a record is being traded for the tail: no record is waiting to be revealed. */
  forgetRecord?: () => void;
  /** Called just before older events are put above the loaded ones, so the host can hold its scroll
   *  position. */
  beforePrepend?: () => void;
}

/**
 * One session's conversation, as its live stream keeps it.
 *
 * The window of events opens tail-first — from the in-memory cache, the stored copy
 * (lib/transcriptStore) or the newest page, or on the page around a linked record — and grows by
 * the session's SSE stream and by paging (`loadOlder`, `loadNewer`). Beside it is what the stream
 * drives: the drafts being generated, live shell output and background-task progress, pending
 * approvals, whether a turn is in flight, the turns not yet taken (refreshed from the active
 * snapshot), and the background-shell list.
 *
 * All of it resets when `sessionId` changes; a host resets its own state (scroll, composer) on the
 * same change. SessionConversation draws what this returns.
 */
export function useSessionStream({
  sessionId: selectedId,
  landingSession = false,
  recordAt = null,
  live,
  runStatus,
  runTerminal,
  revealRecord,
  forgetRecord,
  beforePrepend,
}: SessionStreamOptions) {
  const qc = useQueryClient();
  const message = useToast();
  // Latest session, readable from async callbacks (loadOlder) to bail if the user has switched
  // sessions since the request was issued — so a late page never lands in the wrong transcript.
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;
  // `recordAt`, mirrored for the session effect, which reads the one it opens with and must not
  // re-run — re-seeding the whole window — when only this changes.
  const recordAtRef = useRef(recordAt);
  recordAtRef.current = recordAt;
  // The host's callbacks, read when they are needed: the stream is registered once per session.
  const host = useRef({ revealRecord, forgetRecord, beforePrepend });
  host.current = { revealRecord, forgetRecord, beforePrepend };
  const [events, setEvents] = useState<RunEvent[]>([]);
  // `events` is replaced in an effect after navigation. Keep its owner explicit so a render in
  // between cannot treat the previous session's transcript as the newly selected session's.
  const [eventsSessionId, setEventsSessionId] = useState<string | null>(selectedId);
  const [approvals, setApprovals] = useState<ApprovalInfo[]>([]); // pending tool-permission requests
  const [streamingText, setStreamingText] = useState(''); // live assistant text from text_delta
  const [streamingThink, setStreamingThink] = useState(''); // live thinking from thinking_delta
  // When the stretch of reasoning on screen began: the live row counts up from it, and the row it
  // settles into states how long it took. Client-side only — `thinking_delta` is broadcast and
  // never persisted, so a reload has no clock to recover this from (see lib/thinkingDraft).
  const [thinkStartedAt, setThinkStartedAt] = useState<number | null>(null);
  // Mirrors of both, for the SSE handler: it is registered once per session and would otherwise
  // close over the values of the render that registered it.
  const streamingThinkRef = useRef('');
  const thinkStartedAtRef = useRef<number | null>(null);
  const [liveToolOutputState, setLiveToolOutputState] = useState<SessionLiveToolOutputs>({
    sessionId: selectedId,
    outputs: EMPTY_LIVE_TOOL_OUTPUTS,
  });
  // Broadcast-only progress of the workspace's background agents and workflows — the same kind of
  // side channel as the shell snapshots above, and scoped to its session the same way.
  const [liveTaskProgressState, setLiveTaskProgressState] = useState<SessionLiveTaskProgress>({
    sessionId: selectedId,
    progress: EMPTY_LIVE_TASK_PROGRESS,
  });
  // The seq the stream was at when the current stretch of generation began, so the transcript can
  // render the drafts where they started rather than always last. A ref, not state: it only ever
  // moves alongside a draft update, so the render that shows the new text already reads the new
  // anchor — and keeping it out of state means a chunk doesn't re-render anything extra.
  const streamAnchorRef = useRef<number | null>(null);
  const [idle, setIdle] = useState(false); // session is AWAITING_INPUT (a new turn is accepted)
  const [queued, setQueued] = useState<QueuedTurn[]>([]); // messages sent while a turn was running
  const queuedRef = useRef<QueuedTurn[]>(queued);
  queuedRef.current = queued;
  const [queuedSessionId, setQueuedSessionId] = useState<string | null>(selectedId);
  // A normal idle/new-session send is accepted before the runner emits its durable `user` event.
  // Keep that acknowledged message visible in the gap; queued/steered follow-ups stay in `queued`
  // above because their status + Cancel affordance are meaningful rather than transport noise.
  const [acceptedUserTurns, setAcceptedUserTurns] = useState<AcceptedUserTurn[]>([]);
  const acceptedUserTurnsRef = useRef<AcceptedUserTurn[]>(acceptedUserTurns);
  acceptedUserTurnsRef.current = acceptedUserTurns;
  // The apiserver's authoritative background-shell list (all launches + output recovered from the
  // workspace's Read polls). The loaded event window only holds recent launches, so the tray merges
  // this complete set with its live-derived overlay — see BackgroundShellsTray.
  const [serverBgShells, setServerBgShells] = useState<BgShell[]>([]);
  // Per-session cache of the server /background scan. The tray is cleared to [] on every switch, so
  // the throttle in the SSE effect repopulates from here (not just skips) when it's still fresh.
  const bgCacheRef = useRef<Map<string, { at: number; shells: BgShell[] }>>(new Map());
  const seen = useRef<Set<number>>(new Set());
  // Per-session transcript cache (mount-scoped): switching seeds events from here for
  // an instant paint and resumes the SSE just past the cached seq, instead of replaying
  // each session's full history from seq 0 on every visit. Stores the older-pagination
  // boundary too, so a reopened session keeps its "load earlier" state.
  const transcriptCache = useRef<Map<string, TranscriptCacheEntry>>(new Map());
  // Live mirror of `events`, so the SSE handler (append) and loadOlder (prepend) both mutate
  // one source of truth without racing stale closures — see the load effect below.
  const accRef = useRef<RunEvent[]>([]);
  // Tail-first lazy loading state for the open session. Refs drive the (deps-free) scroll
  // handler; loadingOlder (state) drives the top "loading earlier" spinner.
  const oldestSeqRef = useRef<number | null>(null); // earliest loaded seq
  const hasMoreOlderRef = useRef(false); // older events exist before oldestSeq on the server
  // The in-flight page request, if any: it both guards against a second one and lets a caller
  // that needs to know when older content has landed (⌘F's "search earlier") await the one
  // already running instead of being told "no".
  const loadingOlderRef = useRef<Promise<boolean> | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  // A window opened at a record (`?at=`) stops short of the tail: this is the `after=` cursor for the
  // page newer than what is loaded, and it is non-null exactly while that is so. The live stream stays
  // closed meanwhile — its events belong after the gap, not at the bottom of this window — and opens
  // once paging down reaches the latest event (joinLiveRef) or the reader jumps there (backToLatestRef).
  const newerCursorRef = useRef<number | null>(null);
  const [detached, setDetached] = useState(false); // render mirror of newerCursorRef !== null
  const loadingNewerRef = useRef<Promise<boolean> | null>(null);
  const [loadingNewer, setLoadingNewer] = useState(false);
  // The `?at=` already followed (`<session> <record>`), so one link is followed once, not on every render.
  const followedRecordRef = useRef<string | null>(null);
  // Set by the session effect, which owns the stream: open a record of the session already open, join
  // the live stream once a detached window reaches the latest event, and trade a detached window for
  // the tail.
  const openRecordRef = useRef<((recordId: string) => void) | null>(null);
  const joinLiveRef = useRef<(() => void) | null>(null);
  const backToLatestRef = useRef<(() => void) | null>(null);
  // True from the moment a session with no cached transcript is selected until its tail page
  // lands (or gives up). Drives the skeleton: without it an unvisited session paints a blank
  // pane for the whole fetch, since an ended session matches none of the empty-state notes.
  const [seeding, setSeeding] = useState(false);
  // Re-opens the transcript SSE after a `final` event paused it and the session was
  // resumed in place (set by the SSE effect, called by the liveness watcher below).
  const resumeStreamRef = useRef<(() => void) | null>(null);
  // Tail-first lazy loading: pull in the next older page when the user scrolls near the top.
  // Guarded to one request in flight; tells the host just before it prepends the page
  // (`beforePrepend`), so the host can hold the viewport steady while older content grows above it.
  // Resolves true when events were actually prepended, so an awaiting caller can tell "there's
  // more history now" from "that was the end of it".
  const loadOlder = useCallback((): Promise<boolean> => {
    if (loadingOlderRef.current) return loadingOlderRef.current;
    if (!selectedId || !hasMoreOlderRef.current) return Promise.resolve(false);
    const before = oldestSeqRef.current;
    if (before == null) return Promise.resolve(false);
    setLoadingOlder(true);
    const inFlight = getSessionEventPage(selectedId, { before, limit: OLDER_PAGE })
      .then((page) => {
        if (selectedIdRef.current !== selectedId) return false; // user switched sessions mid-fetch
        const fresh = page.events.filter((e) => !seen.current.has(e.seq));
        for (const e of fresh) if (typeof e.seq === 'number') seen.current.add(e.seq);
        if (fresh.length) {
          host.current.beforePrepend?.();
          accRef.current = [...fresh, ...accRef.current];
          setEvents(accRef.current);
        }
        oldestSeqRef.current = page.events.length ? page.events[0].seq : before;
        hasMoreOlderRef.current = page.hasMore;
        // A window opened at a record is not cached: the cache is a window that ends at the tail,
        // which a reopen resumes the live stream from.
        if (newerCursorRef.current === null) {
          transcriptCache.current.set(selectedId, {
            events: accRef.current,
            oldestSeq: oldestSeqRef.current,
            hasMoreOlder: page.hasMore,
          });
        }
        return fresh.length > 0;
      })
      .catch(() => false)
      .finally(() => {
        loadingOlderRef.current = null;
        setLoadingOlder(false);
      });
    loadingOlderRef.current = inFlight;
    return inFlight;
  }, [selectedId]);
  // loadOlder's mirror, for a window opened at a record: pull in the page just newer than what is
  // loaded as the reader nears the bottom. Rows appended below the viewport move nothing the reader is
  // looking at, so there is no position to hold. The page that reaches the latest event re-attaches
  // the window to the tail, and the live stream opens from there (joinLiveRef).
  const loadNewer = useCallback((): Promise<boolean> => {
    if (loadingNewerRef.current) return loadingNewerRef.current;
    const after = newerCursorRef.current;
    if (!selectedId || after === null) return Promise.resolve(false);
    setLoadingNewer(true);
    const inFlight = getSessionEventPageAfter(selectedId, after, { limit: OLDER_PAGE })
      .then((page) => {
        // Another session, or the window re-opened at another record meanwhile: not this window's page.
        if (selectedIdRef.current !== selectedId || newerCursorRef.current !== after) return false;
        const fresh = page.events.filter((e) => !seen.current.has(e.seq));
        for (const e of fresh) if (typeof e.seq === 'number') seen.current.add(e.seq);
        if (fresh.length) {
          accRef.current = [...accRef.current, ...fresh];
          setEvents(accRef.current);
        }
        newerCursorRef.current = page.after;
        if (page.after === null) {
          setDetached(false);
          joinLiveRef.current?.();
        }
        return fresh.length > 0;
      })
      .catch(() => false)
      .finally(() => {
        loadingNewerRef.current = null;
        setLoadingNewer(false);
      });
    loadingNewerRef.current = inFlight;
    return inFlight;
  }, [selectedId]);
  // The tail-first window's edges, read through callbacks because they live in refs (kept out of
  // render for cost). ⌘F needs both: whether older events exist, and how far back it has loaded.
  const hasOlderNow = useCallback(() => hasMoreOlderRef.current, []);
  const oldestSeqNow = useCallback(() => oldestSeqRef.current, []);
  const detachedNow = useCallback(() => newerCursorRef.current !== null, []);
  // Pull back the untrimmed payload of an event the server clipped to a preview (see
  // MAX_EVENT_PAYLOAD). The transcript calls this when the user expands such a card, so a big
  // Read output or Write body only crosses the network if someone actually opens it — and, because
  // a remounted row is a new card with no memory of the first ask, only once (see
  // lib/eventFull.ts). Rebuilt per session: seqs are per session, so a memo outliving the switch
  // would answer this session's 99323 with the last session's.
  const fetchEventFull = useMemo(
    () => memoizeEventFull((seq: number) => getSessionEventFull(selectedId ?? '', seq)),
    [selectedId],
  );
  const scopedEvents = useMemo(
    () => (eventsSessionId === selectedId ? events : []),
    [events, eventsSessionId, selectedId],
  );
  const scopedLiveToolOutputs =
    liveToolOutputState.sessionId === selectedId
      ? liveToolOutputState.outputs
      : EMPTY_LIVE_TOOL_OUTPUTS;
  const scopedLiveTaskProgress =
    liveTaskProgressState.sessionId === selectedId
      ? liveTaskProgressState.progress
      : EMPTY_LIVE_TASK_PROGRESS;
  // Which of the workspace's Agent/Workflow calls are still at work — the tray's own list, read the
  // same way, so a card's spinner and its tray row always agree.
  const runningTasks = useMemo(() => {
    const running = new Set<string>();
    const shells = mergeBackgroundShells(serverBgShells, deriveBackgroundShells(events, { sessionLive: live }));
    for (const s of shells) {
      if ((s.kind === 'agent' || s.kind === 'workflow') && s.status === 'running') running.add(s.toolUseId);
    }
    return running;
  }, [events, live, serverBgShells]);
  const taskActivity = useMemo<TaskActivity>(
    () => ({ live: scopedLiveTaskProgress, running: runningTasks }),
    [scopedLiveTaskProgress, runningTasks],
  );
  const visibleAcceptedUserTurns = useMemo(
    () =>
      acceptedUserTurns.filter(
        (turn) =>
          turn.sessionId === selectedId &&
          !acceptedUserTurnLanded(turn, eventsSessionId, scopedEvents),
      ),
    [acceptedUserTurns, eventsSessionId, scopedEvents, selectedId],
  );
  const optimisticTranscriptEvents = useMemo(() => {
    if (visibleAcceptedUserTurns.length === 0) return scopedEvents;
    const lastSeq = scopedEvents.reduce((max, event) => Math.max(max, event.seq), 0);
    return [
      ...scopedEvents,
      ...visibleAcceptedUserTurns.map((turn, index) =>
        acceptedUserTurnEvent(
          turn,
          lastSeq + (index + 1) / (visibleAcceptedUserTurns.length + 1),
        ),
      ),
    ];
  }, [scopedEvents, visibleAcceptedUserTurns]);
  const scopedQueuedTurns = useMemo(
    () => (queuedSessionId === selectedId ? queued : []),
    [queued, queuedSessionId, selectedId],
  );
  const transcriptEvents = useMemo(
    () => transcriptEventsWithDurableDeliveryReceipts(
      optimisticTranscriptEvents,
      scopedQueuedTurns,
    ),
    [optimisticTranscriptEvents, scopedQueuedTurns],
  );
  const visibleQueuedTurns = useMemo(
    () => queuedTurnsOutsideTranscript(scopedQueuedTurns, transcriptEvents),
    [scopedQueuedTurns, transcriptEvents],
  );
  // The render-time filter above removes duplication in the same frame the SSE event lands. Trim
  // the acknowledged copy afterwards so landed turns do not accumulate in memory.
  useEffect(() => {
    if (!selectedId) return;
    setAcceptedUserTurns((current) => {
      const next = current.filter(
        (turn) =>
          turn.sessionId !== selectedId ||
          !acceptedUserTurnLanded(turn, eventsSessionId, scopedEvents),
      );
      return next.length === current.length ? current : next;
    });
  }, [acceptedUserTurns, eventsSessionId, scopedEvents, selectedId]);
  // Null when nothing is being generated, so the transcript can skip splitting itself in two
  // (and keep grouping runs of tool calls across the seam) whenever there are no drafts to place.
  const streamingDrafts = useMemo(
    () =>
      streamingText || streamingThink
        ? { text: streamingText, think: streamingThink, thinkStartedAt: thinkStartedAt ?? undefined }
        : null,
    [streamingText, streamingThink, thinkStartedAt],
  );
  // Mirror the live reasoning and its start into the refs the SSE handler reads, so a block that
  // closes with no text of its own can be settled from what was streamed.
  useEffect(() => {
    streamingThinkRef.current = streamingThink;
  }, [streamingThink]);
  useEffect(() => {
    thinkStartedAtRef.current = thinkStartedAt;
  }, [thinkStartedAt]);

  // Subscribe to the session's event stream; reset only when the selection changes.
  useEffect(() => {
    setEventsSessionId(selectedId);
    setQueuedSessionId(selectedId);
    // Keep API-accepted turns across navigation. Rendering is session-scoped above, the list is
    // bounded to 32, and returning to this session lets its matching durable user event retire the
    // transient copy. Dropping it here creates a visible REST debounce gap and loses it entirely
    // when startup fails after acceptance but before the first user event.
    // Live/ephemeral drafts belong to the previous selection — clear them at once.
    setStreamingText('');
    setStreamingThink('');
    setLiveToolOutputState((current) =>
      current.sessionId === selectedId && current.outputs.size === 0
        ? current
        : { sessionId: selectedId, outputs: EMPTY_LIVE_TOOL_OUTPUTS },
    );
    setLiveTaskProgressState((current) =>
      current.sessionId === selectedId && current.progress.size === 0
        ? current
        : { sessionId: selectedId, progress: EMPTY_LIVE_TASK_PROGRESS },
    );
    streamAnchorRef.current = null;
    setApprovals([]);
    setQueued([]);
    setIdle(false);
    // Reset tail-first lazy-loading state for the session being opened.
    loadingOlderRef.current = null;
    setLoadingOlder(false);
    // Every session opens attached to its tail, unless its own link names a record (below).
    newerCursorRef.current = null;
    loadingNewerRef.current = null;
    setDetached(false);
    setLoadingNewer(false);
    if (!selectedId || landingSession) {
      accRef.current = [];
      setEvents([]);
      seen.current = new Set();
      oldestSeqRef.current = null;
      hasMoreOlderRef.current = false;
      followedRecordRef.current = null;
      setSeeding(false);
      return;
    }
    const isSeq = (s: unknown): s is number =>
      typeof s === 'number' && s !== Number.MAX_SAFE_INTEGER;
    const maxSeqOf = (list: RunEvent[]): number =>
      list.reduce((m, e) => (isSeq(e.seq) ? Math.max(m, e.seq) : m), 0);
    // A link to one record of this session (`?at=`) opens on the page around that record — not on
    // the cached window, which ends at the tail and may be nowhere near it.
    const openAt = recordAtRef.current;
    followedRecordRef.current = openAt ? `${selectedId} ${openAt}` : null;
    // Seed from cache for an instant paint; touch the entry so it's most-recently-used. On a
    // cache miss the transcript stays empty until boot() fetches the newest page below (no more
    // replaying the whole history over SSE — that's what caused a long session to "fast-forward"
    // on open). The older-pagination boundary is restored from cache, or established by boot().
    const cache = transcriptCache.current;
    const entry = openAt ? undefined : cache.get(selectedId);
    const cached = entry?.events ?? [];
    if (entry) {
      cache.delete(selectedId);
      cache.set(selectedId, entry);
    }
    accRef.current = cached;
    setEvents(cached);
    setSeeding(cached.length === 0); // nothing to paint yet — show the skeleton, not a blank pane
    setServerBgShells([]); // clear the previous session's list until the fetch below repopulates it
    seen.current = new Set(cached.map((e) => e.seq).filter(isSeq));
    oldestSeqRef.current = entry ? entry.oldestSeq : null;
    hasMoreOlderRef.current = entry ? entry.hasMoreOlder : false;
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    // Queue refreshes can overlap when another client quickly adds/withdraws turns. Only the most
    // recently requested snapshot may paint, or a slower stale response can resurrect a cancelled
    // row. The snapshot is authoritative for rows known when its request began; reconcile below
    // preserves a local POST that committed while that older request was in flight.
    let queuedRefreshGeneration = 0;
    const refreshQueued = (): void => {
      const generation = ++queuedRefreshGeneration;
      const knownBefore = new Set(queuedRef.current.map((turn) => turn.turnId));
      const knownAcceptedBefore = new Set(
        acceptedUserTurnsRef.current
          .filter((turn) => turn.sessionId === selectedId)
          .map((turn) => turn.key),
      );
      listQueuedTurns(selectedId)
        .then((rows) => {
          if (closed || generation !== queuedRefreshGeneration) return;
          const acceptedRows = rows.filter(
            (row) => turnPlacementOf(row) === 'accepted' && row.kind !== 'shell',
          );
          const accepted = acceptedRows
            .map((row): AcceptedUserTurn => ({
              key: row.turnId,
              sessionId: selectedId,
              source: 'activeSnapshot',
              turnId: row.turnId,
              ...(row.opening ? { opening: true as const } : {}),
              text: row.content,
              acceptedAt: row.createdAt ?? new Date().toISOString(),
              attachments: (row.attachments ?? []).map((attachment) => ({
                id: attachment.id,
                mime: attachment.mimeType || 'application/octet-stream',
              })),
              // Every card the snapshot carried, so the placeholder this row paints is the card the
              // runner's echo will replace it with.
              ...turnCardsOf(row),
            }))
            .filter(
              (turn) => !acceptedUserTurnLanded(turn, selectedId, accRef.current),
            );
          setAcceptedUserTurns((current) =>
            reconcileAcceptedUserTurnSnapshot(
              accepted,
              current,
              selectedId,
              knownAcceptedBefore,
            ),
          );
          const serverQueued = rows.flatMap((row) => {
            const queued = queuedTurnFromActiveSnapshot(row);
            return queued ? [queued] : [];
          });
          const representedTurnIds = new Set(rows.map((row) => row.turnId));
          setQueued((current) =>
            reconcileQueuedTurnSnapshot(
              serverQueued,
              current,
              knownBefore,
              representedTurnIds,
            ),
          );
        })
        .catch(() => undefined);
    };
    // Set when a `final` event arrives: the connection is dropped (don't hold an idle
    // stream to a finished session) but NOT permanently — unlike `closed`, a paused
    // stream can be re-opened in place when the session resumes (see resumeStreamRef).
    let paused = false;
    let fails = 0;
    // When this connection last heard anything, keepalive included (see WATCHDOG_SILENCE_MS).
    let lastMsgAt = Date.now();
    // Resume just past what's loaded so only the gap is streamed, not the whole history.
    let lastSeq = cached.reduce((m, e) => (isSeq(e.seq) ? Math.max(m, e.seq) : m), 0);
    // The cursor the current connection opened at, and how many connections in a row have died
    // without moving it. A reconnect that resumes from the same seq re-requests the same replay,
    // so a cursor the client can't get past is a loop, not a retry — see reseed().
    let seqAtConnect = -1;
    let stalled = 0;
    const writeCache = (): void => {
      // A window opened at a record ends at a gap, not at the tail: a reopen must not resume from it.
      if (newerCursorRef.current !== null) return;
      const snapshot = {
        events: accRef.current,
        oldestSeq: oldestSeqRef.current,
        hasMoreOlder: hasMoreOlderRef.current,
      };
      cache.set(selectedId, snapshot);
      if (cache.size > TRANSCRIPT_CACHE_MAX) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined && oldest !== selectedId) cache.delete(oldest);
      }
      // Mirror into the persistent L2 so the same transcript survives a reload. Returns at once —
      // this runs on every appended event, and the store batches the actual write into an idle
      // callback rather than opening a transaction per token.
      saveTranscript(selectedId, snapshot);
    };
    const seedAbort = new AbortController();
    // Pending release of the events the first paint held back (see firstPaintSlice).
    let paintRest: ReturnType<typeof setTimeout> | undefined;
    const stop = (): void => {
      closed = true;
      if (retry) clearTimeout(retry);
      if (paintRest) clearTimeout(paintRest);
      es?.close();
      // Scrubbing the list fires one tail page per session passed through (they're no longer
      // debounced — see below); aborting the superseded one keeps at most a single seed in
      // flight instead of a burst the user will never look at.
      seedAbort.abort();
    };
    const push = (ev: RunEvent): void => {
      accRef.current = [...accRef.current, ev];
      writeCache();
      setEvents(accRef.current);
    };
    const applyLiveTaskEvent = (ev: RunEvent): void => {
      setLiveTaskProgressState((current) => {
        const base = current.sessionId === selectedId ? current.progress : EMPTY_LIVE_TASK_PROGRESS;
        const progress = reduceLiveTaskProgress(base, ev);
        return current.sessionId === selectedId && progress === current.progress
          ? current
          : { sessionId: selectedId, progress };
      });
    };
    const applyLiveToolEvent = (ev: RunEvent): void => {
      setLiveToolOutputState((current) => {
        const base =
          current.sessionId === selectedId ? current.outputs : EMPTY_LIVE_TOOL_OUTPUTS;
        const outputs = reduceLiveToolOutputs(base, ev);
        return current.sessionId === selectedId && outputs === current.outputs
          ? current
          : { sessionId: selectedId, outputs };
      });
    };
    /**
     * Throw the loaded window away and start over from a tail page, exactly as a cold open does.
     *
     * Two callers, one situation: the cursor this tab holds is not a viable place to resume from.
     * The server says so with `resync` when the gap is too long to replay; the stall counter below
     * infers it when reconnecting from the same seq keeps failing to advance it. Both used to be
     * unrecoverable in place — the tab reconnected from that cursor forever, re-downloading the
     * same replay while the session it was watching ran on without it.
     *
     * Resetting `seen` and the pagination boundary along with the events is what makes this a real
     * re-seed rather than a patch over a hole: the tail page re-establishes both.
     */
    const reseed = async (): Promise<void> => {
      accRef.current = [];
      seen.current = new Set();
      setLiveToolOutputState({ sessionId: selectedId, outputs: EMPTY_LIVE_TOOL_OUTPUTS });
      setLiveTaskProgressState({ sessionId: selectedId, progress: EMPTY_LIVE_TASK_PROGRESS });
      oldestSeqRef.current = null;
      hasMoreOlderRef.current = false;
      lastSeq = 0;
      stalled = 0;
      try {
        const page = await reseedWithActiveSnapshot(
          () => getSessionEventPage(selectedId, {
            tail: TAIL_PAGE,
            signal: seedAbort.signal,
          }),
          () => { if (!closed) refreshQueued(); },
        );
        if (closed) return;
        accRef.current = page.events;
        for (const e of page.events) if (isSeq(e.seq)) seen.current.add(e.seq);
        oldestSeqRef.current = page.events.length ? page.events[0].seq : null;
        hasMoreOlderRef.current = page.hasMore;
        lastSeq = page.events.reduce((m, e) => (isSeq(e.seq) ? Math.max(m, e.seq) : m), 0);
        setEvents(accRef.current);
        writeCache();
      } catch {
        // Leave lastSeq at 0 and let the reconnect below carry it: a cursor-less connect is
        // server-capped, so the fallback for a failed re-seed is still a bounded replay.
      }
      if (closed) return;
      // `fails` is deliberately NOT reset: re-seeding is a different way to spend the same retry
      // budget, not a fresh start. Zeroing it would turn the give-up below into an unreachable
      // branch — a permanently broken stream would reconnect, stall, re-seed, forever.
      connect();
    };
    const connect = (): void => {
      // A tab in the background holds no transcript stream: nobody is reading it, and every frame
      // it took would be growth in a tab nobody is watching — the shape of a tab that gets heavier
      // the longer it is left open. `onVisibility` reopens it from `lastSeq` on the way back, so the
      // server replays only the gap (or answers `resync` and the tab re-seeds from a tail page).
      if (closed || document.visibilityState === 'hidden') return;
      seqAtConnect = lastSeq;
      lastMsgAt = Date.now();
      es = new EventSource(sessionEventsUrl(selectedId, lastSeq));
      es.onmessage = (e) => {
        lastMsgAt = Date.now();
        fails = 0; // a message means the stream is healthy
        const ev = JSON.parse(e.data) as RunEvent;
        // Server keepalive (~20s): a health byte with no seq/payload, sent so an idle transcript
        // stream isn't reaped by Cloudflare. Discard it by type before the reducer below, which
        // would otherwise dedup-miss (seq undefined) and append it as a junk transcript row.
        if (ev.type === 'ping') return;
        // The server refused to replay our gap — it's longer than it will stream (SSE_GAP_CAP).
        // Handled here, before the seq bookkeeping and the dedup below, because it rides seq 0
        // like the approval nudges. Re-seed from a tail page instead; this connection is spent.
        if (ev.type === 'resync') {
          es?.close();
          void reseed();
          return;
        }
        // A still-PENDING turn is not in the transcript stream until the runner leases it.
        // Re-fetch the durable queue when another web/native client adds or withdraws one.
        if (ev.type === 'queued_turns_changed') {
          refreshQueued();
          return;
        }
        // Whole-output snapshots for a foreground `!` shell are live animation, like the text
        // deltas below: replace their side-channel value and return before advancing lastSeq,
        // entering `seen`, or writing the transcript cache. A runner restart/reconnect must never
        // turn one into durable history or make its ephemeral seq the resume cursor.
        if (ev.type === 'tool_output') {
          applyLiveToolEvent(ev);
          return;
        }
        // How far a background agent or workflow has got: animation like the snapshot above — the
        // task's end (a durable background_task) carries the last of it into the transcript.
        if (ev.type === 'task_progress') {
          applyLiveTaskEvent(ev);
          return;
        }
        if (ev.type === 'background_task' || (ev.type === 'system' && ev.payload?.subtype === 'resumed')) {
          applyLiveTaskEvent(ev);
        }
        // The durable result wins in the same render that appends it. Clearing here also releases
        // the potentially large snapshot once the result has entered the ordinary transcript.
        if (
          ev.type === 'tool_result' ||
          ev.type === 'turn_end' ||
          ev.payload?.final ||
          (ev.type === 'system' && ev.payload?.subtype === 'resumed')
        ) {
          applyLiveToolEvent(ev);
        }
        if (typeof ev.seq === 'number' && ev.seq !== Number.MAX_SAFE_INTEGER) {
          lastSeq = Math.max(lastSeq, ev.seq);
        }
        if (ev.payload?.final) {
          // Session finalized (turn-complete failure, idle-recycle, or a user end). Drop
          // the live connection so we don't hold an idle stream — but a gracefully-ended
          // session is resumable IN PLACE (same selectedId, so this effect
          // doesn't re-run), and a resumed turn's events would be published to a stream
          // we'd have permanently closed, leaving the open transcript stale while the
          // polled sidebar advances. So pause instead of closing for good; the liveness
          // watcher re-opens it (replaying the missed seq) once the session is live again.
          paused = true;
          es?.close();
          // However the run ended, no turn is in flight any more. `turn_end` is the
          // only other event that says so, and a run that died before its first one —
          // an engine that failed during session setup, a crash before the first
          // reply — never emits it. Without this the console keeps the turn state of
          // a session that is already terminal: a half-streamed bubble left mid-air,
          // and the next message queued behind a turn that will never end.
          setIdle(true);
          setStreamingText('');
          setStreamingThink('');
          setThinkStartedAt(null);
          streamAnchorRef.current = null;
          // A snapshot started before this terminal signal must not resurrect an accepted/queued
          // fallback after the terminal cleanup below.
          queuedRefreshGeneration += 1;
          setAcceptedUserTurns((current) =>
            clearAcceptedUserTurnsForSession(current, selectedId),
          );
          return;
        }
        // Streaming increment: append to the in-progress assistant bubble. Don't
        // dedup or store it — it's pure animation; the trailing `assistant` event
        // carries the authoritative full text and finalizes the bubble.
        //
        // The first chunk of a stretch also fixes where that bubble sits: at the cursor as it
        // stands now, so a mid-turn message the runner echoes back renders below it rather than
        // above. See streamAnchorAfter for what moves that anchor afterwards.
        if (ev.type === 'text_delta') {
          const chunk = ev.payload?.text;
          if (typeof chunk === 'string') {
            streamAnchorRef.current = streamAnchorAfter(streamAnchorRef.current, ev, lastSeq);
            setStreamingText((p) => p + chunk);
          }
          return;
        }
        if (ev.type === 'thinking_delta') {
          const chunk = ev.payload?.text;
          if (typeof chunk === 'string') {
            streamAnchorRef.current = streamAnchorAfter(streamAnchorRef.current, ev, lastSeq);
            setStreamingThink((p) => p + chunk);
            // The first chunk of a stretch starts its clock; the rest ride the one already running.
            setThinkStartedAt((at) => at ?? Date.now());
          }
          return;
        }
        // Approval nudges (live-only, seq 0) — handle BEFORE the seq dedup, which is
        // keyed on seq and would drop the second one. They drive `approvals`, not the
        // transcript reducer.
        if (ev.type === 'approval_request') {
          const p = ev.payload as { id: string; toolName: string; input: unknown; toolUseId?: string };
          setApprovals((prev) =>
            prev.some((x) => x.id === p.id)
              ? prev
              : [
                  ...prev,
                  { ...p, sessionId: selectedId, status: 'PENDING', createdAt: new Date().toISOString() } as ApprovalInfo,
                ],
          );
          return;
        }
        if (ev.type === 'approval_resolved') {
          const id = ev.payload?.id as string | undefined;
          if (id) setApprovals((prev) => prev.filter((x) => x.id !== id));
          return;
        }
        if (seen.current.has(ev.seq)) return;
        seen.current.add(ev.seq);
        // A block the provider closes with no text of its own would otherwise take its reasoning
        // with it: the draft is cleared just below, and an empty durable event renders nothing.
        // Keep what was streamed — and how long it took, when the runner did not say — on this
        // LOCAL copy of the event. It is never sent back, so a reload still reads the server's
        // empty text and still renders nothing, which is deliberate (see lib/thinkingDraft).
        if (ev.type === 'thinking') {
          const patch = settleThinking(
            ev.payload,
            streamingThinkRef.current,
            thinkStartedAtRef.current,
            Date.now(),
          );
          push(Object.keys(patch).length ? { ...ev, payload: { ...ev.payload, ...patch } } : ev);
        } else {
          push(ev);
        }
        // The authoritative full text (or a turn/user/interrupt boundary) supersedes
        // the live drafts — clear them so streamed text isn't rendered twice. Text
        // implies thinking is done, so a text/turn boundary clears both; the durable
        // `thinking` block clears only its own draft. A mid-turn crash skips turn_end
        // and re-spawns with a `resumed` system event — clear there too so a partial
        // bubble can't outlive its turn. (Don't clear on every system event: claude's
        // stderr also arrives as `system` and would wipe an in-progress bubble.)
        // A steer is the one `user` event that is NOT a boundary — see supersedesLiveDrafts.
        // Where the drafts belong afterwards is streamAnchorAfter's call: a boundary ends the
        // stretch they were anchored to, while the model's own output (a closed thinking block,
        // a tool call) moves the anchor past itself so what is still being generated follows it.
        if (supersedesLiveDrafts(ev)) {
          setStreamingText('');
          setStreamingThink('');
          setThinkStartedAt(null);
        } else if (ev.type === 'thinking') {
          setStreamingThink('');
          setThinkStartedAt(null);
        } else if (ev.type === 'system' && ev.payload?.subtype === 'resumed') {
          setStreamingText('');
          setStreamingThink('');
          setThinkStartedAt(null);
        }
        streamAnchorRef.current = streamAnchorAfter(streamAnchorRef.current, ev, lastSeq);
        // Track turn boundaries live so the composer re-enables the instant a turn
        // ends, rather than waiting for the 4s session poll.
        if (ev.type === 'turn_end') {
          setIdle(true);
          setAcceptedUserTurns((current) =>
            clearAcceptedUserTurnsForTurn(current, selectedId, ev.turnId),
          );
          // The terminal boundary is persisted and replayable; use it to refresh the active
          // snapshot too, so an accepted placeholder also clears when an older runner omitted the
          // turn id or a queued successor moved into the executable head at the same boundary.
          refreshQueued();
          // Refresh the worktree status bar: the runner reports this turn's diff +
          // isolation on /turn-complete. Delay a touch so that POST (which persists
          // changed_files) lands before we refetch the detail, rather than racing the
          // turn_end event broadcast.
          setTimeout(() => qc.invalidateQueries({ queryKey: ['session', selectedId] }), 400);
        }
        else if (ev.type === 'user') {
          setIdle(false);
          // The runner just picked up this turn — it's now in the transcript, so drop
          // it from the local queue (no-op if it wasn't ours / already cleared). Re-fetch too:
          // an older queue request may have snapshotted this row just before the lease and could
          // otherwise arrive afterwards and resurrect it; the generation fence drops that reply.
          if (ev.turnId) {
            setQueued((q) => q.filter((x) => x.turnId !== ev.turnId));
          }
          refreshQueued();
        }
      };
      es.onerror = () => dropStream();
    };
    // Close the stream and schedule a backoff reconnect. Shared by `onerror` and the silence
    // watchdog, which can both fire for the same dead socket. Never gives up: past the quick
    // retries the stream is asked for once a minute (QUICK_RECONNECTS).
    const dropStream = (): void => {
      es?.close();
      es = null;
      if (closed || paused) return;
      // A background tab waits for `onVisibility` instead of counting down retries nobody reads.
      if (document.visibilityState === 'hidden') return;
      // A connection that died without moving the cursor forward left us exactly where we
      // started, so reconnecting asks the server for the same replay again. Once is a dropped
      // connection; three in a row is a replay this tab cannot get through — the shape a single
      // outsized event makes — and the only way out is to stop asking for it. See reseed().
      stalled = lastSeq > seqAtConnect ? 0 : stalled + 1;
      if (stalled >= RESEED_AFTER_STALLED_RECONNECTS) {
        void reseed();
        return;
      }
      fails += 1;
      const delay = fails > QUICK_RECONNECTS ? SLOW_RECONNECT_MS : Math.min(2000 * fails, 15_000);
      retry = setTimeout(connect, delay + Math.random() * 500);
    };
    // A tab coming back into view, or a browser back online, asks for the stream at once rather
    // than waiting out the backoff. Nothing to do while one is open, or while the session is
    // paused (a finalized turn) or the window is detached from the live tail.
    const retryNow = (): void => {
      if (closed || paused || es || newerCursorRef.current !== null) return;
      if (document.visibilityState === 'hidden') return;
      if (retry) clearTimeout(retry);
      connect();
    };
    const onVisibility = (): void => {
      if (closed) return;
      if (document.visibilityState === 'hidden') {
        // Nobody is reading this tab; hold no stream for it (see `connect`). A pending retry
        // fires into the same guard and is left for `onVisibility` to answer.
        es?.close();
        es = null;
        return;
      }
      retryNow();
    };
    // Bridge for the liveness watcher: re-open a stream paused by a `final` event once the
    // session is live again. No-op unless paused (so it's safe to call on any status tick);
    // reconnect resumes from lastSeq, so the server replays the turns missed while paused.
    resumeStreamRef.current = () => {
      if (closed || !paused) return;
      paused = false;
      fails = 0;
      // A window opened at a record stays off the stream until it reaches the tail (joinLiveRef).
      if (newerCursorRef.current !== null) return;
      connect();
    };
    /**
     * Make the page around a record the loaded window. Its older edge is set from the page's `before`
     * cursor, as a tail page's `hasMore` would set it; where the page stops short of the latest event
     * the newer edge stays open (newerCursorRef) and the stream stays closed, since what it streams
     * belongs past the gap. The record is brought into view once its row has rendered.
     */
    const applyRecordPage = (page: TranscriptAroundPage): void => {
      accRef.current = page.events;
      seen.current = new Set(page.events.map((e) => e.seq).filter(isSeq));
      oldestSeqRef.current = page.events.length ? page.events[0].seq : null;
      hasMoreOlderRef.current = page.before !== null;
      lastSeq = maxSeqOf(page.events);
      newerCursorRef.current = page.after;
      setDetached(page.after !== null);
      // Drafts streamed into the window being replaced are not this window's to show.
      setStreamingText('');
      setStreamingThink('');
      setThinkStartedAt(null);
      streamAnchorRef.current = null;
      // The reader came for this record, not the latest message.
      host.current.revealRecord?.(selectedId, page.anchor.seq);
      setEvents(accRef.current);
      setSeeding(false);
      writeCache(); // only a page that reaches the tail is a window a reopen may resume from
    };
    // A detached window's last newer page reached the latest event: resume the stream from there.
    joinLiveRef.current = () => {
      if (closed) return;
      lastSeq = maxSeqOf(accRef.current);
      writeCache();
      es?.close();
      if (!paused) connect();
    };
    // "Jump to the latest" from a detached window: the latest message is past the gap, so the window
    // is traded for a tail page and the stream reopens from it — reseed() is exactly that.
    backToLatestRef.current = () => {
      if (closed) return;
      es?.close();
      clearTimeout(retry);
      newerCursorRef.current = null;
      host.current.forgetRecord?.();
      setDetached(false);
      void reseed();
    };
    // A record of this session, named by a link followed while it is open. A record already in the
    // window — every seq from its oldest to its newest is loaded — is a scroll; one elsewhere in the
    // history replaces the window with the page around it, exactly as opening the session at it does.
    openRecordRef.current = (recordId: string): void => {
      void (async () => {
        let page: TranscriptAroundPage;
        try {
          page = await getSessionEventPageAround(selectedId, recordId, {
            limit: AROUND_PAGE,
            signal: seedAbort.signal,
          });
        } catch {
          if (!closed) message.info(RECORD_NOT_FOUND);
          return;
        }
        if (closed) return;
        const seq = page.anchor.seq;
        const oldest = oldestSeqRef.current;
        if (oldest !== null && seq >= oldest && seq <= maxSeqOf(accRef.current)) {
          host.current.revealRecord?.(selectedId, seq);
          return;
        }
        es?.close();
        es = null;
        clearTimeout(retry);
        applyRecordPage(page);
        if (page.after === null && !paused) connect();
      })();
    };
    // Tail-first seed, fired NOW rather than from the debounced block below: on a cache miss it
    // is the only request whose answer the transcript is waiting on, so making it wait out the
    // debounce — behind a whole-history /background scan, no less — was pure dead time under a
    // blank pane. What the debounce protected against is covered by the abort in stop() instead.
    // Null on a cache hit, where the SSE's replay of the gap after the cached seq is enough. The
    // debounced block awaits this before connect(), so the stream still opens at the seq the
    // page established, however long it took.
    const seedTail = async (): Promise<void> => {
      // L2 first: the same transcript, kept in IndexedDB so it outlives the page. A hit skips
      // the tail page entirely — the SSE resumes from the stored max seq and replays only what
      // happened since, exactly as an L1 hit does. A miss (or any error) returns null and falls
      // through to the network below, so this can only save a request, never cost correctness.
      const stored = await loadTranscript(selectedId);
      if (closed) return;
      if (stored && stored.events.length > 0) {
        accRef.current = stored.events;
        for (const e of stored.events) if (isSeq(e.seq)) seen.current.add(e.seq);
        oldestSeqRef.current = stored.oldestSeq;
        hasMoreOlderRef.current = stored.hasMoreOlder;
        lastSeq = stored.events.reduce((m, e) => (isSeq(e.seq) ? Math.max(m, e.seq) : m), lastSeq);
        const { now, deferred } = firstPaintSlice(stored.events);
        setEvents(now);
        setSeeding(false);
        // Into L1 too, so switching away and back in this page load is synchronous again.
        cache.set(selectedId, stored);
        if (deferred) {
          paintRest = setTimeout(() => {
            if (!closed) setEvents(accRef.current);
          }, 0);
        }
        return;
      }
      // Retry the tail seed a few times before giving up. A transient failure here used to fall
      // straight through to the SSE with lastSeq=0, replaying the whole history (now server-capped,
      // but still a needless full tail). Stop as soon as a page seeds; on total failure fall through.
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const page = await getSessionEventPage(selectedId, {
            tail: TAIL_PAGE,
            signal: seedAbort.signal,
          });
          if (closed) return;
          accRef.current = page.events;
          for (const e of page.events) if (isSeq(e.seq)) seen.current.add(e.seq);
          oldestSeqRef.current = page.events.length ? page.events[0].seq : null;
          hasMoreOlderRef.current = page.hasMore;
          lastSeq = page.events.reduce((m, e) => (isSeq(e.seq) ? Math.max(m, e.seq) : m), lastSeq);
          // Paint the newest slice first and release the rest after the browser has drawn it:
          // a full page is a few hundred Markdown bodies to parse and highlight in one
          // synchronous burst, which the user would otherwise spend staring at the skeleton.
          // accRef keeps the whole page throughout, so the SSE and the cache are unaffected,
          // and the remainder lands above a viewport that stays pinned to the tail.
          const { now, deferred } = firstPaintSlice(page.events);
          setEvents(now);
          setSeeding(false); // history is on screen — drop the skeleton
          writeCache();
          if (deferred) {
            // A macrotask, not rAF: rAF callbacks run BEFORE the paint they're queued for,
            // which would merge the two renders and defeat the split.
            paintRest = setTimeout(() => {
              if (!closed) setEvents(accRef.current);
            }, 0);
          }
          return;
        } catch {
          if (closed) return;
          // Last attempt failed: fall through to the SSE (the server caps a cursor-less replay).
          if (attempt < 2) await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
        }
      }
      // Every attempt failed. Clear the skeleton anyway rather than spin forever — the SSE
      // replay below is the remaining path to content.
      if (!closed) setSeeding(false);
    };
    // A link to one record: the page around it — or, for a record that is not this session's, the
    // tail, with a note saying the link could not be followed.
    const seedRecord = async (recordId: string): Promise<void> => {
      try {
        const page = await getSessionEventPageAround(selectedId, recordId, {
          limit: AROUND_PAGE,
          signal: seedAbort.signal,
        });
        if (closed) return;
        applyRecordPage(page);
        return;
      } catch {
        if (closed) return;
        message.info(RECORD_NOT_FOUND);
      }
      await seedTail();
    };
    const seed: Promise<void> | null = openAt
      ? seedRecord(openAt)
      : cached.length === 0
        ? seedTail()
        : null;
    // Debounce the rest of the network work: scrubbing the list with the arrow keys shouldn't
    // open (and tear down) a connection — nor re-fetch approvals/queued turns — for each
    // session skipped past. The cached transcript above is already on screen meanwhile.
    const start = setTimeout(() => {
      // Pending approvals aren't in the event stream (separate table) — fetch them so
      // a refresh/deep-link shows any request already awaiting a decision.
      listApprovals(selectedId)
        .then(setApprovals)
        .catch(() => undefined);
      // Same for queued messages: a still-PENDING turn emits no event until the runner
      // picks it up, so switching away and back (or a refresh/deep-link) would lose the
      // visible queue — restore it from the DB, the source of truth.
      refreshQueued();
      // The complete background-shell list (all launches, output recovered from Read polls) —
      // the loaded event window only holds the most recent launches, so without this the tray
      // under-counts a long session. Merged with the live-derived overlay in the tray. Throttled
      // per session (BG_TTL_MS): this scans the session's whole history, so a re-open within the
      // window paints the cached shells instead of re-running it. A failed fetch isn't cached, so
      // it retries next open.
      const loadBackgroundShells = (): void => {
        const bgCached = bgCacheRef.current.get(selectedId);
        if (bgCached && Date.now() - bgCached.at < BG_TTL_MS) {
          setServerBgShells(bgCached.shells);
          return;
        }
        getBackgroundShells(selectedId)
          .then((shells) => {
            bgCacheRef.current.set(selectedId, { at: Date.now(), shells });
            // Still cache it above (it belongs to `selectedId`, whenever it lands), but only the
            // open session may paint: this now runs after the transcript, so a slow scan can
            // easily outlive the switch away — and `serverBgShells` is one slot, not per-session.
            if (!closed) setServerBgShells(shells);
          })
          .catch(() => undefined);
      };
      // Open the stream once the seed above has established the resume point, so the SSE
      // streams only what's newer than the page (no full-history replay). The seed started at
      // t=0 and this block at t=SWITCH_DEBOUNCE_MS, so on a cache hit — or a seed that already
      // landed — this connects immediately.
      void (async () => {
        await seed;
        if (closed) return;
        // A window opened at a record waits for the reader to reach the tail (joinLiveRef).
        // The reader may have joined already while this startup was debounced.
        if (newerCursorRef.current === null && !es) connect();
        // Last, deliberately: the tray it feeds sits below the fold and nothing else waits on it,
        // whereas the scan behind it is the most expensive read on this path. Issuing it here
        // rather than alongside the seed keeps it from competing for the connection — and, on the
        // server, the event loop — with the one request the transcript is actually waiting for.
        loadBackgroundShells();
      })();
    }, SWITCH_DEBOUNCE_MS);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('online', retryNow);
    const watchdog = setInterval(() => {
      if (closed || paused || !es) return;
      if (document.visibilityState === 'hidden') return;
      if (Date.now() - lastMsgAt > WATCHDOG_SILENCE_MS) dropStream();
    }, WATCHDOG_TICK_MS);
    return () => {
      resumeStreamRef.current = null;
      openRecordRef.current = null;
      joinLiveRef.current = null;
      backToLatestRef.current = null;
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('online', retryNow);
      clearInterval(watchdog);
      clearTimeout(start);
      stop();
    };
  }, [selectedId, landingSession]);

  // A link to a record of the session already open — a footnote, a link in a message, back and
  // forward through them. The session effect above followed the record the session opened with.
  useEffect(() => {
    if (!selectedId || !recordAt) {
      followedRecordRef.current = null;
      return;
    }
    const key = `${selectedId} ${recordAt}`;
    if (followedRecordRef.current === key) return;
    followedRecordRef.current = key;
    openRecordRef.current?.(recordAt);
  }, [selectedId, recordAt]);

  // Polled fallback for idleness, in case an SSE turn_end was missed / reconnected.
  // Also keyed on selectedId so it re-syncs on a session switch: the SSE effect above
  // resets idle→false for the freshly opened session, but switching between two sessions
  // that share a status (both AWAITING_INPUT) wouldn't change `runStatus`, so without the
  // selectedId dep this effect wouldn't re-run and idle would stay wrongly false — flipping
  // turnActive on and hiding the worktree bar's "committed"/merge state until a refresh.
  useEffect(() => {
    // The normalized terminal outcome wins over a stale raw runStatus on rolling-upgrade payloads.
    // AWAITING_INPUT is equally conclusive here: the foreground command has returned, even if its
    // result/turn_end SSE was the event this tab missed.
    if (runTerminal || runStatus === 'AWAITING_INPUT') {
      setIdle(true);
      // SSE `tool_result`/`turn_end`/`final` normally clear this first. This is the missed-event
      // fallback: once the REST/control-plane poll observes idle/terminal, no live output is real.
      setLiveToolOutputState((current) =>
        clearLiveToolOutputsForSession(current, selectedId),
      );
    } else if (runStatus === 'RUNNING') setIdle(false);
  }, [runStatus, runTerminal, selectedId]);

  // A finalized session can be resumed in place (same selectedId, so the SSE effect above
  // doesn't re-run and its stream was paused on `final`). When the polled status shows it
  // live again, re-open the paused stream so the open transcript catches the resumed turn —
  // otherwise only the sidebar (separately polled) would advance and the conversation would
  // look stuck until a manual refresh.
  useEffect(() => {
    if (live) resumeStreamRef.current?.();
  }, [live]);

  // "Jump to the latest" from a detached window: the window is traded for a tail page.
  const backToLatest = useCallback(() => backToLatestRef.current?.(), []);

  return {
    events,
    eventsSessionId,
    transcriptEvents,
    visibleQueuedTurns,
    seeding,
    detached,
    loadingOlder,
    loadingNewer,
    streamingText,
    streamingThink,
    streamingDrafts,
    // Where the drafts belong (Transcript's `streamingAfterSeq`): the anchor as this render reads it.
    streamingAfterSeq: streamingDrafts ? streamAnchorRef.current : null,
    liveToolOutputs: scopedLiveToolOutputs,
    liveTaskProgress: scopedLiveTaskProgress,
    taskActivity,
    approvals,
    setApprovals,
    idle,
    setIdle,
    queued,
    setQueued,
    setAcceptedUserTurns,
    serverBgShells,
    loadOlder,
    loadNewer,
    hasOlderNow,
    oldestSeqNow,
    detachedNow,
    backToLatest,
    fetchEventFull,
  };
}

export type SessionStream = ReturnType<typeof useSessionStream>;
