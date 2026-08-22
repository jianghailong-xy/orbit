"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const node_fs_1 = require("node:fs");
const node_path_1 = __importDefault(require("node:path"));
const node_test_1 = require("node:test");
const project_task_dispatcher_service_1 = require("./project-task-dispatcher.service");
const contract_doc_1 = require("./contract-doc");
const project_blocker_1 = require("./project-blocker");
const REPO = node_path_1.default.resolve(__dirname, '../../../..');
const PCC = (0, node_fs_1.readFileSync)(node_path_1.default.join(REPO, 'docs/project-coordinator-contract.md'), 'utf8');
const MIGRATIONS = node_path_1.default.join(REPO, 'src/apiserver/prisma/migrations');
const MIGRATION = (0, node_fs_1.readFileSync)(node_path_1.default.join(MIGRATIONS, '0125_project_blocker/migration.sql'), 'utf8');
/**
 * The kind CHECK as it stands after every migration, not as 0125 first wrote it.
 *
 * A closed set that can only ever be read from the migration that CREATED it is a set that can
 * never grow: adding a kind means a later migration drops and re-adds the constraint (an applied
 * migration may not be edited), and a test pinned to the first one would then be asserting a
 * historical fact about a database nobody runs. Directory order is deployment order, so the last
 * file that declares the constraint is the one in force.
 */
function kindCheckInForce() {
    const declared = (0, node_fs_1.readdirSync)(MIGRATIONS)
        .filter((entry) => /^\d{4}_/.test(entry))
        .sort()
        .map((entry) => node_path_1.default.join(MIGRATIONS, entry, 'migration.sql'))
        .filter((file) => (0, node_fs_1.existsSync)(file))
        .map((file) => (0, node_fs_1.readFileSync)(file, 'utf8'))
        .map((sql) => /project_blocker_kind_chk[\s\S]*?CHECK \("kind" IN \(([\s\S]*?)\)\)/.exec(sql))
        .filter((match) => match !== null);
    strict_1.default.ok(declared.length > 0, 'no migration declares the project_blocker kind CHECK');
    return [...declared.at(-1)[1].matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]);
}
// Read from the repo, not from `__dirname`: these specs run compiled, out of `build/`.
const SRC = node_path_1.default.join(REPO, 'src/apiserver/src/projects');
const AUTHORIZATION = (0, node_fs_1.readFileSync)(node_path_1.default.join(SRC, 'project-authorization.service.ts'), 'utf8');
const DISPATCHER = (0, node_fs_1.readFileSync)(node_path_1.default.join(SRC, 'project-task-dispatcher.service.ts'), 'utf8');
const EPOCH = Math.floor(Date.parse('2026-08-20T00:00:00.000Z') / 1_000);
const PROJECT = 'PPPPPPPPPPPPPPPPPPPPPP';
const TASK = 'TTTTTTTTTTTTTTTTTTTTTT';
const MINUTE = 60_000;
// ── §11.2's table is the source, and it lives in the document ────────────────────────────────
// The point of reading the markdown rather than restating it: a kind whose owner is edited in one
// place and not the other is exactly the drift `PC-CX-06` and `PC-CX-12` were, and neither of them
// produced a compile error.
/** §11.2's kind table, as the document states it. */
function contractKindTable() {
    const md = (0, contract_doc_1.section)(PCC, '11.2');
    const table = (0, contract_doc_1.tables)(md).find((rows) => (0, contract_doc_1.bare)(rows[0][0]) === 'kind');
    strict_1.default.ok(table, '§11.2 no longer has a table headed `kind`');
    return table;
}
/**
 * The rows §11.2 says are LANDED — the ones whose `落地` column reads `已落地`.
 *
 * BL8 (v1.16) is why this is not simply every row. PAC §12 can mint a dispatch refusal, and PAC
 * §7.4 AU-F says it has to become a blocker kind; the contract records that immediately, while the
 * CHECK constraint and this module's policy table move with the migration step §12.1 declares for
 * it. Without the column there were only two possible rules and both are wrong: "equal to the
 * implementation" refuses to let a new refusal into the contract at all, and "unconstrained" stops
 * seeing drift. So the column carries the distinction, and PAC's own self-check (`00.14`) is what
 * stops it being used to park a kind in the contract forever: an unlanded kind must be named by
 * exactly one declared migration step, and a landed one by none.
 */
function landedKinds() {
    const rows = contractKindTable();
    const kinds = (0, contract_doc_1.column)(rows, 'kind').map(contract_doc_1.bare);
    const landed = (0, contract_doc_1.column)(rows, '落地').map(contract_doc_1.bare);
    return kinds.filter((_, i) => landed[i] === '已落地');
}
(0, node_test_1.test)('§11.2: the implemented kind set IS the document\'s, in the document\'s order', () => {
    strict_1.default.deepEqual([...project_blocker_1.PROJECT_BLOCKER_KINDS], landedKinds());
    // …and the rest of the table is not free-floating: every unlanded kind is one PAC §12 refuses a
    // dispatch with, so BL8's first direction still holds over the WHOLE table.
    const rows = contractKindTable();
    const kinds = (0, contract_doc_1.column)(rows, 'kind').map(contract_doc_1.bare);
    const pending = kinds.filter((k) => !landedKinds().includes(k));
    const sources = (0, contract_doc_1.column)(rows, '来源').map(contract_doc_1.bare);
    for (const kind of pending) {
        strict_1.default.equal(sources[kinds.indexOf(kind)], 'PAC §12', `§11.2 leaves \`${kind}\` unlanded without it being a PAC refusal code — nothing would ever land it`);
    }
});
(0, node_test_1.test)('§11.2: the migration CHECK freezes exactly the same closed set', () => {
    strict_1.default.deepEqual(kindCheckInForce().sort(), [...project_blocker_1.PROJECT_BLOCKER_KINDS].sort());
    // …and 0125 is still where it started, so a rewrite of history would be visible here too.
    strict_1.default.match(MIGRATION, /project_blocker_kind_chk/);
});
(0, node_test_1.test)('§11.2: every kind carries the document\'s owner and recovery', () => {
    const rows = contractKindTable();
    const kinds = (0, contract_doc_1.column)(rows, 'kind').map(contract_doc_1.bare);
    const owners = (0, contract_doc_1.column)(rows, '默认 owner').map(contract_doc_1.bare);
    const recoveries = (0, contract_doc_1.column)(rows, 'recovery').map(contract_doc_1.bare);
    for (const [at, kind] of kinds.entries()) {
        if (!landedKinds().includes(kind))
            continue;
        const policy = project_blocker_1.PROJECT_BLOCKER_POLICY[kind];
        strict_1.default.equal(policy.owner, owners[at], `${kind} owner`);
        strict_1.default.equal(policy.recovery, recoveries[at], `${kind} recovery`);
    }
});
(0, node_test_1.test)('BL4: opensTurn is true for exactly the kinds whose default owner is COORDINATOR', () => {
    const rows = contractKindTable();
    const kinds = (0, contract_doc_1.column)(rows, 'kind').map(contract_doc_1.bare);
    const opens = (0, contract_doc_1.column)(rows, 'opensTurn').map(contract_doc_1.bare);
    for (const [at, kind] of kinds.entries()) {
        if (!landedKinds().includes(kind))
            continue;
        const policy = project_blocker_1.PROJECT_BLOCKER_POLICY[kind];
        strict_1.default.equal(policy.opensTurn, opens[at] === '✔', `${kind} opensTurn`);
        // Both directions, which is the whole of BL4: v1 hung "wake the coordinator" on `owner`, then
        // assigned `owner` by another rule elsewhere, and TEST_FAILED got two contradictory answers.
        strict_1.default.equal(policy.opensTurn, policy.owner === 'COORDINATOR', `${kind} BL4 iff`);
    }
});
(0, node_test_1.test)('§7.2 BLOCKER_DECISION reads exactly the opensTurn kinds', () => {
    const row = (0, contract_doc_1.tables)((0, contract_doc_1.section)(PCC, '7.2'))
        .flat()
        .find((cells) => cells.some((cell) => cell.includes('BLOCKER_DECISION')));
    strict_1.default.ok(row, '§7.2 no longer has a BLOCKER_DECISION row');
    // The document writes the four as one backticked SET, so read every SCREAMING token in the row
    // and keep the ones that name a kind.
    const listed = [...row.join(' ').matchAll(/[A-Z][A-Z_]{3,}/g)]
        .map((m) => m[0])
        .filter((name) => project_blocker_1.PROJECT_BLOCKER_KINDS.includes(name));
    strict_1.default.deepEqual([...new Set(listed)].sort(), [...project_blocker_1.PROJECT_BLOCKER_TURN_KINDS].sort());
});
(0, node_test_1.test)('BL5: next_check_at means the right thing for each recovery axis', () => {
    for (const kind of project_blocker_1.PROJECT_BLOCKER_KINDS) {
        const policy = project_blocker_1.PROJECT_BLOCKER_POLICY[kind];
        const raise = onlyRaise(plan([], [condition(kind)]));
        if (policy.recovery === 'EVENT') {
            // A recompute poll, measured from the frozen epoch.
            strict_1.default.equal(raise.nextCheckAt, iso(EPOCH * 1_000 + policy.pollMs), `${kind} poll`);
        }
        else if (policy.recovery === 'HUMAN') {
            // The escalation alarm, and NOT a recovery poll: once it fires this row stops ticking.
            strict_1.default.equal(raise.nextCheckAt, iso(EPOCH * 1_000 + policy.escalateMs), `${kind} alarm`);
            strict_1.default.equal(policy.pollMs, null, `${kind} must not also carry a poll`);
        }
        else {
            const at = iso(EPOCH * 1_000 + 3 * 60 * MINUTE);
            const timed = onlyRaise(plan([], [{ ...condition(kind), recoveryAt: at }]));
            strict_1.default.equal(timed.nextCheckAt, at, `${kind} recovery instant`);
        }
    }
});
(0, node_test_1.test)('§11.1: a raise answers all five questions and carries every audited column', () => {
    for (const kind of project_blocker_1.PROJECT_BLOCKER_KINDS) {
        const raise = onlyRaise(plan([], [{ ...condition(kind), recoveryAt: iso(EPOCH * 1_000 + MINUTE) }]));
        const policy = project_blocker_1.PROJECT_BLOCKER_POLICY[kind];
        strict_1.default.equal(raise.kind, kind);
        strict_1.default.equal(raise.owner, policy.owner);
        strict_1.default.equal(raise.recovery, policy.recovery);
        strict_1.default.equal(raise.severity, policy.severity);
        strict_1.default.equal(raise.requiredAction, policy.requiredAction);
        strict_1.default.ok(raise.requiredAction.endsWith('.'), `${kind} required action must be a sentence`);
        strict_1.default.equal(raise.subjectType, 'TASK');
        strict_1.default.equal(raise.subjectId, TASK);
        strict_1.default.equal(raise.dedupeKey, `${kind}:TASK:${TASK}`);
        strict_1.default.match(raise.conditionVersion, /^[0-9a-f]{64}$/);
        strict_1.default.ok(Date.parse(raise.nextCheckAt) > EPOCH * 1_000, `${kind} must have a next check`);
        strict_1.default.deepEqual(raise.detail, { note: kind });
    }
});
// ── §11.3 dedupe, and BL7's exclusion set ───────────────────────────────────────────────────
(0, node_test_1.test)('§11.3: the default dedupe key is <kind>:<subjectType>:<subjectId>', () => {
    strict_1.default.equal((0, project_blocker_1.projectBlockerDedupeKey)('MERGE_CONFLICT', 'TASK', TASK), `MERGE_CONFLICT:TASK:${TASK}`);
    strict_1.default.equal((0, project_blocker_1.raiseBlockerIdempotencyKey)('p', 'TEST_FAILED', 't', 7n), 'pc:v1:p:blocker:TEST_FAILED:t:7');
    strict_1.default.equal((0, project_blocker_1.clearBlockerIdempotencyKey)('p', 'b'), 'pc:v1:p:unblock:b');
});
(0, node_test_1.test)('§11.3: a repeat cause touches the open row instead of opening a second one', () => {
    const open = fact('MERGE_CONFLICT', { occurrences: 41 });
    const result = plan([open], [condition('MERGE_CONFLICT')]);
    strict_1.default.deepEqual(result.raises, []);
    strict_1.default.deepEqual(result.clears, []);
    strict_1.default.equal(result.touches.length, 1);
    strict_1.default.equal(result.touches[0].blockerId, open.id);
    strict_1.default.equal(result.openAfter.length, 1);
    strict_1.default.equal(result.openAfter[0].lifecycleGeneration, open.lifecycleGeneration);
});
(0, node_test_1.test)('TF2: the digest follows the FACTS, not how often they were seen', () => {
    const facts = { targetBranch: 'main', paths: ['a.ts'] };
    const same = (0, project_blocker_1.projectBlockerConditionVersion)('MERGE_CONFLICT', 'TASK', TASK, facts);
    strict_1.default.equal((0, project_blocker_1.projectBlockerConditionVersion)('MERGE_CONFLICT', 'TASK', TASK, { ...facts }), same);
    // Key order must not matter; a changed fact must.
    strict_1.default.equal((0, project_blocker_1.projectBlockerConditionVersion)('MERGE_CONFLICT', 'TASK', TASK, { paths: ['a.ts'], targetBranch: 'main' }), same);
    strict_1.default.notEqual((0, project_blocker_1.projectBlockerConditionVersion)('MERGE_CONFLICT', 'TASK', TASK, { ...facts, paths: ['a.ts', 'b.ts'] }), same);
});
(0, node_test_1.test)('§11.3: a changed condition on an open row overwrites the digest without reopening it', () => {
    const open = fact('MERGE_CONFLICT', { conditionVersion: 'f'.repeat(64) });
    const result = plan([open], [{ ...condition('MERGE_CONFLICT'), facts: { paths: ['b.ts'] } }]);
    strict_1.default.deepEqual(result.raises, []);
    strict_1.default.notEqual(result.touches[0].conditionVersion, open.conditionVersion);
    strict_1.default.equal(result.touches[0].conditionVersion, (0, project_blocker_1.projectBlockerConditionVersion)('MERGE_CONFLICT', 'TASK', TASK, { paths: ['b.ts'] }));
});
(0, node_test_1.test)('ES5: N deliveries, reordered and across a restart, are byte-identical to N = 1', () => {
    const one = plan([], [condition('MERGE_CONFLICT'), condition('TEST_FAILED')]);
    // The same world delivered ten times, in the other order, is the same world.
    const ten = plan([], [
        ...Array.from({ length: 5 }, () => condition('TEST_FAILED')),
        ...Array.from({ length: 5 }, () => condition('MERGE_CONFLICT')),
    ]);
    strict_1.default.equal(JSON.stringify(ten), JSON.stringify(one));
    // And once the rows exist, redelivery moves nothing this plan decides. `occurrences` and
    // `lastSeenAt` are the only things allowed to differ and they are written by the database, so at
    // this layer the plan is a touch with the SAME digest and no escalation.
    const open = [fact('MERGE_CONFLICT', { occurrences: 1 }), fact('TEST_FAILED', { occurrences: 97 })];
    const after = plan(open, [condition('TEST_FAILED'), condition('MERGE_CONFLICT')]);
    strict_1.default.deepEqual(after.raises, []);
    strict_1.default.deepEqual(after.clears, []);
    strict_1.default.deepEqual(after.escalations, []);
    strict_1.default.deepEqual(after.openAfter.map((row) => [row.kind, row.owner, row.recovery, row.escalatedAt, row.lifecycleGeneration]), [['MERGE_CONFLICT', 'COORDINATOR', 'EVENT', null, '3'], ['TEST_FAILED', 'USER', 'HUMAN', null, '3']]);
});
(0, node_test_1.test)('BL7: occurrences enters no key, no digest and no escalation', () => {
    const quiet = fact('TEST_FAILED', { occurrences: 1 });
    const loud = fact('TEST_FAILED', { occurrences: 10_000 });
    const a = plan([quiet], [condition('TEST_FAILED')]);
    const b = plan([loud], [condition('TEST_FAILED')]);
    strict_1.default.equal(JSON.stringify(a), JSON.stringify(b));
    // And it cannot buy an escalation the clock has not earned.
    strict_1.default.deepEqual(plan([loud], [condition('TEST_FAILED')]).escalations, []);
});
// ── §11.4 auto-clear ────────────────────────────────────────────────────────────────────────
(0, node_test_1.test)('§11.4 BL3: a condition the recomputation no longer sees is cleared as AUTO', () => {
    const open = fact('PROVIDER_UNAVAILABLE');
    const result = plan([open], []);
    strict_1.default.deepEqual(result.raises, []);
    strict_1.default.deepEqual(result.touches, []);
    strict_1.default.deepEqual(result.clears, [{
            blockerId: open.id,
            dedupeKey: open.dedupeKey,
            kind: 'PROVIDER_UNAVAILABLE',
            lifecycleGeneration: open.lifecycleGeneration,
        }]);
    strict_1.default.deepEqual(result.openAfter, []);
});
(0, node_test_1.test)('§11.4: clearing one condition leaves the others open', () => {
    const gone = fact('PROVIDER_UNAVAILABLE');
    const stays = fact('TEST_FAILED');
    const result = plan([gone, stays], [condition('TEST_FAILED')]);
    strict_1.default.deepEqual(result.clears.map((clear) => clear.kind), ['PROVIDER_UNAVAILABLE']);
    strict_1.default.deepEqual(result.openAfter.map((row) => row.kind), ['TEST_FAILED']);
});
(0, node_test_1.test)('BE1: a cleared condition that comes back is a RAISE, not a reopen', () => {
    // The row is resolved, so it is not in the open set any more; the same cause is a fresh raise and
    // the database allocates it `MAX + 1`. Reopening the old row in place would hand a new failure the
    // old episode's identity, which is what §7.6 TR3 then misreads as "no progress".
    const result = plan([], [condition('MERGE_CONFLICT')]);
    strict_1.default.equal(result.raises.length, 1);
    strict_1.default.equal(result.raises[0].dedupeKey, `MERGE_CONFLICT:TASK:${TASK}`);
});
// ── §11.5 escalation ────────────────────────────────────────────────────────────────────────
(0, node_test_1.test)('ES4/ES3/ES1: escalation is driven only by age, goes to USER, and leaves recovery alone', () => {
    const budget = fact('BUDGET_EXHAUSTED', {
        firstSeenAt: iso(EPOCH * 1_000 - project_blocker_1.PROJECT_BLOCKER_POLICY.BUDGET_EXHAUSTED.escalateMs),
        subjectType: 'PROJECT',
        subjectId: PROJECT,
    });
    const result = plan([budget], [{ ...condition('BUDGET_EXHAUSTED'), subjectType: 'PROJECT', subjectId: PROJECT }]);
    strict_1.default.equal(result.escalations.length, 1);
    strict_1.default.equal(result.escalations[0].owner, 'USER');
    strict_1.default.equal(result.escalations[0].blockerId, budget.id);
    const after = result.openAfter[0];
    strict_1.default.equal(after.owner, 'USER');
    // ES1: still TIME, so it still clears itself when the window rolls. Escalation says "somebody
    // should look at this", not "from now on only a person can end it".
    strict_1.default.equal(after.recovery, 'TIME');
    strict_1.default.equal(after.escalatedAt, iso(EPOCH * 1_000));
});
(0, node_test_1.test)('ES4: one second before the threshold, nothing escalates', () => {
    const open = fact('TEST_FAILED', {
        firstSeenAt: iso(EPOCH * 1_000 - project_blocker_1.PROJECT_BLOCKER_POLICY.TEST_FAILED.escalateMs + 1_000),
    });
    strict_1.default.deepEqual(plan([open], [condition('TEST_FAILED')]).escalations, []);
});
(0, node_test_1.test)('ES3/§11.5: a blocker escalates at most once in its lifecycle', () => {
    const open = fact('TEST_FAILED', {
        firstSeenAt: iso(EPOCH * 1_000 - 10 * 60 * MINUTE),
        escalatedAt: iso(EPOCH * 1_000 - 5 * 60 * MINUTE),
        owner: 'USER',
    });
    strict_1.default.deepEqual(plan([open], [condition('TEST_FAILED')]).escalations, []);
});
(0, node_test_1.test)('a raise cannot also escalate in the pass that opened it', () => {
    for (const kind of project_blocker_1.PROJECT_BLOCKER_KINDS) {
        strict_1.default.deepEqual(plan([], [condition(kind)]).escalations, [], kind);
    }
});
// ── §4.2 guards 2 and 3 ─────────────────────────────────────────────────────────────────────
(0, node_test_1.test)('I4a/I4b: a USER blocker wins, and it masks without silencing', () => {
    strict_1.default.equal((0, project_blocker_1.blockerRunState)([]), null);
    strict_1.default.equal((0, project_blocker_1.blockerRunState)([{ owner: 'SYSTEM' }]), 'BLOCKED');
    strict_1.default.equal((0, project_blocker_1.blockerRunState)([{ owner: 'COORDINATOR' }]), 'BLOCKED');
    strict_1.default.equal((0, project_blocker_1.blockerRunState)([{ owner: 'USER' }]), 'AWAITING_HUMAN');
    strict_1.default.equal((0, project_blocker_1.blockerRunState)([{ owner: 'SYSTEM' }, { owner: 'USER' }]), 'AWAITING_HUMAN');
    // Order must not decide it — that was `PC-CX-03`.
    strict_1.default.equal((0, project_blocker_1.blockerRunState)([{ owner: 'USER' }, { owner: 'SYSTEM' }]), 'AWAITING_HUMAN');
});
(0, node_test_1.test)('N-mask: a masked SYSTEM blocker is still recomputed and still carries its own clock', () => {
    const masked = fact('PROVIDER_UNAVAILABLE');
    const masking = fact('TEST_FAILED');
    const result = plan([masked, masking], [condition('PROVIDER_UNAVAILABLE'), condition('TEST_FAILED')]);
    const provider = result.openAfter.find((row) => row.kind === 'PROVIDER_UNAVAILABLE');
    strict_1.default.ok(provider, 'the masked row stays open');
    strict_1.default.equal(provider.recovery, 'EVENT');
    strict_1.default.equal(provider.nextCheckAt, iso(EPOCH * 1_000 + project_blocker_1.PROJECT_BLOCKER_POLICY.PROVIDER_UNAVAILABLE.pollMs));
});
// ── BL2 fail closed ─────────────────────────────────────────────────────────────────────────
// ── §5.4 F22: the dead letter both writers have to name identically ─────────────────────────────
const DEAD_A = { eventId: 'AAAAAAAAAAAAAAAAAAAAAA', kind: 'task.updated', dedupeKey: 'task.updated:1', attempts: 10 };
const DEAD_B = { eventId: 'BBBBBBBBBBBBBBBBBBBBBB', kind: 'session.ended', dedupeKey: 'session.ended:1', attempts: 10 };
(0, node_test_1.test)('F22: a dead letter is a PROJECT-subject UNKNOWN_FAILURE, so it stops the whole project', () => {
    const condition = (0, project_blocker_1.projectDeadLetterCondition)(PROJECT, [DEAD_A]);
    strict_1.default.equal(condition.kind, 'UNKNOWN_FAILURE');
    strict_1.default.equal(condition.subjectType, 'PROJECT');
    strict_1.default.equal(condition.subjectId, PROJECT);
    // The dedupe key is the whole point: the delivery path opens the row and §11.4's recomputation
    // keeps it open, and they only meet on this string.
    strict_1.default.equal((0, project_blocker_1.projectBlockerDedupeKey)(condition.kind, condition.subjectType, condition.subjectId), `UNKNOWN_FAILURE:PROJECT:${PROJECT}`);
    // §11.2's row, reached through the policy table rather than restated: whoever writes it gets a
    // person as the owner, a person as the only recovery, and an escalation alarm for a clock.
    const [raise] = (0, project_blocker_1.planProjectBlockers)({ epoch: EPOCH, open: [], observed: [condition] }).raises;
    strict_1.default.equal(raise.owner, 'USER');
    strict_1.default.equal(raise.recovery, 'HUMAN');
    strict_1.default.equal(raise.severity, 'CRITICAL');
    strict_1.default.ok(raise.requiredAction.length > 0);
    strict_1.default.equal(Date.parse(raise.nextCheckAt), EPOCH * 1_000 + 30 * MINUTE);
});
(0, node_test_1.test)('F22: the same losses in any order are one condition, and a new loss is a changed one', () => {
    // Redelivery reorders batches, and two instances can dead-letter the same events from different
    // sides of a restart. TF2 has to see one condition through all of it, so the digest is taken over
    // a SET of event identities — never over the order they arrived in or how many attempts each took.
    const forwards = (0, project_blocker_1.projectDeadLetterCondition)(PROJECT, [DEAD_A, DEAD_B]);
    const backwards = (0, project_blocker_1.projectDeadLetterCondition)(PROJECT, [DEAD_B, DEAD_A]);
    const version = (condition) => (0, project_blocker_1.projectBlockerConditionVersion)(condition.kind, condition.subjectType, condition.subjectId, condition.facts);
    strict_1.default.equal(version(forwards), version(backwards));
    strict_1.default.deepEqual(forwards.detail, backwards.detail, 'the display payload is order-free too');
    strict_1.default.notEqual(version(forwards), version((0, project_blocker_1.projectDeadLetterCondition)(PROJECT, [DEAD_A])), 'a signal lost that was not lost before is a changed condition, not the same one');
    strict_1.default.equal(version((0, project_blocker_1.projectDeadLetterCondition)(PROJECT, [{ ...DEAD_A, attempts: 40 }])), version((0, project_blocker_1.projectDeadLetterCondition)(PROJECT, [DEAD_A])), 'BL7: how hard delivery tried is a delivery observation, not the condition');
});
(0, node_test_1.test)('F22: a second dead letter touches the open episode instead of opening a second one', () => {
    const first = (0, project_blocker_1.planProjectBlockers)({
        epoch: EPOCH, open: [], observed: [(0, project_blocker_1.projectDeadLetterCondition)(PROJECT, [DEAD_A])],
    });
    const [raise] = first.raises;
    const open = [{
            id: 'BLOCKERBLOCKERBLOCKER1',
            kind: raise.kind,
            owner: raise.owner,
            recovery: raise.recovery,
            severity: raise.severity,
            requiredAction: raise.requiredAction,
            subjectType: raise.subjectType,
            subjectId: raise.subjectId,
            dedupeKey: raise.dedupeKey,
            lifecycleGeneration: '1',
            conditionVersion: raise.conditionVersion,
            firstSeenAt: raise.firstSeenAt,
            lastSeenAt: raise.firstSeenAt,
            occurrences: 1,
            nextCheckAt: raise.nextCheckAt,
            escalatedAt: null,
        }];
    const second = (0, project_blocker_1.planProjectBlockers)({
        epoch: EPOCH + 60, open, observed: [(0, project_blocker_1.projectDeadLetterCondition)(PROJECT, [DEAD_A, DEAD_B])],
    });
    strict_1.default.deepEqual(second.raises, [], 'the episode is already open');
    strict_1.default.deepEqual(second.clears, [], 'and the losses have not gone away');
    strict_1.default.equal(second.touches.length, 1);
    strict_1.default.equal(second.touches[0].blockerId, 'BLOCKERBLOCKERBLOCKER1');
    strict_1.default.notEqual(second.touches[0].conditionVersion, raise.conditionVersion, 'the digest follows the set of lost signals, which grew');
    strict_1.default.equal(second.openAfter[0].firstSeenAt, raise.firstSeenAt, 'ES5: the age the escalation is measured from does not restart');
    strict_1.default.equal(second.openAfter[0].nextCheckAt, raise.nextCheckAt, 'BL5: a HUMAN row\'s clock is its escalation alarm, so it does not move with redelivery');
});
(0, node_test_1.test)('F22: nothing but a person clears it — the recomputation on its own never does', () => {
    // §11.4 clears whatever it no longer observes, which is exactly how every other kind recovers.
    // This one has no world left to look at — the event is gone and its effect never happened — so
    // the condition holds until the snapshot stops carrying it, and only an acknowledgement can do
    // that. Asserted in both directions so "it never clears" cannot be true by accident.
    const condition = (0, project_blocker_1.projectDeadLetterCondition)(PROJECT, [DEAD_A]);
    const [raise] = (0, project_blocker_1.planProjectBlockers)({ epoch: EPOCH, open: [], observed: [condition] }).raises;
    const open = [{
            id: 'BLOCKERBLOCKERBLOCKER2',
            kind: raise.kind, owner: raise.owner, recovery: raise.recovery, severity: raise.severity,
            requiredAction: raise.requiredAction, subjectType: raise.subjectType,
            subjectId: raise.subjectId, dedupeKey: raise.dedupeKey, lifecycleGeneration: '1',
            conditionVersion: raise.conditionVersion, firstSeenAt: raise.firstSeenAt,
            lastSeenAt: raise.firstSeenAt, occurrences: 1, nextCheckAt: raise.nextCheckAt,
            escalatedAt: null,
        }];
    strict_1.default.deepEqual((0, project_blocker_1.planProjectBlockers)({ epoch: EPOCH + 3_600, open, observed: [condition] }).clears, [], 'an hour of healthy passes does not resolve a signal that is still lost');
    strict_1.default.deepEqual((0, project_blocker_1.planProjectBlockers)({ epoch: EPOCH + 3_600, open, observed: [] }).clears.map((c) => c.blockerId), ['BLOCKERBLOCKERBLOCKER2'], 'and once the snapshot stops carrying it — somebody acknowledged it — it clears like anything else');
});
(0, node_test_1.test)('BL2: an unclassified refusal becomes UNKNOWN_FAILURE, never nothing', () => {
    strict_1.default.equal((0, project_blocker_1.blockerKindForRefusal)('SOMETHING_NOBODY_CLASSIFIED'), 'UNKNOWN_FAILURE');
    strict_1.default.equal((0, project_blocker_1.blockerKindForRefusal)(null), 'UNKNOWN_FAILURE');
    strict_1.default.equal((0, project_blocker_1.blockerKindForRefusal)(undefined), 'UNKNOWN_FAILURE');
    strict_1.default.equal((0, project_blocker_1.blockerKindForRefusal)(''), 'UNKNOWN_FAILURE');
    strict_1.default.equal((0, project_blocker_1.blockerKindForRefusal)('WHO_UNRESOLVED'), 'WHO_UNRESOLVED');
    strict_1.default.equal((0, project_blocker_1.blockerKindForRefusal)('RUNNER_UNAVAILABLE'), 'NO_MATCHING_RUNNER');
    strict_1.default.equal((0, project_blocker_1.blockerKindForRefusal)('RETRY_BACKOFF_ACTIVE'), null);
});
(0, node_test_1.test)('BL2: every refusal code the resolution chain can emit is classified exactly once', () => {
    // Only the reason-code union: the same file declares other string unions, and folding an action
    // TYPE into this list would ask the wrong question about it.
    const union = /export type ProjectAuthorizationReasonCode =([\s\S]*?);\n/.exec(AUTHORIZATION);
    strict_1.default.ok(union, 'the reason-code union no longer parses');
    const reasonCodes = [...union[1].matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]);
    strict_1.default.ok(reasonCodes.length > 20, 'the reason-code union no longer parses');
    const refusalCodes = [...DISPATCHER.matchAll(/this\.refusal\(\s*'([A-Z_]+)'/g)].map((m) => m[1]);
    strict_1.default.ok(refusalCodes.length > 3, 'the dispatcher refusal codes no longer parse');
    const unclassified = [...new Set([...reasonCodes, ...refusalCodes])].filter((code) => !(code in project_blocker_1.PROJECT_BLOCKER_REFUSAL_KINDS) && !project_blocker_1.PROJECT_BLOCKER_NON_BLOCKING_REFUSALS.has(code));
    strict_1.default.deepEqual(unclassified, [], 'a refusal code in neither list falls through to UNKNOWN_FAILURE at runtime — decide which it is');
    const both = [...new Set([...reasonCodes, ...refusalCodes])].filter((code) => code in project_blocker_1.PROJECT_BLOCKER_REFUSAL_KINDS && project_blocker_1.PROJECT_BLOCKER_NON_BLOCKING_REFUSALS.has(code));
    strict_1.default.deepEqual(both, [], 'classified as both a blocker and not one');
});
(0, node_test_1.test)('the guard\'s own refusal is transparent, so a blocker cannot breed a second one', () => {
    strict_1.default.ok(project_blocker_1.PROJECT_BLOCKER_NON_BLOCKING_REFUSALS.has('PROJECT_BLOCKED'));
    strict_1.default.equal((0, project_blocker_1.blockerKindForRefusal)('PROJECT_BLOCKED'), null);
    strict_1.default.match(DISPATCHER, /this\.refusal\('PROJECT_BLOCKED'/, 'the dispatcher must stop a blocked task with the code this list exempts');
});
// ── determinism ─────────────────────────────────────────────────────────────────────────────
(0, node_test_1.test)('the plan is sorted, so the same world always produces the same audit bytes', () => {
    const kinds = ['TEST_FAILED', 'MERGE_CONFLICT', 'WHO_UNRESOLVED'];
    const forward = plan([], kinds.map((kind) => condition(kind)));
    const backward = plan([], [...kinds].reverse().map((kind) => condition(kind)));
    strict_1.default.equal(JSON.stringify(forward), JSON.stringify(backward));
    strict_1.default.deepEqual(forward.raises.map((raise) => raise.kind), ['MERGE_CONFLICT', 'TEST_FAILED', 'WHO_UNRESOLVED']);
});
// ── helpers ─────────────────────────────────────────────────────────────────────────────────
function plan(open, observed) {
    return (0, project_blocker_1.planProjectBlockers)({ epoch: EPOCH, open, observed });
}
function onlyRaise(result) {
    strict_1.default.equal(result.raises.length, 1, 'expected exactly one raise');
    return result.raises[0];
}
function condition(kind) {
    return {
        kind,
        subjectType: 'TASK',
        subjectId: TASK,
        facts: { kind },
        detail: { note: kind },
    };
}
function fact(kind, overrides = {}) {
    const policy = project_blocker_1.PROJECT_BLOCKER_POLICY[kind];
    const subjectType = overrides.subjectType ?? 'TASK';
    const subjectId = overrides.subjectId ?? TASK;
    return {
        id: `blocker-${kind}`,
        kind,
        owner: policy.owner,
        recovery: policy.recovery,
        severity: policy.severity,
        requiredAction: policy.requiredAction,
        subjectType,
        subjectId,
        dedupeKey: (0, project_blocker_1.projectBlockerDedupeKey)(kind, subjectType, subjectId),
        lifecycleGeneration: '3',
        conditionVersion: (0, project_blocker_1.projectBlockerConditionVersion)(kind, subjectType, subjectId, { kind }),
        firstSeenAt: iso(EPOCH * 1_000 - MINUTE),
        lastSeenAt: iso(EPOCH * 1_000 - MINUTE),
        occurrences: 1,
        nextCheckAt: iso(EPOCH * 1_000 + MINUTE),
        escalatedAt: null,
        ...overrides,
    };
}
function iso(ms) {
    return new Date(ms).toISOString();
}
(0, node_test_1.test)('§13.1 AG6: the refusal is non-blocking, and its wire code is one old readers know', () => {
    // If this code ever became a blocker it would be a PROJECT-subject `UNKNOWN_FAILURE`, §11 BL1
    // would read that as "stop everything", and §11.4 could never clear it — the attempt it needs to
    // let through will always be refused for the same reason.
    strict_1.default.equal((0, project_blocker_1.blockerKindForRefusal)('TASK_AGGREGATE_PARENT'), null);
    strict_1.default.ok(project_blocker_1.PROJECT_BLOCKER_NON_BLOCKING_REFUSALS.has('TASK_AGGREGATE_PARENT'));
    // ...and the durable column carries a code a replica that predates this release also classifies
    // as non-blocking, because adding it to THIS build's list does nothing for the one beside it.
    strict_1.default.equal((0, project_task_dispatcher_service_1.wireRefusalCode)('TASK_AGGREGATE_PARENT'), 'STALE_SNAPSHOT');
    strict_1.default.equal((0, project_blocker_1.blockerKindForRefusal)((0, project_task_dispatcher_service_1.wireRefusalCode)('TASK_AGGREGATE_PARENT')), null);
    // Every other code is passed through untouched.
    strict_1.default.equal((0, project_task_dispatcher_service_1.wireRefusalCode)('RUNNER_UNAVAILABLE'), 'RUNNER_UNAVAILABLE');
});
//# sourceMappingURL=project-blocker.spec.js.map