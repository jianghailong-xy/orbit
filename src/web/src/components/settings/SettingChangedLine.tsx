import { createContext, type ComponentType, type JSX } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api';
import { meQuery, type Me } from '../../lib/queries';
import { SETTINGS_CHANGE_COPY as COPY, changedByLead, settingKeyOfAnchor } from '../../lib/settingsChange';
import { useToast } from '../../lib/toast';
import { ago, linkId } from '../../lib/watches';
import { AppLink } from '../AppLink';

/**
 * What a SettingsRow draws under itself when its setting was last changed from a conversation (docs/settings-from-
 * conversation-design.md §8.2, board 3 note 8): Settings provides it (SettingsLayout), so a row drawn anywhere else
 * draws nothing and reads no account.
 */
export const SettingChangedLineSlot = createContext<ComponentType<{ anchor: string }> | null>(null);

/**
 * `Turned on from <conversation> · 2m ago · Undo` (`Set from …` for a value that is not a switch), in the description's
 * grey. The title opens the conversation; Undo is the owner's own PATCH with the value the card replaced (§5.3), which
 * also ends the mark (board 3 note 9).
 */
export function SettingChangedLine({ anchor }: { anchor: string }): JSX.Element | null {
  const key = settingKeyOfAnchor(anchor);
  const me = useQuery(meQuery());
  const qc = useQueryClient();
  const message = useToast();
  const undo = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<Me>('/users/me/preferences', { method: 'PATCH', body }),
    onSuccess: (updated) => {
      qc.setQueryData(meQuery().queryKey, updated);
      message.success('Setting saved');
    },
    onError: (e: Error) => message.error("Couldn't save the setting", e.message),
  });
  const mark = key ? me.data?.changedBy?.[key] : undefined;
  if (!key || !mark) return null;
  return (
    <div className="settings-row-changed" data-changed-by={key}>
      {`${changedByLead(mark)} `}
      {mark.sessionTitle !== null ? (
        <AppLink to={`/sessions/${linkId(mark.sessionId)}`}>{mark.sessionTitle || 'Untitled conversation'}</AppLink>
      ) : (
        COPY.aConversation
      )}
      {` · ${ago(mark.at, Date.now())} · `}
      <button
        type="button"
        className="settings-row-changed-undo"
        disabled={undo.isPending}
        onClick={() => undo.mutate({ [key]: mark.from })}
      >
        {COPY.undo}
      </button>
    </div>
  );
}
