// @vitest-environment jsdom
import { act, lazy, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearToasts } from '../lib/toastStore';
import { AppBoundary } from './BootGate';
import { LazyBoundary } from './ErrorBoundary';
import { ToastViewport } from './ToastViewport';

/**
 * A render that throws, in a real DOM. The case that sent this here (2026-10-31): a tab older than the
 * last deploy reached a chunk that deploy had removed, nothing caught the throw, and React took the
 * whole app down to an empty page, a half-typed message with it.
 */

const CHUNK_404 = new TypeError(
  'Failed to fetch dynamically imported module: https://orbitd.io/assets/StartPlanGraph-CMhICvIb.js',
);

/** A `lazy` whose import is still out, for the test to fail or answer when it wants. */
function pendingChunk() {
  const chunk = {
    fail: (_error: Error) => {},
    arrive: (_module: { default: () => ReactNode }) => {},
    Component: lazy(
      () =>
        new Promise<{ default: () => ReactNode }>((resolve, reject) => {
          chunk.fail = reject;
          chunk.arrive = resolve;
        }),
    ),
  };
  return chunk;
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function mount(node: ReactNode): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <MemoryRouter>
        {node}
        <ToastViewport />
      </MemoryRouter>,
    );
  });
}

const reloadButton = () => document.querySelector<HTMLButtonElement>('button[aria-label="Reload the page"]');
const toasts = () => document.querySelectorAll('.toast-head');

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // React reports every error it catches; each test here makes one on purpose.
  vi.spyOn(console, 'error').mockImplementation(() => {});
  // ToastViewport measures the viewport with one, which jsdom does not have.
  vi.stubGlobal('ResizeObserver', class {
    observe(): void {}
    disconnect(): void {}
  });
});

afterEach(async () => {
  const mounted = root;
  root = null;
  if (mounted) await act(async () => mounted.unmount());
  container?.remove();
  container = null;
  await act(async () => clearToasts());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

describe('LazyBoundary', () => {
  it('holds a chunk that 404s to its own place: the page stays, and what the reader typed with it', async () => {
    const chunk = pendingChunk();
    await mount(
      <>
        <textarea aria-label="Composer" />
        <LazyBoundary fallback={<p>The plan, by level</p>}>
          <chunk.Component />
        </LazyBoundary>
      </>,
    );
    const composer = container!.querySelector('textarea')!;
    composer.value = 'half a message';

    await act(async () => chunk.fail(CHUNK_404));

    expect(container!.textContent).toContain('The plan, by level');
    expect(composer.isConnected).toBe(true);
    expect(container!.querySelector('textarea')).toBe(composer);
    expect(composer.value).toBe('half a message');
  });

  it('offers the reload, and leaves pressing it to the reader', async () => {
    const reload = vi.fn();
    const chunk = pendingChunk();
    await mount(
      <LazyBoundary fallback={null}>
        <chunk.Component />
      </LazyBoundary>,
    );
    vi.stubGlobal('location', { ...window.location, reload });

    await act(async () => chunk.fail(CHUNK_404));

    expect(toasts()[0]?.textContent).toBe("Part of this page didn't load");
    expect(document.querySelector('.toast-sub')?.textContent).toBe('Orbit may have been updated.');
    expect(reload).not.toHaveBeenCalled();

    await act(async () => reloadButton()!.click());

    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('is one toast however many parts of the page fail, and however far apart', async () => {
    const chunks = [pendingChunk(), pendingChunk()];
    await mount(
      <>
        {chunks.map((chunk, index) => (
          <LazyBoundary key={index} fallback={null}>
            <chunk.Component />
          </LazyBoundary>
        ))}
      </>,
    );

    await act(async () => chunks[0].fail(CHUNK_404));
    // Past the two seconds in which the feed folds an identical toast by itself: the reader has
    // moved on to another panel, and only the toast's key keeps this from stacking.
    const later = Date.now() + 60_000;
    vi.spyOn(Date, 'now').mockReturnValue(later);
    await act(async () => chunks[1].fail(CHUNK_404));

    expect(toasts()).toHaveLength(1);
    expect(document.querySelector('.toast-more')).toBeNull();
  });

  it('does not leave a spinner spinning: `failed` takes the place of a fallback that means wait', async () => {
    const chunk = pendingChunk();
    await mount(
      <LazyBoundary fallback={<p>Loading</p>} failed={null}>
        <chunk.Component />
      </LazyBoundary>,
    );
    expect(container!.textContent).toContain('Loading');

    await act(async () => chunk.fail(CHUNK_404));

    expect(container!.textContent).not.toContain('Loading');
  });

  it('draws the chunk that arrives, and says nothing', async () => {
    const chunk = pendingChunk();
    await mount(
      <LazyBoundary fallback={<p>Loading</p>}>
        <chunk.Component />
      </LazyBoundary>,
    );

    await act(async () => chunk.arrive({ default: () => <p>The graph</p> }));

    expect(container!.textContent).toContain('The graph');
    expect(container!.textContent).not.toContain('Loading');
    expect(toasts()).toHaveLength(0);
  });

  it('is how the app waits for a chunk: a bare Suspense would hand a 404 to the whole page', () => {
    const sources = import.meta.glob<string>('../**/*.tsx', { query: '?raw', import: 'default', eager: true });
    expect(sources['./ErrorBoundary.tsx']).toContain('<Suspense');

    const bare = Object.entries(sources)
      .filter(([file]) => !file.endsWith('.test.tsx') && file !== './ErrorBoundary.tsx')
      .filter(([, source]) => source.includes('<Suspense'))
      .map(([file]) => file);

    expect(bare).toEqual([]);
  });
});

describe('AppBoundary', () => {
  function Throws(): ReactNode {
    throw new Error('a render that throws');
  }

  it('says so where the page was, and reloads when asked', async () => {
    const reload = vi.fn();
    await mount(
      <AppBoundary>
        <Throws />
      </AppBoundary>,
    );
    vi.stubGlobal('location', { ...window.location, reload });

    expect(container!.textContent).toContain('Something went wrong');

    await act(async () => container!.querySelector('button')!.click());

    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('takes the boot splash down: it covers the page, and a throw behind it is a bar that stopped', async () => {
    const boot = document.createElement('div');
    boot.id = 'boot';
    document.body.append(boot);

    await mount(
      <AppBoundary>
        <Throws />
      </AppBoundary>,
    );

    expect(boot.classList.contains('hide')).toBe(true);
    boot.remove();
  });

  it('leaves a page that renders alone', async () => {
    await mount(
      <AppBoundary>
        <p>The page</p>
      </AppBoundary>,
    );

    expect(container!.textContent).toContain('The page');
    expect(container!.textContent).not.toContain('Something went wrong');
  });
});
