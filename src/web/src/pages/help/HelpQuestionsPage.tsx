import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { HelpAskOutcome, HelpAskRow } from '@orbit/shared';
import { Spinner } from '../../components/ui/Spinner';
import { AskConversation } from '../../components/help/HelpAsk';
import '../../components/help/HelpAsk.css';
import { helpAskChoicesQuery, helpAskListQuery } from '../../lib/help/helpAsk';
import { openHelpDrawer } from '../../lib/help/openHelpDrawer';
import { routeId } from '../../lib/idCodec';
import { useDocumentTitle } from './useDocumentTitle';

const OUTCOME: Record<HelpAskOutcome, string> = {
  answered: 'Answered',
  working: 'Working',
  failed: 'Did not finish',
  'with-admin': 'With your admin',
};

/** "Today 13:02", "Nov 12": when a question was asked, as the board writes it. */
export function askedAt(iso: string, now = new Date()): string {
  const at = new Date(iso);
  if (at.toDateString() === now.toDateString()) {
    return `Today ${at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
  }
  return at.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(at.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  });
}

/** One row's second line: when, where it was asked from, how it ended (or who it was sent to), what it cost. */
export function questionLine(row: HelpAskRow, now = new Date()): string {
  const ended = row.sentTo ? `sent to ${row.sentTo}` : OUTCOME[row.outcome].toLowerCase();
  return [askedAt(row.createdAt, now), row.origin ? `from ${row.origin}` : null, ended, `$${row.costUsd.toFixed(2)}`]
    .filter(Boolean)
    .join(' · ');
}

/**
 * /help → Your questions (docs/mocks/help-center board 02 ④): every Ask the person started, newest first — the first
 * question as its title, the page it was asked from, how it ended and what it cost. They are sessions like any other,
 * in no workspace's list; opening one continues it here.
 */
export function HelpQuestionsPage() {
  useDocumentTitle('Your questions');
  const navigate = useNavigate();
  const list = useQuery(helpAskListQuery());
  const rows = list.data?.questions ?? [];
  return (
    <div className="help-column">
      <div className="help-questions-head">
        <div>
          <h1 className="help-title">Your questions</h1>
          <p className="help-sub">Every Ask chat you started. They are sessions like any other.</p>
        </div>
        <button type="button" className="help-ask-pill" onClick={() => openHelpDrawer({ tab: 'ask', askSession: null })}>
          ✦ Ask
        </button>
      </div>
      {list.isPending ? (
        <Spinner aria-busy="true" />
      ) : rows.length === 0 ? (
        <p className="help-sub">You haven't asked anything yet. Press Ask, or ? anywhere in Orbit.</p>
      ) : (
        <div className="help-questions-list">
          {rows.map((row) => (
            <button
              key={row.sessionId}
              type="button"
              className="help-questions-row"
              data-row-focus=""
              data-help-question={row.sessionId}
              onClick={() => navigate(`/help/questions/${row.sessionId}`)}
            >
              <span>
                <span>{row.title}</span>
                <br />
                <span className="help-questions-sub">{questionLine(row)}</span>
              </span>
              <span className="help-questions-outcome">
                <span className={`help-questions-dot is-${row.outcome}`} aria-hidden />
                {OUTCOME[row.outcome]}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** /help/questions/:id: one Ask, continued in place. */
export function HelpQuestionPage() {
  const { id = '' } = useParams();
  const sessionId = routeId(id) ?? id;
  const choices = useQuery(helpAskChoicesQuery());
  const navigate = useNavigate();
  useDocumentTitle('Your questions');
  return (
    <div className="help-column">
      <nav className="help-breadcrumb" aria-label="Breadcrumb">
        <Link to="/help/questions">Your questions</Link>
      </nav>
      <div className="help-questions-thread">
        <AskConversation sessionId={sessionId} choices={choices.data} onOpenArticle={(_slug, path) => navigate(path)} />
      </div>
    </div>
  );
}
