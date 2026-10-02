import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { AgentProvider } from '@orbit/shared';
import { sha256 } from '../common/crypto.util';
import { OPEN_SESSION_STATUSES } from '../common/session-scheduling';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { ACCESS_TOKEN_FALLBACK_MS, accountOf, maskedAccount } from './codex-login';
import {
  ACCESS_TOKEN_REFRESH_WINDOW_MS,
  codexUsageSnapshot,
  loginForwardedHeaders,
  loginMissingReason,
  loginSignedOutNotice,
  loginSpentNotice,
  POOL_LOGIN_TOKEN_ENDPOINT,
  POOL_LOGIN_UPSTREAM,
  refreshRefusal,
  refreshRequestBody,
  usageLimitResetAt,
} from './codex-login-gateway';
import { CodexLoginService } from './codex-login.service';
import { responseCostMicros } from './openai-prices';
import {
  gatewayTarget,
  parseJson,
  readAll,
  readBody,
  refuse,
  relayHead,
  relayStream,
  sendUpstream,
  SPENT_ERROR_CODES,
  type Answer,
} from './pool-gateway.service';
import { PoolLoginLedger } from './pool-login-ledger';
import { PoolNotices } from './pool-notice';
import { decryptSecret, encryptSecret } from './provider-crypto';
import { readResponsesEvent, type ResponsesOutcome } from './responses-stream-tap';

/**
 * What a login pool's session token may call, and nothing else: what a session's codex sends through a
 * configured provider — one POST of `/responses` per model request, its compaction's included (codex
 * 0.158, recorded: providers/fixtures/codex-gateway-recording.json). Everything else codex asks a ChatGPT
 * backend for when it is signed in itself — the model list, workspace routing, plugins, settings,
 * analytics (providers/fixtures/codex-chatgpt-backend-recording.json) — goes to the backend it was
 * configured with, never through here, and a session token reaches none of it.
 */
const ALLOWED = [{ method: 'POST', path: '/responses' }] as const;

/** How long a refresh may take before the request that needed it is answered 502. */
const REFRESH_TIMEOUT_MS = 15_000;

/** A 429 that is the subscription's limit, which a wait mends — `usage_not_included` is a plan, not a limit. */
const SPENT = new Set([...SPENT_ERROR_CODES].filter((code) => code !== 'usage_not_included'));

/** A login as the gateway uses one. The access token is decrypted only for the request, and never kept. */
interface GatewayLogin {
  accountId: string;
  email: string | null;
  state: string;
  accessTokenEnc: string;
  expiresAt: Date;
  spentUntil: Date | null;
}

const LOGIN_SELECT = {
  accountId: true, email: true, state: true, accessTokenEnc: true, expiresAt: true, spentUntil: true,
} as const;

/** Who is calling, established from their token, and the login their session's account holds (or none). */
interface Caller {
  poolId: string;
  poolLabel: string;
  userId: string;
  sessionId: string;
  login: GatewayLogin | null;
}

/** What a refresh came to. */
type Refreshed =
  | { kind: 'OK'; accessToken: string }
  | { kind: 'REFUSED'; message: string }
  | { kind: 'UNREACHABLE'; message: string }
  | { kind: 'GONE' };

/**
 * The pool gateway for a Codex pool of the account owner's own ChatGPT login (P3-b; migrations 0323 and
 * 0324; docs/codex-shared-pool-design.md in the 2026-09-28 direction): a session on such a pool runs codex
 * with the gateway as its OpenAI endpoint and a session token as its key; this checks the token, puts the
 * login in its place — `Authorization: Bearer <access token>` and `ChatGPT-Account-ID`, the pair the
 * official codex CLI authenticates to ChatGPT's Codex backend with — and passes the request to that
 * backend and the answer back byte for byte. The login never leaves this process: not to a runner, not to
 * a log, not to a response.
 *
 * What it decides, and nothing more:
 * - WHO: the token's hash names one (pool, owner, session). A token revoked or expired, a session no longer
 *   open, moved to another provider or not its token's person's, or the pool deleted — the last deletes the
 *   token row itself — is 401. The token names no account (migration 0355), so no account's leaving the pool
 *   refuses it here.
 * - WHAT: only the ALLOWED paths; anything else is 403.
 * - WHICH ACCOUNT: `session.pool_codex_account_id`, the account the last claim recorded on the session —
 *   never one the token names, which is nothing. An engine warm on a token minted before the session moved
 *   therefore sends on the account the session is on now; the gateway chooses no account and moves no
 *   session. A session whose account the pool no longer holds, or which has none, is refused here with the
 *   reason, and its next claim is what moves it.
 * - FRESHNESS: an access token about to expire is refreshed first, and one the backend answers 401 is
 *   refreshed and the request sent again once — the codex CLI's own recovery, on the same OAuth client and
 *   the same request (`refreshRequestBody`). This is the only place the pair is rotated, one refresh at a
 *   time per account (a refresh token is good once), under the account row's lock.
 * - WHAT THE BACKEND SAID: `usage_limit_reached` records the reset it names on the account (`spent_until`)
 *   before the 429 goes back unchanged, and the session is owed the line saying so; its retry goes at once
 *   when another account can take it, whose claim moves the session there, else waits for the first reset
 *   (QueueService.loginPoolRetryAt) — no other account is tried here. A refresh the token endpoint
 *   refuses, or a 401 on a token just refreshed, signs the account out (SIGNED_OUT, which only its owner
 *   can undo by signing in again) and is answered 403 with that — not 401, which the runner would read as
 *   its own login failing. A rate limit is waited out on the same login (sendUpstream).
 * - WHAT IT USED: the usage each answer ends with, per session and hour, into PoolLoginLedger, with the
 *   x-codex-* window reading the answer carried.
 *
 * No database connection is held while a response streams: every read and every write is made before the
 * answer starts — the refresh's included — or handed to the ledger's batch.
 */
@Injectable()
export class PoolLoginGatewayService {
  private readonly log = new Logger('PoolLoginGateway');
  private readonly agent = new HttpsAgent({ keepAlive: true, maxSockets: 256 });
  /** The refresh in flight for each account, which every request that needs one in this process shares. */
  private readonly refreshing = new Map<string, Promise<Refreshed>>();
  private readonly notices: PoolNotices;

  constructor(
    private readonly prisma: PrismaService,
    private readonly logins: CodexLoginService,
    private readonly ledger: PoolLoginLedger,
    // @Global RealtimeModule: a notice's carrier wakes the runner's inbox poll.
    realtime: RealtimeService,
    @Inject(POOL_LOGIN_UPSTREAM) private readonly upstream: string,
    @Inject(POOL_LOGIN_TOKEN_ENDPOINT) private readonly tokenEndpoint: string,
  ) {
    this.notices = new PoolNotices(prisma, realtime);
  }

  async handle(req: Request, res: Response, token: string): Promise<void> {
    const started = Date.now();
    const target = gatewayTarget(req.originalUrl ?? req.url);
    const caller = await this.caller(token);
    if (!caller) {
      refuse(res, 401, 'orbit_gateway_token_invalid',
        'This Orbit session token is not valid any more — the session ended or moved, or the pool is gone');
      return;
    }
    if (!ALLOWED.some((allowed) => allowed.method === req.method && allowed.path === target.path)) {
      refuse(res, 403, 'orbit_gateway_path_not_allowed', `${req.method} ${target.path} is not something the Orbit pool gateway forwards`);
      return;
    }
    const login = caller.login;
    if (!login) {
      refuse(res, 403, 'orbit_pool_login_missing', loginMissingReason(caller.poolLabel));
      this.log.log(`session ${caller.sessionId} pool ${caller.poolId}: no account — refused`);
      return;
    }
    const account = maskedAccount(login.accountId);
    if (login.state !== 'ACTIVE') {
      // Every session it refuses is told, once, whichever of them saw it signed out first.
      await this.owe(caller.sessionId, loginSignedOutNotice(login, caller.poolLabel));
      refuse(res, 403, 'orbit_pool_login_signed_out', loginSignedOutNotice(login, caller.poolLabel));
      this.log.log(`session ${caller.sessionId} account ${account}: signed out — refused`);
      return;
    }
    let body: Buffer;
    try {
      body = await readBody(req);
    } catch {
      refuse(res, 413, 'orbit_gateway_request_too_large', 'The request is larger than the Orbit pool gateway forwards');
      return;
    }
    const now = new Date();
    let access = decryptSecret(login.accessTokenEnc);
    const url = `${this.upstream}${target.path}${target.query}`;
    const send = (credential: string) =>
      sendUpstream(this.agent, req.method, url, loginForwardedHeaders(req.headers, credential, login.accountId, body.length), body, res);
    let answer: Answer;
    try {
      // Refreshed ahead of its own expiry, as the codex CLI does. A token endpoint that cannot be reached
      // just then is no reason to refuse a token that has minutes left: it is sent on as it is.
      if (login.expiresAt.getTime() - now.getTime() <= ACCESS_TOKEN_REFRESH_WINDOW_MS) {
        const refreshed = await this.refresh(caller.poolId, login.accountId, access);
        if (refreshed.kind === 'OK') {
          access = refreshed.accessToken;
        } else if (refreshed.kind !== 'UNREACHABLE' || login.expiresAt.getTime() <= now.getTime()) {
          await this.refreshFailed(res, caller, login, refreshed);
          return;
        }
      }
      answer = await send(access);
      if (answer.response.statusCode === 401) {
        // The codex CLI's recovery: refresh, and send once more on what comes back.
        const refreshed = await this.refresh(caller.poolId, login.accountId, access);
        if (refreshed.kind !== 'OK') {
          await this.refreshFailed(res, caller, login, refreshed);
          return;
        }
        answer = await send(refreshed.accessToken);
        if (answer.response.statusCode === 401) {
          // Refused again on a token just issued: it is the login itself that is refused.
          const said = (parseJson(answer.body ?? Buffer.alloc(0)) as { error?: { message?: unknown } } | undefined)?.error?.message;
          await this.signedOut(res, caller, login, typeof said === 'string' && said ? said : 'OpenAI refused the login');
          return;
        }
      }
    } catch (e) {
      if (!res.headersSent) {
        refuse(res, 502, 'orbit_gateway_upstream_unreachable', `The Orbit pool gateway could not reach OpenAI: ${(e as Error).message}`);
      }
      this.log.warn(`session ${caller.sessionId} account ${account}: OpenAI unreachable: ${(e as Error).message}`);
      return;
    }
    const status = answer.response.statusCode ?? 502;
    const reading = codexUsageSnapshot(answer.response.headers, now);
    if (reading) this.ledger.recordReading(caller.poolId, login.accountId, reading, now);
    if (answer.body) {
      const outcome: ResponsesOutcome = {};
      const parsed = parseJson(answer.body);
      readResponsesEvent(parsed, outcome);
      if (status === 429 && outcome.errorCode && SPENT.has(outcome.errorCode)) {
        // Recorded before the answer goes back, so the retry the failed turn arms waits for this reset.
        const resetAt = usageLimitResetAt(parsed, answer.response.headers, now);
        await this.spent(caller, login, resetAt, reading, now);
      }
      this.record(caller, login, outcome, now);
      relayHead(res, answer.response);
      res.end(answer.body);
      this.log.log(`session ${caller.sessionId} account ${account}: ${req.method} ${target.path} → ${status} in ${Date.now() - started}ms`);
      return;
    }
    await relayStream(answer.response, res, (outcome, complete) => {
      if (outcome.errorCode && SPENT.has(outcome.errorCode)) {
        // Said inside a stream that had already begun: recorded all the same, off the stream's path.
        void this.spent(caller, login, usageLimitResetAt(undefined, answer.response.headers, now), reading, now).catch((e) =>
          this.log.warn(`could not record ${account} as spent: ${(e as Error).message}`),
        );
      } else if (complete && login.spentUntil && status < 300) {
        // The backend took it: the limit has reset.
        void this.logins.clearSpent(caller.poolId, login.accountId).catch((e) =>
          this.log.warn(`could not clear ${account}'s spent mark: ${(e as Error).message}`),
        );
      }
      this.record(caller, login, outcome, now);
    });
    this.log.log(`session ${caller.sessionId} account ${account}: ${req.method} ${target.path} → ${status} in ${Date.now() - started}ms`);
  }

  /**
   * The token's (pool, owner, session) and the login the session's account holds, when the token may
   * still be used; null otherwise. The token names no account, so no account's leaving the pool refuses
   * it here: a session whose account the pool no longer holds — or which has none — comes back with a
   * null login, which the caller answers as the pool having no account.
   */
  private async caller(token: string): Promise<Caller | null> {
    const row = await this.prisma.poolLoginToken.findUnique({
      where: { tokenHash: sha256(token) },
      select: {
        poolId: true,
        userId: true,
        sessionId: true,
        expiresAt: true,
        revokedAt: true,
        pool: {
          select: {
            slug: true, label: true, shared: true, engine: true,
            logins: { orderBy: [{ createdAt: 'asc' }, { accountId: 'asc' }], select: LOGIN_SELECT },
          },
        },
        session: {
          select: { status: true, ownerId: true, provider: true, poolCodexAccountId: true, completedAt: true, deletedAt: true },
        },
      },
    });
    if (!row || row.revokedAt || row.expiresAt.getTime() <= Date.now()) return null;
    const { pool, session } = row;
    const current =
      !pool.shared &&
      pool.engine === AgentProvider.CODEX &&
      OPEN_SESSION_STATUSES.includes(session.status) &&
      !session.completedAt &&
      !session.deletedAt &&
      // Nobody's session but the pool's owner's: the token's person is the owner (its foreign key), and
      // the session has to be theirs too.
      session.ownerId === row.userId &&
      // A session moved onto another provider since: its old tokens name a pool it no longer runs on.
      session.provider === pool.slug;
    if (!current) return null;
    // The account the session is on, if the pool still holds it: the token that got here may have been
    // minted on another, before the session moved (migration 0355). None when the session names an
    // account the pool has since lost, and when it names none — the same answer either way.
    const login = session.poolCodexAccountId
      ? pool.logins.find((candidate) => candidate.accountId === session.poolCodexAccountId) ?? null
      : null;
    return { poolId: row.poolId, poolLabel: pool.label, userId: row.userId, sessionId: row.sessionId, login };
  }

  /** The usage limit is reached until `resetAt`: recorded on the account, and the session told why it waits. */
  private async spent(caller: Caller, login: GatewayLogin, resetAt: Date, reading: ReturnType<typeof codexUsageSnapshot>, now: Date) {
    await this.logins.markSpent(caller.poolId, login.accountId, resetAt, reading, now);
    await this.owe(caller.sessionId, loginSpentNotice(login, reading, resetAt));
    this.log.log(`session ${caller.sessionId} account ${maskedAccount(login.accountId)}: usage limit reached — waits until ${resetAt.toISOString()}`);
  }

  /** The login is refused for good: signed out, the session told, and the request answered with that. */
  private async signedOut(res: Response, caller: Caller, login: GatewayLogin, reason: string): Promise<void> {
    await this.logins.markSignedOut(caller.poolId, login.accountId, reason);
    await this.owe(caller.sessionId, loginSignedOutNotice(login, caller.poolLabel));
    refuse(res, 403, 'orbit_pool_login_signed_out', loginSignedOutNotice(login, caller.poolLabel));
    this.log.log(`session ${caller.sessionId} account ${maskedAccount(login.accountId)}: refused by OpenAI — signed out`);
  }

  private async refreshFailed(res: Response, caller: Caller, login: GatewayLogin, refreshed: Exclude<Refreshed, { kind: 'OK' }>) {
    if (refreshed.kind === 'REFUSED') {
      await this.signedOut(res, caller, login, refreshed.message);
    } else if (refreshed.kind === 'UNREACHABLE') {
      refuse(res, 502, 'orbit_gateway_upstream_unreachable', `The Orbit pool gateway could not refresh the ChatGPT login: ${refreshed.message}`);
      this.log.warn(`account ${maskedAccount(login.accountId)}: refresh failed: ${refreshed.message}`);
    } else {
      // Signed out or taken out of the pool while this request waited.
      refuse(res, 403, 'orbit_pool_login_signed_out', loginSignedOutNotice(login, caller.poolLabel));
    }
  }

  /** The line the session's transcript is owed; a failure to owe it never fails the request. */
  private async owe(sessionId: string, notice: string): Promise<void> {
    await this.notices.owe(sessionId, notice).catch((e) =>
      this.log.warn(`could not owe session ${sessionId} its pool notice: ${(e as Error).message}`),
    );
  }

  /** What the answer used, into the ledger for this session and account. */
  private record(caller: Caller, login: GatewayLogin, outcome: ResponsesOutcome, now: Date): void {
    if (!outcome.usage) return;
    this.ledger.record({
      poolId: caller.poolId,
      accountId: login.accountId,
      sessionId: caller.sessionId,
      inputTokens: outcome.usage.input_tokens ?? 0,
      cachedInputTokens: outcome.usage.input_tokens_details?.cached_tokens ?? 0,
      outputTokens: outcome.usage.output_tokens ?? 0,
      costMicros: responseCostMicros(outcome.model, outcome.serviceTier, outcome.usage),
      at: now,
    });
  }

  /** The account's refresh, shared by every request of this process that needs one while it runs. */
  private refresh(poolId: string, accountId: string, stale: string): Promise<Refreshed> {
    const key = `${poolId}|${accountId}`;
    const inFlight = this.refreshing.get(key);
    if (inFlight) return inFlight;
    const refresh = this.rotate(poolId, accountId, stale).finally(() => this.refreshing.delete(key));
    this.refreshing.set(key, refresh);
    return refresh;
  }

  /**
   * The one place a login's pair is rotated. Under the account row's lock, so two processes never spend
   * the same refresh token: whoever comes second finds an access token other than the one it was refused
   * on — the first one's refresh — and sends on that instead of refreshing again. The lock is held for the
   * token endpoint's answer (at most REFRESH_TIMEOUT_MS) and never while anything streams. Not retried:
   * a refresh token is good once, and sending it twice is what `refresh_token_reused` is.
   */
  private async rotate(poolId: string, accountId: string, stale: string): Promise<Refreshed> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const [row] = await tx.$queryRaw<Array<{ access_token_enc: string; refresh_token_enc: string; state: string }>>`
          SELECT "access_token_enc", "refresh_token_enc", "state" FROM "pool_codex_login"
           WHERE "pool_id" = ${poolId}::uuid AND "account_id" = ${accountId}
           FOR UPDATE`;
        if (!row || row.state !== 'ACTIVE') return { kind: 'GONE' } as const;
        const current = decryptSecret(row.access_token_enc);
        if (current !== stale) return { kind: 'OK', accessToken: current } as const;
        const refreshed = await this.postRefresh(decryptSecret(row.refresh_token_enc));
        if (refreshed.kind !== 'OK') return refreshed;
        const said = accountOf(refreshed.idToken ?? refreshed.accessToken);
        await tx.poolCodexLogin.update({
          where: { poolId_accountId: { poolId, accountId } },
          data: {
            accessTokenEnc: encryptSecret(refreshed.accessToken),
            ...(refreshed.refreshToken ? { refreshTokenEnc: encryptSecret(refreshed.refreshToken) } : {}),
            expiresAt: accountOf(refreshed.accessToken).expiresAt ?? new Date(Date.now() + ACCESS_TOKEN_FALLBACK_MS),
            ...(said.plan ? { plan: said.plan } : {}),
            ...(said.email ? { email: said.email } : {}),
          },
        });
        return { kind: 'OK', accessToken: refreshed.accessToken } as const;
      }, { maxWait: 10_000, timeout: REFRESH_TIMEOUT_MS + 5_000 });
    } catch {
      // A database error's own words may quote what it was writing — the new pair's ciphertext — so none
      // of them is repeated; the pair stored before stays, and the next request tries again.
      return { kind: 'UNREACHABLE', message: 'the refreshed login could not be stored' };
    }
  }

  /** The refresh itself, sent to the token endpoint as the codex CLI sends it. */
  private async postRefresh(
    refreshToken: string,
  ): Promise<{ kind: 'OK'; accessToken: string; refreshToken?: string; idToken?: string } | Exclude<Refreshed, { kind: 'OK' | 'GONE' }>> {
    const body = Buffer.from(refreshRequestBody(refreshToken));
    let response: IncomingMessage;
    let text: Buffer;
    try {
      response = await new Promise<IncomingMessage>((resolve, reject) => {
        const target = new URL(this.tokenEndpoint);
        const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
        const request = send(target, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json', 'content-length': String(body.length) },
          ...(target.protocol === 'https:' ? { agent: this.agent } : {}),
        }, resolve);
        request.on('error', reject);
        request.setTimeout(REFRESH_TIMEOUT_MS, () => request.destroy(new Error('the token endpoint went quiet')));
        request.end(body);
      });
      text = await readAll(response);
    } catch (e) {
      return { kind: 'UNREACHABLE', message: (e as Error).message };
    }
    const parsed = parseJson(text) as { access_token?: unknown; refresh_token?: unknown; id_token?: unknown } | undefined;
    const status = response.statusCode ?? 0;
    if (status >= 200 && status < 300 && typeof parsed?.access_token === 'string' && parsed.access_token) {
      return {
        kind: 'OK',
        accessToken: parsed.access_token,
        refreshToken: typeof parsed.refresh_token === 'string' && parsed.refresh_token ? parsed.refresh_token : undefined,
        idToken: typeof parsed.id_token === 'string' && parsed.id_token ? parsed.id_token : undefined,
      };
    }
    const refusal = refreshRefusal(status, parsed);
    return refusal.permanent
      ? { kind: 'REFUSED', message: refusal.message }
      : { kind: 'UNREACHABLE', message: refusal.message };
  }
}
