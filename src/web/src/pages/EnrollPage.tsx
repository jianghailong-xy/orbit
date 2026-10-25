import { useEffect, useState } from 'react';
import { api } from '../api';
import { Alert } from '../components/ui/Alert';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { Descriptions } from '../components/ui/Descriptions';
import { Result } from '../components/ui/Result';
import { Spinner } from '../components/ui/Spinner';
import { useToast } from '../lib/toast';

export interface DeviceInfo {
  userCode: string;
  name: string;
  hostname?: string;
  labels: string[];
  maxConcurrent: number;
  status: string;
  nameConflict?: boolean;
}

/** The identity being approved. The user-chosen name and OS hostname are separate fields. */
export function EnrollmentDetails({ info }: { info: DeviceInfo }) {
  return (
    <Descriptions
      style={{ marginBottom: 16 }}
      items={[
        { key: 'runner', label: 'Runner', children: info.name },
        ...(info.hostname && info.hostname !== info.name ? [{ key: 'hostname', label: 'Hostname', children: info.hostname }] : []),
        {
          key: 'labels',
          label: 'Labels',
          children: info.labels.length ? info.labels.map((l) => <Badge key={l}>{l}</Badge>) : '—',
        },
        { key: 'code', label: 'Code', children: info.userCode },
      ]}
    />
  );
}

/** Browser approval page for `orbit register` (reached via /enroll?code=XXXX-XXXX). */
export function EnrollPage() {
  const message = useToast();
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
      message.error("Couldn't register this machine", (e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div style={{ display: 'grid', placeItems: 'center', minHeight: '100vh', background: 'var(--bg-base)' }}>
      <Card title="🛰 Register a machine" style={{ width: 460 }}>
        {loading ? (
          <div style={{ textAlign: 'center', padding: 24 }}>
            <Spinner />
          </div>
        ) : error ? (
          <Result status="warning" title="Cannot register" subTitle={error} />
        ) : approved ? (
          <Result
            status="success"
            title="Machine approved"
            subTitle={`"${info?.name}" is now registered. Return to your terminal — it will continue automatically.`}
          />
        ) : (
          <>
            <p style={{ marginTop: 0 }}>
              A machine is requesting to register as a runner on your account. Approve it only if you
              just started <code>orbit register</code>.
            </p>
            {info && <EnrollmentDetails info={info} />}
            {info?.nameConflict && (
              <Alert
                type="warning"
                style={{ marginBottom: 16 }}
                title={`This runner ("${info.name}") is already registered on your account.`}
                description="Approving re-issues its credential. The old credential stops working; no duplicate runner is created."
              />
            )}
            <Button
              variant="primary"
              danger={!!info?.nameConflict}
              loading={submitting}
              onClick={() => void approve()}
              style={{ width: '100%' }}
            >
              {info?.nameConflict ? 'Re-register machine' : 'Approve'}
            </Button>
          </>
        )}
      </Card>
    </div>
  );
}
