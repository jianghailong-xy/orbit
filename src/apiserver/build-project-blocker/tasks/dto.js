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
exports.CreateTaskCommentDto = exports.BatchAssignDto = exports.BatchDeleteDto = exports.BatchStopDto = exports.BatchExecuteDto = exports.RefreshDependencyGraphNodesDto = exports.ExpandDependencyGraphDto = exports.AddDependencyDto = exports.UpdateTaskDto = exports.ProposeDagDto = exports.DagOpDto = exports.CreateTasksBatchDto = exports.CreateTaskBatchItemDto = exports.DAG_PREVIEW_TITLES = exports.MAX_DAG_OPS = exports.TASK_BATCH_CREATE_MAX = exports.CreateTaskDto = exports.MAX_TASK_ACCEPTANCE_CRITERIA_CHARS = exports.TASK_LABEL_MAX_LENGTH = exports.TASK_LABEL_MAX_COUNT = void 0;
const class_transformer_1 = require("class-transformer");
const class_validator_1 = require("class-validator");
const shared_1 = require("@orbit/shared");
const public_id_1 = require("../common/public-id");
const task_supersession_1 = require("./task-supersession");
const task_aggregation_1 = require("../projects/task-aggregation");
const TASK_STATUSES = Object.values(shared_1.TaskStatus);
const TASK_COMPLETION_POLICY_VALUES = [...task_aggregation_1.TASK_COMPLETION_POLICIES];
const TASK_VERDICT_VALUES = [...task_aggregation_1.TASK_VERDICTS];
const TASK_TERMINAL_REASON_VALUES = [...task_supersession_1.TASK_TERMINAL_REASONS];
/**
 * Bounds on one task's labels. Not a taxonomy — a stop on a caller that has confused the label
 * set with the description. Both are mirrored in the runner's MCP tool schema.
 */
exports.TASK_LABEL_MAX_COUNT = 16;
exports.TASK_LABEL_MAX_LENGTH = 64;
/** Same cap and same reasoning as the project's own criteria (see projects/dto.ts). */
exports.MAX_TASK_ACCEPTANCE_CRITERIA_CHARS = 4_000;
class CreateTaskDto {
    title;
    description;
    // The workspace assigned to execute the task. Must be owned by the caller.
    assigneeId;
    // The list this task belongs to. Must be owned by the caller.
    listId;
    // The project this task is work towards. Must be owned by the caller. Orthogonal to listId:
    // a list decides how the task runs, a project states what it is for.
    projectId;
    // The task this one is a part of. Must be owned by the caller and belong to the same project —
    // a subtask of work in another project is a statement no reader could act on.
    parentTaskId;
    // What would settle that this task is actually done.
    acceptanceCriteria;
    // How this task's own completion is decided once it has subtasks. Omitted is MANUAL, which is
    // what every task has always been: nothing completes it but a status write. See §13.1.
    completionPolicy;
    // The task this one exists to check (§13.2). Naming it here is what makes a verification
    // filable on purpose rather than only by the automatic verifyOnDone path — and it is the
    // precondition for everything the verdict does, since `verdict` is refused on a task that
    // verifies nothing and `VERIFICATION_PASSED` counts only checks pointed at the subject.
    //
    // The subject must be owned by the caller, must not be this task, must not itself be a
    // verification, and must be in the same project — aggregation reads one project's tasks, so a
    // check filed across that line would be one nothing can ever count.
    verifiesTaskId;
    // §13.6 SU7: the attempt this new task REPLACES. The successor and the link are written in one
    // transaction — the point of the field is that there is no window in which the replacement
    // exists and the thing it replaced does not know.
    //
    // Without it, recording a supersession takes two calls, and this deployment has already paid for
    // the gap between them: a fresh review was created saying "replacement for the earlier attempt"
    // in its description, the second call was never made, and the abandoned attempt was re-dispatched
    // by the control loop weeks later because nothing structured said it had been replaced.
    //
    // The predecessor must be CANCELLED or FAILED, owned by the caller, in the same project as this
    // new task, and not already replaced (SU2–SU5, plus a compare-and-set so two concurrent
    // replacements produce one winner and one 409 rather than a pointer that depends on timing).
    //
    // There is deliberately no `supersedesRef` for a task created by this same batch: SU4 refuses a
    // predecessor that has not stopped, batch-created tasks are OPEN, and a parameter that is
    // refused every time it is used is worse than one that does not exist.
    supersedesTaskId;
    dueDate;
    // The earliest time this task may start automatically (ISO 8601, stored and returned UTC).
    // Omitted means unscheduled, which is what every task has always been. Distinct from dueDate on
    // purpose: that is a deadline nothing dispatches on, this is a trigger — see Task.runAt.
    //
    // One-shot. The first run actually accepted consumes it, so there is no recurrence to express
    // and no cron expression to accept.
    runAt;
    // Provider/model this task's runs use, overriding the assignee workspace's own. The provider must
    // be a built-in engine slug or one of the caller's enabled configured providers; omitted (or
    // null) inherits from the assignee, which is the historical behaviour.
    provider;
    model;
    // Prerequisite task ids this new task should wait on (each must be owned by the
    // caller). The task only runs once they're all DONE.  //
    // Name the SUBJECT, not its verification task. "B waits for A to be verified" is spelled
    // `dependsOn: A`: once anything checks A, §13.3 DEP holds that edge until A's latest check has
    // actually PASSED — a check that finished DONE with a FAIL verdict does not release it, and
    // neither does re-opening the question with a new check. An edge naming the CHECK resolves to
    // the same epoch, so old plans keep working, but it reads as being about one particular run
    // when what the author meant was the work.
    dependsOnTaskIds;
    // Auto-run once all prerequisites are DONE (default true). Ignored without deps.
    autoRunWhenReady;
    // Free-text grouping labels, orthogonal to listId (see Task.labels). Stored trimmed and
    // deduplicated, case as given, since filtering matches exactly.
    labels;
}
exports.CreateTaskDto = CreateTaskDto;
__decorate([
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MinLength)(1),
    __metadata("design:type", String)
], CreateTaskDto.prototype, "title", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], CreateTaskDto.prototype, "description", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, public_id_1.IsPublicId)(),
    __metadata("design:type", String)
], CreateTaskDto.prototype, "assigneeId", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, public_id_1.IsPublicId)(),
    __metadata("design:type", String)
], CreateTaskDto.prototype, "listId", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, public_id_1.IsPublicId)(),
    __metadata("design:type", String)
], CreateTaskDto.prototype, "projectId", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, public_id_1.IsPublicId)(),
    __metadata("design:type", String)
], CreateTaskDto.prototype, "parentTaskId", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MaxLength)(exports.MAX_TASK_ACCEPTANCE_CRITERIA_CHARS),
    __metadata("design:type", String)
], CreateTaskDto.prototype, "acceptanceCriteria", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsIn)(TASK_COMPLETION_POLICY_VALUES),
    __metadata("design:type", String)
], CreateTaskDto.prototype, "completionPolicy", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, public_id_1.IsPublicId)(),
    __metadata("design:type", String)
], CreateTaskDto.prototype, "verifiesTaskId", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, public_id_1.IsPublicId)(),
    __metadata("design:type", String)
], CreateTaskDto.prototype, "supersedesTaskId", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsDateString)(),
    __metadata("design:type", String)
], CreateTaskDto.prototype, "dueDate", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsDateString)(),
    __metadata("design:type", String)
], CreateTaskDto.prototype, "runAt", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MaxLength)(64),
    __metadata("design:type", Object)
], CreateTaskDto.prototype, "provider", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MaxLength)(200),
    __metadata("design:type", Object)
], CreateTaskDto.prototype, "model", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsArray)(),
    (0, public_id_1.IsPublicId)({ each: true }),
    __metadata("design:type", Array)
], CreateTaskDto.prototype, "dependsOnTaskIds", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsBoolean)(),
    __metadata("design:type", Boolean)
], CreateTaskDto.prototype, "autoRunWhenReady", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsArray)(),
    (0, class_validator_1.ArrayMaxSize)(exports.TASK_LABEL_MAX_COUNT),
    (0, class_validator_1.IsString)({ each: true }),
    (0, class_validator_1.MaxLength)(exports.TASK_LABEL_MAX_LENGTH, { each: true }),
    __metadata("design:type", Array)
], CreateTaskDto.prototype, "labels", void 0);
/** How many tasks one batch-create call may write. Mirrored in the runner's MCP tool schema. */
exports.TASK_BATCH_CREATE_MAX = 50;
/**
 * How many edges one DAG proposal may rewrite.
 *
 * A cap on how much a single approval can be made to mean. Fifty is well past any restructure a
 * person reads and judges in one card; past that the honest description of what they are doing is
 * clicking approve on a number rather than on a change.
 */
exports.MAX_DAG_OPS = 50;
/** How many task titles a batch-create approval card shows before it starts counting instead. */
exports.DAG_PREVIEW_TITLES = 12;
class CreateTaskBatchItemDto extends CreateTaskDto {
    // Caller-supplied label for THIS item, used only to wire the batch together internally — its
    // dependencies (dependsOnRefs) and its subtasks (parentRef) — since the real ids don't exist
    // yet. Never stored.
    ref;
    // Prerequisites created by this same batch, addressed by their `ref`. Each must belong to an
    // EARLIER item, which keeps the batch acyclic by construction. Adds to dependsOnTaskIds,
    // which stays reserved for tasks that already exist.
    dependsOnRefs;
    // The parent this item is a part of, created by this same batch and addressed by its `ref` —
    // what lets a decomposition land in one call, since the parent's id does not exist yet. Must
    // name an EARLIER item, which is both what makes the id available by the time this row is
    // written and what keeps the tree acyclic by construction. Mutually exclusive with
    // parentTaskId, which stays reserved for a parent that already exists: naming both is naming
    // two parents.
    parentRef;
    // The subject this item verifies, created by this same batch and addressed by its `ref`. Same
    // backward-only rule as the two above, and mutually exclusive with verifiesTaskId for the same
    // reason parentRef is with parentTaskId: naming both names two subjects.
    //
    // It exists so a phase and the check on that phase land in ONE all-or-nothing write. Filed as
    // two calls instead, the window between them is a phase whose completion policy is
    // VERIFICATION_PASSED with nothing pointed at it — a parent that can never complete.
    verifiesRef;
}
exports.CreateTaskBatchItemDto = CreateTaskBatchItemDto;
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MinLength)(1),
    (0, class_validator_1.MaxLength)(64),
    __metadata("design:type", String)
], CreateTaskBatchItemDto.prototype, "ref", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsArray)(),
    (0, class_validator_1.IsString)({ each: true }),
    __metadata("design:type", Array)
], CreateTaskBatchItemDto.prototype, "dependsOnRefs", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MinLength)(1),
    (0, class_validator_1.MaxLength)(64),
    __metadata("design:type", String)
], CreateTaskBatchItemDto.prototype, "parentRef", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MinLength)(1),
    (0, class_validator_1.MaxLength)(64),
    __metadata("design:type", String)
], CreateTaskBatchItemDto.prototype, "verifiesRef", void 0);
class CreateTasksBatchDto {
    // Created in order, all-or-nothing: if any item is invalid, no task is written.
    tasks;
}
exports.CreateTasksBatchDto = CreateTasksBatchDto;
__decorate([
    (0, class_validator_1.IsArray)(),
    (0, class_validator_1.ArrayMinSize)(1),
    (0, class_validator_1.ArrayMaxSize)(exports.TASK_BATCH_CREATE_MAX),
    (0, class_validator_1.ValidateNested)({ each: true }),
    (0, class_transformer_1.Type)(() => CreateTaskBatchItemDto),
    __metadata("design:type", Array)
], CreateTasksBatchDto.prototype, "tasks", void 0);
class DagOpDto {
    op;
    /** The dependent. Must belong to the list being restructured. */
    taskId;
    /** The prerequisite. May live in another list — cross-list waits are an ordinary shape. */
    dependsOnTaskId;
}
exports.DagOpDto = DagOpDto;
__decorate([
    (0, class_validator_1.IsIn)(['add', 'remove']),
    __metadata("design:type", String)
], DagOpDto.prototype, "op", void 0);
__decorate([
    (0, public_id_1.IsPublicId)(),
    __metadata("design:type", String)
], DagOpDto.prototype, "taskId", void 0);
__decorate([
    (0, public_id_1.IsPublicId)(),
    __metadata("design:type", String)
], DagOpDto.prototype, "dependsOnTaskId", void 0);
class ProposeDagDto {
    ops;
    /** Why, carried onto the approval card. The reason a human can judge the change at all. */
    note;
}
exports.ProposeDagDto = ProposeDagDto;
__decorate([
    (0, class_validator_1.IsArray)(),
    (0, class_validator_1.ArrayMinSize)(1),
    (0, class_validator_1.ArrayMaxSize)(exports.MAX_DAG_OPS),
    (0, class_validator_1.ValidateNested)({ each: true }),
    (0, class_transformer_1.Type)(() => DagOpDto),
    __metadata("design:type", Array)
], ProposeDagDto.prototype, "ops", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MaxLength)(2000),
    __metadata("design:type", String)
], ProposeDagDto.prototype, "note", void 0);
class UpdateTaskDto {
    title;
    description;
    status;
    // null clears the assignment; a string (re)assigns to that workspace.
    assigneeId;
    // null detaches from its list; a string (re)assigns to that list.
    listId;
    // null detaches from its project; a string (re)files it under that project. Rejected when it
    // would leave this task in a different project from its parent or its subtasks — see
    // TasksService.assertHierarchyConsistent.
    projectId;
    // null detaches from its parent; a string makes this task part of that one. Rejected for a
    // self-parent, for a cycle, and across projects.
    parentTaskId;
    // null clears the criteria; a string replaces them.
    acceptanceCriteria;
    dueDate;
    // Three-state like dueDate above: omit to keep the current schedule, null to cancel it, an ISO
    // instant to (re)schedule. Rescheduling a task whose dispatch is in flight is safe — the
    // consumption is a compare-and-set on the instant it read, so this write wins rather than being
    // cleared by the run it raced.
    runAt;
    // null goes back to inheriting the assignee workspace's provider/model; a string pins this task's
    // runs to that provider / model id. Omit to leave the current pin alone.
    provider;
    model;
    // Full replacement for this task's prerequisites. Omit to keep them unchanged;
    // pass [] to clear them all.  //
    // Name the SUBJECT, not its verification task. "B waits for A to be verified" is spelled
    // `dependsOn: A`: once anything checks A, §13.3 DEP holds that edge until A's latest check has
    // actually PASSED — a check that finished DONE with a FAIL verdict does not release it, and
    // neither does re-opening the question with a new check. An edge naming the CHECK resolves to
    // the same epoch, so old plans keep working, but it reads as being about one particular run
    // when what the author meant was the work.
    dependsOnTaskIds;
    // Auto-run once all prerequisites are DONE.
    autoRunWhenReady;
    // How this task's completion is decided. Switching to MANUAL stops aggregation without undoing
    // whatever it last concluded; switching away from it hands the status to the subtasks.
    completionPolicy;
    // The task this one exists to check. Three-state: omit to leave the relation alone, null to
    // detach it, an id to point this task at that subject. Refused once this task has concluded
    // anything (§13.2 V7): the consequences already applied are keyed on (verifier, revision) and
    // name the subject they were about, so re-pointing afterwards would leave the ledger asserting
    // a conclusion about a task the verifier no longer checks. File a new verification instead.
    verifiesTaskId;
    // The later attempt that replaced this one (§13.6). Three-state like the links above: omit to
    // leave it alone, null to unlink, an id to record that this attempt was superseded. Only a
    // CANCELLED or FAILED task may name one, the successor must be in the same project, and linking
    // writes nothing to `status` — the original outcome is the fact being kept.
    supersededByTaskId;
    // Why this task stopped, when its status alone does not say. Setting a successor implies
    // 'SUPERSEDED' and needs no explicit value; 'ABANDONED' is for the other case, a task dropped
    // with nothing replacing it.
    terminalReason;
    // This verification task's conclusion about its subject. Three-state like the pins above: omit
    // to leave it alone, null to revoke it, a value to record it. Only a task that names a subject
    // (verifiesTaskId) can carry one, and a revoked PASS reopens whatever it had completed.
    verdict;
    // Full replacement for this task's labels, like dependsOnTaskIds above: omit to leave them
    // alone, pass [] to clear them.
    labels;
}
exports.UpdateTaskDto = UpdateTaskDto;
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MinLength)(1),
    __metadata("design:type", String)
], UpdateTaskDto.prototype, "title", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], UpdateTaskDto.prototype, "description", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsIn)(TASK_STATUSES),
    __metadata("design:type", String)
], UpdateTaskDto.prototype, "status", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, public_id_1.IsPublicId)(),
    __metadata("design:type", Object)
], UpdateTaskDto.prototype, "assigneeId", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, public_id_1.IsPublicId)(),
    __metadata("design:type", Object)
], UpdateTaskDto.prototype, "listId", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, public_id_1.IsPublicId)(),
    __metadata("design:type", Object)
], UpdateTaskDto.prototype, "projectId", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, public_id_1.IsPublicId)(),
    __metadata("design:type", Object)
], UpdateTaskDto.prototype, "parentTaskId", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MaxLength)(exports.MAX_TASK_ACCEPTANCE_CRITERIA_CHARS),
    __metadata("design:type", Object)
], UpdateTaskDto.prototype, "acceptanceCriteria", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsDateString)(),
    __metadata("design:type", Object)
], UpdateTaskDto.prototype, "dueDate", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsDateString)(),
    __metadata("design:type", Object)
], UpdateTaskDto.prototype, "runAt", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MaxLength)(64),
    __metadata("design:type", Object)
], UpdateTaskDto.prototype, "provider", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MaxLength)(200),
    __metadata("design:type", Object)
], UpdateTaskDto.prototype, "model", void 0);
__decorate([
    (0, class_validator_1.ValidateIf)((_dto, value) => value !== undefined),
    (0, class_validator_1.IsArray)(),
    (0, public_id_1.IsPublicId)({ each: true }),
    __metadata("design:type", Array)
], UpdateTaskDto.prototype, "dependsOnTaskIds", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsBoolean)(),
    __metadata("design:type", Boolean)
], UpdateTaskDto.prototype, "autoRunWhenReady", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsIn)(TASK_COMPLETION_POLICY_VALUES),
    __metadata("design:type", String)
], UpdateTaskDto.prototype, "completionPolicy", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, public_id_1.IsPublicId)(),
    __metadata("design:type", Object)
], UpdateTaskDto.prototype, "verifiesTaskId", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, public_id_1.IsPublicId)(),
    __metadata("design:type", Object)
], UpdateTaskDto.prototype, "supersededByTaskId", void 0);
__decorate([
    (0, class_validator_1.ValidateIf)((_dto, value) => value !== null),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsIn)(TASK_TERMINAL_REASON_VALUES),
    __metadata("design:type", Object)
], UpdateTaskDto.prototype, "terminalReason", void 0);
__decorate([
    (0, class_validator_1.ValidateIf)((_dto, value) => value !== null),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsIn)(TASK_VERDICT_VALUES),
    __metadata("design:type", Object)
], UpdateTaskDto.prototype, "verdict", void 0);
__decorate([
    (0, class_validator_1.ValidateIf)((_dto, value) => value !== undefined),
    (0, class_validator_1.IsArray)(),
    (0, class_validator_1.ArrayMaxSize)(exports.TASK_LABEL_MAX_COUNT),
    (0, class_validator_1.IsString)({ each: true }),
    (0, class_validator_1.MaxLength)(exports.TASK_LABEL_MAX_LENGTH, { each: true }),
    __metadata("design:type", Array)
], UpdateTaskDto.prototype, "labels", void 0);
class AddDependencyDto {
    // The prerequisite task this task should wait on. Must be owned by the caller, differ
    // from the task itself, and not introduce a dependency cycle.  //
    // Name the SUBJECT, not its verification task. "B waits for A to be verified" is spelled
    // `dependsOn: A`: once anything checks A, §13.3 DEP holds that edge until A's latest check has
    // actually PASSED — a check that finished DONE with a FAIL verdict does not release it, and
    // neither does re-opening the question with a new check. An edge naming the CHECK resolves to
    // the same epoch, so old plans keep working, but it reads as being about one particular run
    // when what the author meant was the work.
    dependsOnTaskId;
}
exports.AddDependencyDto = AddDependencyDto;
__decorate([
    (0, public_id_1.IsPublicId)(),
    __metadata("design:type", String)
], AddDependencyDto.prototype, "dependsOnTaskId", void 0);
class ExpandDependencyGraphDto {
    /** The visible task whose prerequisite or dependent branch should be expanded. */
    anchorTaskId;
    direction;
    /** Every task node currently present in the client snapshot. */
    knownTaskIds;
    /**
     * Direct neighbors whose anchor-side edge is already present. This is deliberately
     * separate from knownTaskIds: a diamond can make a node visible through another
     * branch before this anchor's edge has been loaded.
     */
    loadedNeighborTaskIds;
    limit;
    /** Opaque branch token returned by dependency-graph or the previous expansion. */
    cursor;
}
exports.ExpandDependencyGraphDto = ExpandDependencyGraphDto;
__decorate([
    (0, public_id_1.IsPublicId)(),
    __metadata("design:type", String)
], ExpandDependencyGraphDto.prototype, "anchorTaskId", void 0);
__decorate([
    (0, class_validator_1.IsIn)(['prerequisites', 'dependents']),
    __metadata("design:type", String)
], ExpandDependencyGraphDto.prototype, "direction", void 0);
__decorate([
    (0, class_validator_1.IsArray)(),
    (0, class_validator_1.ArrayMinSize)(1),
    (0, class_validator_1.ArrayMaxSize)(1000),
    (0, public_id_1.IsPublicId)({ each: true }),
    __metadata("design:type", Array)
], ExpandDependencyGraphDto.prototype, "knownTaskIds", void 0);
__decorate([
    (0, class_validator_1.IsArray)(),
    (0, class_validator_1.ArrayMaxSize)(1000),
    (0, public_id_1.IsPublicId)({ each: true }),
    __metadata("design:type", Array)
], ExpandDependencyGraphDto.prototype, "loadedNeighborTaskIds", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsInt)(),
    (0, class_validator_1.Min)(1),
    (0, class_validator_1.Max)(100),
    __metadata("design:type", Number)
], ExpandDependencyGraphDto.prototype, "limit", void 0);
__decorate([
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MinLength)(1),
    __metadata("design:type", String)
], ExpandDependencyGraphDto.prototype, "cursor", void 0);
class RefreshDependencyGraphNodesDto {
    /** Current client snapshot ids; duplicates are collapsed by TasksService. */
    taskIds;
}
exports.RefreshDependencyGraphNodesDto = RefreshDependencyGraphNodesDto;
__decorate([
    (0, class_validator_1.IsArray)(),
    (0, class_validator_1.ArrayMinSize)(1),
    (0, class_validator_1.ArrayMaxSize)(1000),
    (0, public_id_1.IsPublicId)({ each: true }),
    __metadata("design:type", Array)
], RefreshDependencyGraphNodesDto.prototype, "taskIds", void 0);
class BatchExecuteDto {
    // The tasks to run. Tasks without a responsible workspace / bound runner are skipped
    // server-side rather than failing the batch.
    taskIds;
    // When set, caps how many of THIS batch's tasks run at once. It applies only to this
    // batch (the claim queue gates the batch's live sessions on it) and never touches any
    // runner's persistent max_concurrent — independent of the per-runner cap. Rest queue.
    maxConcurrent;
}
exports.BatchExecuteDto = BatchExecuteDto;
__decorate([
    (0, class_validator_1.IsArray)(),
    (0, public_id_1.IsPublicId)({ each: true }),
    __metadata("design:type", Array)
], BatchExecuteDto.prototype, "taskIds", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsInt)(),
    (0, class_validator_1.Min)(1),
    (0, class_validator_1.Max)(64),
    __metadata("design:type", Number)
], BatchExecuteDto.prototype, "maxConcurrent", void 0);
class BatchStopDto {
    // The tasks whose in-flight session (running or queued) should be cancelled. Tasks
    // with no stoppable session are silently no-ops.
    taskIds;
}
exports.BatchStopDto = BatchStopDto;
__decorate([
    (0, class_validator_1.IsArray)(),
    (0, public_id_1.IsPublicId)({ each: true }),
    __metadata("design:type", Array)
], BatchStopDto.prototype, "taskIds", void 0);
class BatchDeleteDto {
    // Hard-delete the caller's matching tasks. Unknown and cross-tenant ids are ignored;
    // duplicates are collapsed by TasksService before reaching PostgreSQL.
    taskIds;
}
exports.BatchDeleteDto = BatchDeleteDto;
__decorate([
    (0, class_validator_1.IsArray)(),
    (0, public_id_1.IsPublicId)({ each: true }),
    __metadata("design:type", Array)
], BatchDeleteDto.prototype, "taskIds", void 0);
class BatchAssignDto {
    taskIds;
    // The workspace to set as responsible for every selected task; null clears the assignment.
    assigneeId;
}
exports.BatchAssignDto = BatchAssignDto;
__decorate([
    (0, class_validator_1.IsArray)(),
    (0, public_id_1.IsPublicId)({ each: true }),
    __metadata("design:type", Array)
], BatchAssignDto.prototype, "taskIds", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, public_id_1.IsPublicId)(),
    __metadata("design:type", Object)
], BatchAssignDto.prototype, "assigneeId", void 0);
class CreateTaskCommentDto {
    body;
    // Workspace ids @-mentioned in the comment. Each owned workspace is notified and triggered
    // on this task; unknown/non-owned ids are silently dropped (see TasksService).
    mentions;
}
exports.CreateTaskCommentDto = CreateTaskCommentDto;
__decorate([
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MinLength)(1),
    __metadata("design:type", String)
], CreateTaskCommentDto.prototype, "body", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsArray)(),
    (0, public_id_1.IsPublicId)({ each: true }),
    __metadata("design:type", Array)
], CreateTaskCommentDto.prototype, "mentions", void 0);
//# sourceMappingURL=dto.js.map