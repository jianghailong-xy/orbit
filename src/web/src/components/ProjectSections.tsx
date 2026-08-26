import { useId, useState, type ReactNode } from 'react';
import { DownOutlined, UpOutlined } from '@ant-design/icons';
import { Button, List } from 'antd';
import { Link } from 'react-router-dom';
import { encodeId } from '../lib/idCodec';

/** What a section needs of a project in its own right: enough to fold it into a pill. The expanded
 *  row is rendered by the caller, which holds the full shape — this file only decides WHERE the
 *  rows go, never what one says. */
export interface SectionProject {
  id: string;
  title: string;
  _count: { tasks: number };
}

export interface ProjectSection<T extends SectionProject> {
  /** Stable across renders — it is the React key and what a test names a section by. */
  key: string;
  title: string;
  /** The header's small print: what this section is ordered by, so the order is never guessed at. */
  note: string;
  projects: T[];
  /** Folds on first render. Attention lanes stay open; callers may fold secondary sections. */
  defaultCollapsed?: boolean;
  /**
   * Render the rows as a flat list when the surrounding view already names the collection.
   * Headerless sections are always expanded: hiding the only expand control must never hide rows.
   */
  hideHeader?: boolean;
}

/**
 * The projects list, cut into sections with a header apiece.
 *
 * A flat `createdAt desc` list makes the reader do the sorting: finished projects sit between live
 * ones and the list's first job — "which of these still needs me" — is diluted by however many are
 * already done. A section states its own membership, counts itself, and says what it is ordered by.
 *
 * Takes ANY number of sections, because the split is going to get finer: today it is in-progress vs
 * completed, next it is stalled / waiting-to-close / running, and nothing here knows or cares which.
 * The caller decides what the sections are and renders the rows; this decides the chrome around them.
 *
 * Normal sections have uniform collapse controls and fold into pills rather than disappearing.
 * A caller may suppress that chrome when a selected lifecycle filter already supplies the title;
 * that produces a genuinely flat, always-expanded list rather than a section with an invisible
 * control.
 */
export function ProjectSections<T extends SectionProject>({
  sections,
  renderProject,
}: {
  sections: ProjectSection<T>[];
  renderProject: (project: T) => ReactNode;
}) {
  return (
    <>
      {/* An empty section is a header that counts nothing — noise on a list whose whole point is
          what still needs the reader. Dropped here rather than by every caller. */}
      {sections
        .filter((section) => section.projects.length > 0)
        .map((section) => (
          <Section key={section.key} section={section} renderProject={renderProject} />
        ))}
    </>
  );
}

function Section<T extends SectionProject>({
  section,
  renderProject,
}: {
  section: ProjectSection<T>;
  renderProject: (project: T) => ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(section.defaultCollapsed ?? false);
  const headingId = useId();
  const bodyId = useId();
  const rowsCollapsed = !section.hideHeader && collapsed;

  return (
    <section
      aria-labelledby={section.hideHeader ? undefined : headingId}
      aria-label={section.hideHeader ? section.title : undefined}
      data-section={section.key}
      style={{ marginTop: section.hideHeader ? 8 : 20 }}
    >
      {section.hideHeader ? null : (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 9,
            padding: '0 2px 8px',
            borderBottom: '1px solid var(--border-subtle)',
          }}
        >
          <h3
            id={headingId}
            style={{
              margin: 0,
              fontSize: 12.5,
              fontWeight: 650,
              letterSpacing: '0.3px',
              color: 'var(--text-1)',
            }}
          >
            {section.title}
          </h3>
          <span
            style={{
              fontSize: 11.5,
              fontWeight: 600,
              color: 'var(--text-2)',
              background: 'var(--fill-muted)',
              borderRadius: 999,
              padding: '1px 7px',
            }}
          >
            {section.projects.length}
          </span>
          {/* Classed, not just styled: on a phone this sentence is 71 characters folded onto three
              lines above the rows it explains, and index.css takes it away there. The order the
              section is in is a desktop aside; the rows are the page. */}
          <span className="project-section-note" style={{ fontSize: 11.5, color: 'var(--text-3)' }}>
            {section.note}
          </span>
          <Button
            type="text"
            size="small"
            aria-expanded={!collapsed}
            aria-controls={bodyId}
            onClick={() => setCollapsed((c) => !c)}
            style={{ marginLeft: 'auto', fontSize: 11.5, color: 'var(--text-3)' }}
          >
            {collapsed ? 'Expand' : 'Collapse'} {collapsed ? <DownOutlined /> : <UpOutlined />}
          </Button>
        </div>
      )}

      <div id={bodyId}>
        {rowsCollapsed ? (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              flexWrap: 'wrap',
              padding: '10px 0 2px',
            }}
          >
            {section.projects.map((p) => (
              <Pill key={p.id} project={p} />
            ))}
          </div>
        ) : (
          <List dataSource={section.projects} rowKey="id" renderItem={renderProject} />
        )}
      </div>
    </section>
  );
}

/** A folded project: its name, its task count, and the same destination the full row has. Folding
 *  is meant to cost the reader the detail, not the project. */
function Pill<T extends SectionProject>({ project }: { project: T }) {
  return (
    <Link
      to={`/projects/${encodeURIComponent(encodeId(project.id))}`}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        fontSize: 12,
        color: 'var(--text-2)',
        background: 'var(--bg-subtle)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 999,
        padding: '3px 10px',
      }}
    >
      {project.title}
      <span style={{ color: 'var(--text-4)', fontVariantNumeric: 'tabular-nums' }}>
        {project._count.tasks}
      </span>
    </Link>
  );
}
