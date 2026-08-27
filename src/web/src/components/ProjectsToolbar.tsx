import { PlusOutlined, SearchOutlined } from '@ant-design/icons';
import { Button, Input, Segmented } from 'antd';
import { useId } from 'react';
import { useMediaQuery } from '../lib/useMediaQuery';

/**
 * Where a projects row's three columns stop fitting on one line.
 *
 * A row is `text | 196px meter | 78px dates`, and on a 393px phone the row is 341px wide — so the
 * two fixed columns and their gaps take 306px and leave the title 35px, which the badges then eat
 * outright. Kept identical to the `@media` block in index.css that folds the row, because the
 * decisions on both sides of that width (fold the row / drop the status tag the section header
 * already states / shrink this button to its icon) have to flip together or they contradict.
 *
 * 640 and not the app's existing 960: 960 is where three columns stop fitting, while this is where
 * 306px of fixed columns stops fitting — a portrait tablet still has a 736px row and reads fine.
 */
export const PROJECTS_PHONE_QUERY = '(max-width: 640px)';

/** The API's three mutually exclusive, persisted project lifecycle states. */
export type ProjectFilter = 'OPEN' | 'DONE' | 'CANCELLED';

/** A local view over the one OPEN response. Running and Ready never become lifecycle states. */
export type OpenProjectView = 'ALL' | 'RUNNING' | 'READY';

const HISTORY_OPTIONS: { label: string; value: Exclude<ProjectFilter, 'OPEN'> }[] = [
  { label: 'Completed', value: 'DONE' },
  { label: 'Cancelled', value: 'CANCELLED' },
];

function counted(label: string, count: number | undefined): string {
  return count === undefined ? label : `${label} ${count.toLocaleString('en-US')}`;
}

/**
 * The Projects heading and its controls.
 *
 * Lifecycle and execution are deliberately not one segmented control. Open is the default page
 * scope; All / Running / Ready narrow that scope locally. History is a separate destination and
 * only then exposes Completed / Cancelled. This keeps the everyday surface to one selectable row
 * without pretending Running is a sibling of Open.
 */
export function ProjectsToolbar({
  search,
  onSearchChange,
  filter,
  onFilterChange,
  openView,
  onOpenViewChange,
  runningCount,
  readyCount,
  onNewProject,
}: {
  search: string;
  onSearchChange: (value: string) => void;
  filter: ProjectFilter;
  onFilterChange: (value: ProjectFilter) => void;
  openView: OpenProjectView;
  onOpenViewChange: (value: OpenProjectView) => void;
  runningCount?: number;
  readyCount?: number;
  onNewProject: () => void;
}) {
  const phone = useMediaQuery(PROJECTS_PHONE_QUERY);
  const scopeHeadingId = useId();
  const open = filter === 'OPEN';
  const openOptions: { label: string; value: OpenProjectView }[] = [
    { label: 'All', value: 'ALL' },
    { label: counted('Running', runningCount), value: 'RUNNING' },
    { label: counted('Ready', readyCount), value: 'READY' },
  ];

  return (
    <>
      <div className="projects-title-row">
        <h1 className="page-title">Projects</h1>
        <div className="projects-title-actions">
          <Button
            type="text"
            className="projects-scope-action"
            onClick={() => onFilterChange(open ? 'DONE' : 'OPEN')}
          >
            {open ? 'History' : 'Open projects'}
          </Button>
          {/* The label goes on a phone, the accessible name does not. */}
          <Button
            className="projects-new-button"
            type="primary"
            icon={<PlusOutlined />}
            onClick={onNewProject}
            aria-label={phone ? 'New project' : undefined}
          >
            {phone ? null : 'New project'}
          </Button>
        </div>
      </div>

      <div className="projects-toolbar">
        <Input
          className="projects-toolbar-search"
          // Titles AND goals, said out loud: the goal is a paragraph the row only shows a line of,
          // so a reader typing a word they remember from it has no other way to know it counts.
          placeholder="Search projects and goals"
          aria-label="Search projects"
          prefix={<SearchOutlined style={{ color: 'var(--text-4)' }} />}
          allowClear
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
        />

        <div className="projects-toolbar-scope">
          <h2 id={scopeHeadingId} className="projects-toolbar-scope-label">
            {open ? 'Open projects' : 'Project history'}
          </h2>
          {open ? (
            <Segmented<OpenProjectView>
              className="projects-toolbar-filter"
              aria-labelledby={scopeHeadingId}
              value={openView}
              onChange={onOpenViewChange}
              options={openOptions}
            />
          ) : (
            <Segmented<Exclude<ProjectFilter, 'OPEN'>>
              className="projects-toolbar-filter"
              aria-labelledby={scopeHeadingId}
              value={filter}
              onChange={(value) => onFilterChange(value)}
              options={HISTORY_OPTIONS}
            />
          )}
        </div>
      </div>
    </>
  );
}
