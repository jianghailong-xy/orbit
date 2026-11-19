import { createContext, useContext, useMemo, useState } from 'react';
import { stripAnsi } from '../lib/ansi';

// The transcript's monospace, diff and key/value blocks, in a module of their own so a card outside
// the transcript (the tool-call approval) draws a call the way the transcript does without loading it.

// When present, the transcript is being serialized to a standalone HTML file (see
// lib/sessionExport). A static file has no JS, so collapsibles must render expanded —
// otherwise their content sits behind a dead, un-clickable fold and is simply lost — and
// images must resolve from a pre-fetched data-URL map instead of the live bearer fetch.
// The context is null in the running app, so every reader below is a no-op there.
export interface ExportMode {
  images: Map<string, string>; // attachment id → base64 data URL
}
export const ExportCtx = createContext<ExportMode | null>(null);

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

export function Diff({ oldStr, newStr }: { oldStr?: string; newStr?: string }) {
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

// KeyVals renders an unknown tool's input as a compact key/value table instead of
// a raw JSON blob — scalars inline, nested objects/arrays as collapsible JSON.
export function KeyVals({ obj }: { obj: any }) {
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

// A worktree-isolated session runs its tools under <home>/.orbit/worktrees/<id>/;
// that absolute prefix is ephemeral machine scratch, so strip it and show the path
// relative to the repo root. Paths outside a worktree are returned unchanged.
const WORKTREE_RE = /\.orbit\/worktrees\/[^/]+\//;
export function relPath(path: string): string {
  const m = WORKTREE_RE.exec(path);
  if (!m) return path;
  return path.slice(m.index + m[0].length) || path;
}

export const safeJson = (v: any): string => {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
};
