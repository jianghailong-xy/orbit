import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { api, setAvatar } from '../api';
import { SettingsCard, SettingsHeader, SettingsRow, SettingsSection } from '../components/settings';
import { SignInMethodsCard } from '../components/SignInMethodsCard';
import { Avatar } from '../components/ui/Avatar';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { squareJpeg } from '../lib/avatar';
import { avatarQuery, meQuery, type Me } from '../lib/queries';
import { useToast } from '../lib/toast';
import { PERSONAL_SETTINGS as S } from './settings/settingsIndex';

/** Under the name: who sees it besides you. The iOS edit-profile card says the same
 *  (`SettingsCopy.nameCaption`). */
export const NAME_CAPTION = 'People in your shared pools see you by this name.';
/** The photo's two actions, in the words the iOS and macOS apps use (`SettingsCopy`). */
export const CHOOSE_PHOTO = 'Choose photo';
export const REMOVE_PHOTO = 'Remove photo';

// Self-service profile page: your identity — the photo and the name, which you change here, and the
// email you sign in with — plus how you sign in (a password, changed in a dialog from its row, and the
// Google account connected or to connect; SignInMethodsCard). A photo is cut to its middle square and
// sent the moment it is chosen; the name is written by its Save.
export function ProfilePage() {
  const message = useToast();
  const qc = useQueryClient();
  const me = useQuery(meQuery());
  const photo = useQuery(avatarQuery(me.data?.avatarUpdatedAt));
  const chooser = useRef<HTMLInputElement>(null);
  /** The name as it is being edited; null until touched, so the saved one shows. */
  const [edited, setEdited] = useState<string | null>(null);
  const draft = edited ?? me.data?.name ?? '';
  const canSave = draft.trim() !== '' && draft.trim() !== (me.data?.name ?? '');
  const initial = (me.data?.name || me.data?.email || '?').trim().charAt(0).toUpperCase();

  /** Every write here answers with the account; it becomes the one every view shows. */
  const adopt = (account: Me) => qc.setQueryData(meQuery().queryKey, account);

  const rename = useMutation({
    mutationFn: () => api<Me>('/users/me', { method: 'PATCH', body: { name: draft.trim() } }),
    onSuccess: (account) => {
      adopt(account);
      setEdited(null);
      message.success('Name saved');
    },
    onError: (e: Error) => message.error("Couldn't save your name", e.message),
  });
  const upload = useMutation({
    mutationFn: async (file: File) => setAvatar(await squareJpeg(file)),
    onSuccess: adopt,
    onError: (e: Error) => message.error("Couldn't save your photo", e.message),
  });
  const remove = useMutation({
    mutationFn: () => api<Me>('/users/me/avatar', { method: 'DELETE' }),
    onSuccess: adopt,
    onError: (e: Error) => message.error("Couldn't remove your photo", e.message),
  });

  return (
    <div className="settings-page">
      <SettingsHeader title="Profile" />

      <SettingsSection title="Basic information">
        <SettingsCard>
          <SettingsRow
            anchor={S.photo.anchor}
            title={S.photo.title}
            control={
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <Avatar size={40} src={photo.data} style={{ background: 'var(--brand)', flex: 'none', fontSize: 18 }}>
                  {initial}
                </Avatar>
                <Button loading={upload.isPending} onClick={() => chooser.current?.click()}>
                  {CHOOSE_PHOTO}
                </Button>
                {me.data?.avatarUpdatedAt && (
                  <Button loading={remove.isPending} onClick={() => remove.mutate()}>
                    {REMOVE_PHOTO}
                  </Button>
                )}
                <input
                  ref={chooser}
                  type="file"
                  accept="image/*"
                  hidden
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = '';
                    if (file) upload.mutate(file);
                  }}
                />
              </div>
            }
          />
          <SettingsRow
            anchor={S.name.anchor}
            title={S.name.title}
            description={NAME_CAPTION}
            control={
              <div style={{ display: 'flex', gap: 8 }}>
                <Input
                  aria-label="Name"
                  style={{ width: 200 }}
                  value={draft}
                  maxLength={80}
                  autoComplete="name"
                  onChange={(e) => setEdited(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.repeat && !e.nativeEvent.isComposing && canSave) rename.mutate();
                  }}
                />
                <Button variant="primary" disabled={!canSave} loading={rename.isPending} onClick={() => rename.mutate()}>
                  Save
                </Button>
              </div>
            }
          />
          <SettingsRow anchor={S.email.anchor} title={S.email.title} control={<span style={{ color: 'var(--text-2)' }}>{me.data?.email ?? '—'}</span>} />
        </SettingsCard>
      </SettingsSection>

      <SignInMethodsCard me={me.data} />

    </div>
  );
}
