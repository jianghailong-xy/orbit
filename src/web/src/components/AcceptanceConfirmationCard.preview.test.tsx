// @vitest-environment jsdom
import { QueryClient, QueryClientProvider, notifyManager } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import { acceptanceConfirmationKey, type StandardSetConfirmationStanding } from '../lib/acceptanceConfirmation';
import {
  ACCEPTANCE_CONFIRMATION_TITLE,
  ACCEPTANCE_CONFIRM_LABEL,
  CONFIRMATION_UNREAD_EXPLANATION,
  SessionAcceptanceConfirmationCard,
  acceptanceConfirmationStaleExplanation,
} from './AcceptanceConfirmationCard';

/**
 * The settlement confirmation card as a coordinator conversation draws it since the compact
 * previews: the preview in the conversation and the card itself in the review dialog, both the real
 * `ReviewCard`. `AcceptanceConfirmationCard.test.tsx` draws the card inline through
 * `test/inlineReviewCard`, so its "stale in place" is the form's; here it is what the reader sees
 * without opening anything. The preview had dropped it: the conversation went on offering
 * "3 criteria" to review after the set was confirmed at another end, while the strip had already
 * stopped counting the question.
 */

vi.mock('../api', () => ({ api: vi.fn() }));

const PROJECT = '34LWcmLItBx6ytdO26XXF';
const CURRENT = `4fc57753a6ec${'0'.repeat(52)}`;
const STANDING_PATH = `/projects/${PROJECT}/acceptance/confirmation`;

function standingOf(state: 'UNCONFIRMED' | 'CONFIRMED'): StandardSetConfirmationStanding {
  const material = [1, 2, 3].map((n) => ({ definitionId: `c${n}`, revision: 1, contentHash: `h${n}` }));
  return {
    state,
    confirmed: state === 'CONFIRMED',
    currentVersion: { digest: CURRENT, material },
    confirmation:
      state === 'CONFIRMED'
        ? { criteriaDigest: CURRENT, criteriaMaterial: material, confirmedAt: '2026-09-11T03:00:00.000Z', confirmedById: 'owner' }
        : null,
  };
}

/** A started project with work filed and a set nobody confirmed: the one this card is drawn for. */
const DOCUMENT = {
  title: 'move the confirmation to the start',
  status: 'OPEN',
  coordinatorEnabled: false,
  startedAt: '2026-09-10T08:00:00.000Z',
  _count: { tasks: 1 },
  acceptanceCriteriaItems: [1, 2, 3].map((n) => ({ id: `c${n}`, ordinal: n, text: `condition ${n} holds`, satisfied: false })),
};

const server: { standing: StandardSetConfirmationStanding | Error } = { standing: standingOf('UNCONFIRMED') };
/** Every press that reached the door. */
const presses: string[] = [];

let root: Root | null = null;
let conversation: HTMLDivElement | null = null;
let client: QueryClient | null = null;

beforeEach(() => {
  server.standing = standingOf('UNCONFIRMED');
  presses.length = 0;
  vi.mocked(api).mockImplementation((async (path: string, init?: { method?: string }) => {
    if (init?.method === 'POST') {
      presses.push(path);
      return standingOf('CONFIRMED');
    }
    if (path === STANDING_PATH) {
      return server.standing instanceof Error ? Promise.reject(server.standing) : server.standing;
    }
    if (path === `/projects/${PROJECT}`) return DOCUMENT;
    throw new Error(`nothing is stubbed at ${path}`);
  }) as unknown as typeof api);
});

afterEach(async () => {
  const mounted = root;
  root = null;
  if (mounted) await act(async () => mounted.unmount());
  conversation?.remove();
  conversation = null;
  await client?.cancelQueries();
  client?.clear();
  client = null;
  vi.mocked(api).mockReset();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

/** React Query hands every change on its own scheduler; a turn waits for one hand-off of its own. */
async function turn(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => notifyManager.schedule(() => resolve()));
  });
}

async function until(done: () => boolean, what: string): Promise<void> {
  for (let n = 0; n < 200 && !done(); n += 1) await turn();
  expect(done(), `waited for ${what}`).toBe(true);
}

async function mount(): Promise<{ node: HTMLElement; qc: QueryClient }> {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false }, mutations: { retry: false } },
  });
  client = qc;
  const node = document.createElement('div');
  document.body.appendChild(node);
  conversation = node;
  const tree = createRoot(node);
  root = tree;
  await act(async () => {
    tree.render(
      <QueryClientProvider client={qc}>
        <SessionAcceptanceConfirmationCard projectId={PROJECT} />
      </QueryClientProvider>,
    );
  });
  return { node, qc };
}

const previewsIn = (node: ParentNode): HTMLElement[] => [...node.querySelectorAll<HTMLElement>('#settlement-preview')];
const metaOf = (preview: HTMLElement): string => preview.querySelector('.review-card-meta')?.textContent ?? '';
const openReview = (): HTMLElement | null => document.querySelector<HTMLElement>('.review-card-dialog[data-open]');

describe('the settlement confirmation preview', () => {
  it.each<[string, () => void, string]>([
    [
      'the next read says the set was confirmed at another end',
      () => { server.standing = standingOf('CONFIRMED'); },
      acceptanceConfirmationStaleExplanation(standingOf('CONFIRMED'))!,
    ],
    [
      'a re-read fails',
      () => { server.standing = new Error('503 on the standing'); },
      CONFIRMATION_UNREAD_EXPLANATION,
    ],
  ])('goes stale in place when %s: the preview says why, unopened, and the review says the same over a dead button', async (_, change, why) => {
    const { node, qc } = await mount();
    await until(() => previewsIn(node).length === 1, 'the preview in the conversation');
    const [preview] = previewsIn(node);
    expect(preview!.querySelector('.review-card-title')?.textContent).toBe(ACCEPTANCE_CONFIRMATION_TITLE);
    expect(metaOf(preview!), 'a live card says what there is to review').toBe('3 criteria');
    expect(node.querySelector('.settlement-card'), 'the form is in the conversation, not in its review').toBeNull();

    change();
    await act(async () => {
      await qc.invalidateQueries({ queryKey: acceptanceConfirmationKey(PROJECT) });
    });
    await until(() => {
      const state = qc.getQueryState<StandardSetConfirmationStanding>(acceptanceConfirmationKey(PROJECT));
      return state?.fetchStatus === 'idle' && (state.status === 'error' || state.data?.state === 'CONFIRMED');
    }, 'the re-read to land');
    for (let n = 0; n < 5; n += 1) await turn();

    expect(previewsIn(node), 'the delivered card left the conversation').toHaveLength(1);
    expect(metaOf(previewsIn(node)[0]!), 'the preview still offers the set as a question').toBe(why);

    await act(async () => { previewsIn(node)[0]!.querySelector<HTMLButtonElement>('.review-card-preview')!.click(); });
    const review = openReview();
    expect(review, 'the preview opened no review').not.toBeNull();
    expect(review!.querySelector('.settlement-card-stale')?.textContent).toBe(why);
    const confirm = [...review!.querySelectorAll<HTMLButtonElement>('.settlement-card-actions button')]
      .find((button) => button.textContent?.includes(ACCEPTANCE_CONFIRM_LABEL))!;
    expect(confirm.disabled, 'a card nobody can answer still offers a confirmation').toBe(true);
    await act(async () => { confirm.click(); });
    expect(presses, 'a press on the stale card reached the door').toEqual([]);
  });
});
