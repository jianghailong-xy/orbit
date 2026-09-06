// @vitest-environment jsdom
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
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

// A blocked task is drawn as a link into the app, so the card now needs a router the way every
// other linking view on the project page does.
function paint(qc: QueryClient) {
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/projects/${PROJECT}`]}>
        <ProjectAcceptanceCard projectId={PROJECT} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/**
 * The stylesheet, with comments off. They come off first because a rule must not be satisfied by
 * a sentence describing it — "a 2px ring" in prose beside a rule reads as `2px` to a regex.
 *
 * Both path spellings, because the web suite runs from `src/web` and a runner may start at the
 * repository root.
 */
function loadCss(): string {
  const found = ['src/index.css', 'src/web/src/index.css']
    .map((each) => resolve(process.cwd(), each))
    .find(existsSync);
  if (found === undefined) throw new Error(`no index.css from ${process.cwd()}`);
  return readFileSync(found, 'utf8').replace(/\/\*[\s\S]*?\*\//gu, '');
}

/**
 * One rule out of the stylesheet, by exact selector, so an assertion about a mark's SHAPE is about
 * the shape and not about the class name that was supposed to carry it — jsdom computes none of
 * this.
 */
function styleRule(selector: string, css: string = loadCss()): string {
  const rule = new RegExp(`(?:^|[},])\\s*${selector.replace(/[.]/gu, '\\.')}\\s*\\{([^{}]*)\\}`, 'u')
    .exec(css);
  if (rule === null) throw new Error(`no rule for "${selector}" in index.css`);
  return rule[1];
}

/**
 * The body of the `@media (max-width: 560px)` block the acceptance rules live in, so a rule
 * asserted about a narrow screen is read out of the phone's stylesheet and not the desktop's.
 * Found by brace matching rather than by regex: the file has several blocks on this breakpoint
 * and only one of them draws the criteria rows.
 */
function phoneCss(): string {
  const css = loadCss();
  const query = `@media (${ACCEPTANCE_PHONE_QUERY.replace(/^\(|\)$/gu, '')}) {`;
  for (let at = css.indexOf(query); at !== -1; at = css.indexOf(query, at + 1)) {
    let depth = 0;
    for (let i = at + query.length - 1; i < css.length; i += 1) {
      if (css[i] === '{') depth += 1;
      else if (css[i] === '}' && (depth -= 1) === 0) {
        const body = css.slice(at + query.length, i);
        if (body.includes('.acceptance-row-no')) return body;
        at = i;
        break;
      }
    }
  }
  throw new Error('no acceptance block on the phone breakpoint in index.css');
}

/** How many pixels tall the rule says its target is at least. */
function minHeightPx(rule: string): number {
  const found = /min-height:\s*(\d+(?:\.\d+)?)px/u.exec(rule);
  if (found === null) throw new Error(`no min-height in "${rule.trim()}"`);
  return Number(found[1]);
}

/** What the row's one mark has inside it, exactly as rendered. */
function markContent(row: string): string {
  const found = /<span class="acceptance-row-no[^"]*">([\s\S]*?)<\/span>/u.exec(row);
  if (found === null) throw new Error('no mark rendered in row');
  return found[1];
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
        <MemoryRouter initialEntries={[`/projects/${PROJECT}`]}>
          <ProjectAcceptanceCard projectId={PROJECT} />
        </MemoryRouter>
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
    const numbers = [...html.matchAll(/class="acceptance-row-no[^"]*">(\d+)</g)].map((m) => m[1]);
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
        <MemoryRouter initialEntries={[`/projects/${PROJECT}`]}>
          <ProjectAcceptanceCard projectId={PROJECT} action={<button type="button">Edit</button>} />
        </MemoryRouter>
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
/** What the owner wrote beside a criterion about how anybody would know it holds. Long enough
 *  that a card printing all of them inline would double the height of every row, which is why it
 *  is folded away — and why "folded" has to mean absent rather than merely out of sight. */
const METHOD = 'Read the project document back and check each criterion carries its own answer.';

const MET_CRITERION: AcceptanceCriterionItem = {
  ...criterion(1, 'The project read serves each criterion its satisfaction'),
  satisfied: true,
  unmet: [],
  landing: 'LANDED',
  verificationMethod: METHOD,
};

/** Met by its work, with nothing putting that work on the default branch. This is the row the
 *  whole landing lane exists for: settled and landed are different facts, and a card that let
 *  them look the same would be hiding exactly the false green it was built to expose. */
const MET_UNRECEIPTED_CRITERION: AcceptanceCriterionItem = {
  ...criterion(2, 'Settling a task and landing its code are separate facts'),
  satisfied: true,
  unmet: [],
  landing: 'UNKNOWN',
  verificationMethod: null,
};

const HELD_UP_CRITERION: AcceptanceCriterionItem = {
  // Carries a landing the card is expected to WITHHOLD: a reader whose criterion is still open is
  // not asking where the unfinished work merged to, so the silence below has to be a decision
  // rather than an absence in the fixture.
  ...criterion(3, 'A reader can see what is holding a criterion open'),
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
        // A code a newer server knows and this build does not — a browser held open across a
        // deploy is how that arrives, and it must not be dropped on the floor.
        { taskId: 't-4', title: 'Something a later server added', requiredAction: 'AWAIT_THE_NEXT_THING' },
      ],
    },
  ],
};

/** A criterion this read did not answer for: no `satisfied`, so no `unmet` and no `landing`
 *  either. It is the third state and it is NOT a "no" — an older server's document renders like
 *  this too, and so does any criterion the read could not reach. */
const UNANSWERED_CRITERION: AcceptanceCriterionItem =
  criterion(4, 'A criterion this read did not answer for');

const DERIVED = [
  MET_CRITERION, MET_UNRECEIPTED_CRITERION, HELD_UP_CRITERION, UNANSWERED_CRITERION,
];

describe('ProjectAcceptanceCard on what the work has done', { timeout: 20_000 }, () => {
  it('draws its three states as three shapes before it uses any colour', () => {
    const qc = client();
    seed(qc, DERIVED);

    const html = paint(qc);
    const met = rowFor(html, 'The project read serves each criterion its satisfaction');
    const open = rowFor(html, 'A reader can see what is holding a criterion open');
    const silent = rowFor(html, UNANSWERED_CRITERION.text);

    // ONE mark per row, and it is the number. The separate dot is gone: on a phone the number is
    // a 36px disc, so a 10px dot beside it put the meaningless circle at 3.6x the size of the
    // meaningful one and the dot was read as a bullet.
    for (const row of [met, open, silent]) {
      expect((row.match(/acceptance-row-no/gu) ?? [])).toHaveLength(1);
      expect(row).not.toContain('acceptance-dot');
    }
    expect(met).toContain('class="acceptance-row-no is-met"');
    expect(open).toContain('class="acceptance-row-no is-unmet"');
    expect(silent).toContain('class="acceptance-row-no is-unanswered"');
    // Nothing about the distinction rides on an inline colour, and no mark can pass for another
    // once one is stripped out.
    expect(withoutColour(met)).toContain('is-met');
    expect(withoutColour(met)).not.toContain('is-unmet');
    expect(withoutColour(open)).toContain('is-unmet');
    expect(withoutColour(silent)).toContain('is-unanswered');

    // And what the stylesheet draws for them is FILL and STROKE, which survive greyscale and
    // colour blindness. Three classes differing only in `color` would satisfy every assertion
    // above and none of the reason for them.
    const met_ = styleRule('.acceptance-row-no.is-met');
    const unmet_ = styleRule('.acceptance-row-no.is-unmet');
    const silent_ = styleRule('.acceptance-row-no.is-unanswered');
    // Met: a filled disc, its number knocked out of the fill rather than set on top of it.
    expect(met_).toMatch(/background:\s*var\(--success\)/u);
    expect(met_).toMatch(/color:\s*var\(--bg-base\)/u);
    // Unmet: a solid ring around nothing.
    expect(unmet_).toMatch(/border:\s*2px solid/u);
    expect(unmet_).toMatch(/background:\s*transparent/u);
    // No answer is not "the answer is no". A dashed ring, never the unmet ring.
    expect(silent_).toMatch(/border:\s*1px dashed/u);
    expect(silent_).toMatch(/background:\s*transparent/u);
    expect(silent_).not.toMatch(/border:[^;]*solid/u);

    // Pairwise, on the two properties that are not hue: three different strokes, and exactly one
    // of the three is filled.
    const declaration = (rule: string, property: string) => {
      const found = new RegExp(`${property}:\\s*([^;]+);`, 'u').exec(rule);
      if (found === null) throw new Error(`no ${property} in "${rule.trim()}"`);
      return found[1];
    };
    const strokes = [met_, unmet_, silent_]
      .map((rule) => declaration(rule, 'border').replace(/var\([^)]*\)/gu, '').trim());
    expect(new Set(strokes).size).toBe(3);
    const fills = [met_, unmet_, silent_].map((rule) => declaration(rule, 'background'));
    expect(fills.filter((fill) => fill === 'transparent')).toHaveLength(2);
  });

  it('has no separate status dot left, in the markup or in the stylesheet', () => {
    const qc = client();
    seed(qc, DERIVED);

    expect(paint(qc)).not.toContain('acceptance-dot');
    // Nor left behind as a rule. Dead CSS for a mark nothing renders is the next reader's
    // evidence that the dot is still part of this design.
    expect(loadCss()).not.toContain('acceptance-dot');
    for (const gone of ['.acceptance-dot', '.acceptance-dot.is-met', '.acceptance-dot.is-unmet']) {
      expect(() => styleRule(gone)).toThrow();
    }
  });

  it('puts nothing but the ordinal inside the mark', () => {
    const qc = client();
    seed(qc, DERIVED);

    const html = paint(qc);
    for (const item of DERIVED) {
      expect(markContent(rowFor(html, item.text))).toBe(String(item.ordinal));
    }
    // A tick in the met circle would make it the verdict badge 0229 deleted. The mark says WHICH
    // criterion; the row says, in words, what that criterion's work has done.
    const marks = (html.match(/<span class="acceptance-row-no[^"]*">[\s\S]*?<\/span>/gu) ?? [])
      .join('');
    expect(marks).not.toBe('');
    for (const symbol of ['\u2713', '\u2714', '\u2717', '\u2718', '\u00d7', '!', '?']) {
      expect(marks).not.toContain(symbol);
    }
  });

  it('leaves no orphaned separator where the landing half wraps on a narrow screen', () => {
    const qc = client();
    seed(qc, DERIVED);

    // The separator is drawn by the desktop rule and by nothing else: the markup itself never
    // carries one, so switching that rule off at the breakpoint removes it outright.
    const row = rowFor(paint(qc), 'The project read serves each criterion its satisfaction');
    expect(row).toContain('landed on the default branch');
    expect(row).not.toContain('\u00b7');
    expect(styleRule('.acceptance-landing::before')).toMatch(/content:\s*'\u00b7 '/u);

    // Narrow, that half wraps whatever it is given. It takes a line of its own and drops the
    // dot, rather than starting the new line with a separator joining it to nothing above.
    const phone = phoneCss();
    expect(styleRule('.acceptance-landing::before', phone)).toMatch(/content:\s*none/u);
    expect(styleRule('.acceptance-landing', phone)).toMatch(/flex-basis:\s*100%/u);
  });

  it("gives How it's checked a target big enough to press", () => {
    // A 10px triangle beside 12px text is a 15px-high target drawn as decoration and read as
    // decoration. 24px is the floor everywhere, and the phone gives it more.
    expect(minHeightPx(styleRule('.acceptance-method-toggle'))).toBeGreaterThanOrEqual(24);
    expect(minHeightPx(styleRule('.acceptance-method-toggle', phoneCss())))
      .toBeGreaterThanOrEqual(24);
    // And it reads as something to press before anybody has hovered it.
    expect(styleRule('.acceptance-method-toggle')).toMatch(/text-decoration:\s*underline/u);
  });

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

  it('says where met work is, and says nothing about it on a criterion still open', () => {
    const qc = client();
    seed(qc, DERIVED);

    const html = paint(qc);
    // A met row carries both halves: the state and where that work went.
    const met = rowFor(html, 'The project read serves each criterion its satisfaction');
    expect(met).toContain('Met by its work');
    expect(met).toContain('landed on the default branch');

    // The open row's fixture HAS a landing. Withholding it is the decision under test: a reader
    // whose criterion is not met is not asking where the unfinished work merged to, and printing
    // it put a second sentence on the row that had nothing to do with why it was open.
    const open = rowFor(html, 'A reader can see what is holding a criterion open');
    expect(open).toContain('Not met by its work');
    expect(open).not.toContain('acceptance-landing');
    for (const half of ['landed on the default branch', 'no merge receipt either way']) {
      expect(open).not.toContain(half);
    }
  });

  it('gives met work with no receipt behind it more weight than met work that landed', () => {
    const qc = client();
    seed(qc, DERIVED);

    const html = paint(qc);
    // Both are printed — the difference between settled and landed cannot be expressed by
    // silence — but they are not printed at the same weight.
    const landed = rowFor(html, 'The project read serves each criterion its satisfaction');
    const unreceipted = rowFor(html, 'Settling a task and landing its code are separate facts');
    expect(landed).toContain('class="acceptance-landing"');
    expect(landed).not.toContain('is-flagged');
    expect(unreceipted).toContain('class="acceptance-landing is-flagged"');
    expect(unreceipted).toContain('no merge receipt either way');
    // The emphasis is real and not just a spare class name: the flagged half comes up to full
    // text colour while the ordinary one stays receded.
    expect(styleRule('.acceptance-landing')).toMatch(/color:\s*var\(--text-2\)/);
    expect(styleRule('.acceptance-landing.is-flagged')).toMatch(/color:\s*var\(--text-1\)/);

    // The value the lane refuses to produce may not be invented by the drawing either: no receipt
    // is no evidence, and work lands without leaving one.
    for (const lie of ['Not landed', 'NOT_LANDED', 'not merged', 'Unmerged']) {
      expect(html).not.toContain(lie);
    }
  });

  it('makes every blocked task openable and says what it needs in words', () => {
    const qc = client();
    seed(qc, DERIVED);

    const row = rowFor(paint(qc), 'A reader can see what is holding a criterion open');
    const reasons = unmetReasons(row);

    // EVERY named task is a link, not just the first: knowing which task is holding a criterion
    // open and having no way to open it is the whole of what this line was failing to do.
    const named = (row.match(/class="acceptance-held-up"/g) ?? []).length;
    const links = (row.match(/<a [^>]*href="\/tasks\/[^"]+"/g) ?? []).length;
    expect(named).toBe(4);
    expect(links).toBe(named);
    expect(reasons[0]).toContain('href="/tasks/t-1"');
    expect(reasons[0]).toContain('href="/tasks/t-2"');
    expect(reasons[1]).toContain('href="/tasks/t-3"');

    // What each one needs, as a sentence. The code is a completion-refusal token and reads as
    // one; nobody opening a project page agreed to learn that vocabulary.
    expect(accessibleText(reasons[0])).toContain('needs its acceptance command to run');
    expect(accessibleText(reasons[0])).toContain('needs an independent verification pass');
    expect(accessibleText(reasons[1]))
      .toContain('needs evidence submitted, then an independent decision');
    expect(accessibleText(reasons[0])).not.toContain('RUN_ACCEPTANCE_COMMAND');

    // Kept, not discarded: a reader matching this row against an API response still has the code.
    expect(reasons[0]).toContain('title="RUN_ACCEPTANCE_COMMAND"');
    expect(reasons[0]).toContain('title="OBTAIN_INDEPENDENT_VERIFICATION_PASS"');
    expect(reasons[1]).toContain('title="SUBMIT_EVIDENCE_AND_AWAIT_INDEPENDENT_DECISION"');

    // A code this build does not recognise prints as itself rather than vanishing — the same
    // treatment an unknown clause already gets. Dropping it would say the task needs nothing.
    expect(accessibleText(reasons[1])).toContain('AWAIT_THE_NEXT_THING');
  });

  it("folds the owner's verification method away until it is asked for", async () => {
    const qc = client();
    seed(qc, DERIVED);

    // Collapsed means ABSENT. Fifty-three methods sitting in the document behind a shut twisty is
    // fifty-three criteria rendered twice over.
    const html = paint(qc);
    expect(html).toMatch(/How it(?:&#x27;|')s checked/);
    expect(html).not.toContain(METHOD);
    // And a criterion whose author left the method unanswered offers nothing to open.
    expect(rowFor(html, 'Settling a task and landing its code are separate facts')).not.toContain('acceptance-method');

    const { container, cleanup } = await mount(qc);
    try {
      expect(container.textContent).not.toContain(METHOD);
      const toggle = container.querySelector<HTMLButtonElement>('.acceptance-method-toggle');
      expect(toggle).not.toBeNull();
      expect(toggle!.getAttribute('aria-expanded')).toBe('false');

      await click(toggle!);
      expect(toggle!.getAttribute('aria-expanded')).toBe('true');
      expect(container.textContent).toContain(METHOD);
    } finally {
      await cleanup();
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

  it('says nothing about work the read did not answer for, and marks the row as unanswered', () => {
    const qc = client();
    seed(qc, [criterion(1, 'The runner reconnects after a restart')]);

    const html = paint(qc);
    expect(html).toContain('The runner reconnects after a restart');
    expect(html).not.toContain('acceptance-work');
    expect(html).not.toContain('Met by its work');
    // The row still has its mark — it is the number, and every row has one — but the mark says
    // the read declined to answer. Drawing it as unmet would be this file inventing the answer.
    expect(html).toContain('class="acceptance-row-no is-unanswered"');
    expect(html).not.toContain('is-unmet');
    expect(html).not.toContain('acceptance-dot');
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
