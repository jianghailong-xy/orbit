import { Alert } from 'antd';
import { Suspense, lazy, useState, type ReactNode } from 'react';

/**
 * `List | Graph` for a project's task section.
 *
 * List is the default and Graph is the option, never the other way round, and that is a product
 * decision rather than an implementation accident: 82.5% of tasks in this database have at most
 * one prerequisite, which an indented topological list expresses without loss. A node-link picture
 * earns its place only on the minority of projects that are genuinely a mesh, so it is offered —
 * and remembered — but never assumed. `DEFAULT_PROJECT_TASKS_VIEW` below is the single place that
 * says so.
 */
export type ProjectTasksView = 'list' | 'graph';

export const DEFAULT_PROJECT_TASKS_VIEW: ProjectTasksView = 'list';

/** Where the last pick is remembered. Account-independent: this is a reading preference. */
export const PROJECT_TASKS_VIEW_STORAGE_KEY = 'orbit-project-tasks-view';

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
// this boundary and nothing on the page's own import path reaches it, so adding this toggle costs
// the first paint nothing — the same arrangement TaskDetailPanel uses for the task-rooted graph.
const LazyProjectDependencyGraph = lazy(async () => {
  const module = await import('./ProjectDependencyGraph');
  return { default: module.ProjectDependencyGraph };
});

/**
 * The view to open on: whatever was last picked, else List.
 *
 * A stored value that is not one of the two words is discarded rather than trusted — the default
 * has to survive a stale or hand-edited key, otherwise "always List unless the reader chose
 * otherwise" quietly becomes "whatever is in storage". Storage is read defensively for the reason
 * `initialTaskFilter` reads it that way: Safari's private mode throws on access, and a section
 * that will not render is a worse outcome than a forgotten preference.
 */
export function initialProjectTasksView(): ProjectTasksView {
  try {
    const stored = localStorage.getItem(PROJECT_TASKS_VIEW_STORAGE_KEY);
    return stored === 'graph' || stored === 'list' ? stored : DEFAULT_PROJECT_TASKS_VIEW;
  } catch {
    return DEFAULT_PROJECT_TASKS_VIEW;
  }
}

export function rememberProjectTasksView(view: ProjectTasksView): void {
  try {
    localStorage.setItem(PROJECT_TASKS_VIEW_STORAGE_KEY, view);
  } catch {
    /* preference is a convenience; losing it must never break the view */
  }
}

/**
 * The segmented control and whichever view it selects.
 *
 * The List view arrives as `children` rather than being imported here: the list is part of the
 * project page and importing it back would close a cycle, and a toggle that does not know what it
 * is toggling between is also the one that can be mounted on its own in a test.
 *
 * `taskCount` is the project's own task total — the node count the graph would have to draw. It is
 * the page's number, already loaded, so the threshold is decided without a second request and
 * without loading the graph chunk to find out.
 */
export function ProjectTasksViewToggle({
  projectId,
  taskCount,
  children,
}: {
  projectId: string;
  taskCount: number;
  children: ReactNode;
}) {
  const [view, setView] = useState<ProjectTasksView>(initialProjectTasksView);
  const choose = (next: ProjectTasksView) => {
    setView(next);
    rememberProjectTasksView(next);
  };
  const tooLarge = taskCount > PROJECT_GRAPH_MAX_NODES;

  return (
    <div>
      {/* A group, not two loose buttons: a reader arriving on the second one needs to be told what
          the pair is for, and `aria-pressed` is what says which of them is currently in effect. */}
      <div
        className="ptv-toggle"
        role="group"
        aria-label="Task view"
        style={{ display: 'flex', gap: 4, marginBottom: 12 }}
      >
        <button
          type="button"
          aria-pressed={view === 'list'}
          className={`ptv-toggle-option${view === 'list' ? ' is-selected' : ''}`}
          onClick={() => choose('list')}
        >
          List
        </button>
        <button
          type="button"
          aria-pressed={view === 'graph'}
          className={`ptv-toggle-option${view === 'graph' ? ' is-selected' : ''}`}
          onClick={() => choose('graph')}
        >
          Graph
        </button>
      </div>

      {view === 'list' ? (
        children
      ) : tooLarge ? (
        // Said rather than drawn. The alternative — drawing it anyway — spends the download and
        // the layout to produce a picture whose own conclusion is "use the list".
        <div data-testid="project-graph-too-large">
          <Alert
            type="info"
            showIcon
            message="This project is too large to draw"
            description={`${taskCount} tasks is past the ${PROJECT_GRAPH_MAX_NODES}-task limit where a node-link picture stays readable. The List view shows all of them, in dependency order.`}
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
