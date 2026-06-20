import { useQuery } from '@tanstack/react-query';
import { Spin } from 'antd';
import { useRef } from 'react';
import { useMatch } from 'react-router-dom';
import { api } from '../api';
import { decodeId } from '../lib/idCodec';
import { sessionQuery } from '../lib/queries';
import { AgentView } from './AgentView';

// The agent console, mounted as the layout route shared by /agents/:id(/new) and
// /sessions/:id. Being their parent route, it stays mounted as the child match changes
// between those paths — so AgentView never unmounts (and never loses its SSE stream /
// transcript or reloads the session list) on an in-console navigation.
export function AgentConsole() {
  const agents = useQuery({ queryKey: ['agents'], queryFn: () => api<any[]>('/agents') });
  const runners = useQuery({ queryKey: ['runners'], queryFn: () => api<any[]>('/runners') });

  // /agents/<agent> names the agent (its runner is derived below); /sessions/<id>
  // resolves the runner from the session behind it.
  const agentMatch = useMatch('/agents/:id/*');
  const sessionMatch = useMatch('/sessions/:id');
  const selectedSessionId = sessionMatch ? decodeId(sessionMatch.params.id) : null;
  // A /sessions/:id deep link carries no runner — fetch the session to find it.
  const sessionQ = useQuery(sessionQuery(selectedSessionId));
  const openAgentId = agentMatch ? decodeId(agentMatch.params.id) : null;
  const openAgent = (agents.data ?? []).find((a: any) => a.id === openAgentId) ?? null;
  // Prefer the agent's runner; fall back to treating the id as a runner so older
  // /agents/<runner> links still resolve, then to the open session's runner.
  const runnerId =
    openAgent?.runnerId ?? openAgentId ?? sessionQ.data?.assignedRunnerId ?? null;
  const selectedRunner = (runners.data ?? []).find((r: any) => r.id === runnerId) ?? null;
  // Navigating /agents/<id>/new -> /sessions/<newId> drops the agent from the URL, so
  // the runner can only come from getSession — undefined until that request returns.
  // The runner doesn't change across an in-console navigation, so hold the last resolved
  // one as a fallback while getSession is in flight.
  const lastRunner = useRef<any>(null);
  if (selectedRunner) lastRunner.current = selectedRunner;
  const viewRunner = selectedRunner ?? lastRunner.current;

  return (
    <main className="app-main">
      <div className="app-view">
        {viewRunner ? (
          <AgentView runner={viewRunner} />
        ) : (
          <div style={{ padding: 48, textAlign: 'center' }}>
            <Spin />
          </div>
        )}
      </div>
    </main>
  );
}
