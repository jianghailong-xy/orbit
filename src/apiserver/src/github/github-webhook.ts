import {
  Controller, Headers, HttpCode, HttpException, Injectable, Logger, NotFoundException, Post, Req, UnauthorizedException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Request } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { GithubAppConfigService } from './github-app-config.service';
import { GithubInstallationGrants } from './github-installation-grants';
import { PullRequestDoorService } from './pull-request-door.service';

/** The route GitHub delivers the App's webhooks to (docs/design/protected-branch-landing.md §4.7, §8). */
export const GITHUB_WEBHOOK_PATH = '/api/integrations/github/webhook';

/** The most of a delivery Orbit reads. GitHub's pull request events are far smaller; a larger one is not read. */
export const GITHUB_WEBHOOK_MAX_BYTES = 5 * 1024 * 1024;

/** A delivery's raw bytes, kept by the body parser for this one route so the signature is checked over them. */
export type RawBodyRequest = Request & { rawBody?: Buffer };

/** Whether `header` (X-Hub-Signature-256) is GitHub's HMAC-SHA256 of `body` under `secret`, compared in constant time. */
export function githubSignatureValid(secret: string, body: Buffer, header: string | undefined): boolean {
  if (!secret || typeof header !== 'string' || !header.startsWith('sha256=')) return false;
  const given = Buffer.from(header.slice('sha256='.length), 'hex');
  const expected = createHmac('sha256', secret).update(body).digest();
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** What a delivery says it is about. Read only to find which pull requests to read again, never for what changed. */
export interface DeliveryAbout {
  action: string | null;
  installationId: bigint | null;
  repoId: bigint | null;
  pullNumbers: number[];
  headShas: string[];
  /** A push's ref: the base of the pull requests into it moved. */
  pushedRef: string | null;
}

const SHA40 = /^[0-9a-f]{40}$/;

function idOf(value: unknown): bigint | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? BigInt(value) : null;
}

/** §4.7: the doorbell's address, out of GitHub's payload. */
export function deliveryAbout(event: string, payload: unknown): DeliveryAbout {
  const body = (payload && typeof payload === 'object' ? payload : {}) as Record<string, any>;
  const numbers = new Set<number>();
  const shas = new Set<string>();
  const addNumber = (value: unknown) => {
    if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) numbers.add(value);
  };
  const addSha = (value: unknown) => {
    if (typeof value === 'string' && SHA40.test(value)) shas.add(value);
  };
  if (event === 'pull_request' || event === 'pull_request_review') {
    addNumber(body.pull_request?.number);
    addSha(body.pull_request?.head?.sha);
  } else if (event === 'check_run' || event === 'check_suite') {
    const of = event === 'check_run' ? body.check_run : body.check_suite;
    for (const pr of Array.isArray(of?.pull_requests) ? of.pull_requests : []) addNumber(pr?.number);
    addSha(of?.head_sha);
  } else if (event === 'status') {
    addSha(body.sha);
  }
  return {
    action: typeof body.action === 'string' ? body.action.slice(0, 100) : null,
    installationId: idOf(body.installation?.id),
    repoId: idOf(body.repository?.id),
    pullNumbers: [...numbers],
    headShas: [...shas],
    pushedRef: event === 'push' && typeof body.ref === 'string' ? body.ref : null,
  };
}

/** What became of one delivery. */
export type DeliveryOutcome = 'ACCEPTED' | 'DUPLICATE' | 'DROPPED';

/**
 * GitHub's webhook deliveries (docs/design/protected-branch-landing.md §4.7, D3). The signature is checked over the raw
 * bytes against the saved secret; a delivery is stored by GitHub's delivery id, so a redelivery is a no-op; a delivery
 * about an installation or a repository Orbit does not know is dropped. What is stored is the doorbell, not the
 * payload: the pull requests it is about are read again from GitHub after the 202, and only that read decides anything.
 */
@Injectable()
export class GithubWebhookService {
  private readonly logger = new Logger('GithubWebhook');

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: GithubAppConfigService,
    private readonly grants: GithubInstallationGrants,
    private readonly door: PullRequestDoorService,
  ) {}

  /** Checks and records one delivery, and answers which rows its re-read is for; the caller reads them after the 202. */
  async receive(input: {
    deliveryId: string | undefined;
    event: string | undefined;
    signature: string | undefined;
    rawBody: Buffer | undefined;
  }): Promise<{ outcome: DeliveryOutcome; reread: string[] }> {
    const secret = await this.config.webhookSecret();
    if (!secret) throw new NotFoundException({ code: 'GITHUB_WEBHOOK_NOT_SET_UP', message: 'No webhook secret is saved on this Orbit.' });
    const body = input.rawBody;
    if (!body || !githubSignatureValid(secret, body, input.signature)) {
      throw new UnauthorizedException({ code: 'GITHUB_WEBHOOK_SIGNATURE', message: 'The delivery is not signed with the saved secret.' });
    }
    if (body.length > GITHUB_WEBHOOK_MAX_BYTES) {
      throw new HttpException({ code: 'GITHUB_WEBHOOK_TOO_LARGE', message: 'The delivery is too large.' }, 413);
    }
    const deliveryId = (input.deliveryId ?? '').trim();
    const event = (input.event ?? '').trim();
    if (deliveryId === '' || deliveryId.length > 100 || event === '' || event.length > 100) {
      throw new HttpException({ code: 'GITHUB_WEBHOOK_HEADERS', message: 'A delivery names its id and its event.' }, 400);
    }
    let payload: unknown;
    try {
      payload = JSON.parse(body.toString('utf8'));
    } catch {
      throw new HttpException({ code: 'GITHUB_WEBHOOK_BODY', message: 'The delivery is not JSON.' }, 400);
    }
    const about = deliveryAbout(event, payload);
    if (!(await this.knows(about))) return { outcome: 'DROPPED', reread: [] };
    const stored = await this.prisma.githubWebhookDelivery.createMany({
      data: [{
        id: deliveryId,
        event,
        action: about.action,
        installationId: about.installationId,
        githubRepoId: about.repoId,
        pullNumber: about.pullNumbers[0] ?? null,
      }],
      skipDuplicates: true,
    });
    if (stored.count === 0) return { outcome: 'DUPLICATE', reread: [] };
    // §10 step 3: the installation's owner accepted new permissions, so what it granted is read again.
    if (event === 'installation' && about.installationId !== null) this.grants.forget(about.installationId.toString());
    return { outcome: 'ACCEPTED', reread: await this.rowsAbout(about) };
  }

  /** After the 202: read each pull request the delivery is about again, then mark the delivery applied. */
  async applyAfterResponse(deliveryId: string, rows: readonly string[]): Promise<void> {
    try {
      await this.door.advance(rows);
      await this.prisma.githubWebhookDelivery.updateMany({ where: { id: deliveryId, appliedAt: null }, data: { appliedAt: new Date() } });
    } catch (error) {
      this.logger.warn(`delivery ${deliveryId} not applied: ${(error as Error)?.message}`);
    }
  }

  /** An installation or a repository one of this Orbit's workspaces was cloned through. */
  private async knows(about: DeliveryAbout): Promise<boolean> {
    if (about.repoId === null && about.installationId === null) return false;
    const known = await this.prisma.workspace.count({
      where: about.repoId !== null ? { githubRepoId: about.repoId } : { githubInstallationId: about.installationId },
    });
    return known > 0;
  }

  /** The open pull requests a delivery is about: by number, by head commit, or every one into a pushed base. */
  private async rowsAbout(about: DeliveryAbout): Promise<string[]> {
    if (about.repoId === null) return [];
    if (about.pullNumbers.length === 0 && about.headShas.length === 0 && about.pushedRef === null) return [];
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "github_pull_request"
       WHERE "github_repo_id" = ${about.repoId}
         AND "state" IN ('OPENING', 'OPEN')
         AND ("number" = ANY(${about.pullNumbers}::int[])
              OR "head_sha" = ANY(${about.headShas}::text[])
              OR "base_ref" = ${about.pushedRef ?? ''})
       ORDER BY "id"
       LIMIT 50`);
    return rows.map((row) => row.id);
  }
}

/**
 * `POST /api/integrations/github/webhook`: GitHub's deliveries. No session and no token — the signature is the
 * credential — and the answer is 202 at once; the re-read happens after it (§8).
 */
@Controller('integrations/github')
export class GithubWebhookController {
  constructor(private readonly webhooks: GithubWebhookService) {}

  @Post('webhook')
  @HttpCode(202)
  async receive(
    @Req() req: RawBodyRequest,
    @Headers('x-github-delivery') deliveryId?: string,
    @Headers('x-github-event') event?: string,
    @Headers('x-hub-signature-256') signature?: string,
  ): Promise<{ outcome: DeliveryOutcome }> {
    const received = await this.webhooks.receive({ deliveryId, event, signature, rawBody: req.rawBody });
    if (received.reread.length > 0) {
      setImmediate(() => void this.webhooks.applyAfterResponse((deliveryId ?? '').trim(), received.reread));
    }
    return { outcome: received.outcome };
  }
}
