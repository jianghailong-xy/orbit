import { Injectable, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { OutgoingHttpHeaders } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
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
  type MessagesEvent,
  type TranslateContext,
} from './anthropic-gateway';
import { ANTHROPIC_GATEWAY_PATH, anthropicGatewayEnabled, gatewaySmallModel, KEY_GATEWAY_TOKEN_PREFIX } from './key-gateway';
import { resolveHost, UpstreamRefused, vetUpstream, type HostResolver, type VettedUpstream } from './gateway-upstream';
import { catalogModels } from './model-catalog';
import { parseJson, readAll, readBody, relayStream, sendUpstream, type Answer } from './pool-gateway.service';
import { decryptSecret } from './provider-crypto';

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
    baseUrl: string;
    apiKeyEnc: string;
    presetSlug: string | null;
    followsPreset: boolean;
    models: unknown;
  };
}

/** The paths the gateway answers, matched without the query (the CLI sends `?beta=true`). */
const MESSAGES = '/v1/messages';
const COUNT_TOKENS = '/v1/messages/count_tokens';

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
 * Errors pass back in Anthropic's shape with the upstream's status; which status and wording each upstream
 * failure is answered with, and what it does to the key, are P2's (design §5.4). No body, key or token is
 * ever logged.
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
            id: true, slug: true, ownerId: true, runtime: true, baseUrl: true, apiKeyEnc: true, enabled: true,
            presetSlug: true, followsPreset: true, models: true,
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
        id: provider.id, slug: provider.slug, baseUrl: provider.baseUrl, apiKeyEnc: provider.apiKeyEnc,
        presetSlug: provider.presetSlug, followsPreset: provider.followsPreset, models: provider.models,
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
    const payload = Buffer.from(JSON.stringify(request), 'utf8');
    let answer: Answer;
    try {
      answer = await sendUpstream(this.agent, 'POST', upstreamUrl(caller.key.baseUrl, '/responses'),
        upstreamHeaders(caller.key.apiKeyEnc, payload.length, 'text/event-stream'), payload, res, upstream.lookup);
    } catch (e) {
      if (!res.headersSent) refuseAnthropic(res, 529, 'overloaded_error', `The Orbit gateway could not reach OpenAI: ${(e as Error).message}`);
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
      // The minimal passthrough: the upstream's status, its error in Anthropic's terms (design §5.4 is P2's).
      const error = (parseJson(answer.body) as { error?: { code?: unknown; type?: unknown; message?: unknown } } | undefined)?.error;
      const code = typeof error?.code === 'string' ? error.code : typeof error?.type === 'string' ? error.type : '';
      const text = typeof error?.message === 'string' ? error.message : '';
      res.status(status).json({ type: 'error', error: anthropicError(code, text, { contextWindow: window, inputTokensEstimate: estimate }) });
      this.log.log(`session ${caller.sessionId} key ${caller.key.slug} model ${upstreamModel}: POST ${path} → ${status} ${code || 'error'} in ${Date.now() - started}ms`);
      return;
    }
    const converter = new MessagesStreamConverter({
      model: typeof message.model === 'string' ? message.model : upstreamModel,
      contextWindow: window,
      inputTokensEstimate: estimate,
    });
    const streamed = message.stream === true;
    const events: MessagesEvent[] = [];
    await relayStream(answer.response, res, (outcome, complete) => {
      const usage = outcome.usage
        ? ` in ${outcome.usage.input_tokens ?? 0} out ${outcome.usage.output_tokens ?? 0}`
        : '';
      this.log.log(
        `session ${caller.sessionId} key ${caller.key.slug} model ${outcome.model ?? upstreamModel}: POST ${path} → ${status}` +
        `${complete ? '' : ' (cut off)'}${usage} in ${Date.now() - started}ms`,
      );
    }, streamed
      ? { contentType: 'text/event-stream; charset=utf-8', push: (chunk) => toSse(converter.push(chunk)), end: () => toSse(converter.end()) }
      : {
        contentType: 'application/json',
        push: (chunk) => {
          events.push(...converter.push(chunk));
          return '';
        },
        end: () => {
          events.push(...converter.end());
          const whole = assembleMessage(events);
          return JSON.stringify('message' in whole ? whole.message : { type: 'error', error: whole.error });
        },
      });
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
