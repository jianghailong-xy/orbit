import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AgentProvider, providerPreset, RunEventType, type ProviderPreset } from '@orbit/shared';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { CreateModelProviderDto, UpdateModelProviderDto } from './dto';
import { decryptSecret, encryptSecret } from './provider-crypto';
import { catalogDefaultModel, catalogModels, presetCatalog } from './model-catalog';
import { withPreset } from './preset-overlay';
import { pickFreeSlug, slugBase } from './provider-slug';

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

  /** What each vendor preset offers *right now*, by slug — its models and the default they resolve
   *  to, with the last models.dev refresh folded in. The connect form reads this instead of the
   *  catalogue compiled into the bundle, so what it shows a user about to connect Kimi (and probes
   *  their key with) is what their sessions will actually get. */
  presetModels() {
    return presetCatalog();
  }

  /** The caller's personal (BYOK) providers, disabled ones included. */
  async listMine(ownerId: string) {
    const rows = await this.prisma.modelProvider.findMany({
      where: { ownerId, slug: { not: AgentProvider.OPENCODE } },
      orderBy: [{ position: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }],
    });
    return rows.map((r) => this.desensitize(r));
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
    // What the endpoint speaks, not which CLI drives it: codex and kimi providers both point at
    // an OpenAI-compatible base URL (Moonshot's own /v1 for kimi), claude providers at the
    // Anthropic Messages API.
    const isOpenAIDialect = dto.runtime === 'codex' || dto.runtime === 'kimi';
    const endpoint = isOpenAIDialect ? `${base}/chat/completions` : `${base}/v1/messages`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${dto.apiKey}`,
    };
    if (!isOpenAIDialect) headers['anthropic-version'] = '2023-06-01';
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
}
