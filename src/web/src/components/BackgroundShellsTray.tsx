import { useEffect, useMemo, useRef, useState } from 'react';
import { App as AntApp } from 'antd';
import {
  CheckCircleFilled,
  ConsoleSqlOutlined,
  DownOutlined,
  LoadingOutlined,
  MinusCircleOutlined,
  RightOutlined,
} from '@ant-design/icons';
import type { RunEvent } from './Transcript';
import { Pre } from './Transcript';
import type { BgShell, BgShellStatus } from '../lib/backgroundShells';
import { deriveBackgroundShells } from '../lib/backgroundShells';

/**
 * "Background processes" tray, shown above the composer like the worktree status bar. It
 * surfaces the shell processes the agent launched with Bash(run_in_background) — which are
 * otherwise invisible (the session looks idle while a build runs in the background).
 *
 * Everything is derived from the session's existing event stream (see deriveBackgroundShells),
 * so there's no backend dependency. Phase-1 limits to be aware of: output only refreshes when
 * the agent itself polls the file with Read (not an independent live tail), and completion is
 * best-effort — see classifyShellStatus. Both are addressed in later plan phases.
 */
export function BackgroundShellsTray({ events, live }: { events: RunEvent[]; live?: boolean }) {
  const { message } = AntApp.useApp();
  const shells = useMemo(
    () => deriveBackgroundShells(events, { sessionLive: !!live }),
    [events, live],
  );
  const [open, setOpen] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Toast the moment a process flips running → done. Phase 1's best-effort classifier never
  // returns 'done' yet (no reliable signal — see classifyShellStatus), so this is wired and
  // silent until phase 2 emits a real completion event; then it lights up with no other change.
  const lastStatus = useRef<Map<string, BgShellStatus>>(new Map());
  useEffect(() => {
    const seen = lastStatus.current;
    for (const s of shells) {
      if (seen.get(s.shellId) === 'running' && s.status === 'done') {
        message.success(`Background process ${s.shellId} finished`);
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
      {/* Folded: one-line peek of the latest output the agent pulled. */}
      {!expanded && shell.latestOutput && (
        <div className="bg-shell-peek">{lastLine(shell.latestOutput)}</div>
      )}
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
  return <MinusCircleOutlined className="chat-tool-status pending" />;
}

function lastLine(text: string): string {
  const lines = text.trimEnd().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim() !== '') return lines[i];
  }
  return '';
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
