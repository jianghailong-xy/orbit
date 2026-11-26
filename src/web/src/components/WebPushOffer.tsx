import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CloseOutlined } from '@ant-design/icons';
import { Button } from './ui/Button';
import { useToast } from '../lib/toast';
import { enableWebPush, getWebPushConfig, getWebPushState, webPushSupported } from '../lib/webPush';

/** Set once the offer was answered either way: it is shown once per browser (docs/web-push-design.md, D1 = B). */
export const WEB_PUSH_OFFER_DISMISSED_KEY = 'orbit.webPushOffer.dismissed';

export const WEB_PUSH_OFFER_TEXT = 'Get Orbit alerts in this browser';
/** Left out on a phone's bar, where the line has room for the first half only. */
export const WEB_PUSH_OFFER_MORE = ', even with no Orbit tab open.';
export const WEB_PUSH_OFFER_TURN_ON = 'Turn on';
export const WEB_PUSH_OFFER_NOT_NOW = 'Not now';

/**
 * Whether to offer this browser's notifications: the server sends web push, the browser can show it, it has never
 * been asked (permission `default`, so no subscription either), and the offer was not answered here before.
 */
async function offerable(): Promise<string | null> {
  if (localStorage.getItem(WEB_PUSH_OFFER_DISMISSED_KEY) || !webPushSupported()) return null;
  if (Notification.permission !== 'default') return null;
  const publicKey = await getWebPushConfig();
  if (!publicKey || (await getWebPushState()) !== 'off') return null;
  return publicKey;
}

/**
 * The one-time offer to turn on notifications in this browser, after sign-in. Turn on asks the browser from the click
 * itself (browsers allow the prompt only then); either answer, or Not now, ends the offer for this browser. Settings →
 * Notifications keeps the switch for later.
 */
export function WebPushOffer({ placement }: { placement: 'bar' | 'rail' }) {
  const toast = useToast();
  const offer = useQuery({ queryKey: ['push', 'web-offer'], queryFn: offerable, retry: false, staleTime: Infinity });
  const [answered, setAnswered] = useState(false);
  const [busy, setBusy] = useState(false);
  const publicKey = offer.data ?? null;
  if (!publicKey || answered) return null;

  const end = () => {
    localStorage.setItem(WEB_PUSH_OFFER_DISMISSED_KEY, new Date().toISOString());
    setAnswered(true);
  };
  const turnOn = async () => {
    setBusy(true);
    try {
      const state = await enableWebPush(publicKey);
      end();
      if (state === 'on') toast.success('Notifications are on in this browser.');
    } catch {
      toast.warning("Couldn't turn on notifications here.", 'Try again in Settings → Notifications.');
      end();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`web-push-offer web-push-offer--${placement}`} role="region" aria-label="Browser notifications">
      <span className="web-push-offer-text">
        {WEB_PUSH_OFFER_TEXT}
        <span className="web-push-offer-more">{WEB_PUSH_OFFER_MORE}</span>
      </span>
      <span className="web-push-offer-actions">
        <Button size="small" variant="primary" loading={busy} onClick={() => void turnOn()}>
          {WEB_PUSH_OFFER_TURN_ON}
        </Button>
        <button type="button" className="web-push-offer-close" aria-label={WEB_PUSH_OFFER_NOT_NOW} onClick={end}>
          <CloseOutlined />
        </button>
      </span>
    </div>
  );
}
