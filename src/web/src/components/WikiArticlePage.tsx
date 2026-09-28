import { Fragment, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Button, Drawer, Popover } from 'antd';
import { ClockCircleOutlined, RightOutlined } from '@ant-design/icons';
import { WikiEmpty } from './WikiCards';
import { WikiContentsButton } from './WikiDirectory';
import { WikiAnchorMark, WikiKindMark, WikiTrustBadge } from './WikiMarks';
import { WikiTopicGroup, WikiTopicPage } from './WikiTopicPage';
import { wikiArticleQuery, wikiEntryQuery } from '../lib/queries';
import { PHONE_QUERY, useMediaQuery } from '../lib/useMediaQuery';
import {
  WIKI_ACTION_OPEN,
  WIKI_KIND_LABELS,
  WIKI_TITLE,
  WIKI_TOPIC_MISSING,
  readWikiSeen,
  wikiAnchorMark,
  wikiChangedSince,
  wikiEntryPath,
  wikiSeenKey,
  wikiSpacePath,
  writeWikiSeen,
  type WikiEntryKind,
  type WikiTrust,
} from '../lib/wiki';
import {
  WIKI_ARTICLE_ENTRIES,
  WIKI_FOOTNOTES,
  WIKI_FOOTNOTE_GONE,
  WIKI_NO_ARTICLE_YET,
  wikiArticleEntriesHint,
  wikiArticleGroups,
  wikiArticleKindTags,
  wikiArticlePath,
  wikiArticleUpdated,
  wikiBrowsePath,
  wikiEntriesCited,
  wikiNoteLabel,
  wikiSentenceSegments,
  wikiSourceCounts,
  wikiSourcesLine,
  type WikiArticleFootnote,
  type WikiArticleView,
} from '../lib/wikiArticles';

/**
 * A topic's page, article first (criterion 10, mocks 13–14): the crumb, the title, the tags, when and
 * from what it was written, the text with a superscript footnote after every sentence, the footnotes,
 * then the entries it was written from, by kind. The order is the web phone's and iOS's alike
 * (`WIKI_ARTICLE_SECTIONS`, held by `WikiArticlesCopyParityTests`).
 *
 * A TOPIC WITH NO ARTICLE is still a page: the article read answers 404 until a maintenance run has
 * written one, and the page is then the topic's entries alone — the phase-1 topic page.
 *
 * A FOOTNOTE OPENS ITS ENTRY'S CARD where the reader is: a popover beside the number on a desktop, a
 * sheet from the bottom on a phone, where a superscript is too small a target for a second tap inside
 * a popover. The card's Open entry is the entry's page, with this article kept behind it.
 */
export function WikiArticleRoute({
  spaceId,
  spaceSlug,
  topicSlug,
  part,
}: {
  spaceId: string;
  spaceSlug: string;
  topicSlug: string;
  part: number;
}) {
  const article = useQuery(wikiArticleQuery(spaceId, topicSlug, part));
  if (article.data === null) {
    return <WikiTopicPage spaceId={spaceId} spaceSlug={spaceSlug} topicSlug={topicSlug} note={WIKI_NO_ARTICLE_YET} />;
  }
  // A read that failed for another reason still leaves the topic's entries to read.
  if (article.isError) return <WikiTopicPage spaceId={spaceId} spaceSlug={spaceSlug} topicSlug={topicSlug} />;
  if (!article.data) return <div className="wk-art-page" aria-busy={article.isPending} />;
  return <WikiArticlePage article={article.data} spaceSlug={spaceSlug} />;
}

export function WikiArticlePage({
  article,
  spaceSlug,
}: {
  article: WikiArticleView;
  spaceSlug: string;
}) {
  const topicSlug = article.topic.slug;
  // The entries it was written from, as its read carries them (contract `articles.reads.article`).
  const entries = article.entries;
  const [seen] = useState(() => readWikiSeen(wikiSeenKey(spaceSlug, topicSlug)));
  useEffect(() => {
    writeWikiSeen(wikiSeenKey(spaceSlug, topicSlug));
  }, [spaceSlug, topicSlug]);

  const cited = useMemo(() => article.footnotes.map((note) => note.entryId), [article.footnotes]);
  const groups = useMemo(() => wikiArticleGroups(entries, cited), [entries, cited]);
  const byId = useMemo(() => new Map(entries.map((entry) => [entry.id, entry])), [entries]);
  const changed = useMemo(() => new Set(wikiChangedSince(entries, seen).map((entry) => entry.id)), [entries, seen]);
  const tags = useMemo(() => wikiArticleKindTags(entries), [entries]);
  const notes = useMemo(() => new Map(article.footnotes.map((note) => [note.n, note])), [article.footnotes]);

  return (
    <article className="wk-art-page">
      <div className="wk-art-crumbrow">
        <div className="wk-crumb">
          <Link to={wikiSpacePath(spaceSlug)}>{WIKI_TITLE}</Link>
          {article.topic.categoryTitle && (
            <>
              <RightOutlined className="ic" />
              <Link to={wikiBrowsePath(spaceSlug)}>{article.topic.categoryTitle}</Link>
            </>
          )}
          <RightOutlined className="ic" />
          <Link to={wikiArticlePath(spaceSlug, topicSlug)}>{article.topic.title}</Link>
        </div>
        <WikiContentsButton />
      </div>
      <h1 className="t-title wk-art-title">{article.title}</h1>
      <div className="wk-tags">
        {article.topic.categoryTitle && <span className="wk-tag cat">{article.topic.categoryTitle}</span>}
        <span className="wk-tag">{article.topic.title}</span>
        {tags.map((tag) => (
          <span className="wk-tag" key={tag}>
            {tag}
          </span>
        ))}
      </div>
      <div className="t-meta wk-art-updated">
        <ClockCircleOutlined className="ic" />
        <span>{wikiArticleUpdated(article)}</span>
      </div>

      <WikiArticleText article={article} notes={notes} spaceSlug={spaceSlug} />

      <section className="wk-fnlist">
        <h3>
          {WIKI_FOOTNOTES} <small>{wikiEntriesCited(article.footnotes.length)}</small>
        </h3>
        <ol>
          {article.footnotes.map((note) => (
            <li key={note.n}>
              <span className="no">{note.n}.</span>
              {note.entry ? (
                <Link className="tt" to={wikiEntryPath(spaceSlug, note.entryId)} state={{ wikiBack: { topic: topicSlug, part: article.part } }}>
                  {note.entry.title}
                </Link>
              ) : (
                <span className="tt gone">{WIKI_FOOTNOTE_GONE}</span>
              )}
              {note.entry && (
                <span className="mt">
                  {WIKI_KIND_LABELS[note.entry.kind as WikiEntryKind] ?? note.entry.kind} ·{' '}
                  <WikiTrustBadge trust={note.entry.trust as WikiTrust} />
                </span>
              )}
            </li>
          ))}
        </ol>
      </section>

      <section className="wk-art-entries">
        <h3 className="wk-art-entries-h">
          {WIKI_ARTICLE_ENTRIES}{' '}
          <small>{wikiArticleEntriesHint(article.entryIds.length)}</small>
        </h3>
        {entries.length === 0 ? (
          <WikiEmpty>{WIKI_TOPIC_MISSING}</WikiEmpty>
        ) : (
          groups.map((group) => (
            <WikiTopicGroup
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
      </section>
    </article>
  );
}

/** Which sentence's footnote is open, and which of its numbers. */
interface OpenNote {
  at: string;
  n: number;
}

/** The text: a paragraph per block, a heading over every block but the lead, a footnote after every sentence. */
function WikiArticleText({
  article,
  notes,
  spaceSlug,
}: {
  article: WikiArticleView;
  notes: Map<number, WikiArticleFootnote>;
  spaceSlug: string;
}) {
  const phone = useMediaQuery(PHONE_QUERY);
  const [open, setOpen] = useState<OpenNote | null>(null);
  const openNote = open ? (notes.get(open.n) ?? null) : null;
  const back = { topic: article.topic.slug, part: article.part };

  return (
    <div className="wk-art">
      {article.blocks.map((block, b) => (
        <Fragment key={b}>
          {block.heading && <h2>{block.heading}</h2>}
          <p>
            {block.sentences.map((sentence, s) => {
              const at = `${b}.${s}`;
              const lit = open?.at === at;
              return (
                <Fragment key={at}>
                  <span className={lit ? 'hl' : undefined}>
                    {wikiSentenceSegments(sentence.text).map((segment, i) =>
                      segment.kind === 'code' ? (
                        <code key={i}>{segment.text}</code>
                      ) : segment.kind === 'strong' ? (
                        <strong key={i}>{segment.text}</strong>
                      ) : (
                        <Fragment key={i}>{segment.text}</Fragment>
                      ),
                    )}
                  </span>
                  <sup className="wk-fn">
                    {sentence.notes.map((n) => {
                      const on = lit && open?.n === n;
                      const marker = (
                        <button
                          type="button"
                          className={`wk-fn-n${on ? ' on' : ''}`}
                          aria-label={`Footnote ${n}`}
                          onClick={() => setOpen(on ? null : { at, n })}
                        >
                          {wikiNoteLabel(n)}
                        </button>
                      );
                      if (phone) return <Fragment key={n}>{marker}</Fragment>;
                      const note = notes.get(n);
                      return (
                        <Popover
                          key={n}
                          open={on}
                          trigger="click"
                          placement="bottomLeft"
                          arrow={{ pointAtCenter: true }}
                          onOpenChange={(visible) => {
                            if (!visible && on) setOpen(null);
                          }}
                          content={note ? <WikiFootnoteCard note={note} spaceSlug={spaceSlug} back={back} /> : null}
                        >
                          {marker}
                        </Popover>
                      );
                    })}
                  </sup>{' '}
                </Fragment>
              );
            })}
          </p>
        </Fragment>
      ))}
      {phone && (
        <Drawer
          placement="bottom"
          open={openNote !== null}
          onClose={() => setOpen(null)}
          size="auto"
          closable={false}
          rootClassName="wk-fnsheet"
          styles={{ body: { padding: 0 } }}
        >
          {openNote && <WikiFootnoteCard note={openNote} spaceSlug={spaceSlug} back={back} sheet />}
        </Drawer>
      )}
    </div>
  );
}

/**
 * The entry a footnote names, as a card: its number, kind and mark, its title and a few lines of its
 * summary, what backs it and where its anchor was last checked — read from the entry when the card
 * opens, since the article carries only the entry's words — and the way to its page.
 */
export function WikiFootnoteCard({
  note,
  spaceSlug,
  back,
  sheet = false,
}: {
  note: WikiArticleFootnote;
  spaceSlug: string;
  back: { topic: string; part: number };
  sheet?: boolean;
}) {
  const navigate = useNavigate();
  const detail = useQuery(wikiEntryQuery(note.entry ? note.entryId : null));
  const entry = note.entry;
  const counts = detail.data?.sources ? wikiSourceCounts(detail.data.sources) : null;
  const mark = detail.data ? wikiAnchorMark(detail.data) : null;
  const open = () => navigate(wikiEntryPath(spaceSlug, note.entryId), { state: { wikiBack: back } });

  return (
    <div className={`wk-fncard${sheet ? ' sheet' : ''}`}>
      <div className="k">
        <span className="num">{wikiNoteLabel(note.n)}</span>
        {entry && <WikiKindMark kind={entry.kind} className="kind" />}
        {entry && <span>{WIKI_KIND_LABELS[entry.kind as WikiEntryKind] ?? entry.kind}</span>}
        {entry && <WikiTrustBadge trust={entry.trust as WikiTrust} />}
      </div>
      {entry ? (
        <>
          <div className="t">{entry.title}</div>
          {entry.summary && <div className="d">{entry.summary}</div>}
          <div className="f">
            {counts && <span>{wikiSourcesLine(counts.sources, counts.sessions)}</span>}
            <WikiAnchorMark mark={mark} />
            {!sheet && (
              <button type="button" className="go" onClick={open}>
                {WIKI_ACTION_OPEN} ›
              </button>
            )}
          </div>
          {sheet && (
            <Button type="primary" block size="large" className="wk-fncard-open" onClick={open}>
              {WIKI_ACTION_OPEN}
            </Button>
          )}
        </>
      ) : (
        <div className="d">{WIKI_FOOTNOTE_GONE}</div>
      )}
    </div>
  );
}
