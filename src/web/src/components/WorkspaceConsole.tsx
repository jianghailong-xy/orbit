import { useQuery } from '@tanstack/react-query';
import { useRef } from 'react';
import { useMatch, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { routeId } from '../lib/idCodec';
import { useFollowFirstSessionProvider, useManagedRunner } from '../lib/managedRunner';
import { projectDetailsQuery, sessionQuery } from '../lib/queries';
import { Button } from './ui/Button';
import { Result } from './ui/Result';
import { Spinner } from './ui/Spinner';
import { WorkspaceView } from './WorkspaceView';

// The workspace console, mounted as the layout route shared by /workspaces/:id(/new),
// /sessions/:id and a project's Landings window, /projects/:id/landings. Being their parent route, it stays mounted as the child match changes
// between those paths — so WorkspaceView never unmounts (and never loses its SSE stream /
// transcript or reloads the session list) on an in-console navigation.
export function WorkspaceConsole() {
  const navigate = useNavigate();
  const workspaces = useQuery({ queryKey: ['workspaces'], queryFn: () => api<any[]>('/workspaces') });
  // Poll while the console is open so the composer's plan-usage gauge stays current
  // (the runner refreshes its usage roughly every 2 min while busy).
  const runners = useQuery({
    queryKey: ['runners'],
    queryFn: () => api<any[]>('/runners'),
    refetchInterval: 60_000,
  });

  // /workspaces/<workspace> names the workspace (its runner is derived below); /sessions/<id>
  // resolves the runner from the session behind it.
  // Two patterns, one meaning: `agents` is the pre-rename URL people still have bookmarked.
  const workspacesMatch = useMatch('/workspaces/:id/*');
  const agentsMatch = useMatch('/agents/:id/*');
  const workspaceMatch = workspacesMatch ?? agentsMatch;
  const sessionMatch = useMatch('/sessions/:id');
  const selectedSessionId = sessionMatch ? routeId(sessionMatch.params.id) : null;
  // A /sessions/:id deep link carries no runner — fetch the session to find it.
  const sessionQ = useQuery(sessionQuery(selectedSessionId));
  const openWorkspaceId = workspaceMatch ? routeId(workspaceMatch.params.id) : null;
  const openWorkspace = (workspaces.data ?? []).find((a: any) => a.id === openWorkspaceId) ?? null;
  // A project's Landings window names no workspace and no session: the console is its coordinator's
  // workspace's, or — for a project whose coordinator has none, once that read has answered — the
  // first runner's. An in-console navigation keeps the runner it had (`lastRunner` below).
  const landingsMatch = useMatch('/projects/:id/landings');
  const landingsProjectId = landingsMatch ? routeId(landingsMatch.params.id) : null;
  const landingsProjectQ = useQuery({ ...projectDetailsQuery(landingsProjectId ?? ''), enabled: landingsProjectId != null });
  const landingsRunnerId = landingsProjectId && (landingsProjectQ.isSuccess || landingsProjectQ.isError)
    ? (workspaces.data ?? []).find((a: any) => a.id === landingsProjectQ.data?.coordinatorWorkspaceId)?.runnerId
      ?? runners.data?.[0]?.id ?? null
    : null;
  // Prefer the workspace's runner; fall back to treating the id as a runner so older
  // /workspaces/<runner> links still resolve, then to the open session's runner.
  const runnerId =
    openWorkspace?.runnerId ?? openWorkspaceId ?? sessionQ.data?.assignedRunnerId ?? landingsRunnerId ?? null;
  const selectedRunner = (runners.data ?? []).find((r: any) => r.id === runnerId) ?? null;
  // Navigating /workspaces/<id>/new -> /sessions/<newId> drops the workspace from the URL, so
  // the runner can only come from getSession — undefined until that request returns.
  // The runner doesn't change across an in-console navigation, so hold the last resolved
  // one as a fallback while getSession is in flight.
  const lastRunner = useRef<any>(null);
  if (selectedRunner) lastRunner.current = selectedRunner;
  const viewRunner = selectedRunner ?? lastRunner.current;
  // A /sessions/:id deep link to a session that doesn't exist (or was deleted) can never
  // resolve a runner, so getSession 404s. Without this we'd sit on the loading spinner
  // below forever; instead surface a clear not-found state with a way out. Gated on a
  // failed session fetch so a genuinely in-flight load still shows the spinner.
  const sessionNotFound = !!selectedSessionId && !viewRunner && sessionQ.isError;
  // The owner's managed runner, handed to the console only when it is this console's runner: its
  // state stands above the composer. Nothing waits on it — the console draws as before while it
  // loads, and with the capability missing or off there is none.
  const { managed } = useManagedRunner();
  // The default workspace's draft starts where the workspace list says; follow it as the runner comes up.
  useFollowFirstSessionProvider(managed);
  const consoleManaged =
    managed?.status.runnerId && viewRunner && routeId(managed.status.runnerId) === routeId(viewRunner.id)
      ? managed
      : null;

  return (
    <main className="app-main">
      <div className="app-view">
        {viewRunner ? (
          <WorkspaceView runner={viewRunner} managed={consoleManaged} fleet={runners.data} />
        ) : sessionNotFound ? (
          <Result
            status="404"
            title="Session not found"
            subTitle="This session doesn't exist or has been deleted."
            extra={
              <Button variant="primary" onClick={() => navigate('/')}>
                Go home
              </Button>
            }
          />
        ) : (
          <div style={{ padding: 48, textAlign: 'center' }}>
            <Spinner />
          </div>
        )}
      </div>
    </main>
  );
}
