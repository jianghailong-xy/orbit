import { Button, Popconfirm, Table, Tag, type TableColumnsType } from 'antd';
import type { AccessToken } from '../api';
import {
  CREATED_VIA,
  NEVER_EXPIRES,
  endedLine,
  fullDate,
  scopeSummary,
  untilLine,
} from '../lib/accessTokens';
import { ago } from '../lib/watches';

/** Which workspaces a token reaches: all of them, or those it is confined to. */
function workspacesLine(token: AccessToken): string {
  if (token.workspaceIds.length === 0) return 'All workspaces';
  const gone = token.workspaceIds.length - token.workspaces.length;
  const names = token.workspaces.map((workspace) => workspace.name);
  if (gone > 0) names.push(gone === 1 ? 'a deleted workspace' : `${gone} deleted workspaces`);
  return names.join(', ');
}

/**
 * Personal access tokens as their owner's Settings page and an administrator's Users page both list
 * them (docs/personal-access-token-design.md §9, §11.4): what each can do and where, when it expires —
 * one that never does is marked so — when and from where it was last used, and how it was made.
 * Never the token itself: Orbit does not keep it. Given `onRevoke`, a token that still works can be
 * revoked from its row.
 */
export function AccessTokenTable({
  tokens,
  now,
  onRevoke,
  revokingId,
  emptyText,
}: {
  tokens: readonly AccessToken[];
  now: number;
  onRevoke?: (token: AccessToken) => void;
  /** The token whose revoke is on its way. */
  revokingId?: string | null;
  emptyText: string;
}) {
  const columns: TableColumnsType<AccessToken> = [
    {
      title: 'Name',
      key: 'name',
      render: (_, token) => (
        <>
          <div className="access-token-title">{token.name}</div>
          <div className="access-token-sub access-token-hint">orbit_pat_…{token.tokenHint}</div>
        </>
      ),
    },
    {
      title: 'Access',
      key: 'scopes',
      render: (_, token) => <span title={token.scopes.join(', ')}>{scopeSummary(token.scopes)}</span>,
    },
    { title: 'Workspaces', key: 'workspaces', render: (_, token) => workspacesLine(token) },
    {
      title: 'Expires',
      key: 'expires',
      render: (_, token) =>
        token.state !== 'ACTIVE' ? (
          <span className="access-token-ended-line">{endedLine(token)}</span>
        ) : token.expiresAt === null ? (
          <Tag color="warning" className="access-token-never">
            {NEVER_EXPIRES}
          </Tag>
        ) : (
          <>
            <div>{fullDate(token.expiresAt)}</div>
            <div className="access-token-sub">{untilLine(token.expiresAt, now)}</div>
          </>
        ),
    },
    {
      title: 'Last used',
      key: 'used',
      render: (_, token) =>
        token.lastUsedAt ? (
          <>
            <div>{ago(token.lastUsedAt, now)}</div>
            <div className="access-token-sub" title={token.lastUsedUserAgent ?? undefined}>
              {token.lastUsedIp ?? 'Address unknown'}
            </div>
          </>
        ) : (
          <span className="access-token-sub">Never used</span>
        ),
    },
    {
      title: 'Created',
      key: 'created',
      render: (_, token) => (
        <>
          <div>{fullDate(token.createdAt)}</div>
          <div className="access-token-sub">{CREATED_VIA[token.createdVia]}</div>
        </>
      ),
    },
  ];
  if (onRevoke) {
    columns.push({
      title: '',
      key: 'actions',
      align: 'right',
      render: (_, token) =>
        token.state === 'ACTIVE' && (
          <Popconfirm
            title={`Revoke “${token.name}”?`}
            description="Anything using it stops working at once. This can’t be undone."
            okText="Revoke"
            okButtonProps={{ danger: true }}
            cancelText="Cancel"
            onConfirm={() => onRevoke(token)}
          >
            <Button size="small" danger loading={revokingId === token.id}>
              Revoke
            </Button>
          </Popconfirm>
        ),
    });
  }
  return (
    <Table<AccessToken>
      className="access-token-table"
      rowKey="id"
      dataSource={[...tokens]}
      columns={columns}
      pagination={false}
      scroll={{ x: 'max-content' }}
      locale={{ emptyText }}
      rowClassName={(token) => (token.state === 'ACTIVE' ? '' : 'access-token-ended')}
    />
  );
}
