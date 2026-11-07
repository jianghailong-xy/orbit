/**
 * One apiserver's approval alerts, as a process of its own, for feishu-alerts.pg.spec.ts: a PushService over its own
 * connection pool with the real FeishuTransport and FeishuOutbound, pointed (ORBIT_TEST_FEISHU_OPEN_PLATFORM_URL) at the
 * spec's fake open platform. It connects, says `ready`, and on each `go <sessionId> <approvalId,…>` line from its parent
 * announces those approvals at once, as the runner's calls reaching this apiserver would, and says `done`.
 */
import { createInterface } from 'node:readline';
import type { ConfigService } from '@nestjs/config';
import { FeishuAppService } from '../../feishu/feishu-app.service';
import { FeishuOutbound } from '../../feishu/feishu-outbound';
import { prismaClientFor } from '../../prisma/prisma-client';
import type { PrismaService } from '../../prisma/prisma.service';
import { FeishuTransport } from '../feishu-transport';
import { PushService } from '../push.service';

async function main(): Promise<void> {
  const db = prismaClientFor(process.env.COORDINATOR_PG_URL!) as unknown as PrismaService;
  await (db as unknown as { $connect(): Promise<void> }).$connect();
  // No APNs, no FCM: Feishu is the only channel.
  const push = new PushService(db, { get: () => undefined } as unknown as ConfigService,
    new FeishuTransport(db, new FeishuAppService(db), new FeishuOutbound()));
  process.stdout.write('ready\n');
  for await (const line of createInterface({ input: process.stdin })) {
    const [verb, sessionId, ids] = line.trim().split(' ');
    if (verb === 'exit') break;
    if (verb !== 'go') continue;
    await Promise.all(ids!.split(',').map((id) => push.notifyApprovalRequest(sessionId!, id, 'Bash')));
    // The cards are started in the background (PushService.background); `done` is said once they are settled.
    await push.feishuIdle();
    process.stdout.write('done\n');
  }
  await (db as unknown as { $disconnect(): Promise<void> }).$disconnect();
}

main().catch((err) => {
  process.stderr.write(`${(err as Error).stack}\n`);
  process.exit(1);
});
