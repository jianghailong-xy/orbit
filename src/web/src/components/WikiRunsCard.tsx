import { Fragment, useEffect, useId, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { RightOutlined } from '@ant-design/icons';
import type { WikiJobView } from '@orbit/shared';
import { WikiCard, WikiEmpty } from './WikiCards';
import { WikiModelLine } from './WikiSystemModel';
import { wikiHealthQuery, wikiJobsQuery } from '../lib/queries';
import type { WikiSpaceRow } from '../lib/wiki';
import {
  WIKI_CALL,
  WIKI_CALLS,
  WIKI_CALL_RAN,
  WIKI_CALL_STATE,
  WIKI_CALL_TOKENS,
  WIKI_CALL_WAITED,
  WIKI_RUNS,
  WIKI_RUNS_NONE,
  wikiCallRow,
  wikiRunFootText,
  wikiRunRow,
  wikiRunsShown,
} from '../lib/wikiRuns';

/**
 * Activity's Runs card (design §2.2, mock 35 ④⑤; contract `jobs.read`, P9): the server's runs of the space, newest
 * first — what kind of run, where it stands, how far it got, and while it waits how many the deployment's queue
 * takes before it — each row opening its call log: the step and unit of every model call, how long it waited and
 * ran, the tokens it spent and how it failed.
 *
 * A SERVER RUN HAS NO TASK AND NO SESSION, so nothing here links to one: the run's detail is this log, and the
 * status line's View run opens it (`?run=<job>` on Activity) instead of a session. Drawn while the server executes
 * the account's wiki, or once it ran something for the space; under runner Activity is what it always was.
 *
 * The words are `lib/wikiRuns.ts`', which OrbitKit's `WikiRunsLogic` says too, both held to
 * `src/shared/src/wiki-server-execution.fixture.json`.
 */
export function WikiRunsCard({ space }: { space: WikiSpaceRow }) {
  const health = useQuery(wikiHealthQuery(space.id));
  const jobs = useQuery(wikiJobsQuery(space.id));
  const [params] = useSearchParams();
  const asked = params.get('run');
  const [open, setOpen] = useState<string | null>(asked);
  const rows = jobs.data?.jobs ?? [];

  // The run View run opened: open, and in view once the read has it.
  useEffect(() => {
    if (!asked) return;
    setOpen(asked);
    document.getElementById(runAnchor(asked))?.scrollIntoView?.({ block: 'center' });
  }, [asked, rows.length]);

  if (!wikiRunsShown(health.data?.executor?.serverExecutes === true, rows)) return null;
  const model = health.data?.systemModel ?? null;
  const now = Date.now();
  return (
    <WikiCard title={WIKI_RUNS} hint={model ? <WikiModelLine model={model} /> : undefined} className="wk-runs-card">
      {rows.length === 0 ? (
        <WikiEmpty>{WIKI_RUNS_NONE}</WikiEmpty>
      ) : (
        <ol className="wk-runs">
          {rows.map((job) => (
            <WikiRunItem
              key={job.id}
              job={job}
              now={now}
              open={open === job.id}
              onToggle={() => setOpen((current) => (current === job.id ? null : job.id))}
            />
          ))}
        </ol>
      )}
    </WikiCard>
  );
}

const runAnchor = (jobId: string): string => `wk-run-${jobId}`;

/** One run: its row, a button that opens and closes its call log. */
function WikiRunItem({ job, now, open, onToggle }: { job: WikiJobView; now: number; open: boolean; onToggle: () => void }) {
  const log = useId();
  const row = wikiRunRow(job, now);
  return (
    <li className={`wk-run${open ? ' open' : ''}`} id={runAnchor(job.id)}>
      <button type="button" className="wk-run-row" aria-expanded={open} aria-controls={log} onClick={onToggle}>
        <span className={`wk-run-mark ${row.mark}`} aria-hidden="true" />
        <span className="k">{row.kind}</span>
        <span className={`s ${row.tone}`}>
          <b>{row.state}</b>
          {row.text ? ` · ${row.text}` : null}
        </span>
        <span className="when">{row.when}</span>
        <RightOutlined className="chev" />
      </button>
      {open && <WikiCallLog id={log} job={job} now={now} />}
    </li>
  );
}

/**
 * A run's call log: a table on a desktop, two lines a call on a phone (the CSS folds the same rows). A call that
 * failed, or waits again after a failure, has its error on the row under it.
 */
function WikiCallLog({ id, job, now }: { id: string; job: WikiJobView; now: number }) {
  return (
    <div className="wk-run-calls" id={id}>
      {job.requests.length > 0 && (
        <table className="wk-calls" aria-label={WIKI_CALLS}>
          <thead>
            <tr>
              <th>{WIKI_CALL}</th>
              <th>{WIKI_CALL_STATE}</th>
              <th className="n">{WIKI_CALL_WAITED}</th>
              <th className="n">{WIKI_CALL_RAN}</th>
              <th className="n">{WIKI_CALL_TOKENS}</th>
            </tr>
          </thead>
          <tbody>
            {job.requests.map((call) => {
              const one = wikiCallRow(call, now);
              return (
                <Fragment key={call.id}>
                  <tr>
                    <td className="c" title={`${call.step} · ${call.unit}`}>
                      {one.call}
                    </td>
                    <td className="st">
                      <span className={one.tone}>{one.state}</span>
                      {one.retries && <span className="dim"> · {one.retries}</span>}
                    </td>
                    <td className="n">{one.waited}</td>
                    <td className="n">{one.ran}</td>
                    <td className="n">{one.tokens}</td>
                    {one.line && <td className="line">{one.line}</td>}
                  </tr>
                  {one.error && (
                    <tr className="why">
                      <td colSpan={5}>{one.error}</td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      )}
      <div className="wk-run-foot">{wikiRunFootText(job)}</div>
    </div>
  );
}
