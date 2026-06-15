import { Tag } from 'antd';

const COLORS: Record<string, string> = {
  DRAFT: 'default',
  QUEUED: 'blue',
  RUNNING: 'processing',
  SUCCEEDED: 'success',
  FAILED: 'error',
  CANCELLED: 'warning',
  PENDING: 'default',
  ONLINE: 'success',
  OFFLINE: 'default',
  DRAINING: 'warning',
};

export function StatusTag({ status }: { status: string }) {
  return <Tag color={COLORS[status] ?? 'default'}>{status}</Tag>;
}
