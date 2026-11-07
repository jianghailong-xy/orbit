import type { FeishuMessageDetail, OwnerItemPushKind } from '@orbit/shared';
import type { OwnerItemAlert } from '../../push/owner-item-alert';
import { toolInputPreview } from './tool-input-preview';

/**
 * The cards the Feishu bot sends its owner (docs/feishu-bot-design.md §6.1, §6.2, §6.4), as Feishu card JSON 2.0.
 * Pure: an alert and the app's settings in, the card out. Sending, collapsing and updating are the transport's.
 *
 * WHAT A CARD CARRIES IS THE POINT (§6.4). A card is stored on Feishu's servers, so in the default TITLES_ONLY mode
 * it carries the session's or project's title, the kind of event, and a tool's name, and nothing else: no tool
 * input, recap, failure reason, `notify` text, owner item body or question. FULL adds the third column of §6.1.
 * What anyone wrote (titles, an agent's words) is forwarded as it was, always as plain text, never as markdown.
 */

/** The app's settings a card depends on. */
export interface FeishuCardContext {
  detail: FeishuMessageDetail;
  /** Whether the owner answers approvals on the card (`approvalsInFeishu`, §7.2). Off, only Open in Orbit. */
  approvalsInFeishu: boolean;
  /** Where Open in Orbit goes: the session, or the project. */
  openUrl: string;
}

/** One pending approval, as the approval row holds it. */
export interface FeishuApprovalItem {
  id: string;
  toolName: string;
  input: unknown;
}

/** What a card is about: one row of §6.1's table. */
export type FeishuAlert =
  /** One stretch of a session's pending approvals: one card, each approval with its own buttons (§6.2). */
  | { kind: 'approval'; sessionTitle: string; approvals: FeishuApprovalItem[] }
  /** `settleAlert`'s answer: `body` is the recap or the failure line. */
  | { kind: 'finished' | 'failed'; sessionTitle: string; body: string }
  /** An agent's `notify`: `message` is what it wrote. */
  | { kind: 'agent-message'; sessionTitle: string; message: string }
  /** `ownerItemAlert`'s answer, and the project it belongs to. */
  | { kind: 'owner-item'; projectTitle: string | null; alert: OwnerItemAlert }
  /** Any other push: its kind in words, its title, and the body the push carries. */
  | { kind: 'other'; eventKind: string; title: string; body: string };

/** What the buttons send back (`value.action`); F2-1 and F2-2 handle them. */
export const FEISHU_CARD_ACTIONS = {
  allow: 'approval.allow',
  deny: 'approval.deny',
  answer: 'question.answer',
} as const;

/** Feishu refuses a card over 30 KB. */
export const FEISHU_CARD_MAX_BYTES = 30 * 1024;

export const DETAILS_HIDDEN = 'Details hidden by your settings';
export const CUT_NOTE = '(Cut to fit a Feishu card. The rest is in Orbit.)';
export const TOO_LONG_NOTE = 'This alert is too long for a Feishu card. Open it in Orbit to see it.';
export const REPLY_HINT = 'Reply to this message to reply to the session.';
const UNTITLED_SESSION = 'Untitled session';

/** The kind of each owner item, in the words its chip uses (§7.6 V12). */
const OWNER_ITEM_KIND_WORDS: Readonly<Record<OwnerItemPushKind, string>> = {
  'approve-merge-to-main': 'Merge to main needs your approval',
  'coordinator-question': 'The coordinator has a question',
  'escalated-to-you': 'Escalated to you',
  'fuse-paused': 'The coordinator paused itself',
  'landed-without-confirmation': 'Landed without your confirmation',
};

/** Orbit's own confirmation cards (§6.1's third approval row), by the tool name the server files them under. */
const ORBIT_CARD_KINDS: Readonly<Record<string, string>> = {
  orbit_task_create: 'Create a task',
  orbit_task_batch: 'Create tasks',
  orbit_project_create: 'Create a project',
  orbit_agent_create: 'Create a workspace',
  orbit_agent_update: 'Change a workspace',
  orbit_agent_delete: 'Delete a workspace',
  orbit_runner_delete: 'Delete a runner',
  orbit_dag_change: 'Restructure dependencies',
  orbit_blocker_resolve: 'Resolve a blocker',
  orbit_integration_skip_merge_check: 'Land without the merge check',
  orbit_project_update_integration: 'Change the merge check',
  orbit_provider_create: 'Add a provider',
  orbit_provider_update: 'Change a provider',
  orbit_provider_delete: 'Remove a provider',
};
const ORBIT_CARD_FALLBACK = 'Orbit confirmation';

/** Which of §6.1's three approval rows an approval is. A server-filed card is `orbit_<name>`; an engine's MCP prompt is not. */
export type FeishuApprovalClass = 'tool' | 'question' | 'orbit';
export function approvalClass(toolName: string): FeishuApprovalClass {
  if (toolName === 'AskUserQuestion') return 'question';
  if (/^orbit_[a-z]/.test(toolName)) return 'orbit';
  return 'tool';
}

/** The alert's card: buttons per §6.1's last column. */
export function renderFeishuCard(alert: FeishuAlert, ctx: FeishuCardContext): FeishuCard {
  return fitted(alert, ctx, null);
}

/**
 * The card once its matter is settled elsewhere (§6.2): the same content, the outcome (`Allowed in Orbit · 10:32`)
 * on top, and no buttons or form at all.
 */
export function renderFeishuTerminalCard(alert: FeishuAlert, ctx: FeishuCardContext, outcome: string): FeishuCard {
  return fitted(alert, ctx, outcome);
}

// ---------------------------------------------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any */
type Element = Record<string, any>;
export interface FeishuCard {
  schema: '2.0';
  config: { update_multi: true; summary: { content: string } };
  header: { title: PlainText; subtitle: PlainText; template: string };
  body: { direction: 'vertical'; elements: Element[] };
}
interface PlainText { tag: 'plain_text'; content: string }

const plain = (content: string): PlainText => ({ tag: 'plain_text', content });
const text = (content: string): Element => ({ tag: 'div', text: plain(content) });
const note = (content: string): Element => ({
  tag: 'div', text: { tag: 'plain_text', content, text_size: 'notation', text_color: 'grey' },
});
const hr: Element = { tag: 'hr' };
const callback = (label: string, type: string, value: Record<string, string>): Element => ({
  tag: 'button', text: plain(label), type, behaviors: [{ type: 'callback', value }],
});
const row = (buttons: Element[]): Element => ({
  tag: 'column_set',
  flex_mode: 'flow',
  columns: buttons.map((button) => ({ tag: 'column', width: 'auto', elements: [button] })),
});
const openInOrbit = (url: string): Element => ({
  tag: 'button', text: plain('Open in Orbit'), type: 'default', behaviors: [{ type: 'open_url', default_url: url }],
});

/** The card the bot answers the owner's `@<bot> connect` in a group with (§8.1): one button, to Orbit's confirm page. */
export const CONNECT_GROUP_TITLE = 'Connect this group to Orbit';
export const CONNECT_GROUP_BUTTON = 'Connect in Orbit';
export function renderConnectGroupCard(chatName: string | null, confirmUrl: string, ttlMinutes: number): FeishuCard {
  return {
    schema: '2.0',
    config: { update_multi: true, summary: { content: CONNECT_GROUP_TITLE } },
    header: { title: plain(CONNECT_GROUP_TITLE), subtitle: plain(chatName ?? ''), template: 'blue' },
    body: {
      direction: 'vertical',
      elements: [
        text(
          'Open Orbit to choose the workspace, the permission mode, who in this group can start sessions, and the limits. '
          + 'Nothing runs from this group until you confirm there.',
        ),
        note(`Only you can use this link, once, within ${ttlMinutes} minutes.`),
        row([{ tag: 'button', text: plain(CONNECT_GROUP_BUTTON), type: 'primary', behaviors: [{ type: 'open_url', default_url: confirmUrl }] }]),
      ],
    },
  };
}

/**
 * A card within FEISHU_CARD_MAX_BYTES. Only what FULL adds can be long, so a card over the limit is drawn again with
 * every detail text cut shorter, each cut one saying so. A card that is still too long with none left (a stretch of
 * very many approvals) says so and keeps its title and Open in Orbit.
 */
function fitted(alert: FeishuAlert, ctx: FeishuCardContext, outcome: string | null): FeishuCard {
  let limit = Number.POSITIVE_INFINITY;
  for (let attempt = 0; attempt < 12; attempt++) {
    const card = build(alert, ctx, outcome, limit);
    const bytes = Buffer.byteLength(JSON.stringify(card), 'utf8');
    if (bytes <= FEISHU_CARD_MAX_BYTES) return card;
    const longest = Number.isFinite(limit) ? limit : longestDetail(alert, ctx);
    if (longest <= 0) break;
    limit = Math.floor(longest * (FEISHU_CARD_MAX_BYTES / bytes) * 0.8);
  }
  const bare = build(alert, ctx, outcome, 0);
  return {
    ...bare,
    body: { direction: 'vertical', elements: [text(TOO_LONG_NOTE), ...(outcome === null ? [openInOrbit(ctx.openUrl)] : [])] },
  };
}

/** The longest detail text the alert has, as `cut` counts it. */
function longestDetail(alert: FeishuAlert, ctx: FeishuCardContext): number {
  let longest = 0;
  build(alert, ctx, null, Number.POSITIVE_INFINITY, (length) => { longest = Math.max(longest, length); });
  return longest;
}

function build(
  alert: FeishuAlert,
  ctx: FeishuCardContext,
  outcome: string | null,
  limit: number,
  measure?: (length: number) => void,
): FeishuCard {
  const full = ctx.detail === 'FULL';
  const live = outcome === null;
  /** A detail text, cut to `limit` characters. */
  const cut = (value: string): string => {
    const chars = [...value];
    measure?.(chars.length);
    if (chars.length <= limit) return value;
    return `${chars.slice(0, Math.max(0, limit)).join('').trimEnd()}…\n${CUT_NOTE}`;
  };
  const elements: Element[] = [];
  if (outcome !== null) elements.push(text(outcome));
  let title: string;
  let subtitle: string;
  let template: string;

  switch (alert.kind) {
    case 'approval': {
      title = sessionTitle(alert.sessionTitle);
      subtitle = alert.approvals.length === 1 ? approvalLine(alert.approvals[0]) : `${alert.approvals.length} approvals need your reply`;
      template = 'orange';
      alert.approvals.forEach((approval, index) => {
        if (index > 0) elements.push(hr);
        elements.push(...approvalSection(approval, index, ctx, full, live, cut));
      });
      break;
    }
    case 'finished':
    case 'failed': {
      title = sessionTitle(alert.sessionTitle);
      subtitle = alert.kind === 'finished' ? 'Finished' : 'Failed';
      template = alert.kind === 'finished' ? 'green' : 'red';
      if (full && alert.body.trim() !== '' && alert.body !== subtitle) elements.push(text(cut(alert.body)));
      if (live) elements.push(note(REPLY_HINT));
      break;
    }
    case 'agent-message': {
      title = sessionTitle(alert.sessionTitle);
      subtitle = 'The agent sent you a message';
      template = 'blue';
      if (full) elements.push(text(cut(alert.message)));
      if (live) elements.push(note(REPLY_HINT));
      break;
    }
    case 'owner-item': {
      title = alert.projectTitle?.trim() || 'Orbit';
      subtitle = OWNER_ITEM_KIND_WORDS[alert.alert.kind];
      template = 'purple';
      if (full) {
        if (alert.alert.title !== subtitle) elements.push(text(cut(alert.alert.title)));
        elements.push(text(cut(alert.alert.body)));
      }
      break;
    }
    case 'other': {
      title = alert.title.trim() || 'Orbit';
      subtitle = alert.eventKind;
      template = 'wathet';
      if (full && alert.body.trim() !== '') elements.push(text(cut(alert.body)));
      break;
    }
  }

  if (live) elements.push(row([openInOrbit(ctx.openUrl)]));
  else elements.push({ tag: 'markdown', content: `[Open in Orbit](${ctx.openUrl})` });
  return {
    schema: '2.0',
    config: { update_multi: true, summary: { content: live ? `${title} · ${subtitle}` : `${title} · ${outcome}` } },
    header: { title: plain(title), subtitle: plain(subtitle), template: live ? template : 'grey' },
    body: { direction: 'vertical', elements },
  };
}

function sessionTitle(title: string): string {
  return title.trim() || UNTITLED_SESSION;
}

/** An approval in one line: what kind of ask it is, and a tool's name. Never anything the call carries. */
function approvalLine(approval: FeishuApprovalItem): string {
  switch (approvalClass(approval.toolName)) {
    case 'tool':
      return `Needs your reply · ${approval.toolName}`;
    case 'question':
      return 'The agent asked you a question';
    case 'orbit':
      return `Confirm: ${ORBIT_CARD_KINDS[approval.toolName] ?? ORBIT_CARD_FALLBACK}`;
  }
}

export interface FeishuQuestion {
  question: string;
  header: string;
  multiSelect: boolean;
  options: { label: string; description: string }[];
}

/**
 * AskUserQuestion's questions, as much of them as is well formed. The answer form numbers them and their options in
 * this order, so a submitted form is read back against the approval's own input with this same function
 * (feishu-card-actions.ts): what reaches the runner is the labels as the agent wrote them, never the card's text.
 */
export function questionsOf(input: unknown): FeishuQuestion[] {
  const raw = (input as { questions?: unknown } | null)?.questions;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((q): FeishuQuestion[] => {
    if (!q || typeof q !== 'object' || typeof (q as { question?: unknown }).question !== 'string') return [];
    const item = q as { question: string; header?: unknown; multiSelect?: unknown; options?: unknown };
    const options = Array.isArray(item.options)
      ? item.options.flatMap((o) =>
        o && typeof o === 'object' && typeof (o as { label?: unknown }).label === 'string'
          ? [{
            label: (o as { label: string }).label,
            description: typeof (o as { description?: unknown }).description === 'string' ? (o as { description: string }).description : '',
          }]
          : [])
      : [];
    return [{
      question: item.question,
      header: typeof item.header === 'string' ? item.header : '',
      multiSelect: item.multiSelect === true,
      options,
    }];
  });
}

/**
 * The answer form's field names (§7.2's "answer the agent's question"). Feishu wants a component's name unique within
 * the card, and one card can hold several questions' forms, so each name carries the approval's place on the card;
 * a submission carries only its own form's fields, so the handler reads them by their suffix alone.
 */
export const questionField = (section: number, question: number): string => `a${section}_q${question}`;
export const questionOtherField = (section: number, question: number): string => `${questionField(section, question)}_other`;
/** A submitted field's question and whether it is the typed answer: `a0_q1` is (1, false), `a0_q1_other` is (1, true). */
export function parseQuestionField(name: string): { question: number; other: boolean } | null {
  const m = /^a\d+_q(\d+)(_other)?$/.exec(name);
  return m ? { question: Number(m[1]), other: m[2] !== undefined } : null;
}

function approvalSection(
  approval: FeishuApprovalItem,
  section: number,
  ctx: FeishuCardContext,
  full: boolean,
  live: boolean,
  cut: (value: string) => string,
): Element[] {
  const kind = approvalClass(approval.toolName);
  const out: Element[] = [text(approvalLine(approval))];
  if (kind === 'tool') {
    out.push(full ? text(cut(toolInputPreview(approval.toolName, approval.input))) : note(DETAILS_HIDDEN));
    if (live && ctx.approvalsInFeishu) {
      out.push(row([
        callback('Allow once', 'primary', { action: FEISHU_CARD_ACTIONS.allow, approvalId: approval.id }),
        callback('Deny', 'danger', { action: FEISHU_CARD_ACTIONS.deny, approvalId: approval.id }),
      ]));
    }
    return out;
  }
  if (kind === 'orbit') {
    if (full) out.push(text(cut(toolInputPreview(approval.toolName, approval.input))));
    return out;
  }
  if (!full) return out;
  const questions = questionsOf(approval.input);
  questions.forEach((q) => {
    const options = q.options.map((o) => `• ${o.label}${o.description ? ` — ${o.description}` : ''}`).join('\n');
    out.push(text(cut([q.header ? `${q.header}: ${q.question}` : q.question, options].filter(Boolean).join('\n'))));
  });
  if (live && ctx.approvalsInFeishu && questions.length > 0) {
    out.push({
      tag: 'form',
      name: `answer_${section}`,
      elements: [
        // Per question: which one it is, its options (one, or one or more), and a box for an answer of the owner's
        // own, as the web app's form offers. An option's value is its place in the agent's list.
        ...questions.flatMap((q, index) => [
          text(cut(q.header || q.question)),
          ...(q.options.length > 0
            ? [{
              tag: q.multiSelect ? 'multi_select_static' : 'select_static',
              name: questionField(section, index),
              placeholder: plain(q.multiSelect ? 'Choose one or more' : 'Choose one'),
              options: q.options.map((o, value) => ({ text: plain(cut(o.label)), value: String(value) })),
            }]
            : []),
          { tag: 'input', name: questionOtherField(section, index), placeholder: plain('Or type your own answer') },
        ]),
        {
          tag: 'button',
          text: plain('Submit'),
          type: 'primary',
          name: `answer_${section}_submit`,
          form_action_type: 'submit',
          behaviors: [{ type: 'callback', value: { action: FEISHU_CARD_ACTIONS.answer, approvalId: approval.id } }],
        },
      ],
    });
  }
  return out;
}
