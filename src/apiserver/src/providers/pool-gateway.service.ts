import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type OutgoingHttpHeaders } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { AgentProvider } from '@orbit/shared';
import { ACCOUNT_DISABLED } from '../auth/disabled-accounts';
import { sha256 } from '../common/crypto.util';
import { OPEN_SESSION_STATUSES } from '../common/session-scheduling';
import { PrismaService } from '../prisma/prisma.service';
import { poolPauseBlocksRequest } from './pool-pause';
import { responseCostMicros } from './openai-prices';
import { keyRoom, poolKeysResumeAt } from './pool-key-select';
import { PoolUsageLedger } from './pool-usage-ledger';
import { decryptSecret } from './provider-crypto';
import { readResponsesEvent, ResponsesStreamTap, type ResponsesOutcome } from './responses-stream-tap';
import { maskedKey, nextUsageWindowStart, sharedPoolKeyCandidates, usageWindowStart } from './shared-pool';
import { SharedPoolsService } from './shared-pools.service';

/**
 * Where the pool gateway sends every request it forwards: OpenAI's API. Fixed here — no request, header,
 * setting or environment variable can point a pool's keys anywhere else (docs/codex-shared-pool-design.md
 * §2.2). Provided under POOL_GATEWAY_UPSTREAM so a spec can stand a recorder in its place.
 */
export const OPENAI_API_BASE = 'https://api.openai.com/v1';
export const POOL_GATEWAY_UPSTREAM = 'POOL_GATEWAY_UPSTREAM';

/** The gateway's path under the API prefix; codex appends `/responses` to it (shared-pool.ts poolGatewayUrl). */
export const POOL_GATEWAY_PATH = '/api/gw/codex';

/**
 * What a session on one of a pool's API keys may call, and nothing else: what codex 0.158 was recorded
 * calling through a configured provider (providers/fixtures/codex-gateway-recording.json) — one POST of
 * `/responses` per model request, the context compaction's included. OpenAI's API has no other path codex
 * asks it for. A session on one of a pool's ChatGPT accounts is the login gateway's, whose allowed paths
 * are loginGatewayAllows (codex-login-gateway.ts): the turn, plus the ChatGPT backend calls the CLI makes
 * for itself when signed in — routing, plugins, settings, analytics.
 */
const ALLOWED = [{ method: 'POST', path: '/responses' }] as const;

/** Whether the gateway forwards `method` `path` (a path under POOL_GATEWAY_PATH) at all. */
export function gatewayAllows(method: string, path: string): boolean {
  return ALLOWED.some((allowed) => allowed.method === method && allowed.path === path);
}

/** The largest request body forwarded: nginx admits 30m under `/api/`, and a long thread can come near it. */
const MAX_BODY_BYTES = 30 * 1024 * 1024;

/**
 * A 429 that is a rate limit, not a spent budget, is waited out and sent again on the SAME credential:
 * at most RATE_LIMIT_ATTEMPTS sends, no single wait over RATE_LIMIT_MAX_WAIT_MS and none that would take
 * the waiting past RATE_LIMIT_BUDGET_MS, so the answer leaves well inside the edge's 100-second limit.
 * Codex does not retry a 429 itself (measured on 0.160: one request, then the turn fails), so a limit
 * that outlasts this wait does reach it — which is why the credential is marked `throttled_until` before
 * that answer goes back (throttledUntil below): no claim picks it until the mark passes, and the retry
 * the failed turn arms waits for that instead of a fixed ladder.
 */
const RATE_LIMIT_ATTEMPTS = 4;
const RATE_LIMIT_MAX_WAIT_MS = 20_000;
const RATE_LIMIT_BUDGET_MS = 40_000;

/**
 * The shortest and the longest a credential is held out of new claims once a rate limit outlasted the
 * wait above. The floor, because the answer only goes back at all when the upstream was still refusing
 * after RATE_LIMIT_BUDGET_MS — a `retry-after` shorter than that is a reading from before it. The cap,
 * so that a nonsense one cannot park a credential for hours.
 */
export const THROTTLE_MIN_MS = 60_000;
export const THROTTLE_MAX_MS = 15 * 60_000;

/**
 * Until when a credential that just rate-limited this gateway is held out of new claims: what the upstream
 * asked to be left alone for, inside the bounds above. Codex does not retry a 429 itself, so the turn ends
 * — and without a mark the next claim would put the session back on the same credential and the retry
 * would arm on a fixed ladder. With one, no claim chooses it until it passes (pool-login-select.ts
 * loginCanRun, pool-key-select.ts keyCanRun) and the pool's own retry waits for that moment instead.
 */
export function throttledUntil(headers: IncomingHttpHeaders, body: Buffer | undefined, now: Date): Date {
  const hint = rateLimitWait(headers, body, 1);
  return new Date(now.getTime() + Math.min(THROTTLE_MAX_MS, Math.max(THROTTLE_MIN_MS, hint)));
}

/** An upstream stream that goes this long without a byte is given up on. */
const UPSTREAM_IDLE_MS = 5 * 60_000;

/**
 * Headers not passed on: hop-by-hop ones, which describe a connection and not the request, and the ones
 * this deployment's own edge (Cloudflare, then nginx) adds on the way in — a runner's address, the
 * gateway's loop guard, the edge's accept-encoding. What reaches OpenAI is what codex sent, with one
 * header replaced.
 */
const NOT_FORWARDED = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'trailers',
  'transfer-encoding', 'upgrade', 'host', 'content-length', 'authorization',
  'x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host', 'x-forwarded-port', 'x-real-ip', 'forwarded',
  'via', 'x-orbit-gateway', 'cdn-loop', 'true-client-ip', 'accept-encoding',
  'cf-connecting-ip', 'cf-connecting-ipv6', 'cf-ipcountry', 'cf-ray', 'cf-visitor', 'cf-worker', 'cf-warp-tag-id',
]);

/** Headers of OpenAI's answer not passed back: hop-by-hop ones, and its cookies, which are api.openai.com's. */
const NOT_RETURNED = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'trailers',
  'transfer-encoding', 'upgrade', 'set-cookie',
]);

/**
 * The error codes of a spent budget, as codex-api api_bridge.rs reads a 429: the API's `insufficient_quota`
 * family, and a ChatGPT subscription's `usage_limit_reached` / `usage_not_included` (the Codex backend's,
 * pool-login-gateway.service.ts). Asking again changes none of them, so none is waited out.
 */
export const SPENT_ERROR_CODES = new Set([
  'insufficient_quota', 'credit_balance_exhausted', 'organization_spend_limit_exceeded',
  'project_spend_limit_exceeded', 'organization_usage_limit_exceeded', 'usage_limit_reached', 'usage_not_included',
]);

/**
 * Who is calling, established from their session token — a person's (`orbit-gw-`, this service's) or a
 * login pool's (`orbit-gwl-`, PoolLoginGatewayService's) — and what their session runs on now. The token
 * authenticates (pool, person, session) and nothing more; which upstream a request goes to is the
 * session's: one of the pool's ChatGPT accounts (`accountId`), or one of its API keys (`keyId`).
 */
export interface GatewayCaller {
  poolId: string;
  poolLabel: string;
  /** Whose the pool is — and so whose its ChatGPT accounts are, 0323's foreign key holding them to it. */
  poolOwnerId: string;
  /** The token's person. */
  userId: string;
  sessionId: string;
  /** Whose the session is: the token's person, or the token is refused before this is built. */
  sessionOwnerId: string;
  /** `session.pool_codex_account_id`: the ChatGPT account of the pool the session runs on, if any. */
  accountId: string | null;
  /** `session.pool_key_id`: the API key of the pool the session runs on, if any. */
  keyId: string | null;
}

/** A key as the gateway uses one. The secret is decrypted only for the request, and never kept. */
interface GatewayKey {
  id: string;
  label: string;
  contributorId: string;
  state: string;
  enabled: boolean;
  shareCap: number | null;
  spentUntil: Date | null;
  throttledUntil: Date | null;
  pausedAt?: Date | null;
  pausedUntil?: Date | null;
  keyHint: string;
  secretEncrypted: string;
}

/** The upstream's answer as far as it has been read. */
export interface Answer {
  response: IncomingMessage;
  /** Read whole, for an error answer, which is small; undefined for one passed on as a stream. */
  body?: Buffer;
}

/**
 * The Codex pools' gateway on API keys (docs/codex-shared-pool-design.md §2.2–§2.3): a session on a Codex
 * pool runs codex with the gateway as its OpenAI endpoint and a session token as its key; while the session
 * runs on one of the pool's API keys, this puts that key in the token's place and passes the request to
 * OpenAI and the answer back byte for byte. Which upstream a request goes to is the session's, not the
 * token's (PoolGatewayController): one of the pool's ChatGPT accounts is PoolLoginGatewayService's.
 *
 * What it decides, and nothing more:
 * - WHO (`caller`, for a person's token, `orbit-gw-`): the token's hash names one (pool, person,
 *   session); a token revoked or expired, a session no longer open, a session moved to another provider,
 *   a person gone from the pool or a pool deleted — the last two delete the token row itself — is 401. A
 *   good token of an account an administrator disabled is 403 ACCOUNT_DISABLED, as its runner credential
 *   is. The pool may be a shared one or one of somebody's own its owner added the person to (migration 0358).
 * - WHAT: only the ALLOWED paths; anything else is 403 (gatewayAllows, asked by the controller).
 * - WHICH KEY (`forward`): `session.pool_key_id`, as the claim chose it (QueueService.resolveSharedPool,
 *   and resolveLoginPool for an owner's session none of whose pool's accounts can run). The gateway
 *   never chooses a key and never moves a session to another one; a key that cannot run for the session
 *   — none chosen, switched off, refused or disabled by OpenAI, or its share cap spent by the others — is
 *   refused here with the reason, and the session's next claim moves it.
 * - WHAT OPENAI SAID: `insufficient_quota` marks the key out of budget until it resets; a 401 marks it
 *   INVALID. Either way the turn ends, as any quota ends one, and the next claim moves the session. A rate
 *   limit is waited out on the same key; one that outlasts that wait is recorded as a short
 *   `throttled_until` on the key before its 429 goes back, so no claim picks it until then.
 * - WHAT IT COST: the usage the response ends with, per person and per key, into PoolUsageLedger.
 *
 * No database connection is held while a response streams: every read is made before the request goes
 * out, and every write after it is either awaited before the answer starts (a key marked) or handed to
 * the ledger's batch.
 */
@Injectable()
export class PoolGatewayService {
  private readonly log = new Logger('PoolGateway');
  private readonly agent = new HttpsAgent({ keepAlive: true, maxSockets: 256 });

  constructor(
    private readonly prisma: PrismaService,
    private readonly pools: SharedPoolsService,
    private readonly ledger: PoolUsageLedger,
    @Inject(POOL_GATEWAY_UPSTREAM) private readonly upstream: string,
  ) {}

  /**
   * A request of a session on one of its pool's API keys (or on none), sent on to OpenAI's API on that key
   * — `caller` authenticated by either kind of token, and the path already allowed (PoolGatewayController).
   */
  async forward(req: Request, res: Response, caller: GatewayCaller): Promise<void> {
    const started = Date.now();
    const target = gatewayTarget(req.originalUrl ?? req.url);
    const now = new Date();
    const key = caller.keyId ? await this.keyOf(caller.poolId, caller.keyId) : null;
    const why = key ? await this.whyNot(key, caller.userId, now) : null;
    if (!key || why) {
      refuse(res, 403, 'orbit_pool_key_unavailable', await this.unavailable(caller, key, why, now));
      this.log.log(`session ${caller.sessionId} pool ${caller.poolId}: ${key ? `${maskedKey(key.keyHint)} ${why}` : 'no key'} — refused`);
      return;
    }
    if (await poolPauseBlocksRequest(this.prisma, caller.sessionId, key, now)) {
      refuse(res, 403, 'orbit_pool_account_paused', `This account is paused until ${key.pausedUntil!.toISOString()}`);
      return;
    }
    let body: Buffer;
    try {
      body = await readBody(req);
    } catch {
      refuse(res, 413, 'orbit_gateway_request_too_large', 'The request is larger than the Orbit pool gateway forwards');
      return;
    }
    const headers = forwardedHeaders(req.headers, decryptSecret(key.secretEncrypted), body.length);
    const url = `${this.upstream}${target.path}${target.query}`;
    let answer: Answer;
    try {
      answer = await sendUpstream(this.agent, req.method, url, headers, body, res);
    } catch (e) {
      if (!res.headersSent) {
        refuse(res, 502, 'orbit_gateway_upstream_unreachable', `The Orbit pool gateway could not reach OpenAI: ${(e as Error).message}`);
      }
      this.log.warn(`session ${caller.sessionId} key ${maskedKey(key.keyHint)}: OpenAI unreachable: ${(e as Error).message}`);
      return;
    }
    const status = answer.response.statusCode ?? 502;
    if (answer.body) {
      const outcome: ResponsesOutcome = {};
      readResponsesEvent(parseJson(answer.body), outcome);
      if (status === 401) {
        // The key is wrong or revoked. Marked before the answer, so the claim that follows cannot choose it.
        await this.pools.markKeyInvalid(key.id);
        refuse(res, 403, 'orbit_pool_key_rejected',
          `${key.label} (${maskedKey(key.keyHint)}) was rejected by OpenAI — it stays out of "${caller.poolLabel}" until ` +
          'its contributor or an admin replaces it, and your next turn moves to another key');
        this.log.log(`session ${caller.sessionId} key ${maskedKey(key.keyHint)}: 401 from OpenAI — marked invalid`);
        return;
      }
      if (outcome.errorCode === 'insufficient_quota') {
        await this.pools.markKeySpent(key.id, spentUntil(answer.response.headers, now));
        this.log.log(`session ${caller.sessionId} key ${maskedKey(key.keyHint)}: insufficient_quota — marked out of budget`);
      } else if (status === 429 && !(outcome.errorCode && SPENT_ERROR_CODES.has(outcome.errorCode))) {
        // A rate limit the wait above did not outlast — the one kind of 429 that reaches codex, which
        // does not retry it. Marked before the answer goes back, so the claim the failed turn's retry
        // makes already finds it out and moves the session, or waits for the moment it can run.
        const until = throttledUntil(answer.response.headers, answer.body, now);
        await this.pools.markKeyThrottled(key.id, until);
        this.log.log(`session ${caller.sessionId} key ${maskedKey(key.keyHint)}: rate limited — held out until ${until.toISOString()}`);
      }
      this.record(caller, key, outcome, now);
      relayHead(res, answer.response);
      res.end(answer.body);
      this.log.log(`session ${caller.sessionId} key ${maskedKey(key.keyHint)}: ${req.method} ${target.path} → ${status} in ${Date.now() - started}ms`);
      return;
    }
    await this.stream(answer.response, res, caller, key, now);
    this.log.log(`session ${caller.sessionId} key ${maskedKey(key.keyHint)}: ${req.method} ${target.path} → ${status} in ${Date.now() - started}ms`);
  }

  /**
   * A person's token's (pool, person, session) and what the session runs on, when the token may still be
   * used; ACCOUNT_DISABLED when it may but for its person's account, which an administrator disabled
   * (docs/google-sign-in-design.md §5.5); null for every other way it may not. The pool is a Codex pool the
   * person is one of the people of — the token's own key says so — whether a shared one or one of somebody's
   * own (migration 0358).
   */
  async caller(token: string | undefined): Promise<GatewayCaller | typeof ACCOUNT_DISABLED | null> {
    if (!token || !token.startsWith('orbit-gw-')) return null;
    const row = await this.prisma.poolGatewayToken.findUnique({
      where: { tokenHash: sha256(token) },
      select: {
        poolId: true,
        userId: true,
        sessionId: true,
        expiresAt: true,
        revokedAt: true,
        person: { select: { pool: { select: { slug: true, label: true, engine: true, ownerId: true } } } },
        session: {
          select: {
            status: true, ownerId: true, provider: true, poolKeyId: true, poolCodexAccountId: true,
            completedAt: true, deletedAt: true, owner: { select: { disabledAt: true } },
          },
        },
      },
    });
    if (!row || row.revokedAt || row.expiresAt.getTime() <= Date.now()) return null;
    const { pool } = row.person;
    const { session } = row;
    const current =
      pool.engine === AgentProvider.CODEX &&
      OPEN_SESSION_STATUSES.includes(session.status) &&
      !session.completedAt &&
      !session.deletedAt &&
      session.ownerId === row.userId &&
      // A session moved onto another provider since: its old tokens name a pool it no longer runs on.
      session.provider === pool.slug;
    if (!current) return null;
    // The session's owner is the token's person (above). Asked last, as the runner credential asks it:
    // the token itself is good, and works again once the account is enabled.
    if (session.owner.disabledAt) return ACCOUNT_DISABLED;
    return {
      poolId: row.poolId,
      poolLabel: pool.label,
      poolOwnerId: pool.ownerId,
      userId: row.userId,
      sessionId: row.sessionId,
      sessionOwnerId: session.ownerId,
      accountId: session.poolCodexAccountId,
      keyId: session.poolKeyId,
    };
  }

  private keyOf(poolId: string, keyId: string): Promise<GatewayKey | null> {
    return this.prisma.poolApiKey.findFirst({
      where: { id: keyId, poolId },
      select: {
        id: true, label: true, contributorId: true, state: true, enabled: true, shareCap: true, spentUntil: true,
        throttledUntil: true,
        keyHint: true, secretEncrypted: true, pausedAt: true, pausedUntil: true,
      },
    });
  }

  /**
   * Why a session of `userId` may not send on `key` now, or null when it may. Out of budget is not a
   * reason here: OpenAI decides that, and a key its organization has topped up works again the moment it
   * is asked (and is then cleared). The share cap is the gateway's own to hold, counted with what the
   * ledger has not written yet.
   */
  private async whyNot(key: GatewayKey, userId: string, now: Date): Promise<string | null> {
    if (key.state === 'INVALID') return 'was rejected by OpenAI';
    if (!key.enabled || key.state !== 'ACTIVE') return 'is disabled';
    if (key.contributorId === userId || key.shareCap === null) return null;
    const window = usageWindowStart(now);
    const spent = await this.prisma.poolUsage.aggregate({
      where: { keyId: key.id, windowStart: window, userId: { not: key.contributorId } },
      _sum: { costMicros: true },
    });
    const othersCostMicros =
      Number(spent._sum.costMicros ?? 0n) + this.ledger.pendingOthersCostMicros(key.id, key.contributorId, window);
    return keyRoom({ ...key, othersCostMicros }, userId) > 0 ? null : 'is out of budget';
  }

  /**
   * The refusal's words: which key, why, and what happens next for this person — another key takes the
   * next turn, or nothing can until the first reset (this key's own included), or until somebody acts.
   */
  private async unavailable(caller: GatewayCaller, key: GatewayKey | null, why: string | null, now: Date): Promise<string> {
    // Counted as whyNot counts a cap: with what the ledger has not written yet.
    const window = usageWindowStart(now);
    const keys = (await sharedPoolKeyCandidates(this.prisma, caller.poolId, now)).map((candidate) => ({
      ...candidate,
      othersCostMicros:
        candidate.othersCostMicros + this.ledger.pendingOthersCostMicros(candidate.id, candidate.contributorId, window),
    }));
    const another = poolKeysResumeAt(keys.filter((candidate) => candidate.id !== key?.id), caller.userId, now);
    const resumes = poolKeysResumeAt(keys, caller.userId, now);
    const next =
      another && another.getTime() <= now.getTime()
        ? 'your next turn moves to another key'
        : resumes
          ? `no key of "${caller.poolLabel}" can run for you until ${resumes.toISOString().slice(0, 16).replace('T', ' ')} UTC`
          : `no key of "${caller.poolLabel}" can run for you until one is replaced or switched back on`;
    return key ? `${key.label} (${maskedKey(key.keyHint)}) ${why} — ${next}` : `There is no key for you in "${caller.poolLabel}" right now — ${next}`;
  }

  /** A successful answer, passed back byte for byte as it arrives, read along the way for what it used. */
  private stream(response: IncomingMessage, res: Response, caller: GatewayCaller, key: GatewayKey, now: Date): Promise<void> {
    return relayStream(response, res, (outcome, complete) => {
      if (outcome.errorCode === 'insufficient_quota') {
        // Said inside a stream that had already begun: marked all the same, off the stream's path.
        void this.pools.markKeySpent(key.id, nextUsageWindowStart(now)).catch((e) =>
          this.log.warn(`could not mark ${maskedKey(key.keyHint)} out of budget: ${(e as Error).message}`),
        );
      } else if (complete && key.spentUntil && (response.statusCode ?? 0) < 300) {
        // OpenAI took it after all: the organization has budget again.
        void this.pools.clearKeySpent(key.id).catch((e) =>
          this.log.warn(`could not clear ${maskedKey(key.keyHint)}'s out-of-budget mark: ${(e as Error).message}`),
        );
      }
      this.record(caller, key, outcome, now);
    });
  }

  /** What the answer used, into the ledger for this person and this key. */
  private record(caller: GatewayCaller, key: GatewayKey, outcome: ResponsesOutcome, now: Date): void {
    if (!outcome.usage) return;
    this.ledger.record({
      poolId: caller.poolId,
      keyId: key.id,
      userId: caller.userId,
      inputTokens: outcome.usage.input_tokens ?? 0,
      outputTokens: outcome.usage.output_tokens ?? 0,
      costMicros: responseCostMicros(outcome.model, outcome.serviceTier, outcome.usage),
      at: now,
    });
  }
}

/** The path under the gateway a request asks for, and its query string, as sent. */
export function gatewayTarget(url: string): { path: string; query: string } {
  const at = url.indexOf('?');
  const path = at >= 0 ? url.slice(0, at) : url;
  const rest = path.startsWith(POOL_GATEWAY_PATH) ? path.slice(POOL_GATEWAY_PATH.length) : path;
  return { path: rest === '' ? '/' : rest, query: at >= 0 ? url.slice(at) : '' };
}

/** What codex sent, minus NOT_FORWARDED, with the pool's key as its credential. */
export function forwardedHeaders(incoming: IncomingHttpHeaders, secret: string, length: number): OutgoingHttpHeaders {
  const headers: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(incoming)) {
    if (value === undefined || NOT_FORWARDED.has(name.toLowerCase())) continue;
    headers[name] = value;
  }
  headers.authorization = `Bearer ${secret}`;
  headers['content-length'] = String(length);
  return headers;
}

/** The bearer credential of an `Authorization` header, or undefined. */
export function bearerToken(authorization: string | undefined): string | undefined {
  return /^Bearer\s+(\S+)\s*$/i.exec(authorization ?? '')?.[1];
}

/**
 * Sends the request, waiting out a rate limit on the same credential. An error answer (status 400 and up)
 * is read whole before anything goes back — it is small, and whether it is a spent budget or a refused
 * credential decides what the gateway does; a success is handed back unread, to be streamed.
 */
export async function sendUpstream(
  agent: HttpsAgent,
  method: string,
  url: string,
  headers: OutgoingHttpHeaders,
  body: Buffer,
  res: Response,
): Promise<Answer> {
  let waited = 0;
  for (let attempt = 1; ; attempt += 1) {
    const response = await exchangeUpstream(agent, method, url, headers, body, res);
    if ((response.statusCode ?? 0) < 400) return { response };
    const answer = { response, body: await readAll(response) };
    if (response.statusCode !== 429) return answer;
    const outcome: ResponsesOutcome = {};
    readResponsesEvent(parseJson(answer.body), outcome);
    if (outcome.errorCode && SPENT_ERROR_CODES.has(outcome.errorCode)) return answer;
    const wait = rateLimitWait(response.headers, answer.body, attempt);
    if (attempt >= RATE_LIMIT_ATTEMPTS || wait > RATE_LIMIT_MAX_WAIT_MS || waited + wait > RATE_LIMIT_BUDGET_MS) {
      return answer;
    }
    if (res.destroyed) return answer;
    await new Promise((resolve) => setTimeout(resolve, wait));
    waited += wait;
  }
}

/** One request to the upstream, resolved with its answer's head; aborted if codex goes away first. */
export function exchangeUpstream(
  agent: HttpsAgent,
  method: string,
  url: string,
  headers: OutgoingHttpHeaders,
  body: Buffer,
  res: Response,
): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
    const request = send(
      target,
      { method, headers, ...(target.protocol === 'https:' ? { agent } : {}) },
      resolve,
    );
    request.on('error', reject);
    request.setTimeout(UPSTREAM_IDLE_MS, () => request.destroy(new Error('OpenAI went quiet')));
    // Codex gone (an interrupt, a dead process): stop the answer being generated for nobody.
    res.once('close', () => {
      if (!res.writableFinished) request.destroy();
    });
    request.end(body);
  });
}

/**
 * A successful answer, passed back byte for byte as it arrives and read along the way (a copy, never the
 * bytes codex gets) for what it used; `done` is told what was read, once, when the stream ends — complete,
 * or cut off by either side.
 */
export function relayStream(
  response: IncomingMessage,
  res: Response,
  done: (outcome: ResponsesOutcome, complete: boolean) => void,
): Promise<void> {
  return new Promise((resolve) => {
    const tap = new ResponsesStreamTap();
    // A response codex asked for unstreamed is one JSON object, read whole at its end.
    const whole = /application\/json/i.test(String(response.headers['content-type'] ?? '')) ? ([] as Buffer[]) : null;
    let wholeBytes = 0;
    relayHead(res, response);
    res.flushHeaders();
    let settled = false;
    const end = (complete: boolean) => {
      if (settled) return;
      settled = true;
      tap.end();
      const outcome = tap.outcome;
      if (whole && complete) readResponsesEvent(parseJson(Buffer.concat(whole)), outcome);
      done(outcome, complete);
      resolve();
    };
    response.on('data', (chunk: Buffer) => {
      if (whole) {
        wholeBytes += chunk.length;
        if (wholeBytes <= MAX_BODY_BYTES) whole.push(chunk);
      } else {
        tap.push(chunk);
      }
      if (!res.write(chunk)) {
        response.pause();
        res.once('drain', () => response.resume());
      }
    });
    response.on('end', () => {
      res.end();
      end(true);
    });
    response.on('error', () => {
      res.destroy();
      end(false);
    });
    res.once('close', () => {
      if (!res.writableFinished) response.destroy();
      end(false);
    });
  });
}

/** The answer's status and headers, minus NOT_RETURNED. */
export function relayHead(res: Response, response: IncomingMessage): void {
  res.status(response.statusCode ?? 502);
  for (const [name, value] of Object.entries(response.headers)) {
    if (value === undefined || NOT_RETURNED.has(name.toLowerCase())) continue;
    res.setHeader(name, value);
  }
}

/** A refusal in the shape OpenAI's own errors take, which is what codex reads a message out of. */
export function refuse(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: { message, type: 'orbit_gateway', param: null, code } });
}

export function readBody(req: Request): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error('too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function readAll(response: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    response.on('data', (chunk: Buffer) => chunks.push(chunk));
    response.on('end', () => resolve(Buffer.concat(chunks)));
    response.on('error', reject);
  });
}

export function parseJson(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    return undefined;
  }
}

/**
 * How long to wait before sending a rate-limited request again: what OpenAI says — `retry-after-ms`,
 * `retry-after` (seconds or a date), the later of `x-ratelimit-reset-requests` / `-tokens`, or the
 * "try again in 2.4s" of its message — else 1s, 2s, 4s. Never under a quarter of a second.
 */
export function rateLimitWait(headers: IncomingHttpHeaders, body: Buffer | undefined, attempt: number): number {
  const header = (name: string) => {
    const value = headers[name];
    return Array.isArray(value) ? value[0] : value;
  };
  const candidates: number[] = [];
  const ms = Number(header('retry-after-ms'));
  if (Number.isFinite(ms) && ms > 0) candidates.push(ms);
  const after = header('retry-after');
  if (after !== undefined && candidates.length === 0) {
    const seconds = Number(after);
    if (Number.isFinite(seconds)) candidates.push(seconds * 1000);
    else if (!Number.isNaN(Date.parse(after))) candidates.push(Date.parse(after) - Date.now());
  }
  if (candidates.length === 0) {
    const resets = ['x-ratelimit-reset-requests', 'x-ratelimit-reset-tokens']
      .map((name) => duration(header(name)))
      .filter((value): value is number => value !== null);
    if (resets.length > 0) candidates.push(Math.max(...resets));
  }
  if (candidates.length === 0 && body) {
    const hint = /try again in ([0-9.]+\s*(?:ms|s|m))/i.exec(body.toString('utf8'))?.[1];
    const parsed = duration(hint?.replace(/\s+/g, ''));
    if (parsed !== null) candidates.push(parsed);
  }
  const wait = candidates.length > 0 ? candidates[0] : 1000 * 2 ** (attempt - 1);
  return Math.max(250, Math.ceil(wait));
}

/** OpenAI's reset durations — `20ms`, `2.4s`, `6m0s`, `1h2m3s` — in milliseconds; null when unreadable. */
export function duration(text: string | undefined): number | null {
  if (!text) return null;
  const parts = [...text.matchAll(/([0-9]+(?:\.[0-9]+)?)(ms|h|m|s)/g)];
  if (parts.length === 0 || parts.map((part) => part[0]).join('') !== text.trim()) return null;
  const unit: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };
  return parts.reduce((sum, part) => sum + Number(part[1]) * unit[part[2]], 0);
}

/**
 * Until when a key OpenAI answered `insufficient_quota` for stays out of budget: the reset it names —
 * `retry-after` as seconds or a date — when it names one, else the first of the next month, when a
 * monthly budget starts again and the pool's own caps count from zero.
 */
export function spentUntil(headers: IncomingHttpHeaders, now: Date): Date {
  const after = Array.isArray(headers['retry-after']) ? headers['retry-after'][0] : headers['retry-after'];
  if (after !== undefined) {
    const seconds = Number(after);
    const at = Number.isFinite(seconds) ? now.getTime() + seconds * 1000 : Date.parse(after);
    if (Number.isFinite(at) && at > now.getTime()) return new Date(at);
  }
  return nextUsageWindowStart(now);
}
