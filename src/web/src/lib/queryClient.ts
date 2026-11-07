import { QueryClient } from '@tanstack/react-query';
import { retryUnlessStreamDown } from './listBudget';

/** The tab's one QueryClient (main.tsx), here so tests read through the same defaults. */
export function createAppQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        refetchOnWindowFocus: false,
        // A browser back online reopens the control-plane stream, which reads again what is on screen.
        // React Query's own refetch on `online` was a second round of every read on top of it.
        refetchOnReconnect: false,
        retry: retryUnlessStreamDown,
      },
    },
  });
}
