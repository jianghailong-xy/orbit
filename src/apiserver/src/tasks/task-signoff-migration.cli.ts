/**
 * Explicit operator door for N8. Schema deployment never calls this file.
 *
 * Examples (run from the built apiserver image, whose DATABASE_URL names the target database):
 *
 *   node dist/tasks/task-signoff-migration.cli.js backfill \
 *     --owner OWNER --idempotency-key rollout-0001 --batch-size 250
 *
 *   node dist/tasks/task-signoff-migration.cli.js import-comment \
 *     --owner OWNER --task TASK --source-comment COMMENT --source-session SESSION \
 *     --evidence-file /run/n8/evidence.json --idempotency-key legacy-TASK-v1 \
 *     --review-note 'Reviewed the exact source comment.' --device-push
 *
 * `import-comment` is intentionally one source at a time. It accepts structured JSON supplied by
 * the reviewer; it does not parse a comment, enumerate comments, or guess completion claims.
 */
import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { ConfigService } from '@nestjs/config';
import { CreatorType } from '@prisma/client';
import { toUuid } from '@orbit/shared';
import { JudgmentDeliveryService } from '../push/judgment-delivery.service';
import { PushService } from '../push/push.service';
import { PrismaService } from '../prisma/prisma.service';
import { TaskCompletionEvidenceService } from './task-completion-evidence.service';

function required(value: string | undefined, flag: string): string {
  if (!value?.trim()) throw new Error(`${flag} is required`);
  return value.trim();
}

function integer(value: string | undefined, flag: string): number {
  const parsed = Number(required(value, flag));
  if (!Number.isSafeInteger(parsed)) throw new Error(`${flag} must be an integer`);
  return parsed;
}

function jsonObject(path: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('--evidence-file must contain one JSON object');
  }
  return parsed as Record<string, unknown>;
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, (_key, item) => (
    typeof item === 'bigint' ? item.toString() : item
  ), 2)}\n`);
}

export async function runTaskSignoffMigrationCli(argv: string[]): Promise<void> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      owner: { type: 'string' },
      task: { type: 'string' },
      'source-comment': { type: 'string' },
      'source-session': { type: 'string' },
      'evidence-file': { type: 'string' },
      'idempotency-key': { type: 'string' },
      'review-note': { type: 'string' },
      'device-push': { type: 'boolean', default: false },
      'batch-size': { type: 'string' },
      'push-task': { type: 'string', multiple: true },
      limit: { type: 'string' },
    },
  });
  const command = positionals[0];
  if (!command || positionals.length !== 1) {
    throw new Error('expected exactly one command: import-comment, backfill, or deliver-due');
  }

  const prisma = new PrismaService();
  await prisma.$connect();
  try {
    if (command === 'deliver-due') {
      const limit = values.limit === undefined ? 20 : integer(values.limit, '--limit');
      if (limit < 1 || limit > 1_000) throw new Error('--limit must be from 1 to 1000');
      const push = new PushService(prisma, new ConfigService());
      const worker = new JudgmentDeliveryService(prisma, push);
      const taken = await worker.deliverDue(limit);
      print({ command, limit, taken });
      return;
    }

    const ownerId = toUuid(required(values.owner, '--owner'));
    const evidence = new TaskCompletionEvidenceService(prisma);
    if (command === 'import-comment') {
      const taskId = toUuid(required(values.task, '--task'));
      const result = await evidence.importLegacyComment(
        ownerId,
        taskId,
        { type: CreatorType.USER, id: ownerId },
        {
          sourceCommentId: toUuid(required(values['source-comment'], '--source-comment')),
          sourceSessionId: toUuid(required(values['source-session'], '--source-session')),
          evidence: jsonObject(required(values['evidence-file'], '--evidence-file')),
          idempotencyKey: required(values['idempotency-key'], '--idempotency-key'),
          reviewNote: required(values['review-note'], '--review-note'),
          devicePush: values['device-push'],
        },
      );
      print(result);
      return;
    }
    if (command === 'backfill') {
      const result = await evidence.backfill(
        ownerId,
        { type: CreatorType.USER, id: ownerId },
        {
          idempotencyKey: required(values['idempotency-key'], '--idempotency-key'),
          batchSize: integer(values['batch-size'], '--batch-size'),
          pushTaskIds: (values['push-task'] ?? []).map(toUuid),
        },
      );
      print(result);
      return;
    }
    throw new Error(`unknown command ${JSON.stringify(command)}`);
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  runTaskSignoffMigrationCli(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
