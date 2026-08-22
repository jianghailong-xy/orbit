"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProjectDecisionService = exports.PROJECT_DECISION_INPUT_VERSION = void 0;
exports.createDecisionId = createDecisionId;
exports.planProjectDecision = planProjectDecision;
exports.verificationVerdictPlan = verificationVerdictPlan;
exports.completionGapPlan = completionGapPlan;
exports.hashDecisionInput = hashDecisionInput;
exports.canonicalJson = canonicalJson;
exports.aggregationFacts = aggregationFacts;
exports.verificationVerdictFacts = verificationVerdictFacts;
exports.publicIdempotencyKey = publicIdempotencyKey;
const node_crypto_1 = require("node:crypto");
const common_1 = require("@nestjs/common");
const client_1 = require("@prisma/client");
const shared_1 = require("@orbit/shared");
const prisma_service_1 = require("../prisma/prisma.service");
const task_supersession_1 = require("../tasks/task-supersession");
const project_authorization_service_1 = require("./project-authorization.service");
const task_retry_policy_1 = require("../tasks/task-retry-policy");
const task_aggregation_1 = require("./task-aggregation");
const task_verification_verdict_1 = require("./task-verification-verdict");
const project_blocker_1 = require("./project-blocker");
const project_blocker_conditions_1 = require("./project-blocker-conditions");
const project_coordinator_session_1 = require("./project-coordinator-session");
const project_turn_reason_1 = require("./project-turn-reason");
const project_next_wake_1 = require("./project-next-wake");
exports.PROJECT_DECISION_INPUT_VERSION = 1;
/**
 * Captures and persists the Coordinator protocol boundary. All UUIDs inside the JSON snapshot are
 * rendered as Base62 before hashing; UUID columns remain internal so database constraints and
 * action keys keep their stable identities.
 */
let ProjectDecisionService = class ProjectDecisionService {
    prisma;
    constructor(prisma) {
        this.prisma = prisma;
    }
    async capture(tx, projectId, readAt = new Date()) {
        const isolation = await tx.$queryRaw(client_1.Prisma.sql `
      SELECT current_setting('transaction_isolation') AS "isolation"
    `);
        if (!['repeatable read', 'serializable'].includes(isolation[0]?.isolation)) {
            throw new Error('Project decision snapshots require REPEATABLE READ or SERIALIZABLE');
        }
        const projects = await tx.$queryRaw(client_1.Prisma.sql `
      SELECT p."id", p."owner_id" AS "ownerId", p."title", p."goal",
             p."acceptance_criteria" AS "acceptanceCriteria", p."status",
             p."coordinator_enabled" AS "coordinatorEnabled",
             p."automation_policy"::text AS "automationPolicy",
             p."max_concurrent_tasks" AS "maxConcurrentTasks",
             p."session_budget_per_day" AS "sessionBudgetPerDay",
             p."config_revision" AS "configRevision",
             p."coordinator_session_id" AS "coordinatorSessionId",
             p."coordinator_workspace_id" AS "coordinatorWorkspaceId",
             coordinator."agent_id" AS "coordinatorAgentId",
             r."run_state"::text AS "runState", r."fencing_token" AS "fencingToken",
             r."coordinator_generation" AS "coordinatorGeneration",
             r."coordinator_session_id" AS "runtimeCoordinatorSessionId",
             r."next_wake_at" AS "nextWakeAt",
             r."acceptance_attempt" AS "acceptanceAttempt"
        FROM "project" p
        JOIN "project_runtime" r ON r."project_id" = p."id"
        LEFT JOIN LATERAL (
          SELECT pm."agent_id"
            FROM "project_member" pm
            JOIN "workspace" w ON w."id" = pm."agent_id" AND w."owner_id" = p."owner_id"
           WHERE pm."project_id" = p."id" AND pm."role" = 'COORDINATOR'
           ORDER BY pm."id" LIMIT 1
        ) coordinator ON true
       WHERE p."id" = ${projectId}::uuid
    `);
        const project = projects[0];
        if (!project)
            throw new Error(`Project decision snapshot cannot find Project ${projectId}`);
        // A transaction owns one PostgreSQL connection. Keep these reads sequential: REPEATABLE READ
        // gives them one MVCC snapshot, while concurrent client.query calls on that connection are an
        // unsupported pg scheduling accident rather than useful parallelism.
        const teamRows = await tx.$queryRaw(client_1.Prisma.sql `
        SELECT pm."id" AS "projectMemberId", pm."agent_id" AS "agentId", pm."role"::text,
               w."enabled", w."deleted_at" AS "deletedAt", w."runner_id" AS "runnerId",
               w."model", w."effort", w."provider_fallbacks" AS "providerFallbacks",
               w."can_create_tasks" AS "canCreateTasks", w."can_delegate" AS "canDelegate",
               w."max_concurrent_tasks" AS "maxConcurrentTasks"
          FROM "project_member" pm
          JOIN "project" p ON p."id" = pm."project_id"
          JOIN "workspace" w ON w."id" = pm."agent_id" AND w."owner_id" = p."owner_id"
         WHERE pm."project_id" = ${projectId}::uuid AND p."owner_id" = ${project.ownerId}::uuid
         ORDER BY pm."id"
      `);
        const taskRows = await tx.$queryRaw(client_1.Prisma.sql `
        SELECT t."id", t."title", t."description",
               t."acceptance_criteria" AS "acceptanceCriteria", t."labels", t."status"::text,
               t."parent_task_id" AS "parentTaskId", t."assignee_id" AS "assigneeAgentId",
               t."provider", t."model", t."auto_run_when_ready" AS "autoRunWhenReady",
               t."dispatch_hold" AS "dispatchHold",
               t."dispatch_authority"::text AS "dispatchAuthority",
               t."dispatch_attempt" AS "dispatchAttempt",
               t."required_capabilities" AS "requiredCapabilities", t."run_at" AS "runAt",
               t."verifies_task_id" AS "verifiesTaskId",
               t."completion_policy"::text AS "completionPolicy", t."verdict"::text AS "verdict",
               t."verdict_revision" AS "verdictRevision",
               t."superseded_by_task_id" AS "supersededByTaskId",
               t."superseded_at" AS "supersededAt",
               t."terminal_reason" AS "terminalReason",
               -- §13.3 DEP4. Correlated rather than joined so a task with no conclusion costs
               -- nothing, and keyed on the ledger's own unique identity (§8.2) rather than on
               -- "some verdict action for this task": a superseded revision is not this one.
               EXISTS (
                 SELECT 1 FROM "project_action" va
                  WHERE va."project_id" = t."project_id"
                    AND va."type"::text = 'APPLY_VERIFICATION_VERDICT'
                    AND va."status"::text = 'APPLIED'
                    AND va."subject_id" = t."id"
                    AND va."idempotency_key" = 'pc:v1:' || t."project_id"::text || ':verdict:'
                        || t."id"::text || ':' || t."verdict_revision"::text
               ) AS "verdictApplied",
               t."updated_at" AS "updatedAt"
          FROM "task" t JOIN "project" p ON p."id" = t."project_id"
         WHERE t."project_id" = ${projectId}::uuid
           AND t."owner_id" = p."owner_id" AND p."owner_id" = ${project.ownerId}::uuid
         ORDER BY t."id"
      `);
        const dependencyRows = await tx.$queryRaw(client_1.Prisma.sql `
        SELECT d."task_id" AS "taskId", d."depends_on_task_id" AS "dependsOnTaskId"
          FROM "task_dependency" d
          JOIN "task" source ON source."id" = d."task_id"
          JOIN "task" target ON target."id" = d."depends_on_task_id"
          JOIN "project" p ON p."id" = source."project_id"
         WHERE source."project_id" = ${projectId}::uuid
           AND target."project_id" = p."id"
           AND source."owner_id" = p."owner_id" AND target."owner_id" = p."owner_id"
           AND p."owner_id" = ${project.ownerId}::uuid
         ORDER BY d."task_id", d."depends_on_task_id"
      `);
        const sessionRows = await tx.$queryRaw(client_1.Prisma.sql `
        SELECT s."id", s."task_id" AS "taskId", s."workspace_id" AS "workspaceId",
               s."assigned_runner_id" AS "assignedRunnerId", s."status"::text,
               s."provider", s."model", s."permission_mode" AS "permissionMode", s."effort",
               s."created_at" AS "createdAt",
               s."started_at" AS "startedAt", s."finished_at" AS "finishedAt",
               s."completed_at" AS "completedAt", s."archived_at" AS "archivedAt",
               s."end_reason" AS "endReason", s."deleted_at" AS "deletedAt",
               s."result", s."error", s."branch", s."base_sha" AS "baseSha",
               s."changed_files" AS "changedFiles", s."merge_status" AS "mergeStatus",
               s."merged_source_sha" AS "mergedSourceSha", s."merge_target" AS "mergeTarget",
               s."branch_merged" AS "branchMerged", s."worktree_branch" AS "worktreeBranch",
               s."worktree_dirty" AS "worktreeDirty", s."commit_status" AS "commitStatus"
          FROM "session" s
          JOIN "project" p ON p."id" = ${projectId}::uuid
          LEFT JOIN "task" t ON t."id" = s."task_id"
         WHERE s."owner_id" = p."owner_id" AND p."owner_id" = ${project.ownerId}::uuid
           AND ((t."project_id" = p."id" AND t."owner_id" = p."owner_id")
                OR s."id" = p."coordinator_session_id")
         ORDER BY s."id"
      `);
        const workspaceRows = await tx.$queryRaw(client_1.Prisma.sql `
        SELECT w."id" AS "workspaceId", w."runner_id" AS "runnerId", w."enabled",
               w."deleted_at" AS "deletedAt", w."model", w."effort",
               w."default_merge_target" AS "defaultMergeTarget",
               w."work_dir_exists" AS "workDirExists", w."work_dir_is_git" AS "workDirIsGit",
               w."work_dir_probed_at" AS "workDirProbedAt"
          FROM "workspace" w JOIN "project" p ON p."id" = ${projectId}::uuid
         WHERE w."owner_id" = p."owner_id" AND p."owner_id" = ${project.ownerId}::uuid
           AND (
             w."id" = p."coordinator_workspace_id"
             OR EXISTS (SELECT 1 FROM "project_member" pm
                         WHERE pm."project_id" = p."id" AND pm."agent_id" = w."id")
             OR EXISTS (SELECT 1 FROM "task" t
                         WHERE t."project_id" = p."id" AND t."owner_id" = p."owner_id"
                           AND t."assignee_id" = w."id")
             OR EXISTS (SELECT 1 FROM "session" s JOIN "task" t ON t."id" = s."task_id"
                         WHERE t."project_id" = p."id" AND t."owner_id" = p."owner_id"
                           AND s."owner_id" = p."owner_id" AND s."workspace_id" = w."id")
             OR EXISTS (SELECT 1 FROM "session" s
                         WHERE s."id" = p."coordinator_session_id"
                           AND s."owner_id" = p."owner_id" AND s."workspace_id" = w."id")
           )
         ORDER BY w."id"
      `);
        const runnerRows = await tx.$queryRaw(client_1.Prisma.sql `
        SELECT r."id" AS "runnerId", r."status"::text, r."labels", r."version",
               r."last_heartbeat_at" AS "lastHeartbeatAt", r."model_catalog" AS "modelCatalog",
               r."capabilities", r."capabilities_reported_at" AS "capabilitiesReportedAt",
               r."engines", r."runs_as_root" AS "runsAsRoot"
          FROM "runner" r JOIN "project" p ON p."id" = ${projectId}::uuid
         WHERE r."owner_id" = p."owner_id" AND p."owner_id" = ${project.ownerId}::uuid
           AND (
             EXISTS (SELECT 1 FROM "workspace" w
                      WHERE w."owner_id" = p."owner_id" AND w."runner_id" = r."id"
                        AND (w."id" = p."coordinator_workspace_id"
                          OR EXISTS (SELECT 1 FROM "project_member" pm
                                     WHERE pm."project_id" = p."id" AND pm."agent_id" = w."id")
                          OR EXISTS (SELECT 1 FROM "task" t
                                     WHERE t."project_id" = p."id" AND t."owner_id" = p."owner_id"
                                       AND t."assignee_id" = w."id")))
             OR EXISTS (SELECT 1 FROM "session" s JOIN "task" t ON t."id" = s."task_id"
                        WHERE t."project_id" = p."id" AND t."owner_id" = p."owner_id"
                          AND s."owner_id" = p."owner_id" AND s."assigned_runner_id" = r."id")
             OR EXISTS (SELECT 1 FROM "session" s
                        WHERE s."id" = p."coordinator_session_id"
                          AND s."owner_id" = p."owner_id" AND s."assigned_runner_id" = r."id")
           )
         ORDER BY r."id"
      `);
        // §13.2 V8's third source, beside the two references: a slug some team member has explicitly
        // configured as a fallback. Sorted and de-duplicated so the same team always produces the same
        // snapshot. The OWNER clause below is untouched — this widens which slugs get answered, never
        // whose providers are visible.
        const fallbackProviderSlugs = [...new Set(teamRows.flatMap((row) => parseProviderFallbacks(row.providerFallbacks).map((fallback) => fallback.provider)))].sort();
        const providerRows = await tx.$queryRaw(client_1.Prisma.sql `
        SELECT mp."id" AS "providerId", mp."slug", mp."runtime", mp."enabled", mp."models",
               mp."default_model" AS "defaultModel", mp."owner_id" AS "ownerId"
          FROM "model_provider" mp
         WHERE (mp."owner_id" IS NULL OR mp."owner_id" = ${project.ownerId}::uuid)
           AND (
             mp."slug" = ANY(${fallbackProviderSlugs}::text[])
             OR EXISTS (SELECT 1 FROM "task" t
                      WHERE t."project_id" = ${projectId}::uuid
                        AND t."owner_id" = ${project.ownerId}::uuid AND t."provider" = mp."slug")
             OR EXISTS (SELECT 1 FROM "session" s JOIN "task" t ON t."id" = s."task_id"
                        WHERE t."project_id" = ${projectId}::uuid
                          AND t."owner_id" = ${project.ownerId}::uuid
                          AND s."owner_id" = ${project.ownerId}::uuid AND s."provider" = mp."slug")
           )
         ORDER BY mp."slug", mp."id"
      `);
        const actionRows = await tx.$queryRaw(client_1.Prisma.sql `
        SELECT a."id" AS "actionId", a."idempotency_key" AS "idempotencyKey", a."type"::text,
               a."status"::text, a."subject_type" AS "subjectType", a."subject_id" AS "subjectId",
               a."decision_id" AS "decisionId", a."result_session_id" AS "resultSessionId",
               a."refusal_code" AS "refusalCode", a."reason_code" AS "reasonCode",
               a."detail", a."created_at" AS "createdAt"
          FROM "project_action" a JOIN "project" p ON p."id" = a."project_id"
         WHERE a."project_id" = ${projectId}::uuid AND p."owner_id" = ${project.ownerId}::uuid
         ORDER BY a."created_at", a."id"
      `);
        // §11: the OPEN set only. Resolved rows stay on disk forever (BE1 needs their generations) but
        // they are history, not facts about now.
        const blockerRows = await tx.$queryRaw(client_1.Prisma.sql `
        SELECT b."id", b."kind", b."owner"::text, b."recovery"::text, b."severity"::text,
               b."required_action" AS "requiredAction", b."next_check_at" AS "nextCheckAt",
               b."subject_type" AS "subjectType", b."subject_id" AS "subjectId",
               b."dedupe_key" AS "dedupeKey",
               b."lifecycle_generation" AS "lifecycleGeneration",
               b."condition_version" AS "conditionVersion",
               b."first_seen_at" AS "firstSeenAt", b."last_seen_at" AS "lastSeenAt",
               b."occurrences", b."escalated_at" AS "escalatedAt"
          FROM "project_blocker" b JOIN "project" p ON p."id" = b."project_id"
         WHERE b."project_id" = ${projectId}::uuid AND p."owner_id" = ${project.ownerId}::uuid
           AND b."resolved_at" IS NULL
         ORDER BY b."dedupe_key", b."id"
      `);
        const signalRows = await tx.$queryRaw(client_1.Prisma.sql `
        SELECT e."id", e."kind", e."dedupe_key" AS "dedupeKey"
          FROM "project_event" e JOIN "project" p ON p."id" = e."project_id"
         WHERE e."project_id" = ${projectId}::uuid AND p."owner_id" = ${project.ownerId}::uuid
           AND e."consumed_at" IS NULL AND e."kind" = 'user.manual_trigger'
         ORDER BY e."dedupe_key", e."id"
      `);
        // §5.4 F22, as the one fact §11.4 can recompute a dead letter from: DEAD rows this project
        // has not acknowledged. The acknowledgement instant is the last time somebody resolved the
        // `UNKNOWN_FAILURE` row these open — by hand, which `resolved_by <> 'AUTO'` is the database's
        // way of saying. Without that exclusion the loop's own auto-clear would be an acknowledgement
        // and the row would close itself the first time delivery started working again.
        const deadLetterRows = await tx.$queryRaw(client_1.Prisma.sql `
        WITH "ack" AS (
          SELECT MAX(b."resolved_at") AS "at"
            FROM "project_blocker" b
           WHERE b."project_id" = ${projectId}::uuid
             AND b."dedupe_key" = ${deadLetterDedupeKey(projectId)}
             AND b."resolved_at" IS NOT NULL
             AND b."resolved_by" <> 'AUTO'::"project_blocker_resolved_by"
        )
        SELECT e."id", e."kind", e."dedupe_key" AS "dedupeKey", e."attempts"
          FROM "project_event" e JOIN "project" p ON p."id" = e."project_id"
         CROSS JOIN "ack"
         WHERE e."project_id" = ${projectId}::uuid AND p."owner_id" = ${project.ownerId}::uuid
           AND e."disposition" = 'DEAD'
           AND ("ack"."at" IS NULL OR e."consumed_at" > "ack"."at")
         ORDER BY e."id"
      `);
        const dependencies = new Map();
        for (const row of dependencyRows) {
            const list = dependencies.get(row.taskId) ?? [];
            list.push(toPublicId(row.dependsOnTaskId));
            dependencies.set(row.taskId, list);
        }
        const liveSessions = new Map();
        for (const row of sessionRows) {
            if (!row.taskId || row.deletedAt || !isLiveSession(row.status))
                continue;
            const list = liveSessions.get(row.taskId) ?? [];
            list.push(toPublicId(row.id));
            liveSessions.set(row.taskId, list);
        }
        const failedSessions = new Map();
        for (const row of sessionRows) {
            if (!row.taskId || row.status !== 'FAILED' || isUsageLimitFailure(row.error))
                continue;
            const list = failedSessions.get(row.taskId) ?? [];
            list.push(row);
            failedSessions.set(row.taskId, list);
        }
        const tasks = taskRows.map((row) => {
            const failures = [...(failedSessions.get(row.id) ?? [])].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
            const lastFailure = failures.at(-1) ?? null;
            const backoffUntil = (0, task_retry_policy_1.retryBackoffUntil)(failures.length, lastFailure?.createdAt ?? null);
            return {
                id: toPublicId(row.id),
                title: row.title,
                contentHash: sha256({
                    title: row.title,
                    description: row.description,
                    acceptanceCriteria: row.acceptanceCriteria,
                    labels: [...row.labels].sort(),
                }),
                status: row.status,
                parentTaskId: toPublicIdOrNull(row.parentTaskId),
                assigneeAgentId: toPublicIdOrNull(row.assigneeAgentId),
                provider: row.provider,
                model: row.model,
                autoRunWhenReady: row.autoRunWhenReady,
                dispatchHold: row.dispatchHold,
                dispatchAuthority: row.dispatchAuthority,
                dispatchAttempt: String(row.dispatchAttempt),
                requiredCapabilities: [...row.requiredCapabilities].sort(),
                runAt: iso(row.runAt),
                verifiesTaskId: toPublicIdOrNull(row.verifiesTaskId),
                completionPolicy: row.completionPolicy,
                verdict: row.verdict,
                verdictRevision: String(row.verdictRevision),
                supersededByTaskId: toPublicIdOrNull(row.supersededByTaskId),
                supersededAt: iso(row.supersededAt),
                terminalReason: row.terminalReason,
                verdictApplied: row.verdictApplied,
                dependsOnTaskIds: dependencies.get(row.id) ?? [],
                liveSessionIds: liveSessions.get(row.id) ?? [],
                failureCount: failures.length,
                lastFailureAt: iso(lastFailure?.createdAt ?? null),
                failureAttributable: failures.every((failure) => Boolean(failure.error?.trim())),
                retryBackoffUntil: iso(backoffUntil),
                updatedAt: isoRequired(row.updatedAt),
            };
        });
        const sessions = sessionRows.map((row) => ({
            id: toPublicId(row.id),
            taskId: toPublicIdOrNull(row.taskId),
            workspaceId: toPublicIdOrNull(row.workspaceId),
            assignedRunnerId: toPublicIdOrNull(row.assignedRunnerId),
            runStatus: row.status,
            provider: row.provider,
            model: row.model,
            permissionMode: row.permissionMode,
            effort: row.effort,
            createdAt: isoRequired(row.createdAt),
            startedAt: iso(row.startedAt),
            finishedAt: iso(row.finishedAt),
            completedAt: iso(row.completedAt),
            // §13.3 DEP1's two halves. `archivedAt` completes §4.2's COMPLETED lifecycle (the derivation
            // is `completedAt ?? archivedAt`) and `endReason` is what tells a run the worker finished
            // apart from one a person filed or stopped — a distinction the whole DEP rule rests on.
            archivedAt: iso(row.archivedAt),
            endReason: row.endReason,
            deletedAt: iso(row.deletedAt),
        }));
        const coordinator = project.coordinatorSessionId
            ? sessionRows.find((row) => row.id === project.coordinatorSessionId)
            : undefined;
        const coordinatorSession = coordinator
            ? {
                id: toPublicId(coordinator.id),
                runStatus: coordinator.status,
                workspaceId: toPublicIdOrNull(coordinator.workspaceId),
                assignedRunnerId: toPublicIdOrNull(coordinator.assignedRunnerId),
                startedAt: iso(coordinator.startedAt),
                finishedAt: iso(coordinator.finishedAt),
                completedAt: iso(coordinator.completedAt),
                deletedAt: iso(coordinator.deletedAt),
            }
            : null;
        const taskById = new Map(taskRows.map((row) => [row.id, row]));
        const latestVerificationSession = new Map();
        for (const row of sessionRows) {
            if (!row.taskId || !taskById.get(row.taskId)?.verifiesTaskId)
                continue;
            const previous = latestVerificationSession.get(row.taskId);
            if (!previous || row.createdAt > previous.createdAt
                || (row.createdAt.getTime() === previous.createdAt.getTime() && row.id > previous.id)) {
                latestVerificationSession.set(row.taskId, row);
            }
        }
        const customProviderSlugs = new Set(providerRows.map((row) => row.slug));
        // Every slug this decision could have to answer about, and the third source is the one AG7/V8
        // needs: §13.2 V8 picks the engine for a filed check from the VERIFIER's own configured
        // fallbacks, so the first check a project ever files usually names a provider no task or
        // session in it has used yet. Projected only from what tasks and sessions REFERENCE, that
        // provider is simply absent from the snapshot, and "absent" is read fail-closed as
        // `NO_RUNNABLE_VERIFIER_COMBINATION` — a project whose team is configured correctly would be
        // told, for ever, that it has no verifier.
        //
        // Widening the projection is not widening the SCOPE: a configured provider still has to be one
        // `providerRows` returned (this owner's or shared), and a built-in still has to be a real
        // runtime that an ONLINE runner reports models for. What changes is only which slugs get
        // ANSWERED, and answering one nobody uses costs one row.
        const referencedProviderSlugs = new Set([
            ...taskRows.map((row) => row.provider),
            ...sessionRows.map((row) => row.provider),
            ...teamRows.flatMap((row) => parseProviderFallbacks(row.providerFallbacks).map((fallback) => fallback.provider)),
        ].filter((slug) => Boolean(slug)));
        const builtinProviders = [...referencedProviderSlugs]
            .filter((slug) => Object.values(shared_1.AgentProvider).includes(slug)
            && !customProviderSlugs.has(slug))
            .map((slug) => {
            const catalogs = runnerRows.flatMap((runner) => providerModels(runner.modelCatalog, slug));
            return {
                providerId: null,
                slug,
                runtime: slug,
                enabled: runnerRows.some((runner) => runner.status === 'ONLINE' && providerModels(runner.modelCatalog, slug).length > 0),
                models: catalogs,
                defaultModel: null,
                scope: 'BUILTIN',
            };
        });
        const world = {
            project: {
                id: toPublicId(project.id),
                ownerId: toPublicId(project.ownerId),
                title: project.title,
                goal: project.goal,
                acceptanceCriteria: project.acceptanceCriteria,
                status: project.status,
                coordinatorEnabled: project.coordinatorEnabled,
                automationPolicy: project.automationPolicy,
                maxConcurrentTasks: project.maxConcurrentTasks,
                sessionBudgetPerDay: project.sessionBudgetPerDay,
                configRevision: String(project.configRevision),
                coordinatorAgentId: toPublicIdOrNull(project.coordinatorAgentId),
                coordinatorSessionId: toPublicIdOrNull(project.coordinatorSessionId),
                coordinatorWorkspaceId: toPublicIdOrNull(project.coordinatorWorkspaceId),
            },
            runtime: {
                runState: project.runState,
                fencingToken: String(project.fencingToken),
                coordinatorGeneration: String(project.coordinatorGeneration),
                coordinatorSessionId: toPublicIdOrNull(project.runtimeCoordinatorSessionId),
                nextWakeAt: iso(project.nextWakeAt),
                acceptanceAttempt: String(project.acceptanceAttempt),
            },
            team: teamRows.map((row) => ({
                projectMemberId: toPublicId(row.projectMemberId),
                agentId: toPublicId(row.agentId),
                role: row.role,
                enabled: row.enabled,
                deletedAt: iso(row.deletedAt),
                runnerId: toPublicIdOrNull(row.runnerId),
                model: row.model,
                effort: row.effort,
                providerFallbacks: parseProviderFallbacks(row.providerFallbacks),
                canCreateTasks: row.canCreateTasks,
                canDelegate: row.canDelegate,
                maxConcurrentTasks: row.maxConcurrentTasks,
            })),
            tasks,
            sessions,
            coordinatorSession,
            workspaces: workspaceRows.map((row) => ({
                workspaceId: toPublicId(row.workspaceId),
                runnerId: toPublicIdOrNull(row.runnerId),
                enabled: row.enabled,
                deletedAt: iso(row.deletedAt),
                model: row.model,
                effort: row.effort,
                defaultMergeTarget: row.defaultMergeTarget,
                workDirExists: row.workDirExists,
                workDirIsGit: row.workDirIsGit,
                workDirProbedAt: iso(row.workDirProbedAt),
            })),
            runners: runnerRows.map((row) => ({
                runnerId: toPublicId(row.runnerId),
                status: row.status,
                labels: [...row.labels].sort(),
                version: row.version,
                lastHeartbeatAt: iso(row.lastHeartbeatAt),
                modelCatalog: jsonValue(row.modelCatalog),
                capabilities: [...row.capabilities].sort(),
                capabilitiesReportedAt: iso(row.capabilitiesReportedAt),
                engines: jsonValue(row.engines),
                runsAsRoot: row.runsAsRoot,
            })),
            providers: [...providerRows.map((row) => ({
                    providerId: toPublicId(row.providerId),
                    slug: row.slug,
                    runtime: row.runtime,
                    enabled: row.enabled,
                    models: jsonValue(row.models),
                    defaultModel: row.defaultModel,
                    scope: row.ownerId ? 'PROJECT_OWNER' : 'SHARED',
                })), ...builtinProviders].sort((a, b) => a.slug.localeCompare(b.slug) || (a.providerId ?? '').localeCompare(b.providerId ?? '')),
            actions: actionRows.map((row) => ({
                actionId: toPublicId(row.actionId),
                type: row.type,
                status: row.status,
                subjectType: row.subjectType,
                subjectId: toPublicIdOrNull(row.subjectId),
                decisionId: toPublicIdOrNull(row.decisionId),
                resultSessionId: toPublicIdOrNull(row.resultSessionId),
                refusalCode: row.refusalCode,
                reasonCode: row.reasonCode,
                idempotencyKeyHash: sha256(row.idempotencyKey),
                detailHash: sha256(jsonValue(row.detail)),
                createdAt: isoRequired(row.createdAt),
            })),
            // §13.1 AG7's capability marker, stamped by the binary that captured this world. Constant by
            // construction — it says what THIS build computes, not what the project contains.
            protocol: { completionGaps: true, verificationEpoch: true },
            blockers: blockerRows.map((row) => ({
                id: toPublicId(row.id),
                kind: row.kind,
                owner: row.owner,
                recovery: row.recovery,
                severity: row.severity,
                requiredAction: row.requiredAction,
                subjectType: row.subjectType,
                // Row subjects are stored as UUID text and rendered Base62 here like every other id in
                // this snapshot; a natural key (a builtin provider's slug) is not a UUID and passes
                // through unchanged.
                subjectId: publicSubjectId(row.subjectId),
                dedupeKey: publicDedupeKey(row.dedupeKey),
                lifecycleGeneration: String(row.lifecycleGeneration),
                conditionVersion: row.conditionVersion,
                firstSeenAt: isoRequired(row.firstSeenAt),
                lastSeenAt: isoRequired(row.lastSeenAt),
                occurrences: row.occurrences,
                nextCheckAt: isoRequired(row.nextCheckAt),
                escalatedAt: iso(row.escalatedAt),
            })),
            // Omitted rather than sent empty, so the overwhelmingly common snapshot — a project that has
            // never lost a signal — hashes exactly as it did before this projection existed.
            deadLetters: deadLetterRows.length === 0 ? undefined : deadLetterRows.map((row) => ({
                eventId: toPublicId(row.id),
                kind: row.kind,
                // An event's dedupe key is `<kind>:<rowId>` (§5.3 N3), so it carries a raw uuid — and this
                // one is read by a person, through the blocker `detail` §11 puts in front of them. Same
                // transform a permanent action key gets on the way out: spell every uuid, change nothing
                // else.
                dedupeKey: publicIdempotencyKey(row.dedupeKey),
                attempts: row.attempts,
            })),
            evidence: {
                branches: sessionRows.filter((row) => Boolean(row.branch))
                    .map((row) => ({
                    sessionId: toPublicId(row.id),
                    taskId: toPublicIdOrNull(row.taskId),
                    branch: row.branch,
                    baseSha: row.baseSha,
                    worktreeBranch: row.worktreeBranch,
                    worktreeDirty: row.worktreeDirty,
                    commitStatus: row.commitStatus,
                    mergeStatus: row.mergeStatus,
                    mergeTarget: row.mergeTarget,
                    mergedSourceSha: row.mergedSourceSha,
                    branchMerged: row.branchMerged,
                    changedFiles: jsonValue(row.changedFiles),
                })),
                tests: taskRows.filter((row) => Boolean(row.verifiesTaskId))
                    .map((row) => {
                    const evidence = latestVerificationSession.get(row.id);
                    return {
                        verificationTaskId: toPublicId(row.id),
                        verifiesTaskId: toPublicId(row.verifiesTaskId),
                        taskStatus: row.status,
                        // The conclusion belongs beside the run that produced it: §13.2 reads both, and a
                        // snapshot that carried only the run would leave "what did it decide" to a join.
                        verdict: row.verdict,
                        verdictRevision: String(row.verdictRevision),
                        sessionId: evidence ? toPublicId(evidence.id) : null,
                        runStatus: evidence?.status ?? null,
                        finishedAt: iso(evidence?.finishedAt ?? null),
                        resultHash: evidence?.result == null ? null : sha256(evidence.result),
                        errorHash: evidence?.error == null ? null : sha256(evidence.error),
                    };
                }),
            },
        };
        const epoch = Math.floor(readAt.getTime() / 1_000);
        const evaluation = {
            epoch,
            dueTasks: Object.fromEntries(tasks.map((task) => [
                task.id,
                {
                    runAtDue: task.runAt == null || Date.parse(task.runAt) <= epoch * 1_000,
                    retryBackoffExpired: task.retryBackoffUntil == null
                        || Date.parse(task.retryBackoffUntil) <= epoch * 1_000,
                },
            ])),
            turnWindows: turnWindowsOf(actionRows, epoch),
        };
        const signals = signalRows.map((row) => ({
            eventId: toPublicId(row.id),
            kind: row.kind,
            dedupeKey: row.dedupeKey,
        }));
        const decisionInputHash = hashDecisionInput({ world, evaluation, signals });
        const input = {
            v: exports.PROJECT_DECISION_INPUT_VERSION,
            readAt: readAt.toISOString(),
            decisionInputHash,
            world,
            evaluation,
            signals,
        };
        return {
            input,
            attribution: {
                ownerId: project.ownerId,
                coordinatorAgentId: project.coordinatorAgentId,
                coordinatorSessionId: project.coordinatorSessionId,
            },
        };
    }
    async persist(tx, captured, outcome, decisionId) {
        assertDecisionReplay(captured.input, outcome);
        if (outcome.reconcileId !== toPublicId(decisionId)) {
            throw new Error('Project decision outcome reconcileId does not match its durable row');
        }
        const inserted = await tx.$queryRaw(client_1.Prisma.sql `
      INSERT INTO "project_decision" (
        "id", "project_id", "input_version", "decision_input_hash", "decision_input",
        "outcome", "decided_by", "coordinator_agent_id", "coordinator_session_id",
        "fencing_token", "reason", "created_at"
      ) VALUES (
        ${decisionId}::uuid, ${toInternalProjectId(captured.input)}::uuid,
        ${captured.input.v}, ${captured.input.decisionInputHash},
        ${JSON.stringify(captured.input)}::jsonb, ${JSON.stringify(outcome)}::jsonb,
        ${outcome.decidedBy}, ${captured.attribution.coordinatorAgentId}::uuid,
        ${captured.attribution.coordinatorSessionId}::uuid,
        ${BigInt(outcome.fencingToken)}, ${outcome.reason}, ${new Date(captured.input.readAt)}
      )
      RETURNING "id"
    `);
        if (inserted[0]?.id !== decisionId)
            throw new Error('failed to persist Project decision');
        return { id: decisionId, input: captured.input, outcome };
    }
    async getInternal(tx, projectId, decisionId) {
        const rows = await tx.$queryRaw(client_1.Prisma.sql `
      SELECT d."id", d."project_id" AS "projectId", p."owner_id" AS "ownerId",
             d."decision_input_hash" AS "decisionInputHash", d."decision_input" AS "decisionInput",
             d."outcome", d."decided_by" AS "decidedBy",
             d."coordinator_agent_id" AS "coordinatorAgentId",
             d."coordinator_session_id" AS "coordinatorSessionId",
             d."fencing_token" AS "fencingToken", d."reason", d."created_at" AS "createdAt"
        FROM "project_decision" d JOIN "project" p ON p."id" = d."project_id"
       WHERE d."id" = ${decisionId}::uuid AND d."project_id" = ${projectId}::uuid
    `);
        return rows[0] ?? null;
    }
    async replay(ownerId, decisionId) {
        const rows = await this.prisma.$queryRaw(client_1.Prisma.sql `
      SELECT d."id", d."project_id" AS "projectId", p."owner_id" AS "ownerId",
             d."decision_input_hash" AS "decisionInputHash", d."decision_input" AS "decisionInput",
             d."outcome", d."decided_by" AS "decidedBy",
             d."coordinator_agent_id" AS "coordinatorAgentId",
             d."coordinator_session_id" AS "coordinatorSessionId",
             d."fencing_token" AS "fencingToken", d."reason", d."created_at" AS "createdAt"
        FROM "project_decision" d JOIN "project" p ON p."id" = d."project_id"
       WHERE d."id" = ${decisionId}::uuid AND p."owner_id" = ${ownerId}::uuid
    `);
        const row = rows[0];
        if (!row)
            return null;
        const input = row.decisionInput;
        const rawStored = row.outcome;
        const stored = {
            ...rawStored,
            authorizations: rawStored.authorizations ?? [],
            aggregations: rawStored.aggregations ?? [],
            aggregationCycleTaskIds: rawStored.aggregationCycleTaskIds ?? [],
        };
        const hashMatches = input.decisionInputHash === row.decisionInputHash
            && hashDecisionInput(input) === row.decisionInputHash;
        const replayed = planProjectDecision(input, {
            decisionId: row.id,
            decidedBy: row.decidedBy,
            consumedEventIds: stored.consumedEventIds,
            actions: stored.actions,
            authorizations: stored.authorizations ?? [],
        });
        const outcomeMatches = canonicalJson(replayed) === canonicalJson(stored);
        const actions = await this.prisma.$queryRaw(client_1.Prisma.sql `
      SELECT a."id" AS "actionId", a."idempotency_key" AS "idempotencyKey", a."type"::text,
             a."status"::text, a."subject_type" AS "subjectType", a."subject_id" AS "subjectId",
             a."decision_id" AS "decisionId", a."result_session_id" AS "resultSessionId",
             a."refusal_code" AS "refusalCode", a."detail",
             a."created_at" AS "createdAt", a."updated_at" AS "updatedAt"
        FROM "project_action" a
       WHERE a."decision_id" = ${decisionId}::uuid AND a."project_id" = ${row.projectId}::uuid
       ORDER BY a."created_at", a."id"
    `);
        const actionsTraceable = actions.every((action) => {
            const detail = action.detail && typeof action.detail === 'object' && !Array.isArray(action.detail)
                ? action.detail
                : {};
            // Both spellings of the key, normalized to the audit's — the same translation
            // `applyDecisionActionInTransaction` makes before it decides an action was planned (§8.2).
            // A plan is written in Base62 and the ledger row is keyed by the internal id, so comparing
            // them raw reports every legitimately applied action as untraceable: `ROTATE_COORDINATOR_
            // SESSION` is planned by `plannedActions` from the Base62 snapshot and claimed by the
            // executor under `lease.projectId`, which made `matches` false for every project that had
            // ever rotated its coordinator — an audit that accuses the loop of acting on its own.
            const ledgerKey = publicIdempotencyKey(action.idempotencyKey);
            return detail.decisionInputHash === row.decisionInputHash
                && stored.actions.some((planned) => planned.type === action.type
                    && publicIdempotencyKey(planned.idempotencyKey) === ledgerKey
                    && planned.subject.type === action.subjectType
                    && (planned.subject.id ?? null) === toPublicIdOrNull(action.subjectId));
        });
        return {
            matches: hashMatches && outcomeMatches && actionsTraceable,
            hashMatches,
            outcomeMatches,
            actionsTraceable,
            decision: publicAudit(row, input, stored, actions),
        };
    }
};
exports.ProjectDecisionService = ProjectDecisionService;
exports.ProjectDecisionService = ProjectDecisionService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], ProjectDecisionService);
function createDecisionId() {
    return (0, node_crypto_1.randomUUID)();
}
function planProjectDecision(input, options) {
    if (hashDecisionInput(input) !== input.decisionInputHash) {
        throw new Error('Project decision input hash mismatch');
    }
    for (const audit of options.authorizations ?? []) {
        if (audit.request.sourceDecisionInputHash !== input.decisionInputHash
            || !(0, project_authorization_service_1.replayProjectAuthorizationAudit)(audit)) {
            throw new Error('Project authorization audit does not replay from this decision input');
        }
    }
    const aggregation = (0, task_aggregation_1.planTaskAggregation)(aggregationFacts(input));
    const coordinator = (0, project_coordinator_session_1.planCoordinatorSessionRotation)(input);
    const blockerPlan = planBlockers(input, aggregation, coordinator);
    const runStateAfter = runStateOf(input, blockerPlan?.openAfter ?? []);
    // §7.2 / §7.6, after the blockers and the rotation because it reads both. A snapshot that
    // predates either projection is NOT evaluated at all: those decisions were made by a binary that
    // opened no semantic turn, and a replay has to reproduce what it decided rather than today's
    // rules applied to yesterday's world — the same reading `world.blockers` already asks for.
    const evaluatesTurns = blockerPlan !== null
        && coordinator.status !== 'UNSUPPORTED'
        && coordinator.status !== 'OUT_OF_LOOP';
    const turn = evaluatesTurns
        ? (0, project_turn_reason_1.planCoordinatorTurn)(input, {
            openBlockers: blockerPlan.openAfter,
            verdicts: verificationVerdictPlan(input),
            coordinator,
        })
        : null;
    const wake = blockerPlan
        ? (0, project_next_wake_1.chooseProjectWake)({ epoch: input.evaluation.epoch, runStateAfter }, (0, project_next_wake_1.collectProjectWakeCandidates)({
            epoch: input.evaluation.epoch,
            projectId: input.world.project.id,
            runStateAfter,
            blockers: blockerPlan.openAfter,
            tasks: input.world.tasks.map((task) => ({
                id: task.id,
                retryBackoffUntil: task.retryBackoffUntil,
                runAt: task.runAt,
                retryBackoffExpired: input.evaluation.dueTasks[task.id]?.retryBackoffExpired ?? true,
                runAtDue: input.evaluation.dueTasks[task.id]?.runAtDue ?? true,
            })),
            hasInFlightSession: hasLiveTaskSession(input),
            rateLimitedTurnWindows: rateLimitedTurnWindows(input),
        }))
        : legacyWake(input, runStateAfter);
    return {
        v: 1,
        reconcileId: toPublicId(options.decisionId),
        fencingToken: input.world.runtime.fencingToken,
        decisionInputHash: input.decisionInputHash,
        configRevision: input.world.project.configRevision,
        runStateBefore: input.world.runtime.runState,
        runStateAfter,
        decidedBy: options.decidedBy ?? 'ORCHESTRATOR',
        reason: wake.nextWakeReason ?? 'Project is outside the active coordination loop',
        actions: options.actions ?? plannedActions(input, coordinator, turn),
        authorizations: options.authorizations ?? [],
        blockersOpened: blockerPlan?.raises.map((raise) => raise.dedupeKey) ?? [],
        blockersCleared: blockerPlan?.clears.map((clear) => clear.blockerId) ?? [],
        ...(blockerPlan
            ? {
                blockers: {
                    raised: blockerPlan.raises,
                    touched: blockerPlan.touches,
                    cleared: blockerPlan.clears.map((clear) => ({ ...clear, resolvedBy: 'AUTO' })),
                    escalated: blockerPlan.escalations,
                    open: blockerPlan.openAfter,
                },
                detail: { wakeCandidates: wake.candidates, flooredBy: wake.flooredBy },
            }
            : {}),
        ...(coordinator.status === 'UNSUPPORTED' ? {} : { coordinator }),
        aggregations: aggregation.aggregations,
        aggregationCycleTaskIds: aggregation.cycleTaskIds,
        ...(evaluatesTurns
            ? {
                turnReason: turn?.reasonCode ?? null,
                suppressedTurnReasons: turn?.suppressed ?? [],
            }
            : {}),
        ...(turn ? { turn } : {}),
        nextWakeAt: wake.nextWakeAt,
        nextWakeReason: wake.nextWakeReason,
        consumedEventIds: options.consumedEventIds ?? [],
    };
}
/**
 * The actions this snapshot itself proposes, for a caller that supplied none.
 *
 * §7.5's rotation and §7.2's semantic turn, and deliberately only those two: they are the two
 * actions whose SUBJECT is the project itself and whose decision is this function's own (§7.5 and
 * §7.2 TU4 are both pure functions of the snapshot). Every other action in §7.3's table is proposed
 * by the unit that applies it, which passes its own list. Planning them here is what makes the
 * ledger's `planned` gate meaningful — an action that no decision proposed may not be claimed
 * against that decision (§8.3), so the pass that decides and the pass that acts agree on one
 * frozen list.
 *
 * The key is spelled the way the AUDIT spells everything — Base62 — while the ledger stores the
 * same key with the raw project UUID, because a permanent action key is an internal identity that
 * must not change spelling when the codec does (§8.2). The two are one key in two spellings, and
 * `publicIdempotencyKey` is the single translation between them; the blocker dedupe keys have
 * carried exactly this shape since §11.3.
 */
function plannedActions(input, coordinator, turn) {
    const actions = [];
    if (coordinator.status === 'ROTATE') {
        actions.push({
            type: 'ROTATE_COORDINATOR_SESSION',
            idempotencyKey: (0, project_coordinator_session_1.rotateCoordinatorSessionIdempotencyKey)(input.world.project.id, coordinator.generation),
            subject: { type: 'PROJECT', id: input.world.project.id },
        });
    }
    // §7.2 TU5 / §4.3 I15: at most one, and only when §7.6's three preconditions all cleared. The
    // other verdicts are decisions too — rate-limited, no-progress and no-live-run each have a
    // defined consequence — but none of them is an ACTION, so none of them takes a key.
    if (turn?.verdict === 'OPEN') {
        actions.push({
            type: 'OPEN_COORDINATOR_TURN',
            idempotencyKey: turn.idempotencyKey,
            subject: { type: 'PROJECT', id: input.world.project.id },
        });
    }
    return actions;
}
/**
 * §11.4's recomputation, fail-closed (BL2).
 *
 * Returns `null` for a snapshot taken before migration 0125 — that decision was made by a binary
 * with no blockers at all, and an audit replay has to reproduce what it decided rather than what
 * today's rules would decide about yesterday's world.
 *
 * The `catch` is BL2 written out: a detector that throws is a failure nobody classified, and the
 * answer to that is an `UNKNOWN_FAILURE` blocker that stops this project's automatic dispatch —
 * not an empty condition list, which would silently clear every open row.
 */
function planBlockers(input, aggregation, coordinatorSession) {
    const open = input.world.blockers;
    if (open === undefined)
        return null;
    let observed;
    try {
        observed = (0, project_blocker_conditions_1.detectProjectBlockerConditions)(input, {
            aggregationCycleTaskIds: aggregation.cycleTaskIds,
            // AG7's marker, checked here rather than inside the detector: an old snapshot must produce
            // the outcome its own binary produced, and "no gaps observed" is what that binary observed.
            aggregationCompletionGaps: input.world.protocol?.completionGaps
                ? aggregation.completionGaps
                : [],
            verificationVerdicts: verificationVerdictPlan(input),
            coordinatorSession,
        });
    }
    catch (cause) {
        observed = [{
                kind: 'UNKNOWN_FAILURE',
                subjectType: 'PROJECT',
                subjectId: input.world.project.id,
                // The reason, not the message: a digest that moved with an error string would open a new
                // coordinator turn every time the wording changed.
                facts: { reason: 'CONDITION_DETECTION_FAILED' },
                detail: {
                    reason: 'CONDITION_DETECTION_FAILED',
                    error: (cause instanceof Error ? cause.message : String(cause)).slice(0, 500),
                },
            }];
    }
    return (0, project_blocker_1.planProjectBlockers)({ epoch: input.evaluation.epoch, open, observed });
}
/** §13.2's plan for this snapshot, shared by the verdict consequences and the blocker face so the
 *  two cannot disagree about what a check concluded. */
function verificationVerdictPlan(input) {
    const facts = verificationVerdictFacts(input);
    return (0, task_verification_verdict_1.planVerificationVerdicts)(facts.verifications, facts.subjects).verdicts;
}
/** §13.1 AG7's shapes for this snapshot, shared by §11's blocker face and §13.2 V8's filing action
 *  the way `verificationVerdictPlan` is shared, so the two cannot disagree about which gaps the
 *  loop closes itself and which ones it hands to a person. */
function completionGapPlan(input) {
    // The marker, not a try/catch and not a feature flag: a decision captured before this build has
    // to keep replaying to its own outcome. Both consumers go through here so neither can forget.
    if (!input.world.protocol?.completionGaps)
        return [];
    return (0, task_aggregation_1.planTaskAggregation)(aggregationFacts(input)).completionGaps;
}
/**
 * §10.4 as it read before W5 and before blockers existed, kept for exactly one caller: replaying a
 * decision captured before migration 0125.
 */
function legacyWake(input, runStateAfter) {
    const nextWakeReason = runStateAfter === 'PLANNING'
        ? 'planning requires coordinator decision'
        : runStateAfter === 'EXECUTING'
            ? 'in-flight session may end'
            : runStateAfter === 'AWAITING_VERIFICATION'
                ? 'verification may settle'
                : runStateAfter === 'SETTLED'
                    ? null
                    : 'reconcile state recheck';
    return {
        nextWakeAt: runStateAfter === 'SETTLED'
            ? null
            : new Date(input.evaluation.epoch * 1_000 + project_next_wake_1.PROJECT_WAKE_FALLBACK_MS).toISOString(),
        nextWakeReason,
        candidates: [],
        flooredBy: null,
    };
}
/** §4.2 guard 5 / §10.4 clause 5 read the same predicate, so they read it from one place. */
function hasLiveTaskSession(input) {
    return input.world.sessions.some((session) => session.taskId != null && !session.deletedAt && isLiveSession(session.runStatus));
}
/**
 * §7.6 TR2-b: windows a pending request is currently held behind.
 *
 * `MANUAL` is the only `reasonCode` §7.2's table has today, and it is triggered by an unconsumed
 * `user.manual_trigger`; with none pending there is nothing being held and therefore no candidate.
 * The clause is written per `reasonCode` so a second row in that table needs no change here.
 */
function rateLimitedTurnWindows(input) {
    return Object.entries(input.evaluation.turnWindows ?? {})
        .filter(([reasonCode, window]) => !window.rateLimitExpired
        && (reasonCode !== 'MANUAL' || input.signals.length > 0))
        .map(([reasonCode, window]) => ({ reasonCode, windowEndsAt: window.windowEndsAt }))
        .sort((a, b) => (a.reasonCode < b.reasonCode ? -1 : a.reasonCode > b.reasonCode ? 1 : 0));
}
function hashDecisionInput(input) {
    return sha256({ world: input.world, evaluation: input.evaluation, signals: input.signals });
}
function canonicalJson(value) {
    return JSON.stringify(canonicalValue(value));
}
function canonicalValue(value) {
    if (Array.isArray(value))
        return value.map(canonicalValue);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, item]) => [key, canonicalValue(item)]));
    }
    return value;
}
/**
 * The snapshot's tasks as §13.1 reads them, in Base62 throughout — the plan lands in the decision
 * outcome, which is the public audit protocol, so it must never carry a raw UUID.
 *
 * A pre-0123 snapshot has neither column. Defaulting them here rather than at the database keeps
 * one rule in one place: no policy means MANUAL means no aggregation.
 */
function aggregationFacts(input) {
    return input.world.tasks.map((task) => ({
        id: task.id,
        status: task.status,
        parentTaskId: task.parentTaskId,
        completionPolicy: (task.completionPolicy ?? 'MANUAL'),
        verifiesTaskId: task.verifiesTaskId,
        verdict: (task.verdict ?? null),
        // §13.6 SU6. Absent on a pre-0129 snapshot, which reads as "not retired" — see `world.tasks`.
        supersededByTaskId: task.supersededByTaskId ?? null,
        retirement: (0, task_supersession_1.taskRetirement)({
            supersededByTaskId: task.supersededByTaskId ?? null,
            terminalReason: task.terminalReason ?? null,
        }),
    }));
}
/**
 * The snapshot's verifications and their subjects as §13.2 reads them, Base62 throughout.
 *
 * `hasLiveSession` comes from the task's own live session list, never from a turn count: `numTurns`
 * lands when a turn ENDS, and a task is normally marked DONE from inside the turn that did the
 * work, so counting turns reports "never ran" for precisely the runs that did (V5).
 *
 * A pre-0124 snapshot has no revision column. Defaulting it to `'0'` here keeps one rule in one
 * place — an unrevisioned verdict has no action identity, and the planner skips it.
 */
function verificationVerdictFacts(input) {
    const evidenceByVerifier = new Map(input.world.evidence.tests.map((test) => [test.verificationTaskId, test]));
    const verifications = input.world.tasks
        .filter((task) => task.verifiesTaskId != null)
        .map((task) => {
        const evidence = evidenceByVerifier.get(task.id);
        return {
            id: task.id,
            status: task.status,
            verifiesTaskId: task.verifiesTaskId,
            verdict: (task.verdict ?? null),
            verdictRevision: task.verdictRevision ?? '0',
            // §13.6 SU6, carried through the snapshot rather than re-read: the planner's answer and the
            // decision's recorded input have to be about one world. Absent on a pre-0129 snapshot,
            // which reads as "nothing retired this check".
            supersededByTaskId: task.supersededByTaskId ?? null,
            terminalReason: task.terminalReason ?? null,
            hasLiveSession: task.liveSessionIds.length > 0,
            session: evidence?.sessionId
                ? {
                    id: evidence.sessionId,
                    runStatus: evidence.runStatus ?? 'UNKNOWN',
                    finishedAt: evidence.finishedAt ?? null,
                    resultHash: evidence.resultHash ?? null,
                    errorHash: evidence.errorHash ?? null,
                }
                : null,
        };
    });
    const subjects = input.world.tasks.map((task) => ({
        id: task.id,
        status: task.status,
        supersededByTaskId: task.supersededByTaskId ?? null,
        terminalReason: task.terminalReason ?? null,
    }));
    return { verifications, subjects };
}
/**
 * §4.2 RS0: `run_state` is a pure function of the snapshot, evaluated in guard order, first match
 * wins. Not a transition table — v1's was, and on a mixed blocker set two of its rows fired at once
 * and the answer came down to which blocker the implementation happened to visit first
 * (`PC-CX-03`).
 *
 * Guard 4 (ACCEPTANCE, an unconverged `RUN_PROJECT_ACCEPTANCE`) is absent because no pass produces
 * that action yet; it belongs to §13.4's unit and slots in between guards 3 and 5.
 */
function runStateOf(input, openBlockers) {
    if (input.world.project.status !== 'OPEN')
        return 'SETTLED';
    // Guards 2 and 3. People before machines: AWAITING_HUMAN is the only state that may stop the
    // loop's own clock, so letting a SYSTEM blocker mask it would hide the fact that somebody is
    // being waited on.
    const blocked = (0, project_blocker_1.blockerRunState)(openBlockers);
    if (blocked)
        return blocked;
    if (hasLiveTaskSession(input))
        return 'EXECUTING';
    // §4.2 guard 6, with §13.6 SU6's exception. "A verification exists that is not DONE" is the
    // right question about a LIVE check; asked of a retired one it never stops being true, because
    // nothing will dispatch that verifier again. A project whose check was re-run from scratch would
    // sit in AWAITING_VERIFICATION for the rest of its life, waiting on the attempt it replaced.
    // Absent fields (a pre-0129 snapshot) read as not retired, so an old decision replays unchanged.
    const retirementById = new Map(input.world.tasks.map((task) => [task.id, (0, task_supersession_1.taskRetirement)({
            supersededByTaskId: task.supersededByTaskId ?? null,
            terminalReason: task.terminalReason ?? null,
        })]));
    if (input.world.tasks.some((task) => task.verifiesTaskId
        && task.status !== 'DONE'
        && !(0, task_supersession_1.taskIsObsolete)({
            retirement: retirementById.get(task.id) ?? null,
            // ...and its SUBJECT's, which is the half that made this guard unfalsifiable: a healthy
            // OPEN check pointed at replaced work can never become DONE, so "a verification exists that
            // is not DONE" stayed true for the life of the project.
            subjectRetirement: retirementById.get(task.verifiesTaskId) ?? null,
        }))) {
        return 'AWAITING_VERIFICATION';
    }
    return 'PLANNING';
}
function assertDecisionReplay(input, outcome) {
    const taskIds = new Set(input.world.tasks.map((task) => task.id));
    for (const action of outcome.actions) {
        const subjectId = action.subject.id ?? null;
        if (action.subject.type === 'PROJECT' && subjectId !== input.world.project.id) {
            throw new Error('Project decision action names a Project outside its snapshot');
        }
        if (action.subject.type === 'TASK' && (!subjectId || !taskIds.has(subjectId))) {
            throw new Error('Project decision action names a Task outside its snapshot');
        }
        if (subjectId)
            toInternalId(subjectId);
    }
    const replayed = planProjectDecision(input, {
        decisionId: toInternalId(outcome.reconcileId),
        decidedBy: outcome.decidedBy,
        consumedEventIds: outcome.consumedEventIds,
        actions: outcome.actions,
        authorizations: outcome.authorizations,
    });
    if (canonicalJson(replayed) !== canonicalJson(outcome)) {
        throw new Error('Project decision outcome is not reproducible from its input');
    }
}
function publicAudit(row, input, outcome, actions) {
    return publicizeIds({
        id: row.id,
        projectId: row.projectId,
        input,
        outcome,
        decidedBy: row.decidedBy,
        coordinatorAgentId: row.coordinatorAgentId,
        coordinatorSessionId: row.coordinatorSessionId,
        fencingToken: String(row.fencingToken),
        reason: row.reason,
        createdAt: isoRequired(row.createdAt),
        actions: actions.map((action) => ({
            id: action.actionId,
            type: action.type,
            status: action.status,
            subject: { type: action.subjectType, id: action.subjectId },
            decisionId: action.decisionId,
            resultSessionId: action.resultSessionId,
            refusalCode: action.refusalCode,
            idempotencyKey: action.idempotencyKey,
            idempotencyKeyHash: sha256(action.idempotencyKey),
            detail: jsonValue(action.detail),
            createdAt: isoRequired(action.createdAt),
            updatedAt: isoRequired(action.updatedAt),
        })),
    });
}
/**
 * A permanent action key as the audit protocol spells it (§6.2): every embedded UUID in Base62.
 *
 * Not a second key — the same key, publicized, exactly as `publicDedupeKey` publicizes a blocker's.
 * The ledger keeps the internal spelling (§8.2), so this is also what lets a plan and the call that
 * applies it be compared without either having to know how the other spells an id.
 */
function publicIdempotencyKey(key) {
    return key.replace(UUID_PATTERN, (id) => toPublicId(id));
}
const UUID_PATTERN = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;
function publicizeIds(value) {
    if (Array.isArray(value))
        return value.map(publicizeIds);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value)
            .map(([key, item]) => [key, publicizeIds(item)]));
    }
    if (typeof value !== 'string')
        return value;
    return value.replace(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g, (id) => toPublicId(id));
}
function sha256(value) {
    const source = typeof value === 'string' ? value : canonicalJson(value);
    return (0, node_crypto_1.createHash)('sha256').update(source).digest('hex');
}
function jsonValue(value) {
    return value == null ? null : canonicalValue(value);
}
function providerModels(catalog, slug) {
    if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog))
        return [];
    const value = catalog[slug];
    if (value == null)
        return [];
    return Array.isArray(value) ? value : [value];
}
function parseProviderFallbacks(value) {
    if (!Array.isArray(value))
        return [];
    return value.flatMap((candidate) => {
        if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate))
            return [];
        const item = candidate;
        if (typeof item.provider !== 'string' || !item.provider.trim())
            return [];
        if (item.model != null && typeof item.model !== 'string')
            return [];
        return [{ provider: item.provider, ...(item.model == null ? {} : { model: item.model }) }];
    });
}
function isUsageLimitFailure(error) {
    if (!error)
        return false;
    const normalized = error.toLocaleLowerCase();
    return shared_1.USAGE_LIMIT_ERROR_MARKERS.some((marker) => normalized.includes(marker.toLocaleLowerCase()));
}
/** §4.2 guard 5 and §7.5 must agree about what "still going" means, so they read one predicate. */
function isLiveSession(status) {
    return (0, project_coordinator_session_1.isLiveSessionStatus)(status);
}
function iso(value) {
    return value == null ? null : isoRequired(value);
}
function isoRequired(value) {
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
/**
 * §7.6 TR2-a's window per `reasonCode`, folded into S5's frozen instant.
 *
 * The anchor is the LATEST applied turn on that bucket and the boundary is its `created_at + 60s`
 * — both committed facts, so a takeover, a restart or a replica reads the same window rather than
 * inventing one from its own clock.
 */
function turnWindowsOf(actions, epoch) {
    const anchors = new Map();
    for (const action of actions) {
        if (action.type !== 'OPEN_COORDINATOR_TURN' || action.status !== 'APPLIED')
            continue;
        if (!action.reasonCode)
            continue;
        anchors.set(action.reasonCode, action.createdAt);
    }
    return Object.fromEntries([...anchors]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([reasonCode, createdAt]) => {
        const endsAt = createdAt.getTime() + project_next_wake_1.PROJECT_TURN_RATE_LIMIT_MS;
        return [reasonCode, {
                windowEndsAt: new Date(endsAt).toISOString(),
                rateLimitExpired: endsAt <= epoch * 1_000,
            }];
    }));
}
/** A blocker subject is either a row id (Base62 out, like everything else here) or a natural key
 *  a builtin provider is named by, which is not a UUID and is left alone. */
function publicSubjectId(subjectId) {
    try {
        return (0, shared_1.uuidToBase62)(subjectId);
    }
    catch {
        return subjectId;
    }
}
/** §5.4 F22's row, addressed the way it is STORED: the dedupe key keeps internal ids (§11.3), and
 *  this query runs against the table rather than against a snapshot. */
function deadLetterDedupeKey(projectId) {
    return (0, project_blocker_1.projectBlockerDedupeKey)('UNKNOWN_FAILURE', 'PROJECT', projectId);
}
/** §11.3's key is `<kind>:<subjectType>:<subjectId>`, so the subject inside it is publicized too —
 *  otherwise the audit would carry a raw UUID in the middle of a string. */
function publicDedupeKey(dedupeKey) {
    const parts = dedupeKey.split(':');
    if (parts.length !== 3)
        return dedupeKey;
    return `${parts[0]}:${parts[1]}:${publicSubjectId(parts[2])}`;
}
function toPublicId(id) {
    return (0, shared_1.uuidToBase62)(id);
}
function toPublicIdOrNull(id) {
    return id == null ? null : toPublicId(id);
}
function toInternalId(publicId) {
    // Avoid importing the permissive route decoder into the protocol surface. A decision outcome
    // written here always came from uuidToBase62, so this local inverse is exact and closed.
    const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
    if (!publicId)
        throw new Error('empty Project decision public id');
    let n = 0n;
    for (const char of publicId) {
        const digit = alphabet.indexOf(char);
        if (digit < 0)
            throw new Error('invalid Project decision public id');
        n = n * 62n + BigInt(digit);
    }
    if (n >= (1n << 128n))
        throw new Error('Project decision public id overflows UUID');
    const hex = n.toString(16).padStart(32, '0');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function toInternalProjectId(input) {
    return toInternalId(input.world.project.id);
}
//# sourceMappingURL=project-decision.service.js.map