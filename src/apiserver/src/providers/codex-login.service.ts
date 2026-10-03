import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  type OnModuleDestroy,
} from '@nestjs/common';
import { AgentProvider, RunEventType, type PlanUsageSnapshot } from '@orbit/shared';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import {
  CodexAuthError,
  codexDeviceChallenge,
  codexLoginView,
  maskedAccount,
  parseCodexAuthJson,
  type CodexLoginTokens,
  type CodexLoginView,
  type DeviceChallenge,
} from './codex-login';
import { encryptSecret } from './provider-crypto';

/**
 * The server side of "sign in with ChatGPT" for a personal codex pool (migration 0323): the owner starts
 * a device-code login, the OFFICIAL codex CLI runs it here, the owner approves in their browser, and the
 * credential the CLI leaves behind is encrypted into `pool_codex_login` — one row per account, as many
 * accounts as the owner signs in. The pool's own doors are ProvidersService; this is the flow.
 *
 * THE CLI RUNS HERE, IN A THROWAWAY CODEX_HOME
 * ============================================
 * `codex login --device-auth` is spawned with CODEX_HOME pointing at a directory made for this one
 * attempt, which is what makes it a NEW login: no pre-existing `auth.json` is on that path to be copied
 * or reused, and nothing of the operator's own CODEX_HOME is read or written. The credential exists as a
 * file only while the CLI holds it; this service reads it the moment the CLI stops, parses out the four
 * values it needs, deletes the directory, and keeps the tokens in memory only until the next poll stores
 * them (encrypted, provider-crypto). No refresh is ever done here — the pool gateway is the one place the
 * pair is rotated (P3-b), which is why nothing else in this process ever writes those columns.
 *
 * THE STATE MACHINE
 * =================
 * One attempt per pool, in this process: it owns a child process, and a child process belongs to the
 * process that spawned it, so an attempt cannot be handed to another replica — a poll that lands
 * elsewhere sees no attempt at all (NONE) and the page starts the flow again.
 *
 *   (none) ──POST──▶ PENDING ──(CLI prints the page and code)──▶ PENDING (challenge readable)
 *                       │  │
 *                       │  ├─(DELETE)──────────────▶ CANCELLED   child killed, directory gone
 *                       │  ├─(15 minutes pass)─────▶ EXPIRED     child killed, directory gone
 *                       │  └─(CLI stops, no login)─▶ FAILED      with the exit code, never its output
 *                       │
 *                       └─(owner approves; CLI writes auth.json and stops)─▶ CONFIRMED
 *                                                                              │
 *                                            poll stores it encrypted ─────────┘
 *                                                    │
 *        ┌───────────────────────────────────────────┴────────────────────────────────┐
 *        │  ACTIVE  ──(upstream 401 through the gateway: markSignedOut)──▶  SIGNED_OUT │
 *        │     ▲                                                                  │    │
 *        │     └─── its contributor signs in again (only they can, since 0371) ──┘    │
 *        └──────────────────────────────────────────────────────────────────────────────┘
 *
 * The row's own two states are ACTIVE and SIGNED_OUT, and only the credential's fate moves them. A quota
 * that could not be read is neither: `usage` is null on the view and the account runs on.
 *
 * SECURITY
 * ========
 *   * The tokens are written, decrypted and rotated in this one process and this one table. They are not
 *     logged, not put in a claim payload, not returned by any route: a response carries the account's
 *     email and `…AB12`, and a refusal carries neither the tokens nor the ciphertext.
 *   * The CLI is spawned with a small, named environment (see loginEnv) so this server's own secrets —
 *     PROVIDER_SECRET_KEY above all — are not inherited by it.
 *   * A pool is reached by its people: every method here resolves the caller's place in it (migration
 *     0371; the owner alone before it) and a pool the caller is not one of the people of answers 404,
 *     exactly as one that does not exist. A member may sign an account in while the pool's rule for it is
 *     on (an admin always may), and an account already in the pool is its contributor's to sign in again,
 *     to take out — with the pool's admins — and nobody else's.
 */

/** How long an attempt may live by default: the CLI's own words are "expires in 15 minutes" for the code
 *  it prints. CODEX_LOGIN_TTL_MS overrides it, which is how a spec drives the deadline without waiting a
 *  quarter of an hour for it. */
export const CODEX_LOGIN_TTL_MS = 15 * 60 * 1000;

const codexLoginTtlMs = () => {
  const set = Number(process.env.CODEX_LOGIN_TTL_MS);
  return Number.isFinite(set) && set > 0 ? set : CODEX_LOGIN_TTL_MS;
};

/**
 * How long `start` waits for the CLI to print the page and the code before giving up on it. The CLI
 * prints them at once — this is the whole of what the person needs to be handed back — so the wait is
 * short on purpose: an answer with no code in it is not one the page can do anything with.
 */
const CHALLENGE_TIMEOUT_MS = 10_000;

/** How much of the CLI's output this keeps. It is the banner and the code; nothing else is ever read. */
const OUTPUT_CAP = 16 * 1024;

/** What `start` answers with: the page to open, the code to type there, and when the code dies. Both
 *  halves are always here — an attempt that never printed them is refused at the start, not answered
 *  with nulls — while a poll of one still waiting may repeat them or not have them yet. */
export interface CodexLoginAttemptView {
  status: 'PENDING';
  verificationUrl: string;
  userCode: string;
  expiresAt: string;
}

/** What a poll answers: the attempt's state, and the accounts the pool holds (before and after). */
export interface CodexLoginPollView {
  status: 'PENDING' | 'CONFIRMED' | 'EXPIRED' | 'CANCELLED' | 'FAILED' | 'NONE';
  verificationUrl?: string | null;
  userCode?: string | null;
  expiresAt?: string;
  /** The pool's first account, whenever it has one — the pool's `login`. CONFIRMED names the account
   *  that sign-in stored instead. */
  account: CodexLoginView | null;
  /** Every account the pool holds, oldest first — the pool's `logins`. */
  logins: CodexLoginView[];
  /** Why it failed, in this server's words — the CLI's own output is never repeated. */
  error?: string;
}

interface Attempt {
  poolId: string;
  userId: string;
  dir: string | null;
  child: ChildProcess | null;
  output: string;
  challenge: DeviceChallenge | null;
  status: 'PENDING' | 'CONFIRMED' | 'EXPIRED' | 'CANCELLED' | 'FAILED';
  error: string | null;
  /** Read off the CLI's auth.json once it stopped; held only until the poll that stores it. */
  tokens: CodexLoginTokens | null;
  expiresAt: number;
  timer: NodeJS.Timeout | null;
}

/** The codex CLI this server signs in with. Named by CODEX_LOGIN_BIN so a deployment can pin a path. */
const codexBin = () => process.env.CODEX_LOGIN_BIN?.trim() || 'codex';

/**
 * The environment the CLI is given: its own CODEX_HOME, and only what it needs to run and reach the
 * network. Named rather than inherited wholesale, because a CLI is not a reader of this server's secrets
 * — the master key that decrypts every pool credential is in this process's environment, and it is not
 * going into a child's.
 */
function loginEnv(dir: string): NodeJS.ProcessEnv {
  const keep = [
    'PATH',
    'HOME',
    'TMPDIR',
    'LANG',
    'LC_ALL',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'http_proxy',
    'https_proxy',
    'no_proxy',
    'NODE_EXTRA_CA_CERTS',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
  ];
  const env: NodeJS.ProcessEnv = { CODEX_HOME: dir };
  for (const key of keep) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  return env;
}

@Injectable()
export class CodexLoginService implements OnModuleDestroy {
  /** The attempts this process is running, by pool: one at a time, and only ever here. */
  private readonly attempts = new Map<string, Attempt>();

  constructor(
    private readonly prisma: PrismaService,
    // @Global RealtimeModule: the pool's account is on its owner's pool page and picker.
    private readonly realtime: RealtimeService,
  ) {}

  /** Nothing outlives the process: a sign-in still waiting is killed and its directory removed. */
  onModuleDestroy(): void {
    for (const attempt of this.attempts.values()) void this.abandon(attempt, 'CANCELLED', null);
    this.attempts.clear();
  }

  /**
   * Start a device-code login for a codex pool the caller is one of the people of, whatever accounts it
   * already holds: the one this signs in joins them (`store`), credited to this caller. A second start by
   * the same person takes the place of their first: one attempt per person per pool, so the child process,
   * the directory and the code that is out there all belong to one flow — another person's attempt on the
   * same pool is theirs and is not touched.
   */
  async start(userId: string, poolId: string): Promise<CodexLoginAttemptView> {
    const pool = await this.poolOf(userId, poolId);
    this.assertMayAddAccount(pool);
    const key = this.attemptKey(pool.id, userId);
    const previous = this.attempts.get(key);
    if (previous) await this.abandon(previous, 'CANCELLED', null);

    const dir = await mkdtemp(join(tmpdir(), 'orbit-codex-login-'));
    const attempt: Attempt = {
      poolId: pool.id,
      userId,
      dir,
      child: null,
      output: '',
      challenge: null,
      status: 'PENDING',
      error: null,
      tokens: null,
      expiresAt: Date.now() + codexLoginTtlMs(),
      timer: null,
    };
    this.attempts.set(key, attempt);
    attempt.timer = setTimeout(() => {
      void this.expire(attempt);
    }, codexLoginTtlMs());
    // The deadline is this pool's business, not the process's: an idle server must still exit.
    attempt.timer.unref();

    const child = spawn(codexBin(), ['login', '--device-auth'], {
      cwd: dir,
      env: loginEnv(dir),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    attempt.child = child;
    for (const stream of [child.stdout, child.stderr]) {
      stream?.on('data', (chunk: Buffer) => {
        if (attempt.output.length >= OUTPUT_CAP) return;
        attempt.output += chunk.toString('utf8').slice(0, OUTPUT_CAP - attempt.output.length);
        attempt.challenge = codexDeviceChallenge(attempt.output) ?? attempt.challenge;
      });
    }
    child.on('error', () => {
      void this.abandon(attempt, 'FAILED', `the codex CLI (${codexBin()}) could not be started on this server`);
    });
    child.on('exit', (code) => {
      void this.settle(attempt, code);
    });

    // The code is the point of this call: wait for the CLI to print it, and give the attempt up rather
    // than answer with half of what the page needs. A CLI that died first is answered with why.
    const challenge = await this.awaitChallenge(attempt);
    if (!challenge) {
      await this.abandon(attempt, 'FAILED', attempt.error ?? 'the codex CLI offered no device code');
      this.attempts.delete(key);
      throw new ServiceUnavailableException({
        code: 'CODEX_LOGIN_NO_CHALLENGE',
        message: attempt.error ?? 'the codex CLI offered no device code',
      });
    }
    return {
      status: 'PENDING',
      verificationUrl: challenge.verificationUrl,
      userCode: challenge.userCode,
      expiresAt: new Date(attempt.expiresAt).toISOString(),
    };
  }

  /** The challenge as soon as the CLI has printed it, or null once the attempt is no longer waiting on
   *  the person — a CLI that died, or one that printed nothing this server could read in time. */
  private async awaitChallenge(attempt: Attempt): Promise<DeviceChallenge | null> {
    const deadline = Date.now() + CHALLENGE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (attempt.challenge) return attempt.challenge;
      if (attempt.status !== 'PENDING') return null;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return attempt.challenge;
  }

  /**
   * Where the caller's own login stands. The first poll after they approved is the one that stores the
   * account — encrypted, and only then does anything of it reach the database, credited to them. Another
   * account than those the pool holds is one more row; a second sign-in of an account the pool already
   * runs on is refused here with the same 409 a second add of a key gets; the same account after a
   * SIGNED_OUT is not a second one for the person who signed it in: it is their re-login, and it takes the
   * row over.
   */
  async poll(userId: string, poolId: string): Promise<CodexLoginPollView> {
    const pool = await this.poolOf(userId, poolId);
    this.assertMayAddAccount(pool);
    const attempt = this.attempts.get(this.attemptKey(pool.id, userId));
    if (!attempt) return { status: 'NONE', ...(await this.accounts(pool.id)) };

    if (attempt.status === 'PENDING') {
      return {
        status: 'PENDING',
        verificationUrl: attempt.challenge?.verificationUrl ?? null,
        userCode: attempt.challenge?.userCode ?? null,
        expiresAt: new Date(attempt.expiresAt).toISOString(),
        ...(await this.accounts(pool.id)),
      };
    }
    if (attempt.status === 'CONFIRMED') {
      try {
        const stored = await this.store(pool, attempt);
        this.attempts.delete(this.attemptKey(attempt.poolId, attempt.userId));
        await this.publishPool(poolId);
        return { status: 'CONFIRMED', ...stored };
      } catch (e) {
        // A refused login is over, whichever way it was refused: the tokens it was holding go with the
        // attempt — nothing of them is kept for a retry — and the answer is the refusal itself.
        this.attempts.delete(this.attemptKey(attempt.poolId, attempt.userId));
        await this.release(attempt);
        attempt.tokens = null;
        throw e;
      }
    }
    const { status, error } = attempt;
    this.attempts.delete(this.attemptKey(pool.id, userId));
    return { status, error: error ?? undefined, ...(await this.accounts(pool.id)) };
  }

  /**
   * Give up on the caller's own attempt in flight: the child is killed, its directory removed, and nothing
   * of it is stored. A caller with nothing in flight answers NONE rather than claiming to have cancelled
   * something — another person's attempt on the same pool is not theirs to give up.
   */
  async cancel(userId: string, poolId: string): Promise<CodexLoginPollView> {
    const pool = await this.poolOf(userId, poolId);
    this.assertMayAddAccount(pool);
    const key = this.attemptKey(pool.id, userId);
    const attempt = this.attempts.get(key);
    if (!attempt) return { status: 'NONE', ...(await this.accounts(pool.id)) };
    // Killed and cleaned up BEFORE this answers: once it says CANCELLED, the child is gone and so is the
    // directory it was writing in.
    await this.abandon(attempt, 'CANCELLED', null);
    this.attempts.delete(key);
    return { status: 'CANCELLED', ...(await this.accounts(pool.id)) };
  }

  /**
   * One account out of the pool: its row goes, and with it the only copy this server holds of its tokens.
   * The person who signed it in may take it out at any time — nobody else has that account's credential —
   * and so may any of the pool's admins, who own the pool's contents. The pool's session tokens are not
   * touched — none of them names an account since migration 0355 — so a session that was running on it
   * keeps its token and is answered by the gateway as a pool holding no account, until a claim moves it.
   * The account is named by its fingerprint, `…AB12`, as every response names it; with none, it is the
   * pool's first — its `login`, the account a page that names one shows. Every other account the pool
   * holds stays as it is, and so does a sign-in in flight: it is no account until it is stored. What a
   * session does next is the claim's business, as for a pool deleted under it. An account the pool does
   * not hold answers { removed: 0 }; a fingerprint two of its accounts share is refused rather than read
   * as either.
   */
  async signOut(userId: string, poolId: string, fingerprint?: string) {
    const pool = await this.poolOf(userId, poolId);
    const rows = await this.prisma.poolCodexLogin.findMany({
      where: { poolId: pool.id },
      orderBy: [{ createdAt: 'asc' }, { accountId: 'asc' }],
      select: { accountId: true, userId: true },
    });
    const named =
      fingerprint === undefined ? rows.slice(0, 1) : rows.filter((row) => maskedAccount(row.accountId) === fingerprint);
    if (named.length > 1) {
      throw new ConflictException({
        code: 'POOL_CODEX_ACCOUNT_AMBIGUOUS',
        message: `"${pool.label}" holds more than one ChatGPT account named ${fingerprint}`,
      });
    }
    if (!named.length) return { removed: 0 };
    // A member's own account, or anything at all for an admin of the pool.
    if (named[0].userId !== userId && pool.role !== 'ADMIN') {
      throw new ForbiddenException(
        'Only the person who signed this ChatGPT account in, or the pool\'s admins, can take it out',
      );
    }
    const { count } = await this.prisma.poolCodexLogin.deleteMany({
      where: { poolId: pool.id, accountId: named[0].accountId },
    });
    if (count > 0) await this.publishPool(poolId);
    return { removed: count };
  }

  /**
   * The upstream refused this account (a 401 through the pool gateway): it is SIGNED_OUT until its owner
   * signs in again, and no claim may run on it — the pool's other accounts are not touched. `reason` is
   * the upstream's own words, kept so the page can say them. Only an ACTIVE account moves, so a second
   * refusal — or one racing the owner's re-login — changes nothing; true when it moved. The pool
   * gateway's to call (P3-b); no route reaches it.
   */
  async markSignedOut(poolId: string, accountId: string, reason: string): Promise<boolean> {
    const { count } = await this.prisma.poolCodexLogin.updateMany({
      where: { poolId, accountId, state: 'ACTIVE' },
      data: { state: 'SIGNED_OUT', lastError: reason },
    });
    if (count > 0) await this.publishPool(poolId);
    return count > 0;
  }

  /**
   * `publish`, for a write that knows the pool and not whose sessions it decides: every person of the
   * pool re-reads their providers. Its ChatGPT accounts run the sessions of everyone in it
   * (pool-credential-select.ts, 2026-10-03), so an account's state — signed out, spent, reset — is on the
   * people the owner added's pickers as much as on the owner's. Every Codex pool has its owner's person
   * row (migration 0358), so the owner is reached like the rest.
   */
  private async publishPool(poolId: string): Promise<void> {
    await this.publish(poolId, await this.peopleOf(poolId));
  }

  /** The people of the pool, its owner included (migration 0358's row). */
  private async peopleOf(poolId: string): Promise<string[]> {
    const people = await this.prisma.providerPoolPerson.findMany({ where: { poolId }, select: { userId: true } });
    return people.map((person) => person.userId);
  }

  /**
   * The Codex backend said this account's usage limit is reached, until `until` (the pool gateway, P3-b,
   * off a 429 `usage_limit_reached`): recorded — with the window reading that came with it — so the
   * session's retry waits for that reset, or goes to another account that can run
   * (QueueService.loginPoolRetryAt), and the page can say when. No session is moved here: the claim that
   * next runs it moves it (QueueService.resolveLoginPool). No route reaches it.
   */
  async markSpent(poolId: string, accountId: string, until: Date, usage: PlanUsageSnapshot | null, at: Date): Promise<void> {
    const { count } = await this.prisma.poolCodexLogin.updateMany({
      where: { poolId, accountId },
      data: {
        spentUntil: until,
        ...(usage ? { usage: usage as unknown as Prisma.InputJsonValue, usageReadAt: at } : {}),
      },
    });
    if (count > 0) await this.publishPool(poolId);
  }

  /** The backend took a request on an account marked spent: its limit has reset. The pool gateway's. */
  async clearSpent(poolId: string, accountId: string): Promise<void> {
    const { count } = await this.prisma.poolCodexLogin.updateMany({
      where: { poolId, accountId, spentUntil: { not: null } },
      data: { spentUntil: null },
    });
    if (count > 0) await this.publishPool(poolId);
  }

  /** Each pool's accounts as a response reads them, by pool id, oldest first — the order a pool's `login`
   *  is the first of (ProvidersService). */
  async views(poolIds: string[]): Promise<Map<string, CodexLoginView[]>> {
    const views = new Map<string, CodexLoginView[]>();
    if (!poolIds.length) return views;
    const rows = await this.prisma.poolCodexLogin.findMany({
      where: { poolId: { in: poolIds } },
      orderBy: [{ createdAt: 'asc' }, { accountId: 'asc' }],
    });
    for (const poolId of poolIds) {
      const held = rows.filter((candidate) => candidate.poolId === poolId);
      // The last window reading the gateway took off the backend's own answers (migration 0324).
      views.set(poolId, held.map((row) => codexLoginView(row, row.usage as PlanUsageSnapshot | null)!));
    }
    return views;
  }

  /** The accounts one pool holds, as an answer carries them: all of them, and the first or null. */
  private async accounts(poolId: string): Promise<Pick<CodexLoginPollView, 'account' | 'logins'>> {
    const logins = (await this.views([poolId])).get(poolId) ?? [];
    return { account: logins[0] ?? null, logins };
  }

  /**
   * The pool this caller may sign a ChatGPT account in on: a Codex pool they are one of the people of —
   * one of their own (migration 0358's ADMIN row) or one somebody else made and added them to (migration
   * 0371) — of either kind, a shared pool included. Anything else is not found: another's pool they are
   * not in, and a Claude pool, are answered exactly as one that does not exist.
   */
  private async poolOf(userId: string, poolId: string) {
    const place = await this.prisma.providerPoolPerson.findUnique({
      where: { poolId_userId: { poolId, userId } },
      select: {
        role: true,
        pool: { select: { id: true, label: true, engine: true, membersCanAddAccounts: true } },
      },
    });
    if (!place || place.pool.engine !== AgentProvider.CODEX) throw new NotFoundException('pool not found');
    return {
      id: place.pool.id,
      label: place.pool.label,
      role: place.role,
      membersCanAddAccounts: place.pool.membersCanAddAccounts,
    };
  }

  /** Whether this person may sign another account of their own into the pool: any of its admins may, and
   *  a member while the pool's rule for it is on (migration 0371). */
  private assertMayAddAccount(pool: { role: string; membersCanAddAccounts: boolean }): void {
    if (pool.role === 'ADMIN' || pool.membersCanAddAccounts) return;
    throw new ForbiddenException("Only the pool's admins can add ChatGPT accounts to it");
  }

  /**
   * The key an attempt is kept under: one per person per pool. Two people signing into one pool are two
   * flows — two CLI children, two directories, two codes — and neither may take the other's place, cancel
   * it, or read its outcome; before migration 0371 the owner was the only person who could start one.
   */
  private attemptKey(poolId: string, userId: string): string {
    return `${poolId}:${userId}`;
  }

  /**
   * The CLI has stopped: read what it left, if anything. The FILE decides, not the exit code — the codex
   * CLI's status is not a reliable word on the login, and a login that happened while the process was
   * killed late is still a login. Its output is never read for this and never repeated anywhere.
   */
  private async settle(attempt: Attempt, code: number | null): Promise<void> {
    if (attempt.status !== 'PENDING' || !attempt.dir) return;
    if (attempt.timer) clearTimeout(attempt.timer);
    attempt.timer = null;
    const raw = await readFile(join(attempt.dir, 'auth.json'), 'utf8').catch(() => null);
    let status: 'CONFIRMED' | 'FAILED' = 'FAILED';
    let tokens: CodexLoginTokens | null = null;
    let error: string | null = null;
    if (raw !== null) {
      try {
        tokens = parseCodexAuthJson(raw);
        status = 'CONFIRMED';
      } catch (e) {
        error = e instanceof CodexAuthError ? e.message : 'the codex CLI left a login this server cannot read';
      }
    } else if (code === 0) {
      error = 'the codex CLI finished without a login';
    } else {
      error = `the codex CLI gave up (exit ${code ?? 'signal'})`;
    }
    // The credential file goes first — the moment it has been read, nothing of it is on disk — and only
    // then is the status set: a poll that reads CONFIRMED is one whose directory is already gone, and
    // whose tokens are the ones read here.
    await this.release(attempt);
    attempt.tokens = tokens;
    attempt.error = error;
    attempt.status = status;
  }

  /**
   * Give an attempt up: kill the child, remove the directory it was writing in, and only then take the
   * status — so that whatever a caller reads the status from (a poll, a cancel's answer) is reading one
   * whose process and files are already gone. The tokens it may have read go too: this is the ending for
   * every attempt that is NOT being stored.
   */
  private async abandon(attempt: Attempt, status: 'CANCELLED' | 'EXPIRED' | 'FAILED', error: string | null) {
    await this.release(attempt);
    attempt.tokens = null;
    attempt.error = error;
    attempt.status = status;
  }

  /** The deadline: an attempt nobody finished is given up, and told so only once it is over. */
  private async expire(attempt: Attempt): Promise<void> {
    // A sign-in the CLI already finished is not this: its tokens are the poll's to store.
    if (attempt.status !== 'PENDING') return;
    await this.abandon(attempt, 'EXPIRED', null);
  }

  /**
   * Kill the child and forget the directory. What was READ out of it is the caller's to keep or drop: a
   * finished sign-in's tokens outlive this call until the poll that stores them (see `store`), and every
   * other ending drops them through `abandon`. Safe to call more than once.
   */
  private async release(attempt: Attempt): Promise<void> {
    if (attempt.timer) clearTimeout(attempt.timer);
    attempt.timer = null;
    attempt.child?.kill('SIGKILL');
    attempt.child = null;
    attempt.output = '';
    attempt.challenge = null;
    const dir = attempt.dir;
    attempt.dir = null;
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }

  /**
   * The account the attempt signed in, encrypted into the pool — a row of its own beside every other
   * account the pool holds — or the 409 that says the pool already runs on it. The same account SIGNED_OUT
   * is the owner's sign-in again: its row is taken over. Answers with that account, and all of the pool's.
   */
  private async store(
    pool: { id: string; label: string },
    attempt: Attempt,
  ): Promise<Pick<CodexLoginPollView, 'account' | 'logins'>> {
    const tokens = attempt.tokens;
    if (!tokens) throw new Error('a confirmed attempt with no tokens');
    const rows = await this.prisma.poolCodexLogin.findMany({
      where: { poolId: pool.id },
      select: { accountId: true, state: true, userId: true },
    });
    const held = rows.find((row) => row.accountId === tokens.accountId);
    // Already in the pool — running, or signed out under the person who signed it in. A signed-out row is
    // only its own contributor's to put back: the row is theirs (a login belongs to a person of the pool,
    // migration 0371), it leaves the pool with their membership, and signing back in is what only they can
    // do. Somebody else's sign-in of that same account is refused as the duplicate it is.
    if (held && (held.state === 'ACTIVE' || held.userId !== attempt.userId)) {
      throw new ConflictException({
        code: 'POOL_CODEX_ACCOUNT_DUPLICATE',
        message: `This ChatGPT account is already in "${pool.label}"`,
        // Which account this sign-in turned out to be: the page names it in the refusal it shows.
        email: tokens.email,
      });
    }
    const data = {
      accessTokenEnc: encryptSecret(tokens.accessToken),
      refreshTokenEnc: encryptSecret(tokens.refreshToken),
      email: tokens.email,
      plan: tokens.plan,
      expiresAt: tokens.expiresAt,
      state: 'ACTIVE',
      lastError: null,
    };
    const row = await this.prisma.poolCodexLogin.upsert({
      where: { poolId_accountId: { poolId: pool.id, accountId: tokens.accountId } },
      create: { poolId: pool.id, userId: attempt.userId, accountId: tokens.accountId, ...data },
      update: data,
    });
    attempt.tokens = null;
    return {
      ...(await this.accounts(pool.id)),
      account: codexLoginView(row, row.usage as PlanUsageSnapshot | null),
    };
  }

  private async publish(poolId: string, userIds: Iterable<string>): Promise<void> {
    for (const userId of new Set(userIds)) {
      this.realtime.publishForUser(userId, RunEventType.PROVIDER_CHANGED, poolId);
    }
  }
}
