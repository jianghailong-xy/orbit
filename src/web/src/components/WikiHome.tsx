import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Button } from 'antd';
import { AppstoreOutlined, PushpinOutlined, RightOutlined, SortAscendingOutlined } from '@ant-design/icons';
import { relTime } from './Transcript';
import { WikiCard, WikiEmpty } from './WikiCards';
import { WikiDocRow } from './WikiDocList';
import { WikiDot, WikiOpChip, WikiTrustBadge } from './WikiMarks';
import { wikiArticlesQuery, wikiDocsQuery, wikiEntriesOfKindQuery } from '../lib/queries';
import type { WikiChangeset, WikiChangesetOp, WikiEntry, WikiSpaceRow, WikiSpaceWithUsage, WikiTimelineItem } from '../lib/wiki';
import {
  WIKI_AGENTS_USED,
  WIKI_AGENTS_USED_HINT,
  WIKI_MOST_USED,
  WIKI_NO_AGENTS_YET,
  WIKI_NO_REVIEW,
  WIKI_PRINCIPLES,
  WIKI_REVIEW_TITLE,
  WIKI_SEARCHES,
  WIKI_SESSIONS_RECEIVED,
  WIKI_TRUST_TONE,
  wikiAllPrinciples,
  wikiChangeNote,
  wikiChangeVerb,
  wikiChangedSince,
  wikiEntriesOfKind,
  wikiEntryPath,
  wikiOldest,
  wikiProposalsFrom,
  wikiSeenKey,
  wikiShortDay,
  moveWikiSeen,
  readWikiSeen,
  type WikiTrust,
} from '../lib/wiki';
import {
  WIKI_AZ_INDEX,
  WIKI_BROWSE,
  wikiArticlePath,
  wikiBrowsePath,
  wikiDirectoryGroups,
  wikiIndexPath,
  type WikiDirectoryGroup,
} from '../lib/wikiArticles';
import {
  WIKI_DOC_NOT_WRITTEN_SHORT,
  WIKI_NO_DOCUMENTS_NOTE,
  wikiDocPath,
  wikiHomeCategories,
  wikiHomeLine,
  wikiNotWrittenRow,
  wikiReadsByDocs,
  type WikiDocsDirectory,
  type WikiHomeCategory,
} from '../lib/wikiDocs';
import { WIKI_PLAN_SET_UP } from '../lib/wikiPlan';
import { wikiSettingsPath } from '../lib/wikiReviewMode';

/** Every principle: the most one read answers (the server's cap), far above any space's own rules. */
const PRINCIPLES_READ = 200;
/** The principles the home lists before `All N ›` (design §12.3.1, mock 31 ③). */
const PRINCIPLES_SHOWN = 3;
/** Activity's decision log: the newest four. */
export const RECENT_DECISIONS = 4;

/**
 * The Wiki home: what this codebase's wiki says (design §12.3.1, mocks 30 ③, 31 ① ③ ⑥ ⑦, 33 ①).
 *
 * THE ORDER IS THE DESIGN'S: the head, then the content line (`WikiHomeState`, which the frame draws
 * between the head and the search), the search, the principles — only when there are any: the first three
 * and `All N ›` — the documents by category, and last `Browse by category · A–Z index`, a phone's (a
 * desktop has both atop the directory). A phone draws it as one column, and iOS the same bands in the same
 * order: this file, the phone rules in index.css and `WikiLogic.HomeBand` hold it together.
 *
 * NOTHING HERE SAYS HOW THE WIKI IS KEPT. The status row, Review, the plan, Recent decisions, Recently
 * changed and Agents used the wiki are Activity's (design §12.3.2, `WikiActivityPage`), which still takes
 * its blocks from the bottom of this file.
 *
 * THE DOCUMENTS ARE THE CONFIRMED PLAN'S, in the plan page's own rows: a number, a title and the
 * document's lead, a blue dot on one written since the reader last looked, and what is not written yet
 * folded into one row a category, opened to its titles. Before a plan is confirmed the home lists the topic
 * articles as the directory does (`wikiReadsByDocs` false), a title a row. A space with neither says how
 * it comes to have some — maintenance, not set up yet — or, once it is, only that it has none yet.
 *
 * WHAT IS KNOWN IS DRAWN AT ONCE (design §12.3.6): the head is the spaces list the drawer has already
 * read; the content line and the documents are grey bars until their own read is in, and only the first
 * time — after that the home draws what it read last while it reads again.
 *
 * THE PRINCIPLES READ THEIR OWN KIND, never the newest 200 entries of every kind: a space holds
 * thousands, and a principle older than the 200th newest entry dropped off the page.
 */
export function WikiHome({ space }: { space: WikiSpaceRow }) {
  const principleRead = useQuery(wikiEntriesOfKindQuery(space.id, 'principle', PRINCIPLES_READ));
  const home = useWikiHomeContent(space.id);
  // What was new is read before the stamp moves: `seen` is fixed at mount, and the effect below is
  // what makes the NEXT visit compare against this one.
  const [seen] = useState(() => readSeen(space.slug));
  useEffect(() => {
    moveWikiSeen(wikiSeenKey(space.slug, 'home'));
  }, [space.slug]);

  // Oldest first: the principles are a pinned set a reader reads top to bottom, and a new one appends
  // to the bottom of it rather than pushing the rest down. The blue dot is what says which is new.
  const principles = useMemo(
    () =>
      [...wikiEntriesOfKind(principleRead.data ?? [], 'principle')].sort(
        (a, b) => Date.parse(a.recordedAt) - Date.parse(b.recordedAt),
      ),
    [principleRead.data],
  );
  const categories = useMemo(() => (home.directory ? wikiHomeCategories(home.directory, seen) : []), [home.directory, seen]);
  const listed = home.directory !== null || home.topics > 0;

  return (
    <div className="wk-home">
      {principles.length > 0 && <HomePrinciples principles={principles} spaceSlug={space.slug} seen={seen} />}
      {home.loading ? (
        <HomeSkeleton />
      ) : home.directory ? (
        categories.map((category) => <HomeCategory key={category.key} category={category} spaceSlug={space.slug} />)
      ) : listed ? (
        home.groups.map((group) => <HomeTopics key={group.key} group={group} spaceSlug={space.slug} />)
      ) : (
        !space.settings?.maintenance?.enabled && <HomeNewSpace spaceSlug={space.slug} />
      )}
      {!home.loading && listed && (
        <div className="wk-home-more">
          <Link to={wikiBrowsePath(space.slug)}>
            <AppstoreOutlined className="ic" />
            {WIKI_BROWSE}
          </Link>
          <Link to={wikiIndexPath(space.slug)}>
            <SortAscendingOutlined className="ic" />
            {WIKI_AZ_INDEX}
          </Link>
        </div>
      )}
    </div>
  );
}

/**
 * The line under the head on the home (design §12.3.1): the documents and how many are written, the
 * topic articles before a plan, `No documents yet` — or a grey bar while the first read is out.
 */
export function WikiHomeState({ spaceId }: { spaceId: string }) {
  const home = useWikiHomeContent(spaceId);
  return (
    <div className="wk-home-state">
      {home.loading ? <span className="wk-sk" aria-hidden="true" /> : wikiHomeLine(home.directory, home.topics)}
    </div>
  );
}

/**
 * What the home reads by: the confirmed plan's documents, or — before one, as the directory does — the
 * topic articles. `loading` is the first read alone: a read the page already has stays drawn while it is
 * read again.
 */
function useWikiHomeContent(spaceId: string): {
  directory: WikiDocsDirectory | null;
  groups: WikiDirectoryGroup[];
  topics: number;
  loading: boolean;
} {
  const docs = useQuery(wikiDocsQuery(spaceId));
  const articles = useQuery(wikiArticlesQuery(spaceId));
  const byDocs = wikiReadsByDocs(docs.data);
  const groups = useMemo(() => (articles.data && !byDocs ? wikiDirectoryGroups(articles.data) : []), [articles.data, byDocs]);
  return {
    directory: byDocs ? (docs.data ?? null) : null,
    groups,
    topics: groups.reduce((sum, group) => sum + group.topics.length, 0),
    loading: docs.isPending || (!byDocs && articles.isPending),
  };
}

/** The principles (mock 31 ③): the owner's, the first three a title a row with its day, then `All N ›`. */
function HomePrinciples({ principles, spaceSlug, seen }: { principles: readonly WikiEntry[]; spaceSlug: string; seen: number }) {
  const [all, setAll] = useState(false);
  return (
    <section className="wk-pl-cat wk-home-pr">
      <div className="wk-pl-cat-h">
        <b>{WIKI_PRINCIPLES}</b>
        <span className="wk-home-n">{principles.length}</span>
        <WikiTrustBadge trust="owner" />
        {!all && principles.length > PRINCIPLES_SHOWN && (
          <button type="button" className="wk-home-all" onClick={() => setAll(true)}>
            {wikiAllPrinciples(principles.length)}
          </button>
        )}
      </div>
      {(all ? principles : principles.slice(0, PRINCIPLES_SHOWN)).map((entry) => (
        <WikiDocRow
          key={entry.id}
          className="pr"
          to={wikiEntryPath(spaceSlug, entry.id)}
          number={<PushpinOutlined className="ic" />}
          title={entry.title}
          fresh={wikiChangedSince([entry], seen).length > 0}
          end={<span className="d">{wikiShortDay(entry.validFrom)}</span>}
        />
      ))}
    </section>
  );
}

/**
 * One category of the plan: its head as the plan page draws it, its written documents with their leads,
 * then one row for the rest — `+3 not written yet`, or `3 documents · Not written yet` when none is — which
 * opens to their titles in grey, as the directory draws a document not written yet (mock 26 ②).
 */
function HomeCategory({ category, spaceSlug }: { category: WikiHomeCategory; spaceSlug: string }) {
  const [open, setOpen] = useState(false);
  const folded = wikiNotWrittenRow(category);
  return (
    <section className="wk-pl-cat">
      <div className="wk-pl-cat-h">
        <span className="no">{category.number}</span>
        <b>{category.title}</b>
      </div>
      {category.written.map((doc) => (
        <WikiDocRow
          key={doc.slug}
          to={wikiDocPath(spaceSlug, doc.slug)}
          number={doc.number}
          title={doc.title}
          fresh={doc.fresh}
          line={doc.lead ?? undefined}
          lead
        />
      ))}
      {folded && (
        <button type="button" className="wk-pl-doc phone more" aria-expanded={open} onClick={() => setOpen(!open)}>
          <span className="no" />
          <span className="main">
            <span className="q">{folded}</span>
          </span>
          <RightOutlined className="chev" />
        </button>
      )}
      {open &&
        category.notWritten.map((doc) => (
          <WikiDocRow
            key={doc.slug}
            className="todo"
            to={wikiDocPath(spaceSlug, doc.slug)}
            number={doc.number}
            title={doc.title}
            line={WIKI_DOC_NOT_WRITTEN_SHORT}
          />
        ))}
    </section>
  );
}

/** Before a plan is confirmed: a category of the directory, each topic's article a title a row. */
function HomeTopics({ group, spaceSlug }: { group: WikiDirectoryGroup; spaceSlug: string }) {
  return (
    <section className="wk-pl-cat">
      <div className="wk-pl-cat-h">
        <b>{group.title}</b>
      </div>
      {group.topics.map((topic) => (
        <WikiDocRow key={topic.slug} className="topic" to={wikiArticlePath(spaceSlug, topic.slug)} title={topic.title} />
      ))}
    </section>
  );
}

/** A new space (mock 31 ⑥): no document, no maintenance — one card, and the way to set it up. */
function HomeNewSpace({ spaceSlug }: { spaceSlug: string }) {
  return (
    <div className="wk-home-new">
      <p>{WIKI_NO_DOCUMENTS_NOTE}</p>
      <Link to={wikiSettingsPath(spaceSlug)}>{WIKI_PLAN_SET_UP} ›</Link>
    </div>
  );
}

/** The documents' first read (mock 31 ⑦): a category's bar, then four documents' — number, title, two lines. */
const SKELETON_ROWS: ReadonlyArray<[number, number]> = [
  [130, 55],
  [171, 72],
  [212, 59],
  [163, 76],
];

function HomeSkeleton() {
  return (
    <section className="wk-pl-cat wk-home-sk" aria-busy="true">
      <div className="wk-pl-cat-h">
        <span className="wk-sk" />
      </div>
      {SKELETON_ROWS.map(([title, last], index) => (
        <div className="wk-pl-doc phone" key={index}>
          <span className="no">
            <span className="wk-sk" />
          </span>
          <span className="main">
            <span className="wk-sk" style={{ width: title }} />
            <span className="wk-sk" />
            <span className="wk-sk" style={{ width: `${last}%` }} />
          </span>
        </div>
      ))}
    </section>
  );
}

// ── Activity's blocks (design §12.3.2), drawn on the home until 2026-10-06 ─────────────────────────

/** The decision log's rows: when, what, what it replaced, and whether it is still in force. */
export function WikiDecisionRows({
  decisions,
  entryById,
  spaceSlug,
}: {
  decisions: readonly WikiEntry[];
  entryById: ReadonlyMap<string, WikiEntry>;
  spaceSlug: string;
}) {
  return (
    <>
      {decisions.map((entry) => (
        <div className="wk-dec" key={entry.id}>
          <span className="d">{entry.validFrom.slice(0, 10)}</span>
          <div className="wk-row-main">
            <div className="t">
              <Link to={wikiEntryPath(spaceSlug, entry.id)}>{entry.title}</Link>
            </div>
            {entry.supersededById && (
              <div className="s">
                <span>supersedes</span>
                <span className="x">{entryById.get(entry.supersededById)?.title ?? entry.supersededById}</span>
              </div>
            )}
          </div>
          <WikiDecisionBadge entry={entry} />
        </div>
      ))}
    </>
  );
}

/** The right rail's first card: the proposals waiting, and the way into Review. */
export function ReviewCard({
  space,
  pending,
  changesets,
}: {
  space: WikiSpaceWithUsage;
  pending: WikiChangesetOp[];
  changesets: WikiChangeset[];
}) {
  const navigate = useNavigate();
  const sessions = new Set(changesets.map((changeset) => changeset.sessionId).filter(Boolean));
  const oldest = pending
    .map((op) => changesets.find((changeset) => changeset.id === op.changesetId)?.createdAt)
    .filter((at): at is string => !!at)
    .sort()[0];

  return (
    <WikiCard
      title={WIKI_REVIEW_TITLE}
      leading={<WikiDot tone="amber" />}
      trailing={<span className="tp-count needs-you">{pending.length}</span>}
      className="wk-review-card"
    >
      {pending.length === 0 ? (
        <WikiEmpty>{WIKI_NO_REVIEW}</WikiEmpty>
      ) : (
        <>
          <div className="project-open-items-hint wk-review-sub">
            {wikiProposalsFrom(pending.length, sessions.size)}
          </div>
          {pending.slice(0, 3).map((op, index) => (
            <div className={`wk-rv-row${index === 0 ? ' first' : ''}`} key={op.id}>
              <WikiOpChip op={op.op} />
              <span className="t">{opTitle(op)}</span>
              <span className="a">{relTime(changesetAt(op, changesets))}</span>
            </div>
          ))}
          <div className="wk-rv-foot">
            <Button type="primary" size="small" onClick={() => navigate('/wiki/review')}>
              {WIKI_REVIEW_TITLE}
            </Button>
            {oldest && <span className="hint">{wikiOldest(relTime(oldest))}</span>}
          </div>
        </>
      )}
    </WikiCard>
  );
}

/**
 * One row of the change feed: what happened, to what, and — when there is one — the note under it.
 * `fresh` is Activity's: blue when it came after the reader last looked, grey when before; left out,
 * the dot is the entry's trust.
 */
export function TimelineRow({ item, spaceSlug, fresh }: { item: WikiTimelineItem; spaceSlug: string; fresh?: boolean }) {
  const note = wikiChangeNote(item);
  const retired = item.status === 'retired' || item.status === 'superseded' || item.status === 'rejected';
  const trust = (item.trust ?? 'proposed') as WikiTrust;
  return (
    <li className={retired ? 'retired' : ''}>
      <WikiDot tone={fresh !== undefined ? (fresh ? 'blue' : 'muted') : retired ? 'muted' : WIKI_TRUST_TONE[trust]} />
      <div>
        <div className="wk-tl-h">
          <b>{wikiChangeVerb(item)}</b>
          {item.appliedByMode && !retired && (trust === 'auto' || trust === 'unreviewed') && <WikiTrustBadge trust={trust} />}
          <span className="when">{relTime(item.at)}</span>
        </div>
        <div className="wk-tl-t">
          {item.entryId ? (
            <Link to={wikiEntryPath(spaceSlug, item.entryId)}>{item.title ?? '—'}</Link>
          ) : (
            (item.title ?? '—')
          )}
        </div>
        {note && <div className="wk-tl-n">{note}</div>}
      </div>
    </li>
  );
}

/** The right rail's last card: what the agents have actually done with this wiki. */
export function UsageCard({ space }: { space: WikiSpaceWithUsage }) {
  const usage = space.usage;
  const total = usage?.entries.reduce((sum, entry) => sum + entry.total, 0) ?? 0;
  if (!usage || total === 0) {
    return (
      <WikiCard title={WIKI_AGENTS_USED} hint={WIKI_AGENTS_USED_HINT}>
        <WikiEmpty>{WIKI_NO_AGENTS_YET}</WikiEmpty>
      </WikiCard>
    );
  }
  const top = usage.entries.slice(0, 3);
  const widest = top[0]?.total ?? 1;
  return (
    <WikiCard title={WIKI_AGENTS_USED} hint={WIKI_AGENTS_USED_HINT}>
      <div className="wk-stats">
        <div>
          <div className="n">{usage.sessionsPushed}</div>
          <div className="l">{WIKI_SESSIONS_RECEIVED}</div>
        </div>
        <div>
          <div className="n">{usage.searches}</div>
          <div className="l">{WIKI_SEARCHES}</div>
        </div>
      </div>
      <div className="wk-bars">
        <div className="h">{WIKI_MOST_USED}</div>
        {top.map((entry) => (
          <div className="wk-bar" key={entry.entryId}>
            <div className="t">
              <Link to={wikiEntryPath(space.slug, entry.entryId)}>{entry.title ?? entry.entryId}</Link>
            </div>
            <div className="b">
              <i style={{ width: `${Math.max(6, Math.round((entry.total / widest) * 100))}%` }} />
              <span className="v">{entry.total}×</span>
            </div>
          </div>
        ))}
      </div>
    </WikiCard>
  );
}

/** A decision's badge: in force, or the ending it met. */
function WikiDecisionBadge({ entry }: { entry: WikiEntry }) {
  const word = entry.status === 'active' ? 'Active' : entry.status === 'superseded' ? 'Superseded' : entry.status;
  const tone = entry.status === 'active' ? 'green' : 'muted';
  return <span className={`tdp-badge tone-${tone}`}>{word}</span>;
}

// ── Readings of the review queue, shared with nothing else ──────────────────────────────────────

/** Every op still waiting, oldest changeset first, which is the order they are answered in. */
export function reviewOps(changesets: readonly WikiChangeset[]): WikiChangesetOp[] {
  return changesets
    .flatMap((changeset) => changeset.ops.filter((op) => op.decision === 'pending'))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** When the changeset an op belongs to was written. */
export function changesetAt(op: WikiChangesetOp, changesets: readonly WikiChangeset[]): string {
  return changesets.find((changeset) => changeset.id === op.changesetId)?.createdAt ?? new Date().toISOString();
}

/**
 * What a pending op is about: the entry an add or a supersede drafts, else the entry it names — by the
 * title Review's read carries for it (`entryTitle`), which no window of entries can leave out.
 */
export function opTitle(op: WikiChangesetOp): string {
  const payload = (op.payload ?? {}) as { entry?: { title?: unknown }; changes?: { title?: unknown } };
  if (typeof payload.entry?.title === 'string') return payload.entry.title;
  if (op.entryTitle) return op.entryTitle;
  if (typeof payload.changes?.title === 'string') return payload.changes.title;
  return op.op === 'add' ? 'A new entry' : 'An entry';
}

/** When this reader last had the home page open, and the stamp that moves it forward. */
function readSeen(spaceSlug: string): number {
  return readWikiSeen(wikiSeenKey(spaceSlug, 'home'));
}
