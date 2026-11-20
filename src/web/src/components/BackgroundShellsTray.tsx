import { useEffect, useMemo, useState, type CSSProperties } from 'react';
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
import {
  backgroundRow,
  progressTrayLine,
  type BackgroundRowCountPart,
  type BackgroundRowItem,
  type BackgroundRowName,
  type TaskProgress,
} from '@orbit/shared';
import { splitRecordedNote } from '../lib/deliveredMessage';
import { parseWatchWake } from '../lib/watches';
import { parseSessionMessage } from '../lib/sessionMessage';
import { EMPTY_LIVE_TASK_PROGRESS, type LiveTaskProgress } from '../lib/liveTaskProgress';
import { TaskProgressBlock } from './TaskProgressBlock';

/**
 * "Background processes" tray, shown above the composer like the worktree status bar. It
 * surfaces the shell processes the workspace launched with Bash(run_in_background) — which are
 * otherwise invisible (the session looks idle while a build runs in the background).
 *
 * Derived from the session's event stream (see deriveBackgroundShells): the launch + the
 * workspace's Read polls, plus the runner's live output tail (background_output) and the reliable
 * completion signal (background_task, from Claude's <task-notification>) that drives the
 * terminal icon. Nothing toasts when a process ends: the row's icon, on this same screen, already
 * says how it ended, and neither a finish nor a failure needs the reader to act.
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
  liveProgress = EMPTY_LIVE_TASK_PROGRESS,
}: {
  events: RunEvent[];
  live?: boolean;
  serverShells?: BgShell[];
  /** The live progress frames of the background agents and workflows, by launching call. */
  liveProgress?: LiveTaskProgress;
}) {
  const shells = useMemo(
    () =>
      mergeBackgroundShells(serverShells ?? [], deriveBackgroundShells(events, { sessionLive: !!live })),
    [events, live, serverShells],
  );
  // The folded row is the shared rule's (src/shared backgroundRow.ts, background-row.fixture.json):
  // what is running on a live session, plus what ended after the person's last message.
  const since = useMemo(() => lastUserMessageAt(events), [events]);
  const row = useMemo(() => backgroundRow(shells, since, !!live), [shells, since, live]);
  const [open, setOpen] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // Held here rather than in the folded name, so opening the list pauses the names, not resets them.
  const rotation = useRotation(row.hidden ? null : row.name, open);

  if (row.hidden) return null;
  const toggle = () => setOpen((o) => !o);

  return (
    <div className={`bg-tray${open ? ' bg-open' : ''}`}>
      <div className="bg-tray-row" onClick={toggle}>
        <ConsoleSqlOutlined className="bg-tray-ico" />
        {open ? (
          // Opened, the head keeps the full name and the count; the names stop rotating.
          <>
            <span className="bg-tray-title">Background processes</span>
            {row.countParts.length > 0 && <CountLine parts={row.countParts} />}
          </>
        ) : (
          <>
            <span className="bg-tray-title bg-tray-label">{row.label}</span>
            <FoldedName name={row.name} rotation={rotation} />
          </>
        )}
        <span className="wt-spacer" />
        {/* Folded, the count and then the mark sit at the right edge, before the arrow, as the
            Agents row draws its status. */}
        {!open && row.countParts.length > 0 && <CountLine parts={row.countParts} />}
        {!open && <BgStatusIcon status={row.name.mode === 'rotate' ? 'running' : row.name.item.mark} />}
        <button
          type="button"
          className="wt-expand"
          onClick={(e) => {
            e.stopPropagation();
            toggle();
          }}
          aria-expanded={open}
          aria-label={open ? 'Hide background processes' : row.accessibilityLabel}
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
              progress={liveProgress.get(s.toolUseId) ?? s.progress}
              expanded={expandedId === s.shellId}
              onToggle={() => setExpandedId((id) => (id === s.shellId ? null : s.shellId))}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * When the person last wrote: the newest `user` event with words they typed. A turn Orbit opened
 * itself (a background job's or a SubAgent's wake: nothing typed, only the recorded note) or a
 * watch's wake is not their message, so it clears nothing (decision D1); nor is a message another
 * Orbit session sent (`sessionMessage` card).
 */
export function lastUserMessageAt(events: RunEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.type !== 'user' || !ev.ts) continue;
    const p = (ev.payload ?? {}) as { text?: unknown };
    if (parseSessionMessage(p)) continue;
    const recorded = splitRecordedNote(p);
    const text = recorded ? recorded.text : typeof p.text === 'string' ? p.text : '';
    if (text.trim() === '' || parseWatchWake(text)) continue;
    return ev.ts;
  }
  return null;
}

function CountLine({ parts }: { parts: BackgroundRowCountPart[] }) {
  return (
    <span className="bg-tray-count">
      {parts.map((part, i) => (
        <span key={part.kind}>
          {i > 0 && ' · '}
          {part.kind === 'failed' ? <span className="ct-failed">{part.text}</span> : part.text}
        </span>
      ))}
    </span>
  );
}

const reducedMotion = (): boolean =>
  typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** Whether the tab is in the background (document.hidden), kept current. */
function useDocumentHidden(): boolean {
  const [hidden, setHidden] = useState(() => typeof document !== 'undefined' && document.hidden);
  useEffect(() => {
    const onChange = () => setHidden(document.hidden);
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);
  return hidden;
}

interface Rotation {
  step: number;
  changing: boolean;
}

/**
 * Which rotating name shows: the step advances every perNameMs, and `changing` holds for changeMs
 * after each advance while the old name leaves. It holds while `paused` (the list is open) or the
 * tab is hidden, and starts again from the newest when the running set changes.
 */
function useRotation(name: BackgroundRowName | null, paused: boolean): Rotation {
  const hidden = useDocumentHidden();
  const rotate = name?.mode === 'rotate' ? name : null;
  const key = rotate?.items.map((i) => i.id).join('\n') ?? '';
  const [state, setState] = useState<Rotation>({ step: 0, changing: false });
  useEffect(() => setState({ step: 0, changing: false }), [key]);
  const perNameMs = rotate?.perNameMs ?? 0;
  const changeMs = rotate?.changeMs ?? 0;
  const active = !!rotate && !paused && !hidden;
  useEffect(() => {
    if (!active) return;
    let settle: ReturnType<typeof setTimeout> | undefined;
    const tick = setInterval(() => {
      setState((s) => ({ step: s.step + 1, changing: true }));
      clearTimeout(settle);
      settle = setTimeout(() => setState((s) => ({ ...s, changing: false })), changeMs);
    }, perNameMs);
    return () => {
      clearInterval(tick);
      clearTimeout(settle);
      setState((s) => (s.changing ? { ...s, changing: false } : s));
    };
  }, [active, key, perNameMs, changeMs]);
  return state;
}

/**
 * The folded row's name: one still name, or the running names in turn. A change
 * pushes the old name up and the new one in from below (translateY); under prefers-reduced-motion
 * the two crossfade in place. The rotating text is aria-hidden: the toggle's label says the count.
 */
function FoldedName({ name, rotation }: { name: BackgroundRowName; rotation: Rotation }) {
  if (name.mode !== 'rotate') return <RowName item={name.item} className="bg-tray-name" />;
  const { items, changeMs } = name;
  const { step, changing } = rotation;
  const at = (n: number) => items[((n % items.length) + items.length) % items.length];
  const style = { '--bg-rot-change': `${changeMs}ms` } as CSSProperties;
  return (
    <span className={`bg-rot ${reducedMotion() ? 'is-fade' : 'is-push'}`} style={style} aria-hidden="true">
      {changing && <RowName key={`out-${step}`} item={at(step - 1)} className="bg-rot-name bg-rot-out" />}
      <RowName key={`in-${step}`} item={at(step)} className={`bg-rot-name${changing ? ' bg-rot-in' : ''}`} />
    </span>
  );
}

/**
 * A name in the folded row. A description gives way at its tail (CSS ellipsis); a command keeps
 * its end and gives way in the middle ("npm run build … tee build.log").
 */
function RowName({ item, className }: { item: BackgroundRowItem; className: string }) {
  if (item.truncate === 'tail') {
    return (
      <span className={className} data-truncate="tail" title={item.name}>
        {item.name}
      </span>
    );
  }
  const keep = Math.min(16, Math.floor(item.name.length / 2));
  return (
    <span className={`${className} bg-name-mid`} data-truncate="middle" title={item.name}>
      <span className="bg-name-head">{item.name.slice(0, item.name.length - keep)}</span>
      <span className="bg-name-tail">{item.name.slice(item.name.length - keep)}</span>
    </span>
  );
}

function BgShellRow({
  shell,
  progress,
  expanded,
  onToggle,
}: {
  shell: BgShell;
  progress?: TaskProgress;
  expanded: boolean;
  onToggle: () => void;
}) {
  const title = shell.description || shell.command;
  const task = shell.kind === 'agent' || shell.kind === 'workflow';
  // Where a running workflow is, or what a running agent is on — the second line of its row.
  const line = task && shell.status === 'running' && progress ? progressTrayLine(progress) : null;
  return (
    <div className={`bg-shell bg-shell-${shell.status}${expanded ? ' bg-shell-open' : ''}`}>
      <div className="bg-shell-head" onClick={onToggle}>
        <BgStatusIcon status={shell.status} />
        {task && <span className="bg-shell-kind">{shell.kind === 'workflow' ? 'Workflow' : 'Agent'}</span>}
        <span className="bg-shell-cmd" title={shell.command || title}>
          {title}
        </span>
        <span className="bg-shell-id">{shell.shellId}</span>
        {shell.startedTs && <span className="bg-shell-age">{relAge(shell.startedTs)}</span>}
        <span className="bg-shell-caret">{expanded ? <DownOutlined /> : <RightOutlined />}</span>
      </div>
      {line && <div className="bg-shell-sub">{line}</div>}
      {expanded && task && (
        <div className="bg-shell-detail">
          {progress ? (
            <TaskProgressBlock progress={progress} />
          ) : (
            <div className="bg-shell-empty">No progress reported yet.</div>
          )}
        </div>
      )}
      {expanded && !task && (
        <div className="bg-shell-detail">
          {/* When the title is the description, still show the actual command. */}
          {shell.description && shell.command && <Pre text={shell.command} prompt />}
          {shell.latestOutput ? (
            <Pre text={shell.latestOutput} threshold={16} muted />
          ) : (
            <div className="bg-shell-empty">
              No output captured yet — either the process hasn't written any, or the
              workspace hasn't read its .output file.
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
