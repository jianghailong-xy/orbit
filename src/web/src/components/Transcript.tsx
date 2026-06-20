import {
  ApiOutlined,
  CheckCircleFilled,
  CheckSquareOutlined,
  CloseCircleFilled,
  CodeOutlined,
  DownOutlined,
  EditOutlined,
  FileAddOutlined,
  FileTextOutlined,
  FolderOpenOutlined,
  GlobalOutlined,
  LoadingOutlined,
  MinusCircleOutlined,
  PartitionOutlined,
  QuestionCircleOutlined,
  RightOutlined,
  SearchOutlined,
  ToolOutlined,
} from '@ant-design/icons';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { fetchAttachmentObjectUrl } from '../api';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import 'highlight.js/styles/github.css';

// One normalized run event (subset the transcript cares about). Mirrors the SSE
// payload the runner emits; see src/runner-go/claude.go + @orbit/shared enums.
export interface RunEvent {
  seq: number;
  type: string;
  payload: any;
  turnId?: string | null;
  ts?: string;
}

/** A locally-known image attachment for a user turn, keyed by turnId. The bytes are the
 *  browser's own object URL from the just-sent upload — the runner echoes only the text,
 *  so the composer hands these in to show the sent image inside the user's bubble. */
export interface TurnImage {
  url: string;
  mime: string;
}

// ── grouped transcript tree ────────────────────────────────────────────────
// The raw event stream is flat. Two relationships have to be reconstructed to
// render like Claude Code: a tool_result belongs to its tool_use, and every
// event a sub-agent produced (Task tool) carries the spawning call's id in
// payload.parentToolUseId and must nest under that call.

type ToolNode = {
  kind: 'tool';
  seq: number;
  id: string;
  name: string;
  input: any;
  result?: { content: any; isError?: boolean };
  children: Node[];
};
type TextNode = {
  kind: 'user' | 'assistant' | 'thinking';
  seq: number;
  text: string;
  // Local previews of images the composer just sent (object URLs, shown instantly).
  images?: TurnImage[];
  // Durable refs from the persisted `user` event — fetched on demand so a turn's images
  // survive a reload (and show on the seeded first turn, which has no local preview).
  imageRefs?: { id: string }[];
};
type ResultNode = { kind: 'result'; seq: number; content: any; isError?: boolean };
type MarkerNode = { kind: 'divider' | 'interrupt'; seq: number };
type ErrorNode = { kind: 'error'; seq: number; message: string };
type Node = ToolNode | TextNode | ResultNode | MarkerNode | ErrorNode;

function buildNodes(events: RunEvent[], turnImages?: Record<string, TurnImage[]>): Node[] {
  const roots: Node[] = [];
  const byId = new Map<string, ToolNode>();
  // Legacy transcripts (pre-id) carry no tool_use id / tool_result toolUseId, so a
  // result can't be matched by id. Fall back to the most recently opened tool that
  // still has no result — results arrive right after their call in those streams.
  let lastOpenTool: ToolNode | undefined;
  // Sub-agent events land inside their spawning Task's children; everything else
  // (and any event whose parent we haven't seen) goes to the top level.
  const into = (parentId?: string): Node[] => {
    if (parentId) {
      const t = byId.get(parentId);
      if (t) return t.children;
    }
    return roots;
  };

  for (const ev of events) {
    const p = ev.payload ?? {};
    const parent: string | undefined = p.parentToolUseId;
    switch (ev.type) {
      case 'user': {
        // The composer's just-sent previews join in by turnId (instant, local object URLs);
        // the runner also echoes durable image refs in the event payload, used when there's
        // no local preview (after a reload, or the server-seeded first turn). An image-only
        // turn has empty text, so still render a bubble when there are images for it.
        const imgs = ev.turnId ? turnImages?.[ev.turnId] : undefined;
        const refs: { id: string }[] | undefined = Array.isArray(p.images)
          ? p.images.filter((im: any) => im && typeof im.id === 'string').map((im: any) => ({ id: String(im.id) }))
          : undefined;
        if (p.text || (imgs && imgs.length) || (refs && refs.length)) {
          into(parent).push({
            kind: 'user',
            seq: ev.seq,
            text: p.text ? String(p.text) : '',
            images: imgs,
            imageRefs: refs,
          });
        }
        break;
      }
      case 'assistant':
        if (p.text) into(parent).push({ kind: 'assistant', seq: ev.seq, text: String(p.text) });
        break;
      case 'thinking':
        if (p.text) into(parent).push({ kind: 'thinking', seq: ev.seq, text: String(p.text) });
        break;
      case 'tool_use': {
        const node: ToolNode = {
          kind: 'tool',
          seq: ev.seq,
          id: String(p.id ?? ''),
          name: String(p.name ?? 'tool'),
          input: p.input,
          children: [],
        };
        if (node.id) byId.set(node.id, node);
        into(parent).push(node);
        lastOpenTool = node;
        break;
      }
      case 'tool_result': {
        const t =
          (p.toolUseId ? byId.get(String(p.toolUseId)) : undefined) ??
          (lastOpenTool && !lastOpenTool.result ? lastOpenTool : undefined);
        if (t) {
          t.result = { content: p.content, isError: !!p.isError };
          if (t === lastOpenTool) lastOpenTool = undefined;
        } else {
          into(parent).push({ kind: 'result', seq: ev.seq, content: p.content, isError: !!p.isError });
        }
        break;
      }
      // turn_end is emitted only for the top-level turn (never inside a sub-agent).
      case 'turn_end':
        roots.push({ kind: 'divider', seq: ev.seq });
        break;
      case 'interrupt':
        into(parent).push({ kind: 'interrupt', seq: ev.seq });
        break;
      case 'error':
        into(parent).push({ kind: 'error', seq: ev.seq, message: String(p.message ?? 'error') });
        break;
      default:
        break; // system / status — not part of the chat transcript
    }
  }
  return roots;
}

// `live` indicates the session is still streaming, so a tool_use without a
// result yet renders a spinner rather than a (misleading) terminal marker.
//
// memo'd on (events, live): streaming text/thinking deltas and the 4s/15s status
// polls all live in sibling state on AgentView and don't touch `events`, so the
// whole transcript subtree is skipped on those re-renders — it only rebuilds when
// an actual event is appended.
export const Transcript = memo(function Transcript({
  events,
  live,
  turnImages,
}: {
  events: RunEvent[];
  live?: boolean;
  turnImages?: Record<string, TurnImage[]>;
}) {
  const nodes = useMemo(() => buildNodes(events, turnImages), [events, turnImages]);
  return (
    <>
      {nodes.map((n) => (
        <NodeView key={n.seq} node={n} live={live} />
      ))}
    </>
  );
});

function NodeView({ node, live }: { node: Node; live?: boolean }) {
  switch (node.kind) {
    case 'user':
      // User input is kept verbatim (pre-wrap), not Markdown-parsed, so a literal
      // '#' or '*' the user typed isn't reinterpreted. Any images sent with the turn
      // render above the text (an image-only turn has empty text). Prefer the local
      // preview (instant); fall back to fetching the durable refs when there's none.
      return (
        <div className="chat-msg chat-user" data-seq={node.seq}>
          {node.images && node.images.length > 0 ? (
            <div className="chat-images">
              {node.images.map((im, i) => (
                <img key={i} className="chat-image" src={im.url} alt="" />
              ))}
            </div>
          ) : (
            node.imageRefs &&
            node.imageRefs.length > 0 && (
              <div className="chat-images">
                {node.imageRefs.map((r) => (
                  <AttachmentImage key={r.id} id={r.id} />
                ))}
              </div>
            )
          )}
          {node.text}
        </div>
      );
    case 'assistant':
      return <AssistantBubble text={node.text} />;
    case 'thinking':
      return <Thinking text={node.text} />;
    case 'tool':
      return <ToolView node={node} live={live} />;
    case 'result':
      return <ToolResult content={node.content} isError={node.isError} />;
    case 'divider':
      return <div className="chat-turn-divider" />;
    case 'interrupt':
      return <div className="chat-note">⊘ interrupted</div>;
    case 'error':
      return <div className="chat-error">✖ {node.message}</div>;
  }
}

// Renders a past turn's image from its attachment id. The download endpoint is
// bearer-guarded (an <img src> can't carry the token), so fetch the blob and show its
// object URL, revoking it on unmount. Stays blank until loaded (and on error).
function AttachmentImage({ id }: { id: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    let made: string | null = null;
    fetchAttachmentObjectUrl(id)
      .then((u) => {
        if (active) {
          made = u;
          setUrl(u);
        } else {
          URL.revokeObjectURL(u); // unmounted before the fetch resolved
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [id]);
  if (!url) return <span className="chat-image chat-image-loading" />;
  return <img className="chat-image" src={url} alt="" />;
}

// ── Markdown ────────────────────────────────────────────────────────────────
// memo'd on (text, highlight): when a new event is appended the tree is rebuilt and
// every node object is new, but unchanged text compares equal by value, so the
// react-markdown AST isn't re-parsed for messages that didn't change.
// `highlight` is off while streaming — re-highlighting the whole doc on every chunk
// is the expensive part, and code isn't complete mid-stream anyway.
export const MD = memo(function MD({ children, highlight = true }: { children: string; highlight?: boolean }) {
  return (
    <div className="md">
      <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={highlight ? [rehypeHighlight] : []}>
        {children}
      </Markdown>
    </div>
  );
});

// Assistant message bubble — the single render path shared by the finalized
// transcript node and the live streaming draft, so both look and behave identically.
// While streaming we drop syntax highlighting (see MD) and mark the bubble so the
// blinking caret CSS attaches.
export function AssistantBubble({ text, streaming }: { text: string; streaming?: boolean }) {
  return (
    <div className={streaming ? 'chat-msg chat-assistant chat-streaming-md' : 'chat-msg chat-assistant'}>
      <MD highlight={!streaming}>{text}</MD>
    </div>
  );
}

// Live assistant draft. text_delta chunks arrive every few ms; throttling before
// the markdown re-parse keeps a long, dense answer from re-rendering on every chunk.
// Leading-edge + trailing flush: the first chunk shows immediately and the latest
// text always lands within `ms` of the last update.
export function StreamingMessage({ text }: { text: string }) {
  return <AssistantBubble text={useThrottled(text, 90)} streaming />;
}

function useThrottled(value: string, ms: number): string {
  const [shown, setShown] = useState(value);
  const last = useRef(0);
  const latest = useRef(value);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    latest.current = value;
    const elapsed = Date.now() - last.current;
    if (elapsed >= ms) {
      last.current = Date.now();
      setShown(value);
    } else if (timer.current === undefined) {
      timer.current = setTimeout(() => {
        last.current = Date.now();
        timer.current = undefined;
        setShown(latest.current);
      }, ms - elapsed);
    }
  }, [value, ms]);
  useEffect(() => () => clearTimeout(timer.current), []);
  return shown;
}

// ── thinking (collapsible) ──────────────────────────────────────────────────
function Thinking({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="chat-think">
      <div className="chat-think-head" onClick={() => setOpen((o) => !o)}>
        {open ? <DownOutlined /> : <RightOutlined />} 💭 Thinking
      </div>
      {open && (
        <div className="chat-think-body">
          <MD>{text}</MD>
        </div>
      )}
    </div>
  );
}

// ── tool calls ──────────────────────────────────────────────────────────────
// Each tool renders as a single folded row (icon · name · summary · status);
// clicking expands to show the call body, any sub-agent transcript, and the
// result. Failed calls open by default so an error is never hidden behind a fold.
function ToolView({ node, live }: { node: ToolNode; live?: boolean }) {
  // node.input keeps its reference across tree rebuilds (the source event object is
  // reused when events are appended), so this holds the computed body/icon — and the
  // <Diff>/<MD>/<KeyVals> elements inside it — stable instead of rebuilding each append.
  const { label, summary, summaryMono, body, icon, tone, path, meta } = useMemo(
    () => describeTool(node.name, node.input),
    [node.name, node.input],
  );
  const isSubAgent = node.name === 'Task' || node.name === 'Agent';
  const p = path ? splitPath(path) : null;
  const hasDetail = !!body || node.children.length > 0 || !!node.result;
  // A plan or a question to the user is the point of the turn — open it by
  // default; errors also auto-open.
  const [open, setOpen] = useState(
    !!node.result?.isError || node.name === 'ExitPlanMode' || node.name === 'AskUserQuestion',
  );
  // While an AskUserQuestion is still awaiting the user, the interactive answer
  // card (ApprovalPanel) is shown separately — don't also render this read-only
  // copy in the transcript. Once answered (result arrives) or the session has
  // ended, show it as the historical record (question + the chosen answer).
  if (node.name === 'AskUserQuestion' && live && !node.result) return null;
  return (
    <div
      className={`chat-tool-card chat-tone-${tone ?? 'default'}${isSubAgent ? ' chat-tool-task' : ''}${
        hasDetail && open ? ' is-open' : ''
      }`}
    >
      <div
        className={`chat-tool-row${hasDetail ? '' : ' no-detail'}`}
        onClick={hasDetail ? () => setOpen((o) => !o) : undefined}
      >
        {hasDetail && (
          <span className="chat-tool-caret">{open ? <DownOutlined /> : <RightOutlined />}</span>
        )}
        <span className="chat-tool-icon">{icon}</span>
        <span className="chat-tool-name">{label}</span>
        {p ? (
          <span className="chat-tool-summary mono chat-path" title={path}>
            <b className="chat-path-file">{p.base}</b>
            {p.dir && <span className="chat-path-dir">{p.dir}</span>}
          </span>
        ) : (
          summary && <span className={`chat-tool-summary${summaryMono ? ' mono' : ''}`}>{summary}</span>
        )}
        {meta && <span className="chat-tool-meta">{meta}</span>}
        <ToolStatus node={node} live={live} />
      </div>
      {hasDetail && open && (
        <div className="chat-tool-detail">
          {body && <div className="chat-tool-body">{body}</div>}
          {node.children.length > 0 && (
            <div className="chat-subagent">
              {node.children.map((c) => (
                <NodeView key={c.seq} node={c} live={live} />
              ))}
            </div>
          )}
          {node.result && (
            <ToolResult content={node.result.content} isError={node.result.isError} compact markdown={isSubAgent} />
          )}
        </div>
      )}
    </div>
  );
}

// Folded-row status: spinner while a result is still pending on a live session,
// a neutral dot for an unfinished call on an ended session (e.g. cancelled),
// otherwise success / error.
function ToolStatus({ node, live }: { node: ToolNode; live?: boolean }) {
  if (!node.result) {
    return live ? (
      <LoadingOutlined className="chat-tool-status running" spin />
    ) : (
      <MinusCircleOutlined className="chat-tool-status pending" />
    );
  }
  return node.result.isError ? (
    <CloseCircleFilled className="chat-tool-status err" />
  ) : (
    <CheckCircleFilled className="chat-tool-status ok" />
  );
}

type Tone = 'read' | 'exec' | 'write' | 'agent' | 'default';

type ToolDesc = {
  label: string;
  summary?: string;
  summaryMono?: boolean; // render the summary in monospace (paths/patterns), not prose
  body?: ReactNode;
  icon: ReactNode;
  tone?: Tone; // colour family for the icon chip + card left rail
  path?: string; // a file path → rendered as bold filename + dimmed parent dir
  meta?: string; // small trailing badge (line range, edit count)
};

// describeTool maps a tool name + input to a folded-row label/summary/icon and an
// optional expanded body, roughly matching how Claude Code Web renders each tool.
function describeTool(name: string, input: any): ToolDesc {
  const i = input ?? {};
  switch (name) {
    case 'Bash':
      return { label: 'Bash', icon: <CodeOutlined />, tone: 'exec', summary: i.description, body: <Pre text={String(i.command ?? '')} prompt /> };
    case 'Read':
      return { label: 'Read', icon: <FileTextOutlined />, tone: 'read', path: i.file_path, meta: lineMeta(i.offset, i.limit) };
    case 'Write':
      return {
        label: 'Write',
        icon: <FileAddOutlined />,
        tone: 'write',
        path: i.file_path,
        body: i.content ? <Pre text={String(i.content)} /> : undefined,
      };
    case 'Edit':
      return { label: 'Edit', icon: <EditOutlined />, tone: 'write', path: i.file_path, body: <Diff oldStr={i.old_string} newStr={i.new_string} /> };
    case 'MultiEdit':
      return {
        label: 'MultiEdit',
        icon: <EditOutlined />,
        tone: 'write',
        path: i.file_path,
        meta: `${i.edits?.length ?? 0} edits`,
        body: (
          <>
            {(i.edits ?? []).map((e: any, k: number) => (
              <Diff key={k} oldStr={e.old_string} newStr={e.new_string} />
            ))}
          </>
        ),
      };
    case 'Glob':
      return { label: 'Glob', icon: <FolderOpenOutlined />, tone: 'read', summary: [i.pattern, i.path].filter(Boolean).join('  ·  '), summaryMono: true };
    case 'Grep':
      return { label: 'Grep', icon: <SearchOutlined />, tone: 'read', summary: [i.pattern, i.path, i.glob].filter(Boolean).join('  ·  '), summaryMono: true };
    case 'TodoWrite':
      return { label: 'Todos', icon: <CheckSquareOutlined />, body: <Todos todos={i.todos ?? []} /> };
    case 'WebFetch':
      return { label: 'WebFetch', icon: <GlobalOutlined />, tone: 'read', summary: i.url, summaryMono: true };
    case 'WebSearch':
      return { label: 'WebSearch', icon: <SearchOutlined />, tone: 'read', summary: i.query };
    case 'ToolSearch':
      return { label: 'ToolSearch', icon: <ApiOutlined />, tone: 'read', summary: i.query, summaryMono: true, body: hasKeys(i) ? <KeyVals obj={i} /> : undefined };
    case 'Task':
    case 'Agent':
      return {
        label: `${name}${i.subagent_type ? ` · ${i.subagent_type}` : ''}`,
        icon: <PartitionOutlined />,
        tone: 'agent',
        summary: i.description,
        body: i.prompt ? (
          <div className="chat-tool-prompt">
            <MD>{String(i.prompt)}</MD>
          </div>
        ) : undefined,
      };
    case 'ExitPlanMode':
      // The plan is Markdown meant to be read — render it like Task's prompt,
      // not as a raw key/value blob via the default branch.
      return {
        label: 'Plan',
        icon: <FileTextOutlined />,
        tone: 'agent',
        body: i.plan ? (
          <div className="chat-tool-prompt">
            <MD>{String(i.plan)}</MD>
          </div>
        ) : undefined,
      };
    case 'AskUserQuestion': {
      // A multiple-choice prompt to the user — render each question as a card
      // (header · question · options) instead of dumping the nested questions
      // array as a raw JSON blob via the default branch.
      const qs: any[] = Array.isArray(i.questions) ? i.questions : [];
      return {
        label: 'Question',
        icon: <QuestionCircleOutlined />,
        tone: 'agent',
        summary: qs.map((q) => q?.header).filter(Boolean).join('  ·  ') || undefined,
        body: qs.length ? <Questions questions={qs} /> : undefined,
      };
    }
    default:
      if (name.startsWith('mcp__')) {
        return {
          label: name.replace(/^mcp__/, '').replace(/__/g, ' · '),
          icon: <ApiOutlined />,
          summary: kvSummary(i),
          summaryMono: true,
          body: hasKeys(i) ? <KeyVals obj={i} /> : undefined,
        };
      }
      return { label: name, icon: <ToolOutlined />, summary: kvSummary(i), summaryMono: true, body: hasKeys(i) ? <KeyVals obj={i} /> : undefined };
  }
}

function ToolResult({
  content,
  isError,
  compact,
  markdown,
}: {
  content: any;
  isError?: boolean;
  compact?: boolean;
  // A Task (sub-agent) result is the agent's prose report — render it as Markdown,
  // like Claude Code Web, rather than raw monospace. Raw tool output stays monospace.
  markdown?: boolean;
}) {
  const text = resultText(content);
  // A successful tool with no textual output renders nothing; but an error with no
  // output must still surface — otherwise a failed tool looks like it never ran.
  if (!text && !isError) return null;
  return (
    <div className={`chat-result${isError ? ' is-error' : ''}${compact ? ' compact' : ''}`}>
      {!text ? (
        <div className="chat-result-empty">✖ error</div>
      ) : markdown && !isError ? (
        <MD>{text}</MD>
      ) : (
        <>
          {compact && <div className="chat-result-label">{isError ? 'error' : 'output'}</div>}
          <Pre text={text} threshold={12} muted />
        </>
      )}
    </div>
  );
}

// ── primitives ──────────────────────────────────────────────────────────────
// Pre renders monospace text and collapses past `threshold` lines (Read output,
// long commands, JSON blobs) so one tool call can't flood the transcript.
// `prompt` prefixes a shell `$` for Bash commands.
function Pre({
  text,
  threshold = 16,
  muted,
  prompt,
}: {
  text: string;
  threshold?: number;
  muted?: boolean;
  prompt?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const lines = text.split('\n');
  const hidden = Math.max(0, lines.length - threshold);
  const long = hidden > 0;
  const shown = open || !long ? text : lines.slice(0, threshold).join('\n');
  return (
    <div className={`chat-pre-wrap${muted ? ' muted' : ''}${prompt ? ' cmd' : ''}`}>
      <pre className="chat-pre">
        {prompt && <span className="chat-cmd-prompt">$ </span>}
        {shown}
      </pre>
      {long && (
        <button className="chat-more" onClick={() => setOpen((o) => !o)}>
          {open ? 'Show less' : `Show ${hidden} more lines`}
        </button>
      )}
    </div>
  );
}

// ── edit diff ─────────────────────────────────────────────────────────────--
type DiffRow = { type: 'ctx' | 'del' | 'add'; text: string };
type RenderRow = DiffRow | { type: 'gap'; n: number };

// Line-level LCS diff: unchanged lines become context, so a one-line change in a
// 30-line block shows ~3 context lines around it instead of 30 red + 30 green.
function lineDiff(oldStr: string, newStr: string): DiffRow[] {
  const a = oldStr.split('\n');
  const b = newStr.split('\n');
  const n = a.length;
  const m = b.length;
  // Bail out to a plain del/add dump on pathologically large inputs — the LCS
  // table is O(n·m) and not worth it for a giant generated edit.
  if (n * m > 250_000) {
    return [...a.map((t): DiffRow => ({ type: 'del', text: t })), ...b.map((t): DiffRow => ({ type: 'add', text: t }))];
  }
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let x = n - 1; x >= 0; x--) {
    for (let y = m - 1; y >= 0; y--) {
      dp[x][y] = a[x] === b[y] ? dp[x + 1][y + 1] + 1 : Math.max(dp[x + 1][y], dp[x][y + 1]);
    }
  }
  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      rows.push({ type: 'ctx', text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      rows.push({ type: 'del', text: a[i++] });
    } else {
      rows.push({ type: 'add', text: b[j++] });
    }
  }
  while (i < n) rows.push({ type: 'del', text: a[i++] });
  while (j < m) rows.push({ type: 'add', text: b[j++] });
  return rows;
}

// Collapse long runs of unchanged context, keeping `ctx` lines next to each
// change so the diff reads like a unified hunk rather than the whole file.
function collapseCtx(rows: DiffRow[], ctx: number): RenderRow[] {
  const out: RenderRow[] = [];
  let i = 0;
  while (i < rows.length) {
    if (rows[i].type !== 'ctx') {
      out.push(rows[i]);
      i++;
      continue;
    }
    let j = i;
    while (j < rows.length && rows[j].type === 'ctx') j++;
    const run = rows.slice(i, j);
    const head = i === 0 ? 0 : ctx; // no leading context before the first change
    const tail = j === rows.length ? 0 : ctx; // none after the last change
    if (run.length > head + tail + 1) {
      for (let k = 0; k < head; k++) out.push(run[k]);
      out.push({ type: 'gap', n: run.length - head - tail });
      for (let k = run.length - tail; k < run.length; k++) out.push(run[k]);
    } else {
      for (const r of run) out.push(r);
    }
    i = j;
  }
  return out;
}

function Diff({ oldStr, newStr }: { oldStr?: string; newStr?: string }) {
  const rows = useMemo(
    () => collapseCtx(lineDiff(String(oldStr ?? ''), String(newStr ?? '')), 3),
    [oldStr, newStr],
  );
  // Hunk-relative line numbers (Edit payloads carry no file offset, so these can't
  // be real file lines) — a light gutter just to keep the two sides aligned.
  let oldNo = 0;
  let newNo = 0;
  return (
    <div className="chat-diff">
      {rows.map((r, k) => {
        if (r.type === 'gap') {
          oldNo += r.n;
          newNo += r.n;
          return (
            <div key={k} className="diff-line diff-gap">
              <span className="diff-gutter" />
              <span className="diff-text">⋯ {r.n} unchanged {r.n === 1 ? 'line' : 'lines'} ⋯</span>
            </div>
          );
        }
        const o = r.type !== 'add' ? ++oldNo : undefined;
        const nw = r.type !== 'del' ? ++newNo : undefined;
        const sign = r.type === 'del' ? '-' : r.type === 'add' ? '+' : ' ';
        return (
          <div key={k} className={`diff-line diff-${r.type}`}>
            <span className="diff-ln">{o ?? ''}</span>
            <span className="diff-ln">{nw ?? ''}</span>
            <span className="diff-sign">{sign}</span>
            <span className="diff-text">{r.text}</span>
          </div>
        );
      })}
    </div>
  );
}

function Todos({ todos }: { todos: any[] }) {
  const mark = (s: string): string => (s === 'completed' ? '✔' : s === 'in_progress' ? '◐' : '○');
  return (
    <div className="chat-todos">
      {todos.map((t: any, k: number) => (
        <div key={k} className={`todo todo-${t.status}`}>
          <span className="todo-mark">{mark(t.status)}</span>
          <span>{t.content ?? t.activeForm ?? ''}</span>
        </div>
      ))}
    </div>
  );
}

// Questions renders an AskUserQuestion input: each question as a card with its
// header, prompt text, and the selectable options (label + description).
function Questions({ questions }: { questions: any[] }) {
  return (
    <div className="chat-questions">
      {questions.map((q: any, k: number) => (
        <div className="chat-q" key={k}>
          {q?.header && <div className="chat-q-header">{q.header}</div>}
          {q?.question && <div className="chat-q-text">{String(q.question)}</div>}
          <div className="chat-q-opts">
            {(q?.options ?? []).map((o: any, j: number) => (
              <div className="chat-q-opt" key={j}>
                <span className="chat-q-opt-label">{o?.label ?? ''}</span>
                {o?.description && <span className="chat-q-opt-desc">{o.description}</span>}
              </div>
            ))}
          </div>
          {q?.multiSelect && <div className="chat-q-multi">multi-select</div>}
        </div>
      ))}
    </div>
  );
}

// KeyVals renders an unknown tool's input as a compact key/value table instead of
// a raw JSON blob — scalars inline, nested objects/arrays as collapsible JSON.
function KeyVals({ obj }: { obj: any }) {
  const entries = obj && typeof obj === 'object' ? Object.entries(obj) : [];
  return (
    <div className="chat-kv">
      {entries.map(([k, v]) => (
        <div className="kv-row" key={k}>
          <span className="kv-key">{k}</span>
          {v !== null && typeof v === 'object' ? (
            <Pre text={safeJson(v)} threshold={12} muted />
          ) : (
            <span className="kv-val">{String(v)}</span>
          )}
        </div>
      ))}
    </div>
  );
}

// ── helpers ─────────────────────────────────────────────────────────────────
const hasKeys = (o: any): boolean => !!o && typeof o === 'object' && Object.keys(o).length > 0;

// Pick a representative field from an unknown tool's input for the folded summary.
const SUMMARY_KEYS = ['query', 'name', 'file_path', 'path', 'url', 'pattern', 'command'];
function kvSummary(o: any): string | undefined {
  if (!o || typeof o !== 'object') return undefined;
  for (const k of SUMMARY_KEYS) {
    if (typeof o[k] === 'string' && o[k]) return o[k];
  }
  for (const v of Object.values(o)) {
    if (typeof v === 'string' && v) return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  }
  return undefined;
}

// Split a file path into a bold leaf filename + a dimmed, abbreviated parent dir
// (…/<last segment>/) so the row leads with the file, not the long absolute path.
// The full path stays available on hover via the row's title attribute.
function splitPath(path: string): { base: string; dir: string } {
  const clean = path.replace(/\/+$/, '');
  const cut = clean.lastIndexOf('/');
  if (cut < 0) return { base: clean, dir: '' };
  const segs = clean.slice(0, cut).split('/').filter(Boolean);
  return { base: clean.slice(cut + 1), dir: segs.length ? `…/${segs[segs.length - 1]}/` : '/' };
}

// Read's offset/limit → a compact line-range badge (e.g. L240–400) instead of an
// inline "(from 240, 160 lines)" tail on the path.
function lineMeta(offset?: number, limit?: number): string | undefined {
  if (!offset && !limit) return undefined;
  const start = offset ?? 0;
  return limit ? `L${start}–${start + limit}` : `L${start}+`;
}

const safeJson = (v: any): string => {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
};

// A tool_result's content is either a string or an array of content blocks
// (text/image/...). Flatten it to displayable text.
function resultText(content: any): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b: any) => {
        if (typeof b === 'string') return b;
        if (b && b.type === 'text') return b.text ?? '';
        if (b && b.type === 'image') return '[image]';
        return safeJson(b);
      })
      .join('\n');
  }
  return safeJson(content);
}
