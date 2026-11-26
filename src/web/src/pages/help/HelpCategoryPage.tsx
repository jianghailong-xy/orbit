import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { RightOutlined } from '@ant-design/icons';
import { Spinner } from '../../components/ui/Spinner';
import { helpArticlePath, helpIndexQuery } from '../../lib/help/helpQueries';
import { CATEGORY_BLURB } from './HelpHomePage';
import { useDocumentTitle } from './useDocumentTitle';

/** /help/:category: a category's articles, each with its summary — what a category in the nav opens. */
export function HelpCategoryPage() {
  const { category = '' } = useParams();
  const index = useQuery(helpIndexQuery());
  const found = index.data?.categories.find((c) => c.slug === category);
  useDocumentTitle(found?.title);
  if (index.isPending) {
    return (
      <div className="help-column help-loading">
        <Spinner aria-busy="true" />
      </div>
    );
  }
  if (!found) {
    return (
      <div className="help-column">
        <h1 className="help-title">This topic doesn't exist</h1>
        <p className="help-sub">
          <Link to="/help">Back to Help</Link>
        </p>
      </div>
    );
  }
  const articles = (index.data?.articles ?? []).filter((a) => a.category === found.slug);
  return (
    <div className="help-column">
      <nav className="help-breadcrumb" aria-label="Breadcrumb">
        <Link to="/help">Help</Link>
      </nav>
      <h1 className="help-title">{found.title}</h1>
      <p className="help-sub">{CATEGORY_BLURB[found.slug]}</p>
      <div className="help-list">
        {articles.map((article) => (
          <Link key={article.slug} to={helpArticlePath(article)} className="help-list-row help-list-row--two" data-row-focus="">
            <span className="help-list-text">
              <span>{article.title}</span>
              <span className="help-list-summary">{article.summary}</span>
            </span>
            <RightOutlined />
          </Link>
        ))}
      </div>
    </div>
  );
}

/** What's new and Your questions, until their own tasks fill them. */
export function HelpPlaceholderPage({ title, text }: { title: string; text: string }) {
  useDocumentTitle(title);
  return (
    <div className="help-column">
      <h1 className="help-title">{title}</h1>
      <p className="help-sub">{text}</p>
    </div>
  );
}
