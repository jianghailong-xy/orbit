import { useEffect, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { CloseOutlined, ExclamationOutlined, FileTextOutlined, SearchOutlined, StarOutlined } from '@ant-design/icons';
import { HELP_CATEGORIES, type HelpArticleMeta, type HelpMatch } from '@orbit/shared';
import { useHelpDrawer } from '../../lib/helpDrawer';
import { forThisPage, getStartedArticles, highlightPieces, routeLabel } from '../../lib/help/drawerArticles';
import { articleMeta } from '../../lib/help/helpContent';
import { useHelpVote } from '../../lib/help/helpFeedback';
import { useHelpLanguage } from '../../lib/help/helpLanguage';
import { helpArticleQuery, helpIndexQuery, helpSearchQuery } from '../../lib/help/helpQueries';
import { useHelpAccount } from '../../lib/help/useHelpAccount';
import { useVisibleHelpErrors } from '../../lib/help/useVisibleHelpErrors';
import { Spinner } from '../ui/Spinner';
import { HelpMarkdown } from './HelpMarkdown';

/** How long typing has to pause before the search is sent. */
export const HELP_SEARCH_DEBOUNCE_MS = 200;

const categoryTitle = (slug: string) => HELP_CATEGORIES.find((c) => c.slug === slug)?.title ?? slug;

/**
 * The help drawer's Articles tab (board docs/mocks/help-center/01-web.png ①–②): the article the drawer was opened
 * at, or the search field over either the search's results or "For this page" and Get started. The search typed
 * stays while an article is read, so ‹ comes back to the same results.
 */
export function HelpArticlesPane() {
  const help = useHelpDrawer();
  const [typed, setTyped] = useState('');
  const [query, setQuery] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setQuery(typed.trim()), HELP_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [typed]);

  if (help.slug) return <DrawerArticle slug={help.slug} />;
  return (
    <div className="help-pane" data-help-pane="articles">
      <div className="help-drawer-search">
        <SearchOutlined aria-hidden />
        <input
          type="search"
          aria-label="Search help"
          placeholder="Search help"
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
        />
        {typed && (
          <button type="button" className="help-drawer-search-clear" aria-label="Clear search" onClick={() => setTyped('')}>
            <CloseOutlined />
          </button>
        )}
      </div>
      {query ? <SearchResults query={query} /> : <ArticleGroups />}
    </div>
  );
}

function ArticleRow({ article, icon, warn }: { article: HelpArticleMeta; icon: ReactNode; warn?: boolean }) {
  const help = useHelpDrawer();
  return (
    <li>
      <button
        type="button"
        className="help-art"
        data-help-article={article.slug}
        data-pinned={warn ? 'true' : undefined}
        onClick={() => help.openHelp({ slug: article.slug })}
      >
        <span className={`help-art-icon${warn ? ' warn' : ''}`} aria-hidden>
          {icon}
        </span>
        <span className="help-art-text">
          <span className="help-art-title">{article.title}</span>
          <span className="help-art-summary">{article.summary}</span>
        </span>
      </button>
    </li>
  );
}

/** For this page (articles about a visible error first, then the route's), and Get started. */
function ArticleGroups() {
  const { pathname } = useLocation();
  const errors = useVisibleHelpErrors();
  const { language } = useHelpLanguage();
  const index = useQuery(helpIndexQuery(language));
  if (index.isPending) return <Spinner className="help-pane-loading" aria-busy="true" />;
  if (!index.data) return <p className="help-pane-empty">Help articles could not be loaded.</p>;
  const page = forThisPage(index.data.articles, pathname, errors);
  const started = getStartedArticles(index.data.articles);
  return (
    <>
      {page.length > 0 && (
        <section aria-label="For this page">
          <h3 className="help-group">
            For this page <span className="help-group-ctx">{routeLabel(pathname)}</span>
          </h3>
          <ul className="help-drawer-list">
            {page.map(({ article, pinned }) => (
              <ArticleRow
                key={article.slug}
                article={article}
                warn={pinned}
                icon={pinned ? <ExclamationOutlined /> : <FileTextOutlined />}
              />
            ))}
          </ul>
        </section>
      )}
      {started.length > 0 && (
        <section aria-label="Get started">
          <h3 className="help-group">Get started</h3>
          <ul className="help-drawer-list">
            {started.map((article, i) => (
              <ArticleRow key={article.slug} article={article} icon={i + 1} />
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

function Highlighted({ text, matches }: { text: string; matches: readonly HelpMatch[] }) {
  return (
    <>
      {highlightPieces(text, matches).map((piece, i) => (piece.mark ? <mark key={i}>{piece.text}</mark> : piece.text))}
    </>
  );
}

/** The search's hits with their matches marked, and always last, Ask "<query>". */
function SearchResults({ query }: { query: string }) {
  const help = useHelpDrawer();
  const { language } = useHelpLanguage();
  const search = useQuery(helpSearchQuery(query, language));
  const hits = search.data?.hits ?? [];
  return (
    <section aria-label="Search results">
      {search.isPending ? (
        <Spinner className="help-pane-loading" aria-busy="true" />
      ) : (
        <h3 className="help-group">{hits.length === 1 ? '1 article' : `${hits.length} articles`}</h3>
      )}
      {hits.length > 0 && (
        <ul className="help-drawer-list">
          {hits.map((hit) => (
            <li key={hit.slug}>
              <button type="button" className="help-res" data-help-article={hit.slug} onClick={() => help.openHelp({ slug: hit.slug })}>
                <span className="help-res-title">
                  <Highlighted text={hit.title} matches={hit.titleMatches} />
                </span>
                <span className="help-res-category">{categoryTitle(hit.category)}</span>
                <span className="help-res-snippet">
                  <Highlighted text={hit.snippet.text} matches={hit.snippet.matches} />
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <button type="button" className="help-art help-ask-row" data-help-ask onClick={() => help.openHelp({ tab: 'ask', query })}>
        <span className="help-art-icon brand" aria-hidden>
          <StarOutlined />
        </span>
        <span className="help-art-text">
          <span className="help-art-title">Ask “{query}”</span>
          <span className="help-art-summary">Get an answer from an agent that reads these articles.</span>
        </span>
      </button>
    </section>
  );
}

/** One article read in the drawer: breadcrumb, title, read time and date, the body, Did this help? and Ask instead. */
function DrawerArticle({ slug }: { slug: string }) {
  const help = useHelpDrawer();
  const { language } = useHelpLanguage();
  const article = useQuery(helpArticleQuery(slug, language));
  const { links } = useHelpAccount();
  const { vote, choose } = useHelpVote('article', slug);
  if (article.isPending) {
    return (
      <div className="help-pane" data-help-pane="article" data-help-slug={slug}>
        <Spinner className="help-pane-loading" aria-busy="true" />
      </div>
    );
  }
  if (!article.data) {
    return (
      <div className="help-pane" data-help-pane="article" data-help-slug={slug}>
        <p className="help-pane-empty">This article doesn't exist. It may have moved, or it is for administrators only.</p>
      </div>
    );
  }
  const a = article.data;
  return (
    <article className="help-pane help-reading" data-help-pane="article" data-help-slug={slug}>
      <div className="help-crumb">{categoryTitle(a.category)}</div>
      <h3 className="help-reading-title">{a.title}</h3>
      <div className="help-reading-meta">{articleMeta({ ...a, platforms: [] })}</div>
      <HelpMarkdown body={a.body} account={links} />
      <div className="help-helpful" role="group" aria-label="Did this help?">
        <span>Did this help?</span>
        <button type="button" className="help-helpful-button" data-answer="yes" aria-pressed={vote === 'yes'} onClick={() => choose('yes')}>
          Yes
        </button>
        <button type="button" className="help-helpful-button" data-answer="no" aria-pressed={vote === 'no'} onClick={() => choose('no')}>
          No
        </button>
        <button type="button" className="help-drawer-link help-ask-instead" onClick={() => help.openHelp({ tab: 'ask' })}>
          Ask instead
        </button>
      </div>
    </article>
  );
}
