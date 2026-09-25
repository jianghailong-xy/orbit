import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Button } from 'antd';
import { relTime } from './Transcript';
import { WikiCard, WikiEmpty, WikiPin } from './WikiCards';
import { WikiEntryLine } from './WikiEntryRow';
import { WikiDot, WikiOpChip } from './WikiMarks';
import { wikiEntriesQuery, wikiReviewQuery, wikiSpaceQuery, wikiSpacesQuery, wikiTimelineQuery } from '../lib/queries';
import type { WikiChangeset, WikiChangesetOp, WikiEntry, WikiSpaceWithUsage, WikiTimelineItem } from '../lib/wiki';
import {
  WIKI_AGENTS_USED,
  WIKI_AGENTS_USED_HINT,
  WIKI_ALL_DECISIONS,
  WIKI_MOST_USED,
  WIKI_NO_AGENTS_YET,
  WIKI_NO_CHANGES,
  WIKI_NO_DECISIONS,
  WIKI_NO_ENTRIES,
  WIKI_NO_REVIEW,
  WIKI_NO_TOPICS,
  WIKI_PRINCIPLES,
  WIKI_PRINCIPLES_HINT,
  WIKI_RECENT_DECISIONS,
  WIKI_RECENT_DECISIONS_HINT,
  WIKI_RECENTLY_CHANGED,
  WIKI_REVIEW_TITLE,
  WIKI_SEARCHES,
  WIKI_SESSIONS_RECEIVED,
  WIKI_TOPICS,
  WIKI_TRUST_TONE,
  wikiChangeNote,
  wikiChangeVerb,
  wikiChangedSince,
  wikiEntriesOfKind,
  wikiEntryPath,
  wikiOldest,
  wikiProposalsFrom,
  wikiSeenKey,
  wikiTopicPath,
  wikiTopicSummaries,
  readWikiSeen,
  writeWikiSeen,
  type WikiTrust,
} from '../lib/wiki';

/**
 * The Wiki home: what the space holds, and what wants the owner's attention.
 *
 * THE ORDER IS THE DESIGN'S (§12.1, mock 01): Principles, then the Topics grid, then the decision
 * log, with Review leading the right rail above what changed lately and what the agents used. The
 * same order, and the same words, are what iOS draws — `WIKI_*` here is one half of that pair.
 *
 * EVERY NUMBER IS READ, NOT INVENTED. The three counts on the status row, the topic tallies, the
 * decision log and the usage bars all come from the space and its entries; the one block whose data
 * phase 1 has no writer for ("Detector") is absent from the entry drawer rather than drawn at zero,
 * and the usage block says plainly when nothing has used the wiki yet.
 */
export function WikiHome({ space }: { space: WikiSpaceWithUsage }) {
  const entries = useQuery(wikiEntriesQuery(space.id));
  const timeline = useQuery(wikiTimelineQuery(space.id));
  const review = useQuery(wikiReviewQuery(space.id));
  const all = entries.data ?? [];
  // What was new is read before the stamp moves: `seen` is fixed at mount, and the effect below is
  // what makes the NEXT visit compare against this one.
  const [seen] = useState(() => readSeen(space.slug));
  useEffect(() => {
    writeWikiSeen(wikiSeenKey(space.slug, 'home'));
  }, [space.slug]);

  const principles = useMemo(() => wikiEntriesOfKind(all, 'principle'), [all]);
  const decisions = useMemo(() => wikiEntriesOfKind(all, 'decision'), [all]);
  const topics = useMemo(() => wikiTopicSummaries(all), [all]);
  const pending = useMemo(() => reviewOps(review.data ?? []), [review.data]);
  const entryById = useMemo(() => new Map(all.map((entry) => [entry.id, entry])), [all]);

  return (
    <div className="wk-cols">
      <div className="wk-col">
        <WikiCard
          title={WIKI_PRINCIPLES}
          leading={<WikiPin />}
          hint={`${principles.length} · ${WIKI_PRINCIPLES_HINT}`}
        >
          {principles.length === 0 ? (
            <WikiEmpty>{WIKI_NO_ENTRIES}</WikiEmpty>
          ) : (
            principles.map((entry) => (
              <WikiEntryLine
                key={entry.id}
                entry={entry}
                spaceSlug={space.slug}
                newSince={wikiChangedSince([entry], seen).length > 0}
              />
            ))
          )}
        </WikiCard>

        <WikiCard title={WIKI_TOPICS} hint={`${topics.length} ${WIKI_TOPICS.toLowerCase()} · ${all.length} entries`}>
          {topics.length === 0 ? (
            <WikiEmpty>{WIKI_NO_TOPICS}</WikiEmpty>
          ) : (
            <div className="wk-topics">
              {topics.map((topic) => (
                <Link className="wk-topic" key={topic.slug} to={wikiTopicPath(space.slug, topic.slug)}>
                  <div className="wk-topic-h">
                    <span className="wk-topic-n">{topicTitle(topic.slug)}</span>
                    <span className="wk-topic-c">{topic.count}</span>
                  </div>
                  <div className="wk-topic-l">
                    {topic.latest ? (
                      <>
                        <b>{wikiChangeVerbOfEntry(topic.latest, entryById)}</b>{' '}
                        <span className="when">{relTime(topic.latest.validFrom)}</span> · {topic.latest.title}
                      </>
                    ) : null}
                  </div>
                </Link>
              ))}
            </div>
          )}
        </WikiCard>

        <WikiCard
          title={WIKI_RECENT_DECISIONS}
          hint={WIKI_RECENT_DECISIONS_HINT}
          trailing={
            <Link className="wk-card-more" to={wikiTopicPath(space.slug, 'decisions')}>
              {WIKI_ALL_DECISIONS}
            </Link>
          }
        >
          {decisions.length === 0 ? (
            <WikiEmpty>{WIKI_NO_DECISIONS}</WikiEmpty>
          ) : (
            decisions.slice(0, 4).map((entry) => (
              <div className="wk-dec" key={entry.id}>
                <span className="d">{entry.validFrom.slice(0, 10)}</span>
                <div className="wk-row-main">
                  <div className="t">
                    <Link to={wikiEntryPath(space.slug, entry.id)}>{entry.title}</Link>
                  </div>
                  {entry.supersededById && (
                    <div className="s">
                      <span>supersedes</span>
                      <span className="x">
                        {entryById.get(entry.supersededById)?.title ?? entry.supersededById}
                      </span>
                    </div>
                  )}
                </div>
                <WikiDecisionBadge entry={entry} />
              </div>
            ))
          )}
        </WikiCard>
      </div>

      <div className="wk-col">
        <ReviewCard space={space} pending={pending} changesets={review.data ?? []} entryById={entryById} />

        <WikiCard title={WIKI_RECENTLY_CHANGED}>
          {(timeline.data?.items ?? []).length === 0 ? (
            <WikiEmpty>{WIKI_NO_CHANGES}</WikiEmpty>
          ) : (
            <ol className="wk-tl">
              {(timeline.data?.items ?? []).slice(0, 5).map((item) => (
                <TimelineRow key={item.opId} item={item} spaceSlug={space.slug} />
              ))}
            </ol>
          )}
        </WikiCard>

        <UsageCard space={space} />
      </div>
    </div>
  );
}

/** The right rail's first card: the proposals waiting, and the way into Review. */
function ReviewCard({
  space,
  pending,
  changesets,
  entryById,
}: {
  space: WikiSpaceWithUsage;
  pending: WikiChangesetOp[];
  changesets: WikiChangeset[];
  entryById: Map<string, WikiEntry>;
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
              <span className="t">{opTitle(op, entryById)}</span>
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

/** One row of the change feed: what happened, to what, and — when there is one — the note under it. */
function TimelineRow({ item, spaceSlug }: { item: WikiTimelineItem; spaceSlug: string }) {
  const note = wikiChangeNote(item);
  const retired = item.status === 'retired' || item.status === 'superseded' || item.status === 'rejected';
  const trust = (item.trust ?? 'proposed') as WikiTrust;
  return (
    <li className={retired ? 'retired' : ''}>
      <WikiDot tone={retired ? 'muted' : WIKI_TRUST_TONE[trust]} />
      <div>
        <div className="wk-tl-h">
          <b>{wikiChangeVerb(item)}</b>
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
function UsageCard({ space }: { space: WikiSpaceWithUsage }) {
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

/** What a pending op is about: the entry it names, or the one an add would create. */
export function opTitle(op: WikiChangesetOp, entryById: Map<string, WikiEntry>): string {
  const named = entryById.get(op.resultEntryId ?? op.entryId ?? '');
  if (named) return named.title;
  const payload = (op.payload ?? {}) as { entry?: { title?: unknown }; changes?: { title?: unknown } };
  if (typeof payload.entry?.title === 'string') return payload.entry.title;
  if (typeof payload.changes?.title === 'string') return payload.changes.title;
  return op.op === 'add' ? 'A new entry' : 'An entry';
}

/** A topic's name, read out of its slug the way the server reads it. */
export function topicTitle(slug: string): string {
  const words = slug.split('-').filter(Boolean);
  if (words.length === 0) return slug;
  return [words[0].charAt(0).toUpperCase() + words[0].slice(1), ...words.slice(1)].join(' ');
}

/** The verb the Topics grid leads with: what the newest entry in a topic is, and who made it so. */
function wikiChangeVerbOfEntry(entry: WikiEntry, entryById: Map<string, WikiEntry>): string {
  if (entry.status === 'superseded') return 'Superseded';
  if (entry.status === 'retired') return 'Retired';
  if (entry.trust === 'owner') return 'Added by you';
  if (entry.supersededById && entryById.has(entry.supersededById)) return 'Superseded';
  return 'Confirmed';
}

/** When this reader last had the home page open, and the stamp that moves it forward. */
function readSeen(spaceSlug: string): number {
  return readWikiSeen(wikiSeenKey(spaceSlug, 'home'));
}
