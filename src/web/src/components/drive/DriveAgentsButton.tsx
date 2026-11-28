import { CommentOutlined } from '@ant-design/icons';
import { Button } from '../ui/Button';
import type { DriveAgents } from './DriveChatHost';

/**
 * The Drive header's last control and its only primary button (board drive-web 01 ①④): it opens and closes the chat panel,
 * is pressed while the panel is open, wears a white ring in place of its icon while a chat, a sync or an upload is
 * working, and an amber count of what waits on the owner.
 */
export function DriveAgentsButton({ agents }: { agents: DriveAgents }) {
  return (
    <Button
      variant="primary"
      className={`files-agents${agents.open ? ' is-open' : ''}`}
      aria-pressed={agents.open}
      data-working={agents.working || undefined}
      icon={agents.working ? <span className="files-agents-ring" aria-hidden="true" /> : <CommentOutlined />}
      onClick={agents.toggle}
    >
      Agents
      {agents.count > 0 && (
        <span className="files-agents-count" aria-label={`${agents.count} need you`}>
          {agents.count > 99 ? '99+' : agents.count}
        </span>
      )}
    </Button>
  );
}
