import { Component, Suspense, type ReactNode } from 'react';
import { useToast } from '../lib/toast';

/**
 * Draws `fallback` in place of `children` once they have thrown while rendering. A throw takes down
 * everything up to the nearest boundary, and with none that is the whole app: an empty page.
 */
export class ErrorBoundary extends Component<
  { fallback: ReactNode; onCatch?: () => void; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(): void {
    this.props.onCatch?.();
  }

  render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/**
 * `<Suspense>` for a `lazy()` component, holding a chunk that never arrives to the place that asked
 * for it.
 *
 * A tab keeps the chunk names of the build that opened it, and a deploy takes those files away: the
 * web image serves its own build's /assets/ and no other. So the first time a tab older than the
 * last deploy reaches a chunk it has not fetched yet, the import 404s and `lazy` throws that from the
 * render. The reader keeps the page they are on and is offered the reload. It is not done for them:
 * a composer's draft lives in memory only, and a chunk can fail while they are typing, when a card
 * arrives in the conversation.
 *
 * `fallback` shows while the chunk loads and `failed` stays if it never does. They are the same thing
 * unless `fallback` means "wait": a spinner must not spin for the rest of the tab's life.
 */
export function LazyBoundary({
  fallback,
  failed = fallback,
  children,
}: {
  fallback: ReactNode;
  failed?: ReactNode;
  children: ReactNode;
}) {
  const toast = useToast();
  return (
    <ErrorBoundary fallback={failed} onCatch={toast.partOfPageFailed}>
      <Suspense fallback={fallback}>{children}</Suspense>
    </ErrorBoundary>
  );
}
