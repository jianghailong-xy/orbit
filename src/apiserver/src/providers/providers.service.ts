import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AgentProvider, providerPreset, RunEventType, type ProviderPreset } from '@orbit/shared';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { CreateModelProviderDto, UpdateModelProviderDto } from './dto';
import { encryptSecret } from './provider-crypto';
import { withPreset } from './preset-overlay';
import { pickFreeSlug, slugBase } from './provider-slug';
import { AUTH_MODE_SUBSCRIPTION } from './subscription-token';

@Injectable()
export class ProvidersService {
  constructor(
    private readonly prisma: PrismaService,
    // @Global RealtimeModule. Providers back every client's model picker, so a change pushes to
    // the owner (a personal BYOK row) or to everyone (a shared, admin-owned one).
    private readonly realtime: RealtimeService,
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
    return rows.map((r) => withPreset(r));
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

  /** The caller's personal (BYOK) providers, disabled ones included. */
  async listMine(ownerId: string) {
    const rows = await this.prisma.modelProvider.findMany({
      where: { ownerId, slug: { not: AgentProvider.OPENCODE } },
      orderBy: [{ position: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }],
    });
    return rows.map((r) => this.desensitize(r));
  }

  /** Create a provider. ownerId null = shared (admin area); set = the caller's personal one. */
  async create(ownerId: string | null, dto: CreateModelProviderDto) {
    const preset = this.assertPreset(dto.presetSlug);
    // Following means the catalogue supplies the models — a list sent alongside it would only be a
    // stale copy of the same thing. What's stored is then a snapshot: reads serve the preset, so it
    // only ever surfaces if we stop shipping that preset.
    const follows = !!preset && dto.followsPreset !== false;
    const models = follows
      ? preset!.models.map((m) => ({
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
      defaultModel: (follows ? preset!.defaultModel : dto.defaultModel) ?? dto.models?.[0]?.value ?? null,
      // Identity outlives ownership: a row that maintains its own list is still an Anthropic one.
      presetSlug: preset?.slug ?? null,
      followsPreset: follows,
      enabled: dto.enabled ?? true,
      ownerId,
    };
    // Two people connecting the same vendor at once would pick the same free slug, so a lost race
    // just re-picks against what's now taken rather than surfacing as an error about an identifier
    // nobody chose.
    for (let attempt = 0; ; attempt++) {
      try {
        const row = await this.prisma.modelProvider.create({
          data: { ...data, slug: await this.freeSlug(base) },
        });
        this.publishChanged(ownerId, row.id);
        return this.desensitize(row);
      } catch (e) {
        const raced = e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';
        if (!raced || attempt >= 4) throw e;
      }
    }
  }

  /** An unused slug for this base — see pickFreeSlug for why a collision is routine. */
  private async freeSlug(base: string) {
    const rows = await this.prisma.modelProvider.findMany({
      where: { slug: { startsWith: base } },
      select: { slug: true },
    });
    return pickFreeSlug(
      base,
      rows.map((r) => r.slug),
    );
  }

  /** Update a provider within one ownership scope: admins pass null (shared rows),
   *  users pass their id (their personal rows). Cross-scope ids read as not-found. */
  async update(ownerId: string | null, id: string, dto: UpdateModelProviderDto) {
    await this.getScoped(ownerId, id);
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
    if (dto.apiKey) data.apiKeyEnc = encryptSecret(dto.apiKey);
    const row = await this.prisma.modelProvider.update({ where: { id }, data });
    this.publishChanged(ownerId, row.id);
    return this.desensitize(row);
  }

  async remove(ownerId: string | null, id: string) {
    await this.getScoped(ownerId, id);
    await this.prisma.modelProvider.delete({ where: { id } });
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
   * Probe a provider before it's saved: one minimal Anthropic-compatible request
   * (POST {baseUrl}/v1/messages, max_tokens 1) with the same `Bearer` auth the claude runtime
   * injects. Stateless — the browser passes the freshly-typed key, nothing is persisted. Never
   * throws on a network/HTTP failure; returns a structured verdict the picker renders inline.
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
    // codex providers speak OpenAI chat-completions; claude providers the Anthropic Messages API.
    const isCodex = dto.runtime === 'codex';
    const endpoint = isCodex ? `${base}/chat/completions` : `${base}/v1/messages`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${dto.apiKey}`,
    };
    if (!isCodex) headers['anthropic-version'] = '2023-06-01';
    try {
      const resp = await fetch(endpoint, {
        method: 'POST',
        redirect: 'manual',
        headers,
        body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }),
        signal: AbortSignal.timeout(8000),
      });
      if (resp.ok) return { ok: true, status: resp.status, message: 'Connected' };
      if (resp.status === 401 || resp.status === 403) {
        return { ok: false, status: resp.status, message: 'Invalid API key' };
      }
      if (resp.status === 404) {
        return { ok: false, status: resp.status, message: 'Endpoint not found — check the Base URL' };
      }
      const detail = this.extractErr(await resp.text().catch(() => ''));
      return { ok: false, status: resp.status, message: detail || `Endpoint returned HTTP ${resp.status}` };
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

  /** This user's Claude accounts, newest last. The token is never returned — there is no read
   *  path for it outside dispatch. */
  async listSubscriptions(userId: string): Promise<SubscriptionAccountView[]> {
    const rows = await this.prisma.modelProvider.findMany({
      where: { ownerId: userId, authMode: AUTH_MODE_SUBSCRIPTION },
      orderBy: { createdAt: 'asc' },
      select: { id: true, slug: true, label: true, isDefault: true, enabled: true, createdAt: true },
    });
    return rows.map((r) => ({
      id: r.id,
      slug: r.slug,
      label: r.label,
      isDefault: r.isDefault,
      enabled: r.enabled,
      setAt: r.createdAt.toISOString(),
    }));
  }

  /**
   * Store one Claude account. `claude setup-token` prints its token on a line of its own; users
   * paste it with stray whitespace often enough that trimming here is worth more than rejecting
   * it. We deliberately do NOT probe it: the subscription endpoint has no cheap
   * unauthenticated-safe health call, and a wrong token already surfaces clearly as the sign-in
   * card on the next turn.
   *
   * The label is the user's; the slug is derived from it and is what Agent.provider stores, so an
   * account can be picked per agent exactly like an API-key provider. The row follows the
   * anthropic preset, so it offers the current Claude models without anyone maintaining a list.
   */
  async createSubscription(userId: string, label: string, token: string) {
    const trimmedToken = token.trim();
    if (!trimmedToken) throw new BadRequestException('Token is empty');
    const trimmedLabel = label.trim();
    if (!trimmedLabel) throw new BadRequestException('Name is empty');
    const preset = providerPreset('anthropic');
    // The first account an owner stores becomes the default; later ones never steal it.
    const existing = await this.prisma.modelProvider.count({
      where: { ownerId: userId, authMode: AUTH_MODE_SUBSCRIPTION },
    });
    const base = slugBase(trimmedLabel);
    // Same lost-race retry as create(): two accounts named alike pick the same free slug, and the
    // loser just re-picks rather than surfacing an error about an identifier nobody chose.
    for (let attempt = 0; ; attempt++) {
      try {
        const row = await this.prisma.modelProvider.create({
          data: {
            slug: await this.freeSlug(base),
            label: trimmedLabel,
            runtime: AgentProvider.CLAUDE,
            // Recorded for display only — a subscription row never injects an endpoint.
            baseUrl: preset?.baseUrl ?? 'https://api.anthropic.com',
            apiKeyEnc: encryptSecret(trimmedToken),
            models: [] as unknown as Prisma.InputJsonValue,
            presetSlug: 'anthropic',
            followsPreset: true,
            authMode: AUTH_MODE_SUBSCRIPTION,
            isDefault: existing === 0,
            ownerId: userId,
          },
        });
        this.publishChanged(userId, row.id);
        return this.desensitize(row);
      } catch (e) {
        const raced = e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';
        if (!raced || attempt >= 4) throw e;
      }
    }
  }

  /**
   * Make one account the owner's default. Clearing the others and setting this one has to be
   * atomic, or a crash between the two leaves an owner with none (new agents would silently fall
   * back to each runner's local login) or two (dispatch would pick arbitrarily).
   */
  async setDefaultSubscription(userId: string, id: string) {
    await this.getSubscriptionScoped(userId, id);
    await this.prisma.$transaction([
      this.prisma.modelProvider.updateMany({
        where: { ownerId: userId, authMode: AUTH_MODE_SUBSCRIPTION, isDefault: true },
        data: { isDefault: false },
      }),
      this.prisma.modelProvider.update({ where: { id }, data: { isDefault: true } }),
    ]);
    this.publishChanged(userId, id);
    return { ok: true };
  }

  /**
   * Forget one account. Removing the default promotes the oldest survivor rather than leaving the
   * owner without one — an owner with accounts should always have a default, and picking one for
   * them beats silently falling back to each runner's local login.
   *
   * Agents pinned to this account keep a slug that no longer resolves, which resolveProviderExec
   * already handles: an unresolvable slug degrades to the built-in claude runtime, so they land
   * on the new default instead of failing to dispatch.
   */
  async removeSubscription(userId: string, id: string) {
    const row = await this.getSubscriptionScoped(userId, id);
    await this.prisma.$transaction(async (tx) => {
      await tx.modelProvider.delete({ where: { id } });
      if (!row.isDefault) return;
      const next = await tx.modelProvider.findFirst({
        where: { ownerId: userId, authMode: AUTH_MODE_SUBSCRIPTION },
        orderBy: { createdAt: 'asc' },
        select: { id: true },
      });
      if (next) await tx.modelProvider.update({ where: { id: next.id }, data: { isDefault: true } });
    });
    this.publishChanged(userId, id);
    return { ok: true };
  }

  /** A subscription row owned by this user, or not-found. Keeps another user's id — and an
   *  API-key row's id — from reaching the account routes. */
  private async getSubscriptionScoped(userId: string, id: string) {
    const row = await this.prisma.modelProvider.findFirst({
      where: { id, ownerId: userId, authMode: AUTH_MODE_SUBSCRIPTION },
      select: { id: true, isDefault: true },
    });
    if (!row) throw new NotFoundException('account not found');
    return row;
  }
}

/** Browser-facing view of one Claude account: everything but the token. */
export interface SubscriptionAccountView {
  id: string;
  slug: string;
  label: string;
  isDefault: boolean;
  enabled: boolean;
  setAt: string;
}
