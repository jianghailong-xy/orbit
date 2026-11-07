import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { Injectable, Logger } from '@nestjs/common';
import { feishuClient, type FeishuAppCredentials } from './feishu-open-platform';
import { feishuTiming, type FeishuTiming } from './feishu-timing';

/** What Feishu said to one send, reply or update. */
export type FeishuSendResult =
  | { ok: true; messageId: string | null }
  | { ok: false; status: number | null; feishuCode: number | null; feishuMsg: string };

/** A message's body as Feishu takes it: its type (`text`, `interactive`, …) and its content, a JSON value. */
export interface FeishuMessageBody {
  msgType: string;
  content: unknown;
}

/**
 * Feishu's own de-duplication key for a send or a reply (`uuid` in the request body, at most 50 characters): Feishu
 * delivers one message per uuid within an hour. Derived from why the message is sent — never from the attempt — so the
 * same event processed again, a retry after a timeout whose request got through, and two replicas sending at once all
 * reach the person once (project instruction 15). A hex SHA-256 of the reasons, cut to 32 characters.
 */
export function feishuDedupeUuid(...why: string[]): string {
  return createHash('sha256').update(JSON.stringify(why)).digest('hex').slice(0, 32);
}

/** Retries of one request after a 429: Feishu's suggested wait each time, then the 429 is the answer. */
const RATE_LIMIT_RETRIES = 3;

interface Request {
  method: 'POST' | 'PATCH';
  url: string;
  params?: Record<string, string>;
  data: Record<string, unknown>;
}

/**
 * How long a 429 asks to wait (§6.3): Feishu's `x-ogw-ratelimit-reset` header, in seconds; `retry-after` likewise; its
 * absence the default. Exported for its spec.
 */
export function rateLimitWaitMs(headers: Record<string, unknown> | undefined, timing: FeishuTiming): number {
  for (const name of ['x-ogw-ratelimit-reset', 'retry-after']) {
    const seconds = Number(headers?.[name]);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.max(seconds * 1000, 0);
  }
  return timing.rateLimitDefaultMs;
}

/**
 * The outbound client (docs/feishu-bot-design.md §6.3): send a message, reply to one (in its thread when asked), update
 * a card — as an app, through the SDK with its tenant_access_token, which it fetches and caches per app. Any replica
 * sends. A 429 waits the time Feishu suggests and tries again, a few times, and no cross-process token bucket is kept:
 * one account's volume is far below Feishu's limits. Nothing else is retried here; callers own their retries (the outbox,
 * F2). What is answered and logged carries Feishu's code and message, never a credential or a message's content.
 */
@Injectable()
export class FeishuOutbound {
  private readonly logger = new Logger(FeishuOutbound.name);

  /** The clocks, and how a 429's wait is waited: a spec replaces either. */
  timing: FeishuTiming = feishuTiming();
  wait: (ms: number) => Promise<unknown> = sleep;

  /**
   * `POST /open-apis/im/v1/messages`: to a user (`open_id`) or a chat (`chat_id`). `uuid` (feishuDedupeUuid) makes Feishu
   * deliver it once however often it is sent within an hour.
   */
  send(
    app: FeishuAppCredentials,
    to: { receiveIdType: 'open_id' | 'chat_id'; receiveId: string },
    body: FeishuMessageBody,
    { uuid }: { uuid?: string } = {},
  ): Promise<FeishuSendResult> {
    return this.call(app, {
      method: 'POST',
      url: 'open-apis/im/v1/messages',
      params: { receive_id_type: to.receiveIdType },
      data: { receive_id: to.receiveId, msg_type: body.msgType, content: JSON.stringify(body.content), ...(uuid ? { uuid } : {}) },
    });
  }

  /**
   * `POST /open-apis/im/v1/messages/:message_id/reply`; `replyInThread` answers in the message's thread (§8.2), and `uuid`
   * is Feishu's de-duplication key, as for `send`.
   */
  reply(
    app: FeishuAppCredentials,
    messageId: string,
    body: FeishuMessageBody,
    { replyInThread = false, uuid }: { replyInThread?: boolean; uuid?: string } = {},
  ): Promise<FeishuSendResult> {
    return this.call(app, {
      method: 'POST',
      url: `open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reply`,
      data: { msg_type: body.msgType, content: JSON.stringify(body.content), reply_in_thread: replyInThread, ...(uuid ? { uuid } : {}) },
    });
  }

  /** `PATCH /open-apis/im/v1/messages/:message_id`: replace a card the bot sent (§6.2). */
  updateCard(app: FeishuAppCredentials, messageId: string, card: unknown): Promise<FeishuSendResult> {
    return this.call(app, {
      method: 'PATCH',
      url: `open-apis/im/v1/messages/${encodeURIComponent(messageId)}`,
      data: { content: JSON.stringify(card) },
    });
  }

  /**
   * `POST /open-apis/interactive/v1/card/update`: replace the card a callback was clicked on, with the callback's own
   * update token (§7.1) — the late answer to a click Orbit could not answer within Feishu's 3 seconds. Feishu takes a
   * token for 30 minutes after the click and at most twice.
   */
  delayedUpdateCard(app: FeishuAppCredentials, token: string, card: unknown): Promise<FeishuSendResult> {
    return this.call(app, { method: 'POST', url: 'open-apis/interactive/v1/card/update', data: { token, card } });
  }

  /**
   * `GET /open-apis/contact/v3/users/:user_id` (open_id): a person's name in the app's tenant, for display (§5.1). Null
   * when Feishu does not say — the permission not granted, the person out of the app's range, Feishu unreachable.
   */
  async userName(app: FeishuAppCredentials, openId: string): Promise<string | null> {
    try {
      const answer = (await feishuClient(app).request({
        method: 'GET',
        url: `open-apis/contact/v3/users/${encodeURIComponent(openId)}`,
        params: { user_id_type: 'open_id' },
      })) as { code?: unknown; data?: { user?: { name?: unknown } } } | null;
      const name = answer?.code === 0 ? answer.data?.user?.name : undefined;
      return typeof name === 'string' && name.trim() !== '' ? name.trim().slice(0, 200) : null;
    } catch {
      this.logger.log(`feishu app ${app.appId}: a user's name could not be read`);
      return null;
    }
  }

  private async call(app: FeishuAppCredentials, request: Request): Promise<FeishuSendResult> {
    const client = feishuClient(app);
    for (let attempt = 0; ; attempt++) {
      let status: number | null = 200;
      let headers: Record<string, unknown> | undefined;
      let answer: unknown;
      try {
        answer = await client.request(request);
      } catch (error) {
        const response = (error as { response?: { status?: unknown; data?: unknown; headers?: Record<string, unknown> } } | null)?.response;
        if (!response) {
          const code = (error as { code?: unknown } | null)?.code;
          return { ok: false, status: null, feishuCode: null, feishuMsg: typeof code === 'string' ? code : 'no answer' };
        }
        status = typeof response.status === 'number' ? response.status : null;
        headers = response.headers;
        answer = response.data;
      }
      const { code, msg, data } = (answer && typeof answer === 'object' ? answer : {}) as { code?: unknown; msg?: unknown; data?: { message_id?: unknown } };
      if (status === 429 || code === 99991400) {
        const waitMs = rateLimitWaitMs(headers, this.timing);
        if (attempt < RATE_LIMIT_RETRIES && waitMs <= this.timing.rateLimitCapMs) {
          this.logger.log(`feishu app ${app.appId}: rate limited; trying again in ${waitMs}ms`);
          await this.wait(waitMs);
          continue;
        }
      }
      const feishuMsg = typeof msg === 'string' ? msg.slice(0, 500) : '';
      if (code === 0 && status !== null && status < 300) {
        return { ok: true, messageId: typeof data?.message_id === 'string' ? data.message_id : null };
      }
      return { ok: false, status, feishuCode: typeof code === 'number' ? code : null, feishuMsg };
    }
  }
}
