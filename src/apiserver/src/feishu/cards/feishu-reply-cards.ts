/**
 * A session's reply as it goes back to its Feishu chain (docs/feishu-bot-design.md §7.5): the turn's last assistant
 * text, as the agent wrote it, in a card's markdown while the card is within 30 KB; past that as plain text, within
 * 150 KB; past that cut, with a note saying so. In a direct chat it carries Open in Orbit; in a group nothing but the
 * words (§8.3). The note and the button are the bot's own words, in English (CLAUDE.md §5).
 */
import type { FeishuMessageBody } from '../feishu-outbound';
import { FEISHU_CARD_MAX_BYTES } from './feishu-cards';

/** The largest plain-text message Feishu takes: its request body's `content`, 150 KB. */
export const FEISHU_TEXT_MAX_BYTES = 150 * 1024;

export const REPLY_CUT_NOTE = '(Cut to fit a Feishu message. The rest is in Orbit.)';

const OPEN_IN_ORBIT = 'Open in Orbit';

/** How many bytes a message's `content` is as Feishu receives it: the JSON string the request carries. */
const contentBytes = (content: unknown) => Buffer.byteLength(JSON.stringify(content), 'utf8');

/** The card's summary line: what Feishu shows in the chat list, the reply's first line, cut short. */
function summaryOf(text: string): string {
  const line = text.split('\n').find((l) => l.trim() !== '')?.trim() ?? '';
  const points = [...line];
  return points.length > 60 ? `${points.slice(0, 59).join('')}…` : line;
}

function cardOf(text: string, openUrl: string | null) {
  const elements: Array<Record<string, unknown>> = [{ tag: 'markdown', content: text }];
  if (openUrl) {
    elements.push({
      tag: 'button',
      text: { tag: 'plain_text', content: OPEN_IN_ORBIT },
      type: 'default',
      behaviors: [{ type: 'open_url', default_url: openUrl }],
    });
  }
  return { schema: '2.0', config: { summary: { content: summaryOf(text) } }, body: { direction: 'vertical', elements } };
}

function plainOf(text: string, openUrl: string | null) {
  return { text: openUrl ? `${text}\n\n${OPEN_IN_ORBIT}: ${openUrl}` : text };
}

/**
 * The reply as Feishu takes it. `openUrl` is the session's address in a direct chat, null in a group. Pure; exported
 * for its spec.
 */
export function renderSessionReply(text: string, openUrl: string | null): FeishuMessageBody {
  const card = cardOf(text, openUrl);
  if (contentBytes(card) <= FEISHU_CARD_MAX_BYTES) return { msgType: 'interactive', content: card };
  const plain = plainOf(text, openUrl);
  if (contentBytes(plain) <= FEISHU_TEXT_MAX_BYTES) return { msgType: 'text', content: plain };
  // The longest head of the text that fits with the note, found by halving over its code points (never splitting one).
  const points = [...text];
  const fits = (n: number) => contentBytes(plainOf(`${points.slice(0, n).join('').trimEnd()}\n\n${REPLY_CUT_NOTE}`, openUrl)) <= FEISHU_TEXT_MAX_BYTES;
  let [low, high] = [0, points.length];
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (fits(mid)) low = mid;
    else high = mid - 1;
  }
  return { msgType: 'text', content: plainOf(`${points.slice(0, low).join('').trimEnd()}\n\n${REPLY_CUT_NOTE}`, openUrl) };
}
