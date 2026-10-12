import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TasksService } from './tasks.service';
import { fakeReceiptStore } from './task-run-receipt-fake';
import { executableAcceptanceFailureReason } from './executable-acceptance-round';
import { EXECUTABLE_ACCEPTANCE_UNAVAILABLE_SIGNAL_CODE } from './reclaim-stalled-task';

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
  completionCriterion?: string;
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
// read one. It last changed when it became English (2026-10-10, AGENTS.md §5). Before that it changed
// when the executor stopped writing its own DONE: steps 3 and 4 are the instruction half of that
// boundary, and they have to arrive in the same release as the refusal in `update()`
// (`task-self-done-boundary.spec.ts`) or every run in flight hits a wall it was never told about.
const PROMPT_WITHOUT_INSTRUCTIONS =
  'Start the task “Ship it”.\n\n' +
  'Task description:\n下载 000_00008.parquet\n\n' +
  'Follow these steps:\n' +
  '1. First use task_get to read the task in full with its comment history.\n' +
  '2. Do the task.\n' +
  '3. When you are done, submit the completion evidence envelope with task_evidence_submit. All four ' +
  'fields are required: claim (what you claim to have completed), criterion ({key, text}, copied from the ' +
  'acceptance criteria project_get returns), checks (each {kind, ref}, kind one of ' +
  "TOOL_CALL / COMMIT / ARTIFACT, ref pointing at a row already recorded under this task's sessions; at " +
  'least one must resolve, or the whole submission is refused), and gaps (what this evidence could not ' +
  'establish; an empty array if nothing). A TOOL_CALL may also carry command/succeeded, which the server ' +
  "checks byte for byte against the cited tool_call. Do not copy a command's raw output into the evidence " +
  '— Orbit has stored it already; work answered by an exit code alone belongs to EXECUTABLE acceptance, ' +
  'not here. Do not use task_comment in place of submitting evidence, and do not write status — DONE is ' +
  'the authorization that unlocks downstream tasks, and only evaluating the completionCriterion the task ' +
  'declares can produce it; the server refuses a direct DONE from anyone.\n' +
  '4. If the work failed or could not be finished, first explain why with task_comment, then use task_update ' +
  'to set the status to FAILED. Do not set it to DONE, and do not set it to IN_PROGRESS — downstream treats ' +
  'IN_PROGRESS as an ordinary wait and keeps waiting forever, while only FAILED marks downstream as needing ' +
  'a person to step in.';

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
    'Start the task “Ship it”.\n\n' +
      'Task description:\n下载 000_00008.parquet\n\n' +
      'List instructions (the same for every task in this list):\n须去重、断点续传，并按 Content-Length 校验；不得删除数据。\n\n' +
      'Follow these steps:\n' +
      '1. First use task_get to read the task in full with its comment history.\n' +
      '2. Do the task.\n' +
      '3. When you are done, submit the completion evidence envelope with task_evidence_submit. All four ' +
      'fields are required: claim (what you claim to have completed), criterion ({key, text}, copied from the ' +
      'acceptance criteria project_get returns), checks (each {kind, ref}, kind one of ' +
      "TOOL_CALL / COMMIT / ARTIFACT, ref pointing at a row already recorded under this task's sessions; at " +
      'least one must resolve, or the whole submission is refused), and gaps (what this evidence could not ' +
      'establish; an empty array if nothing). A TOOL_CALL may also carry command/succeeded, which the server ' +
      "checks byte for byte against the cited tool_call. Do not copy a command's raw output into the evidence " +
      '— Orbit has stored it already; work answered by an exit code alone belongs to EXECUTABLE acceptance, ' +
      'not here. Do not use task_comment in place of submitting evidence, and do not write status — DONE is ' +
      'the authorization that unlocks downstream tasks, and only evaluating the completionCriterion the task ' +
      'declares can produce it; the server refuses a direct DONE from anyone.\n' +
      '4. If the work failed or could not be finished, first explain why with task_comment, then use task_update ' +
      'to set the status to FAILED. Do not set it to DONE, and do not set it to IN_PROGRESS — downstream treats ' +
      'IN_PROGRESS as an ordinary wait and keeps waiting forever, while only FAILED marks downstream as needing ' +
      'a person to step in.',
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
  assert.ok(!text.includes('Task description:'), text);
  assert.ok(text.includes('List instructions (the same for every task in this list):\n按 manifest 逐个下载。'), text);
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
  assert.ok(!text.includes('List instructions'), text);
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
  assert.ok(!text.includes('List instructions'), text);
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
      'Acceptance criteria (what decides whether this task is done):\n'
        + '1. 文件存在且 sha256 与 manifest 一致。\n2. `npm test` 退出码为 0。',
    ),
    text,
  );
  assert.ok(text.indexOf('Task description:') < text.indexOf('Acceptance criteria'), text);
  assert.ok(text.indexOf('Acceptance criteria') < text.indexOf('Follow these steps:'), text);
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
  assert.ok(!text.includes('List instructions'), text);
  assert.ok(text.includes('Acceptance criteria (what decides whether this task is done):\n贴出 X 主张的命令的重跑输出。'), text);
});

test('step 3 asks for the evidence envelope and forbids writing status', async () => {
  // The instruction half of the self-DONE boundary. It has to name the ENVELOPE, field by field,
  // because "summarise what you did" is exactly what produced a DONE whose claim nobody could
  // check — and because an instruction that still asked for raw output and exit codes would now
  // be asking for a submission the server refuses.
  const text = await (await promptFor({ description: 'x', list: null }))();
  const step3 = text.split('\n').find((line) => line.startsWith('3. '))!;
  assert.match(step3, /task_evidence_submit/);
  assert.match(step3, /Do not use task_comment in place of submitting evidence/);
  for (const field of ['claim', 'criterion', 'checks', 'gaps']) {
    assert.match(step3, new RegExp(field), step3);
  }
  assert.match(step3, /TOOL_CALL \/ COMMIT \/ ARTIFACT/);
  assert.match(step3, /least one must resolve/);
  assert.match(step3, /Do not copy a command's raw output into the evidence/);
  assert.match(step3, /do not write status/);
  assert.equal(/set (?:it|the status|this task's status) to DONE/.test(step3), false, step3);
});

test('step 4 says FAILED, and says it instead of IN_PROGRESS', async () => {
  // IN_PROGRESS dresses a terminal failure up as a wait: `computeDependencyState` reads FAILED as
  // BLOCKED_FAILED (a person is needed) and IN_PROGRESS as plain BLOCKED (keep waiting), so the
  // old wording left every downstream task waiting for a run that was never coming back, with
  // nothing anywhere raising a hand.
  const text = await (await promptFor({ description: 'x', list: null }))();
  const step4 = text.split('\n').find((line) => line.startsWith('4. '))!;
  // The status it tells you to WRITE...
  assert.match(step4, /use task_update to set the status to FAILED/);
  // ...and the one it now tells you not to. IN_PROGRESS still appears in the line, which is why
  // this asks about the instruction rather than about the word: the old template's imperative
  // ('再将状态置为 IN_PROGRESS', then set the status to IN_PROGRESS) is what must be gone, and it is
  // now a prohibition instead.
  assert.match(step4, /do not set it to IN_PROGRESS/);
  assert.equal(/set the status to IN_PROGRESS/.test(step4), false, step4);
});

test('an EXECUTABLE task delegates its terminal status to the one declared command', async () => {
  const text = await (await promptFor({
    description: 'x',
    acceptanceCommand: 'npm test',
    acceptanceExpectedExitCode: 0,
    list: null,
  }))();
  const step3 = text.split('\n').find((line) => line.startsWith('3. '))!;
  assert.match(step3, /Orbit automatically runs the task's one declared EXECUTABLE acceptance command/);
  assert.match(step3, /in this run session's workspace/);
  assert.match(step3, /expected exit code 0/);
  // Where the result is recorded, in the spellings of the code that records it. The comparison
  // writes task.status and nothing else (executable-exit-code-judgment.spec.ts), so the brief may
  // not promise the comment it used to: no comment carries the output or the actual exit code.
  assert.match(step3, /The raw output and the actual exit code are not written to a task comment/);
  // The old promise ('并把命令、原始输出和实际退出码写入任务评论'), in the brief's English.
  assert.equal(/actual exit code to a task comment/.test(step3), false, step3);
  assert.match(step3, /the derived status is on the task \(task_get shows it\)/);
  assert.match(step3, /the command and its raw output are in this session's record, as one of its Bash calls/);
  assert.ok(step3.includes(executableAcceptanceFailureReason(4242, 0).replace('4242', '<actual exit code>')), step3);
  assert.match(step3, /read this session with session_get; its id is in the environment variable ORBIT_SESSION_ID/);
  assert.match(step3, /TASK_FAILED exception/);
  assert.ok(step3.includes(`writes a task comment only when the command could not return a result to compare (${EXECUTABLE_ACCEPTANCE_UNAVAILABLE_SIGNAL_CODE})`), step3);
  assert.match(step3, /a matching exit code derives DONE, anything else derives FAILED/);
  assert.match(step3, /Do not write status yourself/);
  assert.match(step3, /do not ask the coordinator to approve/);
  assert.equal(/set (?:this task's|the) status to DONE/.test(step3), false, step3);
});

test('an OWNER_CONFIRMED task declares its work finished and reports in its session, instead of submitting evidence', async () => {
  // Only the account owner settles this criterion, by pressing Confirm done in the app, and only
  // after the run DECLARES the work finished — the declaration is what a card is made of, so the
  // prompt names it first and says what not calling it costs. Handed the evidence envelope like
  // every other task, runs of it did as told, each filing a `task_completion_evidence` row the
  // criterion never reads — for tasks in no project, with no project_get criterion to copy.
  const text = await (await promptFor({
    description: 'x',
    completionCriterion: 'OWNER_CONFIRMED',
    list: null,
  }))();
  const step3 = text.split('\n').find((line) => line.startsWith('3. '))!;
  assert.match(step3, /first declare with task_request_confirmation/);
  assert.match(step3, /Only that declaration puts a confirmation card in front of the account owner/);
  assert.match(step3, /then say in a sentence or two in this session what you did, and end the turn/);
  assert.match(step3, /the account owner confirms it in the Orbit app \(Confirm done\) or sends it back \(Send back…\)/);
  assert.match(step3, /the reason for a send-back arrives in this session as the next message — when it does, carry on as it says/);
  assert.match(step3, /do not write status/);
  // Nothing in the prompt asks for the envelope, and the tool is named only to be refused.
  assert.equal(/evidence envelope|claim|checks|gaps|project_get/.test(text), false, text);
  assert.equal(text.replace('Do not call task_evidence_submit', '').includes('task_evidence_submit'), false, text);
  const step4 = text.split('\n').find((line) => line.startsWith('4. '))!;
  assert.match(step4, /use task_update to set the status to FAILED/);
});

test('an EVIDENCE_JUDGMENT task, and a verifier, still get the evidence envelope word for word', async () => {
  // The branch above is keyed on OWNER_CONFIRMED alone: declaring any other criterion dispatches
  // the template exactly as it was before that branch existed.
  for (const task of [
    { completionCriterion: 'EVIDENCE_JUDGMENT' },
    { completionCriterion: 'VERIFICATION', verifiesTaskId: 'subject-task' },
  ]) {
    const prompt = await promptFor({ description: '下载 000_00008.parquet', list: null, ...task });
    assert.equal(await prompt(), PROMPT_WITHOUT_INSTRUCTIONS);
  }
});

test('a task declaring EXECUTABLE keeps its step 3 word for word', async () => {
  const text = await (await promptFor({
    description: 'x',
    completionCriterion: 'EXECUTABLE',
    acceptanceCommand: 'npm test',
    acceptanceExpectedExitCode: 0,
    list: null,
  }))();
  const step3 = text.split('\n').find((line) => line.startsWith('3. '))!;
  assert.equal(
    step3,
    "3. Once this reply ends, Orbit automatically runs the task's one declared EXECUTABLE acceptance command " +
      "in this run session's workspace (expected exit code 0): a matching exit code derives DONE, anything " +
      'else derives FAILED. The raw output and the actual exit code are not written to a task comment; the ' +
      'result is recorded in these places: the derived status is on the task (task_get shows it); the command ' +
      "and its raw output are in this session's record, as one of its Bash calls (to see the output again, " +
      'rerun the same command in the workspace); on FAILED this session ends failed, its error reading ' +
      '`acceptance command exited <actual exit code>; expected 0` (read this session with session_get; its id ' +
      'is in the environment variable ORBIT_SESSION_ID), and if the task belongs to a project, the project ' +
      'also gets a TASK_FAILED exception recording both exit codes. The acceptance itself writes a task ' +
      'comment only when the command could not return a result to compare (EXECUTABLE_ACCEPTANCE_UNAVAILABLE), ' +
      "and the task's status then stays as it was. Do not write status yourself, and do not ask the " +
      'coordinator to approve this mechanical verdict.',
  );
});

test('foreman and verifier runs are told that their criterion, not their session, writes DONE', async () => {
  for (const task of [{ isForeman: true }, { verifiesTaskId: 'subject-task' }]) {
    const text = await (await promptFor({ description: 'x', list: null, ...task }))();
    const step3 = text.split('\n').find((line) => line.startsWith('3. '))!;
    assert.match(step3, /only evaluating the completionCriterion the task declares can produce it/);
    assert.match(step3, /do not write status/);
    assert.equal(/set (?:this task's|the) status to DONE/.test(step3), false, step3);
    const step4 = text.split('\n').find((line) => line.startsWith('4. '))!;
    assert.match(step4, /use task_update to set the status to FAILED/);
  }
});
