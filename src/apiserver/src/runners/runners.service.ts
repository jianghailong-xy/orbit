import { HttpException, HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import type { SlashCommandInfo } from '@orbit/shared';
import { generateToken, sha256 } from '../common/crypto.util';
import { PrismaService } from '../prisma/prisma.service';
import { CreateEnrollmentTokenDto, UpdateRunnerDto } from './dto';

// Three missed 30s heartbeats — a runner quieter than this reads as offline.
const OFFLINE_AFTER_MS = 90_000;
// Cap device-enrollment userCode lookups per user, so an authenticated insider
// cannot brute-force another user's pending enrollment code online.
const DEVICE_LOOKUP_WINDOW_MS = 5 * 60_000;
const DEVICE_LOOKUP_MAX = 20;

@Injectable()
export class RunnersService {
  constructor(private readonly prisma: PrismaService) {}

  private readonly deviceLookups = new Map<string, number[]>();

  /** Throttle per-user userCode lookups to defeat online enumeration. */
  private rateLimitDeviceLookup(userId: string): void {
    const now = Date.now();
    const recent = (this.deviceLookups.get(userId) ?? []).filter(
      (t) => now - t < DEVICE_LOOKUP_WINDOW_MS,
    );
    if (recent.length >= DEVICE_LOOKUP_MAX) {
      throw new HttpException(
        'too many enrollment lookups, slow down',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    recent.push(now);
    this.deviceLookups.set(userId, recent);
  }

  async listRunners(ownerId: string) {
    const runners = await this.prisma.runner.findMany({
      where: { ownerId },
      orderBy: { enrolledAt: 'desc' },
      select: {
        id: true,
        name: true,
        displayName: true,
        hostname: true,
        labels: true,
        status: true,
        maxConcurrent: true,
        version: true,
        lastHeartbeatAt: true,
        enrolledAt: true,
        availableCommands: true,
        availableSkills: true,
      },
    });
    // A runner heartbeats every 30s; treat a missed window as offline so the UI
    // reflects dropouts without waiting for a background reaper.
    const staleBefore = Date.now() - OFFLINE_AFTER_MS;
    return runners.map(({ availableCommands, availableSkills, ...r }) => ({
      ...r,
      online: r.status !== 'OFFLINE' && !!r.lastHeartbeatAt && r.lastHeartbeatAt.getTime() >= staleBefore,
      // Surface the `/` autocomplete catalog under clean names (mirrors the heartbeat DTO).
      commands: (availableCommands ?? []) as unknown as SlashCommandInfo[],
      skills: (availableSkills ?? []) as unknown as SlashCommandInfo[],
    }));
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

  /** Details shown on the browser approval page for an `orbit register` session. */
  async getDeviceEnrollment(ownerId: string, userCode: string) {
    this.rateLimitDeviceLookup(ownerId);
    const s = await this.prisma.deviceEnrollment.findUnique({ where: { userCode } });
    if (!s || s.expiresAt < new Date()) {
      throw new NotFoundException('enrollment request not found or expired');
    }
    // Warn (don't block) if a runner with this name is already registered, so the
    // user knows approving re-issues its credential rather than adding a 2nd machine.
    const runnerName = s.name;
    const nameConflict =
      (await this.prisma.runner.count({ where: { ownerId, name: runnerName } })) > 0;
    return {
      userCode: s.userCode,
      name: s.name,
      hostname: s.hostname,
      labels: s.labels,
      maxConcurrent: s.maxConcurrent,
      status: s.status,
      nameConflict,
      createdAt: s.createdAt,
    };
  }

  /**
   * Approve a device session: mint one Runner for the machine, then stash its
   * credential. Agents are registered separately, not here.
   */
  async approveDeviceEnrollment(ownerId: string, userCode: string) {
    this.rateLimitDeviceLookup(ownerId);
    const s = await this.prisma.deviceEnrollment.findUnique({ where: { userCode } });
    if (!s || s.expiresAt < new Date()) {
      throw new NotFoundException('enrollment request not found or expired');
    }
    const runnerName = s.name;
    if (s.status === 'APPROVED') {
      return { ok: true, name: runnerName, replaced: false };
    }

    // One Runner per machine. Re-registering reuses the same runner (reissuing its
    // credential) rather than duplicating, so the machine keeps its identity and
    // run history.
    const runnerToken = generateToken(32);
    const data = {
      hostname: s.hostname,
      labels: s.labels,
      maxConcurrent: s.maxConcurrent,
      version: s.version,
      tokenHash: sha256(runnerToken),
      status: 'ONLINE' as const,
      lastHeartbeatAt: new Date(),
    };
    const existing = await this.prisma.runner.findFirst({
      where: { ownerId, name: runnerName },
      orderBy: { enrolledAt: 'desc' },
    });
    const runner = existing
      ? await this.prisma.runner.update({ where: { id: existing.id }, data })
      : await this.prisma.runner.create({ data: { ...data, name: runnerName, ownerId } });

    await this.prisma.deviceEnrollment.update({
      where: { id: s.id },
      data: {
        status: 'APPROVED',
        runnerId: runner.id,
        runnerToken,
        approvedById: ownerId,
        approvedAt: new Date(),
      },
    });
    return { ok: true, name: runnerName, replaced: !!existing };
  }

  async updateRunner(ownerId: string, id: string, dto: UpdateRunnerDto) {
    const runner = await this.prisma.runner.findFirst({ where: { id, ownerId } });
    if (!runner) throw new NotFoundException('runner not found');
    const data: { displayName?: string | null; maxConcurrent?: number } = {};
    if (dto.displayName !== undefined) {
      const trimmed = dto.displayName.trim();
      data.displayName = trimmed.length ? trimmed : null;
    }
    // The queue gates live sessions on this per claim, so a change takes effect
    // next cycle without restarting the runner.
    if (dto.maxConcurrent !== undefined) {
      data.maxConcurrent = dto.maxConcurrent;
    }
    // Never echo back tokenHash.
    return this.prisma.runner.update({
      where: { id },
      data,
      select: { id: true, name: true, displayName: true, maxConcurrent: true },
    });
  }

  async removeRunner(ownerId: string, id: string) {
    const runner = await this.prisma.runner.findFirst({ where: { id, ownerId } });
    if (!runner) throw new NotFoundException('runner not found');
    await this.prisma.runner.delete({ where: { id } });
    return { ok: true };
  }
}
