import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TasksService } from './tasks.service';
import { fakeReceiptStore } from './task-run-receipt-fake';

const TASK_ID = '550e8400-e29b-41d4-a716-446655440000';

/**
 * The prompt a task run is dispatched with, as assembled by execute(). Captured off
 * sessions.create rather than by calling the private builder, so these tests pin what the
 * runner actually receives.
 */
function promptFor(task: {
  description?: string | null;
  acceptanceCriteria?: string | null;
  acceptanceCommand?: string | null;
  acceptanceExpectedExitCode?: number | null;
  isForeman?: boolean;
  verifiesTaskId?: string | null;
  list?: { instructions?: string | null } | null;
}) {
  const created: any[][] = [];
  const prisma = {
    // Every run door opens its receipt (0137) before anything else.
    ...fakeReceiptStore(),
    task: {
      findFirst: async () => ({
        id: TASK_ID,
        title: 'Ship it',
        description: null,
        acceptanceCriteria: null,
        provider: null,
        model: null,
        status: 'OPEN',
        listId: task.list ? 'list-1' : null,
        list: task.list ? { paused: false, maxConcurrent: null, ...task.list } : null,
        isForeman: false,
        verifiesTaskId: null,
        // §13.1 AG6's two facts. Every task in this fixture is an ordinary leaf; the
        // aggregate-parent gate has its own coverage in `task-aggregate-parent-execute.spec.ts`.
        completionPolicy: 'MANUAL',
        children: [],
        assignee: { id: 'workspace-1', runnerId: 'runner-1' },
        ...task,
      }),
    },
    taskDependency: { findMany: async () => [] },
    // A dispatch copies the task's input files into the run it opens
    // (`copyTaskAttachments`); these fixtures attach none, so nothing is copied.
    attachment: { findMany: async () => [] },
    // A paused run's delivery is read by its own turn key before it is written (H2F).
    conversationTurn: { findUnique: async () => null },
    session: {
      // The door reads THIS request's own Session by id before it writes (H2F).
      findUnique: async () => null, findFirst: async () => null },
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

// The template, verbatim. Any edit to it has to break this test — every task run in the
// deployment is assembled from it, and a silent change would reach hundreds of runs before anyone
// read one. It last changed when the executor stopped writing its own DONE: steps 3 and 4 are the
// instruction half of that boundary, and they have to arrive in the same release as the refusal in
// `update()` (`task-self-done-boundary.spec.ts`) or every run in flight hits a wall it was never
// told about.
const PROMPT_WITHOUT_INSTRUCTIONS =
  '请开始执行任务「Ship it」。\n\n' +
  '任务描述：\n下载 000_00008.parquet\n\n' +
  '请按以下步骤进行：\n' +
  '1. 先用 task_get 查看该任务的完整信息与历史评论。\n' +
  '2. 执行任务。\n' +
  '3. 完成后，用 task_evidence_submit 提交完成证据信封，四个字段缺一不可：claim（你主张完成了什么）、' +
  'criterion（{key, text}，抄自 project_get 的验收条目）、checks（每条 {kind, ref}，kind 取 ' +
  'TOOL_CALL / COMMIT / ARTIFACT，ref 指向本任务会话下已有的行；至少一条必须解析成功，否则整次提交被拒）、' +
  'gaps（本次证据没能确立的部分，没有就给空数组）。TOOL_CALL 可再写 command/succeeded，服务端会拿它' +
  '和被引 tool_call 逐字节核对。不要把命令原始输出抄进证据——Orbit 已经存了它；只由退出码回答的工作' +
  '属于 EXECUTABLE 验收，不属于这里。不要用 task_comment 代替证据提交，也不要写 status——DONE 是' +
  '解锁下游任务的授权，只能由任务声明的 completionCriterion 求值产生；服务端会拒绝任何主体直接写 DONE。\n' +
  '4. 如果执行失败或未能完成，先用 task_comment 说明失败/未完成的原因，再用 task_update 将' +
  '状态（status）置为 FAILED。不要置为 DONE，也不要置为 IN_PROGRESS——IN_PROGRESS 会被下游' +
  '当成普通等待一直等下去，FAILED 才会把下游标成需要人介入。';

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
      '3. 完成后，用 task_evidence_submit 提交完成证据信封，四个字段缺一不可：claim（你主张完成了什么）、' +
      'criterion（{key, text}，抄自 project_get 的验收条目）、checks（每条 {kind, ref}，kind 取 ' +
      'TOOL_CALL / COMMIT / ARTIFACT，ref 指向本任务会话下已有的行；至少一条必须解析成功，否则整次提交被拒）、' +
      'gaps（本次证据没能确立的部分，没有就给空数组）。TOOL_CALL 可再写 command/succeeded，服务端会拿它' +
      '和被引 tool_call 逐字节核对。不要把命令原始输出抄进证据——Orbit 已经存了它；只由退出码回答的工作' +
      '属于 EXECUTABLE 验收，不属于这里。不要用 task_comment 代替证据提交，也不要写 status——DONE 是' +
      '解锁下游任务的授权，只能由任务声明的 completionCriterion 求值产生；服务端会拒绝任何主体直接写 DONE。\n' +
      '4. 如果执行失败或未能完成，先用 task_comment 说明失败/未完成的原因，再用 task_update 将' +
      '状态（status）置为 FAILED。不要置为 DONE，也不要置为 IN_PROGRESS——IN_PROGRESS 会被下游' +
      '当成普通等待一直等下去，FAILED 才会把下游标成需要人介入。',
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

test('a foreman task is not given the list instructions', async () => {
  // Those describe how the list's *work* is done. A coordination run is not doing that work, so
  // handing it the work procedure is misdirection — and it is the run most likely to act on a
  // stray instruction, since diagnosing a stall is open-ended by nature.
  const prompt = await promptFor({
    description: '列表已停滞 30 分钟。',
    isForeman: true,
    list: { instructions: '须去重、断点续传，并按 Content-Length 校验。' },
  });
  const text = await prompt();
  assert.ok(!text.includes('作业指导'), text);
  assert.ok(text.includes('列表已停滞 30 分钟。'), text);
});

test('a verification task is not given the list instructions either', async () => {
  // Same reason as the foreman: those say how the list's *work* is done, and a verifier is
  // checking that work rather than performing it. Handing it the work procedure is also the
  // surest way to get it to do the job itself instead of judging it — which would launder a
  // failure into a pass.
  const prompt = await promptFor({
    description: '核实任务 X 是否真的完成。',
    verifiesTaskId: 'subject-task',
    list: { instructions: '须去重、断点续传，并按 Content-Length 校验。' },
  });
  const text = await prompt();
  assert.ok(!text.includes('作业指导'), text);
  assert.ok(text.includes('核实任务 X 是否真的完成。'), text);
});

// ── the acceptance criteria, and the reporting protocol they exist for ───────────────────────

test('the acceptance criteria are in the prompt, between the description and the protocol', async () => {
  // The run is asked to argue that it is finished. Before this it was asked that without being
  // shown what would settle it — the criteria were in the row, reachable only by a `task_get` the
  // prompt merely suggested, so a run that skipped it judged itself against the *description*,
  // which says what to DO and never what would prove it done.
  const prompt = await promptFor({
    description: '下载 000_00008.parquet',
    acceptanceCriteria: '1. 文件存在且 sha256 与 manifest 一致。\n2. `npm test` 退出码为 0。',
    list: { instructions: null },
  });
  const text = await prompt();
  assert.ok(
    text.includes(
      '验收标准（判定本任务是否完成的依据）：\n'
        + '1. 文件存在且 sha256 与 manifest 一致。\n2. `npm test` 退出码为 0。',
    ),
    text,
  );
  assert.ok(text.indexOf('任务描述：') < text.indexOf('验收标准'), text);
  assert.ok(text.indexOf('验收标准') < text.indexOf('请按以下步骤进行：'), text);
});

test('a task with no acceptance criteria gets no empty heading', async () => {
  // Same reason whitespace-only instructions add nothing: a heading promising criteria that are
  // not there is worse than the absence, because a run reads it as "there were none to meet".
  for (const acceptanceCriteria of [null, '   \n\t  ']) {
    const prompt = await promptFor({
      description: '下载 000_00008.parquet',
      acceptanceCriteria,
      list: { instructions: null },
    });
    assert.equal(await prompt(), PROMPT_WITHOUT_INSTRUCTIONS);
  }
});

test('a verifier is given its own acceptance criteria, unlike the list instructions', async () => {
  // The two are suppressed for different reasons or not at all: the list's instructions say how
  // the LIST's work is done and a verifier is not doing it, while a verification task's own
  // criteria are what settles the verification.
  const prompt = await promptFor({
    description: '核实任务 X 是否真的完成。',
    acceptanceCriteria: '贴出 X 主张的命令的重跑输出。',
    verifiesTaskId: 'subject-task',
    list: { instructions: '须去重、断点续传。' },
  });
  const text = await prompt();
  assert.ok(!text.includes('作业指导'), text);
  assert.ok(text.includes('验收标准（判定本任务是否完成的依据）：\n贴出 X 主张的命令的重跑输出。'), text);
});

test('step 3 asks for the evidence envelope and forbids writing status', async () => {
  // The instruction half of the self-DONE boundary. It has to name the ENVELOPE, field by field,
  // because "summarise what you did" is exactly what produced a DONE whose claim nobody could
  // check — and because an instruction that still asked for raw output and exit codes would now
  // be asking for a submission the server refuses.
  const text = await (await promptFor({ description: 'x', list: null }))();
  const step3 = text.split('\n').find((line) => line.startsWith('3. '))!;
  assert.match(step3, /task_evidence_submit/);
  assert.match(step3, /不要用 task_comment 代替证据提交/);
  for (const field of ['claim', 'criterion', 'checks', 'gaps']) {
    assert.match(step3, new RegExp(field), step3);
  }
  assert.match(step3, /TOOL_CALL \/ COMMIT \/ ARTIFACT/);
  assert.match(step3, /至少一条必须解析成功/);
  assert.match(step3, /不要把命令原始输出抄进证据/);
  assert.match(step3, /不要写 status/);
  assert.equal(/置为 DONE/.test(step3), false, step3);
});

test('step 4 says FAILED, and says it instead of IN_PROGRESS', async () => {
  // IN_PROGRESS dresses a terminal failure up as a wait: `computeDependencyState` reads FAILED as
  // BLOCKED_FAILED (a person is needed) and IN_PROGRESS as plain BLOCKED (keep waiting), so the
  // old wording left every downstream task waiting for a run that was never coming back, with
  // nothing anywhere raising a hand.
  const text = await (await promptFor({ description: 'x', list: null }))();
  const step4 = text.split('\n').find((line) => line.startsWith('4. '))!;
  // The status it tells you to WRITE...
  assert.match(step4, /task_update 将状态（status）置为 FAILED/);
  // ...and the one it now tells you not to. IN_PROGRESS still appears in the line, which is why
  // this asks about the instruction rather than about the word: the old template's imperative
  // ('再将状态置为 IN_PROGRESS') is what must be gone, and it is now a prohibition instead.
  assert.match(step4, /不要置为 IN_PROGRESS/);
  assert.equal(/再将状态置为 IN_PROGRESS/.test(step4), false, step4);
});

test('an EXECUTABLE task delegates its terminal status to the one declared command', async () => {
  const text = await (await promptFor({
    description: 'x',
    acceptanceCommand: 'npm test',
    acceptanceExpectedExitCode: 0,
    list: null,
  }))();
  const step3 = text.split('\n').find((line) => line.startsWith('3. '))!;
  assert.match(step3, /系统会在本执行会话的工作区自动运行/);
  assert.match(step3, /唯一 EXECUTABLE 验收命令/);
  assert.match(step3, /期望退出码 0/);
  assert.match(step3, /命令、原始输出和实际退出码写入任务评论/);
  assert.match(step3, /相等则推导 DONE，否则推导 FAILED/);
  assert.match(step3, /不要自行写 status/);
  assert.match(step3, /不要让 coordinator 审批/);
  assert.equal(/task_update 将本任务状态（status）置为 DONE/.test(step3), false, step3);
});

test('foreman and verifier runs are told that their criterion, not their session, writes DONE', async () => {
  for (const task of [{ isForeman: true }, { verifiesTaskId: 'subject-task' }]) {
    const text = await (await promptFor({ description: 'x', list: null, ...task }))();
    const step3 = text.split('\n').find((line) => line.startsWith('3. '))!;
    assert.match(step3, /completionCriterion 求值产生/);
    assert.match(step3, /不要写 status/);
    assert.equal(/task_update 将本任务状态（status）置为 DONE/.test(step3), false, step3);
    const step4 = text.split('\n').find((line) => line.startsWith('4. '))!;
    assert.match(step4, /task_update 将状态（status）置为 FAILED/);
  }
});
