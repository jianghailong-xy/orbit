import { HomeOutlined } from '@ant-design/icons';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, type SessionDetail } from '../api';
import { encodeId } from '../lib/idCodec';
import {
  CREATED_ON,
  CREATED_RENAME,
  CREATED_RENAME_FAILED,
  CREATED_RENAME_LABEL,
  CREATED_SETTINGS,
  CREATED_WORKSPACE,
} from '../lib/machineSetupCopy';
import { sessionQuery, workspacesQuery } from '../lib/queries';
import { useToast } from '../lib/toast';
import { Input } from './ui/Input';
import './MachineSetupCard.css';

/**
 * The first line of a conversation that made its workspace (board rule 8): what was made, where, and
 * the two ways to change it. Having said that is what lets the send ask nothing more first. Rename is
 * done here; Settings is the workspace's section on its machine's page, as its sidebar row's Configure.
 */
export function CreatedWorkspaceLine({
  sessionId,
  workspace,
  machine,
  runnerId,
}: {
  sessionId: string;
  workspace: { id: string; name: string; workDir?: string | null; deletedAt?: string | null };
  machine: string;
  runnerId: string;
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const message = useToast();
  const [renaming, setRenaming] = useState<string | null>(null);
  const rename = useMutation({
    mutationFn: (name: string) => api(`/workspaces/${workspace.id}`, { method: 'PATCH', body: { name } }),
    onSuccess: (_saved, name) => {
      qc.setQueryData<SessionDetail>(sessionQuery(sessionId).queryKey, (detail) =>
        detail?.workspace ? { ...detail, workspace: { ...detail.workspace, name } } : detail,
      );
      void qc.invalidateQueries({ queryKey: workspacesQuery().queryKey });
      // The session list's rows carry the name too, and the column's title reads it from them.
      void qc.invalidateQueries({ queryKey: ['sessions'] });
    },
    onError: (e: Error) => message.error(CREATED_RENAME_FAILED, e.message),
  });
  // Escape leaves through the same blur as Enter, and has to leave nothing behind.
  const dropped = useRef(false);
  const save = () => {
    const name = renaming?.trim();
    setRenaming(null);
    if (dropped.current) dropped.current = false;
    else if (name && name !== workspace.name) rename.mutate(name);
  };
  // A workspace deleted since is still what this conversation made; it just has nothing to change.
  const live = !workspace.deletedAt;
  return (
    <div className="msc-created">
      <HomeOutlined className="msc-created-mark" aria-hidden="true" />
      <span>{CREATED_WORKSPACE}</span>
      {renaming !== null ? (
        <Input
          className="msc-created-name"
          size="small"
          aria-label={CREATED_RENAME_LABEL}
          autoFocus
          value={renaming}
          onChange={(e) => setRenaming(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === 'Enter' || e.key === 'Escape') {
              dropped.current = e.key === 'Escape';
              e.currentTarget.blur();
            }
          }}
        />
      ) : (
        <b>{rename.isPending ? rename.variables : workspace.name}</b>
      )}
      <span>
        {CREATED_ON} {machine}
      </span>
      {workspace.workDir && (
        <>
          <span className="msc-created-sep">·</span>
          <code>{workspace.workDir}</code>
        </>
      )}
      {live && (
        <>
          <span className="msc-created-sep">·</span>
          <button className="msc-change" type="button" onClick={() => setRenaming(workspace.name)}>
            {CREATED_RENAME}
          </button>
          <span className="msc-created-sep">·</span>
          <button
            className="msc-change"
            type="button"
            onClick={() => navigate(`/runners/${encodeId(runnerId)}?workspace=${encodeId(workspace.id)}`)}
          >
            {CREATED_SETTINGS}
          </button>
        </>
      )}
    </div>
  );
}
