import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AgentProvider } from '@orbit/shared';
import { PrismaService } from '../prisma/prisma.service';
import { CreateModelProviderDto, UpdateModelProviderDto } from './dto';
import { encryptSecret } from './provider-crypto';

const BUILTIN_SLUGS = new Set<string>([AgentProvider.CLAUDE, AgentProvider.CODEX]);
const SLUG_RE = /^[a-z][a-z0-9-]*$/;

@Injectable()
export class ProvidersService {
  constructor(private readonly prisma: PrismaService) {}

  /** De-sensitized picker catalog (no key, no baseUrl): the shared providers plus the
   *  caller's own personal ones. Enabled only. */
  listPublic(userId: string) {
    return this.prisma.modelProvider.findMany({
      where: { enabled: true, OR: [{ ownerId: null }, { ownerId: userId }] },
      orderBy: [{ position: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }],
      select: { slug: true, label: true, runtime: true, models: true, defaultModel: true },
    });
  }

  /** Admin management list: the SHARED (ownerId null) providers only — never another
   *  user's personal rows. Every field except the encrypted key (→ hasApiKey). */
  async listShared() {
    const rows = await this.prisma.modelProvider.findMany({
      where: { ownerId: null },
      orderBy: [{ position: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }],
    });
    return rows.map((r) => this.desensitize(r));
  }

  /** The caller's personal (BYOK) providers, disabled ones included. */
  async listMine(ownerId: string) {
    const rows = await this.prisma.modelProvider.findMany({
      where: { ownerId },
      orderBy: [{ position: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }],
    });
    return rows.map((r) => this.desensitize(r));
  }

  /** Create a provider. ownerId null = shared (admin area); set = the caller's personal one. */
  async create(ownerId: string | null, dto: CreateModelProviderDto) {
    const slug = dto.slug.trim().toLowerCase();
    this.assertSlug(slug);
    try {
      const row = await this.prisma.modelProvider.create({
        data: {
          slug,
          label: dto.label,
          runtime: dto.runtime ?? 'claude',
          baseUrl: dto.baseUrl,
          apiKeyEnc: encryptSecret(dto.apiKey),
          models: (dto.models ?? []) as Prisma.InputJsonValue,
          defaultModel: dto.defaultModel ?? dto.models?.[0]?.value ?? null,
          enabled: dto.enabled ?? true,
          ownerId,
        },
      });
      return this.desensitize(row);
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new BadRequestException('a provider with this slug already exists');
      }
      throw e;
    }
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
    // Only re-encrypt when a new key is supplied; an omitted key keeps the stored one.
    if (dto.apiKey) data.apiKeyEnc = encryptSecret(dto.apiKey);
    const row = await this.prisma.modelProvider.update({ where: { id }, data });
    return this.desensitize(row);
  }

  async remove(ownerId: string | null, id: string) {
    await this.getScoped(ownerId, id);
    await this.prisma.modelProvider.delete({ where: { id } });
    return { ok: true };
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
  }): Promise<{ ok: boolean; status?: number; message: string }> {
    const base = this.assertTestableUrl(dto.baseUrl);
    const model = (dto.model ?? '').trim();
    if (!model) throw new BadRequestException('add a model before testing');
    try {
      const resp = await fetch(`${base.replace(/\/+$/, '')}/v1/messages`, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${dto.apiKey}`,
          'anthropic-version': '2023-06-01',
        },
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
    const row = await this.prisma.modelProvider.findFirst({ where: { id, ownerId } });
    if (!row) throw new NotFoundException('provider not found');
    return row;
  }

  private assertSlug(slug: string) {
    if (!SLUG_RE.test(slug)) {
      throw new BadRequestException('slug must be lowercase letters/digits/hyphen, starting with a letter');
    }
    if (BUILTIN_SLUGS.has(slug)) throw new BadRequestException(`"${slug}" is a built-in provider`);
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

  // Drop the encrypted key from any browser-facing payload; expose only whether one is set.
  private desensitize({ apiKeyEnc, ...rest }: Prisma.ModelProviderGetPayload<object>) {
    return { ...rest, hasApiKey: !!apiKeyEnc };
  }
}
