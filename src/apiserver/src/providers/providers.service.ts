import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AgentProvider, providerPreset, RunEventType, type ProviderPreset } from '@orbit/shared';
import { CLAUDE_EFFORT_ORDER } from '../common/runtime-provider';
import { GENERATING_SESSION_FILTER } from '../common/session-generating';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { CreateModelProviderDto, CreateProviderPoolDto, UpdateModelProviderDto } from './dto';
import { decryptSecret, encryptSecret } from './provider-crypto';
import { catalogDefaultModel, catalogModels, presetCatalog } from './model-catalog';
import { ProviderPlanUsageService } from './plan-usage.service';
import {
  isPoolCandidate,
  POOL_MEMBER_REFUSALS,
  poolMemberRefusal,
  type PoolAdmissionRow,
  type PoolMemberRefusal,
} from './pool-admission';
import { selectPoolMember, spentUntil } from './pool-select';
import { withPreset } from './preset-overlay';
import { pickFreeSlug, slugBase } from './provider-slug';

/**
 * One entry of ProvidersService.listUsable. The last three are absent on a built-in engine
 * rather than empty: what a built-in offers is whatever the CLI installed on the runner reports
 * (see the runner's claude_models.go / codex_models.go), which this side does not know — and
 * saying `models: []` would read as "this provider has no models", which is a different claim.
 */
export interface UsableProvider {
  slug: string;
  /** The engine that ends up running it — a configured provider borrows one (`moonshot` → `kimi`). */
  runtime: string;
  builtin: boolean;
  label?: string;
  models?: unknown;
  defaultModel?: string | null;
}

/** The refusal every write that puts a provider in a pool, or keeps it there, answers with: the same
 *  reason, in the same words, whether it was joining the pool or an edit to one already in it. */
function poolMemberRefused(row: { id: string; label: string }, reason: PoolMemberRefusal) {
  return new BadRequestException({
    code: 'PROVIDER_POOL_MEMBER_REFUSED',
    kind: 'REFUSAL',
    reason,
    providerId: row.id,
    message: `${row.label}: ${POOL_MEMBER_REFUSALS[reason]}`,
  });
}

/**
 * Refuse a model list whose `reasoningLevels` dispatch could not honour: a level Claude Code has no
 * name for, or a declaration on any runtime but Claude's. Dispatch maps an effort onto a declared list
 * only for the Claude runtime (declaredReasoningLevels), so on another one it would be stored, shown
 * back, and never read.
 */
function assertReasoningLevels(runtime: string, models: unknown): void {
  if (!Array.isArray(models)) return;
  for (const entry of models) {
    if (!entry || typeof entry !== 'object') continue;
    const { value, reasoningLevels } = entry as { value?: unknown; reasoningLevels?: unknown };
    if (reasoningLevels === undefined) continue;
    if (runtime !== AgentProvider.CLAUDE) {
      throw new BadRequestException(`model "${value}": reasoningLevels is only honoured on the claude runtime`);
    }
    if (
      !Array.isArray(reasoningLevels) ||
      reasoningLevels.some((level) => !CLAUDE_EFFORT_ORDER.includes(level as string))
    ) {
      throw new BadRequestException(
        `model "${value}": reasoningLevels must list only ${CLAUDE_EFFORT_ORDER.join(', ')}`,
      );
    }
  }
}

/** A provider row as refusing an edit to a pool member reads it, before and after the edit. */
type PoolEditRow = PoolAdmissionRow & { id: string; label: string };

/** A pool as its owner reads it: the providers in it, keyless and endpointless, in the order the
 *  provider lists use. */
const POOL_SELECT = {
  id: true,
  slug: true,
  label: true,
  createdAt: true,
  updatedAt: true,
  members: {
    orderBy: [
      { provider: { position: { sort: 'asc', nulls: 'last' } } },
      { provider: { createdAt: 'asc' } },
      { providerId: 'asc' },
    ],
    select: { provider: { select: { id: true, slug: true, label: true } } },
  },
} satisfies Prisma.ProviderPoolSelect;

function poolView({ members, ...pool }: Prisma.ProviderPoolGetPayload<{ select: typeof POOL_SELECT }>) {
  return { ...pool, members: members.map((member) => member.provider) };
}

/** The same pools, read with what asking each member's credential for its quota takes (poolViews). The key
 *  and the endpoint are selected for that and nothing else: no view built from this carries them. Only the
 *  list reads it — a write answers with the membership it wrote, and never asks after a quota. */
const POOL_QUOTA_SELECT = {
  ...POOL_SELECT,
  members: {
    ...POOL_SELECT.members,
    select: {
      provider: {
        select: {
          ...POOL_SELECT.members.select.provider.select,
          presetSlug: true,
          enabled: true,
          ownerId: true,
          runtime: true,
          baseUrl: true,
          apiKeyEnc: true,
        },
      },
    },
  },
} satisfies Prisma.ProviderPoolSelect;

type PoolRow = Prisma.ProviderPoolGetPayload<{ select: typeof POOL_QUOTA_SELECT }>;

/**
 * Where one member of a pool stands, in the order the claim reads a member: a refused key and a disabled
 * row are no candidates at all, a spent one waits for its reset, and of the rest one with no 5-hour
 * reading is last in line — not idle at 0%.
 */
export type PoolMemberState = 'REFUSED' | 'DISABLED' | 'SPENT' | 'RUNNING' | 'AVAILABLE' | 'NO_QUOTA';

@Injectable()
export class ProvidersService {
  constructor(
    private readonly prisma: PrismaService,
    // @Global RealtimeModule. Providers back every client's model picker, so a change pushes to
    // the owner (a personal BYOK row) or to everyone (a shared, admin-owned one).
    private readonly realtime: RealtimeService,
    private readonly planUsage: ProviderPlanUsageService,
  ) {}

  /** De-sensitized picker catalog (no key, no baseUrl): the shared providers plus the
   *  caller's own personal ones. Enabled only. */
  async listPublic(userId: string) {
    const rows = await this.prisma.modelProvider.findMany({
      where: {
        slug: { not: AgentProvider.OPENCODE },
        enabled: true,
        OR: [{ ownerId: null }, { ownerId: userId }],
      },
      orderBy: [{ position: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }],
      select: {
        id: true,
        ownerId: true,
        baseUrl: true,
        apiKeyEnc: true,
        slug: true,
        label: true,
        runtime: true,
        models: true,
        defaultModel: true,
        presetSlug: true,
        followsPreset: true,
      },
    });
    // Every client — web, iOS, macOS — reads its model list from here, so resolving the preset
    // once on this side is what keeps a catalogue update from needing a client release.
    //
    // The quota rides along because it belongs to the credential this row holds, not to the
    // machine running the session: a runner reports the account its own CLI is logged into, which
    // is a different account from a BYOK key. id/ownerId/baseUrl/apiKeyEnc are selected only to
    // ask that credential and are dropped here — this payload stays keyless and endpointless.
    return rows.map(({ id, ownerId, baseUrl, apiKeyEnc, ...picker }) => ({
      ...withPreset(picker),
      planUsage: this.planUsage.snapshot({ id, ownerId, runtime: picker.runtime, baseUrl, apiKeyEnc }),
    }));
  }

  /**
   * The provider slugs this caller may actually dispatch with — what `provider` accepts on a
   * session, a task, or the `--provider` flag of either. Mirrors the check both write paths run
   * (TasksService.assertUsableProvider, SessionsService.create), so a slug listed here is a slug
   * those two accept and one that is absent is one they refuse with `provider not available`.
   *
   * It exists because a configured provider's slug is derived and never shown (provider-slug.ts):
   * a browser picks providers by clicking a row, but an agent has to type the string, and until
   * this list there was no way to learn it other than guessing and being refused. Keyless and
   * endpointless, like listPublic.
   *
   * The caller's own account pools are listed too, by name alone: which members a pool holds, and
   * their keys, are nothing a caller needs to dispatch with it. A pool none of whose accounts can run
   * is still listed, and the doors refuse it with the reason (QueueService.accountPoolRefusal).
   */
  async listUsable(ownerId: string): Promise<UsableProvider[]> {
    const rows = await this.prisma.modelProvider.findMany({
      where: {
        // The built-in entry below already names `opencode`; the compatibility guard row that
        // holds that slug is not a second provider to choose between.
        slug: { not: AgentProvider.OPENCODE },
        enabled: true,
        OR: [{ ownerId: null }, { ownerId }],
      },
      orderBy: [{ position: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }],
      select: {
        slug: true,
        label: true,
        runtime: true,
        models: true,
        defaultModel: true,
        presetSlug: true,
        followsPreset: true,
      },
    });
    const pools = await this.prisma.providerPool.findMany({
      where: { ownerId },
      orderBy: { createdAt: 'asc' },
      select: { slug: true, label: true },
    });
    return [
      // A built-in engine carries no label: the slug is the engine's name, and it runs on itself.
      ...Object.values(AgentProvider).map((slug) => ({ slug, runtime: slug, builtin: true })),
      // Same preset resolution the pickers get, so the models named here are the ones the
      // provider currently offers rather than the copy stored when it was connected. Which
      // preset backs the row is the picker's business, not the caller's: dropped here.
      ...rows.map((row) => {
        const { presetSlug, followsPreset, ...view } = withPreset(row);
        return { ...view, builtin: false };
      }),
      // A pool runs on its members' Claude subscriptions, whose models are the Claude CLI's own —
      // so, like a built-in engine, it names no model list of its own.
      ...pools.map((pool) => ({ ...pool, runtime: AgentProvider.CLAUDE, builtin: false })),
    ];
  }

  /** Admin management list: the SHARED (ownerId null) providers only — never another
   *  user's personal rows. Every field except the encrypted key (→ hasApiKey). */
  async listShared() {
    const rows = await this.prisma.modelProvider.findMany({
      where: { ownerId: null, slug: { not: AgentProvider.OPENCODE } },
      orderBy: [{ position: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }],
    });
    return rows.map((r) => this.desensitize(r));
  }

  /** What each vendor preset offers *right now*, by slug — its models and the default they resolve
   *  to, with the last models.dev refresh folded in. The connect form reads this instead of the
   *  catalogue compiled into the bundle, so what it shows a user about to connect Kimi (and probes
   *  their key with) is what their sessions will actually get. */
  presetModels() {
    return presetCatalog();
  }

  /** The caller's personal (BYOK) providers, disabled ones included — each with why it may not join an
   *  account pool (`poolRefusal`, null when it may). The browser never sees a key, so this verdict is
   *  the only way the pool form can say which rows it will turn away, and why, before anyone asks. */
  async listMine(ownerId: string) {
    const rows = await this.prisma.modelProvider.findMany({
      where: { ownerId, slug: { not: AgentProvider.OPENCODE } },
      orderBy: [{ position: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }],
    });
    return rows.map((r) => {
      const reason = poolMemberRefusal(r);
      return {
        ...this.desensitize(r),
        poolRefusal: reason && { reason, message: POOL_MEMBER_REFUSALS[reason] },
      };
    });
  }

  /** The stored key itself, decrypted — the one payload here that carries a key back to a browser,
   *  and only ever the caller's own. Nothing else can tell you which key a provider holds, so the
   *  alternative to showing it is re-pasting from the vendor to find out. Scoped like every write:
   *  a shared row, or another user's, reads as not-found. */
  async revealKey(ownerId: string, id: string) {
    const row = await this.getScoped(ownerId, id);
    if (!row.apiKeyEnc) throw new NotFoundException('provider has no API key');
    return { apiKey: decryptSecret(row.apiKeyEnc) };
  }

  /** Create a provider. ownerId null = shared (admin area); set = the caller's personal one. */
  async create(ownerId: string | null, dto: CreateModelProviderDto) {
    const preset = this.assertPreset(dto.presetSlug);
    // Following means the catalogue supplies the models — a list sent alongside it would only be a
    // stale copy of the same thing. What's stored is then a snapshot: reads serve the preset, so it
    // only ever surfaces if we stop shipping that preset.
    const follows = !!preset && dto.followsPreset !== false;
    const models = follows
      ? catalogModels(preset!).map((m) => ({
          value: m.value,
          label: m.label,
          ...(m.contextWindow != null ? { contextWindow: m.contextWindow } : {}),
        }))
      : (dto.models ?? []);
    const base = slugBase(dto.slug ?? preset?.slug ?? dto.label);
    const data = {
      label: dto.label,
      runtime: dto.runtime ?? preset?.runtime ?? 'claude',
      baseUrl: dto.baseUrl,
      apiKeyEnc: encryptSecret(dto.apiKey),
      models: models as Prisma.InputJsonValue,
      defaultModel: (follows ? catalogDefaultModel(preset!) : dto.defaultModel) ?? dto.models?.[0]?.value ?? null,
      // Identity outlives ownership: a row that maintains its own list is still an Anthropic one.
      presetSlug: preset?.slug ?? null,
      followsPreset: follows,
      enabled: dto.enabled ?? true,
      ownerId,
    };
    assertReasoningLevels(data.runtime, models);
    const row = await this.withFreeSlug(base, (slug) =>
      this.prisma.modelProvider.create({ data: { ...data, slug } }),
    );
    this.publishChanged(ownerId, row.id);
    return this.desensitize(row);
  }

  /**
   * Write a row under the first free slug for this base. Two people connecting the same vendor at once
   * would pick the same free slug, so a lost race just re-picks against what's now taken rather than
   * surfacing as an error about an identifier nobody chose. A pool and a provider racing for one slug
   * end the same way: migration 0265's guard refuses the loser with the same unique violation.
   */
  private async withFreeSlug<T>(base: string, write: (slug: string) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await write(await this.freeSlug(base));
      } catch (e) {
        const raced = e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';
        if (!raced || attempt >= 4) throw e;
      }
    }
  }

  /** An unused slug for this base — see pickFreeSlug for why a collision is routine. A pool dispatches
   *  under the same field a provider does, so what's taken is both tables' slugs. */
  private async freeSlug(base: string) {
    const where = { slug: { startsWith: base } };
    const [providers, pools] = await Promise.all([
      this.prisma.modelProvider.findMany({ where, select: { slug: true } }),
      this.prisma.providerPool.findMany({ where, select: { slug: true } }),
    ]);
    return pickFreeSlug(
      base,
      [...providers, ...pools].map((r) => r.slug),
    );
  }

  /** Update a provider within one ownership scope: admins pass null (shared rows),
   *  users pass their id (their personal rows). Cross-scope ids read as not-found. */
  async update(ownerId: string | null, id: string, dto: UpdateModelProviderDto) {
    const current = await this.getScoped(ownerId, id);
    assertReasoningLevels(dto.runtime ?? current.runtime, dto.models ?? current.models);
    const data: Prisma.ModelProviderUpdateInput = {
      label: dto.label,
      runtime: dto.runtime,
      baseUrl: dto.baseUrl,
      defaultModel: dto.defaultModel,
      enabled: dto.enabled,
    };
    if (dto.models) data.models = dto.models as Prisma.InputJsonValue;
    // False hands the model list back to the row (the caller edited it); true takes the preset's
    // again. The vendor identity isn't editable — it's what the provider was created from.
    if (dto.followsPreset !== undefined) data.followsPreset = dto.followsPreset;
    // Only re-encrypt when a new key is supplied; an omitted key keeps the stored one.
    const apiKeyEnc = dto.apiKey ? encryptSecret(dto.apiKey) : undefined;
    if (apiKeyEnc) data.apiKeyEnc = apiKeyEnc;
    await this.assertPoolMemberEdit(current, {
      ...current,
      runtime: dto.runtime ?? current.runtime,
      baseUrl: dto.baseUrl ?? current.baseUrl,
      apiKeyEnc: apiKeyEnc ?? current.apiKeyEnc,
    });
    const row = await this.prisma.modelProvider.update({ where: { id }, data });
    this.publishChanged(ownerId, row.id);
    return this.desensitize(row);
  }

  /** The id of one of the caller's own providers, found by the slug `orbit provider list` shows — the
   *  handle the runner's write doors take, since that list carries no id. Scoped like every write: a
   *  shared row, or another user's, reads as not-found. */
  async idOfMine(ownerId: string, slug: string): Promise<string> {
    const row = await this.prisma.modelProvider.findFirst({
      where: { ownerId, slug: { equals: slug, not: AgentProvider.OPENCODE } },
      select: { id: true },
    });
    if (!row) throw new NotFoundException('provider not found');
    return row.id;
  }

  async remove(ownerId: string | null, id: string) {
    await this.getScoped(ownerId, id);
    await this.prisma.modelProvider.delete({ where: { id } });
    this.publishChanged(ownerId, id);
    return { ok: true };
  }

  /** The caller's account pools, each with the providers in it and where each of them stands — the one
   *  pool read that asks after quota (poolViews). */
  async listPools(ownerId: string) {
    const rows = await this.prisma.providerPool.findMany({
      where: { ownerId },
      orderBy: { createdAt: 'asc' },
      select: POOL_QUOTA_SELECT,
    });
    return this.poolViews(ownerId, rows);
  }

  /** An account pool of the caller's own providers: one more slug to dispatch with, taken from the
   *  namespace the providers' slugs come from. Its members keep theirs. */
  async createPool(ownerId: string, dto: CreateProviderPoolDto) {
    const providerIds = [...new Set(dto.providerIds ?? [])];
    await this.assertPoolMembers(ownerId, providerIds);
    const pool = await this.withFreeSlug(slugBase(dto.label), (slug) =>
      this.prisma.providerPool.create({
        data: {
          slug,
          label: dto.label,
          ownerId,
          members: { createMany: { data: providerIds.map((providerId) => ({ providerId })) } },
        },
        select: POOL_SELECT,
      }),
    );
    this.publishChanged(ownerId, pool.id);
    return poolView(pool);
  }

  /** Put one of the caller's providers into one of their pools. Adding a member again changes nothing. */
  async addPoolMember(ownerId: string, poolId: string, providerId: string) {
    await this.getScopedPool(ownerId, poolId);
    await this.assertPoolMembers(ownerId, [providerId]);
    await this.prisma.providerPoolMember.createMany({
      data: [{ poolId, providerId, ownerId }],
      skipDuplicates: true,
    });
    this.publishChanged(ownerId, poolId);
    return this.getScopedPool(ownerId, poolId);
  }

  /** Take a provider out of a pool; the provider itself is untouched. */
  async removePoolMember(ownerId: string, poolId: string, providerId: string) {
    await this.getScopedPool(ownerId, poolId);
    await this.prisma.providerPoolMember.deleteMany({ where: { poolId, providerId, ownerId } });
    this.publishChanged(ownerId, poolId);
    return this.getScopedPool(ownerId, poolId);
  }

  /** Delete a pool. Its members are providers in their own right and stay as they are. */
  async removePool(ownerId: string, id: string) {
    await this.getScopedPool(ownerId, id);
    await this.prisma.providerPool.delete({ where: { id } });
    this.publishChanged(ownerId, id);
    return { ok: true };
  }

  /** Push a provider change to the clients whose picker it affects: just the owner for a personal
   *  row, everyone for a shared one (ownerId null = the admin-managed catalog). */
  private publishChanged(ownerId: string | null, id: string): void {
    if (ownerId) this.realtime.publishForUser(ownerId, RunEventType.PROVIDER_CHANGED, id);
    else this.realtime.publishForAllUsers(RunEventType.PROVIDER_CHANGED, id);
  }

  /**
   * Probe a provider before it's saved: one minimal request on the endpoint the borrowed runtime
   * will actually call, with the same `Bearer` auth that runtime injects — POST {baseUrl}/v1/messages
   * for claude, POST {baseUrl}/responses for codex, POST {baseUrl}/chat/completions for kimi.
   * Stateless — the browser passes the freshly-typed key, nothing is persisted. Never throws on a
   * network/HTTP failure; returns a structured verdict the picker renders inline.
   */
  async testConnection(dto: {
    baseUrl: string;
    apiKey: string;
    model?: string;
    runtime?: string;
  }): Promise<{ ok: boolean; status?: number; message: string }> {
    const base = this.assertTestableUrl(dto.baseUrl).replace(/\/+$/, '');
    const model = (dto.model ?? '').trim();
    if (!model) throw new BadRequestException('add a model before testing');
    // The path the runtime's CLI will call, not merely the vendor's family: codex and kimi both
    // point at an OpenAI-compatible base URL, but only kimi still speaks Chat Completions. Codex
    // has nothing but the Responses API (it removed Chat Completions in February 2026, and the
    // runner configures it with wire_api="responses"), so a codex probe that asked /chat/completions
    // would pass an endpoint — Gemini's OpenAI-compatible one is exactly this — that every session
    // on it then fails against.
    const isResponses = dto.runtime === 'codex';
    const isOpenAIDialect = isResponses || dto.runtime === 'kimi';
    const endpoint = isResponses
      ? `${base}/responses`
      : isOpenAIDialect
        ? `${base}/chat/completions`
        : `${base}/v1/messages`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${dto.apiKey}`,
    };
    if (!isOpenAIDialect) headers['anthropic-version'] = '2023-06-01';
    // A subscription OAuth token (sk-ant-oat…, what `claude` stores after a browser login) is only
    // served for requests that identify as Claude Code, which the CLI does through its system
    // prompt. Without it Anthropic turns such a token away with a 429 whose message is the literal
    // string "Error" — so a key that drives sessions perfectly well failed the probe. Send what the
    // runtime sends, so the probe is no stricter than the session it is standing in for.
    // The Responses API spells it differently and refuses a cap under 16 output tokens.
    const body: Record<string, unknown> = isResponses
      ? { model, input: 'ping', max_output_tokens: 16 }
      : { model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] };
    if (!isOpenAIDialect) body.system = "You are Claude Code, Anthropic's official CLI for Claude.";
    try {
      const resp = await fetch(endpoint, {
        method: 'POST',
        redirect: 'manual',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(8000),
      });
      if (resp.ok) return { ok: true, status: resp.status, message: 'Connected' };
      if (resp.status === 401 || resp.status === 403) {
        return { ok: false, status: resp.status, message: 'Invalid API key' };
      }
      if (resp.status === 404) {
        // For codex a 404 on /responses is usually not a typo in the URL: it is an OpenAI-compatible
        // endpoint that only serves Chat Completions, which no current Codex can use. "Check the Base
        // URL" would send the owner looking for a mistake they did not make.
        return {
          ok: false,
          status: resp.status,
          message: isResponses
            ? "Endpoint doesn't serve the OpenAI Responses API — Codex needs it, so a Chat Completions-only endpoint can't run on Codex"
            : 'Endpoint not found — check the Base URL',
        };
      }
      // Keep the status next to the vendor's own words: a body can carry a message as unhelpful as
      // "Error", and alone it reads like the form itself broke rather than the endpoint answering.
      const detail = this.extractErr(await resp.text().catch(() => ''));
      return {
        ok: false,
        status: resp.status,
        message: detail ? `HTTP ${resp.status} — ${detail}` : `Endpoint returned HTTP ${resp.status}`,
      };
    } catch (e) {
      const timedOut = e instanceof Error && e.name === 'TimeoutError';
      return { ok: false, message: timedOut ? 'Timed out reaching the endpoint' : 'Could not reach the endpoint' };
    }
  }

  private async getScoped(ownerId: string | null, id: string) {
    const row = await this.prisma.modelProvider.findFirst({
      where: { id, ownerId, slug: { not: AgentProvider.OPENCODE } },
    });
    if (!row) throw new NotFoundException('provider not found');
    return row;
  }

  private async getScopedPool(ownerId: string, id: string) {
    const pool = await this.prisma.providerPool.findFirst({ where: { id, ownerId }, select: POOL_SELECT });
    if (!pool) throw new NotFoundException('pool not found');
    return poolView(pool);
  }

  /**
   * Pools as their owner reads them: each member keyless and endpointless, with its own quota and where
   * it stands (PoolMemberState), and the pool's answer to "what would a session starting now run on".
   *
   * That answer is `selectPoolMember`'s, asked exactly as a claim asks it — the members it may choose
   * (isPoolCandidate), their quota and refusals as the cache has them, no session to stay on — so the
   * member marked `next` is the one the next claim picks, not an average of the members, which would read
   * 50% for one spent account beside one untouched. `resetsAt` on the pool is set only when every member
   * that can run is spent, and is the EARLIEST of their resets: one account freeing up is enough for work
   * to continue. A spent member's own `resetsAt` is the latest of its windows, as for any single account.
   * `unavailable` is set only when no member can run at all, no reset included — the pool every door that
   * takes a provider refuses (QueueService.accountPoolRefusal), in the words a picker has room for.
   */
  private async poolViews(ownerId: string, pools: PoolRow[]) {
    const now = new Date();
    const running = await this.runningMemberIds(
      ownerId,
      pools.flatMap((pool) => pool.members.map((member) => member.provider)),
    );
    return pools.map(({ members, ...pool }) => {
      const quota = members.map(({ provider: row }) => ({
        row,
        usage: this.planUsage.snapshot(row),
        refused: this.planUsage.refused(row),
      }));
      const selection = selectPoolMember(
        quota.filter((member) => isPoolCandidate(member.row)),
        null,
        now,
      );
      return {
        ...pool,
        resetsAt: selection.kind === 'EXHAUSTED' ? (selection.resetsAt?.toISOString() ?? null) : null,
        unavailable:
          selection.kind !== 'UNAVAILABLE' ? null : members.length > 0 ? 'No account can run' : 'No accounts',
        members: quota.map(({ row, usage, refused }) => {
          const spent = spentUntil(usage, now);
          const state: PoolMemberState = refused
            ? 'REFUSED'
            : !row.enabled
              ? 'DISABLED'
              : spent !== undefined
                ? 'SPENT'
                : running.has(row.id)
                  ? 'RUNNING'
                  : usage?.fiveHour
                    ? 'AVAILABLE'
                    : 'NO_QUOTA';
          // Named field by field: the row also holds the key and the endpoint, and neither leaves here.
          return {
            id: row.id,
            slug: row.slug,
            label: row.label,
            presetSlug: row.presetSlug,
            enabled: row.enabled,
            planUsage: usage,
            state,
            resetsAt: state === 'SPENT' ? (spent?.toISOString() ?? null) : null,
            next: selection.kind === 'SELECTED' && selection.row.id === row.id,
          };
        }),
      };
    });
  }

  /**
   * The members some session of this owner is generating on right now: through a pool, the member its
   * last claim chose, and pinned to a member's own slug, that member. A session's recorded member counts
   * only while its provider is still a pool — one switched to a single provider keeps the stale column.
   */
  private async runningMemberIds(ownerId: string, members: { id: string; slug: string }[]): Promise<Set<string>> {
    if (members.length === 0) return new Set();
    const pools = await this.prisma.providerPool.findMany({ where: { ownerId }, select: { slug: true } });
    const sessions = await this.prisma.session.findMany({
      where: {
        ownerId,
        deletedAt: null,
        AND: [
          GENERATING_SESSION_FILTER,
          {
            OR: [
              {
                provider: { in: pools.map((pool) => pool.slug) },
                poolMemberProviderId: { in: members.map((member) => member.id) },
              },
              { provider: { in: members.map((member) => member.slug) } },
            ],
          },
        ],
      },
      select: { provider: true, poolMemberProviderId: true },
    });
    const bySlug = new Map(members.map((member) => [member.slug, member.id]));
    return new Set(
      sessions.flatMap((session) => {
        const id = bySlug.get(session.provider) ?? session.poolMemberProviderId;
        return id ? [id] : [];
      }),
    );
  }

  /**
   * Refuse, with the reason, a provider that could never be chosen from a pool. Another owner's reads
   * as not-found, as it does on every owner-scoped write here. A shared one is refused outright: a
   * pool spends its owner's own quota, and nothing could show whose a shared key's was. One whose
   * credential has no 5-hour window is refused by the very test the usage probe skips it with
   * (subscriptionUsageRefusal) — accepted, it would sit in the pool and never be picked. The member
   * row's foreign keys refuse the first two again in the database.
   */
  private async assertPoolMembers(ownerId: string, providerIds: string[]): Promise<void> {
    if (!providerIds.length) return;
    const rows = await this.prisma.modelProvider.findMany({
      where: {
        id: { in: providerIds },
        slug: { not: AgentProvider.OPENCODE },
        OR: [{ ownerId: null }, { ownerId }],
      },
      select: { id: true, label: true, ownerId: true, runtime: true, baseUrl: true, apiKeyEnc: true },
    });
    for (const providerId of providerIds) {
      const row = rows.find((candidate) => candidate.id === providerId);
      if (!row) throw new NotFoundException('provider not found');
      const reason = poolMemberRefusal(row);
      if (reason) throw poolMemberRefused(row, reason);
    }
  }

  /**
   * Refuse an edit that would turn a member of an account pool into one the pool would not admit: its
   * key made a metered one, its endpoint moved off Anthropic's, its runtime off Claude — the same test,
   * and the same answer, joining the pool gets (assertPoolMembers). Checked before the write, so a
   * refused edit leaves the row exactly as it was, still in its pool. Rotating to another subscription
   * token passes, and the next claim decrypts that one.
   *
   * `next` is the row as the edit would leave it. A provider in no pool, or a shared one (which none can
   * hold), edits as it always has — and so does a member the pool would already turn away, which no
   * claim chooses either way (isPoolCandidate): renaming or disabling it is not what made it so.
   */
  private async assertPoolMemberEdit(current: PoolEditRow, next: PoolEditRow): Promise<void> {
    if (next.ownerId === null) return;
    const reason = poolMemberRefusal(next);
    if (!reason || poolMemberRefusal(current) !== null) return;
    const pooled = await this.prisma.providerPoolMember.findFirst({
      where: { providerId: next.id },
      select: { poolId: true },
    });
    if (pooled) throw poolMemberRefused(next, reason);
  }

  /** The preset a write asks to follow — undefined for none, a 400 for one we don't ship. */
  private assertPreset(slug?: string | null): ProviderPreset | undefined {
    if (!slug) return undefined;
    const preset = providerPreset(slug);
    if (!preset) throw new BadRequestException(`unknown provider preset "${slug}"`);
    return preset;
  }

  // Reject anything but an http(s) URL to a non-internal host, so the test probe can't be aimed
  // at loopback/link-local/private addresses (a basic SSRF guard; DNS is not re-resolved).
  private assertTestableUrl(raw: string): string {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      throw new BadRequestException('invalid Base URL');
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      throw new BadRequestException('Base URL must be http(s)');
    }
    const host = u.hostname.toLowerCase();
    const isInternal =
      host === 'localhost' ||
      host.endsWith('.localhost') ||
      host === '0.0.0.0' ||
      host === '::1' ||
      /^127\./.test(host) ||
      /^169\.254\./.test(host) ||
      /^10\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host);
    if (isInternal) throw new BadRequestException('Base URL host is not allowed');
    return raw;
  }

  // Pull a short human-readable message out of a vendor's JSON error body, if present.
  private extractErr(body: string): string {
    try {
      const j = JSON.parse(body) as { error?: { message?: string } | string; message?: string };
      const m = (typeof j.error === 'object' ? j.error?.message : j.error) ?? j.message;
      if (typeof m === 'string' && m.trim()) return m.trim().slice(0, 200);
    } catch {
      /* non-JSON body → no detail */
    }
    return '';
  }

  // Drop the encrypted key from any browser-facing payload; expose only whether one is set. The
  // management surfaces read the same preset-resolved catalogue the pickers do, so the form shows
  // what a session would actually get.
  private desensitize({ apiKeyEnc, ...rest }: Prisma.ModelProviderGetPayload<object>) {
    return { ...withPreset(rest), hasApiKey: !!apiKeyEnc };
  }
}
