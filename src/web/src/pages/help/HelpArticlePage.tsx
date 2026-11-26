import { Link, Navigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { HELP_CATEGORIES } from '@orbit/shared';
import { HelpMarkdown } from '../../components/help/HelpMarkdown';
import { Spinner } from '../../components/ui/Spinner';
import { articleMeta, forPlatform, tableOfContents } from '../../lib/help/helpContent';
import { useHelpVote } from '../../lib/help/helpFeedback';
import { useHelpLanguage } from '../../lib/help/helpLanguage';
import { helpArticlePath, helpArticleQuery } from '../../lib/help/helpQueries';
import { useHelpAccount } from '../../lib/help/useHelpAccount';
import { useDocumentTitle } from './useDocumentTitle';

/**
 * /help/:category/:slug (docs/mocks/help-center board 01 §4): one article, readable signed out — breadcrumb,
 * title, read time, updated date and platforms, the body as the web reads it (HelpMarkdown), "On this page" on
 * the right, and Did this help? (recorded with POST /api/help/feedback when signed in). An address naming the wrong category
 * moves to the article's own.
 */
export function HelpArticlePage() {
  const { category = '', slug = '' } = useParams();
  const { language } = useHelpLanguage();
  const article = useQuery(helpArticleQuery(slug, language));
  const { links } = useHelpAccount();
  const { vote, choose } = useHelpVote('article', slug);
  useDocumentTitle(article.data?.title);
  if (article.isPending) {
    return (
      <div className="help-column help-loading">
        <Spinner aria-busy="true" />
      </div>
    );
  }
  if (article.isError || !article.data) {
    return (
      <div className="help-column">
        <h1 className="help-title">This article doesn't exist</h1>
        <p className="help-sub">
          It may have moved, or it is for administrators only. <Link to="/help">Back to Help</Link>
        </p>
      </div>
    );
  }
  const a = article.data;
  if (a.category !== category) return <Navigate to={helpArticlePath(a)} replace />;
  const categoryTitle = HELP_CATEGORIES.find((c) => c.slug === a.category)?.title ?? a.category;
  const toc = tableOfContents(forPlatform(a.body, 'web'));
  return (
    <div className="help-article-wrap">
      <article className="help-article">
        <nav className="help-breadcrumb" aria-label="Breadcrumb">
          <Link to="/help">Help</Link>
          <span aria-hidden> › </span>
          <Link to={`/help/${a.category}`}>{categoryTitle}</Link>
        </nav>
        <h1 className="help-title">{a.title}</h1>
        <div className="help-meta">{articleMeta(a)}</div>
        <HelpMarkdown body={a.body} account={links} />
        <div className="help-feedback" role="group" aria-label="Did this help?">
          <span>Did this help?</span>
          <button type="button" className="help-feedback-button" data-answer="yes" aria-pressed={vote === 'yes'} onClick={() => choose('yes')}>
            Yes
          </button>
          <button type="button" className="help-feedback-button" data-answer="no" aria-pressed={vote === 'no'} onClick={() => choose('no')}>
            No
          </button>
        </div>
      </article>
      {toc.length > 0 && (
        <aside className="help-toc" aria-label="On this page">
          <div className="help-toc-title">On this page</div>
          {toc.map((heading) => (
            <a
              key={heading.id}
              href={`#${heading.id}`}
              onClick={(event) => {
                const target = document.getElementById(heading.id);
                if (!target) return;
                event.preventDefault();
                target.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
                history.replaceState(history.state, '', `#${heading.id}`);
              }}
            >
              {heading.text}
            </a>
          ))}
        </aside>
      )}
    </div>
  );
}
