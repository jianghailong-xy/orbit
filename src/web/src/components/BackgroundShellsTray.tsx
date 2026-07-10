import { useEffect, useMemo, useRef, useState } from 'react';
import { App as AntApp } from 'antd';
import {
  CheckCircleFilled,
  CloseCircleFilled,
  ConsoleSqlOutlined,
  DownOutlined,
  LoadingOutlined,
  MinusCircleOutlined,
  RightOutlined,
  StopOutlined,
} from '@ant-design/icons';
import type { RunEvent } from './Transcript';
import { Pre } from './Transcript';
import type { BgShell, BgShellStatus } from '../lib/backgroundShells';
import { deriveBackgroundShells, mergeBackgroundShells } from '../lib/backgroundShells';

/**
 * "Background processes" tray, shown above the composer like the worktree status bar. It
 * surfaces the shell processes the agent launched with Bash(run_in_background) — which are
 * otherwise invisible (the session looks idle while a build runs in the background).
 *
 * Derived from the session's event stream (see deriveBackgroundShells): the launch + the
 * agent's Read polls, plus the runner's live output tail (background_output) and the reliable
 * completion signal (background_task, from Claude's <task-notification>) that drives the
 * terminal icon + this toast.
 *
 * `serverShells` is the apiserver's authoritative, complete list (GET /sessions/:id/background,
 * derived over ALL persisted events). The loaded event window only holds the most recent launches
 * — so on its own the tray under-counts a long session — while the server list may lag the very
 * latest live output. We merge: the complete set from the server, the freshest tail from the window.
 */
export function BackgroundShellsTray({
  events,
  live,
  serverShells,
}: {
  events: RunEvent[];
  live?: boolean;
  serverShells?: BgShell[];
}) {
  const { message } = AntApp.useApp();
  const shells = useMemo(
    () =>
      mergeBackgroundShells(serverShells ?? [], deriveBackgroundShells(events, { sessionLive: !!live })),
    [events, live, serverShells],
  );
  const [open, setOpen] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Toast the moment a process leaves 'running' for a terminal state (driven by the reliable
  // background_task completion signal — see classifyShellStatus). Skips 'unknown' (the session
  // just ended without a notification — not a real completion worth a toast).
  const lastStatus = useRef<Map<string, BgShellStatus>>(new Map());
  useEffect(() => {
    const seen = lastStatus.current;
    for (const s of shells) {
      const was = seen.get(s.shellId);
      if (was === 'running' && s.status !== 'running' && s.status !== 'unknown') {
        const label = s.description || s.shellId;
        if (s.status === 'failed') message.error(`Background process failed: ${label}`);
        else if (s.status === 'killed') message.info(`Background process stopped: ${label}`);
        else message.success(`Background process finished: ${label}`);
      }
      seen.set(s.shellId, s.status);
    }
  }, [shells, message]);

  if (shells.length === 0) return null;
  const running = shells.filter((s) => s.status === 'running').length;
  const toggle = () => setOpen((o) => !o);

  return (
    <div className={`bg-tray${open ? ' bg-open' : ''}`}>
      <div className="bg-tray-row" onClick={toggle}>
        <ConsoleSqlOutlined className="bg-tray-ico" />
        <span className="bg-tray-title">Background processes</span>
        <span className="bg-tray-count">
          {running > 0 ? `${running} running · ` : ''}
          {shells.length} total
        </span>
        <span className="wt-spacer" />
        <button
          type="button"
          className="wt-expand"
          onClick={(e) => {
            e.stopPropagation();
            toggle();
          }}
          aria-label={open ? 'Hide processes' : 'Show processes'}
        >
          {open ? '▾' : '▸'}
        </button>
      </div>
      {open && (
        <div className="bg-tray-list">
          {shells.map((s) => (
            <BgShellRow
              key={s.shellId}
              shell={s}
              expanded={expandedId === s.shellId}
              onToggle={() => setExpandedId((id) => (id === s.shellId ? null : s.shellId))}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function BgShellRow({
  shell,
  expanded,
  onToggle,
}: {
  shell: BgShell;
  expanded: boolean;
  onToggle: () => void;
}) {
  const title = shell.description || shell.command;
  return (
    <div className={`bg-shell bg-shell-${shell.status}${expanded ? ' bg-shell-open' : ''}`}>
      <div className="bg-shell-head" onClick={onToggle}>
        <BgStatusIcon status={shell.status} />
        <span className="bg-shell-cmd" title={shell.command}>
          {title}
        </span>
        <span className="bg-shell-id">{shell.shellId}</span>
        {shell.startedTs && <span className="bg-shell-age">{relAge(shell.startedTs)}</span>}
        <span className="bg-shell-caret">{expanded ? <DownOutlined /> : <RightOutlined />}</span>
      </div>
      {expanded && (
        <div className="bg-shell-detail">
          {/* When the title is the description, still show the actual command. */}
          {shell.description && <Pre text={shell.command} prompt />}
          {shell.latestOutput ? (
            <Pre text={shell.latestOutput} threshold={16} muted />
          ) : (
            <div className="bg-shell-empty">
              No output captured yet — the agent hasn't read this process's output.
            </div>
          )}
          <div className="bg-shell-meta" title={shell.outputPath}>
            {shell.outputPath || shell.shellId}
            {shell.latestOutputTs ? ` · updated ${relAge(shell.latestOutputTs)}` : ''}
          </div>
        </div>
      )}
    </div>
  );
}

// Mirrors Transcript's ToolStatus icon family so background-process state reads the same as
// every other tool: spinner while running, neutral dot once the session ends (best-effort),
// check once a reliable completion signal lands (phase 2).
function BgStatusIcon({ status }: { status: BgShellStatus }) {
  if (status === 'running') return <LoadingOutlined spin className="chat-tool-status running" />;
  if (status === 'done') return <CheckCircleFilled className="chat-tool-status ok" />;
  if (status === 'failed') return <CloseCircleFilled className="chat-tool-status err" />;
  if (status === 'killed') return <StopOutlined className="chat-tool-status pending" />;
  return <MinusCircleOutlined className="chat-tool-status pending" />;
}

// Short relative age ("just now", "5m ago", "3h ago", "2d ago") for a launch / last-read time.
function relAge(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const diff = Date.now() - t;
  const min = 60_000;
  const hour = 60 * min;
  const day = 24 * hour;
  if (diff < min) return 'just now';
  if (diff < hour) return `${Math.floor(diff / min)}m ago`;
  if (diff < day) return `${Math.floor(diff / hour)}h ago`;
  return `${Math.floor(diff / day)}d ago`;
}
