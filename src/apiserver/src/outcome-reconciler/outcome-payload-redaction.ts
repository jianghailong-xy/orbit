import { createHash } from 'node:crypto';

/**
 * Bounded payload redaction, extracted verbatim from the removed outcome-watchdog module so the
 * canary keeps the exact sanitizer it was written against. Nothing here reads the database.
 */
export const WATCHDOG_MAX_PAYLOAD_BYTES = 65_536;
export const WATCHDOG_MAX_RAW_COMMAND_OUTPUT_BYTES = 16_384;
export const WATCHDOG_REDACTION = '[REDACTED]';

const SECRET_KEY = /authorization|cookie|token|secret|password|private[_-]?key|api[_-]?key|credential/i;
const RAW_OUTPUT_KEY = /^(rawCommandOutput|commandOutput|stdout|stderr)$/i;
const INLINE_SECRET_PATTERNS: readonly RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\b(?:gh[opsu]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\b(?:api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/gi,
  /([a-z][a-z0-9+.-]*:\/\/[^\s:/]+:)[^@\s/]+@/gi,
];

export interface SanitizedWatchdogPayload {
  payload: unknown;
  inputBytes: number;
  storedBytes: number;
  redacted: boolean;
  truncatedRawOutput: boolean;
  payloadDigest: string;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function truncateUtf8(value: string, maximumBytes: number): { value: string; truncated: boolean } {
  if (byteLength(value) <= maximumBytes) return { value, truncated: false };
  const suffix = '\n[TRUNCATED]';
  const suffixBytes = byteLength(suffix);
  const source = Buffer.from(value, 'utf8');
  let end = Math.max(0, maximumBytes - suffixBytes);
  while (end > 0 && (source[end] & 0xc0) === 0x80) end -= 1;
  return {
    value: `${source.subarray(0, end).toString('utf8')}${suffix}`,
    truncated: true,
  };
}

function redactString(value: string): { value: string; redacted: boolean } {
  let output = value;
  for (const pattern of INLINE_SECRET_PATTERNS) {
    const prior = output;
    output = output.replace(pattern, (match, prefix?: string) => (
      typeof prefix === 'string' && match.startsWith(prefix)
        ? `${prefix}${WATCHDOG_REDACTION}@`
        : WATCHDOG_REDACTION
    ));
    if (output !== prior) return {
      value: INLINE_SECRET_PATTERNS.slice(INLINE_SECRET_PATTERNS.indexOf(pattern) + 1)
        .reduce((current, next) => current.replace(next, WATCHDOG_REDACTION), output),
      redacted: true,
    };
  }
  return { value: output, redacted: false };
}

function sanitizeValue(
  value: unknown,
  key: string | null,
  state: { redacted: boolean; truncatedRawOutput: boolean },
): unknown {
  if (key && SECRET_KEY.test(key)) {
    state.redacted = true;
    return WATCHDOG_REDACTION;
  }
  if (typeof value === 'string') {
    const redacted = redactString(value);
    state.redacted ||= redacted.redacted;
    if (key && RAW_OUTPUT_KEY.test(key)) {
      const truncated = truncateUtf8(redacted.value, WATCHDOG_MAX_RAW_COMMAND_OUTPUT_BYTES);
      state.truncatedRawOutput ||= truncated.truncated;
      return {
        content: truncated.value,
        originalBytes: byteLength(value),
        storedBytes: byteLength(truncated.value),
        truncated: truncated.truncated,
        redacted: redacted.redacted,
        originalSha256: createHash('sha256').update(value).digest('hex'),
      };
    }
    return redacted.value;
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, null, state));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .map(([childKey, child]) => [childKey, sanitizeValue(child, childKey, state)]));
  }
  return value;
}

/**
 * The caller never receives a partially accepted payload. The original serialized body is bounded
 * first, secrets are removed second, raw command fields receive their tighter byte cap, and the
 * exact stored representation is bounded once more. Only the sanitized representation leaves this
 * function; the original command output is deliberately not retained.
 */
export function sanitizeWatchdogPayload(
  input: unknown,
  maximumPayloadBytes = WATCHDOG_MAX_PAYLOAD_BYTES,
): SanitizedWatchdogPayload {
  if (!Number.isInteger(maximumPayloadBytes) || maximumPayloadBytes < 1) {
    throw new Error('WATCHDOG_PAYLOAD_LIMIT_INVALID');
  }
  const inputJson = JSON.stringify(input);
  if (inputJson === undefined) throw new Error('WATCHDOG_PAYLOAD_NOT_JSON');
  const inputBytes = byteLength(inputJson);
  if (inputBytes > maximumPayloadBytes) throw new Error('WATCHDOG_PAYLOAD_TOO_LARGE');
  const state = { redacted: false, truncatedRawOutput: false };
  const payload = sanitizeValue(input, null, state);
  const storedJson = JSON.stringify(payload);
  const storedBytes = byteLength(storedJson);
  if (storedBytes > maximumPayloadBytes) throw new Error('WATCHDOG_SANITIZED_PAYLOAD_TOO_LARGE');
  return {
    payload,
    inputBytes,
    storedBytes,
    redacted: state.redacted,
    truncatedRawOutput: state.truncatedRawOutput,
    payloadDigest: createHash('sha256').update(storedJson).digest('hex'),
  };
}

/**
 * Transport bounds for the owner decision inbox, kept verbatim from the removed canonical surface
 * module. Both producers that fed that inbox have since been removed — the canonical obligation
 * projection with the obligation algebra, and the failure-continuation owner decision with
 * migration 0226 — but any payload that reaches API, CLI or Web through it must still be redacted
 * and bounded in one traversal so a secret cannot hide behind an unbounded object.
 */
export const OUTCOME_SURFACE_LIMITS = Object.freeze({
  maxProjectionBytes: 256 * 1024,
  maxStringBytes: 8 * 1024,
  maxArrayItems: 50,
  maxObjectKeys: 100,
  maxDepth: 8,
});

// Match snake/kebab/camel/plain keys. Payloads come from integrations, so one naming convention
// must not be able to bypass the transport boundary (for example `apiToken` versus `api_token`).
const SURFACE_SECRET_KEY = /(authorization|cookie|credential|password|private[_-]?key|secret|token|api[_-]?key)/i;
const SURFACE_SECRET_VALUE = /(?:\b(?:bearer|basic)\s+\S+|\bsk-[A-Za-z0-9_-]{12,}|\bgh[pousr]_[A-Za-z0-9_]{12,}|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|-----BEGIN [A-Z ]*PRIVATE KEY-----|[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@|[?&](?:access[_-]?token|api[_-]?key|authorization|password|secret|token)=[^&\s]+)/i;

export function redactOutcomePayload(
  value: unknown,
  depth = 0,
  seen = new Set<object>(),
): unknown {
  if (depth > OUTCOME_SURFACE_LIMITS.maxDepth) return '[TRUNCATED_DEPTH]';
  if (typeof value === 'string') {
    if (SURFACE_SECRET_VALUE.test(value.trim())) return '[REDACTED]';
    return Buffer.byteLength(value, 'utf8') > OUTCOME_SURFACE_LIMITS.maxStringBytes
      ? `${value.slice(0, OUTCOME_SURFACE_LIMITS.maxStringBytes)}…[TRUNCATED]`
      : value;
  }
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value !== 'object' || value === undefined) return String(value);
  if (seen.has(value)) return '[REDACTED_CYCLE]';
  seen.add(value);
  let result: unknown;
  if (Array.isArray(value)) {
    result = value.slice(0, OUTCOME_SURFACE_LIMITS.maxArrayItems)
      .map((entry) => redactOutcomePayload(entry, depth + 1, seen));
  } else {
    result = Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, OUTCOME_SURFACE_LIMITS.maxObjectKeys)
        .map(([key, entry]) => [
          key,
          SURFACE_SECRET_KEY.test(key) ? '[REDACTED]' : redactOutcomePayload(entry, depth + 1, seen),
        ]),
    );
  }
  seen.delete(value);
  return result;
}
