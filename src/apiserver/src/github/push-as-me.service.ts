import { ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { PushAsMeRefusalView, RunnerGitCredentialAnswer, SessionMergeResultRequest } from '@orbit/shared';
import { storedRefusal } from '../projects/pull-request-landing';
import { PrismaService } from '../prisma/prisma.service';
import { PushService } from '../push/push.service';
import { GithubConnectionService, type OwnerTokenRetirement } from './github-connection.service';
import { GITHUB_GIT_HOST, GithubWorkspaceService, githubRepoPath } from './github-workspace.service';

/** What a PUSH_AS_ME request names (docs/design/protected-branch-landing.md §5.2): one landing's push. */
export interface PushAsMeRequest {
  workspaceId: string;
  host: string;
  path: string;
  jobId?: string;
  claimGeneration?: string;
  leaseOwner?: string;
  sessionId?: string;
  mergeOperationId?: string;
}

/** The code every refusal of the owner's token carries, with a sentence the runner quotes in the fallback (§5.4 step 7). */
export const PUSH_AS_ME_REFUSED = 'PUSH_AS_ME_REFUSED';
/** A second request for the same claim generation or merge operation (§5.3). */
export const PUSH_AS_ME_ALREADY_ANSWERED = 'PUSH_AS_ME_ALREADY_ANSWERED';

/** The owner is told this the first time GitHub refuses a Push as me push on a workspace (§11.3). */
export const FIRST_REFUSAL_ALERT = 'GitHub refused a push as you';

/** The owner is told this when a second request is refused (§5.3, §11.3). */
export const SECOND_REQUEST_ALERT = 'Orbit refused a second request for your GitHub token during a landing';

/** How long this process remembers a token it handed out, for its retirement: a user token's own lifetime. */
export const HANDED_TOKEN_MEMORY_MS = 8 * 3_600_000;

const jobKey = (jobId: string, generation: bigint | string) => `job:${jobId}:${generation}`;
const mergeKey = (sessionId: string, operationId: string) => `merge:${sessionId}:${operationId}`;

const refused = (message: string) => new ForbiddenException({ code: PUSH_AS_ME_REFUSED, message });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GENERATION = /^[0-9]{1,18}$/;

/**
 * Push as me's credential door (docs/design/protected-branch-landing.md §5.2): `POST /runner/git-credential` with
 * `purpose: 'PUSH_AS_ME'`. The owner's own GitHub user token is answered only at one landing's push boundary, to the
 * runner and lease that hold it, for the workspace's own repository, and once per claim generation or merge operation:
 *
 *   - an integration job: RUNNING under this runner and lease at the named generation, handed out as PUSH_AS_ME, whose
 *     synchronous PUSH report was accepted for that generation (`push_reported_generation`), in this workspace;
 *   - a session's Merge: the operation this runner and lease hold (`merge_operation_id`, `merge_operation_owner`) on a
 *     session of this workspace, whose landing setting is PUSH_AS_ME.
 *
 * "Once" is a compare-and-set on the attempt's own row (`owner_token_generation`, `merge_owner_token_for`), taken before
 * the token is read: a second request is refused, recorded and announced to the owner, and the runner whose request
 * lost then falls back to a pull request. The token is never cached here, logged or put in an error.
 */
@Injectable()
export class PushAsMeService {
  private readonly log = new Logger('PushAsMe');
  /**
   * The token each attempt was handed, by attempt, until it is retired (§16 Q1). Only a hint: the retirement revokes
   * the token stored before its refresh, which is the one handed out unless something rotated it meanwhile, and this
   * names that other one too. Kept for a token's lifetime at most, and in this process only.
   */
  private readonly handed = new Map<string, { token: string; at: number }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly workspaces: GithubWorkspaceService,
    private readonly connections: GithubConnectionService,
    @Optional() private readonly push?: PushService,
  ) {}

  async ownerCredential(runner: { id: string; ownerId: string }, input: PushAsMeRequest): Promise<RunnerGitCredentialAnswer> {
    if (input.host.trim().toLowerCase() !== GITHUB_GIT_HOST) throw refused(`Orbit answers git credentials for ${GITHUB_GIT_HOST} only.`);
    const leaseOwner = (input.leaseOwner ?? '').trim();
    if (!UUID.test(leaseOwner)) throw refused('A Push as me request names the lease it holds.');
    const workspace = await this.prisma.workspace.findFirst({
      where: { id: input.workspaceId, runnerId: runner.id, ownerId: runner.ownerId, deletedAt: null },
      select: { id: true, ownerId: true, githubRepoId: true, landingMode: true },
    });
    if (!workspace) throw new NotFoundException({ code: 'WORKSPACE_NOT_FOUND', message: 'No workspace of this runner by that id.' });
    if (!workspace.githubRepoId) {
      throw new ConflictException({ code: 'WORKSPACE_NOT_FROM_GITHUB', message: 'This workspace was not cloned from GitHub: Orbit holds no credential for it.' });
    }
    const forJob = input.jobId !== undefined;
    if (forJob === (input.sessionId !== undefined)) throw refused('A Push as me request names one landing: a job or a session\'s Merge.');
    // The attempt first, so a request for no live attempt says so before GitHub is asked anything.
    const target = forJob
      ? await this.jobAttempt(runner, workspace.id, leaseOwner, input)
      : await this.mergeAttempt(runner, workspace, leaseOwner, input);
    const fullName = await this.workspaces.repositoryFullName(workspace.ownerId, workspace.githubRepoId.toString());
    if (githubRepoPath(input.path) !== fullName.toLowerCase()) throw refused('That path is not this workspace\'s repository.');
    // Once per attempt: the compare-and-set comes before the token is read, so two racing requests cannot both get it.
    const won = forJob ? await this.takeJob(target.id, leaseOwner, target.generation as bigint) : await this.takeMerge(target.id, leaseOwner, target.operation as string);
    if (!won) {
      await this.secondRequest(runner.ownerId, forJob ? `integration job ${target.id} claim ${target.generation}` : `session ${target.id} merge ${target.operation}`);
      throw new ConflictException({
        code: PUSH_AS_ME_ALREADY_ANSWERED,
        message: 'Orbit already answered your GitHub token for this landing, so it refused a second request.',
      });
    }
    const token = await this.connections.ownerPushToken(workspace.ownerId).catch((error: unknown) => {
      if (error instanceof ConflictException) throw refused('Your GitHub account is not connected to Orbit any more: connect GitHub again.');
      throw error;
    });
    this.log.log(`owner's GitHub token answered for ${forJob ? `integration job ${target.id} claim ${target.generation}` : `session ${target.id} merge ${target.operation}`}`);
    this.remember(forJob ? jobKey(target.id, target.generation as bigint) : mergeKey(target.id, target.operation as string), token.token);
    return { username: 'x-access-token', password: token.token, expiresAt: token.expiresAt.toISOString() };
  }

  /** The integration job a request names, as §5.2 requires it to stand. */
  private async jobAttempt(runner: { id: string; ownerId: string }, workspaceId: string, leaseOwner: string, input: PushAsMeRequest) {
    const jobId = input.jobId ?? '';
    const generation = input.claimGeneration ?? '';
    if (!UUID.test(jobId) || !GENERATION.test(generation)) throw refused('A Push as me request names its job and claim generation.');
    const [job] = await this.prisma.$queryRaw<Array<{
      id: string; state: string; kind: string; landVia: string | null; runnerId: string | null; leaseOwner: string | null;
      claimGeneration: bigint; pushReportedGeneration: bigint | null; workspaceId: string | null;
    }>>(Prisma.sql`
      SELECT j."id", j."state", j."kind", j."land_via" AS "landVia", j."runner_id" AS "runnerId",
             j."claim_lease_owner" AS "leaseOwner", j."claim_generation" AS "claimGeneration",
             j."push_reported_generation" AS "pushReportedGeneration", s."workspace_id" AS "workspaceId"
        FROM "project_integration_job" j
        LEFT JOIN "session" s ON s."id" = j."session_id"
       WHERE j."id" = ${jobId}::uuid AND j."owner_id" = ${runner.ownerId}::uuid`);
    const gen = BigInt(generation);
    if (!job || job.workspaceId !== workspaceId) throw refused('That landing is not one of this workspace\'s.');
    if (job.kind !== 'LAND_TASK' && job.kind !== 'LAND_PROMOTION') throw refused('Only a landing pushes as you.');
    if (job.state !== 'RUNNING' || job.runnerId !== runner.id || job.leaseOwner !== leaseOwner || job.claimGeneration !== gen) {
      throw refused('This runner does not hold that landing\'s claim.');
    }
    if (job.landVia !== 'PUSH_AS_ME') throw refused('That landing was not handed out to push as you.');
    if (job.pushReportedGeneration !== gen) throw refused('That landing has not reached its push yet.');
    return { id: job.id, generation: gen, operation: null as string | null };
  }

  /** The session Merge a request names, as §5.2 requires it to stand. */
  private async mergeAttempt(
    runner: { id: string; ownerId: string },
    workspace: { id: string; landingMode: string | null },
    leaseOwner: string,
    input: PushAsMeRequest,
  ) {
    const sessionId = input.sessionId ?? '';
    const operation = input.mergeOperationId ?? '';
    if (!UUID.test(sessionId) || !UUID.test(operation)) throw refused('A Push as me request names its session and merge operation.');
    const session = await this.prisma.session.findFirst({
      where: { id: sessionId, ownerId: runner.ownerId },
      select: { id: true, workspaceId: true, mergeStatus: true, mergeOperationId: true, mergeOperationOwner: true, mergeRecoveryAction: true },
    });
    if (!session || session.workspaceId !== workspace.id) throw refused('That Merge is not one of this workspace\'s.');
    if (session.mergeOperationId !== operation || session.mergeOperationOwner !== leaseOwner || session.mergeStatus !== 'pending') {
      throw refused('This runner does not hold that Merge.');
    }
    if (session.mergeRecoveryAction) throw refused('A merge recovery pushes with Orbit\'s own credential.');
    if (workspace.landingMode !== 'PUSH_AS_ME') throw refused('Push as me is off for this workspace.');
    return { id: session.id, generation: null as bigint | null, operation };
  }

  private async takeJob(jobId: string, leaseOwner: string, generation: bigint): Promise<boolean> {
    const taken = await this.prisma.projectIntegrationJob.updateMany({
      where: {
        id: jobId, state: 'RUNNING', claimLeaseOwner: leaseOwner, claimGeneration: generation, landVia: 'PUSH_AS_ME',
        pushReportedGeneration: generation,
        OR: [{ ownerTokenGeneration: null }, { ownerTokenGeneration: { not: generation } }],
      },
      data: { ownerTokenGeneration: generation },
    });
    return taken.count === 1;
  }

  private async takeMerge(sessionId: string, leaseOwner: string, operation: string): Promise<boolean> {
    const taken = await this.prisma.session.updateMany({
      where: {
        id: sessionId, mergeOperationId: operation, mergeOperationOwner: leaseOwner, mergeStatus: 'pending',
        OR: [{ mergeOwnerTokenFor: null }, { mergeOwnerTokenFor: { not: operation } }],
      },
      data: { mergeOwnerTokenFor: operation },
    });
    return taken.count === 1;
  }

  /**
   * After a committed integration job result (§5.4 steps 4 and 6, §5.5): a Push as me landing GitHub accepted clears
   * the workspace's last refusal; one that fell back to a pull request records the refusal there, in the words the
   * pull request row kept, and the first refusal on a workspace is announced. Never throws: it is a display fact.
   */
  async afterJobResult(jobId: string): Promise<OwnerTokenRetirement | null> {
    let retirement: OwnerTokenRetirement | null = null;
    try {
      const job = await this.prisma.projectIntegrationJob.findUnique({
        where: { id: jobId },
        select: {
          ownerId: true, landVia: true, state: true, kind: true, targetRef: true, upstreamRef: true, sessionId: true,
          pullRequestId: true, claimGeneration: true, ownerTokenGeneration: true,
        },
      });
      if (!job || job.landVia !== 'PUSH_AS_ME') return null;
      // §16 Q1: the push this claim was handed the owner's token for has reported back, whatever it came to.
      if (job.ownerTokenGeneration !== null && job.ownerTokenGeneration === job.claimGeneration) {
        retirement = await this.retire(job.ownerId, jobKey(jobId, job.claimGeneration), `integration job ${jobId} claim ${job.claimGeneration}`);
      }
      if (!job.sessionId) return retirement;
      const session = await this.prisma.session.findUnique({ where: { id: job.sessionId }, select: { workspaceId: true } });
      const branch = (job.kind === 'LAND_PROMOTION' ? job.upstreamRef : job.targetRef).replace(/^refs\/heads\//, '');
      if (!session?.workspaceId) return retirement;
      if (job.state === 'LANDED' && job.pullRequestId === null) {
        await this.clearRefusal(session.workspaceId);
        return retirement;
      }
      if (job.state !== 'PULL_REQUEST' || !job.pullRequestId) return retirement;
      const pr = await this.prisma.githubPullRequest.findUnique({ where: { id: job.pullRequestId }, select: { refusal: true } });
      const refusal = pr?.refusal as { via?: unknown; message?: unknown } | null | undefined;
      if (refusal?.via !== 'PUSH_AS_ME' || typeof refusal.message !== 'string') return retirement;
      await this.recordRefusal(session.workspaceId, branch, refusal.message);
    } catch (error) {
      this.log.warn(`Push as me outcome of job ${jobId} not recorded: ${(error as Error)?.message}`);
    }
    return retirement;
  }

  /** The same for a session's Merge (§4.6), from the result the runner reported. */
  async afterMergeResult(sessionId: string, dto: SessionMergeResultRequest): Promise<OwnerTokenRetirement | null> {
    let retirement: OwnerTokenRetirement | null = null;
    try {
      const session = await this.prisma.session.findUnique({
        where: { id: sessionId }, select: { ownerId: true, workspaceId: true, mergeOwnerTokenFor: true },
      });
      if (!session) return null;
      // §16 Q1: the Merge this operation was handed the owner's token for has reported back, whatever it came to.
      const operation = dto.operationId ?? null;
      if (operation !== null && session.mergeOwnerTokenFor === operation) {
        retirement = await this.retire(session.ownerId, mergeKey(sessionId, operation), `session ${sessionId} merge ${operation}`);
      }
      if (dto.landVia !== 'PUSH_AS_ME' || !session.workspaceId) return retirement;
      if (dto.status === 'merged' && dto.pushedAs === 'OWNER') {
        await this.clearRefusal(session.workspaceId);
      } else if (dto.status === 'pull_request') {
        const message = storedRefusal(dto.pushRefusal);
        if (message) await this.recordRefusal(session.workspaceId, (dto.targetBranch ?? '').trim() || 'main', message);
      }
    } catch (error) {
      this.log.warn(`Push as me outcome of session ${sessionId}'s merge not recorded: ${(error as Error)?.message}`);
    }
    return retirement;
  }

  /**
   * §16 Q1: retire the token one attempt was handed — the connection refreshed, then the old token revoked — once.
   * A failure is recorded (logged with the attempt) and changes nothing else: the landing has already ended as it
   * ended, the connection stays, and the attempt's own row still refuses a second handout.
   */
  private async retire(ownerId: string, key: string, what: string): Promise<OwnerTokenRetirement | null> {
    const handed = this.handed.get(key);
    if (handed === undefined && this.retiredKeys.has(key)) return null;
    this.handed.delete(key);
    this.retiredKeys.add(key);
    const retirement = await this.connections.retireOwnerToken(ownerId, handed?.token ?? null);
    if (retirement.failure) {
      this.log.warn(`the owner's GitHub token for ${what} was not fully retired (refreshed: ${retirement.refreshed}, revoked: ${retirement.revoked}): ${retirement.failure}`);
    } else {
      this.log.log(`the owner's GitHub token for ${what} was retired: the connection refreshed and ${retirement.revoked} token(s) revoked`);
    }
    return retirement;
  }

  /** The attempts this process already retired a token for: a result sent twice retires once. */
  private readonly retiredKeys = new Set<string>();

  private remember(key: string, token: string): void {
    const now = Date.now();
    for (const [held, entry] of this.handed) if (now - entry.at > HANDED_TOKEN_MEMORY_MS) this.handed.delete(held);
    if (this.retiredKeys.size > 10_000) this.retiredKeys.clear();
    this.handed.set(key, { token, at: now });
  }

  private async clearRefusal(workspaceId: string): Promise<void> {
    await this.prisma.workspace.updateMany({
      where: { id: workspaceId, NOT: { pushAsMeRefusal: { equals: Prisma.AnyNull } } },
      data: { pushAsMeRefusal: Prisma.DbNull },
    });
  }

  /** Records the refusal on the workspace; the first one on a workspace with none recorded is announced. */
  private async recordRefusal(workspaceId: string, branch: string, message: string): Promise<void> {
    const at = new Date();
    const view: PushAsMeRefusalView = { at: at.toISOString(), branch, message };
    const first = await this.prisma.workspace.updateMany({
      where: { id: workspaceId, pushAsMeRefusal: { equals: Prisma.AnyNull } },
      data: { pushAsMeRefusal: view as unknown as Prisma.InputJsonValue },
    });
    if (first.count === 0) {
      await this.prisma.workspace.updateMany({ where: { id: workspaceId }, data: { pushAsMeRefusal: view as unknown as Prisma.InputJsonValue } });
      return;
    }
    const workspace = await this.prisma.workspace.findUnique({ where: { id: workspaceId }, select: { ownerId: true, name: true } });
    if (!workspace) return;
    await this.push?.notifyOwner(workspace.ownerId, {
      title: FIRST_REFUSAL_ALERT,
      message: `${workspace.name}: GitHub refused the push to ${branch}, so Orbit opened a pull request instead. "${message.slice(0, 200)}"`,
      priority: 'normal',
    }).catch((error: unknown) => this.log.warn(`first-refusal alert not sent: ${(error as Error)?.message}`));
  }

  /** §5.3: a second request is refused, recorded and announced. The record is the log line and the owner's alert. */
  private async secondRequest(ownerId: string, what: string): Promise<void> {
    this.log.warn(`refused a second request for the owner's GitHub token: ${what}`);
    await this.push?.notifyOwner(ownerId, {
      title: SECOND_REQUEST_ALERT,
      message: 'The landing opens a pull request instead. If no landing of yours was retrying, disconnect GitHub in Settings and connect it again.',
      priority: 'high',
    }).catch((error: unknown) => this.log.warn(`second-request alert not sent: ${(error as Error)?.message}`));
  }
}
