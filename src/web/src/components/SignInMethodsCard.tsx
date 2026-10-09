import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api';
import {
  authMethodsQuery,
  confirmGoogleLink,
  GOOGLE_LINK_VERIFIER_KEY,
  googleReturnError,
  startGoogleLink,
} from '../lib/googleLink';
import { meQuery, type Me, type SignInMethods } from '../lib/queries';
import { useToast } from '../lib/toast';
import { Badge } from './ui/Badge';
import { Button } from './ui/Button';
import { Card } from './ui/Card';
import { useConfirm } from './ui/ConfirmDialog';

export const SIGN_IN_METHODS_TITLE = 'Sign-in methods';
export const CONNECT_GOOGLE = 'Connect Google';
export const DISCONNECT_GOOGLE = 'Disconnect';
/** Why Disconnect is off for an account without a password (GOOGLE_UNLINK_WOULD_LOCK_OUT). */
export const GOOGLE_ONLY_WAY_IN = 'Google is the only way you sign in. Ask an administrator to set a password before disconnecting it.';
export const GOOGLE_OFF = 'Google sign-in is turned off on this server.';

/**
 * The profile page's Sign-in methods (docs/google-sign-in-design.md §5.3, §5.4, §8.1): whether the
 * account has a password, and the Google account linked to it — Disconnect, or Connect Google. It is
 * also where Google sends a Connect back to (`?google_link_ticket=` or `?google_error=`, §4.2), so it
 * is mounted whenever the profile page is, and draws itself only where it has something to say: while
 * Google sign-in is on, or for an account Google already concerns — linked, or without a password.
 * An ordinary account on a server without Google sees the profile page as it was.
 */
export function SignInMethodsCard({ me }: { me: Me | undefined }) {
  const message = useToast();
  const qc = useQueryClient();
  const methods = useQuery(authMethodsQuery());
  const [params, setParams] = useSearchParams();
  const [confirm, confirmation] = useConfirm();
  const disconnectButton = useRef<HTMLButtonElement>(null);
  const returned = useRef(false);

  /** Every answer here is the account's sign-in methods; they become what every view shows. */
  const adopt = (signInMethods: SignInMethods) =>
    qc.setQueryData(meQuery().queryKey, (account: Me | undefined) => account && { ...account, signInMethods });

  const connect = useMutation({
    mutationFn: () => startGoogleLink(),
    onError: (e: Error) => message.error("Couldn't connect Google", e.message),
  });
  const finish = useMutation({
    mutationFn: (ticket: string) => confirmGoogleLink(ticket),
    onSuccess: ({ signInMethods }) => {
      adopt(signInMethods);
      message.success('Google connected', signInMethods.google?.email);
    },
    onError: (e: Error) => message.error("Couldn't connect Google", e.message),
  });
  const disconnect = useMutation({
    mutationFn: () => api<{ signInMethods: SignInMethods }>('/auth/google/link', { method: 'DELETE' }),
    onSuccess: ({ signInMethods }) => {
      adopt(signInMethods);
      message.success('Google disconnected');
    },
  });

  // Back from Google: the ticket or the error is taken out of the address before anything else, so a
  // reload cannot present it again, and handled once.
  const ticket = params.get('google_link_ticket');
  const failed = params.get('google_error');
  useEffect(() => {
    if (returned.current || (ticket === null && failed === null)) return;
    returned.current = true;
    const rest = new URLSearchParams(params);
    rest.delete('google_link_ticket');
    rest.delete('google_error');
    setParams(rest, { replace: true });
    if (ticket !== null) {
      finish.mutate(ticket);
    } else {
      sessionStorage.removeItem(GOOGLE_LINK_VERIFIER_KEY);
      message.error("Couldn't connect Google", googleReturnError(failed!));
    }
  }, [ticket, failed, params, setParams, finish, message]);

  const signIn = me?.signInMethods;
  const googleOn = methods.data?.google === true;
  if (!signIn || !(googleOn || signIn.google !== null || !signIn.password)) return null;
  const { google } = signIn;

  const askDisconnect = () =>
    void confirm({
      title: 'Disconnect Google?',
      description: `You won't be able to sign in with ${google?.email} any more. You can connect it again later.`,
      confirmText: DISCONNECT_GOOGLE,
      danger: true,
      onConfirm: () => disconnect.mutateAsync(),
      returnFocus: disconnectButton,
    });

  let action = null;
  let note: string | null = null;
  if (methods.isPending) {
    // Whether Google sign-in is on is not known yet: nothing is offered, and it is not called off.
  } else if (!googleOn) {
    note = GOOGLE_OFF;
  } else if (google) {
    if (!signIn.password) note = GOOGLE_ONLY_WAY_IN;
    action = (
      <Button ref={disconnectButton} disabled={!signIn.password} onClick={askDisconnect}>
        {DISCONNECT_GOOGLE}
      </Button>
    );
  } else {
    action = (
      <Button loading={connect.isPending || finish.isPending} onClick={() => connect.mutate()}>
        {CONNECT_GOOGLE}
      </Button>
    );
  }

  return (
    <Card title={SIGN_IN_METHODS_TITLE} className="profile-signin">
      <div className="signin-method" data-method="password">
        <div className="signin-method-text">
          <div className="signin-method-name">Password</div>
          <div className="signin-method-detail">
            {signIn.password
              ? 'You can sign in with your email and password.'
              : 'No password is set: you sign in with Google. An administrator can set one for you.'}
          </div>
        </div>
        <Badge tone={signIn.password ? 'success' : 'default'}>{signIn.password ? 'Set' : 'Not set'}</Badge>
      </div>
      <div className="signin-method" data-method="google">
        <div className="signin-method-text">
          <div className="signin-method-name">Google</div>
          <div className="signin-method-detail">
            {google ? (
              <>
                Connected as <strong>{google.email}</strong>
              </>
            ) : (
              'Not connected'
            )}
          </div>
          {note && <div className="signin-method-note">{note}</div>}
        </div>
        {action}
      </div>
      {confirmation}
    </Card>
  );
}
