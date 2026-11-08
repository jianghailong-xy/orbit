/**
 * The exhaustive allowlist of service methods a Feishu event may call (docs/feishu-bot-design.md §7.2, decision 1).
 * Feishu actions bypass JwtAuthGuard: feishu/feishu-router.ts calls services directly, as the app's account, with
 * `credential.kind = 'FEISHU'`. Anything not listed here is answered with an "Open in Orbit" link instead.
 *
 * feishu-actions.spec.ts pins it both ways: every entry names a method that exists, and every call the feishu module
 * makes on a service outside its own module is listed. A write enters the list together with the condition §7.2 puts
 * on it, in the task that adds the action (F2: createTurn, create, decideApproval — the last added by F2-1).
 */
export interface FeishuAllowedAction {
  /** The injected service's class name. */
  service: string;
  method: string;
  /** READ: it writes nothing. WRITE: it writes, and the action is recorded with credentialKind=FEISHU (§7.2). */
  access: 'READ' | 'WRITE';
  /** When §7.2 allows it. */
  condition: string;
}

export const FEISHU_ALLOWED_ACTIONS: readonly FeishuAllowedAction[] = [
  // "What needs me": the sessions waiting on the owner (§7.2, the read-only row).
  { service: 'PushService', method: 'needsYouSessions', access: 'READ', condition: 'Always: it reads the account’s own sessions.' },
  // Reply to a session (§7.2, §7.3 1, §8.2): feishu/feishu-direct.service.ts, feishu/feishu-group.service.ts.
  {
    service: 'SessionsService',
    method: 'createTurn',
    access: 'WRITE',
    condition: 'The owner’s reply, in their direct messages, to a message that belongs to the session (an alert card or a chain of it);'
      + ' or a mention of the bot by an allowed sender inside a connected group’s topic that belongs to the session (§8.2).',
  },
  // Open a session (§7.2, §7.3 2, §8.2): feishu/feishu-direct.service.ts, feishu/feishu-group.service.ts.
  {
    service: 'SessionsService',
    method: 'create',
    access: 'WRITE',
    condition: 'The owner’s new direct message, in the app’s default workspace, with no permissionMode: the account’s default applies;'
      + ' or a top-level mention of the bot by an allowed sender in a connected group, in the route’s workspace and permissionMode (§8.2).',
  },
  // Answering a tool approval on a card (§7.2, §7.4; F2-1, feishu-card-actions.ts).
  {
    service: 'SessionsService',
    method: 'listApprovals',
    access: 'READ',
    condition: 'The owner’s click on an approval card: which approvals of the account’s session an answer could still reach.',
  },
  {
    service: 'SessionsService',
    method: 'decideApproval',
    access: 'WRITE',
    condition:
      'The owner’s click on Allow once or Deny of a tool-permission approval while approvalsInFeishu is on: only allow / deny, never'
      + ' rememberRules or startAfterCreate; recorded with credentialKind=FEISHU, the clicker’s open_id and the card’s message_id.'
      + ' Also the owner’s submitted answer form of an AskUserQuestion approval (F2-2), only in FULL detail: an allow with answers.',
  },
];

/**
 * Services the feishu module calls that are its own infrastructure rather than an action on the account's objects:
 * the database, its own services, the leader election. Calls on these are not actions and need no allowlist entry.
 */
export const FEISHU_INFRASTRUCTURE = [
  'PrismaService',
  'FeishuAppService',
  'FeishuInboxService',
  'FeishuLinkService',
  'FeishuRouter',
  'FeishuOutbound',
  'FeishuOwnerService',
  'FeishuChatRouteService',
  'FeishuDirectService',
  'FeishuGroupService',
  'FeishuCardActions',
  // The alert cards' own machinery (push/feishu-transport.ts): a click draws the card it was made on (§7.4).
  'FeishuTransport',
  'ControlPlaneLeader',
] as const;

/**
 * Every action a Feishu event can take (docs/feishu-bot-design.md §1.3 2, §7.2; task F3-6): what it is, the branch the
 * router sends it down, the handler that takes it, the allowlisted service methods it calls (none: it writes only the
 * app's own Feishu rows, or nothing), and how what it names is held to the app's account. A reply alone (help, a
 * non-text message, a refusal) is not an action: it acts on nothing.
 *
 * feishu-actions.spec.ts pins it both ways: against the code — each handler exists and is reached from the router,
 * and the allowlisted calls a source makes are exactly those its actions list — and against feishu-isolation.pg.spec.ts,
 * which has a cross-account case `[isolation:<key>]` for every action, and no case for an action not listed here.
 */
export interface FeishuInboundAction {
  key: string;
  route: 'DIRECT_MESSAGE' | 'GROUP_MENTION' | 'CARD_ACTION' | 'BOT_REMOVED_FROM_CHAT' | 'SETTINGS';
  /** `<source file>#<method>`; the SETTINGS rows are the Orbit pages a Feishu action leads to, not events. */
  handler: string;
  /** `Service.method` of FEISHU_ALLOWED_ACTIONS. */
  calls: readonly string[];
  /** What the event names, and the account filter that reads it. */
  scope: string;
}

export const FEISHU_ACTIONS: readonly FeishuInboundAction[] = [
  {
    key: 'owner-code', route: 'DIRECT_MESSAGE', handler: 'feishu-owner.service.ts#handleMessage', calls: [],
    scope: 'An owner code (also dropped when seen in a group): looked up by its hash and the app’s ownerId; another account’s code is no code.',
  },
  {
    key: 'direct-reply', route: 'DIRECT_MESSAGE', handler: 'feishu-direct.service.ts#handleMessage', calls: ['SessionsService.createTurn'],
    scope: 'root_id / parent_id: a feishu_thread or feishu_message row of this appId and ownerId; the turn is created as the app’s account.',
  },
  {
    key: 'direct-start', route: 'DIRECT_MESSAGE', handler: 'feishu-direct.service.ts#handleMessage', calls: ['SessionsService.create'],
    scope: 'The app’s defaultWorkspaceId, read only as a workspace of the app’s ownerId (not deleted); otherwise no default.',
  },
  {
    key: 'direct-status', route: 'DIRECT_MESSAGE', handler: 'feishu-direct.service.ts#handleMessage', calls: ['PushService.needsYouSessions'],
    scope: 'Names nothing: the sessions waiting on the app’s ownerId.',
  },
  {
    key: 'direct-workspace-pick', route: 'CARD_ACTION', handler: 'feishu-direct.service.ts#handleCardAction', calls: [],
    scope: 'The button’s workspaceId: a workspace of the app’s ownerId, or answered as one that is gone.',
  },
  {
    key: 'card-approval', route: 'CARD_ACTION', handler: 'feishu-card-actions.ts#answer',
    calls: ['SessionsService.listApprovals', 'SessionsService.decideApproval'],
    scope: 'The button’s approvalId: an approval whose session is the app’s ownerId’s; the card redrawn only from this appId’s own feishu_message.',
  },
  {
    key: 'card-question', route: 'CARD_ACTION', handler: 'feishu-card-actions.ts#answer',
    calls: ['SessionsService.listApprovals', 'SessionsService.decideApproval'],
    scope: 'As card-approval, for the AskUserQuestion approval the form names.',
  },
  {
    key: 'group-connect', route: 'GROUP_MENTION', handler: 'feishu-chat-route.service.ts#handleGroupMessage', calls: [],
    scope: 'The chat: the route row keyed (appId, chatId), the app’s own; its ticket is confirmed only by the app’s ownerId.',
  },
  {
    key: 'group-start', route: 'GROUP_MENTION', handler: 'feishu-group.service.ts#handleMention', calls: ['SessionsService.create'],
    scope: 'The chat: a confirmed route of this appId; the session opens as the route’s ownerId, in its workspace.',
  },
  {
    key: 'group-turn', route: 'GROUP_MENTION', handler: 'feishu-group.service.ts#handleMention', calls: ['SessionsService.createTurn'],
    scope: 'The topic’s root_id: a feishu_thread row of this appId, the route’s ownerId and this chat.',
  },
  {
    key: 'bot-removed', route: 'BOT_REMOVED_FROM_CHAT', handler: 'feishu-chat-route.service.ts#botRemoved', calls: [],
    scope: 'The chat: only the route rows of this appId.',
  },
  {
    key: 'settings-default-workspace', route: 'SETTINGS', handler: 'feishu-app.service.ts#change', calls: [],
    scope: 'Where the default workspace of direct-start is set: a workspace of the signed-in account, else 404.',
  },
];
