import { PlusOutlined, SearchOutlined } from '@ant-design/icons';
import { Button, Input, Segmented } from 'antd';

/**
 * Which projects the list asks the server for.
 *
 * 'ALL' is not a status the API knows — it is the ABSENCE of `?status=`, which is why this is its
 * own vocabulary rather than `ProjectStatus | undefined`: a segmented control has to have a value
 * for every segment, including the one that narrows nothing.
 *
 * 'DONE' rather than "everything that is not open": `?status=` takes one status, and DONE is the
 * one this segment names. A CANCELLED project is not a completed one — it is work that will not
 * happen — and it stays reachable under All, where the Completed SECTION (which is defined as
 * "not open") folds it away with the finished work.
 */
export type ProjectFilter = 'ALL' | 'OPEN' | 'DONE';

const FILTER_OPTIONS: { label: string; value: ProjectFilter }[] = [
  { label: 'All', value: 'ALL' },
  { label: 'In progress', value: 'OPEN' },
  { label: 'Completed', value: 'DONE' },
];

/**
 * The row under the page title: find a project, narrow to a status, or start a new one.
 *
 * Presentational — it holds no state and reads nothing. The page owns both the search text and the
 * filter, because the filter is half of the list's query key and the search is what the empty
 * state has to name; a toolbar that kept them to itself could not be asked what it is showing.
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
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '0 0 6px' }}>
      <Input
        // Titles AND goals, said out loud: the goal is a paragraph the row only shows a line of,
        // so a reader typing a word they remember from it has no other way to know it counts.
        placeholder="Search projects and goals"
        aria-label="Search projects"
        prefix={<SearchOutlined style={{ color: 'var(--text-4)' }} />}
        allowClear
        value={search}
        onChange={(e) => onSearchChange(e.target.value)}
        style={{ flex: 1 }}
      />
      <Segmented<ProjectFilter>
        aria-label="Filter projects by status"
        value={filter}
        onChange={onFilterChange}
        options={FILTER_OPTIONS}
      />
      <Button type="primary" icon={<PlusOutlined />} onClick={onNewProject}>
        New project
      </Button>
    </div>
  );
}
