import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { LoadingOutlined } from '@ant-design/icons';
import {
  fetchSharedArtifactObjectUrl,
  fetchSharedAttachmentDataUrl,
  fetchSharedAttachmentObjectUrl,
  getSharedEventFull,
  getSharedEventPage,
  getSharedSession,
  type SharedEvent,
} from '../api';
import { PublicShell } from '../components/PublicShell';
import {
  ArtifactResolverContext,
  AttachmentResolverContext,
  EventFullCtx,
  PublicLinkResolverCtx,
  type PublicLinkResolver,
  Transcript,
} from '../components/Transcript';
import { memoizeEventFull } from '../lib/eventFull';
import {
  sessionLifecycleStateOf,
  sessionRunStateOf,
  sessionStateWord,
  type SessionRunState,
} from '../lib/sessionState';
import { titleFirstLine } from '../lib/title';

// Tail-first, like the app's own transcript (WorkspaceView): the page opens on the newest page and
// pulls in the one before it when the reader scrolls within LOAD_OLDER_AT px of the top.
const TAIL_PAGE = 200;
const OLDER_PAGE = 200;
const LOAD_OLDER_AT = 400;
// Download HTML reads the transcript whole, in the largest pages the share serves.
const EXPORT_PAGE = 500;

/** A session link shares the conversation and nothing it names: a task, project or other session
 *  it links to is outside the link, so each of those links is drawn as its words. */
const NOTHING_ELSE_SHARED: PublicLinkResolver = () => null;

/** The status pill's colour for each run state, as the app's pills use them (index.css `.status-pill`). */
const RUN_TONE: Record<SessionRunState, string> = {
  QUEUED: 'queued',
  RUNNING: 'running',
  AWAITING_INPUT: 'awaiting',
  SUCCEEDED: 'done',
  FAILED: 'failed',
  INTERRUPTED: 'cancelled',
  ENDED: 'cancelled',
};

/** Every event of the shared transcript, unclipped: from the newest page back to the first. */
async function wholeTranscript(token: string): Promise<SharedEvent[]> {
  const pages: SharedEvent[][] = [];
  let before: number | undefined;
  for (;;) {
    const page = await getSharedEventPage(token, { before, limit: EXPORT_PAGE, whole: true });
    pages.unshift(page.events);
    if (!page.hasMore || page.events.length === 0) return pages.flat();
    before = page.events[0].seq;
  }
}

/**
 * Public, read-only view of a session shared via its token (`/s/<token>`). No auth, no app
 * shell — anyone with the link sees the transcript only, in the frame every public page shares
 * (PublicShell). Images load through the public share-attachment route (AttachmentResolverContext),
 * so a logged-out viewer still sees them; links to anything the session names are words
 * (PublicLinkResolverCtx), since none of it is shared.
 */
export function SharedSessionPage() {
  const { token = '' } = useParams();
  const { data, isLoading, isError } = useQuery({
    queryKey: ['shared', token],
    queryFn: () => getSharedSession(token, { limit: TAIL_PAGE }),
    enabled: !!token,
    retry: false,
    // The pages scrolled in above sit right before the tail this page opened with; a tail read
    // again later could have moved on past it and leave a hole between the two.
    staleTime: Infinity,
  });
  const resolve = useMemo(() => (id: string) => fetchSharedAttachmentObjectUrl(token, id), [token]);
  const resolveArtifact = useMemo(() => (artifactPath: string) => fetchSharedArtifactObjectUrl(token, artifactPath), [token]);
  // A card that arrived clipped fetches its whole payload when it is opened, once (lib/eventFull).
  const fetchFull = useMemo(() => memoizeEventFull((seq: number) => getSharedEventFull(token, seq)), [token]);
  const [downloading, setDownloading] = useState(false);

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

  const events = useMemo(() => [...older, ...(data?.events ?? [])], [older, data]);

  const loadOlder = useCallback(() => {
    const cursor =
      cursorRef.current ??
      (data?.events.length ? { before: data.events[0].seq, hasMore: !!data.hasMore } : null);
    if (inFlightRef.current || !cursor?.hasMore) return;
    inFlightRef.current = true;
    setLoadingOlder(true);
    getSharedEventPage(token, { before: cursor.before, limit: OLDER_PAGE })
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
  }, [token, data]);

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
  // What is loaded may not reach LOAD_OLDER_AT above the viewport, and then there is nothing to
  // scroll up through: pull the next page in without waiting for a scroll that cannot happen.
  // (No layout at all, as in jsdom, is not a short page.)
  useEffect(() => {
    const el = scrollRef.current;
    if (el && el.clientHeight > 0 && el.scrollTop < LOAD_OLDER_AT) loadOlder();
  }, [events, loadOlder]);

  // Reflect the session title in the browser tab (and thus the shared-link preview). The
  // static index.html ships <title>Orbit</title>, so without this a shared link's tab just
  // reads "Orbit". Use the first line only — a fallback title can be a multi-line prompt —
  // and restore the previous title on unmount so leaving the page doesn't strand it.
  useEffect(() => {
    if (!data?.title) return;
    const prev = document.title;
    document.title = `${titleFirstLine(data.title)} — Orbit`;
    return () => {
      document.title = prev;
    };
  }, [data?.title]);

  // Build the same self-contained HTML the app's export produces, from the whole transcript rather
  // than the pages scrolled in so far, with images embedded through the public share route so a
  // logged-out viewer's saved file still shows them.
  const download = async () => {
    if (!data || downloading) return;
    setDownloading(true);
    try {
      const [whole, { exportSessionHtml }] = await Promise.all([
        wholeTranscript(token),
        import('../lib/sessionExport'),
      ]);
      await exportSessionHtml(
        {
          id: token,
          title: data.title,
          status: sessionRunStateOf(data),
          createdAt: data.createdAt,
          workspace: { name: data.workspaceName },
        },
        whole,
        (id) => fetchSharedAttachmentDataUrl(token, id),
        NOTHING_ELSE_SHARED,
      );
    } catch (e) {
      console.error('Download failed', e);
    } finally {
      setDownloading(false);
    }
  };

  if (isLoading) {
    return (
      <div className="share-page">
        <div className="share-state">Loading…</div>
      </div>
    );
  }
  if (isError || !data) {
    return (
      <div className="share-page">
        <div className="share-state">
          <div className="share-state-title">This shared link isn’t available</div>
          <div className="share-state-desc">It may have been revoked, or the link is incorrect.</div>
        </div>
      </div>
    );
  }
  const tone =
    sessionLifecycleStateOf(data) === 'COMPLETED' ? 'done' : RUN_TONE[sessionRunStateOf(data)];
  return (
    <PublicShell
      crumbs={[{ label: titleFirstLine(data.title) }]}
      status={
        <span className={`status-pill ${tone}`}>
          {tone === 'running' ? <LoadingOutlined spin /> : <span className="status-dot" />}
          {sessionStateWord(data)}
        </span>
      }
      actions={
        <button
          className="share-download"
          onClick={download}
          disabled={downloading || data.events.length === 0}
          aria-label="Download this conversation as a self-contained HTML file"
          title="Download this conversation as a self-contained HTML file"
        >
          {downloading ? (
            <span className="share-download-spin" aria-hidden />
          ) : (
            <svg
              className="share-download-icon"
              viewBox="0 0 24 24"
              width="16"
              height="16"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
          )}
          <span className="share-download-label">{downloading ? 'Preparing…' : 'Download HTML'}</span>
        </button>
      }
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
      <PublicLinkResolverCtx.Provider value={NOTHING_ELSE_SHARED}>
        <AttachmentResolverContext.Provider value={resolve}>
          <ArtifactResolverContext.Provider value={resolveArtifact}>
            <EventFullCtx.Provider value={fetchFull}>
              <Transcript events={events} />
            </EventFullCtx.Provider>
          </ArtifactResolverContext.Provider>
        </AttachmentResolverContext.Provider>
      </PublicLinkResolverCtx.Provider>
    </PublicShell>
  );
}
