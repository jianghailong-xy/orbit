/** The longest body a crossing request's push carries before it is cut with an ellipsis. */
const BODY_MAX = 160;

function line(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= BODY_MAX ? flat : `${flat.slice(0, BODY_MAX - 1).trimEnd()}…`;
}

/**
 * A cross-project request's push, in Orbit's words: which projects it is between, and the request's
 * own title (for a move, the task's). A move with no target is a task asked to be taken out of its
 * project, and says so.
 */
export function crossingRequestAlert(row: {
  kind: string;
  title: string;
  toProjectId: string | null;
  fromProject: { title: string };
  toProject: { title: string } | null;
}): { title: string; body: string } {
  const from = line(row.fromProject.title);
  if (row.kind === 'MOVE_TASK' && row.toProjectId === null) {
    return { title: `Take a task out of “${from}”?`, body: line(row.title) };
  }
  const to = line(row.toProject?.title ?? '');
  const title = row.kind === 'MOVE_TASK'
    ? `Move a task from “${from}” to “${to}”?`
    : `“${from}” asks for work in “${to}”`;
  return { title, body: line(row.title) };
}
