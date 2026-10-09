// The signed-in owner's managed runner, as the web reads it (docs/managed-runner-design.md, "Server
// and three client interfaces"). The capability comes first: a server from before the feature, the
// switch off, or a contract this client does not know all leave every page exactly as it was —
// no status read, no managed UI. What is shown is @orbit/shared's `managedRunnerDisplay`, the same
// reading OrbitKit mirrors, so Web, macOS and iOS say the same thing about the same state.

import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  MANAGED_RUNNER_STATUS_POLL_SECONDS,
  managedRunnerDisplay,
  managedRunnersOffered,
  type ManagedRunnerDisplay,
  type ManagedRunnerStatus,
  type ServerCapabilities,
} from '@orbit/shared';
import { api, ApiError } from '../api';
import { useToast } from './toast';
import { compatibleUuid } from './uuid';

/** `GET /auth/capabilities`. A server that predates it answers 404: that is no capability, not an error. */
export const serverCapabilitiesQuery = () =>
  queryOptions({
    queryKey: ['auth', 'capabilities'],
    queryFn: async (): Promise<Partial<ServerCapabilities> | null> => {
      try {
        return await api<Partial<ServerCapabilities>>('/auth/capabilities');
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
    // The switch changes only when the server restarts.
    staleTime: 5 * 60_000,
    retry: 1,
  });

/**
 * Where first-run setup sends the account it just created. The registration guide, as always —
 * unless the server offers managed runners, in which case bootstrap has started one for it and the
 * default landing opens its workspace. A capability that cannot be read is no capability.
 */
export async function firstRunLanding(): Promise<string> {
  try {
    return managedRunnersOffered(await api('/auth/capabilities')) ? '/' : '/runners/register';
  } catch {
    return '/runners/register';
  }
}

/** `GET /managed-runner`: the owner's mapping as stored and derived. Reading it allocates nothing. */
export const managedRunnerStatusQuery = () =>
  queryOptions({
    queryKey: ['managed-runner'],
    queryFn: () => api<ManagedRunnerStatus>('/managed-runner'),
    retry: 1,
  });

export interface ManagedRunner {
  status: ManagedRunnerStatus;
  display: ManagedRunnerDisplay;
}

/**
 * The managed runner to show, or null for no managed UI. Read again every few seconds while the
 * state moves by itself and every half minute otherwise, while something on screen shows it.
 * `settled` is whether the answer is in: the capability read has finished, whatever it said, and
 * when it offers managed runners the status read has too. A failed read settles as no managed UI,
 * never as a wait. `ask` false reads nothing at all.
 */
export function useManagedRunner(ask = true): { managed: ManagedRunner | null; settled: boolean } {
  const capabilities = useQuery({ ...serverCapabilitiesQuery(), enabled: ask });
  const offered = ask && managedRunnersOffered(capabilities.data);
  const status = useQuery({
    ...managedRunnerStatusQuery(),
    enabled: offered,
    refetchInterval: (query) =>
      (managedRunnerDisplay(query.state.data)?.moving
        ? MANAGED_RUNNER_STATUS_POLL_SECONDS.moving
        : MANAGED_RUNNER_STATUS_POLL_SECONDS.settled) * 1000,
  });
  const display = offered ? managedRunnerDisplay(status.data) : null;
  return {
    managed: display && status.data ? { status: status.data, display } : null,
    settled: capabilities.isFetched && (!offered || status.isFetched),
  };
}

/**
 * Retry and Set up. Each press is one idempotency key; the answer (202 with the status) replaces the
 * status read, and a refusal — a revision another client moved, an account the server does not give
 * one to — is said with the server's own sentence and the status read again.
 */
export function useManagedRunnerActions() {
  const qc = useQueryClient();
  const toast = useToast();
  const answered = (status: ManagedRunnerStatus) => {
    qc.setQueryData(managedRunnerStatusQuery().queryKey, status);
  };
  const refused = (headline: string) => (error: Error) => {
    toast.error(headline, error.message);
    void qc.invalidateQueries({ queryKey: managedRunnerStatusQuery().queryKey });
  };
  const retry = useMutation({
    mutationFn: (status: ManagedRunnerStatus) =>
      api<ManagedRunnerStatus>('/managed-runner/retry', {
        method: 'POST',
        body: { idempotencyKey: compatibleUuid(), revision: status.revision },
      }),
    onSuccess: answered,
    onError: refused("Couldn't retry the managed runner"),
  });
  const ensure = useMutation({
    mutationFn: () =>
      api<ManagedRunnerStatus>('/managed-runner/ensure', {
        method: 'POST',
        body: { idempotencyKey: compatibleUuid() },
      }),
    onSuccess: (status) => {
      answered(status);
      // The mapping brings its runner and default workspace with it.
      void qc.invalidateQueries({ queryKey: ['workspaces'] });
      void qc.invalidateQueries({ queryKey: ['runners'] });
    },
    onError: refused("Couldn't set up the managed runner"),
  });
  return { retry, ensure };
}
