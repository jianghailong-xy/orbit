import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { OutgoingHttpHeaders } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
import { AgentProvider } from '@orbit/shared';
import { ACCOUNT_DISABLED } from '../auth/disabled-accounts';
import { PrismaService } from '../prisma/prisma.service';
import {
  assembleMessage,
  estimateInputTokens,
  MessagesStreamConverter,
  toResponsesRequest,
  toSse,
} from './anthropic-gateway';
import {
  anthropicGatewayPath,
  answerFailure,
  COUNT_TOKENS,
  earlyFailure,
  gatewayFailure,
  refuseAnthropic,
  type FailureContext,
} from './anthropic-gateway.service';
import { accountName, POOL_LOGIN_UPSTREAM, usageLimitResetAt } from './codex-login-gateway';
import { maskedAccount } from './codex-login';
import { responseCostMicros } from './openai-prices';
import { parseJson, readAll, readBody, relayStream, sendUpstream, type GatewayCaller } from './pool-gateway.service';
import { PoolLoginGatewayService, type GatewayLogin, type LoginRefusal } from './pool-login-gateway.service';
import { ResponsesStreamTap, type ResponsesOutcome } from './responses-stream-tap';
import { POOL_LOGIN_TOKEN_PREFIX } from './shared-pool';

/** What a login pool's token authenticates on /api/gw/anthropic: the pool gateway's caller, and the session's model. */
export type AnthropicLoginCaller = GatewayCaller & { sessionModel: string | null };

/**
 * Claude Code on its owner's own Codex login pool (docs/claude-engine-openai-gateway-design.md §9): the second
 * upstream of /api/gw/anthropic, behind ORBIT_CLAUDE_CODEX_LOGIN_GATEWAY. A request on the pool's session token
 * (`orbit-gwl-`) is translated as an OpenAI key's is (anthropic-gateway/, pure) and sent to ChatGPT's Codex
 * backend on the account the session's claim chose, through the login gateway's own steps
 * (PoolLoginGatewayService): the account checks, the token refresh, the rate-limit wait, the spent and throttled
 * marks, and the usage ledger. The account's token never leaves this process.
 *
 * What it sends is Claude Code's own: the translated request with Claude Code's system prompt as its
 * `instructions`, Claude Code's User-Agent as it came, and the account's credential pair (`Authorization` and
 * `ChatGPT-Account-ID`). None of what the login gateway adds for codex's own turn (loginProviderRequest: the
 * `version` and `x-codex-routing-hint` headers, the guardian metadata, the zstd body) and no Codex prompt or
 * Codex User-Agent: decision D4 forbids any disguise. The Codex backend accepted exactly this on 2026-11-11
 * (the P2b probe, design §9.1).
 *
 * Every failure reaches the CLI in Anthropic's error shape (design §5.4's table, worded for a ChatGPT account),
 * and the session's cost line is booked here from the usage the backend reports, priced with openai-prices.
 */
@Injectable()
export class AnthropicLoginGatewayService {
  private readonly log = new Logger('AnthropicLoginGateway');
  private readonly agent = new HttpsAgent({ keepAlive: true, maxSockets: 256 });

  constructor(
    private readonly prisma: PrismaService,
    private readonly login: PoolLoginGatewayService,
    @Inject(POOL_LOGIN_UPSTREAM) private readonly upstream: string,
  ) {}

  /** Whether `token` is a login pool's, the kind this upstream answers. */
  static owns(token: string | undefined): boolean {
    return token?.startsWith(POOL_LOGIN_TOKEN_PREFIX) ?? false;
  }

  /** The token's caller as a Claude Code session (PoolLoginGatewayService.caller, `claude`). */
  caller(token: string): Promise<AnthropicLoginCaller | typeof ACCOUNT_DISABLED | null> {
    return this.login.caller(token, AgentProvider.CLAUDE);
  }

  /** A request of `caller`'s, on an allowed path (AnthropicGatewayController), answered on the session's account. */
  async forward(req: Request, res: Response, caller: AnthropicLoginCaller): Promise<void> {
    const started = Date.now();
    const path = anthropicGatewayPath(req.originalUrl ?? req.url);
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
    if (path === COUNT_TOKENS) {
      // The Codex backend counts nothing: characters ÷ 4 (design §4.6), which only makes the CLI compact early.
      res.status(200).json({ input_tokens: estimateInputTokens(message) });
      return;
    }
    const login = await this.login.accountFor(res, caller, refuseLogin);
    if (!login) return;
    const account = maskedAccount(login.accountId);
    const sessionModel = caller.sessionModel?.trim() || (typeof message.model === 'string' ? message.model : '');
    const { request } = toResponsesRequest(message, { sessionModel, promptCacheKey: caller.sessionId });
    const upstreamModel = String(request.model);
    const estimate = estimateInputTokens(message);
    const said: FailureContext = {
      keyLabel: caller.poolLabel,
      subject: `the ChatGPT account ${accountName(login)} of the pool "${caller.poolLabel}"`,
      model: upstreamModel,
      inputTokensEstimate: estimate,
    };
    // How many reasoning items of earlier turns the request carries back (encrypted, never read here): a count only.
    const carried = Array.isArray(request.input) ? (request.input as Array<{ type?: unknown }>).filter((item) => item?.type === 'reasoning').length : 0;
    const line = (what: string) =>
      this.log.log(`session ${caller.sessionId} account ${account} model ${upstreamModel} carried reasoning ${carried}: POST ${path} → ${what} in ${Date.now() - started}ms`);
    const payload = Buffer.from(JSON.stringify(request), 'utf8');
    const now = new Date();
    const answer = await this.login.exchange(res, caller, login, refuseLogin, (credential) =>
      sendUpstream(this.agent, 'POST', `${this.upstream}/responses`,
        upstreamHeaders(credential, login.accountId, payload.length, req.headers['user-agent']), payload, res));
    if (!answer) {
      line('refused by the login gateway');
      return;
    }
    const status = answer.response.statusCode ?? 502;
    const reading = this.login.readUsage(caller, login, answer, now);
    if (answer.body) {
      const outcome = await this.login.answeredWhole(caller, login, answer, reading, now);
      this.login.record(caller, login, outcome, now);
      const parsed = parseJson(answer.body);
      const error = (parsed as { error?: { code?: unknown; type?: unknown; message?: unknown } } | undefined)?.error;
      const code = outcome.errorCode ?? (typeof error?.code === 'string' ? error.code : typeof error?.type === 'string' ? error.type : '');
      const text = typeof error?.message === 'string' ? error.message : '';
      fail(res, status, code, text, said, usageLimitResetAt(parsed, answer.response.headers, now));
      line(`${status} ${code || 'error'}`);
      return;
    }
    if (status >= 300) {
      // Never followed: the Codex backend has no reason to send one, and it could point anywhere.
      answer.response.resume();
      refuseAnthropic(res, 502, 'api_error', `The Codex backend answered ${status}, which the Orbit gateway does not follow.`);
      line(`${status} not followed`);
      return;
    }
    const converter = new MessagesStreamConverter({
      model: typeof message.model === 'string' ? message.model : upstreamModel,
      inputTokensEstimate: estimate,
    });
    if (message.stream !== true) {
      // Unstreamed — the CLI's own retry of a stream that broke, and its side requests: read whole.
      let whole: Buffer;
      try {
        whole = await readAll(answer.response);
      } catch {
        whole = Buffer.alloc(0);
      }
      const assembled = assembleMessage([...converter.push(whole), ...converter.end()]);
      const tap = new ResponsesStreamTap();
      tap.push(whole);
      tap.end();
      this.ended(caller, login, answer, reading, tap.outcome, !('error' in assembled), now, upstreamModel);
      if ('error' in assembled) {
        const failed = converter.failure ?? { code: 'server_error', message: assembled.error.message };
        fail(res, null, failed.code, failed.message, said, usageLimitResetAt(undefined, answer.response.headers, now));
        line(`failed ${failed.code}`);
        return;
      }
      res.status(200).json(assembled.message);
      const usage = assembled.message.usage as { input_tokens?: number; output_tokens?: number } | undefined;
      line(`${status} in ${usage?.input_tokens ?? 0} out ${usage?.output_tokens ?? 0}`);
      return;
    }
    const early = await earlyFailure(answer.response);
    if (early) {
      answer.response.destroy();
      this.ended(caller, login, answer, reading, { errorCode: early.code }, false, now, upstreamModel);
      fail(res, null, early.code, early.message, said, usageLimitResetAt(undefined, answer.response.headers, now));
      line(`failed before output ${early.code}`);
      return;
    }
    await relayStream(answer.response, res, (outcome, complete) => {
      this.ended(caller, login, answer, reading, outcome, complete, now, upstreamModel);
      const failed = converter.failure;
      const usage = outcome.usage ? ` in ${outcome.usage.input_tokens ?? 0} out ${outcome.usage.output_tokens ?? 0}` : '';
      line(`${status}${complete ? '' : ' (cut off)'}${failed ? ` failed mid-stream ${failed.code}` : ''}${usage}`);
    }, { contentType: 'text/event-stream; charset=utf-8', push: (chunk) => toSse(converter.push(chunk)), end: () => toSse(converter.end()) });
  }

  /**
   * An answer that ended: the login gateway's own bookkeeping for the account (spent, cleared, its ledger), and
   * the session's cost line, which turn-complete then leaves alone (key-gateway.ts gatewayBooksSpend).
   */
  private ended(
    caller: AnthropicLoginCaller,
    login: GatewayLogin,
    answer: Parameters<PoolLoginGatewayService['streamEnded']>[2],
    reading: ReturnType<PoolLoginGatewayService['readUsage']>,
    outcome: ResponsesOutcome,
    complete: boolean,
    now: Date,
    sentModel: string,
  ): void {
    this.login.streamEnded(caller, login, answer, reading, outcome, complete, now);
    void this.book(caller, outcome, sentModel);
  }

  /** One answer's usage on the session (design §5.5, D8): its cost added to `cost_usd`, and a `usage` row. */
  private async book(caller: AnthropicLoginCaller, outcome: ResponsesOutcome, sentModel: string): Promise<void> {
    const usage = outcome.usage;
    if (!usage) return;
    const model = outcome.model ?? sentModel;
    const input = count(usage.input_tokens);
    const cached = Math.min(input, count(usage.input_tokens_details?.cached_tokens));
    const output = count(usage.output_tokens);
    const costUsd = responseCostMicros(model, outcome.serviceTier, usage) / 1_000_000;
    try {
      await this.prisma.session.update({
        where: { id: caller.sessionId },
        data: {
          costUsd: { increment: costUsd },
          llmUsage: { create: { model, inputTokens: input - cached, cacheReadInputTokens: cached, outputTokens: output, costUsd } },
        },
        select: { id: true },
      });
    } catch (e) {
      this.log.warn(`session ${caller.sessionId}: could not record usage: ${(e as Error).message}`);
    }
  }
}

/** A token count as an answer gave it: a whole number, never below zero. */
function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/**
 * What goes to the Codex backend: the body's type, what is accepted back, the account's credential pair, and
 * Claude Code's own User-Agent as it came. Nothing else the CLI sent, and nothing that claims to be Codex.
 */
export function upstreamHeaders(accessToken: string, accountId: string, length: number, userAgent: string | string[] | undefined): OutgoingHttpHeaders {
  const agent = Array.isArray(userAgent) ? userAgent[0] : userAgent;
  return {
    'content-type': 'application/json',
    accept: 'text/event-stream',
    authorization: `Bearer ${accessToken}`,
    'chatgpt-account-id': accountId,
    'content-length': String(length),
    ...(agent ? { 'user-agent': agent } : {}),
  };
}

/**
 * A failure the backend answered, as the CLI gets it; the account's marks are the login gateway's own.
 * `resetAt` is the reset the login gateway records for a spent subscription (usageLimitResetAt).
 */
function fail(res: Response, status: number | null, code: string, message: string, said: FailureContext, resetAt: Date): void {
  if (!res.headersSent) answerFailure(res, gatewayFailure(status, code, message, { ...said, spentUntil: resetAt }));
}

/**
 * A refusal of the login gateway's own (no account, signed out, paused, disabled, unreachable) in Anthropic's
 * shape. None is worth the CLI's own retries but an unreachable backend's, which is answered as an overload.
 */
const refuseLogin: LoginRefusal = (res, status, _code, message) => {
  if (status >= 500) {
    refuseAnthropic(res, 529, 'overloaded_error', message);
    return;
  }
  res.setHeader('x-should-retry', 'false');
  refuseAnthropic(res, status, status === 413 ? 'request_too_large' : status === 401 ? 'authentication_error' : 'permission_error', message);
};
