import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { SettingsCard, SettingsHeader, SettingsRow, SettingsSection } from '../../components/settings';
import { Switch } from '../../components/ui/Switch';
import { disableWebPush, enableWebPush, getWebPushConfig, getWebPushState, type WebPushState } from '../../lib/webPush';
import { usePreferences } from './preferences';
import { PERSONAL_SETTINGS as S } from './settingsIndex';

const BROWSER_DESCRIPTION = 'Show Orbit alerts on this computer, even with no Orbit tab open.';
const BROWSER_PROMPT = "Allow notifications in the browser's prompt…";
const BROWSER_BLOCKED = "Blocked for this site. Allow notifications in your browser's site settings, then turn this on.";
const BROWSER_UNSUPPORTED =
  "This browser can't show Orbit notifications. On iPhone, add Orbit to the Home Screen first, or use the Orbit app.";

/**
 * This browser's own notifications (docs/web-push-design.md, board docs/mocks/web-push): one switch that subscribes
 * this browser to Web Push and registers it as one more of your devices, or drops it.
 */
function ThisBrowserCard({ publicKey }: { publicKey: string }) {
  const [state, setState] = useState<WebPushState | null>(null);
  const [busy, setBusy] = useState(false);
  const [prompting, setPrompting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void getWebPushState()
      .then((s) => live && setState(s))
      .catch(() => live && setState('off'));
    return () => {
      live = false;
    };
  }, []);

  const toggle = async (on: boolean) => {
    setBusy(true);
    setError(null);
    try {
      if (on) {
        setPrompting(Notification.permission === 'default');
        setState(await enableWebPush(publicKey));
      } else {
        await disableWebPush();
        setState('off');
      }
    } catch {
      setError(on ? "Couldn't turn on notifications here. Try again." : "Couldn't turn off notifications here. Try again.");
      setState(await getWebPushState().catch(() => 'off' as const));
    } finally {
      setPrompting(false);
      setBusy(false);
    }
  };

  const description =
    state === 'unsupported'
      ? BROWSER_UNSUPPORTED
      : state === 'blocked'
        ? BROWSER_BLOCKED
        : prompting
          ? BROWSER_PROMPT
          : (error ?? BROWSER_DESCRIPTION);
  return (
    <SettingsCard>
      <SettingsRow
        title="Notifications in this browser"
        description={description}
        control={
          <Switch
            aria-label="Notifications in this browser"
            checked={state === 'on' || prompting}
            onCheckedChange={(v) => void toggle(v)}
            disabled={state === null || state === 'unsupported' || state === 'blocked'}
            loading={busy}
          />
        }
      />
    </SettingsCard>
  );
}

/**
 * Settings → Notifications: this browser's own switch, when the server sends web push, and which of a session's
 * moments alert your devices. Each switch saves when changed.
 */
export function NotificationsSettingsPage() {
  const { prefs, save } = usePreferences();
  // A server without a VAPID key, or older than web push, shows the page as it was: no This browser card.
  const webPush = useQuery({ queryKey: ['push', 'web-config'], queryFn: getWebPushConfig, retry: false });
  const publicKey = webPush.data ?? null;
  const devicesCard = (
    <SettingsCard>
      <SettingsRow
        anchor={S.notifySessionFinished.anchor}
        title={S.notifySessionFinished.title}
        description={S.notifySessionFinished.description}
        control={
          <Switch
            aria-label="When a session finishes"
            checked={prefs.notifySessionFinished ?? true}
            onCheckedChange={(v) => save.mutate({ notifySessionFinished: v })}
            loading={save.isPending}
          />
        }
      />
      <SettingsRow
        anchor={S.notifyAgentMessage.anchor}
        title={S.notifyAgentMessage.title}
        description={S.notifyAgentMessage.description}
        control={
          <Switch
            aria-label="When an agent asks for you"
            checked={prefs.notifyAgentMessage ?? true}
            onCheckedChange={(v) => save.mutate({ notifyAgentMessage: v })}
            loading={save.isPending}
          />
        }
      />
    </SettingsCard>
  );
  return (
    <div className="settings-page">
      <SettingsHeader title="Notifications" />
      {publicKey ? (
        <>
          <SettingsSection title="This browser">
            <ThisBrowserCard publicKey={publicKey} />
          </SettingsSection>
          <SettingsSection title="All your devices">{devicesCard}</SettingsSection>
        </>
      ) : (
        devicesCard
      )}
    </div>
  );
}
