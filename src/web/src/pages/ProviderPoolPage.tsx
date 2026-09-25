import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Popconfirm, Spin } from 'antd';
import { api } from '../api';
import { availabilityOf, PoolAccountsModal, PoolGauge, PoolMembers } from '../components/AccountPools';
import { encodeId, routeId } from '../lib/idCodec';
import { PROVIDERS_BASE, PROVIDERS_LIST_KEY, type ProviderRow } from '../lib/providerAdmin';
import { providerPoolsQuery, type PoolMember } from '../lib/providerPools';
import { useToast } from '../lib/toast';

/**
 * One account pool (/providers/pools/:id), linkable like a provider's own page: its accounts with
 * where each stands, and the ways to change it — add an account, take one out, delete the pool.
 * Taking an account out or deleting the pool leaves the provider itself standing.
 */
export function ProviderPoolPage() {
  const message = useToast();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const poolId = routeId(useParams().id);
  const pools = useQuery(providerPoolsQuery());
  const keys = useQuery({ queryKey: PROVIDERS_LIST_KEY, queryFn: () => api<ProviderRow[]>(PROVIDERS_BASE) });
  const [adding, setAdding] = useState(false);

  const refresh = () => void qc.invalidateQueries({ queryKey: ['providers'] });
  const removeMember = useMutation({
    mutationFn: (member: PoolMember) =>
      api(`/providers/pools/${encodeId(poolId!)}/members/${encodeId(member.id)}`, { method: 'DELETE' }),
    onSuccess: (_, member) => {
      refresh();
      message.success(`${member.label} left the pool`);
    },
    onError: (e: Error) => message.error(e.message || 'Failed'),
  });
  const removePool = useMutation({
    mutationFn: () => api(`/providers/pools/${encodeId(poolId!)}`, { method: 'DELETE' }),
    onSuccess: () => {
      refresh();
      message.success('Pool deleted');
      navigate('/providers');
    },
    onError: (e: Error) => message.error(e.message || 'Failed'),
  });

  if (pools.isPending) {
    return (
      <div style={{ padding: 48, textAlign: 'center' }}>
        <Spin />
      </div>
    );
  }
  const pool = pools.data?.find((row) => routeId(row.id) === poolId);
  if (!pool) {
    return (
      <div className="provider-form">
        <Link className="provider-back" to="/providers">
          ‹ All providers
        </Link>
        <div style={{ marginTop: 16, color: 'var(--text-3)' }}>That pool no longer exists.</div>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 900, margin: '0 auto' }}>
      <Link className="provider-back" to="/providers">
        ‹ All providers
      </Link>
      <div className="pool-page-head">
        <div style={{ minWidth: 0 }}>
          <h1 className="page-title" style={{ marginBottom: 0 }}>
            {pool.label}
          </h1>
          <div style={{ color: 'var(--text-3)', fontSize: 12 }}>
            Account pool · {availabilityOf(pool)} · each session starts on the account with the most
            room in its 5-hour window, and stays on it until that one runs out.
          </div>
        </div>
        <Button type="primary" disabled={keys.isPending} onClick={() => setAdding(true)}>
          Add account
        </Button>
      </div>

      <div className="re-card pool-card pool-detail" data-pool={pool.id}>
        <div className="re-head">
          <span className="re-runner">Accounts</span>
          <span className="re-head-sp" />
          <PoolGauge pool={pool} />
        </div>
        <PoolMembers pool={pool} onRemove={(member) => removeMember.mutate(member)} />
      </div>

      <div className="pool-danger">
        <Popconfirm
          title={`Delete ${pool.label}?`}
          description="Its accounts stay as they are — only the pool goes."
          onConfirm={() => removePool.mutate()}
        >
          <Button danger loading={removePool.isPending}>
            Delete pool
          </Button>
        </Popconfirm>
      </div>

      {adding && <PoolAccountsModal rows={keys.data ?? []} pool={pool} onClose={() => setAdding(false)} />}
    </div>
  );
}
