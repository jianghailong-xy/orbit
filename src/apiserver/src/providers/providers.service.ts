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

  /** De-sensitized list for pickers (no key, no baseUrl). Enabled only. All users. */
  listPublic() {
    return this.prisma.modelProvider.findMany({
      where: { enabled: true },
      orderBy: [{ position: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }],
      select: { slug: true, label: true, runtime: true, models: true, defaultModel: true },
    });
  }

  /** Admin list: every field except the encrypted key (surfaced as a hasApiKey flag). */
  async listAdmin() {
    const rows = await this.prisma.modelProvider.findMany({
      orderBy: [{ position: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }],
    });
    return rows.map((r) => this.desensitize(r));
  }

  async create(dto: CreateModelProviderDto) {
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

  async update(id: string, dto: UpdateModelProviderDto) {
    await this.getOrThrow(id);
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

  async remove(id: string) {
    await this.getOrThrow(id);
    await this.prisma.modelProvider.delete({ where: { id } });
    return { ok: true };
  }

  private async getOrThrow(id: string) {
    const row = await this.prisma.modelProvider.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('provider not found');
    return row;
  }

  private assertSlug(slug: string) {
    if (!SLUG_RE.test(slug)) {
      throw new BadRequestException('slug must be lowercase letters/digits/hyphen, starting with a letter');
    }
    if (BUILTIN_SLUGS.has(slug)) throw new BadRequestException(`"${slug}" is a built-in provider`);
  }

  // Drop the encrypted key from any browser-facing payload; expose only whether one is set.
  private desensitize({ apiKeyEnc, ...rest }: Prisma.ModelProviderGetPayload<object>) {
    return { ...rest, hasApiKey: !!apiKeyEnc };
  }
}
