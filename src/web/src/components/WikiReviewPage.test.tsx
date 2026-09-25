import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import type { WikiChangeset, WikiChangesetOp } from '@orbit/shared';
import { WikiReviewPage } from './WikiReviewPage';

// Nothing in these tests may reach the network: every read is answered from the query cache the
// fixture seeds, and a fetch that did happen would be a request this file has no server for. The
// real module is spread in first — the transcript's own helpers are imported by the components under
// test, and replacing the whole module would take those with it.
vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  api: () => new Promise(() => undefined),
}));

/**
 * Review, rendered from a fixture: one ADD, one AMEND and one RETIRE, which are the three cards the
 * design draws (mock 04).
 *
 * WHAT IS ASSERTED IS WHAT THE OWNER'S RULER NAMES: the three ops are three cards with the right
 * chips; the button row is `Accept · Edit · Reject` IN THAT ORDER with the primary on Accept, because
 * the primary-first rule and the phone's stacked column both read off the DOM order; a rejected
 * proposal must name one of the contract's four reasons; and a web-derived proposal says so, because
 * accepting it shows web text to agents.
 *
 * Rendered statically rather than driven: these are arrangements, and the arrangement is exactly what
 * a diff cannot keep honest.
 */

let counter = 0;
const id = (): string => `0196b000-0000-7000-8000-${String(++counter).padStart(12, '0')}`;

function op(over: Partial<WikiChangesetOp> = {}): WikiChangesetOp {
  return {
    id: id(),
    changesetId: 'changeset',
    seq: 0,
    op: 'add',
    entryId: null,
    baseRevision: null,
    payload: {},
    similar: [],
    tainted: false,
    decision: 'pending',
    decisionReason: null,
    decisionNote: null,
    resultEntryId: null,
    resultRevision: null,
    decidedAt: null,
    ...over,
  } as WikiChangesetOp;
}

function changeset(over: Partial<WikiChangeset> = {}): WikiChangeset {
  return {
    id: 'changeset',
    spaceId: 'space',
    origin: 'agent',
    sessionId: '0196b000-0000-7000-8000-00000000aaaa',
    toolCallId: null,
    rationale: 'Orbit wiki review',
    status: 'pending',
    createdAt: new Date(Date.now() - 12 * 60_000).toISOString(),
    decidedAt: null,
    expiresAt: new Date(Date.now() + 14 * 86_400_000).toISOString(),
    ops: [],
    ...over,
  } as WikiChangeset;
}

const ADD = op({
  op: 'add',
  payload: {
    entry: {
      kind: 'pitfall',
      title: 'Secret redaction lets ENV_VAR=value secrets through',
      summary: 'A watch delivery stores the value unredacted.',
      fields: {
        trigger: { paths: ['src/apiserver/src/watches/'], commands: [] },
        symptom: 'The value is stored in the delivery’s lastError',
        cause: 'The key pattern starts with a word boundary',
        fix: 'Let the key follow _ as well as a word boundary',
      },
      anchors: [{ type: 'path', path: 'src/apiserver/src/watches/watch-redaction.ts' }],
    },
    sources: [{ kind: 'turn', ref: 'self', quote: 'POSTGRES_PASSWORD=hunter2 => POSTGRES_PASSWORD=hunter2' }],
  },
});

const AMEND = op({
  op: 'amend',
  entryId: '0196b000-0000-7000-8000-00000000bbbb',
  baseRevision: 3,
  tainted: true,
  payload: {
    changes: { summary: 'Deploy apiserver and web' },
    sources: [{ kind: 'tool_call', ref: id(), quote: 'Refreshing the Postgres image is opt-in: --pull-base' }],
  },
});

const RETIRE = op({
  op: 'retire',
  entryId: '0196b000-0000-7000-8000-00000000cccc',
  baseRevision: 1,
  payload: { reason: 'Fix landed: wakeups are held by the server' },
});

const THREE: WikiChangeset[] = [
  changeset({ ops: [ADD] }),
  changeset({ id: 'changeset-two', ops: [AMEND] }),
  changeset({ id: 'changeset-three', ops: [RETIRE] }),
];

function paint(changesets: WikiChangeset[] = THREE): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['wiki', 'review', null], changesets);
  client.setQueryData(['wiki', 'spaces'], []);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <WikiReviewPage spaceSlug={null} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Review — one card per op', () => {
  it('draws the three ops the queue holds, each with its own chip', () => {
    const html = paint();
    expect(html).toContain('ADD');
    expect(html).toContain('AMEND');
    expect(html).toContain('RETIRE');
    expect(html).toContain('Secret redaction lets ENV_VAR=value secrets through');
    expect(html).toContain('Deploy apiserver and web');
    expect(html).toContain('Fix landed: wakeups are held by the server');
  });

  it('leads the action row with the primary, and puts Reject last', () => {
    const html = paint([changeset({ ops: [ADD] })]);
    const accept = html.indexOf('>Accept<');
    const edit = html.indexOf('>Edit<');
    const reject = html.indexOf('>Reject');
    expect(accept).toBeGreaterThan(-1);
    expect(edit).toBeGreaterThan(accept);
    expect(reject).toBeGreaterThan(edit);
    // Accept is the primary one, and it is the FIRST button in the row — which is what makes the
    // phone's stacked column put it on top (`@media (max-width: 600px) .card-actions`).
    expect(html).toContain('card-action card-action--primary">Accept');
  });

  it('keeps the record of what an agent proposed, and who to blame for it', () => {
    const html = paint([changeset({ ops: [ADD] })]);
    expect(html).toContain('Proposed by');
    expect(html).toContain('/sessions/0196b000-0000-7000-8000-00000000aaaa');
    expect(html).toContain('Accepting makes it Confirmed');
  });

  it('warns that a web-derived proposal was written after reading the web', () => {
    const html = paint([changeset({ id: 'changeset-two', ops: [AMEND] })]);
    expect(html).toContain('Web-derived');
    expect(html).toContain('this session read web pages before proposing');
    expect(html).toContain('Web-derived is never auto-accepted');
  });

  it('offers Retire and Keep — not Accept — for a retirement', () => {
    const html = paint([changeset({ id: 'changeset-three', ops: [RETIRE] })]);
    expect(html).toContain('card-action card-action--primary">Retire<');
    expect(html).toContain('>Keep<');
    expect(html).not.toContain('>Accept<');
    expect(html).toContain('Agents stop getting this entry');
  });

  it('says what an add differs from, and that it differs from nothing', () => {
    const html = paint([changeset({ ops: [ADD] })]);
    expect(html).toContain('Similar entries');
    expect(html).toContain('None');
    expect(html).toContain('compared with 0 entries');
  });

  it('counts the queue by the tab each op falls under', () => {
    const html = paint();
    // All 3, Add 1, Amend 1, Retire 1 — and the amend tab is where a supersede would be counted.
    expect(html).toContain('All<b>3</b>');
    expect(html).toContain('Add<b>1</b>');
    expect(html).toContain('Amend<b>1</b>');
    expect(html).toContain('Retire<b>1</b>');
  });

  it('says which two things never ask, and what always does', () => {
    const html = paint();
    expect(html).toContain('Auto-accept');
    expect(html).toContain('Reinforce');
    expect(html).toContain('Adds a source to an existing entry');
    expect(html).toContain('Challenge');
    expect(html).toContain('Always asks you');
  });

  it('says nothing is waiting rather than drawing an empty queue', () => {
    const html = paint([]);
    expect(html).toContain('Nothing is waiting for you.');
    expect(html).not.toContain('class="approval-card');
  });
});
