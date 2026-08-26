import { Typography } from 'antd';
import { Suspense, lazy } from 'react';

/**
 * The project's dependency picture, as a section of its page.
 *
 * The panorama header above carries counts that summarize this same graph. The task list — the
 * same tasks as an indented topological plan — is a SEPARATE section further down
 * the page, not the other half of a toggle: 82.5% of tasks in this database have at most one
 * prerequisite, so the list stays the exact reading at any size, while the picture is what makes a
 * mesh legible. Both are worth having, one after the other, and neither is a mode the reader has
 * to select to see.
 *
 * ## No node count is too many to draw
 *
 * This section used to refuse a project over 30 tasks and print the reason instead of the picture.
 * That is no longer a rule: a reader who opens a 118-task project and is told the drawing would be
 * unreadable is given neither the drawing nor a way to judge that for themselves. The graph draws
 * whatever the server serves, and the reading a big plan needs — the whole shape at once, then a
 * part of it up close — is what the canvas's fit-to-view, its full-screen mode and its mini map
 * are for.
 *
 * The one cap that remains is the server's: `GET /projects/:id/dependency-graph` answers with at
 * most `PROJECT_DEPENDENCY_GRAPH_MAX_NODES` (500) tasks and sets `truncated` when it bites, which
 * the graph says on the canvas. Past that size the task list below is the complete reading.
 */

// React Flow + dagre are heavy and the project page is a frequent one. The graph module is behind
// this boundary and nothing on the page's own import path reaches it, so the section costs the
// first paint nothing — the same arrangement TaskDetailPanel uses for the task-rooted graph.
const LazyProjectDependencyGraph = lazy(async () => {
  const module = await import('./ProjectDependencyGraph');
  return { default: module.ProjectDependencyGraph };
});

/** The section: a heading, and the graph under it. */
export function ProjectTasksGraph({ projectId }: { projectId: string }) {
  return (
    <div style={{ marginBottom: 24 }}>
      {/* The legend belongs here, at a size a reader can read. It used to be a 10.5px chip pinned
          into the bottom corner of the canvas, permanently, for a fact that is learned once. */}
      <div className="pdg-section-head">
        <Typography.Title level={4} style={{ margin: 0 }}>
          Task graph
        </Typography.Title>
        <span className="pdg-legend">Prerequisite → dependent · boxes are parent tasks</span>
      </div>

      <Suspense
        fallback={
          <div style={{ padding: 48, textAlign: 'center' }} data-testid="project-graph-loading" />
        }
      >
        <LazyProjectDependencyGraph projectId={projectId} />
      </Suspense>
    </div>
  );
}
