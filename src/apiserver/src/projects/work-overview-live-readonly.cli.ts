/**
 * Read-only deployment probe for the verification-gated project fixture named by the repair task.
 * It is intentionally compiled into the apiserver image so the probe executes the exact deployed
 * classifier against the deployment's own database connection. No update/create/delete path is
 * imported or called.
 */
import { toUuid, uuidToBase62 } from '@orbit/shared';
import { PrismaService } from '../prisma/prisma.service';
import { readProjectListRollups } from './project-list-rollup';
import { readProjectPanorama } from './project-panorama';
import { readProjectTaskWorkStates } from './project-task-work-state';

async function main(): Promise<void> {
  const projectPublicId = process.env.WORK_OVERVIEW_PROJECT_PUBLIC_ID;
  const taskPublicId = process.env.WORK_OVERVIEW_TASK_PUBLIC_ID;
  if (!projectPublicId || !taskPublicId) {
    throw new Error('WORK_OVERVIEW_PROJECT_PUBLIC_ID and WORK_OVERVIEW_TASK_PUBLIC_ID are required');
  }
  const projectId = toUuid(projectPublicId);
  const taskId = toUuid(taskPublicId);
  const prisma = new PrismaService();
  await prisma.$connect();
  try {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, ownerId: true, title: true },
    });
    if (!project) throw new Error(`project ${projectPublicId} not found`);
    const task = await prisma.task.findFirst({
      where: { id: taskId, ownerId: project.ownerId, projectId },
      select: {
        id: true,
        title: true,
        status: true,
        completionCriterion: true,
        completionPolicy: true,
        verifiesTaskId: true,
      },
    });
    if (!task) throw new Error(`task ${taskPublicId} is not in project ${projectPublicId}`);
    const taskWorkSessionsBefore = await prisma.session.count({
      where: { taskId, startsTaskWork: true },
    });
    const listStartedAt = performance.now();
    const projectListRollup = (await readProjectListRollups(prisma, project.ownerId)).get(projectId);
    const projectListRollupMs = Math.round((performance.now() - listStartedAt) * 100) / 100;
    if (!projectListRollup) throw new Error(`project-list rollup missing for ${projectPublicId}`);
    const [panorama, workStates] = await Promise.all([
      readProjectPanorama(prisma, project.ownerId, projectId),
      readProjectTaskWorkStates(prisma, project.ownerId, projectId, [taskId]),
    ]);
    const work = workStates.get(taskId);
    if (!work) throw new Error(`canonical work state missing for ${taskPublicId}`);
    const bucketTotal = Object.values(panorama.buckets)
      .reduce((total, value) => total + value, 0);
    if (bucketTotal !== panorama.shape.taskCount) {
      throw new Error(`bucket total ${bucketTotal} does not match taskCount ${panorama.shape.taskCount}`);
    }
    if (
      projectListRollup.taskCount !== panorama.shape.taskCount
      || JSON.stringify(projectListRollup.buckets) !== JSON.stringify(panorama.buckets)
    ) {
      throw new Error('project-list rollup does not match project panorama');
    }
    const taskIsNotReady = work.workState !== 'READY';
    if (!taskIsNotReady) {
      throw new Error(`verification subject ${taskPublicId} is incorrectly READY`);
    }
    if (work.workState !== 'AWAITING_VERIFICATION' && work.workState !== 'DONE') {
      throw new Error(`verification subject has unexpected state ${work.workState}`);
    }
    const taskWorkSessionsAfter = await prisma.session.count({
      where: { taskId, startsTaskWork: true },
    });
    if (taskWorkSessionsAfter !== taskWorkSessionsBefore) {
      throw new Error(
        `task-work session count changed during read-only probe: ${taskWorkSessionsBefore} -> ${taskWorkSessionsAfter}`,
      );
    }
    process.stdout.write(`${JSON.stringify({
      readOnly: true,
      observedAt: new Date().toISOString(),
      project: { id: uuidToBase62(project.id), title: project.title },
      task: {
        id: uuidToBase62(task.id),
        title: task.title,
        status: task.status,
        completionCriterion: task.completionCriterion,
        completionPolicy: task.completionPolicy,
        verifiesTaskId: task.verifiesTaskId ? uuidToBase62(task.verifiesTaskId) : null,
        ...work,
      },
      panorama,
      projectListRollup: { ...projectListRollup, queryDurationMs: projectListRollupMs },
      bucketTotal,
      taskWorkSessions: {
        before: taskWorkSessionsBefore,
        after: taskWorkSessionsAfter,
      },
      assertions: {
        taskIsNotReady,
        noTaskWasStarted: taskWorkSessionsAfter === taskWorkSessionsBefore,
        bucketTotalMatchesTaskCount: bucketTotal === panorama.shape.taskCount,
        projectListMatchesPanorama: true,
      },
    })}\n`);
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
