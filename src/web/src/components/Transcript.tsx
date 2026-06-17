import { DownOutlined, RightOutlined } from '@ant-design/icons';
import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
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
  ts?: string;
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
type TextNode = { kind: 'user' | 'assistant' | 'thinking'; seq: number; text: string };
type ResultNode = { kind: 'result'; seq: number; content: any; isError?: boolean };
type MarkerNode = { kind: 'divider' | 'interrupt'; seq: number };
type ErrorNode = { kind: 'error'; seq: number; message: string };
type Node = ToolNode | TextNode | ResultNode | MarkerNode | ErrorNode;

function buildNodes(events: RunEvent[]): Node[] {
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
      case 'user':
        if (p.text) into(parent).push({ kind: 'user', seq: ev.seq, text: String(p.text) });
        break;
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

export function Transcript({ events }: { events: RunEvent[] }) {
  const nodes = useMemo(() => buildNodes(events), [events]);
  return (
    <>
      {nodes.map((n) => (
        <NodeView key={n.seq} node={n} />
      ))}
    </>
  );
}

function NodeView({ node }: { node: Node }) {
  switch (node.kind) {
    case 'user':
      // User input is kept verbatim (pre-wrap), not Markdown-parsed, so a literal
      // '#' or '*' the user typed isn't reinterpreted.
      return <div className="chat-msg chat-user">{node.text}</div>;
    case 'assistant':
      return (
        <div className="chat-msg chat-assistant">
          <MD>{node.text}</MD>
        </div>
      );
    case 'thinking':
      return <Thinking text={node.text} />;
    case 'tool':
      return <ToolView node={node} />;
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

// ── Markdown ────────────────────────────────────────────────────────────────
export function MD({ children }: { children: string }) {
  return (
    <div className="md">
      <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
        {children}
      </Markdown>
    </div>
  );
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
function ToolView({ node }: { node: ToolNode }) {
  const { label, summary, body } = describeTool(node.name, node.input);
  const isTask = node.name === 'Task';
  return (
    <div className={`chat-tool-card${isTask ? ' chat-tool-task' : ''}`}>
      <div className="chat-tool-head">
        <span className="chat-tool-name">{label}</span>
        {summary && <span className="chat-tool-summary">{summary}</span>}
      </div>
      {body && <div className="chat-tool-body">{body}</div>}
      {node.children.length > 0 && (
        <div className="chat-subagent">
          {node.children.map((c) => (
            <NodeView key={c.seq} node={c} />
          ))}
        </div>
      )}
      {node.result && (
        <ToolResult content={node.result.content} isError={node.result.isError} compact markdown={isTask} />
      )}
    </div>
  );
}

// describeTool maps a tool name + input to a compact header and an optional body,
// roughly matching how Claude Code Web renders each built-in tool.
function describeTool(name: string, input: any): { label: string; summary?: string; body?: ReactNode } {
  const i = input ?? {};
  switch (name) {
    case 'Bash':
      return { label: 'Bash', summary: i.description, body: <Pre text={String(i.command ?? '')} /> };
    case 'Read':
      return { label: 'Read', summary: fileLabel(i.file_path, i.offset, i.limit) };
    case 'Write':
      return {
        label: 'Write',
        summary: i.file_path,
        body: i.content ? <Pre text={String(i.content)} /> : undefined,
      };
    case 'Edit':
      return { label: 'Edit', summary: i.file_path, body: <Diff oldStr={i.old_string} newStr={i.new_string} /> };
    case 'MultiEdit':
      return {
        label: 'MultiEdit',
        summary: `${i.file_path ?? ''} · ${(i.edits?.length ?? 0)} edits`,
        body: (
          <>
            {(i.edits ?? []).map((e: any, k: number) => (
              <Diff key={k} oldStr={e.old_string} newStr={e.new_string} />
            ))}
          </>
        ),
      };
    case 'Glob':
      return { label: 'Glob', summary: [i.pattern, i.path].filter(Boolean).join('  ·  ') };
    case 'Grep':
      return { label: 'Grep', summary: [i.pattern, i.path, i.glob].filter(Boolean).join('  ·  ') };
    case 'TodoWrite':
      return { label: 'Todos', body: <Todos todos={i.todos ?? []} /> };
    case 'WebFetch':
      return { label: 'WebFetch', summary: i.url };
    case 'WebSearch':
      return { label: 'WebSearch', summary: i.query };
    case 'Task':
      return {
        label: `Task${i.subagent_type ? ` · ${i.subagent_type}` : ''}`,
        summary: i.description,
        body: i.prompt ? (
          <div className="chat-tool-prompt">
            <MD>{String(i.prompt)}</MD>
          </div>
        ) : undefined,
      };
    default:
      if (name.startsWith('mcp__')) {
        return { label: name.replace(/^mcp__/, '').replace(/__/g, ' · '), body: <Pre text={safeJson(i)} /> };
      }
      return { label: name, body: hasKeys(i) ? <Pre text={safeJson(i)} /> : undefined };
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
        <Pre text={text} threshold={8} muted />
      )}
    </div>
  );
}

// ── primitives ──────────────────────────────────────────────────────────────
// Pre renders monospace text and collapses past `threshold` lines (Read output,
// long commands, JSON blobs) so one tool call can't flood the transcript.
function Pre({
  text,
  threshold = 16,
  muted,
}: {
  text: string;
  threshold?: number;
  muted?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const lines = text.split('\n');
  const hidden = Math.max(0, lines.length - threshold);
  const long = hidden > 0;
  const shown = open || !long ? text : lines.slice(0, threshold).join('\n');
  return (
    <div className={muted ? 'chat-pre-wrap muted' : 'chat-pre-wrap'}>
      <pre className="chat-pre">{shown}</pre>
      {long && (
        <button className="chat-more" onClick={() => setOpen((o) => !o)}>
          {open ? 'Show less' : `Show ${hidden} more lines`}
        </button>
      )}
    </div>
  );
}

function Diff({ oldStr, newStr }: { oldStr?: string; newStr?: string }) {
  // An empty side (pure insertion or deletion) renders no rows — '' .split('\n')
  // would otherwise yield one misleading blank -/+ line.
  const del = oldStr ? String(oldStr).split('\n') : [];
  const add = newStr ? String(newStr).split('\n') : [];
  return (
    <pre className="chat-diff">
      {del.map((l, k) => (
        <div key={`d${k}`} className="diff-del">
          - {l}
        </div>
      ))}
      {add.map((l, k) => (
        <div key={`a${k}`} className="diff-add">
          + {l}
        </div>
      ))}
    </pre>
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

// ── helpers ─────────────────────────────────────────────────────────────────
const hasKeys = (o: any): boolean => !!o && typeof o === 'object' && Object.keys(o).length > 0;

function fileLabel(path?: string, offset?: number, limit?: number): string | undefined {
  if (!path) return undefined;
  if (offset || limit) return `${path}  (from ${offset ?? 0}${limit ? `, ${limit} lines` : ''})`;
  return path;
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
