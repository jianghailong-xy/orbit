import type { ExternalMessageFrom, MessageSentFrom, SessionMessageCard } from '@orbit/shared';
import type { AuthCredential } from '../common/current-user.decorator';

/**
 * Which client sent a turn (`conversation_turn.sender_client` / `sender_client_detail`, migration 0662), and the
 * `sentFrom` card a `user` event carries for it (`MessageSentFrom`, @orbit/shared).
 *
 * Written by the doors that know, from what the request proved or the apps already send on every request —
 * never from a body:
 *  - the owner's turn routes: a TERMINAL credential is `terminal` with its machine's name; a login names its app
 *    by `X-Orbit-Client` (`web/…`, `ios/…`, `macos/…`, `android/…`, the header ClientVersionInterceptor reads),
 *    and an iOS app its device by `X-Orbit-Device` (`iphone` / `ipad`). A personal access token, an
 *    administrator's view or a header naming no app records nothing.
 *  - the runner's `sessions/:id/turns` without a calling session: `runner` (the `orbit` CLI, a script).
 *  - the Feishu doors: `feishu`.
 * A session's message (`sender_session_id`) and a Feishu group member's (`external_sender_*`) already have their
 * own columns; their `sentFrom` is read off those, so the sender is said one way.
 */
export interface TurnSenderClient {
  client: 'web' | 'ios' | 'macos' | 'android' | 'terminal' | 'feishu' | 'runner';
  /** An `ios` client's device, or a `terminal`'s machine name. */
  detail?: string | null;
}

const APP_CLIENTS = new Set(['web', 'ios', 'macos', 'android']);
const IOS_DEVICES = new Set(['iphone', 'ipad']);

/** The client an owner's request came from, or undefined when nothing it proved or sent names one. */
export function senderClientOfRequest(
  credential: AuthCredential | undefined,
  clientHeader: string | undefined,
  deviceHeader: string | undefined,
): TurnSenderClient | undefined {
  if (credential?.kind === 'TERMINAL') return { client: 'terminal', detail: credential.machineName };
  if (credential && credential.kind !== 'LOGIN') return undefined;
  const slash = typeof clientHeader === 'string' ? clientHeader.indexOf('/') : -1;
  if (slash < 0) return undefined;
  const kind = clientHeader!.slice(0, slash).trim().toLowerCase();
  if (!APP_CLIENTS.has(kind)) return undefined;
  const client = kind as TurnSenderClient['client'];
  const device = typeof deviceHeader === 'string' ? deviceHeader.trim().toLowerCase() : '';
  return client === 'ios' && IOS_DEVICES.has(device) ? { client, detail: device } : { client };
}

/** The turn's columns for its sender client, or none. A machine name is kept to one line of 200 characters. */
export function senderClientColumns(sender: TurnSenderClient | null | undefined): {
  senderClient?: string;
  senderClientDetail?: string | null;
} {
  if (!sender) return {};
  const detail = sender.detail?.replace(/\s+/g, ' ').trim().slice(0, 200) || null;
  return { senderClient: sender.client, senderClientDetail: detail };
}

/** The `sentFrom` card of a turn: off its sender session's card, its outside sender, or its own columns. */
export function sentFromOf(
  turn: { senderClient?: string | null; senderClientDetail?: string | null },
  sessionMessage: SessionMessageCard | undefined,
  externalSender: ExternalMessageFrom | null | undefined,
): MessageSentFrom | null {
  if (sessionMessage) return { client: 'session', sessionTitle: sessionMessage.fromTitle };
  if (externalSender?.source === 'FEISHU') {
    return { client: 'feishu', ...(externalSender.name ? { name: externalSender.name } : {}) };
  }
  const detail = turn.senderClientDetail ?? undefined;
  switch (turn.senderClient) {
    case 'ios':
      return detail === 'iphone' || detail === 'ipad' ? { client: 'ios', device: detail } : { client: 'ios' };
    case 'terminal':
      return detail ? { client: 'terminal', machineName: detail } : { client: 'terminal' };
    case 'web':
    case 'macos':
    case 'android':
    case 'feishu':
    case 'runner':
      return { client: turn.senderClient };
    default:
      return null;
  }
}
