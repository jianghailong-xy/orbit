import { useQuery } from '@tanstack/react-query';
import { Spin } from 'antd';
import { useRef } from 'react';
import { useLocation, useMatch, useNavigate } from 'react-router-dom';
import { api, getSession } from '../api';
import { decodeId } from '../lib/idCodec';
import { ActiveSessionsView } from '../components/ActiveSessionsView';
import { AgentView } from '../components/AgentView';
import { RunnerRegisterGuide } from '../components/RunnerRegisterGuide';
import { TasksSidePanel } from '../components/TasksSidePanel';
import { RunnersPage } from './RunnersPage';
import { RunnerDetailPage } from './RunnerDetailPage';
import { SkillsPage } from './SkillsPage';
import { TaskListView } from './TaskListView';

// The app's main page: a side nav plus a content region that hosts one of several
// views, chosen by the route. The task table is the default; the agent console,
// runners, skills, runner detail, register guide and active-sessions list render in
// its place. Each view declares its own layout contract via the .app-view wrapper.
export function TasksPage() {
  const loc = useLocation();
  const navigate = useNavigate();
  // The "Add a runner" guide is its own route; show it whenever we're on /runners/register.
  const showRegister = loc.pathname === '/runners/register';
  const showRunners = loc.pathname === '/runners';
  const showSkills = loc.pathname === '/skills';
  // Active now lists live sessions (what's running now) instead of the task table.
  const showActive = loc.pathname === '/active';
  // /runners/<base62> opens that runner's detail/settings page. (/runners/register
  // also matches the :id pattern, so guard against it.)
  const runnerDetailMatch = useMatch('/runners/:id');
  const runnerDetailId = !showRegister && runnerDetailMatch ? decodeId(runnerDetailMatch.params.id) : null;

  const agents = useQuery({ queryKey: ['agents'], queryFn: () => api<any[]>('/agents') });
  const runners = useQuery({ queryKey: ['runners'], queryFn: () => api<any[]>('/runners') });

  // The console is keyed by runner: /agents/<agent> names the agent (its runner is
  // derived below), or /sessions/<id> from which we resolve the runner behind it.
  const agentMatch = useMatch('/agents/:id/*');
  const sessionMatch = useMatch('/sessions/:id');
  const inAgentView = !!agentMatch || !!sessionMatch;
  const selectedSessionId = sessionMatch ? decodeId(sessionMatch.params.id) : null;
  // A /sessions/:id deep link carries no runner — fetch the session to find it.
  const sessionQ = useQuery({
    queryKey: ['session', selectedSessionId],
    queryFn: () => getSession(selectedSessionId!),
    enabled: !!selectedSessionId,
  });
  const openAgentId = agentMatch ? decodeId(agentMatch.params.id) : null;
  const openAgent = (agents.data ?? []).find((a: any) => a.id === openAgentId) ?? null;
  // Prefer the agent's runner; fall back to treating the id as a runner so older
  // /agents/<runner> links still resolve, then to the open session's runner.
  const runnerId =
    openAgent?.runnerId ?? openAgentId ?? sessionQ.data?.assignedRunnerId ?? null;
  const selectedRunner = (runners.data ?? []).find((r: any) => r.id === runnerId) ?? null;
  // Navigating /agents/<id>/new -> /sessions/<newId> drops the agent from the URL, so
  // the runner can only come from getSession — undefined until that request returns.
  // Without a bridge, AgentView would unmount to a <Spin/> and remount (losing its SSE
  // stream / transcript and re-loading the session list) on every such hop. The runner
  // doesn't change across an in-console navigation, so hold the last resolved one as a
  // fallback while getSession is in flight; clear it on leaving the console.
  const lastRunner = useRef<any>(null);
  if (!inAgentView) lastRunner.current = null;
  else if (selectedRunner) lastRunner.current = selectedRunner;
  const viewRunner = inAgentView ? (selectedRunner ?? lastRunner.current) : null;

  // The task list is the default view, shown when none of the other routes match.
  const showTaskList =
    !showRegister && !showRunners && !showSkills && !runnerDetailId && !inAgentView && !showActive;

  return (
    <div className="app-shell">
      <TasksSidePanel />
      {showTaskList ? (
        <TaskListView />
      ) : (
        <main className="app-main">
          {/* Most views are document-style (page gutter + own scroll); the agent
              console and the runner install guide fill the region edge-to-edge. */}
          <div className={`app-view${inAgentView || showRegister ? '' : ' app-view--doc'}`}>
            {showRegister ? (
              <RunnerRegisterGuide onClose={() => navigate('/tasks')} />
            ) : showRunners ? (
              <RunnersPage />
            ) : showSkills ? (
              <SkillsPage />
            ) : runnerDetailId ? (
              <RunnerDetailPage runnerId={runnerDetailId} />
            ) : inAgentView ? (
              viewRunner ? (
                <AgentView runner={viewRunner} />
              ) : (
                <div style={{ padding: 48, textAlign: 'center' }}>
                  <Spin />
                </div>
              )
            ) : showActive ? (
              <ActiveSessionsView />
            ) : null}
          </div>
        </main>
      )}
    </div>
  );
}
