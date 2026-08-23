// @vitest-environment jsdom
import type { ReactElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectBlockingLeaderboard, percentOfTrack } from './ProjectBlockingLeaderboard';

// The rest of this suite renders with `react-dom/server`, which cannot press a button — the card's
// whole point of variation is a toggle, so this file mounts into a real DOM instead. jsdom is a dev
// dependency of @orbit/web for exactly this, selected per file by the docblock above; every other
// test file keeps running in node.
vi.mock('../api', () => ({ api: vi.fn() }));
const { api } = await import('../api');
const apiMock = vi.mocked(api);

const ITEM = (title: string, downstreamBlocked: number, i: number) => ({
  taskId: `task-${i}`,
  title,
  status: 'OPEN',
  downstreamBlocked,
});

/** The shape the endpoint answers with, at the numbers this project's real data produces. */
const RANKING = {
  remainingCount: 34,
  items: [
    ITEM('Backend: blocking-root endpoint', 30, 1),
    ITEM('Backend: panorama buckets', 27, 2),
    ITEM('Web: topological task list', 26, 3),
    ITEM('Web: coordinator activity feed', 25, 4),
    ITEM('Assembly: wire the panorama cards', 24, 5),
  ],
  truncated: null,
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  apiMock.mockReset();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function mount(node: ReactElement): Promise<void> {
  const client = new QueryClient({
    // A failed read has to reach the card's error branch on the first answer, not after three
    // silent retries — the assertion below is about what a reader sees when this endpoint is down.
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
  });
  // React Query delivers an answered query on a macrotask, so a microtask flush would leave every
  // assertion below looking at the spinner. The in-flight test flushes too and still sees one.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const bars = () => Array.from(container.querySelectorAll<HTMLElement>('[data-testid="blocking-bar"]'));

/** The one button the card carries, found the way a reader finds it — by its label. */
function tableToggle(): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === 'Table view',
  );
  if (!button) throw new Error('the Table view toggle is not on the card');
  return button;
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

describe('ProjectBlockingLeaderboard', () => {
  it('measures every bar against all remaining tasks, not against the leader', async () => {
    apiMock.mockResolvedValue(RANKING);
    await mount(<ProjectBlockingLeaderboard projectId="p1" />);

    // 30 of 34 remaining — 88.2%, not the 100% a ranking normalized to its own top row would draw.
    // This is the assertion the card exists for: a bar length that means something in absolute
    // terms. The tolerance is 1 percentage point, well inside the 11.8 that separates the two
    // denominators.
    expect(parseFloat(bars()[0].style.width)).toBeCloseTo((30 / 34) * 100, 0);
    expect(parseFloat(bars()[0].style.width)).toBeLessThan(100);
    // ...and the rest of the ranking with it, so the check cannot be passed by scaling the top row
    // alone. 24/34 = 70.6%, which normalizing to the leader would have drawn at 80%.
    expect(parseFloat(bars()[4].style.width)).toBeCloseTo((24 / 34) * 100, 0);
    expect(percentOfTrack(30, 34)).toBeCloseTo(88.24, 1);

    expect(apiMock).toHaveBeenCalledWith('/projects/p1/panorama/blocking?limit=5');
  });

  it('shows all five titles and all five counts as readable text', async () => {
    apiMock.mockResolvedValue(RANKING);
    await mount(<ProjectBlockingLeaderboard projectId="p1" />);

    const text = container.textContent ?? '';
    for (const item of RANKING.items) {
      expect(text).toContain(item.title);
      expect(text).toContain(String(item.downstreamBlocked));
    }
    expect(bars()).toHaveLength(5);
    // The track the lengths are read against is stated, not left to be inferred from the bars.
    expect(text).toContain('track = all 34 remaining');
    // A single series carries its magnitude in length; the footnote says the counts are the
    // transitive closure rather than the direct edges.
    expect(text).toContain('transitive closure');
  });

  it('swaps the bars for a table and back on the same control', async () => {
    apiMock.mockResolvedValue(RANKING);
    await mount(<ProjectBlockingLeaderboard projectId="p1" />);

    expect(container.querySelector('table')).toBeNull();
    expect(tableToggle().getAttribute('aria-pressed')).toBe('false');

    await click(tableToggle());

    const table = container.querySelector('table');
    expect(table).not.toBeNull();
    expect(tableToggle().getAttribute('aria-pressed')).toBe('true');
    const rows = Array.from(table!.querySelectorAll('tbody tr'));
    expect(rows).toHaveLength(5);
    // Same numbers as the bars, in the same order — the table is the copyable form of this
    // ranking, not a second query that could disagree with it.
    expect(rows.map((r) => r.querySelectorAll('td')[1].textContent)).toEqual(
      RANKING.items.map((i) => String(i.downstreamBlocked)),
    );
    expect(rows.map((r) => r.querySelectorAll('td')[0].textContent)).toEqual(
      RANKING.items.map((i) => i.title),
    );
    expect(bars()).toHaveLength(0);
    // Column headings exist and the numbers are right-aligned, which is what makes a column of
    // counts scannable.
    expect(table!.textContent).toContain('Downstream blocked');
    expect((rows[0].querySelectorAll('td')[1] as HTMLElement).style.textAlign).toBe('right');

    await click(tableToggle());

    expect(container.querySelector('table')).toBeNull();
    expect(bars()).toHaveLength(5);
    expect(tableToggle().getAttribute('aria-pressed')).toBe('false');
  });

  it('says a project has no blocking at all rather than drawing an empty card', async () => {
    apiMock.mockResolvedValue({ remainingCount: 7, items: [], truncated: null });
    await mount(<ProjectBlockingLeaderboard projectId="p1" />);

    expect(bars()).toHaveLength(0);
    expect(container.querySelector('table')).toBeNull();
    expect(container.textContent).toContain('Nothing here waits on anything else');
  });

  it('treats a non-array blocking list as empty', async () => {
    apiMock.mockResolvedValue({ remainingCount: 7, items: {}, truncated: null });
    await mount(<ProjectBlockingLeaderboard projectId="p1" />);

    expect(bars()).toHaveLength(0);
    expect(container.textContent).toContain('Nothing here waits on anything else');
  });

  it('renders while the ranking is in flight', async () => {
    apiMock.mockReturnValue(new Promise(() => {}));
    await mount(<ProjectBlockingLeaderboard projectId="p1" />);

    expect(container.querySelector('.ant-spin')).not.toBeNull();
    expect(bars()).toHaveLength(0);
    // No number is claimed before one has been read — an empty state here would be a lie about a
    // project whose ranking simply has not landed.
    expect(container.textContent).not.toContain('Nothing here waits on anything else');
  });

  it('keeps its own failure to itself instead of throwing', async () => {
    apiMock.mockRejectedValue(new Error('Internal server error'));
    await mount(<ProjectBlockingLeaderboard projectId="p1" />);

    expect(container.textContent).toContain('The blocking ranking could not be read');
    expect(container.textContent).toContain('Internal server error');
    expect(bars()).toHaveLength(0);
    // The card is still a card: the page that composes five of these keeps its heading.
    expect(container.textContent).toContain('Unblocks the most work');
  });

  it('states that a ranking was skipped rather than showing it as no blocking', async () => {
    // The server refuses the closure on a project too large to walk and says so in the body; an
    // empty ranking drawn from that answer would read as "nothing blocks anything" on the one
    // project where the most does.
    apiMock.mockResolvedValue({
      remainingCount: 2400,
      items: [],
      truncated: { reason: 'TOO_MANY_UNFINISHED_TASKS', maxTasks: 2000 },
    });
    await mount(<ProjectBlockingLeaderboard projectId="p1" />);

    expect(container.textContent).toContain('Ranking not computed');
    expect(container.textContent).toContain('2000');
    expect(container.textContent).not.toContain('Nothing here waits on anything else');
    expect(bars()).toHaveLength(0);
  });
});
