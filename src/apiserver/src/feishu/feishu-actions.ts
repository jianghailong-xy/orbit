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
      + ' rememberRules or startAfterCreate; recorded with credentialKind=FEISHU, the clicker’s open_id and the card’s message_id.',
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
  'FeishuCardActions',
  // The alert cards' own machinery (push/feishu-transport.ts): a click draws the card it was made on (§7.4).
  'FeishuTransport',
  'ControlPlaneLeader',
] as const;
