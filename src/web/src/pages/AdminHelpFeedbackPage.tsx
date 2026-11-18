import { useQuery } from '@tanstack/react-query';
import { HELP_CATEGORIES, type HelpFeedbackSummary } from '@orbit/shared';
import { Link } from 'react-router-dom';
import { SettingsCard, SettingsHeader, SettingsRow, SettingsSection } from '../components/settings';
import { Spinner } from '../components/ui/Spinner';
import { TableFrame } from '../components/ui/Table';
import { helpFeedbackSummaryQuery } from '../lib/help/helpFeedback';
import { helpArticlePath } from '../lib/help/helpQueries';

/** "12 Yes · 3 No". */
export const yesNoText = ({ yes, no }: { yes: number; no: number }): string => `${yes} Yes · ${no} No`;

/**
 * Admin → Help feedback (docs/mocks/help-center board 03, decision 3): the help center's Yes / No, counted. Every
 * article someone answered Did this help? on, most No first, and Did this answer it? over every Ask answer as two
 * totals. Counts only: no one's words, and nothing of what anyone asked.
 */
export function AdminHelpFeedbackPage() {
  const summary = useQuery(helpFeedbackSummaryQuery());
  return (
    <div className="settings-page">
      <SettingsHeader
        title="Help feedback"
        description="How readers answered Did this help? and Did this answer it?. Counts only: no text is collected, and questions asked in Ask are not shown."
      />
      {summary.isPending ? (
        <Spinner />
      ) : summary.isError ? (
        <p className="admin-signin-error" role="alert">
          Couldn’t load help feedback: {summary.error.message}
        </p>
      ) : (
        <Feedback summary={summary.data} />
      )}
    </div>
  );
}

function Feedback({ summary }: { summary: HelpFeedbackSummary }) {
  return (
    <>
      <SettingsSection title="Ask answers">
        <SettingsCard>
          <SettingsRow title="Did this answer it?" description={yesNoText(summary.answers)} />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="Articles" description="Most No first.">
        <TableFrame>
          <table className="orbit-table" aria-label="Articles">
            <thead>
              <tr>
                <th scope="col">Article</th>
                <th scope="col">Topic</th>
                <th scope="col">Yes</th>
                <th scope="col">No</th>
              </tr>
            </thead>
            <tbody>
              {summary.articles.length === 0 ? (
                <tr className="orbit-table-empty">
                  <td colSpan={4}>
                    <div>No one has answered Did this help? yet.</div>
                  </td>
                </tr>
              ) : (
                summary.articles.map((a) => (
                  <tr key={a.slug} data-slug={a.slug}>
                    <td>
                      {a.title && a.category ? <Link to={helpArticlePath({ category: a.category, slug: a.slug })}>{a.title}</Link> : `${a.slug} (removed)`}
                    </td>
                    <td>{HELP_CATEGORIES.find((c) => c.slug === a.category)?.title ?? ''}</td>
                    <td>{a.yes}</td>
                    <td>{a.no}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </TableFrame>
      </SettingsSection>
    </>
  );
}
