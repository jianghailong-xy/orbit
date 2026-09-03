import { useQuery } from '@tanstack/react-query';
import { Alert, Tag, Typography } from 'antd';
import { api } from '../api';
import type { AttributionProjectStatus } from '../lib/attribution';

/**
 * Unit L7, criterion 1: what a person is told, before they submit, about where this
 * work is going to be filed.
 *
 * The incident behind the whole L unit was a batch of tasks landing in a project nobody meant, and
 * the reason nobody caught it is that no screen ever said which project a create was filing into —
 * it was implied by the page, and an implication is not something you can be wrong about out loud.
 * So this is deliberately not decoration: the TITLE and the Base62 ID together, because a title
 * alone cannot be looked up and an id alone cannot be read, plus the status, because filing into a
 * settled project is refused (`PROJECT_REOPEN_REQUIRED`) and finding that out from the submit
 * button is finding it out too late.
 *
 * Reads `['project', id]` — the key the project page has already filled — so on that page this
 * costs no request at all and shows the same document the header above it is showing.
 */

interface FilingProject {
  publicId?: string;
  title: string;
  status: AttributionProjectStatus;
}

export function ProjectFilingBanner({ projectId }: { projectId: string }) {
  const project = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api<FilingProject>(`/projects/${encodeURIComponent(projectId)}`),
    enabled: Boolean(projectId),
  });
  const id = project.data?.publicId ?? projectId;
  const settled = project.data ? project.data.status !== 'OPEN' : false;

  return (
    <div
      style={{
        marginBottom: 12,
        padding: '8px 12px',
        border: '1px solid var(--border)',
        borderRadius: 6,
        background: 'var(--fill-muted)',
      }}
    >
      <Typography.Text type="secondary">Filing into </Typography.Text>
      {/* The id is shown even while the title is still loading: it is the part that is knowable
          without a request, and a banner that rendered nothing until the fetch resolved would be
          absent for exactly as long as somebody is reading the form. */}
      <Typography.Text strong>{project.data?.title ?? 'this project'}</Typography.Text>{' '}
      <Typography.Text code copyable={{ text: id }}>
        {id}
      </Typography.Text>
      {project.data ? (
        <>
          {' '}
          <Tag aria-label={`Project status ${project.data.status}`}>{project.data.status}</Tag>
        </>
      ) : null}
      {settled ? (
        <Alert
          style={{ marginTop: 8 }}
          type="warning"
          showIcon
          message="This project is settled"
          description={
            'A settled project takes no new work: this create is refused with '
            + 'PROJECT_REOPEN_REQUIRED until somebody reopens it.'
          }
        />
      ) : null}
    </div>
  );
}
