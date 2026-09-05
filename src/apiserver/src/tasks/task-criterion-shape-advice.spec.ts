import 'reflect-metadata';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { test } from 'node:test';
import {
  TASK_CRITERION_SHAPE_ADVICE_CODE,
  TASK_CRITERION_SHAPE_RULES,
  taskCriterionShapeAdvice,
  taskCriterionShapeAdviceBody,
  type TaskCriterionShapeRule,
} from './task-criterion-shape-advice';
import { TasksService } from './tasks.service';

// Verbatim task acceptance text filed in project 34Dn1kFVW8tKOQKcEfpDW on 2026-08-27. These are
// evidence, not synthetic keyword examples: N18/N20 are the two mistaken EVIDENCE_JUDGMENT choices;
// N17/N19/N21 are the legitimate exceptions this heuristic must never make impossible.
/** The project the EVIDENCE_JUDGMENT tasks below are filed under; see the fake's `project` reader. */
const PROJECT = '00000000-0000-7000-8000-0000000000f1';
const TONIGHT = {
  N17: `1. pg spec：一个 \`EXECUTABLE\` 任务在执行会话完成工作回合后，验收命令**确实被执行**，命令、原始输出与实际退出码落库。
2. pg spec：退出码等于期望值 → status 派生为 DONE；不等 → 派生为 FAILED（两条断言），全程无人写 status。
3. pg spec（补上今天缺的那条）：L0 因任何原因无法执行时，**必须产生一个需要人的信号**，不得静默停在 OPEN——与 T11 给 EVIDENCE_JUDGMENT 补的出口同构。
4. 端到端复现今天的实测场景：重建一个 \`acceptanceCommand='true'\` 的任务并真跑一遍，贴出任务最终状态与落库的命令/输出/退出码原始记录。
5. 派发 prompt 里那句「系统会自动运行 L0 验收命令」要么被实现兑现、要么改成与实现一致的措辞；spec 断言 prompt 文案与实际行为一致。
6. apiserver 与 runner 全量测试相对各自开工基线不新增失败。`,
  N18: `1. 不声明判据的建任务请求被拒，refusal 说明三种判据各自适用什么；REST、CLI、MCP、web 建任务入口四处一致，spec 各一条。
2. 一致性约束：声明 \`acceptanceCommand\` 而判据不是 \`EXECUTABLE\` 被拒；有活验证任务指向而判据不是 \`VERIFICATION\` 被拒（两条负向 spec）。
3. 反向断言：判据为 \`EXECUTABLE\` 却没有 \`acceptanceCommand\` 被拒。
4. 分工原则已写入 docs，并在上述 refusal 文案里被引用。
5. 四份真相（usage / handler / capabilities / MCP schema）对齐测试通过。
6. apiserver、runner、web 全量测试相对各自开工基线不新增失败。`,
  N19: `1. 前置门：完成说明首先给出 N17 已验证通过的证据（样本任务 id、执行的命令、退出码、派生出的状态），证明迁移目标不是另一条死路。
2. 分类与命令模板成文，含每类的样本数与推导依据；3–5 个样本先人工核对通过再放量，贴出样本核对记录。
3. 回填后按类抽样验证：抽样任务的 \`completionCriterion=EXECUTABLE\` 且 \`acceptanceCommand\` 与其验收标准文字一致；贴出抽样 SQL 与原始输出。
4. **无任何任务被迁移写成 DONE**：贴出迁移前后各状态计数对比，DONE 数不变。
5. 无法归类的任务清单及其原因已列出，且仍为 EVIDENCE_JUDGMENT。
6. 迁移单独一条迁移、分批执行，给出行数、批次与耗时；提供回滚方式。
7. apiserver 全量测试相对开工基线不新增失败。`,
  N20: `1. 账号所有者能在 web 上完成一次完整的项目验收：逐条给出 verdict 并提交，\`POST /projects/:id/acceptance/runs/:runId/verdict\` 被真实调用；贴出网络请求与响应。
2. 界面逐条展示断言文本、verificationMethod、当前 verdict 与支持它的证据引用（至少 evidenceTaskId / evidenceSessionId）。
3. 服务端边界未被前端放宽：判断会话（dispatch_origin = judgment）进入该界面时提交 PASS 仍得服务端裁决；spec 断言。
4. 未答满全部 criteria 的提交被拒（服务端本就要求，前端要把这条表达清楚而不是静默丢弃）。
5. 用真实数据走通一次：项目 34Cn4EO8NtCTVK3gZ8Cr7 的 run \`34ELDxu5yGxFQJgNvTEmy\` 可在 UI 上被判（若该 run 届时已被处理，另开一个等价 run 演示）。
6. \`npm test -w @orbit/web\` 与 apiserver 全量相对各自开工基线不新增失败。`,
  N21: `1. 成文结论（写进 docs），必须分别回答：(a) \`authorityPrincipal\` 的「无 acting session = USER」是否改、怎么改；(b) 在 agent 与 apiserver 同机的部署里，凭据能否被铸造，因而基于凭据的人/agent 区分是否成立。
2. 若结论是「区分不成立」，文档必须明确写出 HUMAN_ONLY 三项实际提供的性质（例如审计可见性），并说明它**不是**不可为的硬边界；相关 refusal 文案与代码注释同步改对，不得继续暗示它是硬边界。
3. **负向测试**：用 agent 持有的凭据、不带 acting session，分别尝试改 acceptanceCriteria、判 verdict=PASS、写 project.status=DONE，断言结果与第 1 条结论一致（三条断言）。
4. **凭据铸造场景**：或有一条测试覆盖「用铸造/借用的 owner 凭据发起 HUMAN_ONLY 动作」的结果，或在文档中说明为什么该场景无法用测试表达——两者取其一，不得回避。
5. 合法的无会话路径（headless / cron / user API）未被打断：逐条列出受影响路径并各有一条对照测试。
6. \`coordinator-authority.ts\` 里那段解释「为什么 undefined 是 USER」的注释与最终实现一致——注释与实现不一致是本项目反复强调要避免的。
7. apiserver 全量相对开工基线不新增失败。`,
} as const;

test('a shape mismatch is an advisory question with a suggested criterion and reason', () => {
  const advice = taskCriterionShapeAdvice({
    acceptanceCriteria: '目标 spec 通过，且全量测试不新增失败。',
    completionCriterion: 'EVIDENCE_JUDGMENT',
  });
  assert.ok(advice);
  assert.deepEqual(
    { code: advice.code, kind: advice.kind, advisory: advice.advisory },
    { code: TASK_CRITERION_SHAPE_ADVICE_CODE, kind: 'ADVISORY', advisory: true },
  );
  assert.equal(advice.suggestedCriterion, 'EXECUTABLE');
  assert.match(advice.reason, /不新增失败|spec 通过/);
  const body = taskCriterionShapeAdviceBody(advice);
  assert.match(body.message, /Use EXECUTABLE/);
  assert.equal(body.requiredAction, 'USE_SUGGESTED_CRITERION_OR_EXPLAIN_OVERRIDE');
});

test('tonight N18 and N20 EVIDENCE_JUDGMENT choices are questioned as executable-shaped', () => {
  for (const name of ['N18', 'N20'] as const) {
    const advice = taskCriterionShapeAdvice({
      acceptanceCriteria: TONIGHT[name],
      completionCriterion: 'EVIDENCE_JUDGMENT',
    });
    assert.ok(advice, `${name} should be questioned`);
    assert.equal(advice.suggestedCriterion, 'EXECUTABLE', name);
    assert.match(advice.reason, /mechanically decidable/, name);
  }
});

function serviceFixture() {
  const rows: Array<Record<string, unknown>> = [];
  const task = {
    findMany: async () => [],
    findUnique: async () => null,
    count: async () => 0,
    create: async ({ data }: { data: Record<string, unknown> }) => {
      const row = {
        id: `00000000-0000-7000-8000-${String(rows.length + 1).padStart(12, '0')}`,
        status: 'OPEN',
        creatorSessionId: null,
        projectId: null,
        parentTaskId: null,
        verifiesTaskId: null,
        ...data,
      };
      rows.push(row);
      return row;
    },
  };
  const taskDependency = {
    createMany: async () => ({ count: 0 }),
  };
  const prisma = {
    task,
    taskDependency,
    // EVIDENCE_JUDGMENT is declared against a project's stated criterion, so the tasks below have
    // to be filed under one. Nothing in this file is about the filing; it is what that criterion
    // now costs a fixture that uses it.
    project: {
      findFirst: async () => ({ id: PROJECT, ownerId: 'owner' }),
      findMany: async () => [{ id: PROJECT, ownerId: 'owner' }],
    },
    workspace: { findMany: async () => [] },
    modelProvider: { findMany: async () => [] },
    projectHandoffApproval: { findFirst: async () => null },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({
      task,
      taskDependency,
      $queryRaw: async () => [{ id: 'owner' }],
    }),
  };
  const service = new TasksService(
    prisma as never,
    {} as never,
    { publishForUser: () => undefined } as never,
  );
  // The public get path returns every task scalar. This in-memory relation-free fixture supplies
  // the same stored row while the migration/schema assertion below proves the real scalar exists.
  (service as unknown as { loadDetail: (ownerId: string, id: string) => Promise<unknown> })
    .loadDetail = async (_ownerId, id) => rows.find((row) => row.id === id);
  return { service, rows };
}

test('N17, N19 and N21 may keep EVIDENCE_JUDGMENT with an override reason that is stored and read', async () => {
  const fixture = serviceFixture();
  for (const name of ['N17', 'N19', 'N21'] as const) {
    const reason = `${name}: EVIDENCE_JUDGMENT is deliberate for this task's trust/authority boundary.`;
    const created = await fixture.service.create('owner', {
      title: name,
      projectId: PROJECT,
      acceptanceCriteria: TONIGHT[name],
      completionCriterion: 'EVIDENCE_JUDGMENT',
      completionCriterionOverrideReason: `  ${reason}  `,
    });
    const read = await fixture.service.get('owner', created.id);
    assert.equal(created.completionCriterionOverrideReason, reason, `${name} stored reason`);
    assert.equal(read.completionCriterionOverrideReason, reason, `${name} read reason`);
  }
  assert.equal(fixture.rows.length, 3);

  const schema = readFileSync(path.join(repoRoot(), 'src/apiserver/prisma/schema.prisma'), 'utf8');
  const migration = readFileSync(path.join(
    repoRoot(),
    'src/apiserver/prisma/migrations/0188_task_criterion_shape_advice/migration.sql',
  ), 'utf8');
  assert.match(schema, /completionCriterionOverrideReason\s+String\?/);
  assert.match(migration, /ADD COLUMN "completion_criterion_override_reason" TEXT/);
});

test('a questioned override without a non-blank reason creates nothing', async () => {
  for (const completionCriterionOverrideReason of [undefined, '', '   ']) {
    const fixture = serviceFixture();
    await assert.rejects(
      fixture.service.create('owner', {
        title: 'N18 again',
        acceptanceCriteria: TONIGHT.N18,
        completionCriterion: 'EVIDENCE_JUDGMENT',
        completionCriterionOverrideReason,
      }),
      (error: unknown) => {
        assert.ok(error instanceof ConflictException);
        const body = error.getResponse() as Record<string, unknown>;
        assert.equal(body.code, TASK_CRITERION_SHAPE_ADVICE_CODE);
        assert.equal(body.kind, 'ADVISORY');
        assert.equal(body.advisory, true);
        assert.equal(body.overrideReasonField, 'completionCriterionOverrideReason');
        return true;
      },
    );
    assert.equal(fixture.rows.length, 0);
  }
});

test('N18 declaration consistency is a hard refusal and cannot be swallowed by shape advice', async () => {
  const fixture = serviceFixture();
  let hard: BadRequestException | undefined;
  let soft: ConflictException | undefined;
  try {
    await fixture.service.create('owner', {
      title: 'impossible declaration',
      acceptanceCriteria: TONIGHT.N18,
      completionCriterion: 'EVIDENCE_JUDGMENT',
      acceptanceCommand: 'npm test',
      acceptanceExpectedExitCode: 0,
    });
  } catch (error) {
    assert.ok(error instanceof BadRequestException);
    hard = error;
  }
  try {
    await fixture.service.create('owner', {
      title: 'plausible exception',
      acceptanceCriteria: TONIGHT.N18,
      completionCriterion: 'EVIDENCE_JUDGMENT',
    });
  } catch (error) {
    assert.ok(error instanceof ConflictException);
    soft = error;
  }
  assert.equal((hard?.getResponse() as Record<string, unknown>).code,
    'TASK_COMPLETION_DECLARATION_INVALID');
  assert.equal((hard?.getResponse() as Record<string, unknown>).kind, 'REFUSAL');
  assert.equal((soft?.getResponse() as Record<string, unknown>).code,
    TASK_CRITERION_SHAPE_ADVICE_CODE);
  assert.equal((soft?.getResponse() as Record<string, unknown>).kind, 'ADVISORY');
  assert.equal(fixture.rows.length, 0);
});

test('the keyword table is readable, injectable, and unknown or mixed wording stays silent', () => {
  assert.deepEqual(
    TASK_CRITERION_SHAPE_RULES.map((rule) => [rule.criterion, [...rule.keywords]]),
    [
      ['EXECUTABLE', ['spec 通过', '测试全绿', '退出码', '命令', '不新增失败', 'typecheck']],
      ['VERIFICATION', ['改对了吗', '符合意图', '是否覆盖', '是否合理', '独立复核']],
    ],
    'migration 0224 deleted the EVIDENCE_JUDGMENT row: its keywords said what the work costs, '
    + 'and no wording can say whether an independent session will decide it',
  );
  // The proof that the row is gone rather than merely renamed: its most distinctive keyword now
  // matches nothing at all, so the table cannot advise anybody towards EVIDENCE_JUDGMENT.
  assert.equal(taskCriterionShapeAdvice({
    acceptanceCriteria: '这一步是不可逆的，需要授权。',
    completionCriterion: 'EXECUTABLE',
  }), null);
  assert.equal(
    TASK_CRITERION_SHAPE_RULES.filter((rule) => rule.criterion === 'EVIDENCE_JUDGMENT').length,
    0,
  );
  const amended: TaskCriterionShapeRule[] = TASK_CRITERION_SHAPE_RULES.map((rule) => ({
    ...rule,
    keywords: rule.criterion === 'EXECUTABLE'
      ? [...rule.keywords, 'artifact attests cleanly']
      : [...rule.keywords],
  }));
  assert.equal(taskCriterionShapeAdvice({
    acceptanceCriteria: 'The artifact attests cleanly.',
    completionCriterion: 'EVIDENCE_JUDGMENT',
  }), null, 'unknown wording must not be questioned by the default table');
  assert.equal(taskCriterionShapeAdvice({
    acceptanceCriteria: 'The artifact attests cleanly.',
    completionCriterion: 'EVIDENCE_JUDGMENT',
  }, amended)?.suggestedCriterion, 'EXECUTABLE', 'an explicit table edit changes the advice');
  assert.equal(taskCriterionShapeAdvice({
    acceptanceCriteria: '这次改对了吗，spec 通过了吗',
    completionCriterion: 'EVIDENCE_JUDGMENT',
  }), null, 'mixed shapes are deliberately left for the caller');
});

function repoRoot(): string {
  // build/tasks -> build -> apiserver -> src -> repository root
  return path.resolve(__dirname, '../../../..');
}

test('REST/service creation returns the structured advisory contract', () => {
  const dto = readFileSync(path.join(repoRoot(), 'src/apiserver/src/tasks/dto.ts'), 'utf8');
  const service = readFileSync(
    path.join(repoRoot(), 'src/apiserver/src/tasks/tasks.service.ts'),
    'utf8',
  );
  assert.match(dto, /completionCriterionOverrideReason\?: string/);
  assert.match(service, /ConflictException\(taskCriterionShapeAdviceBody\(advice\)\)/);
});

test('CLI creation receives advice and can send the audited override in all CLI truths', () => {
  const cli = readFileSync(path.join(repoRoot(), 'src/runner-go/task_cli.go'), 'utf8');
  const transport = readFileSync(path.join(repoRoot(), 'src/runner-go/transport.go'), 'utf8');
  assert.match(cli, /--completion-criterion-override-reason TEXT/); // usage/help
  assert.match(cli, /body\["completionCriterionOverrideReason"\]/); // handler
  assert.match(cli, /--completion-criterion-override-reason <text>/); // capabilities
  assert.match(transport, /label = "advice"/); // structured response presentation
});

test('MCP single and batch creation receive advice and forward the same override field', () => {
  const mcp = readFileSync(path.join(repoRoot(), 'src/runner-go/mcp.go'), 'utf8');
  assert.match(mcp, /"completionCriterionOverrideReason": criterionOverrideReasonProp/);
  assert.match(mcp, /copyIfPresent\(body, args,[^\n]+"completionCriterionOverrideReason"/);
  assert.match(mcp, /copyIfPresent\(body, item,[^\n]+"completionCriterionOverrideReason"/);
  assert.match(mcp, /TASK_CRITERION_SHAPE_ADVICE questioned it/);
});

test('web creation preserves the advisory body, renders it as a question, and sends the override', () => {
  const api = readFileSync(path.join(repoRoot(), 'src/web/src/api.ts'), 'utf8');
  const web = readFileSync(path.join(repoRoot(), 'src/web/src/pages/ProjectsPage.tsx'), 'utf8');
  assert.match(api, /public readonly body\?: Readonly<Record<string, unknown>>/);
  assert.match(web, /taskCriterionShapeAdviceFrom/);
  assert.match(web, /type="warning"/);
  assert.match(web, /body\.completionCriterionOverrideReason = overrideReason/);
});
