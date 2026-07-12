import {
  ApiOutlined,
  CheckCircleFilled,
  CheckOutlined,
  CheckSquareOutlined,
  CloseCircleFilled,
  CodeOutlined,
  ConsoleSqlOutlined,
  CopyOutlined,
  DownOutlined,
  EditOutlined,
  EyeOutlined,
  FileAddOutlined,
  FileTextOutlined,
  FolderOpenOutlined,
  GlobalOutlined,
  LoadingOutlined,
  MinusCircleOutlined,
  PaperClipOutlined,
  PartitionOutlined,
  QuestionCircleOutlined,
  RightOutlined,
  SearchOutlined,
  ToolOutlined,
} from '@ant-design/icons';
import { Image } from 'antd';
import { createContext, isValidElement, memo, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { isApiErrorText } from '@orbit/shared';
import { fetchAttachmentObjectUrl, fetchSessionArtifactObjectUrl } from '../api';
import { stripAnsi } from '../lib/ansi';

// How a transcript fetches an attachment's bytes (as an object URL). Defaults to the
// bearer-guarded owner route; the public shared page overrides it with the share-token route
// so a logged-out viewer can still see inline images. See SharedSessionPage.
export const AttachmentResolverContext =
  createContext<(id: string) => Promise<string>>(fetchAttachmentObjectUrl);

export const ArtifactResolverContext =
  createContext<((artifactPath: string) => Promise<string>) | null>(null);
import Markdown, { defaultUrlTransform } from 'react-markdown';
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

// When present, the transcript is being serialized to a standalone HTML file (see
// lib/sessionExport). A static file has no JS, so collapsibles must render expanded —
// otherwise their content sits behind a dead, un-clickable fold and is simply lost — and
// images must resolve from a pre-fetched data-URL map instead of the live bearer fetch.
// The context is null in the running app, so every reader below is a no-op there.
export interface ExportMode {
  images: Map<string, string>; // attachment id → base64 data URL
}
export const ExportCtx = createContext<ExportMode | null>(null);

// ── session-wide image preview ──────────────────────────────────────────────
// Every image thumbnail in the transcript (user-sent, durable attachment, tool
// result) registers here so one full-screen lightbox can page across all of them
// with the left/right arrows — clicking any thumbnail opens the group at that
// image. Order is by event `seq`, not mount order: durable attachments resolve
// their blobs asynchronously and scroll-up paging prepends older turns, so
// registration order ≠ visual order; sorting by seq keeps the pager in transcript
// order regardless. A thumbnail registers only once its src is ready (an
// attachment registers after its blob resolves), so the pager never shows a blank
// slide. When this context is absent (the composer's unsent previews, the static
// HTML export) ChatImage falls back to its own standalone single-image preview.
type PreviewRegistry = {
  register: (key: string, order: number, src: string) => void;
  unregister: (key: string) => void;
  open: (key: string) => void;
};
const ImagePreviewContext = createContext<PreviewRegistry | null>(null);

function ImagePreviewProvider({ children }: { children: ReactNode }) {
  const entries = useRef(new Map<string, { order: number; src: string }>());
  const [state, setState] = useState<{ visible: boolean; current: number; items: string[] }>({
    visible: false,
    current: 0,
    items: [],
  });
  const registry = useMemo<PreviewRegistry>(
    () => ({
      register: (key, order, src) => {
        entries.current.set(key, { order, src });
      },
      unregister: (key) => {
        entries.current.delete(key);
      },
      // Snapshot the images in seq order at click time and open the group at the
      // clicked one; images arriving mid-preview needn't join the frozen set.
      open: (key) => {
        const sorted = [...entries.current.entries()].sort((a, b) => a[1].order - b[1].order);
        const current = sorted.findIndex(([k]) => k === key);
        if (current < 0) return;
        setState({ visible: true, current, items: sorted.map(([, v]) => v.src) });
      },
    }),
    [],
  );
  return (
    <ImagePreviewContext.Provider value={registry}>
      {children}
      <Image.PreviewGroup
        items={state.items}
        preview={{
          visible: state.visible,
          current: state.current,
          onVisibleChange: (v) => setState((s) => ({ ...s, visible: v })),
          onChange: (current) => setState((s) => ({ ...s, current })),
        }}
      />
    </ImagePreviewContext.Provider>
  );
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
  // Wall-clock of the source event — carried for user turns to show a relative
  // timestamp ("1w ago") under the bubble.
  ts?: string;
  // Local previews of images the composer just sent (object URLs, shown instantly).
  images?: TurnImage[];
  // Durable refs from the persisted `user` event — fetched on demand so a turn's
  // attachments survive a reload (and show on the seeded first turn, which has no local
  // preview). Images render inline; non-image files render as a downloadable chip.
  attachmentRefs?: { id: string; mime?: string; name?: string }[];
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
        // New events echo `attachments` (id+mime+name, any type); older ones echo `images`
        // (id only, all images). Carry mime/name through so the bubble can tell an inline
        // image from a downloadable file.
        const rawRefs: any[] | undefined = Array.isArray(p.attachments)
          ? p.attachments
          : Array.isArray(p.images)
            ? p.images
            : undefined;
        const refs = rawRefs
          ?.filter((a) => a && typeof a.id === 'string')
          .map((a) => ({
            id: String(a.id),
            mime: typeof a.mime === 'string' ? a.mime : undefined,
            name: typeof a.name === 'string' ? a.name : undefined,
          }));
        if (p.text || (imgs && imgs.length) || (refs && refs.length)) {
          into(parent).push({
            kind: 'user',
            seq: ev.seq,
            text: p.text ? String(p.text) : '',
            ts: ev.ts,
            images: imgs,
            attachmentRefs: refs,
          });
        }
        break;
      }
      case 'assistant':
        if (p.text) {
          const text = String(p.text);
          // A Claude API error (e.g. content filtering) comes back as an assistant text
          // block, not an `error` event — render it as an error so the failed turn is
          // unmistakable instead of looking like a normal reply.
          if (isApiErrorText(text)) into(parent).push({ kind: 'error', seq: ev.seq, message: text });
          else into(parent).push({ kind: 'assistant', seq: ev.seq, text });
        }
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
  artifactSessionId,
}: {
  events: RunEvent[];
  live?: boolean;
  turnImages?: Record<string, TurnImage[]>;
  artifactSessionId?: string;
}) {
  const nodes = useMemo(() => buildNodes(events, turnImages), [events, turnImages]);
  const artifactResolve = useMemo(
    () =>
      artifactSessionId ? (artifactPath: string) => fetchSessionArtifactObjectUrl(artifactSessionId, artifactPath) : null,
    [artifactSessionId],
  );
  const body = (
    <ImagePreviewProvider>
      <NodeList nodes={nodes} live={live} />
    </ImagePreviewProvider>
  );
  return artifactResolve ? (
    <ArtifactResolverContext.Provider value={artifactResolve}>{body}</ArtifactResolverContext.Provider>
  ) : (
    body
  );
});

const TOOL_GROUP_MIN = 3;

type NodeListItem = { kind: 'node'; node: Node } | { kind: 'toolGroup'; key: string; nodes: ToolNode[] };

function NodeList({ nodes, live }: { nodes: Node[]; live?: boolean }) {
  const items = useMemo(() => groupToolRuns(nodes), [nodes]);
  return (
    <>
      {items.map((item) =>
        item.kind === 'toolGroup' ? (
          <ToolGroupView key={item.key} nodes={item.nodes} live={live} />
        ) : (
          <NodeView key={item.node.seq} node={item.node} live={live} />
        ),
      )}
    </>
  );
}

function groupToolRuns(nodes: Node[]): NodeListItem[] {
  const out: NodeListItem[] = [];
  let run: ToolNode[] = [];
  const flush = () => {
    if (run.length >= TOOL_GROUP_MIN) {
      out.push({ kind: 'toolGroup', key: `tool-group-${run[0].seq}`, nodes: run });
    } else {
      out.push(...run.map((node) => ({ kind: 'node' as const, node })));
    }
    run = [];
  };

  for (const node of nodes) {
    if (isGroupableTool(node)) {
      run.push(node);
      continue;
    }
    flush();
    out.push({ kind: 'node', node });
  }
  flush();
  return out;
}

function isGroupableTool(node: Node): node is ToolNode {
  return (
    node.kind === 'tool' &&
    node.children.length === 0 &&
    !node.id.startsWith('shell-') &&
    node.name !== 'AskUserQuestion' &&
    node.name !== 'ExitPlanMode'
  );
}

function NodeView({ node, live }: { node: Node; live?: boolean }) {
  switch (node.kind) {
    case 'user':
      return <UserBubble node={node} />;
    case 'assistant':
      return <AssistantBubble text={node.text} />;
    case 'thinking':
      return <Thinking text={node.text} />;
    case 'tool':
      return <ToolView node={node} live={live} />;
    case 'result':
      return <ToolResult seq={node.seq} content={node.content} isError={node.isError} />;
    case 'divider':
      return <div className="chat-turn-divider" />;
    case 'interrupt':
      return <div className="chat-note">⊘ interrupted</div>;
    case 'error':
      return <div className="chat-error">✖ {node.message}</div>;
  }
}

// Collapse a user bubble past this many characters: a pasted blob would otherwise lay out as
// one giant pre-wrap node and stall the transcript. The composer caps input well above this;
// resumed/old sessions can still carry big messages.
const USER_BUBBLE_TRUNCATE = 6000;

// User message bubble. Input is kept verbatim (pre-wrap), not Markdown-parsed, so a
// literal '#' or '*' the user typed isn't reinterpreted. Any images sent with the turn
// render above the text (an image-only turn has empty text) — prefer the local preview
// (instant), falling back to the durable refs when there's none. Below the bubble a
// right-aligned meta row (copy button · relative time) fades in on hover, like Claude;
// it's absolutely positioned so it never adds height, and lives inside the hover wrap so
// the pointer can travel down onto it without dismissing it (CSS :hover hits ancestors).
function UserBubble({ node }: { node: TextNode }) {
  const exp = useContext(ExportCtx);
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const longText = node.text.length > USER_BUBBLE_TRUNCATE;
  const shownText = longText && !expanded && !exp ? node.text.slice(0, USER_BUBBLE_TRUNCATE) : node.text;
  const copy = () => {
    void navigator.clipboard?.writeText(node.text)?.catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };
  // Inline images come from the instant local previews when present, else from durable refs
  // (fetched on demand); non-image files always render as a downloadable chip.
  const localImgs = node.images && node.images.length ? node.images : undefined;
  const refs = node.attachmentRefs ?? [];
  const imgRefs = localImgs ? [] : refs.filter((r) => !r.mime || r.mime.startsWith('image/'));
  const fileRefs = refs.filter((r) => r.mime && !r.mime.startsWith('image/'));
  return (
    <div className="chat-user-wrap">
      <div className="chat-msg chat-user" data-seq={node.seq}>
        {localImgs && (
          <div className="chat-images">
            {localImgs.map((im, i) => (
              <ChatImage key={i} src={im.url} previewKey={`u${node.seq}-l${i}`} order={node.seq * 1e4 + i} />
            ))}
          </div>
        )}
        {imgRefs.length > 0 && (
          <div className="chat-images">
            {imgRefs.map((r, i) => (
              <AttachmentImage key={r.id} id={r.id} previewKey={`u${node.seq}-a${r.id}`} order={node.seq * 1e4 + i} />
            ))}
          </div>
        )}
        {fileRefs.length > 0 && (
          <div className="chat-files">
            {fileRefs.map((r) => (
              <AttachmentFile key={r.id} id={r.id} name={r.name} />
            ))}
          </div>
        )}
        {shownText}
      </div>
      {longText && !exp && (
        <button className="chat-more" onClick={() => setExpanded((e) => !e)}>
          {expanded
            ? 'Show less'
            : `Show ${(node.text.length - USER_BUBBLE_TRUNCATE).toLocaleString()} more characters`}
        </button>
      )}
      {node.text && (
        <div className="chat-user-meta">
          <button
            type="button"
            className="chat-copy"
            onClick={copy}
            title={copied ? 'Copied' : 'Copy message'}
            aria-label={copied ? 'Copied' : 'Copy message'}
          >
            {copied ? <CheckOutlined /> : <CopyOutlined />}
          </button>
          {node.ts && <span className="chat-time">{relTime(node.ts)}</span>}
        </div>
      )}
    </div>
  );
}

// Relative timestamp under a user bubble ("just now", "5m ago", "3h ago", "2d ago",
// "1w ago"); older than ~4 weeks falls back to a short absolute month/day.
function relTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const diff = Date.now() - t;
  const min = 60_000;
  const hour = 60 * min;
  const day = 24 * hour;
  const week = 7 * day;
  if (diff < min) return 'just now';
  if (diff < hour) return `${Math.floor(diff / min)}m ago`;
  if (diff < day) return `${Math.floor(diff / hour)}h ago`;
  if (diff < week) return `${Math.floor(diff / day)}d ago`;
  if (diff < 4 * week) return `${Math.floor(diff / week)}w ago`;
  return new Date(t).toLocaleDateString([], { month: 'numeric', day: 'numeric' });
}

// Renders a past turn's image from its attachment id. The download endpoint is
// bearer-guarded (an <img src> can't carry the token), so fetch the blob and show its
// object URL, revoking it on unmount. Stays blank until loaded (and on error).
export function AttachmentImage({ id, previewKey, order }: { id: string; previewKey?: string; order?: number }) {
  return (
    <ResolvedAttachmentImage
      id={id}
      className="chat-image"
      alt="Image sent by user"
      loadingClassName="chat-image chat-image-loading"
      previewKey={previewKey}
      order={order}
    />
  );
}

function ResolvedAttachmentImage({
  id,
  className,
  alt,
  loadingClassName,
  previewKey,
  order,
}: {
  id: string;
  className: string;
  alt: string;
  loadingClassName: string;
  previewKey?: string;
  order?: number;
}) {
  const resolve = useContext(AttachmentResolverContext);
  const exp = useContext(ExportCtx);
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (exp) return; // export: bytes are pre-resolved into the data-URL map, no live fetch
    let active = true;
    let made: string | null = null;
    resolve(id)
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
  }, [id, resolve, exp]);
  if (exp) {
    const data = exp.images.get(id);
    return data ? <ChatImage src={data} className={className} alt={alt} /> : <span className={loadingClassName} />;
  }
  if (!url) return <span className={loadingClassName} />;
  return <ChatImage src={url} className={className} alt={alt} previewKey={previewKey} order={order} />;
}

// A non-image file the user sent: a chip that downloads the blob on click (the download
// endpoint is bearer-guarded, so a plain <a href> would 401 — fetch with the token, then
// trigger a download from the object URL). The bytes are fetched only when clicked.
export function AttachmentFile({ id, name }: { id: string; name?: string }) {
  const resolve = useContext(AttachmentResolverContext);
  const exp = useContext(ExportCtx);
  const [busy, setBusy] = useState(false);
  const label = name || 'file';
  // Static export: the download endpoint is bearer-guarded and non-image files aren't
  // embedded, so surface the attachment's name as an inert chip rather than a dead button.
  if (exp) {
    return (
      <span className="chat-file" title={label}>
        <PaperClipOutlined />
        <span className="chat-file-name">{label}</span>
      </span>
    );
  }
  const download = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      const objUrl = await resolve(id);
      const a = document.createElement('a');
      a.href = objUrl;
      a.download = label;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(objUrl), 10_000);
    } catch {
      /* leave the chip in place so the user can retry */
    } finally {
      setBusy(false);
    }
  };
  return (
    <button type="button" className="chat-file" onClick={download} title={`Download ${label}`}>
      {busy ? <LoadingOutlined spin /> : <PaperClipOutlined />}
      <span className="chat-file-name">{label}</span>
    </button>
  );
}

// A user-sent image: click to open AntD's full-screen preview (zoom/rotate, ESC to close).
// The displayed src is already the full-resolution image (just CSS-constrained to 220px),
// so the lightbox shows it at native size with no extra fetch. The hover mask is the
// click affordance — without it a bare <img> gives no hint it's interactive.
export function ChatImage({
  src,
  className = 'chat-image',
  alt = 'Image sent by user',
  previewKey,
  order,
}: {
  src: string;
  className?: string;
  alt?: string;
  // When set (and inside the transcript's ImagePreviewProvider) this image joins the
  // session-wide left/right preview group under this stable key, ordered by `order`.
  previewKey?: string;
  order?: number;
}) {
  const exp = useContext(ExportCtx);
  const registry = useContext(ImagePreviewContext);
  // Static export: AntD's Image lightbox is JS-driven and inert in a saved file — render a
  // plain <img> (the src is already the full-resolution data URL).
  if (exp) return <img className={className} src={src} alt={alt} />;
  // In the transcript: join the shared left/right pager (see ImagePreviewProvider).
  if (registry && previewKey !== undefined && order !== undefined) {
    return (
      <GroupedChatImage registry={registry} previewKey={previewKey} order={order} src={src} className={className} alt={alt} />
    );
  }
  // Standalone (the composer's unsent previews): AntD's own single-image lightbox.
  return (
    <Image
      className={className}
      src={src}
      alt={alt}
      preview={{
        mask: (
          <span className="chat-image-mask">
            <EyeOutlined /> Preview
          </span>
        ),
      }}
    />
  );
}

// A transcript thumbnail wired into the session-wide preview group: registers its src on
// mount (re-registering if the src changes, e.g. an object URL is replaced), unregisters on
// unmount, and opens the group at this image on click.
function GroupedChatImage({
  registry,
  previewKey,
  order,
  src,
  className,
  alt,
}: {
  registry: PreviewRegistry;
  previewKey: string;
  order: number;
  src: string;
  className: string;
  alt: string;
}) {
  useEffect(() => {
    registry.register(previewKey, order, src);
    return () => registry.unregister(previewKey);
  }, [registry, previewKey, order, src]);
  return (
    <button type="button" className="chat-image-btn" onClick={() => registry.open(previewKey)}>
      <img className={className} src={src} alt={alt} />
      <span className="chat-image-mask">
        <EyeOutlined /> Preview
      </span>
    </button>
  );
}

// ── Markdown ────────────────────────────────────────────────────────────────
// memo'd on (text, highlight): when a new event is appended the tree is rebuilt and
// every node object is new, but unchanged text compares equal by value, so the
// react-markdown AST isn't re-parsed for messages that didn't change.
// `highlight` is off while streaming — re-highlighting the whole doc on every chunk
// is the expensive part, and code isn't complete mid-stream anyway.
// A fenced code block rendered with a hover copy button pinned to its top-right corner. The
// block itself is the hover area and the button sits inside it, so the pointer never leaves on
// the way over. Copy reads the rendered <pre>'s textContent — highlight.js spans flatten back
// to exactly the raw code, so "copy this whole HTML and save as a file" gets clean source.
function CodeBlock({ children }: any) {
  const preRef = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  const copy = () => {
    const text = preRef.current?.textContent ?? '';
    if (!text) return;
    void navigator.clipboard?.writeText(text)?.catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };
  return (
    <div className="md-codeblock">
      <button
        type="button"
        className="md-copy"
        onClick={copy}
        title={copied ? 'Copied' : 'Copy code'}
        aria-label={copied ? 'Copied' : 'Copy code'}
      >
        {copied ? <CheckOutlined /> : <CopyOutlined />}
      </button>
      <pre ref={preRef}>{children}</pre>
    </div>
  );
}

const ORBIT_ATTACHMENT_PREFIX = 'orbit-attachment:';

function attachmentIdFromSrc(src: unknown): string | null {
  if (typeof src !== 'string') return null;
  const trimmed = src.trim();
  if (!trimmed.startsWith(ORBIT_ATTACHMENT_PREFIX)) return null;
  const id = trimmed.slice(ORBIT_ATTACHMENT_PREFIX.length).trim().split(/\s+/, 1)[0];
  return id || null;
}

// react-markdown's built-in urlTransform blanks any src/href whose scheme isn't
// on its allow-list (http, https, mailto, …). The runner rewrites transcript
// images and file links to our custom `orbit-attachment:<id>` scheme, so that
// would strip them to '' before MarkdownImage/MarkdownLink ever see the id. Let
// those through untouched and defer every other URL to the default (XSS-safe)
// transform so javascript:/data: links stay neutralized.
function transcriptUrlTransform(url: string): string {
  return url.trim().startsWith(ORBIT_ATTACHMENT_PREFIX) ? url : defaultUrlTransform(url);
}

function isLocalImageSrc(src: string): boolean {
  return /^\/(?:root|home|tmp|Users)\/(?:[^?#]+)\.(?:png|jpe?g|gif|webp|svg)$/i.test(src);
}

function isLocalFileSrc(src: string): boolean {
  return /^\/(?:root|home|tmp|Users)\/[^?#]+$/i.test(src);
}

function isLegacyArtifactSrc(src: string): boolean {
  return isLocalFileSrc(src) && /\/\.orbit\/uploads\/[0-9a-f-]{36}\//i.test(src);
}

function fileLabel(src: string): string {
  try {
    const clean = decodeURIComponent(src);
    return clean.split(/[\\/]/).filter(Boolean).pop() || 'image';
  } catch {
    return src.split(/[\\/]/).filter(Boolean).pop() || 'image';
  }
}

function MarkdownImage({ node: _node, src, alt, className: _className, ...rest }: any) {
  const id = attachmentIdFromSrc(src);
  if (id) {
    return (
      <ResolvedAttachmentImage
        id={id}
        className="md-image"
        alt={typeof alt === 'string' ? alt : 'Image'}
        loadingClassName="md-image md-image-loading"
      />
    );
  }
  if (typeof src === 'string' && isLegacyArtifactSrc(src)) {
    return <LocalArtifactFile artifactPath={src} label={fileLabel(src)} />;
  }
  if (typeof src === 'string' && isLocalImageSrc(src)) {
    return (
      <span className="md-image-unavailable" title={src}>
        <PaperClipOutlined />
        <code>{fileLabel(src)}</code>
      </span>
    );
  }
  return <img {...rest} className="md-image" src={src} alt={alt ?? ''} />;
}

function LocalArtifactFile({
  artifactPath,
  label,
  downloadName,
}: {
  artifactPath: string;
  label?: string;
  downloadName?: string;
}) {
  const resolve = useContext(ArtifactResolverContext);
  const exp = useContext(ExportCtx);
  const [busy, setBusy] = useState(false);
  const shown = label || fileLabel(artifactPath);
  const filename = downloadName || fileLabel(artifactPath);
  if (!resolve || exp) {
    return (
      <span className="md-image-unavailable" title={artifactPath}>
        <PaperClipOutlined />
        <code>{shown}</code>
      </span>
    );
  }
  const download = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      const objUrl = await resolve(artifactPath);
      const a = document.createElement('a');
      a.href = objUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(objUrl), 10_000);
    } catch {
      /* keep the chip retryable */
    } finally {
      setBusy(false);
    }
  };
  return (
    <button type="button" className="chat-file" onClick={download} title={`Download ${filename}`}>
      {busy ? <LoadingOutlined spin /> : <PaperClipOutlined />}
      <span className="chat-file-name">{shown}</span>
    </button>
  );
}

function nodeText(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join('');
  if (isValidElement<{ children?: ReactNode }>(node)) return nodeText(node.props.children);
  return '';
}

function MarkdownLink({ node: _node, href, title, children, ...rest }: any) {
  const id = attachmentIdFromSrc(href);
  if (id) {
    const name = typeof title === 'string' && title.trim() ? title.trim() : nodeText(children).trim() || undefined;
    return <AttachmentFile id={id} name={name} />;
  }
  if (typeof href === 'string' && isLegacyArtifactSrc(href)) {
    return (
      <LocalArtifactFile
        artifactPath={href}
        label={nodeText(children).trim() || fileLabel(href)}
        downloadName={fileLabel(href)}
      />
    );
  }
  if (typeof href === 'string' && isLocalFileSrc(href)) {
    return (
      <span className="md-image-unavailable" title={href}>
        <PaperClipOutlined />
        <code>{fileLabel(href)}</code>
      </span>
    );
  }
  return (
    <a {...rest} href={href} title={title}>
      {children}
    </a>
  );
}

export const MD = memo(function MD({ children, highlight = true }: { children: string; highlight?: boolean }) {
  return (
    <div className="md">
      <Markdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={highlight ? [rehypeHighlight] : []}
        urlTransform={transcriptUrlTransform}
        components={{ pre: CodeBlock, img: MarkdownImage, a: MarkdownLink }}
      >
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
  const exp = useContext(ExportCtx);
  const [open, setOpen] = useState(!!exp);
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
  // A `!`-shell command the user ran (runner tags its tool_use id `shell-…`) renders as a
  // distinct "Shell" card, not Claude's Bash tool — see describeTool's isShell branch.
  const isShell = node.id.startsWith('shell-');
  const { label, summary, summaryMono, body, icon, tone, path, meta } = useMemo(
    () => describeTool(node.name, node.input, isShell),
    [node.name, node.input, isShell],
  );
  const exp = useContext(ExportCtx);
  const isSubAgent = node.name === 'Task' || node.name === 'Agent';
  const p = path ? splitPath(path) : null;
  const hasDetail = !!body || node.children.length > 0 || !!node.result;
  // A plan or a question to the user is the point of the turn — open it by
  // default; errors also auto-open. A static export opens every card (nothing can
  // be un-folded after the fact).
  const defaultOpen =
    !!exp || !!node.result?.isError || node.name === 'ExitPlanMode' || node.name === 'AskUserQuestion' || isShell;
  const [manualOpen, setManualOpen] = useState<boolean | null>(null);
  const open = manualOpen ?? defaultOpen;
  // While an AskUserQuestion or ExitPlanMode is still awaiting the user, the
  // interactive card (ApprovalPanel) is shown separately — don't also render this
  // read-only copy in the transcript (it would duplicate the question/plan). Once
  // resolved (result arrives) or the session has ended, show it as the historical
  // record (question + chosen answer, or the plan).
  if ((node.name === 'AskUserQuestion' || node.name === 'ExitPlanMode') && live && !node.result) return null;
  return (
    <div
      className={`chat-tool-card chat-tone-${tone ?? 'default'}${isSubAgent ? ' chat-tool-task' : ''}${
        hasDetail && open ? ' is-open' : ''
      }`}
    >
      <div
        className={`chat-tool-row${hasDetail ? '' : ' no-detail'}`}
        onClick={hasDetail ? () => setManualOpen((prev) => !(prev ?? defaultOpen)) : undefined}
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
              <NodeList nodes={node.children} live={live} />
            </div>
          )}
          {node.result && (
            <ToolResult seq={node.seq} content={node.result.content} isError={node.result.isError} compact markdown={isSubAgent} />
          )}
        </div>
      )}
    </div>
  );
}

type ToolGroupSummary = {
  title: string;
  summary: string;
  breakdown?: string;
  latest?: string;
  latestMono?: boolean;
  icon: ReactNode;
  tone: Tone;
  status: 'running' | 'error' | 'pending' | 'ok';
  urgent: boolean;
};

function ToolGroupView({ nodes, live }: { nodes: ToolNode[]; live?: boolean }) {
  const exp = useContext(ExportCtx);
  const summary = useMemo(() => summarizeToolGroup(nodes, live), [nodes, live]);
  const [manualOpen, setManualOpen] = useState<boolean | null>(null);
  const open = manualOpen ?? (!!exp || summary.urgent);
  const toggle = () => setManualOpen((prev) => !(prev ?? (!!exp || summary.urgent)));
  return (
    <div
      className={`chat-tool-card chat-tool-group chat-tone-${summary.tone}${open ? ' is-open' : ''}`}
    >
      <div className="chat-tool-row" onClick={toggle}>
        <span className="chat-tool-caret">{open ? <DownOutlined /> : <RightOutlined />}</span>
        <span className="chat-tool-icon">{summary.icon}</span>
        <span className="chat-tool-name">{summary.title}</span>
        <span
          className="chat-tool-summary"
          title={summary.latest ? `${summary.summary} · Latest: ${summary.latest}` : summary.summary}
        >
          {summary.summary}
          {summary.latest && (
            <span className="chat-tool-group-latest">
              {' '}
              · Latest:{' '}
              <span className={summary.latestMono ? 'mono' : undefined}>{summary.latest}</span>
            </span>
          )}
        </span>
        {summary.breakdown && <span className="chat-tool-meta chat-tool-group-breakdown">{summary.breakdown}</span>}
        <ToolGroupStatus status={summary.status} />
      </div>
      {open && (
        <div className="chat-tool-group-detail">
          {nodes.map((node) => (
            <ToolView key={node.seq} node={node} live={live} />
          ))}
        </div>
      )}
    </div>
  );
}

function summarizeToolGroup(nodes: ToolNode[], live?: boolean): ToolGroupSummary {
  const described = nodes.map((node) => {
    const desc = describeTool(node.name, node.input, node.id.startsWith('shell-'));
    const latest = latestToolSummary(node, desc);
    return {
      desc,
      latest: latest?.text,
      latestMono: latest?.mono,
    };
  });
  const counts = new Map<string, number>();
  for (const item of described) counts.set(item.desc.label, (counts.get(item.desc.label) ?? 0) + 1);
  const entries = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const sameKind = entries.length === 1;
  const title = sameKind ? `${entries[0][0]} × ${nodes.length}` : `Tools × ${nodes.length}`;
  const latestItem = [...described].reverse().find((item) => item.latest);
  const running = nodes.filter((node) => live && !node.result).length;
  const pending = nodes.filter((node) => !live && !node.result).length;
  const failed = nodes.filter((node) => !!node.result?.isError).length;
  const succeeded = nodes.length - running - pending - failed;
  const parts: string[] = [];
  if (running) parts.push(`${running} running`);
  if (failed) parts.push(`${failed} failed`);
  if (pending) parts.push(`${pending} pending`);
  if (succeeded) parts.push(`${succeeded} succeeded`);
  const first = described[0]?.desc;
  const status: ToolGroupSummary['status'] = running ? 'running' : failed ? 'error' : pending ? 'pending' : 'ok';
  return {
    title,
    summary: parts.join(' · '),
    breakdown: sameKind ? undefined : entries.map(([label, count]) => `${label} × ${count}`).join(' · '),
    latest: latestItem?.latest,
    latestMono: latestItem?.latestMono,
    icon: sameKind ? first?.icon : <ToolOutlined />,
    tone: sameKind ? (first?.tone ?? 'default') : 'default',
    status,
    urgent: running > 0 || failed > 0,
  };
}

function latestToolSummary(node: ToolNode, desc: ToolDesc): { text: string; mono: boolean } | undefined {
  const input = node.input ?? {};
  if (node.name === 'Bash' && typeof input.command === 'string' && input.command) {
    return { text: input.command, mono: true };
  }
  if (desc.path) return { text: desc.path, mono: true };
  if (desc.summary) return { text: desc.summary, mono: !!desc.summaryMono };
  if (desc.meta) return { text: desc.meta, mono: true };
  return undefined;
}

function ToolGroupStatus({ status }: { status: ToolGroupSummary['status'] }) {
  switch (status) {
    case 'running':
      return <LoadingOutlined className="chat-tool-status running" spin />;
    case 'error':
      return <CloseCircleFilled className="chat-tool-status err" />;
    case 'pending':
      return <MinusCircleOutlined className="chat-tool-status pending" />;
    case 'ok':
      return <CheckCircleFilled className="chat-tool-status ok" />;
  }
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
function describeTool(name: string, input: any, isShell?: boolean): ToolDesc {
  const i = input ?? {};
  // A user-run `!`-shell command (not Claude's Bash tool): show the command inline in the
  // folded row and render as a terminal-flavoured "Shell" card (ToolView auto-opens it).
  if (isShell) {
    return { label: 'Shell', icon: <ConsoleSqlOutlined />, tone: 'exec', summary: String(i.command ?? ''), summaryMono: true };
  }
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
  seq,
  content,
  isError,
  compact,
  markdown,
}: {
  seq: number;
  content: any;
  isError?: boolean;
  compact?: boolean;
  // A Task (sub-agent) result is the agent's prose report — render it as Markdown,
  // like Claude Code Web, rather than raw monospace. Raw tool output stays monospace.
  markdown?: boolean;
}) {
  const text = resultText(content);
  const images = resultImages(content);
  // A successful tool with no output renders nothing; but an error with no output must
  // still surface — otherwise a failed tool looks like it never ran.
  if (!text && images.length === 0 && !isError) return null;
  return (
    <div className={`chat-result${isError ? ' is-error' : ''}${compact ? ' compact' : ''}`}>
      {images.length > 0 && (
        <div className="chat-images">
          {images.map((src, i) => (
            <ChatImage key={i} src={src} previewKey={`r${seq}-${i}`} order={seq * 1e4 + i} />
          ))}
        </div>
      )}
      {!text ? (
        // Image-only success shows just the image above; only a no-output error needs text here.
        isError && <div className="chat-result-empty">✖ error</div>
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
// Exported so the background-process tray can reuse the same collapsing output block.
export function Pre({
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
  const exp = useContext(ExportCtx);
  const [open, setOpen] = useState(!!exp);
  const clean = useMemo(() => stripAnsi(text), [text]);
  const lines = clean.split('\n');
  const hidden = Math.max(0, lines.length - threshold);
  const long = hidden > 0;
  const shown = open || !long ? clean : lines.slice(0, threshold).join('\n');
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
// Exported so the background-process tray can flatten a Read-on-output result the same way.
export function resultText(content: any): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b: any) => {
        if (typeof b === 'string') return b;
        if (b && b.type === 'text') return b.text ?? '';
        if (b && b.type === 'image') return ''; // rendered inline by resultImages()
        return safeJson(b);
      })
      .filter((s) => s !== '')
      .join('\n');
  }
  return safeJson(content);
}

// Inline images carried by a tool_result's content blocks — e.g. Read on a .png, or an
// MCP tool returning a screenshot. The base64 data is passed through verbatim from the
// runner, so render it as a data URL. A plain-text result yields [].
function resultImages(content: any): string[] {
  if (!Array.isArray(content)) return [];
  const urls: string[] = [];
  for (const b of content) {
    const s = b && b.type === 'image' ? b.source : null;
    if (s && s.data && s.media_type) urls.push(`data:${s.media_type};base64,${s.data}`);
  }
  return urls;
}
