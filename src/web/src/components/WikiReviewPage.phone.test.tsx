import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import type { WikiChangeset, WikiChangesetOp } from '@orbit/shared';
import { WikiReviewPage } from './WikiReviewPage';

/**
 * Review on a phone: one card at a time, with the position and two plain buttons to move between them
 * (design §12.1, mock 09).
 *
 * WHAT IT IS FOR: a phone has no room for a queue and no hover to reveal one, and iOS pages the same
 * way — so this is the half of the pair that says the two clients read as one product. What must not
 * change with it is the card itself: the action row is still `Accept · Edit · Reject`, still primary
 * first, and the app's own 600px rule stacks it full-width.
 *
 * `window` is stubbed BEFORE the imports are evaluated, because the width is read while the first
 * render happens (`useMediaQuery`), not after it.
 */
vi.hoisted(() => {
  const noop = (): void => undefined;
  vi.stubGlobal('window', {
    matchMedia: () => ({ matches: true, addEventListener: noop, removeEventListener: noop }),
    addEventListener: noop,
    removeEventListener: noop,
    location: { host: 'localhost', origin: 'http://localhost' },
  });
});

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  api: () => new Promise(() => undefined),
}));

let counter = 0;
const id = (): string => `0196b100-0000-7000-8000-${String(++counter).padStart(12, '0')}`;

function op(over: Partial<WikiChangesetOp> = {}): WikiChangesetOp {
  return {
    id: id(),
    changesetId: 'changeset',
    seq: 0,
    op: 'add',
    entryId: null,
    baseRevision: null,
    payload: { entry: { kind: 'pitfall', title: 'A proposal', fields: {}, anchors: [] } },
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

function changeset(ops: WikiChangesetOp[], index: number): WikiChangeset {
  return {
    id: `changeset-${index}`,
    spaceId: 'space',
    origin: 'agent',
    sessionId: null,
    toolCallId: null,
    rationale: 'a session',
    status: 'pending',
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    decidedAt: null,
    expiresAt: null,
    ops,
  } as WikiChangeset;
}

function paint(ops: WikiChangesetOp[]): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['wiki', 'review', null], ops.map((one, index) => changeset([one], index)));
  client.setQueryData(['wiki', 'spaces'], []);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <WikiReviewPage spaceSlug={null} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Review on a phone', () => {
  it('shows one card, its position, and the two buttons that move it', () => {
    const html = paint([
      op({ payload: { entry: { kind: 'pitfall', title: 'The first proposal', fields: {} } } }),
      op({ payload: { entry: { kind: 'pitfall', title: 'The second proposal', fields: {} } } }),
      op({ payload: { entry: { kind: 'pitfall', title: 'The third proposal', fields: {} } } }),
    ]);
    expect(html).toContain('1 of 3');
    expect(html).toContain('<span>Previous</span>');
    expect(html).toContain('<span>Next</span>');
    // One card at a time: the queue's first is drawn and the other two are not.
    expect(html).toContain('The first proposal');
    expect(html).not.toContain('The second proposal');
    expect(html).not.toContain('The third proposal');
    // And the card itself is unchanged: the primary first, in an action row the app's own 600px rule
    // turns into a full-width column.
    expect(html.indexOf('>Accept<')).toBeGreaterThan(-1);
    expect(html.indexOf('>Accept<')).toBeLessThan(html.indexOf('>Edit<'));
    expect(html).toContain('card-actions approval-actions');
  });

  it('draws no pager when there is nothing to page through', () => {
    const html = paint([op({ payload: { entry: { kind: 'pitfall', title: 'The only proposal', fields: {} } } })]);
    expect(html).not.toContain('1 of 1');
    expect(html).not.toContain('wk-pager');
    expect(html).toContain('The only proposal');
  });
});
