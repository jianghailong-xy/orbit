import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { DownOutlined, RightOutlined } from '@ant-design/icons';
import { WikiEmpty } from './WikiCards';
import { WikiContentsButton } from './WikiDirectory';
import { wikiArticlesQuery, wikiDocsQuery } from '../lib/queries';
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
import {
  WIKI_BROWSE_SECTIONS_SHOWN_PHONE,
  wikiDocPath,
  wikiDocSectionPath,
  wikiDocsBrowseSummary,
  wikiDocsCategoryLine,
  wikiDocsDocLine,
  wikiMoreSections,
  wikiReadsByDocs,
  wikiSectionKindLabel,
  type WikiDocsDirectory,
} from '../lib/wikiDocs';

/**
 * Browse by category (criterion 10, mocks 15–16; by document since its second revision, mocks 27 ②,
 * 28 ①): every category of the confirmed plan with what it answers, its documents with the reader's
 * question, and each document's sections with their kind — or, before a plan is confirmed, every
 * category's topics and each topic's subtopic articles, as it was.
 *
 * A topic's name opens its own article (the overview, when it was split); the line under it is what
 * the topic is about. On a desktop every topic shows its first subtopic articles in two columns; on a
 * phone a topic opens with its caret, one at a time, or a screen would hold a single topic.
 */
export function WikiBrowsePage({ spaceId, spaceSlug }: { spaceId: string; spaceSlug: string }) {
  const docs = useQuery(wikiDocsQuery(spaceId));
  // A space with a confirmed plan browses by its documents (mock 27 ②); before one, by topic articles.
  if (docs.data && wikiReadsByDocs(docs.data)) return <WikiDocsBrowse directory={docs.data} spaceSlug={spaceSlug} />;
  return <WikiArticlesBrowse spaceId={spaceId} spaceSlug={spaceSlug} />;
}

function WikiArticlesBrowse({ spaceId, spaceSlug }: { spaceId: string; spaceSlug: string }) {
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

/**
 * Browse by document (mock 27 ②, 28 ①): the plan's categories → documents (the reader's question under
 * each, and its state: Needs review, Not written yet) → sections, two columns on a desktop with each
 * section's kind; on a phone a document opens with its caret, its first sections and `N more sections`.
 */
function WikiDocsBrowse({ directory, spaceSlug }: { directory: WikiDocsDirectory; spaceSlug: string }) {
  return (
    <div className="wk-browse-page wk-browse-docs">
      <div className="wk-art-crumbrow">
        <div className="wk-crumb">
          <Link to={wikiSpacePath(spaceSlug)}>{WIKI_TITLE}</Link>
          <RightOutlined className="ic" />
          <span>{WIKI_BROWSE}</span>
        </div>
        <WikiContentsButton />
      </div>
      <h1 className="t-title">{WIKI_BROWSE}</h1>
      <div className="t-meta">{wikiDocsBrowseSummary(directory).join(' · ')}</div>
      {directory.categories
        .filter((category) => category.docs.length > 0)
        .map((category) => (
          <section className="wk-browse-cat" key={category.key} id={`wk-cat-${category.key}`}>
            <h2>
              <span className="no">{category.number}</span> {category.title} <small>{wikiDocsCategoryLine(category)}</small>
            </h2>
            {category.question && <div className="wk-browse-q">{category.question}</div>}
            {category.docs.map((doc) => (
              <BrowseDoc key={doc.slug} doc={doc} spaceSlug={spaceSlug} />
            ))}
          </section>
        ))}
    </div>
  );
}

function BrowseDoc({ doc, spaceSlug }: { doc: WikiDocsDirectory['categories'][number]['docs'][number]; spaceSlug: string }) {
  const phone = useMediaQuery(MOBILE_QUERY);
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState(false);
  const expanded = phone ? open : true;
  const shown = all || !phone ? doc.sections : doc.sections.slice(0, WIKI_BROWSE_SECTIONS_SHOWN_PHONE);
  const hidden = doc.sections.length - shown.length;
  const line = wikiDocsDocLine(doc);
  return (
    <div className="wk-browse-topic wk-browse-doc">
      <div className="h">
        <span className="no">{doc.number}</span>
        <Link to={wikiDocPath(spaceSlug, doc.slug)}>{doc.title}</Link>
        <span className="n">
          {line.sections}
          {line.state && <span className={`st ${line.state.tone}`}> · {line.state.text}</span>}
        </span>
        {doc.sections.length > 0 && (
          <button type="button" className="wk-browse-caret" aria-expanded={expanded} aria-label={doc.title} onClick={() => setOpen(!open)}>
            {expanded ? <DownOutlined /> : <RightOutlined />}
          </button>
        )}
      </div>
      {doc.question && <div className="ov">{doc.question}</div>}
      {expanded && doc.sections.length > 0 && (
        <div className="wk-browse-list secs">
          {shown.map((section) => (
            <Link key={section.key} to={wikiDocSectionPath(spaceSlug, doc.slug, section.key)} className={section.written ? undefined : 'todo'}>
              <span className="sn">{section.number}</span>
              <span className="tt">{section.title}</span>
              <span className="dash" />
              <span className="n">{wikiSectionKindLabel(section.kind)}</span>
            </Link>
          ))}
        </div>
      )}
      {expanded && hidden > 0 && (
        <button type="button" className="wk-more" onClick={() => setAll(true)}>
          {wikiMoreSections(hidden)}
        </button>
      )}
    </div>
  );
}
