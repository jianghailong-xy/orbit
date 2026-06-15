import { Injectable, NotFoundException } from '@nestjs/common';
import { generateToken, sha256 } from '../common/crypto.util';
import { PrismaService } from '../prisma/prisma.service';
import { CreateEnrollmentTokenDto } from './dto';

@Injectable()
export class RunnersService {
  constructor(private readonly prisma: PrismaService) {}

  listRunners(ownerId: string) {
    return this.prisma.runner.findMany({
      where: { ownerId },
      orderBy: { enrolledAt: 'desc' },
      select: {
        id: true,
        name: true,
        hostname: true,
        labels: true,
        status: true,
        maxConcurrent: true,
        version: true,
        lastHeartbeatAt: true,
        enrolledAt: true,
      },
    });
  }

  async createEnrollmentToken(ownerId: string, dto: CreateEnrollmentTokenDto) {
    const raw = generateToken(24);
    const expiresAt = dto.ttlHours
      ? new Date(Date.now() + dto.ttlHours * 3600 * 1000)
      : null;
    const rec = await this.prisma.enrollmentToken.create({
      data: { ownerId, tokenHash: sha256(raw), label: dto.label, expiresAt },
    });
    // The raw token is shown exactly once — only its hash is persisted.
    return { id: rec.id, token: raw, label: rec.label, expiresAt: rec.expiresAt };
  }

  listEnrollmentTokens(ownerId: string) {
    return this.prisma.enrollmentToken.findMany({
      where: { ownerId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, label: true, expiresAt: true, usedAt: true, createdAt: true },
    });
  }

  async removeRunner(ownerId: string, id: string) {
    const runner = await this.prisma.runner.findFirst({ where: { id, ownerId } });
    if (!runner) throw new NotFoundException('runner not found');
    await this.prisma.runner.delete({ where: { id } });
    return { ok: true };
  }
}
