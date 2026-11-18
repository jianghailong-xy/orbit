import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * "Does the task's branch already carry the project line AND main?", asked of the repository.
 *
 * WHY. A landing that stopped at MAIN_SYNC conflicted absorbing the upstream into the project branch
 * (§3.1 M2). The answer is M3: a source branch that carries a merge of both tips. Once it does, the
 * runner's J-S2 branch ① skips the main sync and J-S4 lands the branch by MERGE — so running the
 * landing again is exactly right, and refusing Retry sent coordinators to `task_reopen` a task whose
 * work was already finished (2026-11-18, S3/S4 of the message-queueing project).
 *
 * WHAT IT MEASURES. The same three facts J-S2 ① reads, at this moment: the source tip S, the project
 * branch tip T0 and the upstream tip U, fetched by ref from the repository the work was pushed to.
 * BOTH means T0 and U are ancestors of S and S is not U itself (a branch sitting on main carries
 * nothing of its own — J-S2 does not count it as an absorb either).
 *
 * WHY `UNKNOWN` FAILS CLOSED. No git here, a repository this process cannot reach or read, a ref
 * that does not resolve, the budget spent: nobody measured anything, and the caller keeps the
 * refusal it gave before this existed. Like `main-tip-probe.ts`, the apiserver image this ships in
 * has no git, so there it answers UNKNOWN until git and read access to the repository are present.
 */
export type BranchTipsAnswer = 'BOTH' | 'MISSING' | 'UNKNOWN';

/** How long fetching three refs and two ancestry questions may take before the answer is UNKNOWN. */
export const BRANCH_TIPS_PROBE_BUDGET_MS = 30_000;

export interface BranchTipsRequest {
  /** A URL git can fetch from: the remote the task's work session pushed its branch to. */
  repoUrl: string;
  /** The task's work branch (`refs/heads/<branch>`). */
  sourceRef: string;
  /** The project line (`project_codebase.integration_ref`). */
  integrationRef: string;
  /** Main (`project_codebase.upstream_ref`). */
  upstreamRef: string;
  budgetMs?: number;
}

function git(args: readonly string[], deadline: number): Promise<{ code: number | null; stdout: string }> {
  const timeout = deadline - Date.now();
  if (timeout <= 0) return Promise.resolve({ code: null, stdout: '' });
  return new Promise((resolve) => {
    execFile('git', [...args], {
      timeout,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'true' },
    }, (error, stdout) => {
      const code = error == null
        ? 0
        : typeof (error as { code?: unknown }).code === 'number' ? (error as unknown as { code: number }).code : null;
      resolve({ code, stdout: stdout ?? '' });
    });
  });
}

export async function probeBranchCarriesTips(request: BranchTipsRequest): Promise<BranchTipsAnswer> {
  const deadline = Date.now() + (request.budgetMs ?? BRANCH_TIPS_PROBE_BUDGET_MS);
  let dir: string | null = null;
  try {
    dir = await mkdtemp(path.join(tmpdir(), 'orbit-branch-tips-'));
    if ((await git(['init', '--quiet', '--bare', dir], deadline)).code !== 0) return 'UNKNOWN';
    // One fetch, so the three tips are read from the same moment of the remote. Ancestry needs
    // commits only: `tree:0` leaves trees and blobs behind where the server allows filtering.
    const fetched = await git(['-C', dir, 'fetch', '--quiet', '--no-tags', '--filter=tree:0', request.repoUrl,
      `+${request.sourceRef}:refs/probe/source`,
      `+${request.integrationRef}:refs/probe/line`,
      `+${request.upstreamRef}:refs/probe/upstream`], deadline);
    if (fetched.code !== 0) return 'UNKNOWN';
    const tips = await git(['-C', dir, 'rev-parse', 'refs/probe/source', 'refs/probe/upstream'], deadline);
    if (tips.code !== 0) return 'UNKNOWN';
    const [source, upstream] = tips.stdout.trim().split('\n');
    if (!source || !upstream) return 'UNKNOWN';
    if (source === upstream) return 'MISSING';
    for (const tip of ['refs/probe/line', 'refs/probe/upstream']) {
      const ancestor = await git(['-C', dir, 'merge-base', '--is-ancestor', tip, 'refs/probe/source'], deadline);
      if (ancestor.code === 1) return 'MISSING';
      if (ancestor.code !== 0) return 'UNKNOWN';
    }
    return 'BOTH';
  } catch {
    return 'UNKNOWN';
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
