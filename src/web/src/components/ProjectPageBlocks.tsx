import type { ReactNode } from 'react';

/**
 * The project page's blocks, in the order ProjectDetailPage draws them, and which of them a public
 * link keeps (docs/share-links-design.md §7; mock 04's table). A public project page is the app's
 * page with nine of its sixteen blocks taken out and nothing moved: the seven it keeps are the
 * project's work as a visitor can read it, the nine it drops are the owner's — what they have to
 * answer, merge, run or tell their agents.
 *
 * Both pages mark each block they draw with `data-project-block` (ProjectPageBlock, or the attribute
 * on a block's own root where a wrapper would sit inside a grid), so the order a reader gets is
 * read back out of the rendered page rather than trusted to this list (SharedProjectPage.test).
 */
export const PROJECT_PAGE_BLOCKS = [
  { key: 'header', label: 'Header', public: true },
  { key: 'integration-line', label: 'Integration line', public: false },
  { key: 'open-items', label: 'Open items', public: false },
  { key: 'promotion', label: 'Promotion card', public: false },
  { key: 'coordinator-questions', label: 'Coordinator questions', public: false },
  { key: 'work-overview', label: 'Work overview', public: true },
  { key: 'coordinator', label: 'Coordinator', public: false },
  { key: 'goal', label: 'Goal', public: true },
  { key: 'task-graph', label: 'Task graph', public: true },
  { key: 'chain-progress', label: 'Chain progress', public: true },
  { key: 'blockers', label: 'Blockers', public: false },
  { key: 'run-queue', label: 'Run queue', public: false },
  { key: 'acceptance-criteria', label: 'Acceptance criteria', public: true },
  { key: 'instructions', label: 'Instructions', public: false },
  { key: 'tasks', label: 'Tasks', public: true },
  { key: 'crossings', label: 'Crossings', public: false },
] as const;

export type ProjectPageBlockKey = (typeof PROJECT_PAGE_BLOCKS)[number]['key'];

/**
 * One block of a project page, marked with its key. `display: contents`, so the mark adds no box:
 * the block lays out exactly as it did, and a block that draws nothing leaves nothing but the mark.
 */
export function ProjectPageBlock({ name, children }: { name: ProjectPageBlockKey; children: ReactNode }) {
  return (
    <div data-project-block={name} style={{ display: 'contents' }}>
      {children}
    </div>
  );
}
