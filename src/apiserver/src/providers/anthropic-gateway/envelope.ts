/**
 * The reasoning envelope (docs/claude-engine-openai-gateway-design.md §4.3). OpenAI's reasoning item travels
 * inside the `signature` of the `thinking` block Claude Code keeps in its transcript and sends back untouched
 * (fixtures/claude-cli-2.1.322/thinking.json, thinkturns.json), so the gateway holds no state between turns.
 */
export const ENVELOPE_PREFIX = 'orbit1.';

export interface ReasoningEnvelope {
  /** The reasoning item's id (`rs_…`). Kept for the record; not sent back (see request.ts). */
  id: string;
  /** `reasoning.encrypted_content`, which is what OpenAI needs to carry reasoning across turns. */
  encrypted_content?: string;
}

export function encodeReasoningSignature(envelope: ReasoningEnvelope): string {
  const body: ReasoningEnvelope = { id: envelope.id };
  if (envelope.encrypted_content !== undefined) body.encrypted_content = envelope.encrypted_content;
  return ENVELOPE_PREFIX + Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
}

/** The envelope a signature carries, or null for a signature that is not ours or is damaged. */
export function decodeReasoningSignature(signature: unknown): ReasoningEnvelope | null {
  if (typeof signature !== 'string' || !signature.startsWith(ENVELOPE_PREFIX)) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(signature.slice(ENVELOPE_PREFIX.length), 'base64url').toString('utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    const { id, encrypted_content } = parsed as Record<string, unknown>;
    if (typeof id !== 'string') return null;
    if (encrypted_content !== undefined && typeof encrypted_content !== 'string') return null;
    return encrypted_content === undefined ? { id } : { id, encrypted_content };
  } catch {
    return null;
  }
}
