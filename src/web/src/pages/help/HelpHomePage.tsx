import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { CheckCircleFilled, RightOutlined, SearchOutlined } from '@ant-design/icons';
import { HELP_CATEGORIES, type HelpMatch, type HelpSearchHit } from '@orbit/shared';
import { getStartedSteps, type GetStartedAccount } from '../../lib/help/getStarted';
import { helpArticlePath, helpIndexQuery, helpSearchQuery } from '../../lib/help/helpQueries';
import { openHelpDrawer } from '../../lib/help/openHelpDrawer';
import { useHelpAccount } from '../../lib/help/useHelpAccount';
import { useDocumentTitle } from './useDocumentTitle';

/** What each category covers, under its name on the topic cards. */
export const CATEGORY_BLURB: Record<(typeof HELP_CATEGORIES)[number]['slug'], string> = {
  'get-started': 'What Orbit is, and the first hour with it.',
  'workspaces-and-sessions': 'Run agents on a repository; approvals, permission modes, background jobs.',
  'projects-and-tasks': 'Plans, task lists, evidence, confirmations, merging.',
  wiki: 'What your agents learned, and how to change it.',
  'machines-and-engines': 'Add machines, install engines, fix offline ones.',
  'models-keys-and-accounts': 'API keys, subscriptions, account pools, quotas.',
  'phone-and-desktop-apps': 'Orbit on iPhone, Android and the Mac; notifications.',
  'integrations-and-api': 'Access tokens, the HTTP API, Feishu.',
  'admin-and-self-hosting': 'Users and sign-in, email, upgrades, runner troubleshooting.',
};

/** Where the reader hid the Get started card, in this browser. */
export const GET_STARTED_HIDDEN_KEY = 'orbit.help.getStartedHidden';

/**
 * /help (docs/mocks/help-center board 01 §3): a search across the articles with Ask beside it, the Get started
 * checklist ticked from what the account really has, the categories as cards with their article counts, and
 * the articles marked common. Signed out it is the search, the topics and the common problems.
 */
export function HelpHomePage() {
  useDocumentTitle('Help center');
  const index = useQuery(helpIndexQuery());
  const { signedIn, checklist } = useHelpAccount({ checklist: true });
  const [query, setQuery] = useState('');
  const searching = query.trim() !== '';
  const articles = index.data?.articles ?? [];
  const common = articles.filter((article) => article.common);
  return (
    <div className="help-column">
      <section className="help-hero">
        <h1>How can we help?</h1>
        <p className="help-sub">Search the guides{signedIn ? ', or ask an agent that has read them' : ''}.</p>
        <div className="help-search-row">
          <SearchBox query={query} onQuery={setQuery} />
          {signedIn && (
            <button type="button" className="help-ask" onClick={() => openHelpDrawer({ tab: 'ask', query: query.trim() || null })}>
              ✦ Ask
            </button>
          )}
        </div>
      </section>
      {searching ? (
        <SearchResults query={query.trim()} signedIn={signedIn} />
      ) : (
        <>
          {signedIn && <GetStarted account={checklist} />}
          <section className="help-section" aria-labelledby="help-topics">
            <h2 id="help-topics">Browse by topic</h2>
            <div className="help-topics">
              {(index.data?.categories ?? []).map((category) => {
                const count = articles.filter((article) => article.category === category.slug).length;
                return (
                  <Link key={category.slug} to={`/help/${category.slug}`} className="help-topic">
                    <span className="help-topic-title">{category.title}</span>
                    <span className="help-topic-blurb">{CATEGORY_BLURB[category.slug]}</span>
                    <span className="help-topic-count">
                      {count} {count === 1 ? 'article' : 'articles'}
                    </span>
                  </Link>
                );
              })}
            </div>
          </section>
          {common.length > 0 && (
            <section className="help-section" aria-labelledby="help-common">
              <h2 id="help-common">Common problems</h2>
              <div className="help-list">
                {common.map((article) => (
                  <Link key={article.slug} to={helpArticlePath(article)} className="help-list-row" data-row-focus="">
                    <span>{article.title}</span>
                    <RightOutlined />
                  </Link>
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}

function SearchBox({ query, onQuery }: { query: string; onQuery: (q: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  // "/" anywhere on the page but a field puts the cursor in the search.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
      event.preventDefault();
      input.current?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  return (
    <label className="help-search">
      <SearchOutlined />
      <input
        ref={input}
        type="search"
        placeholder="Search help"
        aria-label="Search help"
        value={query}
        onChange={(event) => onQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && query) {
            event.preventDefault();
            onQuery('');
          }
        }}
      />
      <kbd>/</kbd>
    </label>
  );
}

/** The results as the reader types, a moment after they stop. */
function SearchResults({ query, signedIn }: { query: string; signedIn: boolean }) {
  const [asked, setAsked] = useState(query);
  useEffect(() => {
    const t = setTimeout(() => setAsked(query), 200);
    return () => clearTimeout(t);
  }, [query]);
  const search = useQuery({ ...helpSearchQuery(asked), enabled: asked !== '' });
  const hits = search.data?.hits ?? [];
  const titleOf = (slug: string) => HELP_CATEGORIES.find((c) => c.slug === slug)?.title ?? slug;
  return (
    <section className="help-section" aria-label="Search results">
      {search.isSuccess && (
        <div className="help-count">
          {hits.length} {hits.length === 1 ? 'article' : 'articles'}
        </div>
      )}
      <div className="help-results">
        {hits.map((hit: HelpSearchHit) => (
          <Link key={hit.slug} to={helpArticlePath(hit)} className="help-result">
            <span className="help-result-title">
              <Highlighted text={hit.title} matches={hit.titleMatches} />
            </span>
            <span className="help-result-category">{titleOf(hit.category)}</span>
            <span className="help-result-snippet">
              <Highlighted text={hit.snippet.text} matches={hit.snippet.matches} />
            </span>
          </Link>
        ))}
        {signedIn && (
          <button type="button" className="help-result help-result--ask" onClick={() => openHelpDrawer({ tab: 'ask', query })}>
            <span className="help-result-title">Ask “{query}”</span>
            <span className="help-result-snippet">Get an answer from an agent that reads these articles.</span>
          </button>
        )}
      </div>
    </section>
  );
}

function Highlighted({ text, matches }: { text: string; matches: HelpMatch[] }) {
  const parts: ReactNode[] = [];
  let from = 0;
  for (const m of [...matches].sort((a, b) => a.start - b.start)) {
    if (m.start < from) continue;
    if (m.start > from) parts.push(text.slice(from, m.start));
    parts.push(<mark key={m.start}>{text.slice(m.start, m.start + m.length)}</mark>);
    from = m.start + m.length;
  }
  if (from < text.length) parts.push(text.slice(from));
  return <>{parts}</>;
}

/**
 * Get started: four steps ticked from the account (lib/help/getStarted). Once all four are done it folds to one
 * line, "You're set up"; Hide puts it away in this browser.
 */
export function GetStarted({ account }: { account: GetStartedAccount | null }) {
  const [hidden, setHidden] = useState(() => localStorage.getItem(GET_STARTED_HIDDEN_KEY) === '1');
  if (hidden || !account) return null;
  const hide = () => {
    localStorage.setItem(GET_STARTED_HIDDEN_KEY, '1');
    setHidden(true);
  };
  const steps = getStartedSteps(account);
  const done = steps.filter((step) => step.done).length;
  const next = steps.find((step) => !step.done);
  if (!next) {
    return (
      <section className="help-get-started help-get-started--done" aria-label="Get started">
        <CheckCircleFilled className="help-step-tick" />
        <span className="help-get-started-title">You're set up</span>
        <button type="button" className="help-link-button" onClick={hide}>
          Hide
        </button>
      </section>
    );
  }
  return (
    <section className="help-get-started" aria-label="Get started">
      <div className="help-get-started-head">
        <span className="help-get-started-title">
          Get started · {done} of {steps.length} done
        </span>
        <button type="button" className="help-link-button" onClick={hide}>
          Hide
        </button>
      </div>
      <ol className="help-steps">
        {steps.map((step) => (
          <li
            key={step.key}
            className={`help-step${step.done ? ' help-step--done' : ''}${step === next ? ' help-step--next' : ''}`}
            data-step={step.key}
            data-done={step.done ? 'true' : 'false'}
          >
            {step.done ? <CheckCircleFilled className="help-step-tick" aria-label="Done" /> : <span className="help-step-ring" aria-label="Not done" />}
            <span className="help-step-text">
              <span className="help-step-title">{step.title}</span>
              <span className="help-step-detail">{step.detail}</span>
              {step === next && (
                <Link to={step.to} className="help-step-start">
                  Start ›
                </Link>
              )}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
