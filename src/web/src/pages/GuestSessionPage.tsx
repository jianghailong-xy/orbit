import { ArrowUpOutlined, LoadingOutlined } from '@ant-design/icons';
import { queryOptions, useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Navigate, useParams } from 'react-router-dom';
import {
  ApiError,
  getGuestEventFull,
  getGuestEventPage,
  getGuestEventsAfter,
  getGuestSession,
  sendGuestTurn,
  type GuestSessionNow,
  type SharedEvent,
} from '../api';
import { EventFullCtx, PublicLinkResolverCtx, type PublicLinkResolver, Transcript } from '../components/Transcript';
import { memoizeEventFull } from '../lib/eventFull';
import { meQuery } from '../lib/queries';
import { newRunRequestToken } from '../lib/runRequestToken';
import {
  isSessionLive,
  sessionLifecycleStateOf,
  sessionStateWord,
  type SessionStateSource,
} from '../lib/sessionState';
import { NEAR_BOTTOM, sampleTail } from '../lib/tailPinning';
import { titleFirstLine } from '../lib/title';
import { followDelay, sharedStateTone, WORKING_POLL_MS } from './SharedSessionPage';

const TAIL_PAGE = 200;
const OLDER_PAGE = 200;
const NEWER_PAGE = 200;
const LOAD_OLDER_AT = 400;

/** What the guest door answers for every session the caller cannot reply in (§4): removed, left, Trash or deleted. */
export const GUEST_NOT_SHARED = 'This conversation is no longer shared with you.';

/** The guest page's words for each state of the session (docs/session-guests-design.md §4). */
export const guestCopy = {
  placeholder: (owner: string) => `Message ${owner}’s agent…`,
  runsOn: (owner: string) => `Runs on ${owner}’s machine`,
  waiting: (owner: string) => `Waiting for ${owner} to approve`,
  waitsItsTurn: 'Your message waits its turn',
  restarts: (owner: string) => `Send to continue — this restarts the session on ${owner}’s machine.`,
};

/** A guest page names nothing outside the conversation: every link it holds is drawn as its words. */
const NOTHING_ELSE_SHARED: PublicLinkResolver = () => null;

const isGone = (e: unknown) => e instanceof ApiError && e.status === 404;

/**
 * `/g/<sessionId>`, the guest page's first address: a session shared with you now opens at the same `/sessions/<id>`
 * its owner opens (board docs/mocks/share-links/11-guest-one-link, D8), so an old link goes there.
 */
export function GuestLinkRedirect() {
  const { sessionId = '' } = useParams();
  return <Navigate to={`/sessions/${sessionId}`} replace />;
}

/**
 * The guest view (docs/session-guests-design.md §4; boards docs/mocks/share-links/10-session-guests-3 and
 * 11-guest-one-link-2): a session someone invited you to reply in, drawn in your own app where `/sessions/<id>`
 * finds no session of yours (D9). Its head — title, `Shared by <owner>`, the session's status and a Guest badge —
 * over the Transcript the guest door projects, followed as the public page follows it, and a composer that only
 * takes text: no mode, model or effort, no `!` shell, no attachments. A message is a turn of the owner's session, on
 * the owner's machine; one to an ended session restarts it there.
 */
export function GuestSessionView({ sessionId }: { sessionId: string }) {
  return <GuestConversation key={sessionId} sessionId={sessionId} />;
}

/**
 * The guest door's read of a session, and its newest page: what the guest view opens on, and what `/sessions/<id>`
 * asks once the owner's read has found no session of yours there. One query, so the view opens on the answer the
 * question already fetched.
 */
export const guestSessionQuery = (sessionId: string) =>
  queryOptions({
    queryKey: ['guest-session', sessionId] as const,
    queryFn: () => getGuestSession(sessionId, TAIL_PAGE),
    retry: false,
    staleTime: Infinity,
  });

function GuestConversation({ sessionId }: { sessionId: string }) {
  const { data, isLoading, error } = useQuery(guestSessionQuery(sessionId));
  const me = useQuery(meQuery());
  const fetchFull = useMemo(() => memoizeEventFull((seq: number) => getGuestEventFull(sessionId, seq)), [sessionId]);

  const [older, setOlder] = useState<SharedEvent[]>([]);
  const [newer, setNewer] = useState<SharedEvent[]>([]);
  const [now, setNow] = useState<GuestSessionNow | null>(null);
  const [gone, setGone] = useState(false);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  // Bumped by a send, so the follow loop asks at once for the echo and the run it started.
  const [kick, setKick] = useState(0);
  const afterRef = useRef(0);
  const cursorRef = useRef<{ before: number; hasMore: boolean } | null>(null);
  const inFlightRef = useRef(false);
  const scrollRef = useRef<HTMLElement>(null);
  const anchorRef = useRef<{ prevHeight: number; prevTop: number } | null>(null);
  const followRef = useRef(false);
  const landedRef = useRef(false);

  // The guest's own words read `You`, as the owner's read in their own app; anyone else's keep `From <name>`.
  const myName = me.data?.name?.trim() || null;
  const events = useMemo(() => {
    const all = [...older, ...(data?.events ?? []), ...newer];
    if (!myName) return all;
    return all.map((e) =>
      e.type === 'user' && e.payload?.externalSender?.source === 'ORBIT_GUEST' && e.payload.externalSender.name?.trim() === myName
        ? { ...e, payload: { ...e.payload, externalSender: undefined, sentByReader: true } }
        : e,
    );
  }, [older, data, newer, myName]);
  const head = now ?? data;

  useEffect(() => {
    if (data) afterRef.current = Math.max(afterRef.current, data.events.at(-1)?.seq ?? 0);
  }, [data]);

  const loadOlder = useCallback(() => {
    const cursor =
      cursorRef.current ?? (data?.events.length ? { before: data.events[0].seq, hasMore: !!data.hasMore } : null);
    if (inFlightRef.current || !cursor?.hasMore) return;
    inFlightRef.current = true;
    getGuestEventPage(sessionId, { before: cursor.before, limit: OLDER_PAGE })
      .then((page) => {
        cursorRef.current = {
          before: page.events.length ? page.events[0].seq : cursor.before,
          hasMore: page.hasMore && page.events.length > 0,
        };
        const el = scrollRef.current;
        if (el) anchorRef.current = { prevHeight: el.scrollHeight, prevTop: el.scrollTop };
        setOlder((prev) => [...page.events, ...prev]);
      })
      .catch((e) => {
        if (isGone(e)) setGone(true);
      })
      .finally(() => {
        inFlightRef.current = false;
      });
  }, [sessionId, data]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!data || !el || landedRef.current) return;
    landedRef.current = true;
    el.scrollTop = el.scrollHeight;
  }, [data]);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const anchor = anchorRef.current;
    if (anchor) {
      anchorRef.current = null;
      el.scrollTop = el.scrollHeight - anchor.prevHeight + anchor.prevTop;
    } else if (followRef.current) {
      followRef.current = false;
      el.scrollTop = el.scrollHeight;
    }
  }, [events]);

  // Follow the conversation the way the public page does (SharedSessionPage): ask what it has added since the newest
  // event on the page, every few seconds while it works and every half minute while it waits, and stop once it is
  // over. A send asks at once, and keeps asking while the run it started is under way.
  useEffect(() => {
    if (!data || gone) return;
    let state: SessionStateSource = now ?? data;
    let delay = kick > 0 ? 0 : followDelay(state, false);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    let parked = false;
    // A send that restarts an ended session is not over until the run it started has been seen.
    let expecting = kick > 0;
    const read = () => {
      if (document.hidden) {
        parked = true;
        return;
      }
      getGuestEventsAfter(sessionId, { after: afterRef.current, limit: NEWER_PAGE })
        .then((answer) => {
          if (stopped) return;
          const added = answer.events.filter((e) => e.seq > afterRef.current);
          if (added.length) {
            afterRef.current = added[added.length - 1].seq;
            const el = scrollRef.current;
            followRef.current = !el || sampleTail(el).bottomGap <= NEAR_BOTTOM;
            setNewer((prev) => [...prev, ...added]);
          }
          state = answer;
          setNow(answer);
          if (isSessionLive(answer)) expecting = false;
          delay = answer.after != null ? 0 : (followDelay(state, added.length > 0) ?? (expecting ? WORKING_POLL_MS : null));
        })
        .catch((e) => {
          if (isGone(e)) {
            setGone(true);
            delay = null;
            return;
          }
          delay = Math.max(delay ?? 0, WORKING_POLL_MS);
        })
        .finally(() => {
          if (stopped || delay === null) return;
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
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
    // `now` is read once as where the loop starts; following it would restart the loop on every answer.
  }, [sessionId, data, gone, kick]);

  useEffect(() => {
    if (!head?.title) return;
    const prev = document.title;
    document.title = `${titleFirstLine(head.title)} — Orbit`;
    return () => {
      document.title = prev;
    };
  }, [head?.title]);

  const send = () => {
    const content = draft.trim();
    if (!content || sending) return;
    setSending(true);
    setSendError(null);
    sendGuestTurn(sessionId, { clientTurnId: newRunRequestToken(), content })
      .then(() => {
        setDraft('');
        setKick((k) => k + 1);
      })
      .catch((e) => {
        if (isGone(e)) setGone(true);
        else setSendError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => setSending(false));
  };

  if (isLoading) {
    return (
      <div className="share-page guest-view">
        <div className="share-state">Loading…</div>
      </div>
    );
  }
  if (gone || error || !head || !data) {
    return (
      <div className="share-page guest-view">
        <div className="share-state">
          <div className="share-state-title">{GUEST_NOT_SHARED}</div>
          <div className="share-state-desc">Ask the person who shared it if you need it again.</div>
        </div>
      </div>
    );
  }

  const owner = data.ownerName;
  const completed = sessionLifecycleStateOf(head) === 'COMPLETED';
  const tone = sharedStateTone(head, true);
  const live = isSessionLive(head) && !completed;
  const waiting = live && head.waitingOnOwner === true;
  const hint = !live ? guestCopy.restarts(owner) : waiting ? guestCopy.waitsItsTurn : guestCopy.runsOn(owner);

  const composer = (
    <div className="guest-dock">
      <div className="guest-dock-inner">
        {waiting && (
          <div className="guest-waiting" role="status">
            <i aria-hidden />
            {guestCopy.waiting(owner)}
          </div>
        )}
        <form
          className="guest-composer"
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
        >
          <textarea
            className="guest-composer-input"
            aria-label="Message"
            placeholder={guestCopy.placeholder(owner)}
            rows={1}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              }
            }}
          />
          <div className="guest-composer-foot">
            <span className={`guest-composer-hint${sendError ? ' is-error' : ''}`}>{sendError ?? hint}</span>
            <button
              type="submit"
              className="guest-composer-send"
              aria-label="Send"
              disabled={!draft.trim() || sending}
            >
              {sending ? <LoadingOutlined spin /> : <ArrowUpOutlined />}
            </button>
          </div>
        </form>
      </div>
    </div>
  );

  return (
    <div className="share-page guest-view">
      <header className="share-header">
        <div className="share-crumbs">
          <span className="share-crumb is-here" title={titleFirstLine(head.title)}>
            {titleFirstLine(head.title)}
          </span>
          <span className="share-subtitle">Shared by {owner}</span>
        </div>
        <div className="share-right">
          <span className={`status-pill ${tone}`}>
            {tone === 'running' ? <LoadingOutlined spin /> : <span className="status-dot" />}
            {sessionStateWord(head)}
          </span>
          <span className="share-badge">Guest</span>
        </div>
      </header>
      <main
        className="share-scroll"
        ref={scrollRef}
        onScroll={(e) => {
          if (e.currentTarget.scrollTop < LOAD_OLDER_AT) loadOlder();
        }}
      >
        <div className="share-inner">
          <PublicLinkResolverCtx.Provider value={NOTHING_ELSE_SHARED}>
            <EventFullCtx.Provider value={fetchFull}>
              <Transcript events={events} />
            </EventFullCtx.Provider>
          </PublicLinkResolverCtx.Provider>
        </div>
      </main>
      {composer}
    </div>
  );
}
