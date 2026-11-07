/**
 * The Feishu bot integration (docs/feishu-bot-design.md): each account connects its own Feishu (Lark)
 * self-built app. What the account's settings and the administrators' switch answer, shared by the
 * apiserver and the clients.
 */

/** Which open platform an app lives on: Feishu (open.feishu.cn) or Lark (open.larksuite.com). */
export const FEISHU_PLATFORMS = ['FEISHU', 'LARK'] as const;
export type FeishuPlatform = (typeof FEISHU_PLATFORMS)[number];

/** The open platform each platform's apps are made and called on (§4.1). */
export const FEISHU_OPEN_PLATFORM_ORIGINS: Readonly<Record<FeishuPlatform, string>> = {
  FEISHU: 'https://open.feishu.cn',
  LARK: 'https://open.larksuite.com',
};

/** What an alert card carries (§6.4): the titles only, the default, or the details as well. */
export const FEISHU_MESSAGE_DETAILS = ['TITLES_ONLY', 'FULL'] as const;
export type FeishuMessageDetail = (typeof FEISHU_MESSAGE_DETAILS)[number];

/** The longest App ID and App Secret a save takes. Feishu's own are far shorter. */
export const FEISHU_APP_ID_MAX_LENGTH = 128;
export const FEISHU_APP_SECRET_MAX_LENGTH = 256;

/**
 * The account's app, as `GET /api/integrations/feishu` and every write answer it. Never the App Secret in
 * any form: only whether one is saved, and whether the server can still decrypt it.
 */
export interface FeishuAppSettings {
  platform: FeishuPlatform;
  appId: string;
  hasSecret: boolean;
  /**
   * A secret is saved and the current `PROVIDER_SECRET_KEY` cannot decrypt it, so Orbit cannot reach Feishu
   * as this app until the App Secret is entered again (§4.1).
   */
  secretUnreadable: boolean;
  /** The app's own switch: off, Orbit neither connects it nor sends through it. */
  enabled: boolean;
  messageDetail: FeishuMessageDetail;
  approvalsInFeishu: boolean;
  defaultWorkspaceId: string | null;
  /** The owner's open_id in this app and their name, once bound (§5). */
  ownerOpenId: string | null;
  ownerName: string | null;
  botName: string | null;
  lastConnectedAt: string | null;
  lastEventAt: string | null;
  /** The last failure as Feishu worded it, with its code; never a credential. */
  lastError: string | null;
  /** How many apiserver replicas hold a live long connection of this app now (§4.4): one per replica when all is well. */
  connectedReplicas: number;
  createdAt: string;
  updatedAt: string;
}

/** `GET /api/integrations/feishu`, and what `PUT`, `PATCH` and `DELETE` answer. */
export interface FeishuIntegration {
  /** Whether this server lets accounts connect Feishu bots: the administrators' switch (§4.1). */
  allowed: boolean;
  /** The account's app; null while it has none. */
  app: FeishuAppSettings | null;
}

/** `PUT /api/integrations/feishu`: connect an app, or replace the one connected. Every field is required. */
export interface FeishuAppConnect {
  platform: FeishuPlatform;
  appId: string;
  appSecret: string;
}

/** `PATCH /api/integrations/feishu`: what an account changes on the app it has. */
export interface FeishuAppChange {
  enabled?: boolean;
  /** How much an alert card carries (§6.4). Details are stored on Feishu's servers once sent. */
  messageDetail?: FeishuMessageDetail;
  /** Whether a tool approval's card has Allow once and Deny (§7.2). Off, it has only Open in Orbit. */
  approvalsInFeishu?: boolean;
}

/**
 * Why a `PUT` saved nothing (400): Feishu would not trade the credentials for a tenant_access_token
 * (`FEISHU_CREDENTIALS_REJECTED`, with Feishu's own code and message), or it could not be reached at all
 * (`FEISHU_UNREACHABLE`, with neither).
 */
export const FEISHU_CREDENTIAL_REFUSALS = ['FEISHU_CREDENTIALS_REJECTED', 'FEISHU_UNREACHABLE'] as const;
export type FeishuCredentialRefusalCode = (typeof FEISHU_CREDENTIAL_REFUSALS)[number];

export interface FeishuCredentialRefusal {
  code: FeishuCredentialRefusalCode;
  message: string;
  feishuCode: number | null;
  feishuMsg: string | null;
}

/** The 409 a `PUT` answers when another account of this server already connected the App ID (§4.1). */
export const FEISHU_APP_TAKEN = 'FEISHU_APP_TAKEN';
export const FEISHU_APP_TAKEN_MESSAGE = 'This Feishu app is already connected to another Orbit account.';

/** The 403 a `PUT` answers while the administrators' switch is off. */
export const FEISHU_NOT_ALLOWED = 'FEISHU_NOT_ALLOWED';
export const FEISHU_NOT_ALLOWED_MESSAGE = 'An administrator has turned off Feishu bots on this Orbit server.';

/** `GET` and `PUT /api/admin/integrations/feishu`. */
export interface FeishuAdminSettings {
  /** "Allow accounts to connect Feishu bots": on unless an administrator turned it off. */
  allowed: boolean;
  /** The apps accounts have connected, and how many of them are switched on: each is a connection per replica (§4.4). */
  connectedApps: number;
  enabledApps: number;
}

/** `PUT /api/admin/integrations/feishu`'s body. */
export interface FeishuAdminChange {
  allowed: boolean;
}

/**
 * What the app needs in the developer console (§4.2): the permissions it is granted, and what it subscribes
 * to over the long connection. Named as Feishu names them, so they can be copied into the console as they are.
 * It never asks to read every message of a group: only messages that @mention the bot reach Orbit.
 */
export const FEISHU_APP_SCOPES = [
  'im:message:send_as_bot',
  'im:message.p2p_msg:readonly',
  'im:message.group_at_msg:readonly',
  'im:chat:readonly',
  'contact:user.base:readonly',
] as const;
export const FEISHU_APP_EVENTS = ['im.message.receive_v1', 'im.chat.member.bot.deleted_v1'] as const;
export const FEISHU_APP_CALLBACKS = ['card.action.trigger'] as const;

/**
 * The owner's identity (§5): who in the app's tenant the account is. A one-time code generated in Settings →
 * Feishu, sent to the bot in a direct message, makes its sender the owner.
 */
export const FEISHU_CONNECT_CODE_LENGTH = 8;
export const FEISHU_CONNECT_CODE_TTL_MINUTES = 10;

/** `POST /api/integrations/feishu/connect-codes`: the code, once, when it stops working, and the link to the bot's chat. */
export interface FeishuConnectCode {
  code: string;
  expiresAt: string;
  /** A Feishu (or Lark) applink that opens a direct message with the bot. */
  applink: string;
}

/** Where each platform's applinks open (§5.1). */
export const FEISHU_APPLINK_ORIGINS: Readonly<Record<FeishuPlatform, string>> = {
  FEISHU: 'https://applink.feishu.cn',
  LARK: 'https://applink.larksuite.com',
};

/** The applink that opens a direct message with an app's bot. */
export function feishuBotApplink(platform: FeishuPlatform, appId: string): string {
  return `${FEISHU_APPLINK_ORIGINS[platform]}/client/bot/open?appId=${encodeURIComponent(appId)}`;
}

/** The 404 an owner route answers while the account has no app. */
export const FEISHU_NO_APP_MESSAGE = 'No Feishu app is connected to this account.';

/** The 409 `POST /api/integrations/feishu/test` answers while no owner is connected. */
export const FEISHU_NO_OWNER = 'FEISHU_NO_OWNER';
export const FEISHU_NO_OWNER_MESSAGE =
  'Nobody is connected as the owner of this Feishu app yet, so there is no one to send a test message to. Connect your Feishu account first.';

/** `POST /api/integrations/feishu/test`: Feishu accepted the message for the owner. */
export interface FeishuTestMessageResult {
  sent: true;
}
