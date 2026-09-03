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
// per row, a pass ratio or a meter: there is nothing that concludes anything about a criterion.
// What it draws is the declaration, and that is what is asserted here.
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
  it('heads the card with what it is, not with a score', () => {
    const qc = client();
    seed(qc, FIVE);

    const html = paint(qc);
    expect(html).toContain('Acceptance criteria');
    expect(html).toContain('5 criteria stated');
    expect(html).toContain('Nothing in Orbit judges them');
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
