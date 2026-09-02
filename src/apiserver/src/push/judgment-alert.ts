export interface JudgmentAlertInput {
  recipientId: string;
  requestId: string;
  requestVersion: number;
  taskId: string;
  taskTitle: string;
  projectId: string | null;
  projectTitle: string | null;
  requiredAction: string;
  deepLink: string;
  /** Current independent inbox items for this recipient, including this one. */
  openCount: number;
}

export interface JudgmentAlert {
  title: string;
  body: string;
  collapseId: string;
  payload: Record<string, unknown>;
  encoded: string;
}

function oneLine(value: string | null, fallback: string, limit: number): string {
  const normalized = value?.replace(/\s+/g, ' ').trim() || fallback;
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1)}…`;
}

/**
 * The device projection of a durable EVIDENCE_JUDGMENT responsibility.
 *
 * Copy is intentionally prospective ("needs your sign-off"), never a receipt-like "signed" or
 * "approved". The relative deep link is useful to every Orbit client without baking one server's
 * public origin into an immutable delivery row. APNs collapse is per recipient: a burst may become
 * one latest summary banner while each request keeps its own inbox item and delivery receipt.
 */
export function judgmentAlert(input: JudgmentAlertInput): JudgmentAlert {
  const project = oneLine(input.projectTitle, 'No project', 72);
  const task = oneLine(input.taskTitle, 'Untitled task', 96);
  const count = Math.max(1, Math.trunc(input.openCount));
  const title = `Evidence judgment open · Project “${project}”`;
  const body = count === 1
    ? `Task “${task}” has an open evidence judgment. Review the evidence and decide: ${input.deepLink}`
    : `Task “${task}” and ${count - 1} more have open evidence judgments. Review and decide: ${input.deepLink}`;
  const collapseId = `judgment-${input.recipientId}`;
  const payload = {
    aps: {
      alert: { title, body },
      sound: 'default',
      category: 'ORBIT_JUDGMENT',
      'thread-id': collapseId,
    },
    kind: 'evidence-judgment-open',
    judgmentRequestID: input.requestId,
    requestVersion: input.requestVersion,
    taskID: input.taskId,
    ...(input.projectId ? { projectID: input.projectId } : {}),
    requiredAction: input.requiredAction,
    deepLink: input.deepLink,
    openJudgmentCount: count,
  };
  return { title, body, collapseId, payload, encoded: JSON.stringify(payload) };
}
