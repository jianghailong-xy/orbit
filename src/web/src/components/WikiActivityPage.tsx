import { useEffect, useId, useMemo, useState, type MouseEvent, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeftOutlined, HistoryOutlined, RightOutlined } from '@ant-design/icons';
import { wikiChatRewriteWaits, wikiChatWaitingBanner, wikiDocChangeLine, type WikiDocChangeRow } from '@orbit/shared';
import { relTime } from './Transcript';
import { WikiCard, WikiEmpty } from './WikiCards';
import { useWikiChat } from './WikiChat';
import { WikiSeeChanges } from './WikiSeeChanges';
import { RECENT_DECISIONS, ReviewCard, TimelineRow, UsageCard, WikiDecisionRows, reviewOps } from './WikiHome';
import { WikiDot } from './WikiMarks';
import { WikiPlanBanners, WikiPlanCard } from './WikiPlanCard';
import { WikiRunTimelineRow } from './WikiRunPage';
import { WikiRunsCard } from './WikiRunsCard';
import { Button } from './ui/Button';
import {
  wikiChatDraftsQuery,
  wikiChatsQuery,
  wikiDocChangesQuery,
  wikiEntriesOfKindQuery,
  wikiEntriesQuery,
  wikiReviewQuery,
  wikiSpaceQuery,
  wikiTimelineQuery,
} from '../lib/queries';
import { WIKI_ACTIVITY_DOCS, WIKI_CHAT_PARAM, wikiChatActionLabel, wikiChatCardOf, wikiChatToOpen } from '../lib/wikiChat';
import { wikiDocSectionPath } from '../lib/wikiDocs';
import { PHONE_QUERY, useMediaQuery } from '../lib/useMediaQuery';
import {
  WIKI_ACTIVITY,
  WIKI_ALL_DECISIONS,
  WIKI_NO_CHANGES,
  WIKI_NO_DECISIONS,
  WIKI_RECENT_DECISIONS,
  WIKI_RECENT_DECISIONS_HINT,
  WIKI_RECENTLY_CHANGED,
  WIKI_REVIEW_PATH,
  WIKI_TITLE,
  moveWikiSeen,
  readWikiSeenBefore,
  wikiActivityPath,
  wikiEntriesOfKind,
  wikiInSpace,
  wikiNewSinceLastLooked,
  wikiSeenKey,
  wikiSpacePath,
  wikiTopicPath,
  wikiWaitingOnYou,
  type WikiSpaceRow,
} from '../lib/wiki';
import { wikiRecentRows } from '../lib/wikiReviewMode';
import { wikiProposalsBanner, wikiProposalsElsewhere, wikiProposalsWaiting, wikiSpaceNames } from '../lib/wikiSpace';

/**
 * Activity (design §12.3.2, mocks 31 ② and 33 ④): what the Wiki home said besides its content — how the
 * space is kept, what waits on the owner, what was decided and changed lately, and what the agents used.
 *
 * THE HOME'S BLOCKS, MOVED AND IN THEIR ORDER: the status row, Review's banner (a phone) or card (a
 * desktop), the plan's banners or card, Recent decisions, Recently changed, Agents used the wiki. Its
 * head is Review's: `← Wiki` and the big title on a phone, with the space's name beside it; on a desktop
 * the page stands in the Wiki's frame under `Wiki › Activity`, the directory beside it with no row lit.
 *
 * WHAT WAITS IS COUNTED ACROSS EVERY SPACE (§12.3.3). The first banner is every space's proposals, each
 * other space's share said on its line, and it opens Review over all of them; the plan's banners follow,
 * one for each kind of thing waiting, another space's saying which space. Together they are the number
 * on the head's Activity badge and the sidebar's Wiki row (`wikiWaiting`), each banner's part of it in
 * `data-waiting`. A desktop draws cards for this space instead (mock 33 ④ ⑤), so nothing waiting
 * elsewhere may hide behind them: its Review card counts every space's proposals and says the other
 * spaces' shares as the banner does, and the other spaces' plan banners stand over the cards.
 *
 * WHAT IS NEW is what came after the reader last looked at this space (`wikiSeenKey(space, 'home')`, the
 * stamp the home keeps): those rows of Recently changed wear a blue dot and are counted beside its title.
 *
 * THE SERVER'S RUNS come after Review and Plan (mock 35 ④, P9): `WikiRunsCard`, drawn only while the server
 * executes the account's wiki or has run something for the space — a run's detail is its call log there.
 */
export function WikiActivityPage({
  space,
  spaces,
  status,
}: {
  space: WikiSpaceRow;
  /** Every space of the owner, as the list read answers it — `space` among them. */
  spaces: readonly WikiSpaceRow[];
  /** The frame's status row, which on this page stands under the title. */
  status: ReactNode;
}) {
  const detail = useQuery(wikiSpaceQuery(space.id));
  const decisionRead = useQuery(wikiEntriesOfKindQuery(space.id, 'decision', RECENT_DECISIONS));
  // The newest entries of every kind, which the frame reads anyway: only to name the entry a decision
  // was superseded by.
  const entries = useQuery(wikiEntriesQuery(space.id));
  const timeline = useQuery(wikiTimelineQuery(space.id));
  const review = useQuery(wikiReviewQuery(space.id));
  const names = useMemo(() => wikiSpaceNames(spaces), [spaces]);

  // Read before this page moves the stamp, and before the home did if the reader came from it.
  const seenKey = wikiSeenKey(space.slug, 'home');
  const [seen] = useState(() => readWikiSeenBefore(seenKey));
  useEffect(() => moveWikiSeen(seenKey), [seenKey]);

  const decisions = useMemo(() => wikiEntriesOfKind(decisionRead.data ?? [], 'decision'), [decisionRead.data]);
  const entryById = useMemo(
    () => new Map([...(entries.data ?? []), ...decisions].map((entry) => [entry.id, entry])),
    [entries.data, decisions],
  );
  const pending = useMemo(() => reviewOps(review.data ?? []), [review.data]);
  // Recently changed: the entries' newest five, and the documents' (contract `docs.versions.reads.changes`): each
  // section written again, or the sections a follow job left for maintenance — newest five — in one list by time.
  const docChanges = useQuery(wikiDocChangesQuery(space.id));
  const rows = useMemo(() => {
    const entryRows = wikiRecentRows(timeline.data?.items ?? [])
      .slice(0, 5)
      .map((row) => ({ at: row.kind === 'run' ? row.at : row.item.at, row }) as const);
    const docRows = (docChanges.data?.changes ?? []).slice(0, 5).map((change) => ({ at: change.at, doc: change }) as const);
    return [...entryRows, ...docRows].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  }, [timeline.data, docChanges.data]);
  const fresh = (at: string): boolean => seen <= 0 || Date.parse(at) > seen;
  const freshRows = rows.filter((row) => fresh(row.at)).length;

  const proposals = wikiProposalsBanner(spaces, space.id, names);
  const elsewhere = spaces.filter((row) => row.id !== space.id && (row.planWaiting ?? 0) > 0);
  const reviewElsewhere = wikiProposalsElsewhere(spaces, space.id, names);
  // W's chat part (contract `chat.waiting.banner`): this space's rewrites that wait, then every other space's.
  const here = spaces.find((row) => row.id === space.id) ?? space;
  const chatElsewhere = spaces.filter((row) => row.id !== space.id && (row.chatWaiting ?? 0) > 0);

  return (
    <div className="wk-act">
      <div className="wk-crumb wk-crumb--back">
        <Link to={wikiSpacePath(space.slug)}>
          <ArrowLeftOutlined className="back" />
          {WIKI_TITLE}
        </Link>
        <RightOutlined className="ic" />
        <span>{WIKI_ACTIVITY}</span>
      </div>
      <div className="wk-act-head">
        <h1 className="page-title">{WIKI_ACTIVITY}</h1>
        <span className="wk-space-tag">{names.get(space.id) ?? space.title}</span>
      </div>
      {status}

      {/* A phone's banners (mock 31 ②): the proposals of every space, then what each plan waits for — another
          space's on a desktop too, over the cards. */}
      {proposals && (
        <Link className="wk-banner" to={WIKI_REVIEW_PATH} data-waiting={wikiProposalsWaiting(spaces)}>
          <WikiDot tone="amber" />
          <span className="t">{proposals}</span>
          <RightOutlined className="ic" />
        </Link>
      )}
      <WikiPlanBanners space={space} />
      {elsewhere.map((row) => (
        <WikiPlanBanners key={row.id} space={row} elsewhere={names.get(row.id) ?? row.title} />
      ))}
      <WikiChatWaitingBanner space={here} />
      {chatElsewhere.map((row) => (
        <WikiChatWaitingBanner key={row.id} space={row} elsewhere={names.get(row.id) ?? row.title} />
      ))}

      <div className="wk-act-cards">
        <ReviewCard space={space} pending={pending} changesets={review.data ?? []} elsewhere={reviewElsewhere} />
        <WikiPlanCard space={space} />
        <WikiRunsCard space={space} />
        <WikiCard
          title={WIKI_RECENT_DECISIONS}
          hint={WIKI_RECENT_DECISIONS_HINT}
          trailing={
            <Link className="wk-card-more" to={wikiTopicPath(space.slug, 'decisions')}>
              {WIKI_ALL_DECISIONS}
            </Link>
          }
          className="wk-decisions-card"
        >
          {decisions.length === 0 ? (
            <WikiEmpty>{WIKI_NO_DECISIONS}</WikiEmpty>
          ) : (
            <WikiDecisionRows decisions={decisions.slice(0, RECENT_DECISIONS)} entryById={entryById} spaceSlug={space.slug} />
          )}
        </WikiCard>
        <WikiCard
          title={WIKI_RECENTLY_CHANGED}
          hint={
            freshRows > 0 ? (
              <span className="wk-new-hint">
                <span className="wk-new" />
                {wikiNewSinceLastLooked(freshRows)}
              </span>
            ) : undefined
          }
          className="wk-changed-card"
        >
          {rows.length === 0 ? (
            <WikiEmpty>{WIKI_NO_CHANGES}</WikiEmpty>
          ) : (
            <ol className="wk-tl">
              {rows.map((entry) =>
                'doc' in entry ? (
                  <WikiDocChangeTimelineRow
                    key={entry.doc.kind === 'section' ? `doc:${entry.doc.versionId}` : `left:${entry.doc.jobId}`}
                    change={entry.doc}
                    space={space}
                    fresh={fresh(entry.at)}
                  />
                ) : entry.row.kind === 'run' ? (
                  <WikiRunTimelineRow
                    key={entry.row.changesetId}
                    changesetId={entry.row.changesetId}
                    origin={entry.row.origin}
                    at={entry.row.at}
                    changes={entry.row.items.length}
                    spaceSlug={space.slug}
                    fresh={fresh(entry.row.at)}
                  />
                ) : (
                  <TimelineRow key={entry.row.item.opId} item={entry.row.item} spaceSlug={space.slug} fresh={fresh(entry.row.item.at)} />
                ),
              )}
            </ol>
          )}
        </WikiCard>
        {detail.data && <UsageCard space={detail.data} />}
      </div>
    </div>
  );
}

/**
 * One Docs row of Recently changed (contract `docs.versions.reads.changes`, board 36 ④): a section written again —
 * `3.1 §3 rewritten · after chat … · 1 sentence changed` (`wikiDocChangeLine`), opening the section, with See changes
 * under it — or, in grey, the sections a follow job left for the next maintenance run.
 */
function WikiDocChangeTimelineRow({ change, space, fresh }: { change: WikiDocChangeRow; space: WikiSpaceRow; fresh: boolean }) {
  const [open, setOpen] = useState(false);
  const line = wikiDocChangeLine(change);
  return (
    <li className={`wk-tl-doc${change.kind === 'left' ? ' left' : ''}`}>
      <WikiDot tone={fresh ? 'blue' : 'muted'} />
      <div>
        <div className="wk-tl-h">
          <b>{WIKI_ACTIVITY_DOCS}</b>
          <span className="when">{relTime(change.at)}</span>
        </div>
        <div className="wk-tl-t">
          {change.kind === 'section' ? <Link to={wikiDocSectionPath(space.slug, change.doc, change.key)}>{line}</Link> : line}
        </div>
        {change.kind === 'section' && (
          <>
            <div className="wk-tl-n">{change.title}</div>
            <div className="wk-tl-acts">
              <button type="button" aria-expanded={open} onClick={() => setOpen((shown) => !shown)}>
                {wikiChatActionLabel('see_changes')}
              </button>
            </div>
            {open && (
              <WikiSeeChanges
                spaceId={space.id}
                doc={change.doc}
                sectionKey={change.key}
                where={change.where}
                versionId={change.versionId}
                title={false}
              />
            )}
          </>
        )}
      </div>
    </li>
  );
}

/**
 * W's chat part on Activity (contract `chat.waiting.banner`): one amber banner for a space's applied cards whose rewrite
 * waits on the owner — `1 rewrite needs you` — opening the chat at the first such card. Another space's says which space,
 * and opens that space's Activity, where its own banner opens its chat. Its count is `data-waiting`, so the banners still
 * add up to W.
 */
function WikiChatWaitingBanner({ space, elsewhere = null }: { space: WikiSpaceRow; elsewhere?: string | null }) {
  const chat = useWikiChat();
  const qc = useQueryClient();
  const chats = useQuery({ ...wikiChatsQuery(space.id), enabled: elsewhere === null && (space.chatWaiting ?? 0) > 0 });
  const waiting = space.chatWaiting ?? 0;
  const text = wikiChatWaitingBanner(waiting);
  if (!text) return null;
  const first = wikiChatToOpen(chats.data?.chats);
  const to = elsewhere ? wikiActivityPath(space.slug) : `${wikiActivityPath(space.slug)}?${WIKI_CHAT_PARAM}=${encodeURIComponent(first)}`;
  const open = async (event: MouseEvent<HTMLAnchorElement>) => {
    if (elsewhere || !chat) return;
    event.preventDefault();
    // The chat holding the first card whose rewrite waits, newest chat first, at that card.
    const list = await qc.fetchQuery(wikiChatsQuery(space.id)).catch(() => null);
    for (const row of (list?.chats ?? []).filter((one) => one.needsYou > 0)) {
      const cards = await qc.fetchQuery(wikiChatDraftsQuery(row.sessionId)).catch(() => []);
      const card = cards.find((one) => wikiChatRewriteWaits(wikiChatCardOf(one)));
      if (card) return chat.open(row.sessionId, card.id);
    }
    chat.open(wikiChatToOpen(list?.chats));
  };
  return (
    <Link
      className={`wk-banner wk-chat-banner${elsewhere ? ' elsewhere' : ''}`}
      data-waiting={waiting}
      to={to}
      onClick={(event) => void open(event)}
    >
      <WikiDot tone="amber" />
      <span className="t">{elsewhere ? `${text} ${wikiInSpace(elsewhere)}` : text}</span>
      <RightOutlined className="ic" />
    </Link>
  );
}

/**
 * The head's way into Activity (design §12.3.2): the history mark — with its word on a desktop, alone on
 * a phone, as Settings is — and, in its corner, the collapsed sidebar's amber badge with the number
 * waiting on the owner (`wikiWaiting`, the sidebar's own count), none at zero. Pressed on Activity.
 */
export function WikiActivityButton({ spaceSlug, waiting, on }: { spaceSlug: string; waiting: number; on: boolean }) {
  const navigate = useNavigate();
  const phone = useMediaQuery(PHONE_QUERY);
  const badge = useId();
  return (
    <Button
      className={`wk-activity-btn${on ? ' on' : ''}`}
      icon={<HistoryOutlined />}
      aria-label={WIKI_ACTIVITY}
      aria-current={on ? 'page' : undefined}
      aria-describedby={waiting > 0 ? badge : undefined}
      onClick={() => navigate(wikiActivityPath(spaceSlug))}
    >
      {phone ? null : WIKI_ACTIVITY}
      {waiting > 0 && (
        <span id={badge} className="tp-rail-badge needs-you" title={wikiWaitingOnYou(waiting)} aria-label={wikiWaitingOnYou(waiting)}>
          {waiting}
        </span>
      )}
    </Button>
  );
}
