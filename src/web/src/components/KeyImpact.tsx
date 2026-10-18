import { queryOptions, useQuery } from '@tanstack/react-query';
import { ENGINE_CLI_NAMES, type AgentProvider, type ProviderKeyUsage } from '@orbit/shared';
import { api } from '../api';
import { PROVIDERS_BASE, PROVIDERS_LIST_KEY, type ProviderRow } from '../lib/providerAdmin';
import { EngineTile } from './ProviderGallery';

/** How one of the user's keys is used right now, per engine (GET /providers/mine/:id/usage): the open
 *  sessions spending it and the task pins naming it. Under the providers list's key, so saving or
 *  deleting a key reads it again. */
export const keyUsageQuery = (id: string) =>
  queryOptions({
    queryKey: [...PROVIDERS_LIST_KEY, id, 'usage'],
    queryFn: () => api<ProviderKeyUsage>(`${PROVIDERS_BASE}/${id}/usage`),
    // Sessions start and end without the key changing: read it again every time it is asked.
    staleTime: 0,
  });

/** Whether anything uses the key now: an open session on it, or a task pinned to it, on any engine. */
export const keyInUse = (usage: ProviderKeyUsage): boolean => usage.sessions + usage.tasks > 0;

const count = (n: number, what: string) => `${n} ${what}${n === 1 ? '' : 's'}`;

/** One engine's use of a key — "2 open sessions, 1 task pinned" — or `idle` when nothing uses it. */
export function KeyUse({ use, separator, idle }: {
  use: { sessions: number; tasks: number } | undefined;
  separator: string;
  idle: string;
}) {
  const sessions = use?.sessions ?? 0;
  const tasks = use?.tasks ?? 0;
  if (sessions + tasks === 0) return <>{idle}</>;
  return (
    <>
      {sessions > 0 && <b>{count(sessions, 'open session')}</b>}
      {sessions > 0 && tasks > 0 && separator}
      {tasks > 0 && `${count(tasks, 'task')} pinned`}
    </>
  );
}

/** "all three engines", "both engines", "the one engine": how many a key works with. */
function engineCount(n: number): string {
  if (n === 1) return 'the one engine';
  if (n === 2) return 'both engines';
  return `all ${['three', 'four', 'five', 'six'][n - 3] ?? n} engines`;
}

/**
 * What turning a key off or deleting it does, asked before either (board 3 ②, the owner's choice A):
 * every engine the key works with and what uses it on each right now. A key is one credential
 * whichever engines run it, so neither is an engine's switch: whatever runs on it waits on the engine
 * it was on — never a runner's own sign-in — until the key is back, or until it is switched to another.
 */
export function KeyImpact({ row, action }: { row: ProviderRow; action: 'turnOff' | 'delete' }) {
  const usage = useQuery(keyUsageQuery(row.id));
  const used = usage.data?.engines ?? [];
  // A use on an engine the key no longer lists (an older replica's session) is still a use of it.
  const engines: AgentProvider[] = [...row.engines, ...used.map((e) => e.engine).filter((e) => !row.engines.includes(e))];
  const total = usage.data ? usage.data.sessions + usage.data.tasks : 0;
  const one = total === 1;
  const who = [
    ...(usage.data?.sessions ? [usage.data.sessions === 1 ? 'that session' : 'those sessions'] : []),
    ...(usage.data?.tasks ? [usage.data.tasks === 1 ? 'the pinned task' : 'the pinned tasks'] : []),
  ].join(' and ');
  const waits = `${one ? 'keeps its engine' : 'keep their engine'} and can’t run until you`;
  return (
    <div className="key-impact">
      <p>
        {engines.length === 0
          ? 'No engine runs it.'
          : `It ${action === 'delete' ? 'goes from' : 'stops on'} ${engineCount(engines.length)} it works with:`}
      </p>
      <div className="key-impact-list">
        {engines.map((engine) => (
          <div className="key-impact-row" key={engine}>
            <EngineTile engine={engine} size={16} />
            <span>{ENGINE_CLI_NAMES[engine]}</span>{' '}
            <span className="key-impact-use">
              —{' '}
              {usage.data ? (
                <KeyUse use={used.find((e) => e.engine === engine)} separator=", " idle="not in use" />
              ) : usage.isError ? (
                'unknown'
              ) : (
                '…'
              )}
            </span>
          </div>
        ))}
      </div>
      {usage.isError ? (
        <p>Couldn’t check what uses it: {usage.error.message}</p>
      ) : !usage.data ? null : total === 0 ? (
        <p>Nothing uses it right now.</p>
      ) : action === 'turnOff' ? (
        <p>
          {who.charAt(0).toUpperCase() + who.slice(1)} {waits} turn the key back on or switch {one ? 'it' : 'them'} to
          another key — nothing falls back to a runner’s own sign-in.
        </p>
      ) : (
        <p>
          {one ? 'It' : 'They'} {waits} switch {one ? 'it' : 'them'} to another key. To pause the key instead, turn
          it off.
        </p>
      )}
    </div>
  );
}
