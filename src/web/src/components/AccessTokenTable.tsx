import type { ReactNode } from 'react';
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
import { Badge } from './ui/Badge';
import { Button } from './ui/Button';
import { Popconfirm } from './ui/Popconfirm';
import { TableScroll } from './ui/Table';

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
  const columns: { title: string; cell: (token: AccessToken) => ReactNode; end?: boolean }[] = [
    {
      title: 'Name',
      cell: (token) => (
        <>
          <div className="access-token-title">{token.name}</div>
          <div className="access-token-sub access-token-hint">orbit_pat_…{token.tokenHint}</div>
        </>
      ),
    },
    { title: 'Access', cell: (token) => <span title={token.scopes.join(', ')}>{scopeSummary(token.scopes)}</span> },
    { title: 'Workspaces', cell: workspacesLine },
    {
      title: 'Expires',
      cell: (token) =>
        token.state !== 'ACTIVE' ? (
          <span className="access-token-ended-line">{endedLine(token)}</span>
        ) : token.expiresAt === null ? (
          <Badge tone="warning" className="access-token-never">
            {NEVER_EXPIRES}
          </Badge>
        ) : (
          <>
            <div>{fullDate(token.expiresAt)}</div>
            <div className="access-token-sub">{untilLine(token.expiresAt, now)}</div>
          </>
        ),
    },
    {
      title: 'Last used',
      cell: (token) =>
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
      cell: (token) => (
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
      end: true,
      cell: (token) =>
        token.state === 'ACTIVE' && (
          <Popconfirm
            trigger={
              <Button size="small" danger loading={revokingId === token.id}>
                Revoke
              </Button>
            }
            title={`Revoke “${token.name}”?`}
            description="Anything using it stops working at once. This can’t be undone."
            confirmText="Revoke"
            danger
            cancelText="Cancel"
            onConfirm={() => onRevoke(token)}
          />
        ),
    });
  }
  const end = { textAlign: 'right' } as const;
  return (
    <TableScroll>
      <table className="orbit-table access-token-table">
        <thead>
          <tr>
            {columns.map((column, index) => (
              <th key={index} scope="col" style={column.end ? end : undefined}>
                {column.title}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {tokens.length === 0 ? (
            <tr className="orbit-table-empty">
              <td colSpan={columns.length}>
                <div>{emptyText}</div>
              </td>
            </tr>
          ) : (
            tokens.map((token) => (
              <tr key={token.id} className={token.state === 'ACTIVE' ? undefined : 'access-token-ended'}>
                {columns.map((column, index) => (
                  <td key={index} style={column.end ? end : undefined}>
                    {column.cell(token)}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </TableScroll>
  );
}
