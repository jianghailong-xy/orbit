import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NEVER_PUBLIC_ID_FIELDS, PUBLIC_ID_FIELDS } from '@orbit/shared';
import {
  ACCEPTANCE_BLOCKED,
  ACCEPTANCE_MISSING,
  ACCEPTANCE_DIGEST_VERSION,
  AcceptanceFacts,
  acceptanceDigest,
  acceptanceResultDigest,
  criteriaFromDefinitions,
  criteriaLegacyProjection,
  criteriaSemanticRevision,
  parseCriteria,
  sha256,
} from './project-acceptance';

// The digest and the criteria parser, on their own. They are pure by design (§13.4 AE1 is a
// function of stated facts), which is what makes "this evidence is about THAT world" checkable by
// anything — a test, a CLI, a future auditor — without a database in the room.

const PROJECT = '00000000-0000-7000-8000-000000002501';

function facts(overrides: Partial<AcceptanceFacts> = {}): AcceptanceFacts {
  return {
    criteriaRevision: sha256('every suite green\nmerged to main'),
    mergeEvidence: [['r1', 'main', 'a'.repeat(64), '3']],
    ...overrides,
  };
}

test('the digest is stable under evidence reordering and changes with acceptance facts', () => {
  const base = facts();
  assert.equal(acceptanceDigest(PROJECT, base), acceptanceDigest(PROJECT, base));

  // Order is not a fact: the same rows read in another order describe the same world. AE1 says
  // `sorted[...]` for exactly this reason, and a digest that moved here would make every DONE
  // depend on a query plan.
  assert.equal(
    acceptanceDigest(PROJECT, base),
    acceptanceDigest(PROJECT, {
      ...base,
      mergeEvidence: [...base.mergeEvidence].reverse(),
    }),
  );

  // Each acceptance projection moves it. Task backlog state is intentionally not a projection:
  // it says how work is organised, not whether these criteria are true.
  const moved: Array<[string, AcceptanceFacts]> = [
    ['criteria edited', facts({ criteriaRevision: sha256('every suite green') })],
    ['branch content changed', facts({ mergeEvidence: [['r1', 'main', 'b'.repeat(64), '4']] })],
    // AE9's whole point: identical content at a new generation is still a different observation,
    // because "changed and changed back" is real for squash and force-push.
    ['same content, new generation', facts({ mergeEvidence: [['r1', 'main', 'a'.repeat(64), '4']] })],
  ];
  for (const [what, changed] of moved) {
    assert.notEqual(acceptanceDigest(PROJECT, changed), acceptanceDigest(PROJECT, base), what);
  }

  const taskMetadata = {
    ...base,
    taskSet: [['nice-to-have', 'OPEN']],
    taskVerdicts: [['verification-task', 'FAIL']],
    // 0227's retired v6 collector. A caller still presenting it is outside the input shape, the
    // same way the two task projections above are.
    executableAttempts: [['project-acceptance-executable-attempt-v1', 'criterion-1']],
  };
  assert.equal(
    acceptanceDigest(PROJECT, taskMetadata),
    acceptanceDigest(PROJECT, base),
    'even extra task metadata presented by an older caller is outside the v4 input shape',
  );
});

test('the digest names the project and its own version', () => {
  const other = '00000000-0000-7000-8000-0000000025ff';
  assert.notEqual(acceptanceDigest(PROJECT, facts()), acceptanceDigest(other, facts()));
  // The version is INSIDE the hash, so a future change to the input shape cannot let an old record
  // match a new reading of the same world. Schema 0179 treats this digest as an evidence-version
  // identity, not a freshness gate: conclusions are evaluated across versions. It moved to 6 when
  // current-plan typed attempt terminations became acceptance facts, and to 7 when migration 0227
  // removed the attempt and that tuple left the input shape again.
  assert.equal(ACCEPTANCE_DIGEST_VERSION, 7);
});

test('the result digest is about the conclusions, not the world', () => {
  const run = '00000000-0000-7000-8000-0000000025aa';
  const outcomes = [
    { ordinal: 1, criterionKey: 'k1', verdict: 'PASS' },
    { ordinal: 2, criterionKey: 'k2', verdict: 'PASS' },
  ];
  assert.equal(acceptanceResultDigest(run, outcomes), acceptanceResultDigest(run, [...outcomes].reverse()));
  assert.notEqual(
    acceptanceResultDigest(run, outcomes),
    acceptanceResultDigest(run, [outcomes[0], { ...outcomes[1], verdict: 'FAIL' }]),
  );
});

test('criteria decompose one per non-blank line, markers are cosmetic, keys are content', () => {
  const parsed = parseCriteria('1. every suite green\n\n- merged to main\n   \n第 3 条 no open blocker');
  assert.deepEqual(parsed.map((c) => c.ordinal), [1, 2, 3]);
  assert.deepEqual(
    parsed.map((c) => c.text),
    ['every suite green', 'merged to main', 'no open blocker'],
  );
  // Renumbering the list does not change what each criterion IS, so a later run can be lined up
  // against an earlier one; editing the words does.
  assert.equal(parseCriteria('7) every suite green')[0].key, parsed[0].key);
  assert.notEqual(parseCriteria('every suite greenish')[0].key, parsed[0].key);

  // A criteria field somebody wrote as one paragraph is one criterion, not none: refusing to
  // decompose it would make acceptance impossible for the most common way people write these.
  assert.equal(parseCriteria('all twelve standards pass').length, 1);
  assert.deepEqual(parseCriteria(''), []);
  assert.deepEqual(parseCriteria(null), []);
});

/** The exact prose that exposed the storage bug on project 34Cn4EO8NtCTVK3gZ8Cr7. The first
 * physical line introduces the numbered checklist; it is not itself something that can pass or
 * fail. Keeping the production text here prevents a tidier synthetic example from accidentally
 * missing the punctuation/Markdown combination that reached the parser. */
const PROJECT_34CN_ACCEPTANCE_CRITERIA = `全部任务 DONE，且以下端到端检验通过（每条都要有断言它的测试，引用测试名而非代码注释）：

1. **解绑成立**：一个 \`coordinatorEnabled=true\` 的项目，其下有 assignee、\`autoRunWhenReady=true\`、前驱已 DONE 的任务，在一个 reconcile 周期内被自动派发起 session。pg spec 断言；并断言 \`execute(auto=true)\` 不再以 \`skipped: 'coordinator-authority'\` stand down。

2. **唤醒幂等**：同一个事实（同一 事件类型 + 主体 id + 主体版本）重复投递 N 次只产生一次唤醒；一次被**拒绝**的唤醒不消耗该键——修正授权后同一事实仍能唤醒。两条都要有断言。

3. **没有定时器**：本项目新增的唤醒路径不含自己的 \`setInterval\`/\`@Interval\`/\`@Cron\`；唤醒只由已提交事实触发。grep 断言 + spec。

4. **一次性判断会话**：一次唤醒开出的会话读库→行动→结束，不被复用；\`session_list\` 能把它与人点开的对话式 coordinator 会话区分开（dispatchOrigin 或等价字段）。

5. **止损可测**：构造连续 N 次唤醒进展向量不严格改善的项目，第 N+1 次唤醒不再开会话而转为需要人的状态；counters 在进程重启后不清零（pg spec，重建 service 实例后读到的是库里的值）。

6. **授权边界可测（coordinator）**：判断会话尝试改 \`acceptanceCriteria\`、写 \`verdict=PASS\`、写 \`project.status=DONE\` 全部被拒，且 refusal code 指名是哪一条边界；开新任务不声明所服务的验收标准被拒。

7. **状态由证据推导（worker）**：执行 session 写自己任务的 \`status=DONE\` 被服务端拒绝、写 \`FAILED\` 通过（人与其他 session 不受影响）；派发 prompt 含该任务的 \`acceptanceCriteria\`，且失败指向 \`FAILED\` 而非 \`IN_PROGRESS\`；带验收命令的任务由退出码推导 DONE/FAILED，全程执行会话不写任何状态。

8. **验收闭环**：一个项目的全部任务到终态后被唤醒一次，并开出 acceptance run（\`project_acceptance\` 的 runs 不再是 \`ACCEPTANCE_NOT_ATTEMPTED\`）；\`project.status=DONE\` 仍由人写。端到端 pg spec 回放：建项目 → 派任务 → 全部终态 → acceptance run 存在。

9. **不新增失败**：\`npm test -w @orbit/web\` 与 apiserver 全量 spec，相对各自开工基线不新增失败。

10. **线上验证**：改动合入 main 并部署后，项目 34CVzEXsUAPMgdDnqwo8v 那 3 个卡住的 OPEN 任务能被自动派发（或说明它们因别的原因不该跑）。`;

test('an unnumbered colon-ended lead-in is not a criterion (34Cn4EO8NtCTVK3gZ8Cr7)', () => {
  const parsed = parseCriteria(PROJECT_34CN_ACCEPTANCE_CRITERIA);

  assert.equal(parsed.length, 10);
  assert.match(parsed[0].text, /^\*\*解绑成立\*\*/u);
  assert.equal(parsed.some((criterion) => criterion.text.startsWith('全部任务 DONE')), false);
});

test('structured criteria preserve identity while semantic revision ignores presentation order', () => {
  const definitions = [
    { id: 'a', ordinal: 1, text: 'every suite green', revision: 4 },
    { id: 'b', ordinal: 2, text: 'merged to main', revision: 1 },
  ];
  const stated = criteriaFromDefinitions(definitions);
  assert.deepEqual(stated.map((criterion) => criterion.definitionId), ['a', 'b']);
  assert.deepEqual(stated.map((criterion) => criterion.definitionRevision), [4, 1]);
  assert.equal(criteriaLegacyProjection(stated), '1. every suite green\n2. merged to main');

  assert.equal(
    criteriaSemanticRevision(definitions),
    criteriaSemanticRevision([...definitions].reverse()),
    'a conjunction does not change when its display order changes',
  );
  assert.notEqual(
    criteriaSemanticRevision(definitions),
    criteriaSemanticRevision([{ ...definitions[0], text: 'every suite green on Linux' }, definitions[1]]),
  );
  assert.notEqual(
    criteriaSemanticRevision(definitions),
    criteriaSemanticRevision([...definitions, { ...definitions[0], id: 'duplicate', ordinal: 3 }]),
    'duplicates remain part of the multiset',
  );
});

test('acceptance refusals distinguish missing conclusions from known blockers', () => {
  assert.deepEqual(
    [...new Set([
      ACCEPTANCE_MISSING,
      ACCEPTANCE_BLOCKED,
    ])].sort(),
    ['ACCEPTANCE_BLOCKED', 'ACCEPTANCE_MISSING'],
  );
});

test('every id the acceptance record serves is classified as a public id', () => {
  // The response interceptor keys on FIELD NAMES, so a new uuid column served under an
  // unclassified name comes back as a raw uuid beside base62 siblings — which is how a client ends
  // up unable to hand back an id it was just given.
  for (const field of [
    'runId', 'acceptedRunId', 'definitionId', 'criterionId',
    'evidenceTaskId', 'evidenceSessionId', 'evidenceRunId', 'decidedById', 'actingSessionId',
  ]) {
    assert.ok(PUBLIC_ID_FIELDS.has(field), `${field} is not classified as a public id`);
    assert.equal(NEVER_PUBLIC_ID_FIELDS.has(field), false, `${field} is classified twice`);
  }
});
