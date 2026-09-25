import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  BookOutlined,
  CheckSquareOutlined,
  FolderOutlined,
  MessageOutlined,
  ProjectOutlined,
  UnorderedListOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import { Link } from 'react-router-dom';
import type { Components } from 'react-markdown';
import { keepPreviousData, useQueries, useQueryClient } from '@tanstack/react-query';
import {
  LINK_PREVIEW_MAX_REFS,
  type LinkPreview,
  type LinkPreviewList,
  type LinkPreviewProject,
  type LinkPreviewRef,
  type LinkPreviewSession,
  type LinkPreviewTask,
  type LinkPreviewWiki,
} from '@orbit/shared';
import { linkPreviewsQuery } from '../lib/queries';
import {
  canonicalId,
  linkKey,
  pathLabel,
  targetHref,
  ORBIT_LINK_CARD_TAG,
  ORBIT_LINK_KINDS,
  writtenId,
  type OrbitLinkKind,
  type OrbitLinkRef,
} from '../lib/orbitLink';
import { wikiAnchorLabel, wikiAnchorMark, wikiKindWord, WIKI_NO_LONGER_PUSHED } from '../lib/wiki';
import { sessionRunStateOf, type SessionRunState, type SessionStateSource } from '../lib/sessionState';
import { WikiAnchorMark, WikiTrustBadge } from './WikiMarks';
import { TaskStatusPill } from './TaskStatusPill';
import { relTime } from './Transcript';

/**
 * What an Orbit link card says, from the preview the server sent for it.
 *
 * One skeleton, four contents: the type's icon and name, a title, then one or two lines of status.
 * Every word here is one this app already says somewhere — the task pill is the tasks panel's
 * `TaskStatusPill`, a session's status is the conversation header's own word (`statusLabel`, handed
 * in by the session view below), and the progress line is the tasks page's — so a card and the page
 * it leads to cannot describe the same object in two vocabularies. OrbitKit draws the same four
 * cards; `OrbitLinkCopy` is the list of sentences it is checked against, which is why every one of
 * them is an exported constant rather than a literal in the middle of a builder
 * (`src/macos/OrbitKit/Tests/OrbitKitTests/OrbitLinkCopyParityTests.swift`).
 *
 * Cards are drawn only inside a session view: `OrbitLinkCardsProvider` is what a conversation page
 * mounts, and `MD` asks for that provider before it will split a paragraph. The shared page and the
 * exported file have none, so a link there stays the link it is today and no card data is requested
 * — `OrbitLinkCard.test.tsx`'s two negative cases are exactly that.
 */

// MARK: - every sentence a card can say, in one place

/** The two states a card can be in before (or instead of) showing an object. */
export const ORBIT_LINK_NOT_AVAILABLE = 'Not available';
export const ORBIT_LINK_UNAVAILABLE_REASON = 'Deleted, or not in this account.';

/** What parts two facts on one line. */
export const ORBIT_LINK_SEPARATOR = ' · ';

/** A task's owner, when it has none — the list row's own word. */
export const ORBIT_LINK_UNASSIGNED = 'Unassigned';
/** A task nothing has ever run. */
export const ORBIT_LINK_NEVER_RUN = 'never run';

/** A wiki entry filed under nothing. Not a warning: plenty of notes are true everywhere. */
export const ORBIT_LINK_NO_ANCHOR = 'No anchor';

/** The badge on a session that coordinates a project, and the head of a project card's foot. */
export const ORBIT_LINK_COORDINATOR = 'Coordinator';

/** The progress line's labels, the tasks page's own. */
export const ORBIT_LINK_DONE_LABEL = 'Done';
export const ORBIT_LINK_OPEN_LABEL = 'Open';
export const ORBIT_LINK_RUNNING_LABEL = 'Running';
export const ORBIT_LINK_QUEUED_LABEL = 'Queued';
export const ORBIT_LINK_FAILED_LABEL = 'Failed';

/** The type name on the card's first row. */
export const ORBIT_LINK_TYPE_NAMES: Record<OrbitLinkKind, string> = {
  task: 'Task',
  session: 'Session',
  project: 'Project',
  list: 'Task list',
  wiki: 'Wiki',
};

/**
 * The card's first row: the type's name, and for a wiki entry the kind it is.
 *
 * "Wiki · Principle" rather than "Wiki" alone, because the entry's kind is what the note IS — the
 * push block's own lines open the same way (`[Principle] …`), and a card that said only "Wiki" would
 * make a reader open it to learn whether they are looking at a rule or a war story. The kind's word
 * is `lib/wiki`'s, so the card and the Wiki pages cannot name one kind two ways.
 */
export function orbitLinkTypeName(kind: OrbitLinkKind, entryKind: string | undefined): string {
  if (kind !== 'wiki') return ORBIT_LINK_TYPE_NAMES[kind];
  const entry = entryKind ? wikiKindWord(entryKind) : '';
  return entry === '' ? ORBIT_LINK_TYPE_NAMES.wiki : `${ORBIT_LINK_TYPE_NAMES.wiki}${ORBIT_LINK_SEPARATOR}${entry}`;
}

/** Groups thousands the way the app's other counts do (`27,468`). */
export function orbitLinkNumber(value: number): string {
  return value.toLocaleString('en-US');
}

/** `Done 7 / 8 · Open 1 · Failed 1` — the tasks page's progress line, the same parts in the same
 *  order and left out at the same counts (a Running or Failed nobody has is noise). */
export function orbitLinkProgressLine(counts: {
  done: number;
  total: number;
  open: number;
  running?: number;
  queued?: number;
  failed?: number;
}): string {
  const parts = [
    `${ORBIT_LINK_DONE_LABEL} ${orbitLinkNumber(counts.done)} / ${orbitLinkNumber(counts.total)}`,
    `${ORBIT_LINK_OPEN_LABEL} ${orbitLinkNumber(counts.open)}`,
  ];
  if (counts.running) parts.push(`${ORBIT_LINK_RUNNING_LABEL} ${orbitLinkNumber(counts.running)}`);
  if (counts.queued) parts.push(`${ORBIT_LINK_QUEUED_LABEL} ${orbitLinkNumber(counts.queued)}`);
  if (counts.failed) parts.push(`${ORBIT_LINK_FAILED_LABEL} ${orbitLinkNumber(counts.failed)}`);
  return parts.join(ORBIT_LINK_SEPARATOR);
}

/** Ready work exists and nothing is picking it up — the project page's own sentence. */
export function orbitLinkStalled(ready: number): string {
  const noun = ready === 1 ? 'task is' : 'tasks are';
  return `${orbitLinkNumber(ready)} ${noun} ready, but nothing is running.`;
}

/** `2 runs` — a task's runs, and `never run` for a task nothing has run. */
export function orbitLinkRuns(count: number): string {
  if (count === 0) return ORBIT_LINK_NEVER_RUN;
  return count === 1 ? '1 run' : `${orbitLinkNumber(count)} runs`;
}

/** `93 turns`. */
export function orbitLinkTurns(count: number): string {
  return count === 1 ? '1 turn' : `${orbitLinkNumber(count)} turns`;
}

/** `last Succeeded, 93 turns` — how the newest run of a task came out, in the words its own glyph
 *  already uses. */
export function orbitLinkLastRun(word: string, turns: number): string {
  return turns > 0 ? `last ${word}, ${orbitLinkTurns(turns)}` : `last ${word}`;
}

// MARK: - the card

const KIND_ICONS: Record<OrbitLinkKind, ReactNode> = {
  task: <CheckSquareOutlined />,
  session: <MessageOutlined />,
  project: <ProjectOutlined />,
  list: <UnorderedListOutlined />,
  // A closed book, which is the drawer row's glyph too (`WikiMarks` draws the entry's own kind
  // inside the card, so the tile is the wiki rather than the kind).
  wiki: <BookOutlined />,
};

/** One secondary line: what it says, and what it wears. */
interface CardLine {
  text: string;
  glyph?: ReactNode;
  /** A chip in front of the text — the Coordinator badge, and nothing else so far. */
  badge?: string;
  isWarning?: boolean;
}

/** One bar of the card's meter. What each role's colour is is the stylesheet's business. */
type MeterSegment = { role: 'done' | 'ready' | 'failed'; fraction: number };

/** The line under a project card's meter: where the project is coordinated, and how long ago. */
interface CardFoot {
  text: string;
  time: string | null;
}

/**
 * Colour, not vocabulary: the word itself is the conversation page's (`stateWord` below, which is
 * `WorkspaceView`'s `statusLabel`). The five tones are the ones the session list's glyph already
 * uses — brand = working, warning = waiting on you, success = the run reported success, error = a
 * real failure, neutral = a terminal state nobody is waiting on.
 */
function stateTone(state: SessionRunState): 'live' | 'attention' | 'done' | 'failed' | 'idle' {
  if (state === 'RUNNING') return 'live';
  if (state === 'AWAITING_INPUT') return 'attention';
  if (state === 'SUCCEEDED') return 'done';
  if (state === 'FAILED') return 'failed';
  return 'idle';
}

/** Done green, ready orange, failed red, over the whole — the project page's meter. A lane nothing
 *  is in draws no segment at all rather than a zero-width one. */
function meterSegments(done: number, ready: number, failed: number, total: number): MeterSegment[] {
  if (total <= 0) return [];
  const lanes: Array<[MeterSegment['role'], number]> = [
    ['done', done],
    ['ready', ready],
    ['failed', failed],
  ];
  return lanes
    .filter(([, count]) => count > 0)
    .map(([role, count]) => ({ role, fraction: count / total }));
}

/** A card's title, or the id the link wrote when the server sent none: a card with a blank title
 *  row reads as broken, and the id is at least true. */
function cardTitle(sent: string | undefined | null, link: OrbitLinkRef): string {
  return typeof sent === 'string' && sent.trim() !== '' ? sent : writtenId(link);
}

/** The last time anything happened to an object, for the card's relative time. */
function lastActivity(at: Array<string | null | undefined>): string | null {
  for (const candidate of at) if (candidate) return candidate;
  return null;
}

/**
 * One card. Pure: everything it draws comes from its props, so the four contents and the two states
 * with nothing to show are each one render in `OrbitLinkCard.test.tsx`.
 *
 * The title is the link to the object's own page, in every state: the reference a card replaced was
 * one, and for an object the server would not describe a page saying "not found" is a truer answer
 * than a title that cannot be pressed.
 */
export function OrbitLinkCard({
  link,
  preview,
  host,
  stateWord,
}: {
  link: OrbitLinkRef;
  /** The server's answer for this link; undefined while it is still being read. */
  preview?: LinkPreview;
  host: string;
  /** The conversation page's own word for a row's state (`WorkspaceView.statusLabel`). */
  stateWord: (row: SessionStateSource) => string;
}) {
  const kind = link.target.kind;
  const answer:
    | LinkPreviewTask
    | LinkPreviewSession
    | LinkPreviewProject
    | LinkPreviewList
    | LinkPreviewWiki
    | undefined =
    preview?.state === 'ok'
      ? preview.kind === 'task'
        ? preview.task
        : preview.kind === 'session'
          ? preview.session
          : preview.kind === 'project'
            ? preview.project
            : preview.kind === 'wiki'
              ? preview.wiki
              : preview.list
      : undefined;
  // An `ok` answer missing the payload it promised draws the unavailable card rather than a
  // half-drawn one: the server did not describe the object, so there is nothing to describe.
  const state = preview === undefined ? 'loading' : answer === undefined ? 'unavailable' : 'ready';
  // Where the title leads. A wiki entry's page is `/wiki/<space>/e/<id>` — both halves, and only
  // the server knows the space — so an entry it would not describe has no page to offer.
  const href = targetHref(link.target, state === 'ready' && kind === 'wiki' ? (answer as LinkPreviewWiki) : undefined);

  const lines: CardLine[] = [];
  let title: string | null = null;
  let headRight: ReactNode = null;
  let meter: MeterSegment[] = [];
  let foot: CardFoot | null = null;

  if (state === 'unavailable') {
    title = ORBIT_LINK_NOT_AVAILABLE;
    lines.push({ text: ORBIT_LINK_UNAVAILABLE_REASON });
  } else if (state === 'ready' && kind === 'task') {
    const task = answer as LinkPreviewTask;
    headRight = <TaskStatusPill status={task.status} running={task.running} queued={task.queued} />;
    title = cardTitle(task.title, link);
    if (task.project && task.project.title !== '') {
      lines.push({ text: task.project.title, glyph: <ProjectOutlined /> });
    }
    const parts = [task.assignee?.name ?? ORBIT_LINK_UNASSIGNED, orbitLinkRuns(task.runs)];
    if (task.lastRun) {
      // The newest run's own word, from the same vocabulary the conversation header uses.
      parts.push(orbitLinkLastRun(stateWord(task.lastRun), task.lastRun.numTurns));
    }
    const at = lastActivity([task.lastRun?.endedAt, task.updatedAt]);
    if (at) parts.push(relTime(at));
    lines.push({ text: parts.join(ORBIT_LINK_SEPARATOR) });
  } else if (state === 'ready' && kind === 'session') {
    const session = answer as LinkPreviewSession;
    headRight = (
      <span className={`olc-state is-${stateTone(sessionRunStateOf(session))}`}>
        {stateWord(session)}
      </span>
    );
    title = cardTitle(session.title, link);
    const parts = [session.workspace?.name ?? ORBIT_LINK_UNASSIGNED];
    if (session.model) parts.push(session.model);
    if (session.numTurns > 0) parts.push(orbitLinkTurns(session.numTurns));
    const at = lastActivity([session.lastTurnAt, session.updatedAt, session.createdAt]);
    if (at) parts.push(relTime(at));
    lines.push({
      text: parts.join(ORBIT_LINK_SEPARATOR),
      badge: session.projectId ? ORBIT_LINK_COORDINATOR : undefined,
    });
  } else if (state === 'ready' && kind === 'project') {
    const project = answer as LinkPreviewProject;
    const buckets = project.buckets;
    const done = buckets?.done ?? 0;
    const running = buckets?.running ?? 0;
    const ready = buckets?.ready ?? 0;
    const failed = buckets?.failed ?? 0;
    // Every lane that is not an outcome — the tasks page's Open, which is the sum of the four it
    // keeps apart and the reason the lanes and the total agree.
    const open = running + ready + (buckets?.blocked ?? 0) + (buckets?.awaitingVerification ?? 0);
    title = cardTitle(project.title, link);
    meter = meterSegments(done, ready, failed, project.total);
    lines.push({
      text: orbitLinkProgressLine({ done, total: project.total, open, running, failed }),
    });
    if (ready > 0 && running === 0) {
      lines.push({ text: orbitLinkStalled(ready), glyph: <WarningOutlined />, isWarning: true });
    }
    if (project.coordinator) {
      const at = lastActivity([project.coordinator.lastTurnAt, project.coordinator.updatedAt]);
      foot = {
        text: `${ORBIT_LINK_COORDINATOR}${ORBIT_LINK_SEPARATOR}${stateWord(project.coordinator)}`,
        time: at ? relTime(at) : null,
      };
    }
  } else if (state === 'ready' && kind === 'wiki') {
    const entry = answer as LinkPreviewWiki;
    // The trust badge the Wiki's own pages wear (`WikiMarks`), so "Owner" means here what it means
    // in the drawer and on Review — the same word, the same deep surface.
    headRight = <WikiTrustBadge trust={entry.trust} />;
    title = cardTitle(entry.title, link);
    if (entry.summary !== '') lines.push({ text: entry.summary });
    // What the entry stands on, and whether it still stands: the entry's own anchor mark (`✓ 4db4f9f`
    // when a re-check found it, the warning word when it did not), then the anchor itself. An entry
    // nothing has re-checked says nothing about its anchors rather than claiming they are fine —
    // `wikiAnchorMark` answers null for exactly that, which is why the mark is not the line's text.
    const mark = wikiAnchorMark(entry);
    const anchorLabel = entry.anchor ? wikiAnchorLabel(entry.anchor) : null;
    lines.push({
      text: anchorLabel ?? ORBIT_LINK_NO_ANCHOR,
      glyph: mark ? <WikiAnchorMark mark={mark} /> : undefined,
      isWarning: mark?.tone === 'amber' || mark?.tone === 'red',
    });
    // A retired or superseded entry still reads, and a card that hid it would keep claiming a note
    // agents are no longer being handed (design §4: agents stop getting a retired entry).
    if (entry.status !== 'active') {
      lines.push({ text: WIKI_NO_LONGER_PUSHED, glyph: <WarningOutlined />, isWarning: true });
    }
  } else if (state === 'ready') {
    const list = answer as LinkPreviewList;
    const counts = list.counts;
    const done = counts?.done ?? 0;
    const failed = counts?.failed ?? 0;
    title = cardTitle(list.title, link);
    meter = meterSegments(done, 0, failed, counts?.total ?? 0);
    lines.push({
      text: orbitLinkProgressLine({
        done,
        total: counts?.total ?? 0,
        open: (counts?.open ?? 0) + (counts?.inProgress ?? 0),
        running: counts?.running,
        queued: counts?.queued,
        failed,
      }),
    });
  }

  return (
    <div className={`orbit-link-card is-${state}`} data-kind={kind} data-state={state}>
      <div className="olc-head">
        <span className="olc-kind">
          <span className="olc-tile" aria-hidden="true">
            {KIND_ICONS[kind]}
          </span>
          {orbitLinkTypeName(kind, state === 'ready' && kind === 'wiki' ? (answer as LinkPreviewWiki).kind : undefined)}
        </span>
        {headRight}
      </div>
      {state === 'loading' && (
        <div className="olc-skeleton" aria-hidden="true">
          <span />
          <span />
        </div>
      )}
      {title !== null && (
        <div className="olc-title">
          {href !== null ? <Link to={href}>{title}</Link> : <span>{title}</span>}
        </div>
      )}
      {meter.length > 0 && (
        <div className="olc-meter" aria-hidden="true">
          {meter.map((segment) => (
            <span
              key={segment.role}
              className={`olc-meter-seg is-${segment.role}`}
              style={{ width: `${segment.fraction * 100}%` }}
            />
          ))}
        </div>
      )}
      {lines.map((line, index) => (
        <div key={index} className={`olc-line${line.isWarning ? ' is-warning' : ''}`}>
          {line.glyph && (
            <span className="olc-line-glyph" aria-hidden="true">
              {line.glyph}
            </span>
          )}
          {line.badge && <span className="olc-badge">{line.badge}</span>}
          <span className="olc-line-text">{line.text}</span>
        </div>
      ))}
      {foot && (
        <div className="olc-foot">
          <span className="olc-foot-text">{foot.text}</span>
          {foot.time && <span className="olc-foot-time">{`${ORBIT_LINK_SEPARATOR}${foot.time}`}</span>}
          <span className="olc-foot-arrow" aria-hidden="true">
            ›
          </span>
        </div>
      )}
      {state !== 'ready' && <div className="olc-path">{pathLabel(link, host)}</div>}
    </div>
  );
}

// MARK: - the links a conversation view is showing

/** What a card needs from the view it is drawn in. */
export interface OrbitLinkCards {
  /** The host this deployment is served from (`window.location.host`) — the mono hint's text. */
  host: string;
  /** Ask for this link's card. Every card of one conversation view asks, and the view reads the
   *  whole set in one request. */
  register(link: OrbitLinkRef): void;
  /** The answer for a link, or undefined while it is still being read. */
  previewFor(link: OrbitLinkRef): LinkPreview | undefined;
  /** The conversation page's own word for a row's state. */
  stateWord(row: SessionStateSource): string;
}

export const OrbitLinkCardsCtx = createContext<OrbitLinkCards | null>(null);

/** The key prefix every batch of a conversation lives under, so one refresh re-reads them all. */
export const LINK_PREVIEWS_KEY = ['link-previews'] as const;

/**
 * The cards of one conversation view: which links it is showing, read together.
 *
 * A card registers itself as it mounts, and the view reads the whole set in one request — the
 * alternative is a request per link, which is a conversation with six links asking six times on
 * every refresh. Answers are keyed by the object, so the two spellings of one id are one entry and
 * the order the links were written in does not matter.
 *
 * It has no clock of its own: `refreshKey` is the conversation's own refresh signal — WorkspaceView
 * passes its detail query's `dataUpdatedAt` — and the links are re-read when that moves. No
 * interval, so a page nobody is looking at asks the server nothing.
 */
export function OrbitLinkCardsProvider({
  children,
  stateWord,
  host,
  refreshKey,
}: {
  children: ReactNode;
  stateWord: (row: SessionStateSource) => string;
  /** The server this view talks to. Defaults to the one serving the page. */
  host?: string;
  /** Moves when the conversation's own data is re-read. */
  refreshKey?: number;
}) {
  const [links, setLinks] = useState<OrbitLinkRef[]>([]);
  const known = useRef(new Set<string>());
  const register = useCallback((link: OrbitLinkRef) => {
    const key = linkKey(link.target);
    if (known.current.has(key)) return;
    known.current.add(key);
    setLinks((previous) => [...previous, link]);
  }, []);

  // At most `LINK_PREVIEW_MAX_REFS` refs per request, which is what the endpoint accepts: a
  // conversation showing more links than that is read in batches rather than refused whole.
  const batches = useMemo(() => {
    const refs: LinkPreviewRef[] = links.map((link) => ({ kind: link.target.kind, id: link.target.id }));
    const out: LinkPreviewRef[][] = [];
    for (let at = 0; at < refs.length; at += LINK_PREVIEW_MAX_REFS) {
      out.push(refs.slice(at, at + LINK_PREVIEW_MAX_REFS));
    }
    return out;
  }, [links]);

  const results = useQueries({
    queries: batches.map((batch) => ({
      ...linkPreviewsQuery(batch),
      placeholderData: keepPreviousData,
    })),
  });

  // Rebuilt when an answer changes, and not when one is merely in flight: `dataUpdatedAt` moves on
  // every answer, including one that says what the last one said.
  const answers = results.map((result) => String(result.dataUpdatedAt)).join(',');
  const previews = useMemo(() => {
    const map = new Map<string, LinkPreview>();
    for (const result of results) {
      for (const preview of result.data?.previews ?? []) {
        // Keyed off the answer, canonicalised — not off the position it came back in. The server
        // answers in the order it was asked, but a batch held over from an earlier set of links
        // must not be paired with this one.
        const id = canonicalId(preview.id);
        if (id !== null) map.set(linkKey({ kind: preview.kind as OrbitLinkKind, id }), preview);
      }
    }
    return map;
    // `results` is deliberately not a dependency: it is a fresh array every render, and what this
    // map holds is decided by the answers in it (`answers`).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [answers]);

  const client = useQueryClient();
  useEffect(() => {
    if (refreshKey === undefined) return;
    void client.invalidateQueries({ queryKey: LINK_PREVIEWS_KEY });
  }, [client, refreshKey]);

  const value = useMemo<OrbitLinkCards>(
    () => ({
      host: host ?? window.location.host,
      register,
      previewFor: (link) => previews.get(linkKey(link.target)),
      stateWord,
    }),
    [host, register, previews, stateWord],
  );

  return <OrbitLinkCardsCtx.Provider value={value}>{children}</OrbitLinkCardsCtx.Provider>;
}

/** The link a card node in the markdown tree stands for: the plugin hands over the object it found
 *  and the text it replaced, so nothing is re-read out of the prose. */
function linkFromProps(props: {
  kind?: unknown;
  id?: unknown;
  url?: unknown;
  reference?: unknown;
}): OrbitLinkRef | null {
  const { kind, id } = props;
  if (typeof kind !== 'string' || typeof id !== 'string') return null;
  if (!(ORBIT_LINK_KINDS as readonly string[]).includes(kind)) return null;
  const target = { kind: kind as OrbitLinkKind, id };
  if (typeof props.url === 'string') return { target, source: { kind: 'url', url: props.url } };
  if (typeof props.reference === 'string') {
    return { target, source: { kind: 'ref', ref: props.reference } };
  }
  return null;
}

/**
 * The card as react-markdown draws it: the tag `orbitLinkRemarkPlugin` gave the node, mapped to
 * this component in `MD`. It registers its link with the conversation view and reads the answer back
 * out of it.
 */
export function OrbitLinkCardNode(props: {
  kind?: unknown;
  id?: unknown;
  url?: unknown;
  reference?: unknown;
}) {
  const cards = useContext(OrbitLinkCardsCtx);
  const { kind, id, url, reference } = props;
  const link = useMemo(() => linkFromProps({ kind, id, url, reference }), [kind, id, url, reference]);
  useEffect(() => {
    if (link) cards?.register(link);
  }, [cards, link]);
  if (!cards || !link) return null;
  return (
    <OrbitLinkCard
      link={link}
      preview={cards.previewFor(link)}
      host={cards.host}
      stateWord={cards.stateWord}
    />
  );
}

/**
 * The mapping react-markdown needs to draw a card: the tag `orbitLinkRemarkPlugin` gives a card
 * node, and the component above. Spread into `MD`'s overrides rather than written as a key in their
 * literal — `orbit-link-card` is not a JSX intrinsic element, so it has no key of its own in
 * react-markdown's `Components`.
 */
export const orbitLinkCardComponents = {
  [ORBIT_LINK_CARD_TAG]: OrbitLinkCardNode,
} as unknown as Components;
