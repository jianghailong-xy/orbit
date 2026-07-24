/**
 * run_event.type values that mean claude actually produced output for a turn — it received the
 * message and started working, so the message is part of the conversation a `claude --resume`
 * restores. Presence of any of these on a re-delivered message turn is the signal that it must
 * NOT be re-fed verbatim (see dequeueTurn / buildResumeContinuation).
 */
export const CLAUDE_STARTED_EVENT_TYPES = ['assistant', 'thinking', 'tool_use'] as const;

// Cap on how much of the interrupted message we quote back — enough to orient claude without
// re-emphasizing a long instruction it should verify-then-continue rather than re-run.
const MAX_QUOTED = 1000;

/**
 * The prompt delivered in place of a user message when its turn is re-delivered after being
 * interrupted mid-flight — its runner died/restarted before acking, so the inbox's at-least-once
 * lease re-delivers it. `claude --resume` has already restored the original message and whatever
 * the interrupted turn managed to do, so re-feeding the original text would re-run its side
 * effects (the motivating case: a deploy that restarted this very runner, then ran a second time).
 * This drives claude to continue from the restored state instead, and explicitly warns it off
 * repeating completed side effects. The original is quoted (capped) only for orientation.
 */
export function buildResumeContinuation(original: string | null | undefined): string {
  const head =
    '[系统] 你正在处理的上一条消息因所在 runner 重启而中断，之前的对话上下文已恢复。' +
    '请先核对当前的实际状态，再继续把它完成——切勿重复执行任何已经完成的、带副作用的操作' +
    '（例如部署、提交、推送、发送、创建或删除资源等）。';
  const quoted = (original ?? '').trim();
  if (!quoted) return head;
  const preview = quoted.length > MAX_QUOTED ? quoted.slice(0, MAX_QUOTED) + '…' : quoted;
  return `${head}\n\n被中断的消息：\n${preview}`;
}
