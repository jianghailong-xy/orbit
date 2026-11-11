/** The coordinator's read-only view of a blocked run's question (§14 R5). */
export interface RunQuestion {
  requestId: string;
  taskTitle: string;
  runSessionId: string;
  replyBy: string;
  state: string;
  approvalStatus: string;
  questions: Array<{ question: string; multiSelect?: boolean; options?: Array<{ label: string; description?: string }> }>;
}

export function parseRunQuestion(payload: unknown): RunQuestion | null {
  const card = (payload as { runQuestion?: RunQuestion } | null)?.runQuestion;
  if (!card || !['requestId', 'taskTitle', 'runSessionId', 'replyBy', 'state', 'approvalStatus']
    .every(key => typeof (card as unknown as Record<string, unknown>)[key] === 'string') || !Array.isArray(card.questions)) return null;
  return card;
}
