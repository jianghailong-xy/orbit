// Export one session's conversation as a single, self-contained HTML file.
//
// The transcript is rendered by the *same* <Transcript> component the app uses, wrapped in
// ExportCtx so collapsibles render expanded and images resolve from a pre-fetched map (see
// components/Transcript.tsx). The app's real stylesheet is inlined verbatim via `?raw`, so
// the export never drifts from how the app looks. The result is one .html file with no
// external assets — openable offline in any browser, printable to PDF.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ExportCtx, Transcript, type RunEvent } from '../components/Transcript';
import { fetchAttachmentDataUrl } from '../api';
// Vite `?raw`: pull the real CSS text into the bundle. index.css carries the design tokens
// (:root light + dark) and every .chat-*/.md/.diff-* rule; github.css is the light-theme
// highlight.js palette the transcript imports separately (dark is overridden in index.css).
import indexCss from '../index.css?raw';
import hljsCss from 'highlight.js/styles/github.css?raw';

// The session fields the export header needs — kept loose to match the list item shape.
export interface ExportSession {
  id: string;
  title?: string | null;
  status?: string | null;
  createdAt?: string | null;
  startedAt?: string | null;
  lastTurnAt?: string | null;
  agent?: { name?: string | null } | null;
}

// Image attachment ids referenced by the user turns (non-image files aren't embedded).
function imageAttachmentIds(events: RunEvent[]): string[] {
  const ids = new Set<string>();
  for (const ev of events) {
    if (ev.type !== 'user') continue;
    const p = ev.payload ?? {};
    const raw: unknown[] = Array.isArray(p.attachments) ? p.attachments : Array.isArray(p.images) ? p.images : [];
    for (const a of raw) {
      const att = a as { id?: unknown; mime?: unknown };
      const isImage = typeof att?.mime !== 'string' || att.mime.startsWith('image/');
      if (typeof att?.id === 'string' && isImage) ids.add(att.id);
    }
  }
  return [...ids];
}

// Fetch every referenced image once, as a base64 data URL. Failures are dropped (that image
// falls back to an empty placeholder) rather than aborting the whole export.
async function resolveImages(events: RunEvent[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  await Promise.allSettled(
    imageAttachmentIds(events).map(async (id) => {
      map.set(id, await fetchAttachmentDataUrl(id));
    }),
  );
  return map;
}

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);

// Filesystem-safe slug from the session title / agent name for the download filename.
const slug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'session';

const fmtDate = (iso?: string | null): string => {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? new Date(t).toLocaleString() : '';
};

// Overrides layered on top of the app CSS: neutralise the live scroll container, hide the
// controls that only work with the app's JS, and give the document page margins.
const EXPORT_CSS = `
body { margin: 0; background: var(--bg-base); color: var(--text-1);
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; }
.orbit-export { max-width: 880px; margin: 0 auto; padding: 28px 20px 72px; box-sizing: border-box; }
.orbit-export-head { border-bottom: 1px solid var(--border); padding-bottom: 14px; margin-bottom: 22px; }
.orbit-export-title { font-size: 20px; font-weight: 650; color: var(--text-1); line-height: 1.3; }
.orbit-export-meta { margin-top: 6px; font-size: 13px; color: var(--text-2); }
.orbit-export-foot { margin-top: 48px; padding-top: 16px; border-top: 1px solid var(--border-subtle);
  text-align: center; font-size: 12px; color: var(--text-3); }
.orbit-export .agent-sessions { display: block; overflow: visible; flex: none; min-height: 0; }
.orbit-export .chat-copy, .orbit-export .md-copy, .orbit-export .chat-more,
.orbit-export .chat-tool-caret, .orbit-export .chat-image-mask { display: none !important; }
.orbit-export .chat-tool-row { cursor: default !important; }
.orbit-export .chat-user-meta { position: static; opacity: 1; height: auto; }
`;

/** Build a standalone HTML document string for a session's transcript. */
export function buildSessionHtml(
  session: ExportSession,
  events: RunEvent[],
  images: Map<string, string>,
  theme: string,
): string {
  const title = (session.title || 'Session').trim();
  const agentName = session.agent?.name?.trim();
  const started = fmtDate(session.startedAt ?? session.createdAt);
  const meta = [agentName, session.status?.toLowerCase(), started && `started ${started}`]
    .filter(Boolean)
    .join('  ·  ');

  const body = renderToStaticMarkup(
    createElement(
      ExportCtx.Provider,
      { value: { images } },
      createElement(
        'div',
        { className: 'agent-sessions' },
        createElement(Transcript, { events, live: false }),
      ),
    ),
  );

  return `<!doctype html>
<html lang="en"${theme ? ` data-theme="${escapeHtml(theme)}"` : ''}>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)} — Orbit</title>
<style>
${hljsCss}
${indexCss}
${EXPORT_CSS}
</style>
</head>
<body>
<div class="orbit-export">
<header class="orbit-export-head">
<div class="orbit-export-title">${escapeHtml(title)}</div>
${meta ? `<div class="orbit-export-meta">${escapeHtml(meta)}</div>` : ''}
</header>
<div class="agent-sessions">${body}</div>
<footer class="orbit-export-foot">Exported from Orbit${started ? ` · ${escapeHtml(new Date().toLocaleDateString())}` : ''}</footer>
</div>
</body>
</html>`;
}

/** Render the session to HTML and trigger a browser download of the self-contained file. */
export async function exportSessionHtml(session: ExportSession, events: RunEvent[]): Promise<void> {
  const images = await resolveImages(events);
  const theme = document.documentElement.getAttribute('data-theme') ?? '';
  const html = buildSessionHtml(session, events, images, theme);

  const name = `${slug(session.agent?.name || 'orbit')}-${slug(session.title || 'session')}-${new Date()
    .toISOString()
    .slice(0, 10)}.html`;
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
