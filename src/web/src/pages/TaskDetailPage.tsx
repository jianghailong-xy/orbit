import { Typography } from 'antd';
import { Link, useParams } from 'react-router-dom';

// Task is not implemented yet — the task list is mock data, so there is no real
// task detail / run stream to show. The live feature is interactive Agent
// sessions (open an Agent from the sidebar).
export function TaskDetailPage() {
  const { id } = useParams();
  return (
    <div style={{ padding: 24 }}>
      <Link to="/tasks" style={{ color: '#646a73' }}>
        ← Back to Tasks
      </Link>
      <Typography.Paragraph style={{ marginTop: 16 }}>
        Task detail isn’t available yet — Task is mock data for now. Open an Agent from the sidebar
        to start a live interactive session.
      </Typography.Paragraph>
      <Typography.Text type="secondary">id: {id}</Typography.Text>
    </div>
  );
}
