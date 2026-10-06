import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AgentProvider, RunEventType, type PlanUsageSnapshot } from '@orbit/shared';
import { GENERATING_SESSION_FILTER } from '../common/session-generating';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import {
  AddPoolKeyDto,
  AddSharedPoolPersonDto,
  CreateSharedPoolDto,
  ReplacePoolKeyDto,
  UpdatePoolKeyDto,
  UpdateSharedPoolDto,
  UpdateSharedPoolPersonDto,
} from './dto';
import { codexLoginView, type CodexLoginView } from './codex-login';
import { choosePoolCredential } from './pool-credential-select';
import { encryptSecret } from './provider-crypto';
import { slugBase } from './provider-slug';
import { ProvidersService } from './providers.service';
import { maskedKey, nextUsageWindowStart, parsePoolApiKey, usageWindowStart } from './shared-pool';

export type PoolRole = 'ADMIN' | 'MEMBER';

/** A shared pool as its page reads it. */
const POOL_VIEW_SELECT = {
  id: true,
  slug: true,
  label: true,
  ownerId: true,
  engine: true,
  shared: true,
  membersCanAdd: true,
  ownKeyFirst: true,
  // Migration 0371: whether a member may sign a ChatGPT account of their own in beside the pool's keys.
  membersCanAddAccounts: true,
  createdAt: true,
  updatedAt: true,
  people: {
    orderBy: [{ createdAt: 'asc' }, { userId: 'asc' }],
    select: { userId: true, role: true, user: { select: { name: true } } },
  },
} satisfies Prisma.ProviderPoolSelect;

/** A key as the page reads it: its last four characters, and never its secret or its fingerprint. */
const KEY_VIEW_SELECT = {
  id: true,
  poolId: true,
  contributorId: true,
  label: true,
  keyHint: true,
  state: true,
  enabled: true,
  shareCap: true,
  spentUntil: true,
  throttledUntil: true,
  pausedUntil: true,
  createdAt: true,
} satisfies Prisma.PoolApiKeySelect;

/** A ChatGPT account of a pool of somebody's own as its page reads it — the same columns the owner's own
 *  page reads (ProvidersService.POOL_SELECT), and never either token. */
const LOGIN_VIEW_SELECT = {
  poolId: true,
  accountId: true,
  // Who signed it in (migration 0371): the person whose account a row is, and the one who may sign it in
  // again.
  userId: true,
  email: true,
  plan: true,
  state: true,
  lastError: true,
  expiresAt: true,
  createdAt: true,
  spentUntil: true,
  throttledUntil: true,
  pausedUntil: true,
  usage: true,
} satisfies Prisma.PoolCodexLoginSelect;

type PoolRow = Prisma.ProviderPoolGetPayload<{ select: typeof POOL_VIEW_SELECT }>;
type KeyRow = Prisma.PoolApiKeyGetPayload<{ select: typeof KEY_VIEW_SELECT }>;
type LoginRow = Prisma.PoolCodexLoginGetPayload<{ select: typeof LOGIN_VIEW_SELECT }>;
type UsageRow = Prisma.PoolUsageGetPayload<object>;

/** What some ledger rows add up to: tokens, and dollars (the ledger counts millionths of one). */
function spend(rows: UsageRow[]) {
  let input = 0n;
  let output = 0n;
  let cost = 0n;
  for (const row of rows) {
    input += row.inputTokens;
    output += row.outputTokens;
    cost += row.costMicros;
  }
  return { inputTokens: Number(input), outputTokens: Number(output), costUsd: Number(cost) / 1_000_000 };
}

/** What a pool's sessions are doing, read beside its rows: which keys a session is generating on right
 *  now, and how many sessions each person started on the pool this month. */
interface PoolActivity {
  running: ReadonlySet<string>;
  sessions: ReadonlyMap<string, number>;
}

/**
 * A pool as one of its people reads it: the rules, who is in it, how many sessions each started on it and
 * what each spent this month, and each key — whose it is, its label, `sk-…` and its last four characters,
 * where it stands, its cap, what it has run this month (of which `othersCostUsd` is what its cap limits),
 * whether a session is generating on it now, and whether it is the one a session the viewer starts now
 * would run on (`next`: the claim's own choice, choosePoolCredential, asked for a session with no
 * credential yet). No key's secret or fingerprint is selected to build this, so none can reach it.
 *
 * Of the ChatGPT accounts a pool of somebody's own holds (migration 0323) it says what its owner's own
 * page says (CodexLoginService): each one's email, plan, `…AB12`, state and quota, and which of them the
 * viewer's next session would run on. Since 2026-10-03 they run the sessions of everyone in the pool,
 * not its owner's alone (pool-credential-select.ts), so the people the owner added read them as the
 * owner does — signing one in or out is still the owner's alone, and nothing here offers it. A shared
 * pool (migration 0321) holds none.
 */
function poolView(
  pool: PoolRow,
  keys: KeyRow[],
  usage: UsageRow[],
  activity: PoolActivity,
  viewerId: string,
  now: Date,
  logins: LoginRow[],
) {
  const names = new Map(pool.people.map((person) => [person.userId, person.user.name]));
  const viewer = pool.people.find((person) => person.userId === viewerId);
  const othersOn = (key: KeyRow) =>
    usage.filter((row) => row.keyId === key.id && row.userId !== key.contributorId);
  // What a session starting now would run on, asked exactly as the claim asks it for a session that has
  // no credential yet: one of the pool's ChatGPT accounts while any can run, else a key. `chosen` is null
  // while nothing can run, which is what the page reads as "none of them" rather than a mark on one.
  const { chosen } = choosePoolCredential(
    {
      ownerId: pool.ownerId,
      accounts: logins.map((login) => ({ ...login, usage: login.usage as PlanUsageSnapshot | null })),
      keys: keys.map((key) => ({
        ...key,
        othersCostMicros: othersOn(key).reduce((sum, row) => sum + Number(row.costMicros), 0),
      })),
      ownKeyFirst: pool.ownKeyFirst,
    },
    { ownerId: viewerId, accountId: null, keyId: null },
    now,
  );
  return {
    id: pool.id,
    slug: pool.slug,
    label: pool.label,
    engine: pool.engine,
    shared: pool.shared,
    membersCanAdd: pool.membersCanAdd,
    ownKeyFirst: pool.ownKeyFirst,
    viewerRole: viewer?.role as PoolRole,
    // The pool's ChatGPT accounts (a pool of somebody's own; a shared pool holds none), as the owner's
    // page reads them and with which of them this viewer's next session would run on. Never a token.
    logins: logins.map((login) => ({
      ...codexLoginView(login, login.usage as PlanUsageSnapshot | null, now)!,
      next: chosen?.accountId === login.accountId,
    })),
    // The month a share cap and every usage figure below count, UTC.
    window: { start: usageWindowStart(now).toISOString(), end: nextUsageWindowStart(now).toISOString() },
    membersCanAddAccounts: pool.membersCanAddAccounts,
    people: pool.people.map((person) => ({
      userId: person.userId,
      name: person.user.name,
      role: person.role as PoolRole,
      // Who made the pool: always an admin, whom no one can remove or make a member.
      creator: person.userId === pool.ownerId,
      you: person.userId === viewerId,
      keys: keys.filter((key) => key.contributorId === person.userId).length,
      sessions: activity.sessions.get(person.userId) ?? 0,
      usage: spend(usage.filter((row) => row.userId === person.userId)),
    })),
    keys: keys.map((key) => {
      const onKey = usage.filter((row) => row.keyId === key.id);
      return {
        id: key.id,
        label: key.label,
        fingerprint: maskedKey(key.keyHint),
        state: key.state,
        enabled: key.enabled,
        pausedUntil: key.pausedUntil && key.pausedUntil > now ? key.pausedUntil.toISOString() : null,
        shareCap: key.shareCap,
        // Out of budget until then — OpenAI said so (the page's "Out of budget · resets …"); null when not.
        spentUntil: key.spentUntil && key.spentUntil > now ? key.spentUntil : null,
        contributor: {
          userId: key.contributorId,
          name: names.get(key.contributorId) ?? '',
          you: key.contributorId === viewerId,
        },
        usage: {
          ...spend(onKey),
          othersCostUsd: spend(othersOn(key)).costUsd,
        },
        running: activity.running.has(key.id),
        next: chosen?.keyId === key.id,
        createdAt: key.createdAt,
      };
    }),
    createdAt: pool.createdAt,
    updatedAt: pool.updatedAt,
  };
}

/** The refusal a second add of one key gets, naming who put it in — somebody the adder shares the pool with,
 *  or the adder themselves. `addedBy` says the same for a page to put in its own words. */
function duplicateKey(label: string, contributor: { name: string; you: boolean }) {
  return new ConflictException({
    code: 'POOL_KEY_DUPLICATE',
    message: `This key is already in "${label}" — ${contributor.name} put it in`,
    addedBy: contributor,
  });
}

/** The refusal an admin role gets on a pool of one's own: its owner is its only admin (migration 0358). */
function ownPoolOneAdmin() {
  return new ForbiddenException({
    code: 'POOL_OWN_ONE_ADMIN',
    message: 'A pool of your own has one admin, you — the people you add to it are members',
  });
}

/**
 * Shared Codex pools (migration 0321, docs/codex-shared-pool-design.md §2.5, "account" read as "key"):
 * the doors of the pool page. Every one of them first finds the caller among the pool's people, and a
 * pool they are not in is not found — the answer is the same whether it exists or not.
 *
 *   action                                   ADMIN        MEMBER                 not in it
 *   see it (and pick it, and run on it)      yes          yes                    not found
 *   put a key of one's own in                yes          while membersCanAdd    not found
 *   change a key's label, cap, switch        own keys     own keys               not found
 *   replace a key's secret                   any key      own keys               not found
 *   remove a key                             any key      own keys               not found
 *   rules, people and roles, delete pool     yes          no                     not found
 *   leave (one's keys go too)                no           yes                    not found
 *
 * The pool's creator is its `ownerId` and stays an admin: nobody can remove them or make them a member,
 * so a pool never runs out of admins. The claim side — who may dispatch with it, which key a session
 * runs on, and the session token — is QueueService.resolveSharedPool.
 *
 * The same doors serve a Codex pool of one person's own (migration 0358): the pool their ChatGPT accounts
 * are in (migration 0323), which they make on the providers page and whose accounts they sign in there
 * (ProvidersService, CodexLoginService). Its owner is among its people as its ADMIN, so the owner adds
 * people to it by the email of their Orbit account and adds and removes API keys here, under the table
 * above; taking every other person out is how it goes back to "Just me" — who can use a pool is its
 * people, never `shared` — and their keys and session tokens go with them. Its owner is its only admin:
 * the people they add are members, nobody else can be made one, and so nobody else can delete the pool
 * (its accounts with it) or change its rules. The people it takes run on its ChatGPT accounts first and on
 * its API keys when none can (pool-credential-select.ts, 2026-10-03) — the accounts are its owner's, and
 * signing one in or out stays theirs alone (CodexLoginService), but the sessions they run are everyone's
 * in the pool — so the read above hands them the accounts as they are (login rows), and no route here
 * offers to change one.
 */
@Injectable()
export class SharedPoolsService {
  constructor(
    private readonly prisma: PrismaService,
    // @Global RealtimeModule: a change reaches every person of the pool, whose pickers list it.
    private readonly realtime: RealtimeService,
    private readonly providers: ProvidersService,
  ) {}

  /** The Codex pools the caller runs on as one of their people: the shared pools they are in, and the pools
   *  of somebody else's own they were added to. A pool of their own is on their providers page
   *  (ProvidersService.listPools), and `get` reads its people and keys. */
  async list(userId: string) {
    const pools = await this.prisma.providerPool.findMany({
      where: {
        engine: AgentProvider.CODEX,
        people: { some: { userId } },
        OR: [{ shared: true }, { ownerId: { not: userId } }],
      },
      orderBy: { createdAt: 'asc' },
      select: POOL_VIEW_SELECT,
    });
    return this.views(pools, userId);
  }

  /** One shared pool, to one of its people. */
  async get(userId: string, poolId: string) {
    await this.place(userId, poolId);
    const pool = await this.prisma.providerPool.findUniqueOrThrow({ where: { id: poolId }, select: POOL_VIEW_SELECT });
    return (await this.views([pool], userId))[0];
  }

  /** A new shared pool on Codex, with the caller as its creator and first admin. */
  async create(userId: string, dto: CreateSharedPoolDto) {
    const pool = await this.providers.withFreeSlug(slugBase(dto.label), (slug) =>
      this.prisma.providerPool.create({
        data: {
          slug,
          label: dto.label,
          ownerId: userId,
          engine: AgentProvider.CODEX,
          shared: true,
          people: { create: { userId, role: 'ADMIN' } },
        },
        select: { id: true },
      }),
    );
    this.publish([userId], pool.id);
    return this.get(userId, pool.id);
  }

  /** An admin renames the pool or changes its rules. */
  async update(userId: string, poolId: string, dto: UpdateSharedPoolDto) {
    await this.adminOf(userId, poolId, 'change its rules');
    await this.prisma.providerPool.update({
      where: { id: poolId },
      data: {
        label: dto.label,
        membersCanAdd: dto.membersCanAdd,
        membersCanAddAccounts: dto.membersCanAddAccounts,
        ownKeyFirst: dto.ownKeyFirst,
      },
    });
    this.publish(await this.peopleOf(poolId), poolId);
    return this.get(userId, poolId);
  }

  /** An admin deletes the pool: its people, keys, ledger and session tokens go with it — and, from a pool of
   *  one's own, whose only admin is its owner, its ChatGPT accounts. */
  async remove(userId: string, poolId: string) {
    await this.adminOf(userId, poolId, 'delete it');
    const people = await this.peopleOf(poolId);
    await this.prisma.providerPool.delete({ where: { id: poolId } });
    this.publish(people, poolId);
    return { ok: true };
  }

  /** An admin adds a person by the email of their Orbit account. Adding someone already in changes nothing.
   *  On a pool of one's own, everybody added is a member: its owner is its only admin. */
  async addPerson(userId: string, poolId: string, dto: AddSharedPoolPersonDto) {
    const place = await this.adminOf(userId, poolId, 'add people to it');
    if (!place.pool.shared && dto.role !== undefined && dto.role !== 'MEMBER') throw ownPoolOneAdmin();
    const person = await this.prisma.user.findUnique({ where: { email: dto.email.trim() }, select: { id: true } });
    if (!person) throw new NotFoundException('No Orbit account has that email');
    await this.prisma.providerPoolPerson.createMany({
      data: [{ poolId, userId: person.id, role: dto.role ?? 'MEMBER' }],
      skipDuplicates: true,
    });
    this.publish(await this.peopleOf(poolId), poolId);
    return this.get(userId, poolId);
  }

  /** An admin makes a person an admin or a member — anyone but the pool's creator. Nobody but its owner is
   *  an admin of a pool of one's own. */
  async setRole(userId: string, poolId: string, personId: string, dto: UpdateSharedPoolPersonDto) {
    const place = await this.adminOf(userId, poolId, 'change who is an admin');
    if (personId === place.pool.ownerId && dto.role !== 'ADMIN') {
      throw new ForbiddenException('The person who made the pool stays one of its admins');
    }
    if (!place.pool.shared && personId !== place.pool.ownerId && dto.role !== 'MEMBER') throw ownPoolOneAdmin();
    const { count } = await this.prisma.providerPoolPerson.updateMany({
      where: { poolId, userId: personId },
      data: { role: dto.role },
    });
    if (count === 0) throw new NotFoundException('person not found');
    this.publish(await this.peopleOf(poolId), poolId);
    return this.get(userId, poolId);
  }

  /** An admin takes a person out, and their keys and session tokens with them — anyone but the creator
   *  and themselves (an admin leaves by being made a member first). */
  async removePerson(userId: string, poolId: string, personId: string) {
    const place = await this.adminOf(userId, poolId, 'remove people from it');
    if (personId === place.pool.ownerId) {
      throw new ForbiddenException('The person who made the pool stays in it — delete the pool instead');
    }
    if (personId === userId) {
      throw new ForbiddenException('An admin leaves by being made a member first');
    }
    const people = await this.peopleOf(poolId);
    const { count } = await this.prisma.providerPoolPerson.deleteMany({ where: { poolId, userId: personId } });
    if (count === 0) throw new NotFoundException('person not found');
    this.publish(people, poolId);
    return this.get(userId, poolId);
  }

  /** A member leaves the pool, and their keys and session tokens with them. An admin does not leave. */
  async leave(userId: string, poolId: string) {
    const place = await this.place(userId, poolId);
    if (place.role === 'ADMIN') {
      throw new ForbiddenException(
        "An admin can't leave the pool — another admin can make you a member first, or delete the pool",
      );
    }
    const people = await this.peopleOf(poolId);
    await this.prisma.providerPoolPerson.deleteMany({ where: { poolId, userId } });
    this.publish(people, poolId);
    return { ok: true };
  }

  /**
   * The caller puts a key of their own in: an admin always, a member while the pool lets members add.
   * The key is checked for its shape, turned away when it is in the pool already (by its fingerprint),
   * stored encrypted, and never repeated — not in the answer, not in a refusal, not in a log.
   */
  async addKey(userId: string, poolId: string, dto: AddPoolKeyDto) {
    const place = await this.place(userId, poolId);
    if (place.role !== 'ADMIN' && !place.pool.membersCanAdd) {
      throw new ForbiddenException("Only the pool's admins can put keys in it");
    }
    const key = parsePoolApiKey(dto.apiKey);
    await this.assertNotInPool(poolId, key.fingerprint, place.pool.label, userId);
    try {
      await this.prisma.poolApiKey.create({
        data: {
          poolId,
          contributorId: userId,
          label: dto.label,
          keyFingerprint: key.fingerprint,
          keyHint: key.hint,
          secretEncrypted: encryptSecret(key.secret),
          shareCap: dto.shareCap ?? null,
        },
      });
    } catch (e) {
      // Two adds of one key racing: the index decides, and the loser is answered as a duplicate.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        await this.assertNotInPool(poolId, key.fingerprint, place.pool.label, userId);
      }
      throw e;
    }
    this.publish(await this.peopleOf(poolId), poolId);
    return this.get(userId, poolId);
  }

  /** The contributor changes their key's label, its share cap (null removes it) or switches it off and on. */
  async updateKey(userId: string, poolId: string, keyId: string, dto: UpdatePoolKeyDto) {
    await this.place(userId, poolId);
    const key = await this.keyOf(poolId, keyId);
    if (key.contributorId !== userId) {
      throw new ForbiddenException('Only the person who put this key in can change it');
    }
    await this.prisma.poolApiKey.update({
      where: { id: keyId },
      data: {
        label: dto.label,
        enabled: dto.enabled,
        ...(dto.shareCap !== undefined ? { shareCap: dto.shareCap } : {}),
      },
    });
    this.publish(await this.peopleOf(poolId), poolId);
    return this.get(userId, poolId);
  }

  /**
   * A new secret for a key — what one OpenAI refused (INVALID) needs before any session runs on it again —
   * from its contributor or an admin. The key keeps its place, its contributor and its ledger; the new
   * secret is checked and stored like a new key's, and the key is ACTIVE again, with no out-of-budget mark:
   * that was OpenAI's word about the secret it replaces.
   */
  async replaceKey(userId: string, poolId: string, keyId: string, dto: ReplacePoolKeyDto) {
    const place = await this.place(userId, poolId);
    const key = await this.keyOf(poolId, keyId);
    if (key.contributorId !== userId && place.role !== 'ADMIN') {
      throw new ForbiddenException('Only the person who put this key in, or an admin, can replace it');
    }
    const next = parsePoolApiKey(dto.apiKey);
    if (next.fingerprint !== key.keyFingerprint) {
      await this.assertNotInPool(poolId, next.fingerprint, place.pool.label, userId);
    }
    await this.prisma.poolApiKey.update({
      where: { id: keyId },
      data: {
        keyFingerprint: next.fingerprint,
        keyHint: next.hint,
        secretEncrypted: encryptSecret(next.secret),
        state: 'ACTIVE',
        spentUntil: null,
      },
    });
    this.publish(await this.peopleOf(poolId), poolId);
    return this.get(userId, poolId);
  }

  /** A key taken out by its contributor or an admin; its ledger rows go with it. */
  async removeKey(userId: string, poolId: string, keyId: string) {
    const place = await this.place(userId, poolId);
    const key = await this.keyOf(poolId, keyId);
    if (key.contributorId !== userId && place.role !== 'ADMIN') {
      throw new ForbiddenException('Only the person who put this key in, or an admin, can remove it');
    }
    await this.prisma.poolApiKey.delete({ where: { id: keyId } });
    this.publish(await this.peopleOf(poolId), poolId);
    return this.get(userId, poolId);
  }

  /**
   * OpenAI answered 401 for this key: it is wrong or was revoked. Marked INVALID, it is chosen by no claim
   * until its contributor or an admin replaces it (replaceKey). Only an ACTIVE key moves; true when it did.
   * The pool gateway's to call — no route reaches it.
   */
  async markKeyInvalid(keyId: string): Promise<boolean> {
    const key = await this.prisma.poolApiKey.findUnique({ where: { id: keyId }, select: { poolId: true } });
    if (!key) return false;
    const { count } = await this.prisma.poolApiKey.updateMany({
      where: { id: keyId, state: 'ACTIVE' },
      data: { state: 'INVALID' },
    });
    if (count > 0) this.publish(await this.peopleOf(key.poolId), key.poolId);
    return count > 0;
  }

  /**
   * OpenAI answered `insufficient_quota` for this key: out of budget until `until` (migration 0322), and
   * chosen by no claim before then. True when a key was marked. The pool gateway's to call.
   */
  async markKeySpent(keyId: string, until: Date): Promise<boolean> {
    const key = await this.prisma.poolApiKey.findUnique({ where: { id: keyId }, select: { poolId: true } });
    if (!key) return false;
    const { count } = await this.prisma.poolApiKey.updateMany({ where: { id: keyId }, data: { spentUntil: until } });
    if (count > 0) this.publish(await this.peopleOf(key.poolId), key.poolId);
    return count > 0;
  }

  /**
   * OpenAI rate-limited this key and the wait it named outlasted what the pool gateway may hold a request
   * open for, so its 429 went back to codex — which does not retry one (migration 0382). Recorded as a
   * SHORT window, and deliberately not `spentUntil`: an out-of-budget key is a reset away in days, this is
   * minutes. No claim chooses the key until it passes. True when a key was marked. The gateway's to call.
   */
  async markKeyThrottled(keyId: string, until: Date): Promise<boolean> {
    const key = await this.prisma.poolApiKey.findUnique({ where: { id: keyId }, select: { poolId: true } });
    if (!key) return false;
    const { count } = await this.prisma.poolApiKey.updateMany({ where: { id: keyId }, data: { throttledUntil: until } });
    if (count > 0) this.publish(await this.peopleOf(key.poolId), key.poolId);
    return count > 0;
  }

  /**
   * OpenAI took a request on a key marked out of budget — its organization has budget again — so the mark
   * goes. Only a marked key moves; true when it did. The pool gateway's to call.
   */
  async clearKeySpent(keyId: string): Promise<boolean> {
    const key = await this.prisma.poolApiKey.findUnique({ where: { id: keyId }, select: { poolId: true } });
    if (!key) return false;
    const { count } = await this.prisma.poolApiKey.updateMany({
      where: { id: keyId, spentUntil: { not: null } },
      data: { spentUntil: null },
    });
    if (count > 0) this.publish(await this.peopleOf(key.poolId), key.poolId);
    return count > 0;
  }

  /** The caller's place in a Codex pool — a shared one, or one of somebody's own (migration 0358) — or not
   *  found: for a pool they are not in exactly as for none. */
  private async place(userId: string, poolId: string) {
    const place = await this.prisma.providerPoolPerson.findUnique({
      where: { poolId_userId: { poolId, userId } },
      select: {
        role: true,
        pool: { select: { engine: true, shared: true, ownerId: true, label: true, membersCanAdd: true } },
      },
    });
    if (!place || place.pool.engine !== AgentProvider.CODEX) throw new NotFoundException('pool not found');
    return place;
  }

  /** `place`, for what only an admin does. */
  private async adminOf(userId: string, poolId: string, action: string) {
    const place = await this.place(userId, poolId);
    if (place.role !== 'ADMIN') throw new ForbiddenException(`Only the pool's admins can ${action}`);
    return place;
  }

  private async keyOf(poolId: string, keyId: string) {
    const key = await this.prisma.poolApiKey.findFirst({
      where: { id: keyId, poolId },
      select: { contributorId: true, keyFingerprint: true },
    });
    if (!key) throw new NotFoundException('key not found');
    return key;
  }

  /** A 409 when a key of this fingerprint is in the pool already, naming who put it in. */
  private async assertNotInPool(
    poolId: string,
    fingerprint: string,
    poolLabel: string,
    userId: string,
  ): Promise<void> {
    const held = await this.prisma.poolApiKey.findUnique({
      where: { poolId_keyFingerprint: { poolId, keyFingerprint: fingerprint } },
      select: { contributorId: true, contributor: { select: { user: { select: { name: true } } } } },
    });
    if (held) {
      throw duplicateKey(poolLabel, { name: held.contributor.user.name, you: held.contributorId === userId });
    }
  }

  private async peopleOf(poolId: string): Promise<string[]> {
    const people = await this.prisma.providerPoolPerson.findMany({ where: { poolId }, select: { userId: true } });
    return people.map((person) => person.userId);
  }

  /** Every pool given, as `viewerId` reads it, with its keys, this month's ledger and its sessions. */
  private async views(pools: PoolRow[], viewerId: string) {
    if (pools.length === 0) return [];
    const now = new Date();
    const ids = pools.map((pool) => pool.id);
    const slugs = pools.map((pool) => pool.slug);
    const keys = await this.prisma.poolApiKey.findMany({
      where: { poolId: { in: ids } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: KEY_VIEW_SELECT,
    });
    const usage = await this.prisma.poolUsage.findMany({
      where: { poolId: { in: ids }, windowStart: usageWindowStart(now) },
    });
    // A session is on a key while it is on the pool and the claim recorded that key for it
    // (session.pool_key_id), and running on it while its engine is producing output (the Running now
    // an account pool's member shows, ProvidersService.runningMemberIds).
    const running = await this.prisma.session.findMany({
      where: {
        provider: { in: slugs },
        poolKeyId: { in: keys.map((key) => key.id) },
        deletedAt: null,
        ...GENERATING_SESSION_FILTER,
      },
      select: { poolKeyId: true },
    });
    // What each person started on the pool this month — a pool's slug is nobody else's
    // (ProvidersService.withFreeSlug), so a session named by it is on the pool.
    const started = await this.prisma.session.groupBy({
      by: ['provider', 'ownerId'],
      where: {
        provider: { in: slugs },
        ownerId: { in: [...new Set(pools.flatMap((pool) => pool.people.map((person) => person.userId)))] },
        createdAt: { gte: usageWindowStart(now) },
      },
      _count: { _all: true },
    });
    // The ChatGPT accounts a pool of somebody's own holds (migration 0323), read as the owner's own page
    // reads them (ProvidersService) — they run the sessions of everyone in the pool (2026-10-03), so the
    // people the owner added read them too. A shared pool (0321) holds none: the query finds nothing.
    const logins = await this.prisma.poolCodexLogin.findMany({
      where: { poolId: { in: ids } },
      orderBy: [{ createdAt: 'asc' }, { accountId: 'asc' }],
      select: LOGIN_VIEW_SELECT,
    });
    const runningKeys = new Set(running.flatMap((session) => (session.poolKeyId ? [session.poolKeyId] : [])));
    return pools.map((pool) =>
      poolView(
        pool,
        keys.filter((key) => key.poolId === pool.id),
        usage.filter((row) => row.poolId === pool.id),
        {
          running: runningKeys,
          sessions: new Map(
            started.filter((row) => row.provider === pool.slug).map((row) => [row.ownerId, row._count._all]),
          ),
        },
        viewerId,
        now,
        logins.filter((login) => login.poolId === pool.id),
      ),
    );
  }

  /** Every person of the pool re-reads their providers: its keys and its people are on their pickers. */
  private publish(userIds: Iterable<string>, poolId: string): void {
    for (const userId of new Set(userIds)) {
      this.realtime.publishForUser(userId, RunEventType.PROVIDER_CHANGED, poolId);
    }
  }
}
