import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api';
import { meQuery, type Me, type UserPreferences } from '../../lib/queries';
import { useToast } from '../../lib/toast';

/**
 * The account's preferences as the Personal pages read them, and the one way they write them: a PATCH of
 * the fields that changed, the account it answers with taken as the one every view shows, and a toast.
 */
export function usePreferences() {
  const message = useToast();
  const qc = useQueryClient();
  const me = useQuery(meQuery());
  const prefs: UserPreferences = me.data?.preferences ?? {};
  const save = useMutation({
    mutationFn: (patch: UserPreferences) => api<Me>('/users/me/preferences', { method: 'PATCH', body: patch }),
    onSuccess: (updated) => {
      qc.setQueryData(meQuery().queryKey, updated);
      message.success('Setting saved');
    },
    onError: (e: Error) => message.error("Couldn't save the setting", e.message),
  });
  return { prefs, save };
}
