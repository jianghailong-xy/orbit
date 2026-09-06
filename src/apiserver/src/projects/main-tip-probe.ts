import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * "Is the same check also red at the default branch's tip?", answered by asking the repository and
 * running the check — not by reading a flag somebody set.
 *
 * WHY THIS IS AN EXECUTION AND NOT A LOOKUP
 * =========================================
 * On 2026-09-05 a person pushed eight tasks through by hand, and the single question that decided
 * whether a red was the task's own was "is `main` red here too?". They answered it by running the
 * failing check against `main`. That is the whole of the judgement: the answer is not stored
 * anywhere, no column carries it, and a boolean handed to a decision unit would be the answer
 * somebody had already made — the decision unit would be deciding nothing.
 *
 * So this unit resolves the tip from the repository the PROJECT is bound to (`project_codebase`,
 * the row that owns what a project's repository and its integration ref ARE), materialises that
 * exact commit, runs the check there, and reports what it exited with. Every input is a fact
 * outside this process: move the branch, or change what is on it, and the answer changes with no
 * code and no fixture touched.
 *
 * WHAT KEEPS IT AFFORDABLE
 * ========================
 * The check is the one the round ran — a task's own declared acceptance command — and NOT the
 * round it belongs to. That is the same narrowing a person does by hand (run the one spec, not the
 * whole suite), and it is why "really run it" is a second or two rather than a suite's worth of
 * wall clock. `budgetMs` is the hard end of it: this runs inside a post-commit delivery, which is
 * itself inside a runner's turn-complete, and a check that cannot answer inside its budget must
 * not hold that request open. It is killed and the answer is `UNKNOWN`.
 *
 * WHY `UNKNOWN` IS A FIRST-CLASS ANSWER
 * =====================================
 * There is no binding, the remote is unreachable, the ref does not resolve, the toolchain is not
 * here, the check outran its budget: all of them mean the same thing, which is that nobody asked
 * `main` anything. `UNKNOWN` says so, and `mechanical-disposition.ts` turns it into "this is not a
 * mechanical judgement" rather than into a guess. An honest non-answer is what a blocker is for; a
 * cheerful `GREEN` here would send a task back over a red that was never its own.
 *
 * The deployment this ships into is one of those cases and is stated rather than hidden: the
 * apiserver container has no git and no toolchain, so the probe answers `UNKNOWN` there until the
 * check is run where a checkout already exists. What that costs is one class of red staying a
 * person's decision, which is where it is today.
 */

/** What the same check answered at the tip of the project's integration ref. */
export type MainTipAnswer =
  /** It ran there and disagreed with the declaration too — this red is not the branch's. */
  | 'RED'
  /** It ran there and agreed with the declaration — the branch is where the red lives. */
  | 'GREEN'
  /** Nobody asked, or the asking did not finish. Not a guess in either direction. */
  | 'UNKNOWN';

/** How long the whole probe — resolve, materialise, run — may take before it is killed. */
export const MAIN_TIP_PROBE_BUDGET_MS = 30_000;

export interface MainTipProbeRequest {
  /** The repository's identity, from the project's primary codebase binding. */
  repoUrl: string;
  /** The ref whose tip counts, from the same binding: `integration_ref`. */
  ref: string;
  /** The check to run there — the same command the round ran. */
  command: string;
  /** The code that command's declaration calls agreement. */
  expectedExitCode: number;
  budgetMs?: number;
}

/** Run one command, bounded, and report what it exited with. `null` is "it did not report one". */
function run(
  file: string,
  args: readonly string[],
  options: { cwd?: string; timeoutMs: number },
): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    execFile(
      file,
      [...args],
      {
        cwd: options.cwd,
        timeout: options.timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        // A probe that stops to ask for a password is a probe that spends its whole budget
        // waiting: fail rather than prompt.
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'true' },
      },
      (error, stdout) => {
        const code = error == null
          ? 0
          // `code` is absent when the child was killed or never started; both are "no code".
          : typeof (error as { code?: unknown }).code === 'number'
            ? (error as unknown as { code: number }).code
            : null;
        resolve({ code, stdout: stdout ?? '' });
      },
    );
  });
}

/** Milliseconds left of the budget, or `null` once there are none. */
function remaining(deadline: number): number | null {
  const left = deadline - Date.now();
  return left > 0 ? left : null;
}

/**
 * Ask the repository what its integration ref points at right now.
 *
 * Separated from the run below because it is the half that makes this a question about `main`
 * rather than about whatever happens to be on disk: a stale checkout answers confidently and
 * wrongly, and this cannot, because it asks the repository every time.
 */
async function resolveTip(
  request: MainTipProbeRequest,
  deadline: number,
): Promise<string | null> {
  const budget = remaining(deadline);
  if (budget == null) return null;
  const listed = await run('git', ['ls-remote', request.repoUrl, request.ref], {
    timeoutMs: budget,
  });
  if (listed.code !== 0) return null;
  const sha = /^([0-9a-f]{40})\s/m.exec(listed.stdout)?.[1];
  return sha ?? null;
}

/**
 * The real check, at the real tip.
 *
 * Nothing here is cached and nothing is remembered between calls: the answer is about a moment,
 * and a probe that answered from its last answer would be the stored flag this exists instead of.
 */
export async function probeMainTip(request: MainTipProbeRequest): Promise<MainTipAnswer> {
  const deadline = Date.now() + (request.budgetMs ?? MAIN_TIP_PROBE_BUDGET_MS);
  const tip = await resolveTip(request, deadline);
  if (tip == null) return 'UNKNOWN';

  let workspace: string | null = null;
  try {
    workspace = await mkdtemp(path.join(tmpdir(), 'orbit-main-tip-'));
    // Fetched by REF and then pinned to the sha the tip resolved to, so a branch that moves
    // between the two steps produces a mismatch this can see rather than a silent answer about a
    // different commit.
    for (const args of [
      ['init', '--quiet', workspace],
      ['-C', workspace, 'fetch', '--quiet', '--depth', '1', request.repoUrl, request.ref],
      ['-C', workspace, 'checkout', '--quiet', '--detach', 'FETCH_HEAD'],
    ]) {
      const budget = remaining(deadline);
      if (budget == null) return 'UNKNOWN';
      if ((await run('git', args, { timeoutMs: budget })).code !== 0) return 'UNKNOWN';
    }

    const budget = remaining(deadline);
    if (budget == null) return 'UNKNOWN';
    const head = await run('git', ['-C', workspace, 'rev-parse', 'HEAD'], { timeoutMs: budget });
    if (head.code !== 0 || head.stdout.trim() !== tip) return 'UNKNOWN';

    const left = remaining(deadline);
    if (left == null) return 'UNKNOWN';
    const checked = await run('sh', ['-c', request.command], {
      cwd: workspace,
      timeoutMs: left,
    });
    // Killed, or never started: the check did not answer, so neither does this.
    if (checked.code == null) return 'UNKNOWN';
    return checked.code === request.expectedExitCode ? 'GREEN' : 'RED';
  } catch {
    // A probe is diagnosis. Nothing it can fail at is worth failing a committed task's delivery
    // over, and every failure means the same thing as every other one here.
    return 'UNKNOWN';
  } finally {
    if (workspace) await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
  }
}
