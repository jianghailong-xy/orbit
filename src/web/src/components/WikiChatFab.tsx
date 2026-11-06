import { CheckOutlined, CommentOutlined } from '@ant-design/icons';
import { Tooltip } from './ui/Tooltip';
import type { WikiChatFabState } from '../lib/wikiChat';

/**
 * The round button at the window's bottom right (design §3, board 42 ⓪): an icon alone, its hover the state's
 * words. Four looks, read from the space's chats (`wikiChatFab`): at rest; a ring going round while a chat's
 * turn or a rewrite runs; an amber number while something waits on the owner; a green check once a rewrite came
 * out and has not been opened. It is fixed to the window, above the entry drawer, and hidden while the panel is
 * open (`WikiChatHost`).
 */
export function WikiChatFab({
  state,
  label,
  count,
  onOpen,
}: {
  state: WikiChatFabState;
  label: string;
  /** The amber number, while it needs the owner. */
  count: number;
  onOpen: () => void;
}) {
  return (
    <Tooltip content={label} side="left">
      <button type="button" className={`wk-chat-fab is-${state}`} data-state={state} aria-label={label} onClick={onOpen}>
        {state === 'working' && <span className="wk-chat-fab-ring" aria-hidden="true" />}
        <CommentOutlined className="ic" aria-hidden="true" />
        {state === 'needs_you' && (
          <span className="wk-chat-fab-badge amb" aria-hidden="true">
            {count > 99 ? '99+' : count}
          </span>
        )}
        {state === 'updated' && (
          <span className="wk-chat-fab-badge ok" aria-hidden="true">
            <CheckOutlined />
          </span>
        )}
      </button>
    </Tooltip>
  );
}
