/**
 * Explicit operator door for N24's already-satisfied request repair.
 *
 * This is not a generic request-status editor. The service accepts only an exact OPEN request on
 * a DONE Task, derives the actor from the named agent Session, and applies the same audited
 * TASK_ALREADY_DONE transition used by completion-evidence submission.
 *
 * Example (run in the built apiserver image whose DATABASE_URL names the target database):
 *
 *   node dist/tasks/task-judgment-repair.cli.js close-satisfied \
 *     --owner OWNER --task TASK --request REQUEST --source-session SESSION
 */
import 'reflect-metadata';
import { parseArgs } from 'node:util';
import { toUuid } from '@orbit/shared';
import { PrismaService } from '../prisma/prisma.service';
import { TaskCompletionEvidenceService } from './task-completion-evidence.service';

function required(value: string | undefined, flag: string): string {
  if (!value?.trim()) throw new Error(`${flag} is required`);
  return value.trim();
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export async function runTaskJudgmentRepairCli(argv: string[]): Promise<void> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      owner: { type: 'string' },
      task: { type: 'string' },
      request: { type: 'string' },
      'source-session': { type: 'string' },
    },
  });
  if (positionals.length !== 1 || positionals[0] !== 'close-satisfied') {
    throw new Error('expected exactly one command: close-satisfied');
  }

  const prisma = new PrismaService();
  await prisma.$connect();
  try {
    const evidence = new TaskCompletionEvidenceService(prisma);
    const result = await evidence.reconcileSatisfiedJudgmentRequest(
      toUuid(required(values.owner, '--owner')),
      toUuid(required(values.task, '--task')),
      {
        requestId: toUuid(required(values.request, '--request')),
        sourceSessionId: toUuid(required(values['source-session'], '--source-session')),
      },
    );
    print({ command: 'close-satisfied', result });
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  runTaskJudgmentRepairCli(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
