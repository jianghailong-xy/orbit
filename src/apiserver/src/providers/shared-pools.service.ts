import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AgentProvider, RunEventType } from '@orbit/shared';
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
  createdAt: true,
} satisfies Prisma.PoolApiKeySelect;

type PoolRow = Prisma.ProviderPoolGetPayload<{ select: typeof POOL_VIEW_SELECT }>;
type KeyRow = Prisma.PoolApiKeyGetPayload<{ select: typeof KEY_VIEW_SELECT }>;
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

/**
 * A shared pool as one of its people reads it: the rules, who is in it and what each spent this month,
 * and each key — whose it is, its label, `sk-…` and its last four characters, where it stands, its cap,
 * and what it has run this month (of which `othersCostUsd` is what its cap limits). No key's secret or
 * fingerprint is selected to build this, so none can reach it.
 */
function poolView(pool: PoolRow, keys: KeyRow[], usage: UsageRow[], viewerId: string, now: Date) {
  const names = new Map(pool.people.map((person) => [person.userId, person.user.name]));
  const viewer = pool.people.find((person) => person.userId === viewerId);
  return {
    id: pool.id,
    slug: pool.slug,
    label: pool.label,
    engine: pool.engine,
    shared: pool.shared,
    membersCanAdd: pool.membersCanAdd,
    ownKeyFirst: pool.ownKeyFirst,
    viewerRole: viewer?.role as PoolRole,
    // The month a share cap and every usage figure below count, UTC.
    window: { start: usageWindowStart(now).toISOString(), end: nextUsageWindowStart(now).toISOString() },
    people: pool.people.map((person) => ({
      userId: person.userId,
      name: person.user.name,
      role: person.role as PoolRole,
      // Who made the pool: always an admin, whom no one can remove or make a member.
      creator: person.userId === pool.ownerId,
      you: person.userId === viewerId,
      keys: keys.filter((key) => key.contributorId === person.userId).length,
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
        shareCap: key.shareCap,
        contributor: {
          userId: key.contributorId,
          name: names.get(key.contributorId) ?? '',
          you: key.contributorId === viewerId,
        },
        usage: {
          ...spend(onKey),
          othersCostUsd: spend(onKey.filter((row) => row.userId !== key.contributorId)).costUsd,
        },
        createdAt: key.createdAt,
      };
    }),
    createdAt: pool.createdAt,
    updatedAt: pool.updatedAt,
  };
}

/** The refusal a second add of one key gets, naming who put it in — somebody the adder shares the pool with. */
function duplicateKey(label: string, contributor: string) {
  return new ConflictException({
    code: 'POOL_KEY_DUPLICATE',
    message: `This key is already in "${label}" — ${contributor} put it in`,
  });
}

/**
 * Shared Codex pools (migration 0320, docs/codex-shared-pool-design.md §2.5, "account" read as "key"):
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
 */
@Injectable()
export class SharedPoolsService {
  constructor(
    private readonly prisma: PrismaService,
    // @Global RealtimeModule: a change reaches every person of the pool, whose pickers list it.
    private readonly realtime: RealtimeService,
    private readonly providers: ProvidersService,
  ) {}

  /** The shared pools the caller is in. */
  async list(userId: string) {
    const pools = await this.prisma.providerPool.findMany({
      where: { shared: true, people: { some: { userId } } },
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
      data: { label: dto.label, membersCanAdd: dto.membersCanAdd, ownKeyFirst: dto.ownKeyFirst },
    });
    this.publish(await this.peopleOf(poolId), poolId);
    return this.get(userId, poolId);
  }

  /** An admin deletes the pool: its people, keys, ledger and session tokens go with it. */
  async remove(userId: string, poolId: string) {
    await this.adminOf(userId, poolId, 'delete it');
    const people = await this.peopleOf(poolId);
    await this.prisma.providerPool.delete({ where: { id: poolId } });
    this.publish(people, poolId);
    return { ok: true };
  }

  /** An admin adds a person by the email of their Orbit account. Adding someone already in changes nothing. */
  async addPerson(userId: string, poolId: string, dto: AddSharedPoolPersonDto) {
    await this.adminOf(userId, poolId, 'add people to it');
    const person = await this.prisma.user.findUnique({ where: { email: dto.email.trim() }, select: { id: true } });
    if (!person) throw new NotFoundException('No Orbit account has that email');
    await this.prisma.providerPoolPerson.createMany({
      data: [{ poolId, userId: person.id, role: dto.role ?? 'MEMBER' }],
      skipDuplicates: true,
    });
    this.publish(await this.peopleOf(poolId), poolId);
    return this.get(userId, poolId);
  }

  /** An admin makes a person an admin or a member — anyone but the pool's creator. */
  async setRole(userId: string, poolId: string, personId: string, dto: UpdateSharedPoolPersonDto) {
    const place = await this.adminOf(userId, poolId, 'change who is an admin');
    if (personId === place.pool.ownerId && dto.role !== 'ADMIN') {
      throw new ForbiddenException('The person who made the pool stays one of its admins');
    }
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
    await this.assertNotInPool(poolId, key.fingerprint, place.pool.label);
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
        await this.assertNotInPool(poolId, key.fingerprint, place.pool.label);
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
   * secret is checked and stored like a new key's, and the key is ACTIVE again.
   */
  async replaceKey(userId: string, poolId: string, keyId: string, dto: ReplacePoolKeyDto) {
    const place = await this.place(userId, poolId);
    const key = await this.keyOf(poolId, keyId);
    if (key.contributorId !== userId && place.role !== 'ADMIN') {
      throw new ForbiddenException('Only the person who put this key in, or an admin, can replace it');
    }
    const next = parsePoolApiKey(dto.apiKey);
    if (next.fingerprint !== key.keyFingerprint) {
      await this.assertNotInPool(poolId, next.fingerprint, place.pool.label);
    }
    await this.prisma.poolApiKey.update({
      where: { id: keyId },
      data: {
        keyFingerprint: next.fingerprint,
        keyHint: next.hint,
        secretEncrypted: encryptSecret(next.secret),
        state: 'ACTIVE',
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

  /** The caller's place in a shared pool, or not found — for a pool they are not in exactly as for none. */
  private async place(userId: string, poolId: string) {
    const place = await this.prisma.providerPoolPerson.findUnique({
      where: { poolId_userId: { poolId, userId } },
      select: { role: true, pool: { select: { shared: true, ownerId: true, label: true, membersCanAdd: true } } },
    });
    if (!place || !place.pool.shared) throw new NotFoundException('pool not found');
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
  private async assertNotInPool(poolId: string, fingerprint: string, poolLabel: string): Promise<void> {
    const held = await this.prisma.poolApiKey.findUnique({
      where: { poolId_keyFingerprint: { poolId, keyFingerprint: fingerprint } },
      select: { contributor: { select: { user: { select: { name: true } } } } },
    });
    if (held) throw duplicateKey(poolLabel, held.contributor.user.name);
  }

  private async peopleOf(poolId: string): Promise<string[]> {
    const people = await this.prisma.providerPoolPerson.findMany({ where: { poolId }, select: { userId: true } });
    return people.map((person) => person.userId);
  }

  /** Every pool given, as `viewerId` reads it, with its keys and this month's ledger. */
  private async views(pools: PoolRow[], viewerId: string) {
    if (pools.length === 0) return [];
    const now = new Date();
    const ids = pools.map((pool) => pool.id);
    const keys = await this.prisma.poolApiKey.findMany({
      where: { poolId: { in: ids } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: KEY_VIEW_SELECT,
    });
    const usage = await this.prisma.poolUsage.findMany({
      where: { poolId: { in: ids }, windowStart: usageWindowStart(now) },
    });
    return pools.map((pool) =>
      poolView(
        pool,
        keys.filter((key) => key.poolId === pool.id),
        usage.filter((row) => row.poolId === pool.id),
        viewerId,
        now,
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
