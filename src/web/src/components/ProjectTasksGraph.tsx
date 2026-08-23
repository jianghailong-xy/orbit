import { Alert, Typography } from 'antd';
import { Suspense, lazy } from 'react';

/**
 * The project's dependency picture, as a section of its page.
 *
 * It sits directly under the panorama header, whose counts are a summary of this same graph. The
 * task list — the same tasks as an indented topological plan — is a SEPARATE section further down
 * the page, not the other half of a toggle: 82.5% of tasks in this database have at most one
 * prerequisite, so the list stays the exact reading at any size, while the picture is what makes a
 * mesh legible. Both are worth having, one after the other, and neither is a mode the reader has
 * to select to see.
 */

/**
 * Above this many tasks the graph is not drawn at all — a message is rendered instead.
 *
 * 30 is where a node-link picture stops being the best rendering of this data even when the
 * project IS a mesh; past it the reader is looking at a picture of a hairball and the list, which
 * stays exact at any size, is strictly better. It is checked HERE, on the eager side of the
 * `lazy()` boundary, so an oversized project never downloads React Flow to be told it cannot use
 * it.
 */
export const PROJECT_GRAPH_MAX_NODES = 30;

// React Flow + dagre are heavy and the project page is a frequent one. The graph module is behind
// this boundary and nothing on the page's own import path reaches it, so the section costs the
// first paint nothing — the same arrangement TaskDetailPanel uses for the task-rooted graph.
const LazyProjectDependencyGraph = lazy(async () => {
  const module = await import('./ProjectDependencyGraph');
  return { default: module.ProjectDependencyGraph };
});

/**
 * The section: a heading, and either the graph or the reason there is none.
 *
 * `taskCount` is the project's own task total — the node count the graph would have to draw. It is
 * the page's number, already loaded, so the threshold is decided without a second request and
 * without loading the graph chunk to find out.
 */
export function ProjectTasksGraph({
  projectId,
  taskCount,
}: {
  projectId: string;
  taskCount: number;
}) {
  return (
    <div style={{ marginBottom: 24 }}>
      <Typography.Title level={4}>Task graph</Typography.Title>

      {taskCount > PROJECT_GRAPH_MAX_NODES ? (
        // Said rather than drawn. The alternative — drawing it anyway — spends the download and
        // the layout to produce a picture whose own conclusion is "read the list".
        <div data-testid="project-graph-too-large">
          <Alert
            type="info"
            showIcon
            message="This project is too large to draw"
            description={`${taskCount} tasks is past the ${PROJECT_GRAPH_MAX_NODES}-task limit where a node-link picture stays readable. The task list below shows all of them, in dependency order.`}
          />
        </div>
      ) : (
        <Suspense
          fallback={
            <div style={{ padding: 48, textAlign: 'center' }} data-testid="project-graph-loading" />
          }
        >
          <LazyProjectDependencyGraph projectId={projectId} />
        </Suspense>
      )}
    </div>
  );
}
