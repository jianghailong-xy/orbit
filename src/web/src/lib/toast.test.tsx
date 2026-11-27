// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useNavigate, type NavigateFunction } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastViewport } from '../components/ToastViewport';
import { useToast } from './toast';
import { clearToasts, closeToast, showToast } from './toastStore';

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
// The test's own way around the app, as a click elsewhere would take the reader.
let go: NavigateFunction;
function Steer() {
  go = useNavigate();
  return null;
}

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // Layout is covered in real browsers; jsdom has no ResizeObserver.
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<p className="where">home</p>} />
          <Route path="/sessions/:id" element={<p className="where">session</p>} />
          <Route path="/schedules" element={<p className="where">schedules</p>} />
        </Routes>
        <Steer />
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
  vi.unstubAllGlobals();
});

const viewport = (): HTMLElement | null => document.querySelector('.toast-viewport');
const toasts = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('.toast-slot:not(.toast-slot--leaving) .toast')];

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
    // Its × is its only button: the card itself is the way to where it happened.
    expect([...card.querySelectorAll('button')].map((b) => b.getAttribute('aria-label'))).toEqual(['Dismiss']);
  });

  it('takes a failure raised on another page back there from anywhere on the card', async () => {
    await act(async () => go('/schedules'));
    await act(async () => {
      toast.error("Couldn't save the schedule", 'revision 12 is stale');
    });
    await act(async () => go('/'));
    const [card] = toasts();
    expect(card.querySelector('.toast-copy--link')?.getAttribute('aria-label')).toBe('Go to where this happened');
    await act(async () => card.querySelector<HTMLElement>('.toast-reason')!.click());
    expect(document.querySelector('.where')?.textContent).toBe('schedules');
    expect(toasts()).toHaveLength(0);
  });

  it('leaves a failure raised on the page on screen up after a stray click, for its ×', async () => {
    await act(async () => {
      toast.error("Couldn't save the schedule", 'revision 12 is stale');
    });
    const [card] = toasts();
    expect(card.classList.contains('toast--opens')).toBe(false);
    await act(async () => card.click());
    expect(toasts()).toHaveLength(1);
    await act(async () => card.querySelector<HTMLButtonElement>('button[aria-label="Dismiss"]')!.click());
    expect(toasts()).toHaveLength(0);
  });

  it("runs a failure's own fix from the card, with no button for it", async () => {
    const reload = vi.fn();
    await act(async () => {
      showToast({ message: "Part of this page didn't load", tone: 'warning', action: { label: 'Reload', ariaLabel: 'Reload the page', onClick: reload } });
    });
    const [card] = toasts();
    expect([...card.querySelectorAll('button')].map((b) => b.textContent || b.getAttribute('aria-label'))).not.toContain('Reload');
    await act(async () => card.click());
    expect(reload).toHaveBeenCalledOnce();
    expect(toasts()).toHaveLength(0);
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
    expect(toasts()).toHaveLength(0);
    await act(async () => { vi.advanceTimersByTime(250); });
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
    // The replaced library's handle settled only when the toast closed, and an error toast never closes on its own:
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
  it('keeps failures from different events and entities independently dismissible', async () => {
    await act(async () => {
      for (const [sessionId, event, headline] of [
        [SESSION, 'merge', 'First merge failed'],
        ['0196b000-0000-7000-8000-000000000002', 'merge', 'Second merge failed'],
        [SESSION, 'commit', 'Commit failed'],
      ]) toast.sessionNotice({ sessionId, sessionTitle: 'Workspace', event, headline, tone: 'error' });
    });
    await act(async () => { document.querySelector<HTMLButtonElement>('.toast-more')!.click(); });
    expect(toasts().map((one) => one.querySelector('.toast-head')?.textContent)).toEqual([
      'Commit failed', 'Second merge failed', 'First merge failed',
    ]);
    await act(async () => { toasts()[1].querySelector<HTMLButtonElement>('button[aria-label="Dismiss"]')!.click(); });
    expect(toasts().map((one) => one.querySelector('.toast-head')?.textContent)).toEqual(['Commit failed', 'First merge failed']);
  });

  it('does not turn selecting diagnostic text into a session navigation', async () => {
    await act(async () => {
      toast.sessionNotice({ sessionId: SESSION, sessionTitle: 'Workspace', event: 'commit', headline: 'Changes committed', detail: '1 file changed' });
    });
    const detail = document.querySelector('.toast-detail')!;
    const range = document.createRange();
    range.selectNodeContents(detail);
    window.getSelection()!.addRange(range);
    await act(async () => { document.querySelector<HTMLButtonElement>('button[aria-label="Open Workspace"]')!.click(); });
    expect(document.querySelector('.where')?.textContent).toBe('home');
    expect(detail.textContent).toBe('1 file changed');
    window.getSelection()!.removeAllRanges();
  });

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
    expect(toasts()).toHaveLength(0);
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
    expect(toasts()).toHaveLength(0);
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

  it('is a failure whose own copy is the way into the session, with no button for it', async () => {
    await act(async () => {
      toast.sessionNotice({
        sessionId: SESSION,
        sessionTitle: 'Fix login redirect',
        event: 'resolve-conflict-error',
        headline: "Couldn't start resolving the conflict",
        detail: 'index.lock: File exists.',
        tone: 'error',
      });
    });
    const [card] = toasts();
    expect(card.classList.contains('toast--attention')).toBe(true);
    // The press only follows the toast, so it belongs to the card — no button beside it but its ×.
    expect(card.querySelector('.toast-actions')).toBeNull();
    await act(async () => card.click());
    expect(document.querySelector('.where')?.textContent).toBe('session');
    expect(toasts()).toHaveLength(0);
  });
});

describe('a toast leaving', () => {
  it('releases a dismissed hovered result even when no mouse boundary event arrives', async () => {
    vi.useFakeTimers();
    let id: string | null = null;
    await act(async () => {
      id = showToast({ message: 'Result', tone: 'success', detail: 'Details', sessionId: SESSION });
    });
    const card = toasts()[0];
    card.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    await act(async () => { vi.advanceTimersByTime(10000); });
    expect(toasts()).toHaveLength(1);
    await act(async () => { closeToast(id!); });
    expect(card.parentElement!.hasAttribute('inert')).toBe(true);
    await act(async () => { toast.success('Unhovered successor'); });
    await act(async () => { vi.advanceTimersByTime(2999); });
    expect(toasts().map((one) => one.textContent)).toEqual(['Unhovered successor']);
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(toasts()).toHaveLength(0);
  });

  it('keeps a dismissed card for the 250ms exit, with its actions inert, then removes it', async () => {
    vi.useFakeTimers();
    await act(async () => { toast.error("Couldn't save the schedule", 'revision 12 is stale'); });
    const card = document.querySelector('.toast')!;
    await act(async () => { document.querySelector<HTMLButtonElement>('button[aria-label="Dismiss"]')!.click(); });
    const slot = card.parentElement!;
    expect(slot.classList.contains('toast-slot--leaving')).toBe(true);
    expect(slot.hasAttribute('inert')).toBe(true);
    expect(slot.getAttribute('aria-hidden')).toBe('true');
    await act(async () => { vi.advanceTimersByTime(249); });
    expect(card.isConnected).toBe(true);
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(viewport()).toBeNull();
  });

  it('animates an expired confirmation while a new toast arrives without restarting its exit', async () => {
    vi.useFakeTimers();
    await act(async () => { toast.success('Link copied'); });
    const pill = document.querySelector('.toast')!;
    await act(async () => { vi.advanceTimersByTime(3000); });
    expect(pill.parentElement!.classList.contains('toast-slot--leaving')).toBe(true);
    await act(async () => { vi.advanceTimersByTime(100); toast.success('Schedule saved'); });
    await act(async () => { vi.advanceTimersByTime(150); });
    expect(pill.isConnected).toBe(false);
    expect(toasts().map((one) => one.querySelector('.toast-head')?.textContent)).toEqual(['Schedule saved']);
  });

  it.each(['result', 'attention'] as const)('updates progress to a %s card in the same animation container', async (kind) => {
    await act(async () => {
      showToast({ sessionId: SESSION, key: 'merge', message: 'Merging into main…', inProgress: true, tone: 'info' });
    });
    const pill = document.querySelector('.toast')!;
    const slot = pill.parentElement!;
    await act(async () => {
      showToast({
        sessionId: SESSION, key: 'merge',
        message: kind === 'result' ? 'Merged into main' : "Couldn't merge into main",
        detail: kind === 'result' ? 'Merged 2 commits' : 'CONFLICT (content)',
        tone: kind === 'result' ? 'success' : 'error',
      });
    });
    const card = toasts()[0];
    expect(card.classList.contains('toast--card')).toBe(true);
    expect(card.parentElement).toBe(slot);
    expect(document.querySelector('.toast-slot--leaving')).toBeNull();
    expect(card.querySelector('.toast-head')?.textContent).toBe(kind === 'result' ? 'Merged into main' : "Couldn't merge into main");
  });
});
