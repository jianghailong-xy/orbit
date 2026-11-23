// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ProjectOpenItemRow } from '@orbit/shared';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  DecisionStrip,
  type ExceptionCardPointer,
  type OwnerRequestCardPointer,
  type PendingDecisionQueue,
  type QuestionCardPointer,
} from './DecisionRail';

/**
 * A request this conversation filed for its owner on the pinned line (owner 2026-11-23,
 * docs/mocks/owner-request-strip-jump). The header said "Waiting on you" while the line said
 * nothing, and the card was a long scroll up.
 */

vi.mock('../api', () => ({ api: vi.fn() }));

const RELOAD: OwnerRequestCardPointer = {
  id: '352Rq0wnerReq0est00001',
  title: 'Reload the client to finish the profile run',
  ageSeconds: 21 * 60,
  above: true,
};
const KEY: OwnerRequestCardPointer = { id: '352Rq0wnerReq0est00002', title: 'Paste the staging key', ageSeconds: 60 };

const PAUSED: ExceptionCardPointer = {
  row: {
    itemId: '6fWujE4NBkVyzMWkL975oc',
    kind: 'FUSE_PAUSED',
    title: 'The coordinator paused itself',
    assigneeReason: 'DEFAULT',
    waitingSince: '2026-10-02T00:40:00.000Z',
    escalatedAt: null,
  } as ExceptionCardPointer['row'] & Pick<ProjectOpenItemRow, 'kind'>,
  ageSeconds: 3600,
  above: true,
};
const ASKED: QuestionCardPointer = { itemId: '34yQN4tOBrdOBqh7FajW9', question: 'Keep the old column?', ageSeconds: 7200 };

const queue = (): PendingDecisionQueue => ({
  decidingSessionId: '61DehW1OsRMagU5WxOb2yZ',
  count: 0,
  oldestAgeSeconds: null,
  pending: [],
  waitingOnYou: [],
});

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  document.body.innerHTML = '';
});

describe('an owner request on the pinned line', () => {
  it('names it by its card’s title, with its wait and the way up to it', () => {
    const html = renderToStaticMarkup(
      <DecisionStrip queue={queue()} open={false} onToggle={() => {}} ownerRequests={[RELOAD]} />,
    );
    expect(html).toContain(`<span class="decision-strip-title">${RELOAD.title}</span>`);
    expect(html).toContain('<span class="decision-strip-quiet">21m</span>');
    expect(html).toContain('<span class="decision-strip-caret" aria-hidden="true">↑</span>');
    expect(html).toContain(`aria-label="1 waiting: ${RELOAD.title}"`);
  });

  it('draws nothing when no request is pending and nothing else waits', () => {
    const html = renderToStaticMarkup(
      <DecisionStrip queue={queue()} open={false} onToggle={() => {}} ownerRequests={[]} />,
    );
    expect(html).toBe('');
  });

  it('goes after the exceptions and ahead of the questions, oldest request first', () => {
    const went: string[] = [];
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(
      <DecisionStrip
        queue={queue()}
        open={false}
        onToggle={() => {}}
        exceptions={[PAUSED]}
        questions={[ASKED]}
        ownerRequests={[KEY, RELOAD]}
        onRevealException={(row) => went.push(`exception:${row.itemId}`)}
        onRevealQuestion={(itemId) => went.push(`question:${itemId}`)}
        onRevealOwnerRequest={(id) => went.push(`request:${id}`)}
      />,
    ));
    const line = () => host!.querySelector<HTMLButtonElement>('.decision-strip-line')!;
    for (let i = 0; i < 4; i += 1) act(() => line().click());
    expect(went).toEqual([
      `exception:${PAUSED.row.itemId}`,
      `request:${RELOAD.id}`,
      `request:${KEY.id}`,
      `question:${ASKED.itemId}`,
    ]);
    expect(line().textContent).toContain('4 of 4');
  });
});
