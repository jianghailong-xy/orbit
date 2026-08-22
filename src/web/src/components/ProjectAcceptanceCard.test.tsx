import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ProjectAcceptanceCard, type AcceptanceCriterionStanding } from './ProjectAcceptanceCard';

// The card fetches its own query, so the stub is what keeps an accidental live call visible as a
// hang-free failure rather than a real request. A static render never dispatches one anyway —
// react-query subscribes in an effect — which is why every state below is seeded into the cache.
vi.mock('../api', () => ({ api: vi.fn(() => new Promise(() => {})) }));

const PROJECT = '0195c0de-0000-7000-8000-000000000001';

function client() {
  // `retryOnMount: false` because a static render cannot perform the refetch a real mount would:
  // react-query optimistically reports a fresh observer over an errored query as pending, and the
  // fetch that would resolve it back to the error never runs here. Off, the seeded state is what
  // the card reads — which is also what a browser shows once that retry has failed too.
  return new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false } } });
}

function paint(qc: QueryClient) {
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <ProjectAcceptanceCard projectId={PROJECT} />
    </QueryClientProvider>,
  );
}

function criterion(
  ordinal: number,
  text: string,
  verdict: AcceptanceCriterionStanding['verdict'],
): AcceptanceCriterionStanding {
  return { key: `c${ordinal}`, text, ordinal, verdict };
}

/** Five stated criteria, two of them concluded PASS by the latest attempt. */
const FIVE = [
  criterion(1, 'The runner reconnects after a restart', 'PASS'),
  criterion(2, 'A queued message survives a redeploy', 'PASS'),
  criterion(3, 'The merge button refuses a diverged branch', 'FAIL'),
  criterion(4, 'Acceptance runs are recorded per criterion', 'UNDECIDED'),
  criterion(5, 'The context gauge reports a real window', 'INCONCLUSIVE'),
];

function seed(qc: QueryClient, acceptance: unknown) {
  qc.setQueryData(['project', PROJECT], { id: PROJECT, acceptance });
}

/** The state a failed read leaves the cache in. Built rather than fetched: a static render never
 *  runs the query, so the error has to be put where the observer reads it from. */
function seedError(qc: QueryClient, message: string) {
  const error = new Error(message);
  qc.getQueryCache()
    .build(qc, { queryKey: ['project', PROJECT] })
    .setState({ status: 'error', error, fetchStatus: 'idle' });
}

/** One rendered criterion row, as markup. */
function rowFor(html: string, text: string): string {
  const row = (html.match(/<li[^>]*>[\s\S]*?<\/li>/g) ?? []).find((r) => r.includes(text));
  if (row === undefined) throw new Error(`no row rendered for "${text}"`);
  return row;
}

/** A row with every inline style stripped: what is left is what a reader who cannot tell the
 *  colours apart is given. */
function withoutColour(row: string): string {
  return row.replace(/style="[^"]*"/g, '');
}

/** Everything a row says in words — its text plus the labels assistive tech reads. */
function accessibleText(row: string): string {
  const labels = [...row.matchAll(/aria-label="([^"]*)"/g)].map((m) => m[1]).join(' ');
  const text = row.replace(/<[^>]*>/g, ' ');
  return `${labels} ${text}`.replace(/\s+/g, ' ').trim();
}

describe('ProjectAcceptanceCard', () => {
  it('heads the card with passed over total', () => {
    const qc = client();
    seed(qc, { total: 5, passed: 2, lastRunAt: '2026-08-20T10:00:00.000Z', criteria: FIVE });

    expect(paint(qc)).toContain('2 / 5');
  });

  it('gives every criterion its text and its verdict as a word', () => {
    const qc = client();
    seed(qc, { total: 5, passed: 2, lastRunAt: '2026-08-20T10:00:00.000Z', criteria: FIVE });
    const html = paint(qc);

    for (const c of FIVE) expect(html).toContain(c.text);

    // The verdict is legible with the colours taken away — a badge that is only a hue says
    // nothing to a screen reader, a monochrome print, or a red-green reader.
    expect(withoutColour(rowFor(html, FIVE[0].text))).toContain('PASS');
    expect(withoutColour(rowFor(html, FIVE[2].text))).toContain('FAIL');
    expect(withoutColour(rowFor(html, FIVE[4].text))).toContain('INCONCLUSIVE');
    // The one badge whose label is not a word carries the sentence instead of a bare dash.
    expect(withoutColour(rowFor(html, FIVE[3].text))).toContain('Not judged yet');
  });

  it('says a passed criterion and a failed one apart in words, not only in colour', () => {
    const qc = client();
    seed(qc, { total: 5, passed: 2, lastRunAt: '2026-08-20T10:00:00.000Z', criteria: FIVE });
    const html = paint(qc);

    const passed = accessibleText(withoutColour(rowFor(html, FIVE[0].text)));
    const failed = accessibleText(withoutColour(rowFor(html, FIVE[2].text)));

    expect(passed).not.toEqual(failed);
    expect(passed).toContain('PASS');
    expect(passed).toContain('Passed');
    expect(failed).toContain('FAIL');
    expect(failed).toContain('Failed');
  });

  it('states that acceptance has never run instead of scoring it', () => {
    const qc = client();
    // The normal shape of a live project: criteria stated, no attempt against them.
    seed(qc, {
      total: 5,
      passed: 0,
      lastRunAt: null,
      criteria: FIVE.map((c) => ({ ...c, verdict: 'UNDECIDED' as const })),
    });
    const html = paint(qc);

    expect(html).toContain('Acceptance has never been run');
    // No ratio at all: "0 / 5" reads as a score somebody earned, and "0 / 0" as a finished one.
    expect(html).not.toContain('0 / 5');
    expect(html).not.toContain('0 / 0');
    // The stated criteria are still listed — unjudged, which is a fact, not an absence.
    for (const c of FIVE) expect(html).toContain(c.text);
  });

  it('does not print 0 / 0 for a project with no criteria and no run', () => {
    const qc = client();
    seed(qc, { total: 0, passed: 0, lastRunAt: null, criteria: [] });
    const html = paint(qc);

    expect(html).toContain('Acceptance has never been run');
    expect(html).not.toContain('0 / 0');
  });

  it('renders while the read is in flight', () => {
    const qc = client();
    const html = paint(qc);

    expect(html).toContain('ant-skeleton');
    expect(html).not.toContain('Acceptance has never been run');
  });

  it('renders the failure of the read as a failure', () => {
    const qc = client();
    seedError(qc, 'network is down');
    const html = paint(qc);

    expect(html).toContain('Acceptance standing could not be loaded');
    expect(html).toContain('network is down');
    // Not mistaken for a project nobody has run acceptance against.
    expect(html).not.toContain('Acceptance has never been run');
  });

  it('says when the server did not report acceptance at all', () => {
    const qc = client();
    qc.setQueryData(['project', PROJECT], { id: PROJECT });
    const html = paint(qc);

    expect(html).toContain('does not report acceptance standing');
    expect(html).not.toContain('Acceptance has never been run');
  });

  it('puts the caller\'s run control in the never-run state', () => {
    const qc = client();
    seed(qc, { total: 0, passed: 0, lastRunAt: null, criteria: [] });
    const html = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <ProjectAcceptanceCard projectId={PROJECT} action={<button type="button">Run acceptance</button>} />
      </QueryClientProvider>,
    );

    expect(html).toContain('Run acceptance');
  });

  it('reads the project document under the key the detail page already holds', () => {
    // Same key, same URL: the card shares the page's read rather than opening a second one, and a
    // write that invalidates ['project', id] refreshes both.
    const qc = client();
    seed(qc, { total: 1, passed: 1, lastRunAt: '2026-08-20T10:00:00.000Z', criteria: [criterion(1, 'It ships', 'PASS')] });

    expect(paint(qc)).toContain('It ships');
  });

  it('carries the process-versus-outcome note under the list', () => {
    const qc = client();
    seed(qc, { total: 5, passed: 2, lastRunAt: '2026-08-20T10:00:00.000Z', criteria: FIVE });

    expect(paint(qc)).toContain('process measure');
  });
});
