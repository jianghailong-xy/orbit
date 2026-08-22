"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const node_fs_1 = require("node:fs");
const node_path_1 = __importDefault(require("node:path"));
const node_test_1 = require("node:test");
const REPO = node_path_1.default.resolve(__dirname, '../../../..');
const SOURCE = (0, node_fs_1.readFileSync)(node_path_1.default.join(REPO, 'src/apiserver/src/projects/project-decision.service.ts'), 'utf8');
const EVENTS = (0, node_fs_1.readFileSync)(node_path_1.default.join(REPO, 'src/apiserver/src/projects/project-events.service.ts'), 'utf8');
const RECONCILE = (0, node_fs_1.readFileSync)(node_path_1.default.join(REPO, 'src/apiserver/src/projects/project-reconcile.service.ts'), 'utf8');
const MIGRATION = (0, node_fs_1.readFileSync)(node_path_1.default.join(REPO, 'src/apiserver/prisma/migrations/0120_project_decision_audit/migration.sql'), 'utf8');
(0, node_test_1.test)('decision capture is pinned to a repeatable-read boundary and every tenant-bearing source is scoped', () => {
    strict_1.default.match(EVENTS, /isolationLevel:\s*Prisma\.TransactionIsolationLevel\.RepeatableRead/);
    strict_1.default.match(SOURCE, /Project decision snapshots require REPEATABLE READ or SERIALIZABLE/);
    for (const table of ['task', 'session', 'workspace', 'runner']) {
        const tableReads = SOURCE.match(new RegExp(`FROM \\"${table}\\"[\\s\\S]{0,1800}`, 'g')) ?? [];
        strict_1.default.ok(tableReads.length > 0, `snapshot no longer reads ${table}`);
        strict_1.default.ok(tableReads.every((read) => /owner_id/.test(read)), `${table} read lost its owner boundary`);
    }
    strict_1.default.match(SOURCE, /mp\."owner_id" IS NULL OR mp\."owner_id" = \$\{project\.ownerId\}::uuid/);
    strict_1.default.match(SOURCE, /target\."project_id" = p\."id"/);
    strict_1.default.match(SOURCE, /target\."owner_id" = p\."owner_id"/);
});
(0, node_test_1.test)('the audit schema binds every attributed action to a decision in the same Project', () => {
    strict_1.default.match(MIGRATION, /CREATE TABLE "project_decision"/);
    strict_1.default.match(MIGRATION, /"decision_input_hash" ~ '\^\[0-9a-f\]\{64\}\$'/);
    strict_1.default.match(MIGRATION, /"decision_input"->>'decisionInputHash' = "decision_input_hash"/);
    strict_1.default.match(MIGRATION, /FOREIGN KEY \("decision_id", "project_id"\)/);
    strict_1.default.match(MIGRATION, /REFERENCES "project_decision"\("id", "project_id"\)/);
    strict_1.default.match(MIGRATION, /"decided_by" IN \('ORCHESTRATOR', 'COORDINATOR_AGENT'\)/);
    strict_1.default.match(MIGRATION, /PROJECT_DECISION_IMMUTABLE/);
    strict_1.default.match(MIGRATION, /ACTION_DECISION_LINK_FROZEN/);
    strict_1.default.match(SOURCE, /coordinatorAgentId/);
    strict_1.default.match(SOURCE, /coordinatorSessionId/);
});
(0, node_test_1.test)('stale actions fail closed and create their refusal, wake and outbox signal atomically', () => {
    strict_1.default.match(RECONCILE, /applyDecisionAction/);
    strict_1.default.match(RECONCILE, /refusalCode:\s*'STALE_SNAPSHOT'/);
    strict_1.default.match(RECONCILE, /kind:\s*'coordinator\.snapshot_stale'/);
    strict_1.default.match(RECONCILE, /stale Coordinator decision requires reconcile/);
    strict_1.default.match(RECONCILE, /"decision_id" = \$\{decisionId\}::uuid/);
    strict_1.default.match(RECONCILE, /isolationLevel:\s*Prisma\.TransactionIsolationLevel\.RepeatableRead/);
});
(0, node_test_1.test)('snapshot JSON deliberately publicizes ids and hashes opaque ledger/test content', () => {
    strict_1.default.match(SOURCE, /uuidToBase62/);
    strict_1.default.match(SOURCE, /idempotencyKeyHash:\s*sha256/);
    strict_1.default.match(SOURCE, /resultHash:/);
    strict_1.default.doesNotMatch(SOURCE, /api_key_enc|token_hash|system_prompt|append_system_prompt/);
});
//# sourceMappingURL=project-decision-contract.spec.js.map