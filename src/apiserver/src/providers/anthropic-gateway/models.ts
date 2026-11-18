/**
 * Which OpenAI model answers a request (design §4.5). The CLI sends the session model on the main loop and
 * on subagents, and the haiku slot's model (ANTHROPIC_DEFAULT_HAIKU_MODEL, or the session model when that is
 * unset) on background requests such as WebFetch summaries (fixtures/claude-cli-2.1.322/toolsearch-r2.json,
 * toolsearch-haikur2.json). A Claude id is never expected; one that arrives anyway is not sent to OpenAI.
 */
export interface ModelContext {
  /** The session's GPT model. */
  sessionModel: string;
  /** The key's small model, for the haiku slot. Falls back to the session model. */
  smallModel?: string;
}

export function upstreamModel(requested: unknown, ctx: ModelContext): string {
  if (typeof requested !== 'string' || requested.trim() === '') return ctx.sessionModel;
  // Claude Code may append a context-window tag (`[1m]`); OpenAI knows no such suffix.
  const id = requested.trim().replace(/\[[^\]]*\]$/, '');
  if (/^claude-/i.test(id)) return /haiku/i.test(id) ? (ctx.smallModel ?? ctx.sessionModel) : ctx.sessionModel;
  return id;
}
