import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { RightOutlined } from '@ant-design/icons';
import { WikiEmpty } from './WikiCards';
import { WikiContentsButton } from './WikiDirectory';
import { wikiArticleIndexQuery, wikiDocIndexQuery } from '../lib/queries';
import { WIKI_TITLE, wikiSpacePath } from '../lib/wiki';
import {
  WIKI_AZ_INDEX,
  WIKI_INDEX_LETTERS,
  WIKI_NO_ARTICLES,
  wikiArticlePath,
  wikiIndexGroups,
  wikiIndexMeta,
  wikiIndexSummary,
} from '../lib/wikiArticles';
import { wikiDocsIndexGroups, wikiDocsIndexMeta, wikiDocsIndexPath, wikiDocsIndexSummary, type WikiDocsIndexItem } from '../lib/wikiDocs';

/**
 * The A–Z index (criterion 10, mocks 15 ④⑤, 16 ②; by document since its second revision, mocks 27 ③④,
 * 28 ②, where it files every document and every section title no other document shares — owner's call
 * 2026-09-29 — a document's title in bold): every article by title, under its letter —
 * a Latin title by its first letter, a Chinese one by its first character's pinyin, anything else
 * under `#` — with a letter bar that jumps to a group and greys the letters nothing starts with.
 *
 * iOS files the same titles under the same letters (`WikiArticleLogic.indexGroups`, the system's
 * `mandarinToLatin`), and the two are held to one list of cases in the shared fixture.
 */
export function WikiIndexPage({ spaceId, spaceSlug }: { spaceId: string; spaceSlug: string }) {
  const docIndex = useQuery(wikiDocIndexQuery(spaceId));
  // A space with a confirmed plan indexes its documents and their sections (mock 27 ③④); before one, its articles.
  if (docIndex.data?.plan) return <WikiDocsIndexPage items={docIndex.data.items} spaceSlug={spaceSlug} />;
  return <WikiArticlesIndex spaceId={spaceId} spaceSlug={spaceSlug} />;
}

function WikiArticlesIndex({ spaceId, spaceSlug }: { spaceId: string; spaceSlug: string }) {
  const index = useQuery(wikiArticleIndexQuery(spaceId));
  const items = useMemo(() => index.data?.items ?? [], [index.data]);
  const groups = useMemo(() => wikiIndexGroups(items), [items]);
  const present = new Set(groups.map((group) => group.letter));

  return (
    <div className="wk-az-page">
      <div className="wk-art-crumbrow">
        <div className="wk-crumb">
          <Link to={wikiSpacePath(spaceSlug)}>{WIKI_TITLE}</Link>
          <RightOutlined className="ic" />
          <span>{WIKI_AZ_INDEX}</span>
        </div>
        <WikiContentsButton />
      </div>
      <h1 className="t-title">{WIKI_AZ_INDEX}</h1>
      <div className="t-meta">{wikiIndexSummary(items.length)}</div>
      <nav className="wk-az-bar" aria-label={WIKI_AZ_INDEX}>
        {WIKI_INDEX_LETTERS.map((letter) =>
          present.has(letter) ? (
            <button
              type="button"
              key={letter}
              onClick={() => document.getElementById(`wk-az-${letter}`)?.scrollIntoView({ block: 'start' })}
            >
              {letter}
            </button>
          ) : (
            <span key={letter} className="off" aria-disabled="true">
              {letter}
            </span>
          ),
        )}
      </nav>
      {index.isSuccess && items.length === 0 && <WikiEmpty>{WIKI_NO_ARTICLES}</WikiEmpty>}
      {groups.map((group) => (
        <section className="wk-az-g" key={group.letter} id={`wk-az-${group.letter}`}>
          <h2>
            {group.letter} <small>{group.items.length}</small>
          </h2>
          <div className="wk-az-list">
            {group.items.map((item) => (
              <Link key={`${item.topic.slug}:${item.part}`} to={wikiArticlePath(spaceSlug, item.topic.slug, item.part)}>
                <span className={`t${item.part === 0 ? ' ov' : ''}`}>{item.title}</span>
                <span className="m">{wikiIndexMeta(item)}</span>
              </Link>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

/** The index by document (mock 27 ③④): documents in bold with their number and category, sections with where they are. */
function WikiDocsIndexPage({ items, spaceSlug }: { items: readonly WikiDocsIndexItem[]; spaceSlug: string }) {
  const groups = useMemo(() => wikiDocsIndexGroups(items), [items]);
  const present = new Set(groups.map((group) => group.letter));
  return (
    <div className="wk-az-page wk-az-docs">
      <div className="wk-art-crumbrow">
        <div className="wk-crumb">
          <Link to={wikiSpacePath(spaceSlug)}>{WIKI_TITLE}</Link>
          <RightOutlined className="ic" />
          <span>{WIKI_AZ_INDEX}</span>
        </div>
        <WikiContentsButton />
      </div>
      <h1 className="t-title">{WIKI_AZ_INDEX}</h1>
      <div className="t-meta">{wikiDocsIndexSummary(items)}</div>
      <nav className="wk-az-bar" aria-label={WIKI_AZ_INDEX}>
        {WIKI_INDEX_LETTERS.map((letter) =>
          present.has(letter) ? (
            <button type="button" key={letter} onClick={() => document.getElementById(`wk-az-${letter}`)?.scrollIntoView({ block: 'start' })}>
              {letter}
            </button>
          ) : (
            <span key={letter} className="off" aria-disabled="true">
              {letter}
            </span>
          ),
        )}
      </nav>
      {groups.map((group) => (
        <section className="wk-az-g" key={group.letter} id={`wk-az-${group.letter}`}>
          <h2>
            {group.letter} <small>{group.items.length}</small>
          </h2>
          <div className="wk-az-list">
            {group.items.map((item) => (
              <Link key={`${item.docSlug}:${item.sectionKey ?? ''}`} to={wikiDocsIndexPath(spaceSlug, item)}>
                <span className={`t${item.kind === 'doc' ? ' ov' : ''}`}>{item.title}</span>
                <span className="m">{wikiDocsIndexMeta(item)}</span>
              </Link>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
