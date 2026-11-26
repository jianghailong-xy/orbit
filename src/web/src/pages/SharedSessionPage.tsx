import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery, type QueryKey } from '@tanstack/react-query';
import { LoadingOutlined } from '@ant-design/icons';
import {
  fetchSharedArtifactObjectUrl,
  fetchSharedAttachmentObjectUrl,
  getSharedEventFull,
  getSharedEventPage,
  getSharedEventsAfter,
  getSharedSession,
  sharedStreamUrl,
  type SharedEvent,
  type SharedSessionNow,
} from '../api';
import { PublicShell } from '../components/PublicShell';
import {
  ArtifactResolverContext,
  AttachmentResolverContext,
  EventFullCtx,
  PublicLinkResolverCtx,
  type PublicLinkResolver,
  StreamingDraftsCtx,
  Transcript,
} from '../components/Transcript';
import { memoizeEventFull } from '../lib/eventFull';
import { routeId } from '../lib/idCodec';
import { projectLinkResolver, taskLinkResolver } from '../lib/publicLinks';
import {
  isSessionLive,
  isSessionWorking,
  sessionActivityOf,
  sessionLifecycleLabel,
  sessionLifecycleStateOf,
  sessionRunStateOf,
  sessionStateWord,
  type SessionRunState,
  type SessionStateSource,
} from '../lib/sessionState';
import { sessionDisplayState, sessionMarks } from '../lib/sessionDisplay';
import { SessionMarkChips, SessionStateGlyph } from '../components/SessionStateDisplay';
import { shortDate } from '../lib/shareLinks';
import { supersedesLiveDrafts } from '../lib/steerDelivery';
import { streamAnchorAfter } from '../lib/streamAnchor';
import { settleThinking } from '../lib/thinkingDraft';
import { openViewerStream, reconnectDelay, type ViewerFrame } from '../lib/viewerStream';
import { NEAR_BOTTOM, sampleTail } from '../lib/tailPinning';
import { titleFirstLine } from '../lib/title';
import type { SessionReach } from '../lib/sessionReach';

// Tail-first, like the app's own transcript (WorkspaceView): the page opens on the newest page and
// pulls in the one before it when the reader scrolls within LOAD_OLDER_AT px of the top.
const TAIL_PAGE = 200;
const OLDER_PAGE = 200;
const LOAD_OLDER_AT = 400;
// A live conversation is followed: asked what it has added since the newest event on the page,
// NEWER_PAGE at a time — every WORKING_POLL_MS while it works or has just moved, and every
// WAITING_POLL_MS while it waits on its owner, who may answer at any moment.
const NEWER_PAGE = 200;
export const WORKING_POLL_MS = 4_000;
const WAITING_POLL_MS = 30_000;

/** How long until a followed conversation is asked again, after an answer that did or did not bring
 *  anything new (`moved`); null once it has stopped and gone quiet — over, or filed Completed. */
export function followDelay(state: SessionStateSource, moved: boolean): number | null {
  // A turn the engine started for itself streams like a dispatched one, so it is followed as closely. A released
  // session reads RUNNING while an armed retry waits to re-send it, but nothing streams until the retry revives it,
  // which can be hours out on a spent quota: it is not followed at the working pace.
  if (moved || (isSessionLive(state) && isSessionWorking(state))) return WORKING_POLL_MS;
  if (isSessionLive(state) && sessionLifecycleStateOf(state) !== 'COMPLETED') return WAITING_POLL_MS;
  return null;
}

/**
 * The read of a link's root page — `/s/<token>`, whatever it opens. The page that decides what to
 * draw (SharedLinkPage) and a session link's page make the same read, so the second finds the first
 * one's answer and nothing is asked twice. `preview` is the owner's Preview, which is not a view.
 */
export const sharedRootQuery = (token: string, preview = false) => ({
  queryKey: ['shared', token] as QueryKey,
  // The share pages are drawn outside the control-plane stream (App.tsx `/s/` routes): no event reaches them.
  meta: { entities: ['session'], sessionReach: 'none' satisfies SessionReach },
  queryFn: () => getSharedSession(token, { limit: TAIL_PAGE, preview }),
  enabled: !!token,
  retry: false,
  // The pages scrolled in above sit right before the tail this page opened with; a tail read
  // again later could have moved on past it and leave a hole between the two.
  staleTime: Infinity,
});

/** A conversation's header as the follow last stated it: a `head` frame, or an `events?after=` answer. */
type SharedHead = Omit<SharedSessionNow, 'events' | 'after'>;

/** The reply being typed, as StreamingDraftsCtx carries it. */
type Drafts = { text: string; think: string; thinkStartedAt?: number };
const NO_DRAFTS: Drafts = { text: '', think: '' };

/** A session link shares the conversation and nothing it names: a task, project or other session
 *  it links to is outside the link, so each of those links is drawn as its words. */
const NOTHING_ELSE_SHARED: PublicLinkResolver = () => null;

/** What a public page shows while its link is being read. */
export function SharedLoading() {
  return (
    <div className="share-page">
      <div className="share-state">Loading…</div>
    </div>
  );
}

/** What a public page shows for a link that opens nothing — the same whatever the reason. */
export function SharedUnavailable() {
  return (
    <div className="share-page">
      <div className="share-state">
        <div className="share-state-title">This shared link isn’t available</div>
        <div className="share-state-desc">It may have been revoked, or the link is incorrect.</div>
      </div>
    </div>
  );
}

/** The status pill's colour for each run state, as the app's pills use them (index.css `.status-pill`). */
export const RUN_TONE: Record<SessionRunState, string> = {
  QUEUED: 'queued',
  RUNNING: 'running',
  AWAITING_INPUT: 'awaiting',
  SUCCEEDED: 'done',
  FAILED: 'failed',
  INTERRUPTED: 'cancelled',
  ENDED: 'cancelled',
};

/**
 * The pill's colour for a shared session's header: its run's, except where the run state alone says
 * the wrong thing. A parked session still working (sessionActivityOf) wears a live colour — the
 * spinner's for a turn, the in-progress square for a job or a wait — not the amber of a wait on its
 * reader; and an idle one whose reader cannot reply (`canReply: false`, a public link) is grey.
 */
export function sharedStateTone(head: SessionStateSource, canReply: boolean): string {
  // With the facts, the pill's colour is the state (`phase`) alone (lib/sessionDisplay): the spinner while it runs,
  // the queued pill while it waits for a slot, grey when idle. What follows is an older control plane's.
  const shown = sessionDisplayState(head);
  if (shown) return shown.phase === 'RUNNING' ? 'running' : shown.phase === 'PENDING' ? 'queued' : 'todo';
  if (sessionLifecycleStateOf(head) === 'COMPLETED') return 'done';
  const activity = sessionActivityOf(head);
  if (activity === 'TURN') return 'running';
  if (activity) return 'ongoing';
  const state = sessionRunStateOf(head);
  if (state === 'AWAITING_INPUT' && !canReply) return 'todo';
  return RUN_TONE[state];
}

/**
 * A shared or guest page's status: the pill with the state word, then, from a server that sends the facts, the state's
 * icon in the pill (the list row's), the marks and, for a filed session, Completed after the state rather than instead
 * of it (lib/sessionDisplay).
 */
export function SharedSessionStatus({ head, canReply }: { head: SessionStateSource; canReply: boolean }) {
  const tone = sharedStateTone(head, canReply);
  const shown = sessionDisplayState(head);
  const legacyIcon = tone === 'running' ? <LoadingOutlined spin /> : <span className="status-dot" />;
  const pill = (
    <span className={`status-pill ${tone}`}>
      {shown ? <SessionStateGlyph state={shown} size={12} /> : legacyIcon}
      {sessionStateWord(head, canReply ? {} : { canReply: false })}
    </span>
  );
  if (!shown) return pill;
  return (
    <>
      {pill}
      <SessionMarkChips marks={sessionMarks(head)} />
      {sessionLifecycleStateOf(head) === 'COMPLETED' && (
        <span className="share-badge">{sessionLifecycleLabel('COMPLETED')}</span>
      )}
    </>
  );
}

/**
 * Public, read-only view of a conversation a link shares: a session link's own (`/s/<token>`), or
 * one the link opens besides its root — a task link's run (`/s/<token>/c/<id>`). No auth, no app
 * shell — anyone with the link sees the transcript only, in the frame every public page shares
 * (PublicShell), whose breadcrumb is the link's scope: the task › this run, under a task link.
 * Images load through the public share-attachment route (AttachmentResolverContext), so a
 * logged-out viewer still sees them. Links to anything the conversation names go where the link's
 * scope sends them (PublicLinkResolverCtx): under a task link, the task and its runs to their pages
 * here; everything else, and everything a session link's conversation names, is words.
 *
 * One page per conversation: a link from one run to another is the same route with another id, so
 * the page is keyed by it — the pages scrolled in above, the cursor to the next one and where the
 * reader landed all belong to the conversation they were read from.
 */
export function SharedSessionPage() {
  const { token = '', sessionId } = useParams();
  return <SharedConversation key={`${token}/${sessionId ?? ''}`} />;
}

function SharedConversation() {
  const { token = '', sessionId: sessionParam } = useParams();
  // A conversation under the link rather than its root, in the spelling every id here has.
  const sessionId = sessionParam ? routeId(sessionParam) ?? undefined : undefined;
  const { data, isLoading, isError } = useQuery(
    sessionId
      ? {
          queryKey: ['shared', token, 'c', sessionId] as QueryKey,
          meta: { entities: ['session'], sessionReach: 'none' satisfies SessionReach },
          queryFn: () => getSharedSession(token, { limit: TAIL_PAGE, sessionId }),
          enabled: !!token,
          retry: false,
          staleTime: Infinity,
        }
      : sharedRootQuery(token),
  );
  const resolve = useMemo(() => (id: string) => fetchSharedAttachmentObjectUrl(token, id), [token]);
  // Stored artifacts are served for a session link's own transcript; a run under a task link draws
  // a legacy artifact path as its chip.
  const resolveArtifact = useMemo(
    () => (sessionId ? null : (artifactPath: string) => fetchSharedArtifactObjectUrl(token, artifactPath)),
    [token, sessionId],
  );
  // A card that arrived clipped fetches its whole payload when it is opened, once (lib/eventFull).
  const fetchFull = useMemo(
    () => memoizeEventFull((seq: number) => getSharedEventFull(token, seq, sessionId)),
    [token, sessionId],
  );
  // Where the conversation's links go: under a project link, wherever its scope sends them; under a
  // task link, to the run's task and the task's other runs; under a session link, nowhere.
  const task = data?.task ?? null;
  const project = data?.project;
  const linkScope = data?.scope;
  const scope = useMemo(
    () =>
      linkScope
        ? projectLinkResolver(token, {
            projectId: linkScope.projectId,
            taskIds: linkScope.tasks.map((t) => t.id),
            sessionIds: linkScope.conversations.map((c) => c.id),
          })
        : task
          ? taskLinkResolver(token, { taskId: task.id, runSessionIds: task.runs.map((run) => run.sessionId) })
          : NOTHING_ELSE_SHARED,
    [token, task, linkScope],
  );
  // The pages scrolled in above the tail, oldest first.
  const [older, setOlder] = useState<SharedEvent[]>([]);
  const [loadingOlder, setLoadingOlder] = useState(false);
  // Where the next older page starts, and whether there is one. Outside render, so a scroll landing
  // between a page's arrival and its render asks for the next page rather than the same one again.
  const cursorRef = useRef<{ before: number; hasMore: boolean } | null>(null);
  const inFlightRef = useRef(false);
  const scrollRef = useRef<HTMLElement>(null);
  // Set just before a page is prepended, so the reader's place holds while it grows above them.
  const anchorRef = useRef<{ prevHeight: number; prevTop: number } | null>(null);
  const landedRef = useRef(false);
  // What the conversation has added since the page opened, oldest first, and its header as the
  // newest answer gave it — both from following it while it is live.
  const [newer, setNewer] = useState<SharedEvent[]>([]);
  const [now, setNow] = useState<SharedHead | null>(null);
  // The reply being written, as the stream types it out (text_delta / thinking_delta), and the seq
  // it is drawn after (Transcript's `streamingAfterSeq`).
  const [drafts, setDrafts] = useState<Drafts>(NO_DRAFTS);
  const [draftsAfter, setDraftsAfter] = useState<number | null>(null);
  // The stream said the link no longer opens this conversation.
  const [gone, setGone] = useState(false);
  // Set when newer events land under a reader who is at the end, so the end stays in view.
  const followRef = useRef(false);

  const events = useMemo(() => [...older, ...(data?.events ?? []), ...newer], [older, data, newer]);
  // The header as it stands now.
  const head = now ?? data;

  const loadOlder = useCallback(() => {
    const cursor =
      cursorRef.current ??
      (data?.events.length ? { before: data.events[0].seq, hasMore: !!data.hasMore } : null);
    if (inFlightRef.current || !cursor?.hasMore) return;
    inFlightRef.current = true;
    setLoadingOlder(true);
    getSharedEventPage(token, { before: cursor.before, limit: OLDER_PAGE, sessionId })
      .then((page) => {
        cursorRef.current = {
          before: page.events.length ? page.events[0].seq : cursor.before,
          hasMore: page.hasMore && page.events.length > 0,
        };
        const el = scrollRef.current;
        if (el) anchorRef.current = { prevHeight: el.scrollHeight, prevTop: el.scrollTop };
        setOlder((prev) => [...page.events, ...prev]);
      })
      .catch(() => undefined) // the next scroll asks again
      .finally(() => {
        inFlightRef.current = false;
        setLoadingOlder(false);
      });
  }, [token, sessionId, data]);

  // Open where the conversation is read from: its first message when all of it is here, and its
  // latest when the page holds only the newest part of it.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!data || !el || landedRef.current) return;
    landedRef.current = true;
    if (data.hasMore) el.scrollTop = el.scrollHeight;
  }, [data]);

  // Keep the reader's place when an older page lands above it.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const anchor = anchorRef.current;
    if (!el || !anchor) return;
    anchorRef.current = null;
    el.scrollTop = el.scrollHeight - anchor.prevHeight + anchor.prevTop;
  }, [events]);
  // Keep a reader who was at the end at the end when newer events land below; one who scrolled up
  // stays where they are.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !followRef.current) return;
    followRef.current = false;
    el.scrollTop = el.scrollHeight;
  }, [events, drafts]);
  // What is loaded may not reach LOAD_OLDER_AT above the viewport, and then there is nothing to
  // scroll up through: pull the next page in without waiting for a scroll that cannot happen.
  // (No layout at all, as in jsdom, is not a short page.)
  useEffect(() => {
    const el = scrollRef.current;
    if (el && el.clientHeight > 0 && el.scrollTop < LOAD_OLDER_AT) loadOlder();
  }, [events, loadOlder]);

  // Follow a live conversation over its stream (docs/session-viewer-stream-design.md §7): durable
  // events go below, merged by seq; the reply is drawn as it is typed; `head` frames redraw the
  // header. A dropped stream is opened again from the newest seq on the page, after a backoff; a tab
  // nobody is looking at holds none, and opens it again when looked at. A stream that cannot be
  // opened at all — a server from before it, the anonymous caps, a network that will not carry it —
  // leaves the page on the polling follow below, as it was before the stream.
  useEffect(() => {
    if (!data) return;
    // Events at or before the opening page's newest are already drawn; `after` is the newest drawn.
    const floor = data.events.at(-1)?.seq ?? 0;
    let after = floor;
    const held = new Set<number>();
    let state: SessionStateSource = data;
    let stopped = false;
    let stopPolling: (() => void) | null = null;

    /** Put durable events below what is drawn, in seq order, each once. */
    const land = (added: SharedEvent[]): void => {
      const fresh = added.filter((e) => e.seq > floor && !held.has(e.seq));
      if (!fresh.length) return;
      for (const e of fresh) {
        held.add(e.seq);
        after = Math.max(after, e.seq);
      }
      const el = scrollRef.current;
      followRef.current = !!el && sampleTail(el).bottomGap <= NEAR_BOTTOM;
      setNewer((prev) => [...prev, ...fresh].sort((a, b) => a.seq - b.seq));
    };

    // Ask what it has added since the newest event on the page, put it below, and redraw the header
    // from the same answer — at once while more are waiting, else on followDelay's clock. A tab
    // nobody is looking at asks nothing; it catches up when looked at.
    const poll = (): (() => void) => {
      let delay = followDelay(state, false);
      let timer: ReturnType<typeof setTimeout> | undefined;
      let parked = false;
      let done = false;
      const read = () => {
        if (document.hidden) {
          parked = true;
          return;
        }
        getSharedEventsAfter(token, { after, limit: NEWER_PAGE, sessionId })
          .then((answer) => {
            if (done) return;
            const added = answer.events.filter((e) => e.seq > after);
            land(added);
            // A server from before `after` answers with its tail page alone; the header stands.
            if (answer.status !== undefined) {
              state = answer;
              setNow(answer);
            }
            delay = answer.after != null ? 0 : followDelay(state, added.length > 0);
          })
          .catch(() => {
            // Asked again on the same clock, but never at once: a refusal is not more to catch up on.
            delay = Math.max(delay ?? 0, WORKING_POLL_MS);
          })
          .finally(() => {
            if (done || delay === null) return;
            if (delay === 0) read();
            else timer = setTimeout(read, delay);
          });
      };
      const onVisibility = () => {
        if (document.hidden || !parked) return;
        parked = false;
        read();
      };
      document.addEventListener('visibilitychange', onVisibility);
      if (delay !== null) timer = setTimeout(read, delay);
      return () => {
        done = true;
        clearTimeout(timer);
        document.removeEventListener('visibilitychange', onVisibility);
      };
    };

    // A conversation over and quiet is followed no more, over the stream or otherwise.
    if (followDelay(data, false) === null) return;

    // The reply being typed. Local, so a delta appends to what the last one left; drawn through
    // `setDrafts`. `anchor` is where it sits (lib/streamAnchor).
    let text = '';
    let think = '';
    let thinkStartedAt: number | null = null;
    let anchor: number | null = null;
    const drawDrafts = () => {
      setDrafts(text || think ? { text, think, thinkStartedAt: thinkStartedAt ?? undefined } : NO_DRAFTS);
      setDraftsAfter(anchor);
    };
    // A stream that ends mid-reply loses the chunks sent while it was closed, and deltas are never
    // replayed: what was typed so far goes, and the durable reply (or the next chunks) replace it.
    const dropDrafts = () => {
      text = '';
      think = '';
      thinkStartedAt = null;
      anchor = null;
      drawDrafts();
    };

    let close: (() => void) | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    // Whether a stream has opened on this page: until one has, a refusal means the stream is not to
    // be had, and the page polls instead.
    let streamed = false;

    const fallBack = () => {
      if (stopped || stopPolling) return;
      stopStream();
      stopPolling = poll();
    };
    const stopStream = () => {
      close?.();
      close = null;
      clearTimeout(retry);
      retry = undefined;
      dropDrafts();
    };
    const linkGone = () => {
      stopStream();
      stopped = true;
      setGone(true);
    };
    const onFrame = (frame: ViewerFrame) => {
      attempt = 0;
      switch (frame.type) {
        case 'ping':
          return;
        case 'head':
          state = frame.payload as SharedHead;
          setNow(frame.payload as SharedHead);
          return;
        case 'gone':
          linkGone();
          return;
        case 'resync':
          // The gap since `after` is longer than the stream replays: read it a page at a time, then
          // open the stream again from its end.
          stopStream();
          void catchUp().then(
            () => connect(),
            () => fallBack(),
          );
          return;
        case 'text_delta':
        case 'thinking_delta': {
          const chunk = frame.payload?.text;
          if (typeof chunk !== 'string') return;
          anchor = streamAnchorAfter(anchor, { type: frame.type, seq: frame.seq ?? 0 }, after);
          if (frame.type === 'text_delta') text += chunk;
          else {
            think += chunk;
            thinkStartedAt ??= Date.now();
          }
          const el = scrollRef.current;
          followRef.current = !!el && sampleTail(el).bottomGap <= NEAR_BOTTOM;
          drawDrafts();
          return;
        }
        // A running tool's output as it is written: the public transcript draws only its end.
        case 'tool_output':
        case 'background_output':
          return;
      }
      if (typeof frame.seq !== 'number' || frame.seq <= 0 || frame.seq === Number.MAX_SAFE_INTEGER) return;
      let ev = { seq: frame.seq, type: frame.type, payload: frame.payload, turnId: frame.turnId ?? null, ts: frame.ts ?? '' } as SharedEvent;
      if (frame.truncated) ev.truncated = true;
      // A block the provider closed with no text keeps what was typed of it (lib/thinkingDraft).
      if (ev.type === 'thinking') {
        const patch = settleThinking(ev.payload, think, thinkStartedAt, Date.now());
        if (Object.keys(patch).length) ev = { ...ev, payload: { ...ev.payload, ...patch } };
      }
      land([ev]);
      // The whole reply, or the end of its turn, replaces what was typed of it.
      if (supersedesLiveDrafts(ev) || (ev.type === 'system' && ev.payload?.subtype === 'resumed')) {
        text = '';
        think = '';
        thinkStartedAt = null;
      } else if (ev.type === 'thinking') {
        think = '';
        thinkStartedAt = null;
      }
      anchor = streamAnchorAfter(anchor, ev, after);
      drawDrafts();
    };
    const catchUp = async (): Promise<void> => {
      for (;;) {
        const answer = await getSharedEventsAfter(token, { after, limit: NEWER_PAGE, sessionId });
        if (stopped) return;
        const before = after;
        land(answer.events.filter((e) => e.seq > after));
        if (answer.status !== undefined) {
          state = answer;
          setNow(answer);
        }
        if (answer.after == null || after === before) return;
      }
    };
    const connect = () => {
      if (stopped || stopPolling || close) return;
      // A hidden tab opens nothing; it opens the stream when it is looked at again.
      if (document.hidden) return;
      close = openViewerStream(sharedStreamUrl(token, { sinceSeq: after, sessionId }), {
        frame: onFrame,
        end: ({ opened, status }) => {
          close = null;
          if (opened) streamed = true;
          // Never opened, or over the anonymous caps on reopening one that did: the page polls.
          if (!streamed || (!opened && status === 429)) return fallBack();
          // A link that opened a stream before and is refused now has been revoked, or no longer
          // opens this conversation.
          if (!opened && status === 404) return linkGone();
          dropDrafts();
          if (document.hidden) return;
          retry = setTimeout(connect, reconnectDelay(attempt));
          attempt += 1;
        },
      });
    };
    const onVisibility = () => {
      if (stopped || stopPolling) return;
      if (document.hidden) {
        stopStream();
        return;
      }
      attempt = 0;
      connect();
    };
    document.addEventListener('visibilitychange', onVisibility);
    connect();
    return () => {
      stopped = true;
      close?.();
      clearTimeout(retry);
      stopPolling?.();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [token, sessionId, data]);

  // Reflect the session title in the browser tab (and thus the shared-link preview). The
  // static index.html ships <title>Orbit</title>, so without this a shared link's tab just
  // reads "Orbit". Use the first line only — a fallback title can be a multi-line prompt —
  // and restore the previous title on unmount so leaving the page doesn't strand it.
  useEffect(() => {
    if (!head?.title) return;
    const prev = document.title;
    document.title = `${titleFirstLine(head.title)} — Orbit`;
    return () => {
      document.title = prev;
    };
  }, [head?.title]);

  if (isLoading) return <SharedLoading />;
  if (isError || gone || !head) return <SharedUnavailable />;
  // A public link's reader cannot reply, so an idle session is not waiting on them (SharedSessionStatus).
  return (
    <PublicShell
      crumbs={
        project
          ? // Project › Task › Run, or Project › Coordinator: the project's page, then the task's.
            [
              { label: titleFirstLine(project.title), to: `/s/${encodeURIComponent(token)}` },
              ...(task
                ? [
                    {
                      label: titleFirstLine(task.title),
                      to: scope({ kind: 'task', id: task.id }) ?? undefined,
                    },
                    { label: `Run · ${shortDate(head.createdAt)}` },
                  ]
                : [{ label: 'Coordinator' }]),
            ]
          : task
            ? [
                { label: titleFirstLine(task.title), to: `/s/${encodeURIComponent(token)}` },
                { label: `Run · ${shortDate(head.createdAt)}` },
              ]
            : [{ label: titleFirstLine(head.title) }]
      }
      status={<SharedSessionStatus head={head} canReply={false} />}
      scrollRef={scrollRef}
      onScroll={(e) => {
        if (e.currentTarget.scrollTop < LOAD_OLDER_AT) loadOlder();
      }}
    >
      {loadingOlder && (
        <div className="chat-older-top">
          <span className="chat-older-pill">Loading earlier messages…</span>
        </div>
      )}
      <PublicLinkResolverCtx.Provider value={scope}>
        <AttachmentResolverContext.Provider value={resolve}>
          <ArtifactResolverContext.Provider value={resolveArtifact}>
            <EventFullCtx.Provider value={fetchFull}>
              <StreamingDraftsCtx.Provider value={drafts}>
                <Transcript events={events} streamingAfterSeq={draftsAfter} />
              </StreamingDraftsCtx.Provider>
            </EventFullCtx.Provider>
          </ArtifactResolverContext.Provider>
        </AttachmentResolverContext.Provider>
      </PublicLinkResolverCtx.Provider>
    </PublicShell>
  );
}
