import { Alert, App as AntApp, Button, Card, Descriptions, Result, Spin, Tag } from 'antd';
import { useEffect, useState } from 'react';
import { api } from '../api';

interface DeviceInfo {
  userCode: string;
  name: string;
  hostname?: string;
  labels: string[];
  maxConcurrent: number;
  status: string;
  nameConflict?: boolean;
}

/** Browser approval page for `orbit register` (reached via /enroll?code=XXXX-XXXX). */
export function EnrollPage() {
  const { message } = AntApp.useApp();
  const code = new URLSearchParams(window.location.search).get('code') ?? '';
  const [info, setInfo] = useState<DeviceInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [approved, setApproved] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!code) {
      setError('Missing enrollment code.');
      setLoading(false);
      return;
    }
    api<DeviceInfo>(`/runners/device/${encodeURIComponent(code)}`)
      .then((d) => {
        setInfo(d);
        setApproved(d.status === 'APPROVED');
      })
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, [code]);

  const approve = async () => {
    setSubmitting(true);
    try {
      await api(`/runners/device/${encodeURIComponent(code)}/approve`, { method: 'POST' });
      setApproved(true);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div style={{ display: 'grid', placeItems: 'center', minHeight: '100vh', background: '#f0f2f5' }}>
      <Card title="🛰 Register a machine" style={{ width: 460 }}>
        {loading ? (
          <div style={{ textAlign: 'center', padding: 24 }}>
            <Spin />
          </div>
        ) : error ? (
          <Result status="warning" title="Cannot register" subTitle={error} />
        ) : approved ? (
          <Result
            status="success"
            title="Machine approved"
            subTitle={`"${info?.hostname || info?.name}" is now registered. Return to your terminal — it will continue automatically.`}
          />
        ) : (
          <>
            <p style={{ marginTop: 0 }}>
              A machine is requesting to register as a runner on your account. Approve it only if you
              just started <code>orbit register</code>.
            </p>
            <Descriptions column={1} size="small" bordered style={{ marginBottom: 16 }}>
              <Descriptions.Item label="Runner">{info?.hostname || info?.name}</Descriptions.Item>
              <Descriptions.Item label="Agents">{info?.name}/…</Descriptions.Item>
              <Descriptions.Item label="Labels">
                {info?.labels?.length ? info.labels.map((l) => <Tag key={l}>{l}</Tag>) : '—'}
              </Descriptions.Item>
              <Descriptions.Item label="Code">{info?.userCode}</Descriptions.Item>
            </Descriptions>
            {info?.nameConflict && (
              <Alert
                type="warning"
                showIcon
                style={{ marginBottom: 16 }}
                message={`This machine ("${info.hostname || info.name}") is already registered on your account.`}
                description="Approving re-issues its credential and adds/updates this directory's agent. The old credential stops working; no duplicate machine is created."
              />
            )}
            <Button
              type="primary"
              danger={!!info?.nameConflict}
              block
              loading={submitting}
              onClick={approve}
            >
              {info?.nameConflict ? 'Re-register machine' : 'Approve'}
            </Button>
          </>
        )}
      </Card>
    </div>
  );
}
