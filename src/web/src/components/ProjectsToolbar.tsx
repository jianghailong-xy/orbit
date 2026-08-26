import { PlusOutlined, SearchOutlined } from '@ant-design/icons';
import { Button, Input, Segmented } from 'antd';
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

/**
 * Which projects the list asks the server for.
 *
 * These are the API's three mutually exclusive lifecycle states. There is deliberately no All:
 * mixing terminal history into the attention inbox duplicated Completed both as a filter and as a
 * long section at the bottom, while also calling CANCELLED work completed.
 */
export type ProjectFilter = 'OPEN' | 'DONE' | 'CANCELLED';

const FILTER_OPTIONS: { label: string; value: ProjectFilter }[] = [
  { label: 'Open', value: 'OPEN' },
  { label: 'Completed', value: 'DONE' },
  { label: 'Cancelled', value: 'CANCELLED' },
];

/**
 * The row under the page title: find a project, narrow to a status, or start a new one.
 *
 * Presentational — it holds no state and reads nothing. The page owns both the search text and the
 * filter, because the filter is half of the list's query key and the search is what the empty
 * state has to name; a toolbar that kept them to itself could not be asked what it is showing.
 *
 * The viewport is the one thing it does read, and that is not state either: below
 * PROJECTS_PHONE_QUERY the filter and a labelled create button want 378px of a 361px line on their
 * own, so the row wraps (see .projects-toolbar in index.css) and the button gives up its label —
 * 34px of icon leaves the filter the 229px it needs. Nothing else about the toolbar changes: same
 * control, same handler, same accessible name.
 */
export function ProjectsToolbar({
  search,
  onSearchChange,
  filter,
  onFilterChange,
  onNewProject,
}: {
  search: string;
  onSearchChange: (value: string) => void;
  filter: ProjectFilter;
  onFilterChange: (value: ProjectFilter) => void;
  onNewProject: () => void;
}) {
  const phone = useMediaQuery(PROJECTS_PHONE_QUERY);
  return (
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
      <Segmented<ProjectFilter>
        className="projects-toolbar-filter"
        aria-label="Filter projects by status"
        value={filter}
        onChange={onFilterChange}
        options={FILTER_OPTIONS}
      />
      {/* The label goes, the accessible name does not: an icon-only button with nothing to read
          out is a button nobody can name. `aria-label` only when there is no text, so a screen
          reader is never given the same words twice. */}
      <Button
        type="primary"
        icon={<PlusOutlined />}
        onClick={onNewProject}
        aria-label={phone ? 'New project' : undefined}
      >
        {phone ? null : 'New project'}
      </Button>
    </div>
  );
}
