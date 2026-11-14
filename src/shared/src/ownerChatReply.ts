/**
 * The owner's words from a "Chat about this" on one of Orbit's own asks (a project, a task, a batch,
 * a deletion…), read back from the tool result the runner wrote for the agent (`ownerChatReply` in
 * src/runner-go/mcp.go):
 *
 *   Not done yet, and not a no: the owner pressed "Chat about this" … Their message:
 *
 *   <words>
 *
 *   Reply to it as you would to any message from them. …
 *
 * The words are a message the owner sent in the conversation, so every client draws them as one,
 * under the call's row, instead of leaving them inside a folded result. `owner-chat-reply.fixture.json`
 * is the contract the runner's writer and each client's reader are held to.
 */

const LEAD =
  'Not done yet, and not a no: the owner pressed "Chat about this" on the card to talk it over before deciding. Their message:\n\n';
const TAIL = '\n\nReply to it as you would to any message from them.';
const CHAT_OUTCOME = /"outcome"\s*:\s*"chat"/;

/** The owner's words when `result` is a chat reply to a card, otherwise null. */
export function ownerChatWords(result: string): string | null {
  const reply = chatReceiptText(result) ?? result;
  if (!reply.startsWith(LEAD)) return null;
  const end = reply.lastIndexOf(TAIL);
  if (end < LEAD.length) return null;
  const words = reply.slice(LEAD.length, end).trim();
  return words || null;
}

/**
 * The reply inside a chat's receipt (outcome "chat"), which is what an engine records in place of the
 * result's text: Claude Code and Codex pass a result's structuredContent on when it has one, and the
 * receipt carries the reply as its `text` (src/runner-go/tool_receipt.go).
 */
function chatReceiptText(result: string): string | null {
  if (!result.startsWith('{') || !CHAT_OUTCOME.test(result)) return null;
  try {
    const receipt = JSON.parse(result) as { outcome?: unknown; text?: unknown } | null;
    return receipt?.outcome === 'chat' && typeof receipt.text === 'string' ? receipt.text : null;
  } catch {
    return null;
  }
}
