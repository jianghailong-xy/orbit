// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastViewport } from '../components/ToastViewport';
import { useToast } from './toast';
import { clearToasts } from './toastStore';

/**
 * Every toast says what happened to what, and what it asks of you decides its shape
 * (docs/mocks/toast-system): a confirmation is a pill, a result with an Undo is a card, a failure is
 * a tinted card that stays — driven through the real viewport, because that is what the owner reads.
 */

const toast = useToast();
// A session id as the server spells it: the viewport encodes it into the route.
const SESSION = '0196b000-0000-7000-8000-000000000001';

let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<p className="where">home</p>} />
          <Route path="/sessions/:id" element={<p className="where">session</p>} />
        </Routes>
        <ToastViewport />
      </MemoryRouter>,
    );
  });
});

afterEach(async () => {
  await act(async () => {
    clearToasts();
    root.unmount();
  });
  container.remove();
  vi.useRealTimers();
});

const viewport = (): HTMLElement | null => document.querySelector('.toast-viewport');
const toasts = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('.toast')];

describe('a toast says what happened to what', () => {
  it('draws a confirmation as a pill with the thing it happened to under the outcome', async () => {
    await act(async () => {
      toast.success('Accepted', 'Use pnpm for workspace installs');
    });
    const [pill] = toasts();
    expect(pill.classList.contains('toast--pill')).toBe(true);
    expect(pill.querySelector('.toast-head')?.textContent).toBe('Accepted');
    expect(pill.querySelector('.toast-sub')?.textContent).toBe('Use pnpm for workspace installs');
    // A pill that names nothing takes no clicks: it floats over the header's controls.
    expect(pill.classList.contains('toast--live')).toBe(false);
  });

  it("pins a failure as a tinted card, the server's words in their own block", async () => {
    await act(async () => {
      toast.error("Couldn't save the schedule", 'revision 12 is stale');
    });
    const [card] = toasts();
    expect(card.classList.contains('toast--attention')).toBe(true);
    expect(card.classList.contains('toast--error')).toBe(true);
    expect(card.querySelector('.toast-head')?.textContent).toBe("Couldn't save the schedule");
    expect(card.querySelector('.toast-reason')?.textContent).toBe('revision 12 is stale');
    expect(card.querySelector('button[aria-label="Dismiss"]')).not.toBeNull();
    expect([...card.querySelectorAll('button')].map((b) => b.textContent)).toContain('Copy error');
  });

  it('keeps a failure on screen when later toasts arrive, above them', async () => {
    await act(async () => {
      toast.error("Couldn't merge into main", 'CONFLICT (content): Merge conflict in src/app.ts');
      toast.success('Link copied');
    });
    expect(toasts().map((one) => one.querySelector('.toast-head')?.textContent)).toEqual([
      "Couldn't merge into main",
      'Link copied',
    ]);
  });

  it('lets a confirmation go after three seconds, and a failure stay until its ×', async () => {
    vi.useFakeTimers();
    await act(async () => {
      toast.error("Couldn't save the schedule", 'revision 12 is stale');
      toast.success('Link copied');
    });
    await act(async () => {
      vi.advanceTimersByTime(3100);
    });
    expect(toasts().map((one) => one.querySelector('.toast-head')?.textContent)).toEqual([
      "Couldn't save the schedule",
    ]);
    await act(async () => {
      document.querySelector<HTMLButtonElement>('button[aria-label="Dismiss"]')!.click();
    });
    expect(viewport()).toBeNull();
  });

  it('draws a bare headline when the line would add nothing', async () => {
    await act(async () => {
      toast.error("Couldn't save the schedule", '   ');
      toast.info('Moved to Open', 'Moved to Open');
    });
    expect(document.querySelector('.toast-reason')).toBeNull();
    expect(document.querySelector('.toast-sub')).toBeNull();
  });

  it("hands nothing back for a mutation's onError to wait on", () => {
    // AntD's handle settled only when the toast closed, and an error toast never closes on its own:
    // returned from `onError: (e) => toast.error(…)`, TanStack Query waited on it and the mutation's
    // button span until someone clicked ×.
    expect(toast.error("Couldn't rename the runner", 'name taken')).toBeUndefined();
    expect(toast.success('Runner renamed')).toBeUndefined();
  });

  it('reads the line out after the headline', async () => {
    await act(async () => {
      toast.error("Couldn't save the schedule", 'revision 12 is stale');
    });
    await vi.waitFor(() =>
      expect(document.querySelector('.sr-only[aria-live="assertive"]')?.textContent).toBe(
        "Couldn't save the schedule. revision 12 is stale",
      ),
    );
  });
});

describe('a session result', () => {
  it('carries Undo as a card, and opens its session from the copy', async () => {
    const onUndo = vi.fn();
    await act(async () => {
      toast.sessionAction({ sessionId: SESSION, sessionTitle: 'Fix login redirect', action: 'complete', onUndo });
    });
    const [card] = toasts();
    expect(card.classList.contains('toast--card')).toBe(true);
    expect(card.querySelector('.toast-head')?.textContent).toBe('Session completed');
    expect(card.querySelector('.toast-sub')?.textContent).toBe('Fix login redirect');
    await act(async () => {
      card.querySelector<HTMLButtonElement>('button[aria-label="Undo completing Fix login redirect"]')!.click();
    });
    expect(onUndo).toHaveBeenCalledOnce();
    expect(viewport()).toBeNull();
  });

  it('is a pill you click through to the session when there is nothing else to do', async () => {
    await act(async () => {
      toast.sessionNotice({ sessionId: SESSION, sessionTitle: 'Fix login redirect', event: 'merge-result', headline: 'Merged into main' });
    });
    const [pill] = toasts();
    expect(pill.classList.contains('toast--pill')).toBe(true);
    await act(async () => {
      pill.click();
    });
    expect(document.querySelector('.where')?.textContent).toBe('session');
    expect(viewport()).toBeNull();
  });

  it("puts the operation's next result where its last one stood, and clears its failure", async () => {
    await act(async () => {
      toast.sessionNotice({
        sessionId: SESSION,
        sessionTitle: 'Fix login redirect',
        event: 'merge-result',
        headline: "Couldn't merge into main",
        detail: 'CONFLICT (content)',
        tone: 'error',
      });
    });
    expect(document.querySelectorAll('.toast--attention')).toHaveLength(1);
    await act(async () => {
      toast.sessionNotice({ sessionId: SESSION, sessionTitle: 'Fix login redirect', event: 'merge-result', headline: 'Merged into main' });
    });
    expect(toasts().map((one) => one.querySelector('.toast-head')?.textContent)).toEqual(['Merged into main']);
  });
});
