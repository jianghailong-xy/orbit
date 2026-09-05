// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ACCEPTANCE_PHONE_QUERY,
  CRITERIA_PREVIEW,
  MOBILE_CRITERIA_PREVIEW,
  ProjectAcceptanceCard,
  criteriaPreview,
  type AcceptanceCriterionItem,
} from './ProjectAcceptanceCard';

// Migration 0229 removed the project acceptance judgment, so this card no longer draws a verdict
// per row, a pass ratio or a meter: there is nothing that CONCLUDES anything about a criterion.
//
// What a row now says beside its declaration is a different kind of fact and the assertions keep
// the two apart. `satisfied`, `unmet` and `landing` are COMPUTED by the project read out of the
// tasks filed under a criterion — nobody writes them, nobody can overrule them — so the drawing
// is asserted to be words about that work, and the shapes 0229 deleted are asserted to stay gone:
// no ratio, no meter, no per-row verdict rail, no badge reading "Unjudged".
//
// A phone row no longer clamps that declaration to three lines behind a per-row chevron either
// (2026-09-03), so there is no rendered overflow left to measure and no ResizeObserver to stub:
// what a phone shows is what the desktop shows, one criterion per row, whole.

// The card fetches its own query, so the stub is what keeps an accidental live call visible as a
// hang-free failure rather than a real request. A static render never dispatches one anyway —
// react-query subscribes in an effect — which is why every state below is seeded into the cache.
vi.mock('../api', () => ({ api: vi.fn(() => new Promise(() => {})) }));

/** Static renders take the desktop branch. Mounted phone tests override this per test; answering
 * false for every other query also keeps antd's own breakpoint subscriptions deterministic. */
function stubViewport(phone: boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: phone && query === ACCEPTANCE_PHONE_QUERY,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  stubViewport(false);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

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

/** Mounts the stateful card so its phone-only controls can be pressed. */
async function mount(qc: QueryClient): Promise<{
  container: HTMLDivElement;
  cleanup: () => Promise<void>;
}> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={qc}>
        <ProjectAcceptanceCard projectId={PROJECT} />
      </QueryClientProvider>,
    );
  });
  return {
    container,
    cleanup: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

function criterion(ordinal: number, text: string): AcceptanceCriterionItem {
  return { id: `c${ordinal}`, text, ordinal, revision: 1 };
}

/** Five stated criteria. */
const FIVE = [
  criterion(1, 'The runner reconnects after a restart'),
  criterion(2, 'A queued message survives a redeploy'),
  criterion(3, 'The merge button refuses a diverged branch'),
  criterion(4, 'Acceptance criteria are stated per item'),
  criterion(5, 'The context gauge reports a real window'),
];

const SEVEN = [
  criterion(
    1,
    'The [full acceptance criterion](/docs/acceptance) stays readable even when its explanation needs several lines on a phone',
  ),
  ...Array.from({ length: 6 }, (_, i) => criterion(i + 2, `Mobile acceptance criterion ${i + 2}`)),
];

function seed(qc: QueryClient, criteria: unknown, rest: Record<string, unknown> = {}) {
  qc.setQueryData(['project', PROJECT], {
    id: PROJECT, acceptanceCriteriaItems: criteria, ...rest,
  });
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

/** The markup of each unmet reason in a row, split on the reason marker so that a task named
 *  under the second reason cannot pass for one named under the first. */
function unmetReasons(row: string): string[] {
  return row.split('class="acceptance-unmet-reason"').slice(1);
}

/** How many criteria rows the card drew. */
function rowCount(html: string): number {
  return (html.match(/class="acceptance-row(?: |")/g) ?? []).length;
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => element.click());
}

// The first antd render initializes its jsdom style registry and can cross Vitest's 5s default on
// a loaded CI worker; the assertions themselves remain synchronous and bounded.
describe('ProjectAcceptanceCard', { timeout: 20_000 }, () => {
  it('heads the card with what it is, and says where a row\'s answer comes from', () => {
    const qc = client();
    seed(qc, FIVE);

    const html = paint(qc);
    expect(html).toContain('Acceptance criteria');
    expect(html).toContain('5 criteria stated');
    // The head used to say only that nothing judges these criteria, which was the whole of what
    // was true. A row now carries an answer, so the head has to say where that answer comes from:
    // it is read off the work, and the criterion's own text is still judged by nobody.
    expect(html).toContain('read off the work filed under it');
    expect(html).toContain('nothing in Orbit judges the criteria themselves');
    // The two readings a removed judgment would still have printed. Neither may come back: a
    // constant "0 / 5" and a row of "Unjudged" badges both read as a result somebody reached.
    expect(html).not.toContain('/ 5 PASS');
    expect(html).not.toContain('Unjudged');
    expect(html).not.toContain('acceptance-meter');
  });

  it('gives every criterion its text, in stated order, numbered', () => {
    const qc = client();
    seed(qc, FIVE);

    const html = paint(qc);
    for (const item of FIVE) expect(html).toContain(item.text);
    const numbers = [...html.matchAll(/class="acceptance-row-no">(\d+)</g)].map((m) => m[1]);
    expect(numbers).toEqual(['1', '2', '3', '4', '5']);
    const order = FIVE.map((item) => html.indexOf(item.text));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('carries no verdict rail beside a row any more', () => {
    const qc = client();
    seed(qc, FIVE);

    const row = rowFor(paint(qc), 'The runner reconnects after a restart');
    expect(row).not.toContain('acceptance-row-verdict');
    expect(withoutColour(row)).toContain('The runner reconnects after a restart');
    expect(accessibleText(row)).toContain('The runner reconnects after a restart');
  });

  it('reads a criterion as Markdown rather than printing its source', () => {
    const qc = client();
    seed(qc, [criterion(1, 'Lighthouse **≥ 90** on `/` and `/tasks`')]);

    const row = rowFor(paint(qc), 'Lighthouse');
    expect(row).toContain('<strong>≥ 90</strong>');
    expect(row).toContain('<code>/</code>');
    expect(row).not.toContain('**≥ 90**');
  });

  it('says so plainly when nothing is stated', () => {
    const qc = client();
    seed(qc, []);

    const html = paint(qc);
    expect(html).toContain('No criteria are stated for this project');
    expect(rowCount(html)).toBe(0);
  });

  it('treats a missing criteria list as empty', () => {
    const qc = client();
    qc.setQueryData(['project', PROJECT], { id: PROJECT });

    expect(paint(qc)).toContain('No criteria are stated for this project');
  });

  it('renders while the read is in flight', () => {
    const qc = client();

    expect(paint(qc)).toContain('ant-skeleton');
  });

  it('renders the failure of the read as a failure', () => {
    const qc = client();
    seedError(qc, 'gateway timeout');

    const html = paint(qc);
    expect(html).toContain('Acceptance criteria could not be loaded');
    expect(html).toContain('gateway timeout');
  });

  it('says how many criteria it is not showing on a long list', () => {
    const qc = client();
    seed(qc, Array.from({ length: CRITERIA_PREVIEW + 3 }, (_, i) => criterion(i + 1, `C${i + 1}`)));

    const html = paint(qc);
    expect(rowCount(html)).toBe(CRITERIA_PREVIEW);
    expect(html).toContain(`Show all ${CRITERIA_PREVIEW + 3} criteria`);
    expect(html).toContain('3 more not shown');
  });

  it('draws no expander for a list it shows whole', () => {
    const qc = client();
    seed(qc, FIVE);

    const html = paint(qc);
    expect(rowCount(html)).toBe(5);
    expect(html).not.toContain('more not shown');
  });

  it("puts the caller's control in the head", () => {
    const qc = client();
    seed(qc, FIVE);

    const html = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <ProjectAcceptanceCard projectId={PROJECT} action={<button type="button">Edit</button>} />
      </QueryClientProvider>,
    );
    expect(html).toContain('>Edit<');
  });

  it('reads the project document under the key the detail page already holds', () => {
    const qc = client();
    seed(qc, FIVE);

    // No second request: the card renders from the cache the project page filled.
    expect(paint(qc)).toContain('The runner reconnects after a restart');
    expect(qc.getQueryCache().getAll().map((query) => query.queryKey))
      .toEqual([['project', PROJECT]]);
  });

  it('carries the process-versus-outcome note under the list', () => {
    const qc = client();
    seed(qc, FIVE);

    const html = paint(qc);
    expect(html).toContain('Task completion is a process measure');
    expect(html).toContain('nothing evaluates these criteria');
  });
});

// What a row says about the WORK filed under its criterion. Every field below is computed by the
// project read — nobody writes `satisfied`, `unmet` or `landing`, and nobody can overrule them —
// which is the distinction these cases exist to keep visible: the card draws a derivation, not
// the judgment 0229 removed.
const MET_CRITERION: AcceptanceCriterionItem = {
  ...criterion(1, 'The project read serves each criterion its satisfaction'),
  satisfied: true,
  unmet: [],
  landing: 'LANDED',
};

const HELD_UP_CRITERION: AcceptanceCriterionItem = {
  ...criterion(2, 'A reader can see what is holding a criterion open'),
  satisfied: false,
  landing: 'UNKNOWN',
  unmet: [
    {
      clause: 'SERVING_WORK_UNSETTLED',
      heldUpBy: [
        { taskId: 't-1', title: 'Carry the derivation onto the project read', requiredAction: 'RUN_ACCEPTANCE_COMMAND' },
        { taskId: 't-2', title: 'Prove the read has no N+1', requiredAction: 'OBTAIN_INDEPENDENT_VERIFICATION_PASS' },
      ],
    },
    {
      clause: 'DECLARATION_STALE',
      heldUpBy: [
        { taskId: 't-3', title: 'Reword the landing lane', requiredAction: 'SUBMIT_EVIDENCE_AND_AWAIT_INDEPENDENT_DECISION' },
      ],
    },
  ],
};

const DERIVED = [MET_CRITERION, HELD_UP_CRITERION];

describe('ProjectAcceptanceCard on what the work has done', { timeout: 20_000 }, () => {
  it('says a criterion its work has met, and says it about the work', () => {
    const qc = client();
    seed(qc, DERIVED);

    const row = rowFor(paint(qc), 'The project read serves each criterion its satisfaction');
    expect(row).toContain('Met by its work');
    // Not a colour, not an icon: a reader who cannot tell a green pill from a red one is told the
    // same thing as everybody else.
    expect(accessibleText(withoutColour(row))).toContain('Met by its work');
    expect(row).not.toContain('acceptance-unmet');
  });

  it('gives an unmet criterion every reason, and each reason the work holding it open', () => {
    const qc = client();
    seed(qc, DERIVED);

    const row = rowFor(paint(qc), 'A reader can see what is holding a criterion open');
    expect(row).toContain('Not met by its work');

    // Both reasons, not the first one: a reader who fixes what they were shown and comes back for
    // the next has been sent round the loop twice.
    const reasons = unmetReasons(row);
    expect(reasons).toHaveLength(2);
    expect(reasons[0]).toContain('has not settled by the criterion that work declared');
    expect(reasons[1]).toContain('filed against an earlier wording of this criterion');

    // Each reason names ITS OWN tasks, and each named task carries what would settle it. A title
    // alone says a red dot has a name; `requiredAction` says who does what next.
    expect(reasons[0]).toContain('Carry the derivation onto the project read');
    expect(reasons[0]).toContain('RUN_ACCEPTANCE_COMMAND');
    expect(reasons[0]).toContain('Prove the read has no N+1');
    expect(reasons[0]).toContain('OBTAIN_INDEPENDENT_VERIFICATION_PASS');
    expect(reasons[1]).toContain('Reword the landing lane');
    expect(reasons[1]).toContain('SUBMIT_EVIDENCE_AND_AWAIT_INDEPENDENT_DECISION');
    // Grouped, not run together: the stale task is under the stale clause and nowhere else.
    expect(reasons[0]).not.toContain('Reword the landing lane');
  });

  it('draws a landing that is unknown as unknown, never as unlanded', () => {
    const qc = client();
    seed(qc, DERIVED);

    const html = paint(qc);
    expect(rowFor(html, 'The project read serves each criterion its satisfaction'))
      .toContain('Landed on the default branch');
    const unknown = rowFor(html, 'A reader can see what is holding a criterion open');
    expect(unknown).toContain('Landing unknown');
    expect(unknown).not.toContain('Landed on the default branch');
    // The value the lane refuses to produce may not be invented by the drawing either: no receipt
    // is no evidence, and work lands without leaving one.
    for (const lie of ['Not landed', 'NOT_LANDED', 'not merged', 'Unmerged']) {
      expect(html).not.toContain(lie);
    }
  });

  it('reports the derivation without any of the shapes 0229 deleted', () => {
    const qc = client();
    seed(qc, DERIVED);

    const html = paint(qc);
    expect(html).not.toContain('Unjudged');
    expect(html).not.toContain('acceptance-meter');
    expect(html).not.toContain('acceptance-row-verdict');
    // And no ratio anywhere: "1 / 2 met" is the pass count that was removed, under a new name.
    expect(html).not.toMatch(/\d+\s*(?:\/|of)\s*\d+/);
  });

  it('draws nothing for a criterion the read did not answer for', () => {
    const qc = client();
    seed(qc, [criterion(1, 'The runner reconnects after a restart')]);

    const html = paint(qc);
    expect(html).toContain('The runner reconnects after a restart');
    expect(html).not.toContain('acceptance-work');
    expect(html).not.toContain('Met by its work');
  });
});

describe('ProjectAcceptanceCard on a phone', { timeout: 20_000 }, () => {
  it('shows four of seven criteria first, names the hidden count, and can reveal the rest', async () => {
    stubViewport(true);
    const qc = client();
    seed(qc, SEVEN);
    const { container, cleanup } = await mount(qc);
    try {
      expect(rowCount(container.innerHTML)).toBe(MOBILE_CRITERIA_PREVIEW);
      expect(container.textContent).toContain('View all 7 criteria');
      expect(container.textContent).toContain('3 more not shown');

      const more = container.querySelector<HTMLButtonElement>('.acceptance-more-button');
      expect(more).not.toBeNull();
      await click(more!);
      expect(rowCount(container.innerHTML)).toBe(7);
      expect(container.textContent).toContain('Showing all 7 criteria');
    } finally {
      await cleanup();
    }
  });

  it('gives a phone the whole criterion, formatted, and no per-row disclosure', async () => {
    stubViewport(true);
    const qc = client();
    seed(qc, SEVEN);
    const { container, cleanup } = await mount(qc);
    try {
      // The long fixture is exactly what the removed three-line clamp used to cut, and its link
      // is what the collapsed preview used to flatten out of the document.
      expect(container.textContent).toContain('needs several lines on a phone');
      expect(container.querySelector('a[href="/docs/acceptance"]')).not.toBeNull();
      expect(container.querySelector('.acceptance-row-toggle')).toBeNull();
      expect(container.querySelector('.acceptance-row-preview')).toBeNull();
      // Every phone row used to carry this class unconditionally, whatever it measured. Nothing
      // renders a phone-only row shape any more, which is what makes the two assertions above
      // more than an accident of jsdom having no layout.
      expect(container.querySelector('.acceptance-row-mobile')).toBeNull();
      // The list-level disclosure is a different control and stays: it names the hidden three.
      expect(container.querySelector('.acceptance-more-button')).not.toBeNull();
    } finally {
      await cleanup();
    }
  });

  it('keeps all seven criteria and full row text on a desktop', () => {
    stubViewport(false);
    const qc = client();
    seed(qc, SEVEN);

    const html = paint(qc);
    expect(rowCount(html)).toBe(7);
    expect(html).toContain('needs several lines on a phone');
  });
});

describe('criteriaPreview', () => {
  const many = Array.from({ length: 20 }, (_, i) => criterion(i + 1, `C${i + 1}`));

  it('shows the first page collapsed and everything expanded', () => {
    expect(criteriaPreview(many, false)).toHaveLength(CRITERIA_PREVIEW);
    expect(criteriaPreview(many, true)).toHaveLength(20);
  });

  it('leaves a short list alone in both readings', () => {
    expect(criteriaPreview(FIVE, false)).toEqual(FIVE);
    expect(criteriaPreview(FIVE, true)).toEqual(FIVE);
  });

  it('accepts the smaller phone preview without changing the desktop default', () => {
    expect(criteriaPreview(many, false, MOBILE_CRITERIA_PREVIEW))
      .toHaveLength(MOBILE_CRITERIA_PREVIEW);
    expect(criteriaPreview(many, false)).toHaveLength(CRITERIA_PREVIEW);
  });
});
