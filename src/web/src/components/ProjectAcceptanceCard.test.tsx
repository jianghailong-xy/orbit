// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ACCEPTANCE_PHONE_QUERY,
  CRITERIA_PREVIEW,
  METER_SEGMENT_LIMIT,
  MOBILE_CRITERION_PREVIEW_LINES,
  MOBILE_CRITERIA_PREVIEW,
  ProjectAcceptanceCard,
  criterionNeedsDisclosure,
  criteriaPreview,
  meterReading,
  meterSegments,
  standingLine,
  tally,
  type AcceptanceCriterionStanding,
} from './ProjectAcceptanceCard';

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

interface ObservedResize {
  callback: ResizeObserverCallback;
  targets: Set<Element>;
  observer: ResizeObserver;
}

let observedResizes: ObservedResize[] = [];

/** jsdom has neither layout nor ResizeObserver. Tests put explicit dimensions on the preview and
 * then send the same notification a real width change would send. */
function stubResizeObserver(): void {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      private readonly observed: ObservedResize;

      constructor(callback: ResizeObserverCallback) {
        this.observed = {
          callback,
          targets: new Set(),
          observer: this as unknown as ResizeObserver,
        };
        observedResizes.push(this.observed);
      }

      observe(target: Element): void {
        this.observed.targets.add(target);
      }

      unobserve(target: Element): void {
        this.observed.targets.delete(target);
      }

      disconnect(): void {
        this.observed.targets.clear();
      }
    },
  );
}

async function notifyResizeObservers(): Promise<void> {
  await act(async () => {
    for (const observed of observedResizes) {
      const entries = [...observed.targets].map((target) => ({ target }) as ResizeObserverEntry);
      if (entries.length > 0) observed.callback(entries, observed.observer);
    }
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  observedResizes = [];
  stubViewport(false);
  stubResizeObserver();
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

const SEVEN = [
  criterion(
    1,
    'The [full acceptance criterion](/docs/acceptance) stays readable even when its explanation needs several lines on a phone',
    'UNDECIDED',
  ),
  ...Array.from({ length: 6 }, (_, i) =>
    criterion(i + 2, `Mobile acceptance criterion ${i + 2}`, 'UNDECIDED'),
  ),
];

/** Long enough ago that `ago` reports whole days, so the sentence is the same on every run of
 *  this suite rather than flipping between "59m ago" and "1h ago" as the clock moves. */
const RAN_AT = '2020-01-01T00:00:00.000Z';

function seed(qc: QueryClient, acceptance: unknown, rest: Record<string, unknown> = {}) {
  qc.setQueryData(['project', PROJECT], { id: PROJECT, acceptance, ...rest });
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

/** Supplies the layout facts jsdom deliberately does not calculate. Only the first, long fixture
 * is allowed to overflow; every ordinary row remains under the three-line threshold. */
function stubCriterionLayout(initiallyOverflows: boolean): {
  setLongCriterionOverflow: (next: boolean) => void;
} {
  let longCriterionOverflows = initiallyOverflows;
  const getComputedStyle = window.getComputedStyle.bind(window);
  vi.spyOn(window, 'getComputedStyle').mockImplementation((element, pseudoElement) => {
    const style = getComputedStyle(element, pseudoElement);
    if (
      element instanceof HTMLElement
      && (element.classList.contains('acceptance-row-preview')
        || element.classList.contains('acceptance-row-full'))
    ) {
      Object.defineProperty(style, 'lineHeight', { configurable: true, value: '20px' });
    }
    return style;
  });
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function () {
    const criterionText = this.textContent ?? '';
    if (criterionText.includes('full acceptance criterion')) {
      return longCriterionOverflows ? 80 : 40;
    }
    return 40;
  });
  return {
    setLongCriterionOverflow: (next: boolean) => {
      longCriterionOverflows = next;
    },
  };
}

// The first antd render initializes its jsdom style registry and can cross Vitest's 5s default on
// a loaded CI worker; the assertions themselves remain synchronous and bounded.
describe('ProjectAcceptanceCard', { timeout: 20_000 }, () => {
  it('heads the card with passed over total', () => {
    const qc = client();
    seed(qc, { total: 5, passed: 2, lastRunAt: RAN_AT, criteria: FIVE });

    expect(paint(qc)).toContain('2 / 5');
  });

  it('gives every criterion its text and its verdict as a word', () => {
    const qc = client();
    seed(qc, { total: 5, passed: 2, lastRunAt: RAN_AT, criteria: FIVE });
    const html = paint(qc);

    for (const c of FIVE) expect(html).toContain(c.text);

    // The verdict is legible with the colours taken away — a badge that is only a hue says
    // nothing to a screen reader, a monochrome print, or a red-green reader.
    expect(withoutColour(rowFor(html, FIVE[0].text))).toContain('PASS');
    expect(withoutColour(rowFor(html, FIVE[2].text))).toContain('FAIL');
    expect(withoutColour(rowFor(html, FIVE[4].text))).toContain('INCONCLUSIVE');
    // Undecided is a readable visual state. Its accessible name begins with the same visible
    // label (label-in-name for speech input), then adds the fuller explanation.
    const undecided = withoutColour(rowFor(html, FIVE[3].text));
    expect(undecided).toContain('>Unjudged<');
    expect(undecided).toContain('aria-label="Unjudged — not judged yet"');
  });

  it('says a passed criterion and a failed one apart in words, not only in colour', () => {
    const qc = client();
    seed(qc, { total: 5, passed: 2, lastRunAt: RAN_AT, criteria: FIVE });
    const html = paint(qc);

    const passed = accessibleText(withoutColour(rowFor(html, FIVE[0].text)));
    const failed = accessibleText(withoutColour(rowFor(html, FIVE[2].text)));

    expect(passed).not.toEqual(failed);
    expect(passed).toContain('PASS');
    expect(passed).toContain('Passed');
    expect(failed).toContain('FAIL');
    expect(failed).toContain('Failed');
  });

  it('numbers each row and puts its verdict in the rail, in stated order', () => {
    const qc = client();
    seed(qc, { total: 5, passed: 2, lastRunAt: RAN_AT, criteria: FIVE });
    const html = paint(qc);

    // The ordinal is what ties a row back to the numbered list the author wrote, and the rail is
    // what lines the verdicts up as one scannable column beside sentences of any length.
    for (const c of FIVE) {
      const row = rowFor(html, c.text);
      expect(row).toContain(`class="acceptance-row-no">${c.ordinal}<`);
      expect(row).toContain('class="acceptance-row-verdict"');
    }

    // Stated order, not verdict order: the meter above indexes the rows by position.
    const order = FIVE.map((c) => html.indexOf(c.text));
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('marks a failed row as failed beyond its badge', () => {
    const qc = client();
    seed(qc, { total: 5, passed: 2, lastRunAt: RAN_AT, criteria: FIVE });
    const html = paint(qc);

    expect(rowFor(html, FIVE[2].text)).toContain('is-fail');
    // ...and no other row is dressed as one.
    expect(rowFor(html, FIVE[0].text)).not.toContain('is-fail');
    expect(rowFor(html, FIVE[4].text)).not.toContain('is-fail');
  });

  it('reads a criterion as Markdown rather than printing its source', () => {
    const qc = client();
    seed(qc, {
      total: 2,
      passed: 0,
      lastRunAt: null,
      criteria: [
        criterion(1, 'The **90** Lighthouse score holds on `/pricing`', 'UNDECIDED'),
        // A criterion is one line of the authored field, and the parser keeps a heading line as
        // one — so a row has to survive being handed block Markdown without becoming a heading.
        criterion(2, '## Ship it', 'UNDECIDED'),
      ],
    });
    const html = paint(qc);

    expect(html).toContain('<strong>90</strong>');
    expect(html).toContain('<code>/pricing</code>');
    expect(html).not.toContain('**90**');
    // Flattened: the row is a row whatever the author typed.
    expect(html).toContain('Ship it');
    expect(html).not.toContain('<h2>');
    expect(html).not.toContain('## Ship it');
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

    expect(html).toContain('Never run — 5 criteria stated');
    expect(html).toContain('unknown, not zero');
    // No ratio at all: "0 / 5" reads as a score somebody earned, and "0 / 0" as a finished one.
    expect(html).not.toContain('0 / 5');
    expect(html).not.toContain('0 / 0');
    // What IS shown is a count of what was stated, which is a fact rather than a result.
    expect(html).toContain('5 unjudged');
    // The stated criteria are still listed — unjudged, which is a fact, not an absence.
    for (const c of FIVE) expect(html).toContain(c.text);
  });

  it('does not print 0 / 0 for a project with no criteria and no run', () => {
    const qc = client();
    seed(qc, { total: 0, passed: 0, lastRunAt: null, criteria: [] });
    const html = paint(qc);

    expect(html).toContain('No criteria are stated for this project');
    expect(html).not.toContain('0 / 0');
    // Nothing to draw a meter of, so there is no meter — an empty track reads as a zero score.
    expect(html).not.toContain('acceptance-meter');
    // And no count either: `0 unjudged` is a number where a score goes, for a project that was
    // never held to anything.
    expect(html).not.toContain('unjudged');
  });

  it('treats a missing criteria list as empty', () => {
    const qc = client();
    seed(qc, { total: 0, passed: 0, lastRunAt: null });

    const html = paint(qc);
    expect(html).toContain('No criteria are stated for this project');
  });

  it('renders while the read is in flight', () => {
    const qc = client();
    const html = paint(qc);

    expect(html).toContain('ant-skeleton');
    expect(html).not.toContain('Never run');
  });

  it('renders the failure of the read as a failure', () => {
    const qc = client();
    seedError(qc, 'network is down');
    const html = paint(qc);

    expect(html).toContain('Acceptance standing could not be loaded');
    expect(html).toContain('network is down');
    // Not mistaken for a project nobody has run acceptance against.
    expect(html).not.toContain('Never run');
  });

  it('says when the server did not report acceptance at all', () => {
    const qc = client();
    qc.setQueryData(['project', PROJECT], { id: PROJECT });
    const html = paint(qc);

    expect(html).toContain('does not report acceptance standing');
    expect(html).not.toContain('Never run');
  });

  it('falls back to the criteria as written when the server reports no standing', () => {
    // The one thing the deleted `Acceptance criteria` field did that no verdict list can: on a
    // server that does not report acceptance, the authored text is the only account of what this
    // project is held to, and the page has nowhere else to show it.
    const qc = client();
    qc.setQueryData(['project', PROJECT], {
      id: PROJECT,
      acceptanceCriteria: '1. Lighthouse ≥ 90 on every page\n2. No **console** errors',
    });
    const html = paint(qc);

    expect(html).toContain('does not report acceptance standing');
    expect(html).toContain('showing the stated criteria as written');
    expect(html).toContain('Lighthouse ≥ 90 on every page');
    // As Markdown, like the field it replaces — not as source.
    expect(html).toContain('<strong>console</strong>');
    expect(html).not.toContain('**console**');
  });

  it('prefers the reported standing over the authored text when it has both', () => {
    // Both are in the document on every modern server. Only one of them carries verdicts, and
    // drawing both is what this card was consolidated to stop doing.
    const qc = client();
    seed(
      qc,
      { total: 1, passed: 1, lastRunAt: RAN_AT, criteria: [criterion(1, 'Every page scores 90', 'PASS')] },
      { acceptanceCriteria: 'Lighthouse ≥ 90 on every page' },
    );
    const html = paint(qc);

    expect(html).toContain('Every page scores 90');
    expect(html).not.toContain('Lighthouse ≥ 90 on every page');
  });

  it('surfaces an ambiguous one-line legacy backfill instead of pretending it was split', () => {
    const qc = client();
    seed(
      qc,
      {
        total: 1,
        passed: 0,
        lastRunAt: null,
        criteria: [criterion(1, '1. Build; 2. Boot', 'UNDECIDED')],
      },
      {
        acceptanceCriteria: '1. Build; 2. Boot',
        acceptanceCriteriaMigration: {
          source: 'LEGACY_TEXT',
          needsReview: true,
          reason: 'AMBIGUOUS_SINGLE_LINE_ENUMERATION',
        },
      },
    );
    const html = paint(qc);

    expect(html).toContain('Legacy acceptance criteria need review');
    expect(html).toContain('preserved as one criterion rather than guessed into several');
    expect(rowCount(html)).toBe(1);
  });

  it('says how many criteria it is not showing on a long list', () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      criterion(i + 1, `Criterion number ${i + 1} holds`, i % 3 === 0 ? 'PASS' : 'UNDECIDED'),
    );
    const qc = client();
    seed(qc, { total: 30, passed: 10, lastRunAt: RAN_AT, criteria: many });
    const html = paint(qc);

    expect(rowCount(html)).toBe(CRITERIA_PREVIEW);
    // Named, not silently dropped: a list that stopped at twelve without saying so reads as a
    // complete list of twelve.
    expect(html).toContain('Show all 30 criteria');
    expect(html).toContain('18 more not shown');
    expect(html).toContain('Criterion number 12 holds');
    expect(html).not.toContain('Criterion number 13 holds');
  });

  it('draws no expander for a list it shows whole', () => {
    const qc = client();
    seed(qc, { total: 5, passed: 2, lastRunAt: RAN_AT, criteria: FIVE });
    const html = paint(qc);

    expect(rowCount(html)).toBe(5);
    expect(html).not.toContain('Show all');
    expect(html).not.toContain('more not shown');
  });

  it('puts the caller\'s run control in the head', () => {
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
    seed(qc, { total: 1, passed: 1, lastRunAt: RAN_AT, criteria: [criterion(1, 'It ships', 'PASS')] });

    expect(paint(qc)).toContain('It ships');
  });

  it('carries the process-versus-outcome note under the list', () => {
    const qc = client();
    seed(qc, { total: 5, passed: 2, lastRunAt: RAN_AT, criteria: FIVE });

    expect(paint(qc)).toContain('process measure');
  });
});

describe('ProjectAcceptanceCard on a phone', { timeout: 20_000 }, () => {
  it('shows four of seven criteria first, names the hidden count, and can reveal the rest', async () => {
    stubViewport(true);
    const qc = client();
    seed(qc, { total: 7, passed: 0, lastRunAt: null, criteria: SEVEN });
    const mounted = await mount(qc);

    try {
      expect(mounted.container.querySelectorAll('.acceptance-row')).toHaveLength(
        MOBILE_CRITERIA_PREVIEW,
      );
      expect(mounted.container.textContent).toContain('Mobile acceptance criterion 4');
      expect(mounted.container.textContent).not.toContain('Mobile acceptance criterion 5');
      expect(mounted.container.textContent).toContain('3 more not shown');

      const viewAll = [...mounted.container.querySelectorAll('button')].find(
        (button) => button.textContent?.trim() === 'View all 7 criteria',
      );
      expect(viewAll, 'the control that names the complete list').toBeTruthy();
      expect(viewAll!.getAttribute('aria-expanded')).toBe('false');
      viewAll!.focus();
      await click(viewAll!);

      expect(mounted.container.querySelectorAll('.acceptance-row')).toHaveLength(7);
      expect(mounted.container.textContent).toContain('Mobile acceptance criterion 7');
      expect(viewAll!.textContent).toContain('Show first 4 criteria');
      expect(viewAll!.getAttribute('aria-expanded')).toBe('true');
      expect(mounted.container.textContent).toContain('Showing all 7 criteria');
      expect(document.activeElement).toBe(viewAll);

      await click(viewAll!);
      expect(mounted.container.querySelectorAll('.acceptance-row')).toHaveLength(4);
      expect(viewAll!.textContent).toContain('View all 7 criteria');
      expect(viewAll!.getAttribute('aria-expanded')).toBe('false');
      expect(mounted.container.textContent).toContain('3 more not shown');
      expect(document.activeElement).toBe(viewAll);
    } finally {
      await mounted.cleanup();
    }
  });

  it('renders a short criterion as full Markdown without a disclosure that reveals nothing', async () => {
    stubViewport(true);
    stubCriterionLayout(false);
    const qc = client();
    seed(qc, {
      total: 1,
      passed: 0,
      lastRunAt: null,
      criteria: [criterion(1, 'A [short criterion](/docs/short) fits', 'UNDECIDED')],
    });
    const mounted = await mount(qc);

    try {
      const row = mounted.container.querySelector<HTMLElement>('.acceptance-row-mobile');
      expect(row).toBeTruthy();
      expect(row!.querySelector('.acceptance-row-toggle')).toBeNull();
      expect(row!.querySelector('.acceptance-row-preview')).toBeNull();
      const full = row!.querySelector<HTMLElement>('.acceptance-row-full');
      expect(full?.hidden).toBe(false);
      expect(full?.querySelector('a')?.getAttribute('href')).toBe('/docs/short');
      expect(row!.querySelector('.acceptance-row-verdict-static')).toBeTruthy();
    } finally {
      await mounted.cleanup();
    }
  });

  it('reveals and re-hides the formatted Markdown only when a criterion really overflows', async () => {
    stubViewport(true);
    stubCriterionLayout(true);
    const qc = client();
    seed(qc, { total: 1, passed: 0, lastRunAt: null, criteria: [SEVEN[0]] });
    const mounted = await mount(qc);

    try {
      const row = mounted.container.querySelector<HTMLElement>('.acceptance-row-mobile');
      const preview = row?.querySelector<HTMLElement>('.acceptance-row-preview');
      const full = row?.querySelector<HTMLElement>('.acceptance-row-full');
      const toggle = row?.querySelector<HTMLButtonElement>('.acceptance-row-toggle');

      expect(preview?.hidden).toBe(false);
      expect(preview?.textContent).toContain('full acceptance criterion');
      expect(preview?.querySelector('a')).toBeNull();
      expect(full?.hidden).toBe(true);
      expect(full?.querySelector('a')?.getAttribute('href')).toBe('/docs/acceptance');
      expect(toggle?.getAttribute('aria-expanded')).toBe('false');
      expect(toggle?.getAttribute('aria-controls')).toBe(full?.id);
      expect(toggle?.getAttribute('aria-label')).toContain('Show formatted criterion 1');

      toggle!.focus();
      await click(toggle!);
      expect(preview?.hidden).toBe(true);
      expect(full?.hidden).toBe(false);
      expect(full?.querySelector<HTMLAnchorElement>('a')?.tabIndex).toBe(0);
      expect(toggle?.getAttribute('aria-expanded')).toBe('true');
      expect(toggle?.getAttribute('aria-label')).toContain('Hide formatted criterion 1');
      expect(row?.classList.contains('is-expanded')).toBe(true);
      expect(document.activeElement).toBe(toggle);

      await click(toggle!);
      expect(preview?.hidden).toBe(false);
      expect(preview?.querySelector('a')).toBeNull();
      expect(full?.hidden).toBe(true);
      expect(toggle?.getAttribute('aria-expanded')).toBe('false');
      expect(row?.classList.contains('is-expanded')).toBe(false);
      expect(document.activeElement).toBe(toggle);
    } finally {
      await mounted.cleanup();
    }
  });

  it('re-measures overflow when ResizeObserver reports a width change', async () => {
    stubViewport(true);
    const layout = stubCriterionLayout(true);
    const qc = client();
    seed(qc, { total: 1, passed: 0, lastRunAt: null, criteria: [SEVEN[0]] });
    const mounted = await mount(qc);

    try {
      expect(mounted.container.querySelector('.acceptance-row-toggle')).toBeTruthy();

      layout.setLongCriterionOverflow(false);
      await notifyResizeObservers();
      expect(mounted.container.querySelector('.acceptance-row-toggle')).toBeNull();
      expect(mounted.container.querySelector<HTMLElement>('.acceptance-row-full')?.hidden).toBe(
        false,
      );

      layout.setLongCriterionOverflow(true);
      await notifyResizeObservers();
      expect(mounted.container.querySelector('.acceptance-row-toggle')).toBeTruthy();
      expect(mounted.container.querySelector<HTMLElement>('.acceptance-row-preview')?.hidden).toBe(
        false,
      );
      expect(mounted.container.querySelector<HTMLElement>('.acceptance-row-full')?.hidden).toBe(
        true,
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it('keeps all seven criteria and full row text on a desktop', () => {
    const qc = client();
    seed(qc, { total: 7, passed: 0, lastRunAt: null, criteria: SEVEN });
    const html = paint(qc);

    expect(rowCount(html)).toBe(7);
    expect(html).not.toContain('View all 7 criteria');
    expect(html).not.toContain('more not shown');
    expect(html).not.toContain('aria-expanded');
    expect(html).not.toContain('acceptance-row-mobile');
    expect(html.match(/href="\/docs\/acceptance"/g)).toHaveLength(1);
  });
});

describe('mobile criterion overflow', () => {
  it('asks for disclosure only beyond the three-line rendered preview', () => {
    const layout = stubCriterionLayout(false);
    const preview = document.createElement('span');
    preview.className = 'acceptance-row-preview';
    preview.textContent = 'full acceptance criterion';

    expect(MOBILE_CRITERION_PREVIEW_LINES).toBe(3);
    expect(criterionNeedsDisclosure(preview)).toBe(false);
    layout.setLongCriterionOverflow(true);
    expect(criterionNeedsDisclosure(preview)).toBe(true);
  });
});

describe('the meter', () => {
  it('is one segment per criterion, in stated order', () => {
    // Segment three is criterion three: the meter indexes the list under it rather than
    // summarizing it, which is the only reading that survives being placed above the rows.
    expect(meterSegments(FIVE)).toEqual([
      { verdict: 'PASS', weight: 1 },
      { verdict: 'PASS', weight: 1 },
      { verdict: 'FAIL', weight: 1 },
      { verdict: 'UNDECIDED', weight: 1 },
      { verdict: 'INCONCLUSIVE', weight: 1 },
    ]);
  });

  it('collapses to proportional runs once per-criterion segments stop being readable', () => {
    const many = Array.from({ length: METER_SEGMENT_LIMIT + 1 }, (_, i) =>
      criterion(i + 1, `c${i}`, i < 20 ? 'PASS' : 'FAIL'),
    );
    expect(meterSegments(many)).toEqual([
      { verdict: 'PASS', weight: 20 },
      { verdict: 'FAIL', weight: 5 },
    ]);
    // Exactly at the limit it is still one segment each — the collapse is above it, not at it.
    expect(meterSegments(many.slice(0, METER_SEGMENT_LIMIT))).toHaveLength(METER_SEGMENT_LIMIT);
  });

  it('draws nothing for a project with no criteria', () => {
    expect(meterSegments([])).toEqual([]);
  });

  it('says its reading in words', () => {
    const t = tally(FIVE);
    expect(t).toEqual({ pass: 2, fail: 1, inconclusive: 1, undecided: 1, total: 5 });
    expect(meterReading(t, true)).toBe(
      '2 passed, 1 failed, 1 inconclusive, 1 not judged of 5 criteria',
    );
    // Never run says what is stated and that none of it was judged — never a pass count of zero.
    expect(meterReading(tally(FIVE.map((c) => ({ ...c, verdict: 'UNDECIDED' as const }))), false)).toBe(
      '5 criteria stated, none judged',
    );
    expect(meterReading(tally([criterion(1, 'one', 'UNDECIDED')]), false)).toBe(
      '1 criterion stated, none judged',
    );
  });
});

describe('the standing sentence', () => {
  const NOW = Date.parse('2026-08-24T00:00:00.000Z');

  it('names the state rather than scoring it when no run has happened', () => {
    const line = standingLine({ total: 5, passed: 0, lastRunAt: null, criteria: [] }, NOW);
    expect(line).toContain('Never run — 5 criteria stated');
    expect(line).toContain('unknown, not zero');
    expect(line).not.toContain('0');
  });

  it('counts one criterion in the singular', () => {
    expect(standingLine({ total: 1, passed: 0, lastRunAt: null, criteria: [] }, NOW)).toContain(
      '1 criterion stated',
    );
  });

  it('says there is nothing to conclude when nothing is stated', () => {
    expect(standingLine({ total: 0, passed: 0, lastRunAt: null, criteria: [] }, NOW)).toBe(
      'No criteria are stated for this project, so there is nothing for a run to conclude.',
    );
  });

  it('leads with what is wrong once a run has concluded', () => {
    expect(standingLine({ total: 5, passed: 2, lastRunAt: RAN_AT, criteria: FIVE }, NOW)).toBe(
      'Judged 2427d ago — 1 failed, 1 inconclusive, 1 still unjudged.',
    );
  });

  it('says so plainly when a run found nothing wrong', () => {
    const allPass = FIVE.map((c) => ({ ...c, verdict: 'PASS' as const }));
    expect(standingLine({ total: 5, passed: 5, lastRunAt: RAN_AT, criteria: allPass }, NOW)).toBe(
      'Judged 2427d ago — every stated criterion passed.',
    );
  });
});

describe('criteriaPreview', () => {
  const many = Array.from({ length: 30 }, (_, i) => criterion(i + 1, `c${i}`, 'UNDECIDED'));

  it('shows the first page collapsed and everything expanded', () => {
    expect(criteriaPreview(many, false)).toHaveLength(CRITERIA_PREVIEW);
    expect(criteriaPreview(many, false)[0]).toEqual(many[0]);
    expect(criteriaPreview(many, true)).toHaveLength(30);
  });

  it('leaves a short list alone in both readings', () => {
    expect(criteriaPreview(FIVE, false)).toEqual(FIVE);
    expect(criteriaPreview(FIVE, true)).toEqual(FIVE);
  });

  it('accepts the smaller phone preview without changing the desktop default', () => {
    expect(criteriaPreview(many, false, MOBILE_CRITERIA_PREVIEW)).toEqual(
      many.slice(0, MOBILE_CRITERIA_PREVIEW),
    );
    expect(criteriaPreview(many, false)).toHaveLength(CRITERIA_PREVIEW);
  });
});
