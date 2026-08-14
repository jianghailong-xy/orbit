import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TasksService } from './tasks.service';

const TASK_ID = '550e8400-e29b-41d4-a716-446655440000';

/**
 * The prompt a task run is dispatched with, as assembled by execute(). Captured off
 * sessions.create rather than by calling the private builder, so these tests pin what the
 * runner actually receives.
 */
function promptFor(task: {
  description?: string | null;
  list?: { instructions?: string | null } | null;
}) {
  const created: any[][] = [];
  const prisma = {
    task: {
      findFirst: async () => ({
        id: TASK_ID,
        title: 'Ship it',
        description: null,
        provider: null,
        model: null,
        status: 'OPEN',
        listId: task.list ? 'list-1' : null,
        list: task.list ? { paused: false, maxConcurrent: null, ...task.list } : null,
        assignee: { id: 'workspace-1', runnerId: 'runner-1' },
        ...task,
      }),
    },
    taskDependency: { findMany: async () => [] },
    session: { findFirst: async () => null },
  } as never;
  const sessions = {
    create: async (...args: any[]) => {
      created.push(args);
      return { id: 'session-new' };
    },
  } as never;
  const service = new TasksService(prisma, sessions, {} as never);
  return async () => {
    await service.execute('owner-1', TASK_ID);
    return created[0][1].prompt as string;
  };
}

// Verbatim from before the instructions layer existed (HEAD~2). Any edit to the template has to
// break this test — every task run in the deployment is assembled from it, and a silent change
// would reach hundreds of runs before anyone read one.
const PROMPT_WITHOUT_INSTRUCTIONS =
  '请开始执行任务「Ship it」。\n\n' +
  '任务描述：\n下载 000_00008.parquet\n\n' +
  '请按以下步骤进行：\n' +
  '1. 先用 task_get 查看该任务的完整信息与历史评论。\n' +
  '2. 执行任务。\n' +
  '3. 完成后，用 task_comment 在该任务下评论一段本次执行的总结（做了什么、结果如何、有无遗留），' +
  '再用 task_update 将该任务状态（status）置为 DONE。\n' +
  '4. 如果执行失败或未能完成，绝不要将状态置为 DONE；请先用 task_comment 在该任务下明确说明失败/未完成的原因，再将状态置为 IN_PROGRESS。';

test('a list with no instructions assembles the prompt exactly as it did before the layer existed', async () => {
  const prompt = await promptFor({
    description: '下载 000_00008.parquet',
    list: { instructions: null },
  });
  assert.equal(await prompt(), PROMPT_WITHOUT_INSTRUCTIONS);
});

test('a task belonging to no list assembles that same prompt', async () => {
  const prompt = await promptFor({ description: '下载 000_00008.parquet', list: null });
  assert.equal(await prompt(), PROMPT_WITHOUT_INSTRUCTIONS);
});

test('instructions are spliced between the task description and the reporting protocol', async () => {
  const prompt = await promptFor({
    description: '下载 000_00008.parquet',
    list: { instructions: '须去重、断点续传，并按 Content-Length 校验；不得删除数据。' },
  });
  assert.equal(
    await prompt(),
    '请开始执行任务「Ship it」。\n\n' +
      '任务描述：\n下载 000_00008.parquet\n\n' +
      '作业指导（本任务列表通用）：\n须去重、断点续传，并按 Content-Length 校验；不得删除数据。\n\n' +
      '请按以下步骤进行：\n' +
      '1. 先用 task_get 查看该任务的完整信息与历史评论。\n' +
      '2. 执行任务。\n' +
      '3. 完成后，用 task_comment 在该任务下评论一段本次执行的总结（做了什么、结果如何、有无遗留），' +
      '再用 task_update 将该任务状态（status）置为 DONE。\n' +
      '4. 如果执行失败或未能完成，绝不要将状态置为 DONE；请先用 task_comment 在该任务下明确说明失败/未完成的原因，再将状态置为 IN_PROGRESS。',
  );
});

test('whitespace-only instructions add nothing', async () => {
  // Otherwise an accidentally blanked field would inject an empty labelled section into every
  // run of the list — a heading promising instructions that are not there.
  const prompt = await promptFor({
    description: '下载 000_00008.parquet',
    list: { instructions: '   \n\t  ' },
  });
  assert.equal(await prompt(), PROMPT_WITHOUT_INSTRUCTIONS);
});

test('instructions reach a task that has no description of its own', async () => {
  // The shape the layer is for: the description shrinks to the per-item part (or vanishes) and
  // the procedure lives once, on the list.
  const prompt = await promptFor({
    description: null,
    list: { instructions: '按 manifest 逐个下载。' },
  });
  const text = await prompt();
  assert.ok(!text.includes('任务描述：'), text);
  assert.ok(text.includes('作业指导（本任务列表通用）：\n按 manifest 逐个下载。'), text);
});
