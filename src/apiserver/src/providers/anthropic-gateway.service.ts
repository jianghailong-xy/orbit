import { Injectable, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { IncomingHttpHeaders, IncomingMessage, OutgoingHttpHeaders } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
import { StringDecoder } from 'node:string_decoder';
import { AgentProvider, keyDialect, providerPreset } from '@orbit/shared';
import { ACCOUNT_DISABLED, ACCOUNT_DISABLED_MESSAGE, DisabledAccounts } from '../auth/disabled-accounts';
import { sha256 } from '../common/crypto.util';
import { OPEN_SESSION_STATUSES } from '../common/session-scheduling';
import { PrismaService } from '../prisma/prisma.service';
import {
  anthropicError,
  assembleMessage,
  estimateInputTokens,
  MessagesStreamConverter,
  toInputTokensRequest,
  toResponsesRequest,
  toSse,
  type TranslateContext,
} from './anthropic-gateway';
import { ANTHROPIC_GATEWAY_PATH, anthropicGatewayEnabled, gatewaySmallModel, KEY_GATEWAY_TOKEN_PREFIX } from './key-gateway';
import { resolveHost, UpstreamRefused, vetUpstream, type HostResolver, type VettedUpstream } from './gateway-upstream';
import { catalogModels } from './model-catalog';
import {
  parseJson,
  readAll,
  readBody,
  relayStream,
  sendUpstream,
  SPENT_ERROR_CODES,
  spentUntil,
  type Answer,
} from './pool-gateway.service';
import { responseCostMicros } from './openai-prices';
import { decryptSecret } from './provider-crypto';
import { ResponsesStreamTap, type ResponsesOutcome } from './responses-stream-tap';

/**
 * What a token authenticates (docs/claude-engine-openai-gateway-design.md §5.2): one session, of one person, on
 * one of their OpenAI keys — and nothing more. Everything here was read live at the request.
 */
export interface AnthropicGatewayCaller {
  sessionId: string;
  userId: string;
  /** The session's GPT model, which the translator sends whatever Claude id the CLI names (models.ts). */
  sessionModel: string | null;
  key: {
    id: string;
    slug: string;
    /** The name its owner gave it, which every refusal names it by. */
    label: string;
    baseUrl: string;
    apiKeyEnc: string;
    presetSlug: string | null;
    followsPreset: boolean;
    models: unknown;
    /** INVALID once OpenAI refused it (a 401 here), until a new secret clears it. */
    keyCheckState: string | null;
    /** Until when OpenAI said its budget is spent (migration 0520). */
    spentUntil: Date | null;
  };
}

/** The paths the gateway answers, matched without the query (the CLI sends `?beta=true`). */
const MESSAGES = '/v1/messages';
export const COUNT_TOKENS = '/v1/messages/count_tokens';

/** The path under the gateway a request asks for, without its query. */
export function anthropicGatewayPath(url: string): string {
  const at = url.indexOf('?');
  const path = at >= 0 ? url.slice(0, at) : url;
  const rest = path.startsWith(ANTHROPIC_GATEWAY_PATH) ? path.slice(ANTHROPIC_GATEWAY_PATH.length) : path;
  return rest === '' ? '/' : rest.replace(/\/+$/, '') || '/';
}

/** Whether the gateway answers `method` `path` at all: the turn and its token count, nothing else (§4.1). */
export function anthropicGatewayAllows(method: string, path: string): boolean {
  return method === 'POST' && (path === MESSAGES || path === COUNT_TOKENS);
}

/** A refusal in the shape Anthropic's own errors take, which is what Claude Code reads a message out of. */
export function refuseAnthropic(res: Response, status: number, type: string, message: string): void {
  res.status(status).json({ type: 'error', error: { type, message } });
}

/**
 * The /api/gw/anthropic gateway (design §4.1): Claude Code on an OpenAI key sends Anthropic Messages here with
 * an `orbit-gwk-` token, and this sends them on to the key's `/responses` as OpenAI Responses with the key,
 * translating the answer back (anthropic-gateway/, a pure module). The key is decrypted only for that request.
 *
 * Every upstream failure is answered in Anthropic's shape with the status and wording design §5.4 gives it,
 * and does what it says to the key (gatewayFailure): a 401 marks the key INVALID, a spent budget records
 * until when. That holds for one that comes as the stream's first word too (`response.failed` or `error`
 * before any output, earlyFailure), which is answered as the same HTTP error; one after output has begun
 * can only be an SSE `error` event, on which the CLI asks again unstreamed. No body, key or token is ever
 * logged.
 */
@Injectable()
export class AnthropicGatewayService {
  private readonly log = new Logger('AnthropicGateway');
  /** The connections to the keys' endpoints. Not private: a spec stands its own in to see what connects. */
  agent = new HttpsAgent({ keepAlive: true, maxSockets: 256 });
  /** How an endpoint's host is resolved before the guard checks it (gateway-upstream.ts); a spec stands one in. */
  resolveHost: HostResolver = resolveHost;

  constructor(
    private readonly prisma: PrismaService,
    private readonly disabled: DisabledAccounts,
  ) {}

  /**
   * The token's (session, key, person) when it may still be used; ACCOUNT_DISABLED when it may but for its
   * person's account, which an administrator disabled; null for every other way it may not — revoked (the key
   * was switched off or given a new secret) or expired, the session ended (or its end was asked for) or moved to another credential or
   * engine, the key switched off or no longer an OpenAI key, or the gateway switched off. A deleted session,
   * key or person took the token row with it.
   */
  async caller(token: string | undefined): Promise<AnthropicGatewayCaller | typeof ACCOUNT_DISABLED | null> {
    if (!anthropicGatewayEnabled()) return null;
    if (!token || !token.startsWith(KEY_GATEWAY_TOKEN_PREFIX)) return null;
    const row = await this.prisma.keyGatewayToken.findUnique({
      where: { tokenHash: sha256(token) },
      select: {
        sessionId: true,
        userId: true,
        expiresAt: true,
        revokedAt: true,
        provider: {
          select: {
            id: true, slug: true, label: true, ownerId: true, runtime: true, baseUrl: true, apiKeyEnc: true, enabled: true,
            presetSlug: true, followsPreset: true, models: true, keyCheckState: true, spentUntil: true,
          },
        },
        session: {
          select: {
            status: true, ownerId: true, provider: true, engine: true, model: true, completedAt: true, deletedAt: true,
            cancelRequestedAt: true, endReason: true,
            owner: { select: { disabledAt: true } },
          },
        },
      },
    });
    if (!row || row.revokedAt || row.expiresAt.getTime() <= Date.now()) return null;
    const { session, provider } = row;
    const current =
      OPEN_SESSION_STATUSES.includes(session.status) &&
      !session.completedAt &&
      !session.deletedAt &&
      // An end asked for (SessionsService.end): the runner has yet to stop it, but it serves no more turns.
      !session.cancelRequestedAt &&
      !session.endReason &&
      session.ownerId === row.userId &&
      session.provider === provider.slug &&
      session.engine === AgentProvider.CLAUDE &&
      provider.enabled &&
      keyDialect(provider.runtime) === 'openai' &&
      // A personal key is its owner's alone; a shared one (no owner) an admin's, as dispatch scopes it.
      (provider.ownerId === null || provider.ownerId === row.userId);
    if (!current) return null;
    // Asked last, as the pool gateway asks it: the token itself is good, and works again once enabled.
    if (session.owner.disabledAt || this.disabled.has(row.userId)) return ACCOUNT_DISABLED;
    return {
      sessionId: row.sessionId,
      userId: row.userId,
      sessionModel: session.model,
      key: {
        id: provider.id, slug: provider.slug, label: provider.label, baseUrl: provider.baseUrl, apiKeyEnc: provider.apiKeyEnc,
        presetSlug: provider.presetSlug, followsPreset: provider.followsPreset, models: provider.models,
        keyCheckState: provider.keyCheckState, spentUntil: provider.spentUntil,
      },
    };
  }

  /** A request of `caller`'s, on an allowed path (AnthropicGatewayController), answered through the key. */
  async forward(req: Request, res: Response, caller: AnthropicGatewayCaller): Promise<void> {
    const started = Date.now();
    const path = anthropicGatewayPath(req.originalUrl ?? req.url);
    // Design §5.3 (D3): the key's endpoint is checked and its host resolved before anything connects.
    let upstream: VettedUpstream;
    try {
      upstream = await vetUpstream(caller.key.baseUrl, this.resolveHost);
    } catch (e) {
      if (e instanceof UpstreamRefused) {
        refuseAnthropic(res, 403, 'permission_error', upstreamRefusalMessage(caller.key.slug, e.reason));
        this.log.warn(`session ${caller.sessionId} key ${caller.key.slug}: POST ${path} refused: ${e.reason}`);
      } else {
        refuseAnthropic(res, 529, 'overloaded_error', `The Orbit gateway could not resolve the endpoint of key "${caller.key.slug}": ${(e as Error).message}`);
        this.log.warn(`session ${caller.sessionId} key ${caller.key.slug}: endpoint unresolved: ${(e as Error).message}`);
      }
      return;
    }
    let raw: Buffer;
    try {
      raw = await readBody(req);
    } catch {
      refuseAnthropic(res, 413, 'request_too_large', 'The request is larger than the Orbit gateway forwards.');
      return;
    }
    const body = parseJson(raw);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      refuseAnthropic(res, 400, 'invalid_request_error', 'The request body is not a JSON object.');
      return;
    }
    const message = body as Record<string, unknown>;
    const sessionModel = caller.sessionModel?.trim() || (typeof message.model === 'string' ? message.model : '');
    const ctx: TranslateContext = {
      sessionModel,
      smallModel: gatewaySmallModel(caller.key),
      promptCacheKey: caller.sessionId,
    };
    if (path === COUNT_TOKENS) {
      await this.countTokens(res, caller, message, ctx, upstream);
      this.log.log(`session ${caller.sessionId} key ${caller.key.slug}: POST ${path} in ${Date.now() - started}ms`);
      return;
    }
    const { request } = toResponsesRequest(message, ctx);
    const upstreamModel = String(request.model);
    const estimate = estimateInputTokens(message);
    const window = contextWindow(caller.key, upstreamModel);
    const said: FailureContext = { keyLabel: caller.key.label, model: upstreamModel, contextWindow: window, inputTokensEstimate: estimate };
    const line = (what: string) =>
      this.log.log(`session ${caller.sessionId} key ${caller.key.slug} model ${upstreamModel}: POST ${path} → ${what} in ${Date.now() - started}ms`);
    if (caller.key.keyCheckState === 'INVALID') {
      // OpenAI refused this key already; asking again with it only repeats the refusal until a new one is pasted.
      const failure = gatewayFailure(401, 'invalid_api_key', '', { ...said, spentUntil: new Date() });
      answerFailure(res, failure);
      line('401 key marked invalid, not sent');
      return;
    }
    const payload = Buffer.from(JSON.stringify(request), 'utf8');
    let answer: Answer;
    try {
      answer = await sendUpstream(this.agent, 'POST', upstreamUrl(caller.key.baseUrl, '/responses'),
        upstreamHeaders(caller.key.apiKeyEnc, payload.length, 'text/event-stream'), payload, res, upstream.lookup);
    } catch (e) {
      if (!res.headersSent) answerFailure(res, gatewayFailure(null, 'server_error', `the Orbit gateway could not reach it: ${(e as Error).message}`, { ...said, spentUntil: new Date() }));
      this.log.warn(`session ${caller.sessionId} key ${caller.key.slug}: OpenAI unreachable: ${(e as Error).message}`);
      return;
    }
    const status = answer.response.statusCode ?? 502;
    if (status >= 300 && status < 400) {
      // Never followed (D3): a redirect could point anywhere, an internal address included.
      answer.response.resume();
      refuseAnthropic(res, 502, 'api_error', redirectRefusalMessage(caller.key.slug, status));
      this.log.warn(`session ${caller.sessionId} key ${caller.key.slug} model ${upstreamModel}: POST ${path} → ${status} redirect not followed in ${Date.now() - started}ms`);
      return;
    }
    if (answer.body) {
      const error = (parseJson(answer.body) as { error?: { code?: unknown; type?: unknown; message?: unknown } } | undefined)?.error;
      const code = typeof error?.code === 'string' ? error.code : typeof error?.type === 'string' ? error.type : '';
      const text = typeof error?.message === 'string' ? error.message : '';
      await this.fail(res, caller, status, code, text, answer.response.headers, said);
      line(`${status} ${code || 'error'}`);
      return;
    }
    const converter = new MessagesStreamConverter({
      model: typeof message.model === 'string' ? message.model : upstreamModel,
      contextWindow: window,
      inputTokensEstimate: estimate,
    });
    if (message.stream !== true) {
      // Unstreamed — the CLI's own retry of a stream that broke, and its side requests: one response,
      // read whole, so a failure anywhere in it is answered with its status rather than a 200.
      let raw: Buffer;
      try {
        raw = await readAll(answer.response);
      } catch {
        raw = Buffer.alloc(0);
      }
      const whole = assembleMessage([...converter.push(raw), ...converter.end()]);
      const tap = new ResponsesStreamTap();
      tap.push(raw);
      tap.end();
      void this.record(caller, tap.outcome, upstreamModel);
      if ('error' in whole) {
        const failed = converter.failure ?? { code: 'server_error', message: whole.error.message };
        await this.fail(res, caller, null, failed.code, failed.message, answer.response.headers, said);
        line(`failed ${failed.code}`);
        return;
      }
      res.status(200).json(whole.message);
      void this.answered(caller);
      const usage = whole.message.usage as { input_tokens?: number; output_tokens?: number } | undefined;
      line(`${status} in ${usage?.input_tokens ?? 0} out ${usage?.output_tokens ?? 0}`);
      return;
    }
    const early = await earlyFailure(answer.response);
    if (early) {
      answer.response.destroy();
      await this.fail(res, caller, null, early.code, early.message, answer.response.headers, said);
      line(`failed before output ${early.code}`);
      return;
    }
    await relayStream(answer.response, res, (outcome, complete) => {
      const usage = outcome.usage
        ? ` in ${outcome.usage.input_tokens ?? 0} out ${outcome.usage.output_tokens ?? 0}`
        : '';
      void this.record(caller, outcome, upstreamModel);
      const failed = converter.failure;
      if (failed) {
        // Output had begun, so the CLI was told by an `error` event; the key is answered for all the same.
        const failure = gatewayFailure(null, failed.code, failed.message, { ...said, spentUntil: spentUntil(answer.response.headers, new Date()) });
        void this.effect(caller, failure.effect, failure.spentUntil);
      } else if (complete) {
        void this.answered(caller);
      }
      line(`${status}${complete ? '' : ' (cut off)'}${failed ? ` failed mid-stream ${failed.code}` : ''}${usage}`);
    }, { contentType: 'text/event-stream; charset=utf-8', push: (chunk) => toSse(converter.push(chunk)), end: () => toSse(converter.end()) });
  }

  /** An upstream failure answered (gatewayFailure), its effect on the key written first. */
  private async fail(
    res: Response,
    caller: AnthropicGatewayCaller,
    status: number | null,
    code: string,
    message: string,
    headers: IncomingHttpHeaders,
    said: FailureContext,
  ): Promise<void> {
    const failure = gatewayFailure(status, code, message, { ...said, spentUntil: spentUntil(headers, new Date()) });
    await this.effect(caller, failure.effect, failure.spentUntil);
    if (!res.headersSent) answerFailure(res, failure);
  }

  /**
   * What OpenAI's answer says about the key, kept on its row: refused (keyCheckState INVALID, as a Cursor
   * key's check records a refusal) or out of budget until `until`. Only while the row still holds the
   * secret that was sent, so a key replaced meanwhile is not marked for its predecessor.
   */
  private async effect(caller: AnthropicGatewayCaller, effect: GatewayFailure['effect'], until: Date | undefined): Promise<void> {
    if (!effect) return;
    const data = effect === 'key_invalid'
      ? { keyCheckState: 'INVALID', keyCheckedAt: new Date() }
      : { spentUntil: until ?? null };
    try {
      await this.prisma.modelProvider.updateMany({ where: { id: caller.key.id, apiKeyEnc: caller.key.apiKeyEnc }, data });
      this.log.log(`session ${caller.sessionId} key ${caller.key.slug}: ${effect === 'key_invalid' ? 'refused by OpenAI — marked invalid' : `insufficient_quota — spent until ${until?.toISOString()}`}`);
    } catch (e) {
      this.log.warn(`session ${caller.sessionId} key ${caller.key.slug}: could not record ${effect}: ${(e as Error).message}`);
    }
  }

  /**
   * What one answer used (design §5.5, decision D8), read off the Responses stream as it passed by the same tap
   * the pool gateway reads (`responses-stream-tap.ts`) and priced with `openai-prices.ts`: a `key_gateway_usage`
   * row for the session and key, a `usage` row (input counted the way a Claude row counts it, without what came
   * from the cache), and the cost added to `session.cost_usd`, which turn-complete then leaves alone for such a
   * session (gatewayBooksSpend). Written after the answer is out, off the stream's path; an answer that names no
   * usage writes nothing.
   */
  private async record(caller: AnthropicGatewayCaller, outcome: ResponsesOutcome, sentModel: string): Promise<void> {
    const usage = outcome.usage;
    if (!usage) return;
    const model = outcome.model ?? sentModel;
    const input = count(usage.input_tokens);
    const cached = Math.min(input, count(usage.input_tokens_details?.cached_tokens));
    const output = count(usage.output_tokens);
    const costMicros = responseCostMicros(model, outcome.serviceTier, usage);
    const costUsd = costMicros / 1_000_000;
    try {
      await this.prisma.session.update({
        where: { id: caller.sessionId },
        data: {
          costUsd: { increment: costUsd },
          llmUsage: { create: { model, inputTokens: input - cached, cacheReadInputTokens: cached, outputTokens: output, costUsd } },
          keyGatewayUsage: {
            create: {
              providerId: caller.key.id, model, serviceTier: outcome.serviceTier ?? null,
              inputTokens: input, cachedInputTokens: cached, outputTokens: output,
              reasoningTokens: count(usage.output_tokens_details?.reasoning_tokens), costMicros,
            },
          },
        },
        select: { id: true },
      });
    } catch (e) {
      this.log.warn(`session ${caller.sessionId} key ${caller.key.slug}: could not record usage: ${(e as Error).message}`);
    }
  }

  /** A response OpenAI answered whole: a budget it had said was spent is not any more. */
  private async answered(caller: AnthropicGatewayCaller): Promise<void> {
    if (!caller.key.spentUntil) return;
    try {
      await this.prisma.modelProvider.updateMany({ where: { id: caller.key.id, spentUntil: { not: null } }, data: { spentUntil: null } });
    } catch (e) {
      this.log.warn(`session ${caller.sessionId} key ${caller.key.slug}: could not clear spent: ${(e as Error).message}`);
    }
  }

  /**
   * POST /v1/messages/count_tokens (design §4.6): OpenAI's input-token count for the translated body, and
   * characters ÷ 4 whenever that cannot be had. An over-count only makes the CLI compact a little early.
   */
  private async countTokens(
    res: Response,
    caller: AnthropicGatewayCaller,
    message: Record<string, unknown>,
    ctx: TranslateContext,
    upstream: VettedUpstream,
  ): Promise<void> {
    const payload = Buffer.from(JSON.stringify(toInputTokensRequest(message, ctx)), 'utf8');
    let counted: number | null = null;
    try {
      const answer = await sendUpstream(this.agent, 'POST', upstreamUrl(caller.key.baseUrl, '/responses/input_tokens'),
        upstreamHeaders(caller.key.apiKeyEnc, payload.length, 'application/json'), payload, res, upstream.lookup);
      // A redirect is not followed: read and dropped, and the estimate answers.
      if (!answer.body && (answer.response.statusCode ?? 0) < 300) {
        const value = (parseJson(await readAll(answer.response)) as { input_tokens?: unknown } | undefined)?.input_tokens;
        if (typeof value === 'number' && Number.isFinite(value) && value >= 0) counted = value;
      } else if (!answer.body) {
        answer.response.resume();
      }
    } catch {
      // Unreachable: the estimate below answers.
    }
    if (!res.headersSent) res.status(200).json({ input_tokens: counted ?? estimateInputTokens(message) });
  }
}

/** A token count as an answer gave it: a whole number, never below zero. */
function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** The refusal a session on a key whose endpoint the gateway may not call gets (design §5.3), naming the key. */
export function upstreamRefusalMessage(slug: string, reason: string): string {
  return `The Orbit gateway does not call the endpoint of key "${slug}": ${reason}. ` +
    'Claude Code on an OpenAI key goes only to https://api.openai.com and the hosts an administrator allows.';
}

/** What a session gets when its key's endpoint answers with a redirect, which is never followed. */
export function redirectRefusalMessage(slug: string, status: number): string {
  return `The endpoint of key "${slug}" answered with a redirect (${status}), which the Orbit gateway does not follow.`;
}

/** `<key baseUrl><path>`: an OpenAI key's base names `/v1` (providerPresets.ts `openai`). */
function upstreamUrl(baseUrl: string, path: string): string {
  return `${baseUrl.trim().replace(/\/+$/, '')}${path}`;
}

/**
 * What goes to OpenAI: the body's type, what is accepted back, and the key. Nothing the CLI sent is passed on —
 * its Anthropic headers mean nothing to OpenAI, and an OpenAI-Organization or OpenAI-Project of its own could
 * name one the key is not in (wiki 34mMW9abYYvUTlWPS4nti).
 */
function upstreamHeaders(apiKeyEnc: string, length: number, accept: string): OutgoingHttpHeaders {
  return {
    'content-type': 'application/json',
    accept,
    authorization: `Bearer ${decryptSecret(apiKeyEnc)}`,
    'content-length': String(length),
  };
}

/** The window the key declares for `model`: its preset's catalogue, else the row's own list. */
function contextWindow(key: AnthropicGatewayCaller['key'], model: string): number | undefined {
  const preset = providerPreset(key.presetSlug);
  const fromPreset = preset ? catalogModels(preset).find((m) => m.value === model)?.contextWindow : undefined;
  if (typeof fromPreset === 'number') return fromPreset;
  const own = Array.isArray(key.models)
    ? (key.models as Array<{ value?: unknown; contextWindow?: unknown }>).find((m) => m?.value === model)?.contextWindow
    : undefined;
  return typeof own === 'number' ? own : undefined;
}

/** What a failure's wording may name: the key, the model, and for an overflow the window and estimate. */
export interface FailureContext {
  keyLabel: string;
  /**
   * What the credential is called in place of `the OpenAI key "<keyLabel>"`: a ChatGPT account of a Codex login
   * pool (anthropic-login-gateway.service.ts), whose 401 the login gateway answers itself.
   */
  subject?: string;
  model: string;
  contextWindow?: number;
  inputTokensEstimate?: number;
}

/** One upstream failure as the CLI is answered (design §5.4), and what it does to the key. */
export interface GatewayFailure {
  status: number;
  type: string;
  message: string;
  /**
   * False sends `x-should-retry: false`. Claude Code 2.1.322 otherwise asks again up to ten times over about
   * three minutes, on a 401 and a 429 too (measured): useless for a refused key or a spent budget, and a
   * rate limit the gateway has already waited out. A 529 is left to those retries.
   */
  cliRetries: boolean;
  effect: 'key_invalid' | 'key_spent' | null;
  /** For `key_spent`: when the budget resets. */
  spentUntil?: Date;
}

/**
 * The §5.4 table. `status` is the upstream's HTTP status, or null for a failure that came inside a stream
 * (`response.failed`, `error`), where only the code says what it was.
 *
 * The spent-budget wording is what Orbit's quota handling reads (@orbit/shared isUsageLimitErrorText,
 * parseQuotaResetAt), as it reaches the transcript: the CLI prints a 429 as "API Error: Request rejected
 * (429) · <message>", 36 characters, so "You hit your usage limit" puts the marker at the 40th, the last
 * place the rule (and its Go, Kotlin and Swift mirrors) accepts — "You've" would be one too far. The reset
 * is named with its date and in UTC, which parseQuotaResetAt reads back to the minute.
 */
export function gatewayFailure(
  status: number | null,
  code: string,
  message: string,
  ctx: FailureContext & { spentUntil: Date },
): GatewayFailure {
  const said = message.trim().replace(/\.$/, '');
  const detail = said ? `: ${said}` : '';
  const key = `"${ctx.keyLabel}"`;
  const subject = ctx.subject ?? `the OpenAI key ${key}`;
  const theKey = ctx.subject ?? `the key ${key}`;
  if (SPENT_ERROR_CODES.has(code)) {
    return {
      status: 429,
      type: 'rate_limit_error',
      message: `You hit your usage limit on ${subject} · resets ${resetsPhrase(ctx.spentUntil)}`,
      cliRetries: false,
      effect: 'key_spent',
      spentUntil: ctx.spentUntil,
    };
  }
  if (code === 'context_length_exceeded') {
    return { status: 400, ...anthropicError(code, message, ctx), cliRetries: true, effect: null };
  }
  if (status === 401 || code === 'invalid_api_key') {
    return {
      status: 401,
      type: 'authentication_error',
      message: ctx.subject
        ? `OpenAI refused ${ctx.subject}${detail}.`
        : `OpenAI refused the key ${key}${detail}. Orbit marked it invalid: add a new key in Providers to go on.`,
      cliRetries: false,
      effect: 'key_invalid',
    };
  }
  if (status === 404 || code === 'model_not_found') {
    return { status: 404, type: 'not_found_error', message: `OpenAI has no model "${ctx.model}" for ${theKey}${detail}.`, cliRetries: false, effect: null };
  }
  if (status === 403) {
    return { status: 403, type: 'permission_error', message: `${theKey.charAt(0).toUpperCase()}${theKey.slice(1)} may not use the model "${ctx.model}" on OpenAI${detail}.`, cliRetries: false, effect: null };
  }
  if (status === 429 || code === 'rate_limit_exceeded') {
    return {
      status: 429,
      type: 'rate_limit_error',
      message: `OpenAI is rate-limiting ${theKey}, and was still refusing after the Orbit gateway waited${detail}.`,
      cliRetries: false,
      effect: null,
    };
  }
  if (status !== null ? status >= 400 && status < 500 && status !== 408 : code === 'invalid_prompt' || code === 'invalid_request_error') {
    return { status: status ?? 400, type: 'invalid_request_error', message: said || code || 'OpenAI refused the request.', cliRetries: false, effect: null };
  }
  return {
    status: 529,
    type: 'overloaded_error',
    message: `OpenAI could not answer${status !== null ? ` (${status})` : ''}${detail || '.'}`,
    cliRetries: true,
    effect: null,
  };
}

/** A failure as the CLI gets it. */
export function answerFailure(res: Response, failure: GatewayFailure): void {
  if (!failure.cliRetries) res.setHeader('x-should-retry', 'false');
  refuseAnthropic(res, failure.status, failure.type, failure.message);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Dec 1, 12:00am (UTC)": `at`, rounded up to its minute, the way Claude Code words its own resets. */
export function resetsPhrase(at: Date): string {
  const t = new Date(Math.ceil(at.getTime() / 60_000) * 60_000);
  const hour = t.getUTCHours();
  const minute = String(t.getUTCMinutes()).padStart(2, '0');
  return `${MONTHS[t.getUTCMonth()]} ${t.getUTCDate()}, ${hour % 12 || 12}:${minute}${hour < 12 ? 'am' : 'pm'} (UTC)`;
}

/** The stream events that say nothing yet: a response failing comes after them, and before any output. */
const PREAMBLE = new Set(['response.created', 'response.in_progress', 'response.queued']);

/** The most of a stream's opening held back while looking for its first word. */
const EARLY_LIMIT = 256 * 1024;

/**
 * Whether a Responses stream fails before it says anything (`response.failed` or `error` as the first
 * event after the preamble): its code and message, the bytes read put back for the relay otherwise. A
 * stream that ends without a word is a failure too. Read before the answer's head goes out, so such a
 * failure — a spent budget, an overflow, an overload, which OpenAI may send this way — is answered with
 * its own status, as an error answer is: on an SSE `error` event the CLI would ask again unstreamed.
 */
export function earlyFailure(response: IncomingMessage): Promise<{ code: string; message: string } | null> {
  return new Promise((resolve) => {
    const decoder = new StringDecoder('utf8');
    const chunks: Buffer[] = [];
    let text = '';
    let size = 0;
    const finish = (failure: { code: string; message: string } | null, ended = false) => {
      response.off('readable', onReadable);
      response.off('end', onEnd);
      response.off('error', onError);
      if (!ended && chunks.length > 0) response.unshift(Buffer.concat(chunks));
      resolve(failure);
    };
    const onReadable = () => {
      let chunk: Buffer | null;
      while ((chunk = response.read() as Buffer | null) !== null) {
        chunks.push(chunk);
        size += chunk.length;
        text += decoder.write(chunk);
        for (;;) {
          const at = /\r\n\r\n|\n\n|\r\r/.exec(text);
          if (!at) break;
          const block = text.slice(0, at.index);
          text = text.slice(at.index + at[0].length);
          const data = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
          const event = data ? (parseJson(Buffer.from(data)) as Record<string, unknown> | undefined) : undefined;
          const type = typeof event?.type === 'string' ? event.type : '';
          if (!type || PREAMBLE.has(type)) continue;
          if (type === 'response.failed' || type === 'error') {
            const error = ((type === 'error' ? event!.error ?? event : (event!.response as Record<string, unknown> | undefined)?.error) ?? {}) as Record<string, unknown>;
            finish({ code: String(error.code ?? error.type ?? 'server_error'), message: String(error.message ?? '') });
          } else {
            finish(null);
          }
          return;
        }
        if (size > EARLY_LIMIT) {
          finish(null);
          return;
        }
      }
    };
    const onEnd = () => finish({ code: 'server_error', message: 'the stream ended before the response began' }, true);
    const onError = () => finish({ code: 'server_error', message: 'the stream broke before the response began' }, true);
    response.on('readable', onReadable);
    response.on('end', onEnd);
    response.on('error', onError);
  });
}
