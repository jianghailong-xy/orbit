import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { RightOutlined } from '@ant-design/icons';
import { WikiEmpty } from './WikiCards';
import { WikiEntryRow } from './WikiEntryRow';
import { wikiTopicQuery } from '../lib/queries';
import type { WikiEntry } from '../lib/wiki';
import {
  WIKI_COL_ANCHOR,
  WIKI_COL_CONFIRMED_BY,
  WIKI_COL_THIS_WEEK,
  WIKI_ENTRIES_LABEL,
  WIKI_NO_ENTRIES,
  WIKI_SHOW_LESS,
  WIKI_TITLE,
  WIKI_TOPIC_GROUPS,
  WIKI_TOPIC_MISSING,
  WIKI_TOPIC_TITLE_FALLBACK,
  WIKI_WARN_ANCHOR_CHANGED,
  readWikiSeen,
  wikiChangedSince,
  wikiChangedSinceLastVisit,
  wikiGroupEntries,
  wikiSeenKey,
  wikiShowMore,
  wikiSpacePath,
  writeWikiSeen,
} from '../lib/wiki';

/**
 * A topic's page: its entries, grouped the way the design groups them.
 *
 * NO GENERATED SUMMARY, deliberately and for now. Design §12.1 puts one at the top of this page and
 * it belongs to phase 2 (`wiki_topic_summary`, written by the maintenance run, every sentence
 * footnoted back to an entry). Phase 1 has nothing to generate it with, and a heading over an empty
 * box reads as a page that failed to load — so the section is absent until there is something to put
 * in it, which is what this task's own instructions ask for.
 *
 * THE GROUPS COME FROM THE SHARED REGISTRY: `WIKI_TOPIC_GROUPS` names the kinds each one holds, so a
 * group appears exactly when the topic has entries of those kinds and disappears when it does not —
 * the design's rule is that a group with nothing in it is not shown at all.
 */
export function WikiTopicPage({ spaceId, spaceSlug }: { spaceId: string; spaceSlug: string }) {
  const params = useParams();
  const topic = params.topic ?? '';
  // The ROOM's id on the wire and its slug in the URL: a slug is what a reader can read and what a
  // link should carry, and the door addresses a space by its id.
  const topicView = useQuery(wikiTopicQuery(spaceId, topic || null));
  const entries = useMemo(() => topicView.data?.entries ?? [], [topicView.data]);
  // The stamp is read before it moves, so what was new since the reader's last visit is decided
  // once, on the render that opened the page (see `lib/wiki.ts`).
  const [seen] = useState(() => readWikiSeen(wikiSeenKey(spaceSlug, topic)));
  useEffect(() => {
    if (topicView.isSuccess) writeWikiSeen(wikiSeenKey(spaceSlug, topic));
  }, [spaceSlug, topic, topicView.isSuccess]);

  const changed = useMemo(
    () => new Set(wikiChangedSince(entries, seen).map((entry) => entry.id)),
    [entries, seen],
  );
  const byId = useMemo(() => new Map(entries.map((entry) => [entry.id, entry])), [entries]);
  const groups = useMemo(
    () =>
      WIKI_TOPIC_GROUPS.map((group) => ({ ...group, entries: wikiGroupEntries(entries, group.kinds) })).filter(
        (group) => group.entries.length > 0,
      ),
    [entries],
  );

  return (
    <div className="wk-topic-page">
      <div className="wk-crumb">
        <Link to={wikiSpacePath(spaceSlug)}>{WIKI_TITLE}</Link>
        <RightOutlined className="ic" />
        <span>{topicView.data?.title ?? WIKI_TOPIC_TITLE_FALLBACK}</span>
      </div>
      <h1 className="t-title">{topicView.data?.title ?? topic}</h1>
      <div className="t-meta">
        <span>
          {entries.length} {WIKI_ENTRIES_LABEL.toLowerCase()}
        </span>
        {changed.size > 0 && (
          <>
            <span className="sep">·</span>
            <span className="chg">
              <span className="wk-new" />
              {wikiChangedSinceLastVisit(changed.size)}
            </span>
          </>
        )}
      </div>

      {topicView.isError ? (
        <WikiEmpty>{WIKI_TOPIC_MISSING}</WikiEmpty>
      ) : entries.length === 0 && topicView.isSuccess ? (
        <WikiEmpty>{WIKI_NO_ENTRIES}</WikiEmpty>
      ) : (
        groups.map((group) => (
          <TopicGroup
            key={group.title}
            title={group.title}
            note={group.note}
            spaceSlug={spaceSlug}
            entries={group.entries}
            byId={byId}
            changed={changed}
          />
        ))
      )}
    </div>
  );
}

/** One kind-group: the head's three columns, then the rows measured against them. */
function TopicGroup({
  title,
  note,
  spaceSlug,
  entries,
  byId,
  changed,
}: {
  title: string;
  note: string;
  spaceSlug: string;
  entries: WikiEntry[];
  byId: Map<string, WikiEntry>;
  changed: Set<string>;
}) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? entries : entries.slice(0, 4);
  const hidden = entries.length - shown.length;
  return (
    <section className="wk-sec">
      <div className="wk-sec-h">
        <h3>{title}</h3>
        <span className="n">{entries.length}</span>
        <span className="note">{note}</span>
        <span className="cols">
          <span className="col">{WIKI_COL_CONFIRMED_BY}</span>
          <span className="col">{WIKI_COL_ANCHOR}</span>
          <span className="col">{WIKI_COL_THIS_WEEK}</span>
        </span>
      </div>
      {shown.map((entry) => (
        <WikiEntryRow
          key={entry.id}
          entry={entry}
          spaceSlug={spaceSlug}
          changedSinceLastVisit={changed.has(entry.id)}
          warnLine={entry.anchorState === 'changed' ? WIKI_WARN_ANCHOR_CHANGED : null}
          successor={entry.supersededById ? (byId.get(entry.supersededById) ?? null) : null}
        />
      ))}
      {hidden > 0 ? (
        <button type="button" className="wk-more" onClick={() => setExpanded(true)}>
          {wikiShowMore(hidden)}
        </button>
      ) : entries.length > 4 ? (
        <button type="button" className="wk-more" onClick={() => setExpanded(false)}>
          {WIKI_SHOW_LESS}
        </button>
      ) : null}
    </section>
  );
}
