import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { DownOutlined, RightOutlined } from '@ant-design/icons';
import { WikiEmpty } from './WikiCards';
import { WikiContentsButton } from './WikiDirectory';
import { wikiArticlesQuery } from '../lib/queries';
import { MOBILE_QUERY, useMediaQuery } from '../lib/useMediaQuery';
import { WIKI_TITLE, wikiSpacePath } from '../lib/wiki';
import {
  WIKI_BROWSE,
  WIKI_BROWSE_SHOWN,
  WIKI_BROWSE_SHOWN_PHONE,
  WIKI_NO_ARTICLES,
  wikiArticlePath,
  wikiBrowseCategories,
  wikiBrowseSummary,
  wikiBrowseTotals,
  wikiBrowseTopicLine,
  wikiCategorySummary,
  wikiCount,
  wikiMoreArticles,
  type WikiBrowseTopic,
} from '../lib/wikiArticles';

/**
 * Browse by category (criterion 10, mocks 15–16): every category, its topics, and each topic's
 * subtopic articles — the directory with the articles spread out.
 *
 * A topic's name opens its own article (the overview, when it was split); the line under it is what
 * the topic is about. On a desktop every topic shows its first subtopic articles in two columns; on a
 * phone a topic opens with its caret, one at a time, or a screen would hold a single topic.
 */
export function WikiBrowsePage({ spaceId, spaceSlug }: { spaceId: string; spaceSlug: string }) {
  const directory = useQuery(wikiArticlesQuery(spaceId));
  const categories = useMemo(() => (directory.data ? wikiBrowseCategories(directory.data) : []), [directory.data]);
  const totals = wikiBrowseTotals(categories);

  return (
    <div className="wk-browse-page">
      <div className="wk-art-crumbrow">
        <div className="wk-crumb">
          <Link to={wikiSpacePath(spaceSlug)}>{WIKI_TITLE}</Link>
          <RightOutlined className="ic" />
          <span>{WIKI_BROWSE}</span>
        </div>
        <WikiContentsButton />
      </div>
      <h1 className="t-title">{WIKI_BROWSE}</h1>
      <div className="t-meta">{wikiBrowseSummary(totals.articles, totals.topics, totals.entries)}</div>
      {directory.isSuccess && totals.articles === 0 && <WikiEmpty>{WIKI_NO_ARTICLES}</WikiEmpty>}
      {categories.map((category) => (
        <section className="wk-browse-cat" key={category.key} id={`wk-cat-${category.key}`}>
          <h2>
            {category.title} <small>{wikiCategorySummary(category.topics, category.articles, category.entries)}</small>
          </h2>
          {category.rows.map((row) => (
            <BrowseTopic key={row.slug} row={row} spaceSlug={spaceSlug} />
          ))}
        </section>
      ))}
    </div>
  );
}

function BrowseTopic({ row, spaceSlug }: { row: WikiBrowseTopic; spaceSlug: string }) {
  const phone = useMediaQuery(MOBILE_QUERY);
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState(false);
  const expanded = phone ? open : true;
  const shown = all ? row.parts : row.parts.slice(0, phone ? WIKI_BROWSE_SHOWN_PHONE : WIKI_BROWSE_SHOWN);
  const hidden = row.parts.length - shown.length;

  return (
    <div className="wk-browse-topic">
      <div className="h">
        {row.hasArticle ? <Link to={wikiArticlePath(spaceSlug, row.slug)}>{row.title}</Link> : <b>{row.title}</b>}
        {row.hasArticle && <span className="n">{wikiBrowseTopicLine(row.entries, row.articles)}</span>}
        {row.parts.length > 0 && (
          <button
            type="button"
            className="wk-browse-caret"
            aria-expanded={expanded}
            aria-label={row.title}
            onClick={() => setOpen(!open)}
          >
            {expanded ? <DownOutlined /> : <RightOutlined />}
          </button>
        )}
      </div>
      {row.description && <div className="ov">{row.description}</div>}
      {expanded && row.parts.length > 0 && (
        <div className="wk-browse-list">
          {shown.map((part) => (
            <Link key={part.part} to={wikiArticlePath(spaceSlug, row.slug, part.part)}>
              <span className="tt">{part.title}</span>
              <span className="dash" />
              <span className="n">{wikiCount(part.entryCount)}</span>
            </Link>
          ))}
        </div>
      )}
      {expanded && hidden > 0 && (
        <button type="button" className="wk-more" onClick={() => setAll(true)}>
          {wikiMoreArticles(hidden)}
        </button>
      )}
    </div>
  );
}
