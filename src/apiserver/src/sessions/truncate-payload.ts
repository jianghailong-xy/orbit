import { RunEventType } from '@orbit/shared';

/**
 * Server-side trimming of the two event types that carry bulk the transcript doesn't show
 * until you ask for it: `tool_result` (67% of the bytes in a typical page — a Read of a big
 * file, a noisy build log) and `tool_use` (13% — Write's whole file body, Edit's before/after).
 * Both render as a *folded* card whose output is clipped to a dozen lines, so shipping the full
 * thing on open pays for something nobody looked at. Clients opt in with `maxPayload` and refetch
 * the untouched payload from `GET /sessions/:id/events/:seq/full` when the user expands the card.
 *
 * Deliberately narrow: assistant / thinking / user text is the thing the reader came for and is
 * never trimmed (it's ~5% of the bytes anyway).
 */

/** Longest string kept inside a trimmed payload. ~2KB is 25-40 lines — comfortably more than
 *  the 12-16 a folded card shows, so the preview is never short of content to display. */
export const DEFAULT_MAX_PAYLOAD = 2048;

/** Below this a cap costs more in refetches than it saves in bytes. */
const MIN_MAX_PAYLOAD = 256;

export function parseMaxPayload(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.max(Math.trunc(n), MIN_MAX_PAYLOAD);
}

const clip = (s: string, cap: number, cut: { hit: boolean }): string => {
  if (s.length <= cap) return s;
  cut.hit = true;
  return s.slice(0, cap);
};

/** Clip every string in an arbitrary tool input (Write.content, Edit.old_string/new_string,
 *  a long Bash heredoc, …) without caring which tool it belongs to. */
function clipDeep(v: unknown, cap: number, cut: { hit: boolean }): unknown {
  if (typeof v === 'string') return clip(v, cap, cut);
  if (Array.isArray(v)) return v.map((x) => clipDeep(x, cap, cut));
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = clipDeep(val, cap, cut);
    return out;
  }
  return v;
}

/**
 * Clip a tool_result's `content`. Claude delivers it as a plain string or as an array of blocks;
 * only the text of a text block is clipped. Image blocks pass through whole — their base64 IS
 * what the user sees (a screenshot the agent produced), and half a base64 string renders as a
 * broken image rather than a preview.
 */
function clipContent(content: unknown, cap: number, cut: { hit: boolean }): unknown {
  if (typeof content === 'string') return clip(content, cap, cut);
  if (Array.isArray(content)) {
    return content.map((b) => {
      if (!b || typeof b !== 'object') return b;
      const block = b as Record<string, unknown>;
      if (typeof block.text !== 'string') return b;
      return { ...block, text: clip(block.text, cap, cut) };
    });
  }
  return content;
}

/**
 * A payload trimmed to `cap`, plus whether anything was actually cut. Returns the original
 * object identity when nothing changed, so unaffected events cost no allocation.
 */
export function truncatePayload(
  type: string,
  payload: unknown,
  cap: number,
): { payload: unknown; truncated: boolean } {
  if (!payload || typeof payload !== 'object') return { payload, truncated: false };
  const cut = { hit: false };
  if (type === RunEventType.TOOL_RESULT) {
    const p = payload as Record<string, unknown>;
    if (!('content' in p)) return { payload, truncated: false };
    const content = clipContent(p.content, cap, cut);
    return cut.hit ? { payload: { ...p, content }, truncated: true } : { payload, truncated: false };
  }
  if (type === RunEventType.TOOL_USE) {
    const p = payload as Record<string, unknown>;
    if (!('input' in p)) return { payload, truncated: false };
    const input = clipDeep(p.input, cap, cut);
    return cut.hit ? { payload: { ...p, input }, truncated: true } : { payload, truncated: false };
  }
  return { payload, truncated: false };
}
