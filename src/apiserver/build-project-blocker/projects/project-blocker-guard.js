"use strict";
/**
 * The dispatch guard §11 BL1/BL2 imply: an open blocker means this step is KNOWN not to be able to
 * go forward, so the dispatch stops before the resolution chain re-litigates it.
 *
 * It lives here, as one exported statement, so the rule and the test read the same bytes. Written
 * out again inside a spec it would be two predicates that agree today.
 *
 * Scope: a PROJECT-subject row stops everything (there is nowhere to run, no coordinator, no
 * budget, a cycle in the graph, or an unclassified failure), while a TASK-subject row stops its own
 * task. A SESSION-subject row — somebody is being waited on in one conversation — deliberately
 * stops nothing else.
 *
 * The one exception is `PROJECT_BLOCKER_RESOLUTION_CHAIN_KINDS` on a TASK: §7.4 re-answers those
 * from the current world on every attempt, so stopping the attempt would leave §11.4's
 * recomputation reading a historical refusal it can never falsify — the row would outlive the
 * outage that caused it. Nothing is lost by letting the attempt through: the chain refuses it again
 * with the same code (same dedupe key, same episode) while the condition holds, and the first
 * attempt that is NOT refused is what clears the row.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.openBlockersStoppingDispatch = openBlockersStoppingDispatch;
const client_1 = require("@prisma/client");
const project_blocker_1 = require("./project-blocker");
function openBlockersStoppingDispatch(projectId, taskId) {
    return client_1.Prisma.sql `
    SELECT b."id", b."kind", b."owner"::text, b."subject_type" AS "subjectType",
           b."required_action" AS "requiredAction"
      FROM "project_blocker" b
     WHERE b."project_id" = ${projectId}::uuid
       AND b."resolved_at" IS NULL
       AND (b."subject_type" = 'PROJECT'
            OR (b."subject_type" = 'TASK' AND b."subject_id" = ${taskId}
                AND b."kind" NOT IN (${client_1.Prisma.join([...project_blocker_1.PROJECT_BLOCKER_RESOLUTION_CHAIN_KINDS])})))
     ORDER BY b."kind", b."id"
  `;
}
//# sourceMappingURL=project-blocker-guard.js.map