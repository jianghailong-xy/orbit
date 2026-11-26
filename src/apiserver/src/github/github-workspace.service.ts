import {
  BadGatewayException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { CloneReport, CloneRequest, RunnerGitCredentialAnswer, WorkspaceCloneState } from '@orbit/shared';
import { redactSecrets } from '../common/secret-redaction';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { turnStateFilter } from '../sessions/session-turn-state';
import { GithubCallError, GithubClient } from './github-api.client';
import { GithubAppConfigService } from './github-app-config.service';
import { GithubConnectionService } from './github-connection.service';

/** The one host a git credential is answered for (docs/github-workspace-design.md §5.4). */
export const GITHUB_GIT_HOST = 'github.com';
/** A cached installation token is handed out again until this long before it expires (§5.4). */
export const INSTALLATION_TOKEN_REUSE_MARGIN_MS = 5 * 60_000;
/** How long one check that the owner can still see the repository on GitHub holds (§5.4). */
export const GITHUB_ACCESS_RECHECK_MS = 10 * 60_000;
/** The longest clone error kept, after redaction. */
export const CLONE_ERROR_MAX = 500;
/** The most clone requests one heartbeat answer carries. */
export const CLONE_REQUESTS_MAX = 50;

const CLONE_REPORT_STATES = new Set(['CLONING', 'READY', 'FAILED']);

/** `https://github.com/<owner>/<name>.git`: a GitHub workspace's repoUrl, without any credential. */
export function githubRepoUrl(fullName: string): string {
  return `https://${GITHUB_GIT_HOST}/${fullName}.git`;
}

/** `owner/name` out of what git asks about: a leading slash and a trailing `.git` or slash are not part of it. */
export function githubRepoPath(path: string): string {
  return path.trim().replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/i, '').toLowerCase();
}

const workspaceNotFound = () => new NotFoundException({ code: 'WORKSPACE_NOT_FOUND', message: 'No workspace of this runner by that id.' });
const credentialRefused = (message: string) => new ForbiddenException({ code: 'GIT_CREDENTIAL_REFUSED', message });
const repoForbidden = () =>
  new ForbiddenException({ code: 'GITHUB_REPO_FORBIDDEN', message: 'Your GitHub account cannot reach that repository through Orbit\'s GitHub App.' });
const unavailable = () => new BadGatewayException({ code: 'GITHUB_UNAVAILABLE', message: "GitHub didn't answer. Try again in a moment." });

interface CachedToken {
  token: string;
  expiresAt: Date;
}

interface AccessCheck {
  at: number;
  fullName: string;
  installationId: string;
}

/**
 * The control plane's side of a GitHub workspace once it is made (docs/github-workspace-design.md §5.3, §5.4, §6, §7):
 * the installation tokens the runner's own git commands use, the clone each runner is asked for and reports on, and
 * the owner's Retry.
 *
 * Tokens live in this process's memory and nowhere else: not in the database, not in a log, not in an error. One is
 * minted for one repository (`repository_ids: [repoId]`) with contents:write and metadata:read, handed only to the
 * runner the workspace is on, and handed again until five minutes before it expires.
 */
@Injectable()
export class GithubWorkspaceService {
  private readonly log = new Logger('GithubWorkspace');
  /** `<installationId>:<repoId>` → the token minted for that repository alone. */
  private readonly tokens = new Map<string, CachedToken>();
  private readonly minting = new Map<string, Promise<CachedToken>>();
  /** `<ownerId>:<repoId>` → the last time GitHub said the owner can see it, and what it is called now. */
  private readonly access = new Map<string, AccessCheck>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: GithubAppConfigService,
    private readonly connections: GithubConnectionService,
    private readonly github: GithubClient,
    private readonly realtime: RealtimeService,
  ) {}

  /**
   * POST /runner/git-credential (§5.4). Answered only when every one of these holds, in this order:
   *   - the workspace is a live workspace on the calling runner (another runner's — the same account's included —,
   *     another account's, a deleted one and one that does not exist are the same 404), and it was cloned from GitHub
   *     (409 WORKSPACE_NOT_FROM_GITHUB otherwise);
   *   - `host` is github.com;
   *   - GitHub is set up, the owner's connection is one GitHub takes, and within the last ten minutes GitHub said the
   *     owner can see the repository (read again otherwise, with the owner's own user token);
   *   - `path` is that repository as GitHub calls it now, found by its id, so a rename keeps working.
   * Then an installation token for that repository alone.
   */
  async gitCredential(runner: { id: string; ownerId: string }, input: { workspaceId: string; host: string; path: string }): Promise<RunnerGitCredentialAnswer> {
    const workspace = await this.prisma.workspace.findFirst({
      where: { id: input.workspaceId, runnerId: runner.id, ownerId: runner.ownerId, deletedAt: null },
      select: { id: true, ownerId: true, githubRepoId: true },
    });
    if (!workspace) throw workspaceNotFound();
    if (!workspace.githubRepoId) {
      throw new ConflictException({ code: 'WORKSPACE_NOT_FROM_GITHUB', message: 'This workspace was not cloned from GitHub: Orbit holds no credential for it.' });
    }
    if (input.host.trim().toLowerCase() !== GITHUB_GIT_HOST) throw credentialRefused(`Orbit answers git credentials for ${GITHUB_GIT_HOST} only.`);
    const repoId = workspace.githubRepoId.toString();
    const app = await this.config.credentials();
    if (!app) {
      throw new ConflictException({ code: 'GITHUB_NOT_CONFIGURED', message: 'GitHub is not set up on this Orbit. Ask an administrator.' });
    }
    const seen = await this.ownerSees(workspace.ownerId, repoId);
    if (githubRepoPath(input.path) !== seen.fullName.toLowerCase()) {
      throw credentialRefused('That path is not this workspace\'s repository.');
    }
    const token = await this.installationToken(app, seen.installationId, repoId, seen.fullName);
    return { username: 'x-access-token', password: token.token, expiresAt: token.expiresAt.toISOString() };
  }

  /** The repository `repoId` as GitHub calls it now, when the owner can see it (§5.4's access check, shared by Push as
   *  me's credential door). */
  async repositoryFullName(ownerId: string, repoId: string): Promise<string> {
    return (await this.ownerSees(ownerId, repoId)).fullName;
  }

  /** The owner can see the repository on GitHub, as GitHub said within the last ten minutes. */
  private async ownerSees(ownerId: string, repoId: string): Promise<AccessCheck> {
    const key = `${ownerId}:${repoId}`;
    const held = this.access.get(key);
    if (held && Date.now() - held.at < GITHUB_ACCESS_RECHECK_MS) return held;
    this.access.delete(key);
    const repo = await this.connections.reachableRepository(ownerId, repoId, { fresh: true });
    if (!repo) throw repoForbidden();
    const check = { at: Date.now(), fullName: repo.fullName, installationId: String(repo.installationId) };
    this.access.set(key, check);
    return check;
  }

  private async installationToken(
    app: { appId: string; privateKey: string },
    installationId: string,
    repoId: string,
    fullName: string,
  ): Promise<CachedToken> {
    const key = `${installationId}:${repoId}`;
    const cached = this.tokens.get(key);
    if (cached && cached.expiresAt.getTime() - INSTALLATION_TOKEN_REUSE_MARGIN_MS > Date.now()) return cached;
    let pending = this.minting.get(key);
    if (!pending) {
      pending = this.github
        .installationToken({ appId: app.appId, privateKey: app.privateKey, installationId, repoId })
        .then((minted) => {
          this.tokens.set(key, minted);
          return minted;
        })
        .catch((error: unknown) => {
          this.tokens.delete(key);
          if (error instanceof GithubCallError && (error.status === 404 || error.status === 422 || error.status === 403)) {
            throw new ConflictException({
              code: 'GITHUB_APP_NOT_INSTALLED',
              message: `Orbit's GitHub App is no longer installed on ${fullName}. Install it again or pick another repository.`,
            });
          }
          // The error's status only: a GitHub answer can quote what it was sent.
          this.log.warn(`installation token for repository ${repoId} not minted: ${error instanceof GithubCallError ? error.status : (error as Error)?.name}`);
          throw unavailable();
        })
        .finally(() => this.minting.delete(key));
      this.minting.set(key, pending);
    }
    return pending;
  }

  /**
   * `cloneRequests` (§5.4): every PENDING and CLONING GitHub workspace of the runner, for a runner that declared
   * clone-workdir/v1. Read on every full reconcile, so the list is the whole truth each time.
   */
  async cloneRequestsFor(runnerId: string): Promise<CloneRequest[]> {
    const rows = await this.prisma.workspace.findMany({
      where: { runnerId, deletedAt: null, githubRepoId: { not: null }, cloneState: { in: ['PENDING', 'CLONING'] }, workDir: { not: null } },
      select: { id: true, workDir: true, repoUrl: true, cloneRef: true, cloneState: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: CLONE_REQUESTS_MAX,
    });
    return rows
      .filter((row) => !!row.repoUrl && !!row.workDir)
      .map((row) => ({
        workspaceId: row.id,
        workDir: row.workDir as string,
        url: row.repoUrl as string,
        ref: row.cloneRef,
        state: row.cloneState as 'PENDING' | 'CLONING',
      }));
  }

  /**
   * `cloneReports` (§5.4): each moves its workspace's clone state, for this runner's own GitHub workspaces only.
   *   PENDING → CLONING, READY or FAILED; CLONING → READY or FAILED; a CLONING report on a CLONING row is progress.
   * READY and FAILED are where a clone ends: a report about either changes nothing (only Retry moves FAILED on).
   * Progress is relayed to the owner's clients and never stored. Answers how many rows moved.
   */
  async applyCloneReports(runner: { id: string; ownerId: string }, reports: unknown): Promise<number> {
    if (!Array.isArray(reports)) return 0;
    let moved = 0;
    for (const report of reports.slice(0, CLONE_REQUESTS_MAX) as Array<Partial<CloneReport>>) {
      if (!report || typeof report !== 'object' || typeof report.workspaceId !== 'string') continue;
      if (typeof report.state !== 'string' || !CLONE_REPORT_STATES.has(report.state)) continue;
      if (!/^[0-9a-f-]{36}$/i.test(report.workspaceId)) continue;
      const progress = typeof report.progress === 'number' && Number.isFinite(report.progress)
        ? Math.max(0, Math.min(100, Math.round(report.progress)))
        : null;
      const now = new Date();
      const where = { id: report.workspaceId, runnerId: runner.id, ownerId: runner.ownerId, deletedAt: null, githubRepoId: { not: null } };
      let count = 0;
      if (report.state === 'CLONING') {
        count = (await this.prisma.workspace.updateMany({
          where: { ...where, cloneState: 'PENDING' },
          data: { cloneState: 'CLONING', cloneStartedAt: now, cloneError: null },
        })).count;
      } else if (report.state === 'READY') {
        count = (await this.prisma.workspace.updateMany({
          where: { ...where, cloneState: { in: ['PENDING', 'CLONING'] } },
          data: {
            cloneState: 'READY', cloneFinishedAt: now, cloneError: null,
            // Which credential it used (§6 step 4), for Settings → GitHub; a report that names none leaves it unknown.
            ...(report.credential === 'machine' || report.credential === 'github-app' ? { cloneCredential: report.credential } : {}),
          },
        })).count;
      } else {
        const said = typeof report.error === 'string' && report.error.trim() !== '' ? report.error.trim() : 'The clone failed.';
        count = (await this.prisma.workspace.updateMany({
          where: { ...where, cloneState: { in: ['PENDING', 'CLONING'] } },
          data: { cloneState: 'FAILED', cloneFinishedAt: now, cloneError: redactSecrets(said).text.slice(0, CLONE_ERROR_MAX) },
        })).count;
      }
      moved += count;
      if (count > 0) {
        await this.announce(runner.ownerId, report.workspaceId, report.state as WorkspaceCloneState, progress);
      } else if (report.state === 'CLONING' && progress !== null) {
        // Progress on a clone already CLONING: relayed, never stored. Only for this runner's own CLONING workspace.
        const own = await this.prisma.workspace.count({ where: { ...where, cloneState: 'CLONING' } });
        if (own > 0) this.realtime.publishWorkspaceCloneChanged(runner.ownerId, report.workspaceId, { state: 'CLONING', progress });
      }
    }
    return moved;
  }

  /**
   * POST /workspaces/:id/clone/retry (§5.3): FAILED → PENDING, its error cleared, and the runner told. Another
   * account's workspace and a deleted one are 404; one of the caller's whose clone has not failed — one not from
   * GitHub included — is 409 CLONE_NOT_FAILED, with nothing written.
   */
  async retryClone(ownerId: string, workspaceId: string): Promise<{ id: string; cloneState: WorkspaceCloneState }> {
    const workspace = await this.prisma.workspace.findFirst({
      where: { id: workspaceId, ownerId, deletedAt: null },
      select: { id: true, runnerId: true, cloneState: true },
    });
    if (!workspace) throw new NotFoundException({ code: 'WORKSPACE_NOT_FOUND', message: 'No workspace of yours by that id.' });
    const { count } = await this.prisma.workspace.updateMany({
      where: { id: workspace.id, ownerId, deletedAt: null, cloneState: 'FAILED' },
      data: { cloneState: 'PENDING', cloneError: null, cloneStartedAt: null, cloneFinishedAt: null },
    });
    if (count === 0) {
      throw new ConflictException({ code: 'CLONE_NOT_FAILED', message: 'Only a clone that failed can be retried.' });
    }
    if (workspace.runnerId) this.realtime.markRunnerChanged(workspace.runnerId);
    await this.announce(ownerId, workspace.id, 'PENDING', null);
    return { id: workspace.id, cloneState: 'PENDING' };
  }

  /** A clone state moved: the owner's clients hear it, and the sessions it holds read their new queued reason. */
  private async announce(ownerId: string, workspaceId: string, state: WorkspaceCloneState, progress: number | null): Promise<void> {
    this.realtime.publishWorkspaceCloneChanged(ownerId, workspaceId, { state, progress });
    const held = await this.prisma.session.findMany({
      where: { workspaceId, ownerId, deletedAt: null, ...turnStateFilter(['QUEUED']) },
      select: { id: true },
      take: 100,
    });
    for (const session of held) this.realtime.publishSessionUpdated(session.id);
  }
}
