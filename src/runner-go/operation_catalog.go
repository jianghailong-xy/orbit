package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"
)

// The Orbit operation catalog.
//
// One declared operation, one row. Every agent-facing operation this runner serves is described
// here once: the object it acts on, the user intent it answers, its MCP descriptor and CLI
// command, whether it writes, who must answer before it takes effect, whether it destroys, how a
// retry is made safe, what a success receipt has to show, and what to do next. The MCP tools/list
// payload and `orbit capabilities` are projections of this catalogue; the leaf `--help` texts are
// held to it by the tests in operation_catalog_test.go.
//
// Adding an operation means adding one row here: a catalogMetadata entry, the MCP descriptor it
// advertises inside buildOperationCatalog, and — when it has one — its cliCapabilitySpec in the
// family list below. No surface may advertise an operation this file does not declare:
// TestOperationCatalogCoversEverySurface fails on a descriptor or capability with no row, and
// TestEveryCatalogOperationIsAdvertised fails on a row no surface reaches. When an operation is
// deliberately absent from one surface, the row says why (CLIExempt / MCPExempt) instead of
// leaving a gap for the two surfaces to drift into (docs/orbit-agent-contract.md §8.4 G8).
//
// Versioning (docs/orbit-agent-contract.md §9): operationCatalogVersion is bumped when an
// operation is added, removed, or the contract a caller reads changes. CatalogHash is the sha256
// of the canonical catalogue and is emitted with `orbit capabilities --json`, so a client can tell
// which catalogue answered it.

const operationCatalogVersion = "1.4.0"

// operationObject is the Orbit object an operation acts on (docs/orbit-agent-contract.md §1.1),
// plus the auxiliary resources (watch, wiki, file) and the two doors that are not writes at all
// (an owner decision, an engine permission bridge).
type operationObject string

const (
	objectTask          operationObject = "task"
	objectTaskList      operationObject = "task_list"
	objectProject       operationObject = "project"
	objectSession       operationObject = "session"
	objectAgent         operationObject = "agent"
	objectRunner        operationObject = "runner"
	objectProvider      operationObject = "provider"
	objectWatch         operationObject = "watch"
	objectWiki          operationObject = "wiki"
	objectFile          operationObject = "file"
	objectOwner         operationObject = "owner"
	objectAccount       operationObject = "account"
	objectBackgroundJob operationObject = "background_job"
	objectPermission    operationObject = "permission"
	objectMergeReceipt  operationObject = "merge_receipt"
)

// operationRisk classes the consequence of getting the call wrong. low is a read with no side
// effect; medium is an ordinary write a later call can undo; high is a write that spends
// credentials, starts or stops work, destroys something, or needs a person's answer.
type operationRisk string

const (
	riskLow    operationRisk = "low"
	riskMedium operationRisk = "medium"
	riskHigh   operationRisk = "high"
)

// operationApproval is who must answer before the operation takes effect. none is the ordinary
// case; card is a confirmation card the account owner answers in the session's conversation;
// owner is a question only the account owner can answer — or an act only they can perform.
type operationApproval string

const (
	approvalKindNone  operationApproval = "none"
	approvalKindCard  operationApproval = "card"
	approvalKindOwner operationApproval = "owner"
)

// operationIdempotency says how a retry is made safe (docs/orbit-agent-contract.md §5.2).
type operationIdempotency string

const (
	// A read: safe to repeat until it answers.
	idempotencyRead operationIdempotency = "read"
	// The caller supplies a key (idempotencyKey, or clientTurnId on the send calls) and a
	// repeat returns the first result instead of writing twice.
	idempotencyCallerKey operationIdempotency = "caller_key"
	// The server deduplicates a redelivered turn's write on a turn-derived key. A fresh call
	// from a later turn does not deduplicate: re-read before sending it again.
	idempotencyServerKey operationIdempotency = "server_key"
	// A repeat writes again. Re-read to prove the first attempt did not land.
	idempotencyNone operationIdempotency = "none"
)

// operationGate is how a caller's context gates the MCP descriptor.
type operationGate uint8

const (
	gateAlways operationGate = iota
	gateOrchestration
	gatePermissionPrompt
)

// operationPlan is what Plan mode does with an operation (docs/orbit-agent-contract.md §4.1). Plan reads, waits
// and asks the owner; it changes nothing until the plan is approved. Orbit's own Plan gate (plan_gate.go) holds
// every engine to this, on both surfaces, by the session's live permission mode.
type operationPlan string

const (
	// The call reads, waits on Orbit's own work for this session, or puts something in front of the owner.
	planRuns operationPlan = "runs"
	// The call changes Orbit's record of work, or starts, stops, steers or configures work: refused in Plan,
	// with what to do instead.
	planRefused operationPlan = "refused"
	// The operation's own gate decides in every mode, Plan included (catalogPlanOwnGates).
	planOwnGate operationPlan = "own_gate"
)

// operationMCP is the descriptor content a tools/list entry is made of. Extra carries the keys
// beyond name/description/inputSchema a descriptor may declare — the wiki tools' annotations
// (readOnlyHint/destructiveHint) and outputSchema — so a tool that says more about itself keeps
// saying it.
type operationMCP struct {
	Description string
	InputSchema map[string]interface{}
	Extra       map[string]interface{}
}

// operation is one row of the catalogue after the join: the declared metadata plus the surfaces
// it is advertised on.
type operation struct {
	Tool string

	Object operationObject
	Intent string

	Risk        operationRisk
	Mutates     bool
	Approval    operationApproval
	ApprovalKey string
	// Why the card is asked only sometimes, when Approval is a card and the trigger is narrower
	// than the operation itself (project_update asks only for a landing/merge-check change).
	ApprovalDetail string
	Destructive    bool

	Idempotency     operationIdempotency
	Retry           string
	SuccessEvidence string
	NextStep        string
	// Returns is the entity document a success carries, in prose. Every MCP tool but the few with an
	// answer shape of their own also answers with the structured receipt (tool_receipt.go), whose
	// `entity` is this document.
	Returns string
	// Exclusive is the groups of arguments that answer one question, of which a call may send one
	// (tool_schema.go exclusiveViolations): "field" for a top-level argument, "list[].field" for a
	// field of every element of an array argument.
	Exclusive [][]string

	// What Plan mode does with the call, and why when that is not what its Mutates alone says
	// (finishOperationCatalog).
	Plan       operationPlan
	PlanReason string

	Gate operationGate
	MCP  *operationMCP
	CLI  *cliCapabilitySpec
	// The family list the CLI spec was declared in; availability() reads the watch/wiki switch
	// from it. Not part of the JSON surfaces.
	CLIFamily string

	// Why a surface deliberately has no door for this operation. An empty reason means the
	// operation is expected on that surface and a test fails when it is missing.
	CLIExempt string
	MCPExempt string
}

// operationMeta is the hand-written half of a row: what no surface text says by itself. Every
// field with a zero value is filled by a rule in finishOperationCatalog, and the rule is stated
// where it is applied.
type operationMeta struct {
	Object operationObject
	Intent string

	Risk           operationRisk
	Approval       operationApproval
	ApprovalKey    string
	ApprovalDetail string
	Destructive    bool

	Idempotency     operationIdempotency
	Retry           string
	SuccessEvidence string
	NextStep        string
	Returns         string
	Exclusive       [][]string
}

// catalogMCPExemptions records the CLI commands that deliberately have no MCP tool, with the
// reason. Four are the person's own account commands and one acts on a transcript on this
// machine's disk; the rest run a model or move a file where an MCP caller has no equivalent door.
var catalogMCPExemptions = map[string]string{
	"session_import": "imports a Claude Code transcript from this machine's disk as a session: a runner's local work, not a control-plane call",
	"wiki_import":    "imports a file or directory tree from this machine into the wiki: a runner's local read, not a control-plane call",
	"wiki_verify":    "runs a model over a wiki entry on this runner: a runner's work, not a tool call",
	"login":          "signs this machine's account in; a person's own terminal act",
	"logout":         "signs this machine's account out; a person's own terminal act",
	"whoami":         "tells the person who this process acts as; there is no agent-session equivalent",
	"api":            "calls any user REST route with the person's own token; a general escape hatch, not an agent operation",
}

// catalogCLIExemptions records the MCP tools that deliberately have no CLI command, with the
// reason. Most act AS the calling session in a way a terminal outside one cannot; the background
// jobs are calls into the local runner socket; permission_prompt is the engine's own bridge.
var catalogCLIExemptions = map[string]string{
	"permission_prompt":               "runtime approval bridge, called by the engine mid-turn",
	"criterion_confirm":               "confirms as the project's coordinator session: a terminal outside one is refused by the server",
	"criterion_confirmation_withdraw": "withdraws as the project's coordinator session: a terminal outside one is refused by the server",
	"criterion_check_start":           "starts a check as the project's coordinator session: a terminal outside one is refused by the server",
	"criterion_check_report":          "reports the Agent check the calling session is running: a terminal is no such session",
	"bg_run":                          "runner-hosted background jobs: a per-session socket call, not a control-plane API call",
	"bg_output":                       "runner-hosted background jobs: a per-session socket call, not a control-plane API call",
	"bg_kill":                         "runner-hosted background jobs: a per-session socket call, not a control-plane API call",
	"bg_list":                         "runner-hosted background jobs: a per-session socket call, not a control-plane API call",
	"schedule_wakeup":                 "wakes the calling session: there is no session to wake at a terminal outside one",
	"ask_owner":                       "asks as the project's coordinator session: a terminal outside one is refused by the server",
	"request_owner_action":            "files as the calling session and answers it with a turn: a terminal outside one is refused by the server",
	"withdraw_owner_request":          "withdraws as the calling session what it filed: a terminal outside one is refused by the server",
	"open_item_resolve":               "closes an item as the project's coordinator session: a terminal outside one is refused by the server",
	"open_item_hand_over":             "hands an item to the account owner as the project's coordinator session: a terminal outside one is refused by the server",
	"integration_retry":               "reruns a landing as the project's coordinator session: a terminal outside one is refused by the server",
	"integration_abandon":             "abandons a running job as the project's coordinator session: a terminal outside one is refused by the server",
	"integration_observe":             "asks for an observation as the project's coordinator session: a terminal outside one is refused by the server",
}

// catalogMCPOnlyMutations says whether an operation with no CLI command writes. The CLI specs
// carry their own `mutates`, so these are only the MCP-only doors.
var catalogMCPOnlyMutations = map[string]bool{
	"ask_owner":                       true,
	"bg_run":                          true,
	"bg_output":                       false,
	"bg_kill":                         true,
	"bg_list":                         false,
	"criterion_confirm":               true,
	"criterion_confirmation_withdraw": true,
	"criterion_check_start":           true,
	"criterion_check_report":          true,
	"integration_abandon":             true,
	"integration_observe":             true,
	"integration_retry":               true,
	"open_item_hand_over":             true,
	"open_item_resolve":               true,
	"permission_prompt":               false,
	"request_owner_action":            true,
	"schedule_wakeup":                 true,
	"withdraw_owner_request":          true,
}

// catalogCallerKeyOperations take a caller idempotency key (idempotencyKey, or clientTurnId on
// the send calls), so a retry is safe with the same key.
var catalogCallerKeyOperations = map[string]bool{
	"task_evidence_submit": true,
	"task_await":           true,
	"session_await":        true,
	"watch_create":         true,
	"wiki_propose":         true,
	"wiki_draft":           true,
	"session_send":         true,
	"session_reply":        true,
	"session_interrupt":    true,
	"project_send":         true,
}

// What a create's idempotencyKey does, said once for the MCP tools and the CLI flags
// (docs/orbit-agent-contract.md §5.2, gap G5).
const taskCreateIdempotencyKeyDescription = "Your name for THIS create, so a retry is safe: send the same " +
	"key again — after a timeout, a lost answer, or in a later turn — and the server answers with the task " +
	"the first send wrote instead of writing a second one; the same key with a different title or " +
	"description is refused 409. Derive it from the work (a slug of what you are filing), not at random, so " +
	"a retried call carries the same one; it is scoped to this session. Without one a create is " +
	"deduplicated only when the turn that made it is redelivered: re-read before sending it again."

const taskBatchIdempotencyKeyDescription = "Your name for THIS batch, as idempotencyKey is for task_create: " +
	"the same key sent again answers with the tasks the first send wrote, item for item, instead of filing " +
	"the plan twice; the same key with a changed item is refused 409. It names the whole batch — an item " +
	"takes no key of its own."

// catalogPlanRunsWrites are the writes Plan mode runs, with the reason. Every other write is refused in Plan
// (planRefused) and every read runs. What these have in common is that they change no work: each waits on
// Orbit's own work for this session, or puts something in front of the owner, which is what Plan is for.
var catalogPlanRunsWrites = map[string]string{
	"task_await":             "waits on Orbit's own work for this session; a wait changes no work",
	"session_await":          "waits on Orbit's own work for this session; a wait changes no work",
	"watch_create":           "waits on Orbit's own work for this session; a wait changes no work",
	"watch_update":           "changes what this session waits for, and nothing else",
	"watch_cancel":           "stops a wait of this session's own",
	"schedule_wakeup":        "schedules this session's own next turn; it changes no work",
	"notify":                 "puts a line in front of the owner; a message is not work",
	"ask_owner":              "puts a question to the owner; a question is not work",
	"request_owner_action":   "asks the owner for an action that is theirs to take; a question is not work",
	"withdraw_owner_request": "takes back a question this session asked",
}

// catalogPlanOwnGates are the operations whose own gate decides in every mode, Plan included, with the reason.
// Orbit's Plan gate leaves them to it, so the refusal the caller reads is that gate's, which says what to do
// instead.
var catalogPlanOwnGates = map[string]string{
	"bg_run": "the background-job gate (background_gate.go) decides in every mode: Plan refuses the job, with what to do instead",
}

// catalogPlanPreviewArgs names, per MCP tool, the argument that makes a call of it a preview, which writes nothing
// and so runs in Plan like a read. The CLI's previews are its own flags (cliPlanPreview).
var catalogPlanPreviewArgs = map[string]string{
	"task_create_batch": "dryRun",
}

// catalogOpenWorld is the one operation whose effect is not confined to Orbit's own records: a background job runs
// any command on the runner. Every other operation reads or writes Orbit's control plane, the session's own
// directories, or the owner's devices through Orbit, and declares openWorldHint false.
var catalogOpenWorld = map[string]bool{
	"bg_run": true,
}

func buildOperationCatalog() []*operation {
	str := map[string]interface{}{"type": "string"}
	taskIDProp := map[string]interface{}{"type": "string", "description": "Task id; defaults to the current task (ORBIT_TASK_ID) if omitted"}
	promptDesc := map[string]interface{}{"type": "string", "description": "Write this as a self-contained, executable prompt for the task — background, files involved, concrete steps, and acceptance criteria — so an agent with no prior conversation context can pick it up and act on it directly."}
	// FAILED is one of the five values TaskStatus has always had, and the server has always
	// accepted it — it was missing from this enum alone, which made "put a task back the way its
	// run left it" unreachable from any tool while remaining reachable from raw SQL.
	status := map[string]interface{}{
		"type": "string",
		"enum": []string{"OPEN", "IN_PROGRESS", "DONE", "CANCELLED", "FAILED"},
		"description": "FAILED is what a run that died leaves behind; write it to restore that " +
			"outcome, never to express \"I could not finish\" about work nobody ran. Pair it with " +
			"supersededByTaskId in ONE call when a later attempt took over, so the attempt keeps " +
			"how it ended and gains what replaced it.",
	}
	taskUpdateStatus := map[string]interface{}{
		"type": "string",
		"enum": []string{"OPEN", "IN_PROGRESS", "DONE", "CANCELLED", "FAILED"},
		"description": "Direct DONE is refused for every person, coordinator, and execution " +
			"session; satisfy the task's declared EXECUTABLE, VERIFICATION, EVIDENCE_JUDGMENT, or " +
			"OWNER_CONFIRMED criterion instead — an OWNER_CONFIRMED task is confirmed only by the " +
			"account owner in the Orbit app, never by an agent. FAILED remains writable as a run's " +
			"conservative self-report.",
	}
	// A provider is where a run's credential comes from and an engine is the CLI that runs it
	// (docs/provider-engine-contract.md §0); a task pins either, both or neither.
	providerProp := map[string]interface{}{
		"type": []string{"string", "null"},
		"description": "Pin where this task's runs get their credential: an engine's own sign-in on the runner (\"claude\", \"codex\", \"kimi\", \"antigravity\"), \"opencode\" for OpenCode's own configuration, an account pool, or one of the owner's API keys — provider_list shows every slug with the engines it can run. " +
			"Named without `engine`, it also pins the engine that provider runs on by default (a key on its own protocol's CLI), which is what a provider pin always meant; the built-in \"dsh\" is DeepSeek Harness on the owner's first enabled DeepSeek key. " +
			"Omit (or pass null) to start where the assignee's project last started, which is almost always right — only pin one when the task genuinely needs that credential. Changing it makes the next run start a fresh session instead of continuing the previous one.",
	}
	engineProp := map[string]interface{}{
		"type": []string{"string", "null"},
		"enum": nullableEngineEnum(),
		"description": "Pin the CLI this task's runs use: \"claude\" (Claude Code), \"codex\" (Codex), \"kimi\" (Kimi Code), \"antigravity\" (Antigravity CLI), \"opencode\" (OpenCode), \"dsh\" (DeepSeek Harness) or \"cursor\" (Cursor CLI). " +
			"With `provider` the two must be a pair that runs: a provider can run only the engines provider_list names for it, and any other is refused PROVIDER_ENGINE_INCOMPATIBLE. " +
			"Alone it keeps the task's provider pin, which then has to run on it; with no provider pin the run uses that engine's own credential — its sign-in on the runner, OpenCode's own configuration, or for \"dsh\" the owner's first enabled DeepSeek key (refused DEEPSEEK_KEY_REQUIRED without one). " +
			"Omit to leave the engine to the provider pin or, with neither, to where the assignee's project last started; on task_update and task_batch_pin null clears only the engine pin.",
	}
	modelProp := map[string]interface{}{
		"type":        []string{"string", "null"},
		"description": "Run this task on a specific model id within the model space of the engine and provider it runs on (e.g. \"claude-opus-5\"). Omit (or pass null) to use their default. An id they don't offer is caught when the run starts, not here.",
	}
	modelHintProp := map[string]interface{}{
		"type":        []string{"string", "null"},
		"enum":        []interface{}{"S", "M", "L", "XL", nil},
		"description": taskModelHintDescription,
	}
	modelHintReasonProp := map[string]interface{}{
		"type":        []string{"string", "null"},
		"maxLength":   maxTaskModelHintReasonChars,
		"description": "One sentence explaining the modelHint tier, at most 500 characters, preserved verbatim. Omit to preserve it on update; null clears the reason.",
	}
	// Files a new task under a project, on task_create and every task_create_batch item alike.
	// Not nullable, unlike listId: on a create there is nothing to clear, and null would be an id
	// the server rejects rather than a shorthand for "no project".
	projectIDProp := map[string]interface{}{
		"type": "string",
		"description": "File this task under a project you own — what to pass when the work is part of a " +
			"goal you were given (project_get names it). Orthogonal to listId: the project says what the " +
			"work is FOR, the list decides how it is dispatched, so a task may have one of each, either, " +
			"or neither. Omit it when the work belongs to no project; a project that does not exist, or " +
			"belongs to somebody else, is rejected rather than filed nowhere.",
	}
	// The one field on a task write whose only possible user is an AGENT: §4 R1 exempts the account
	// owner from the whole scope contract, so a crossing is never something they have to declare.
	// It is also the field the server names in its own refusal — R7's requiredAction is
	// FILE_IN_OWN_PROJECT_OR_REQUEST_HANDOFF — and until it was declarable from here the second
	// half of that sentence pointed at nothing.
	//
	// Three things the description has to carry, because a tool description is the whole contract a
	// model reads before it writes: it is meaningless without an explicit projectId, it grants
	// nothing, and the answer comes from a person.
	handoffProp := map[string]interface{}{
		"type": "object",
		"properties": map[string]interface{}{
			"reason": map[string]interface{}{
				"type":      "string",
				"maxLength": 1000,
				"description": "Why this work belongs over there, in one sentence. Shown to whoever " +
					"answers the crossing; read by no gate, so it persuades a person and nothing else.",
			},
		},
		"description": "DECLARE that this write crosses into another project. Send it together with " +
			"the projectId it crosses into — a crossing has to name where it is going, and a handoff " +
			"with no destination is refused before the request is made. PRESENCE is the declaration, " +
			"so `{}` declares one as loudly as a reason does; without it a write into another " +
			"project is refused PROJECT_SCOPE_MISMATCH and no amount of retrying changes that, " +
			"because \"I did not realise it was another project\" and \"I am asking to move work " +
			"between two goals\" must not be the same request. It CARRIES NO AUTHORITY: it does not " +
			"grant the crossing, it makes it askable — the server files the question against the " +
			"crossing itself and refuses this write until it is answered. The answer is the ACCOUNT " +
			"OWNER's (or their standing policy when both projects are on AUTO); no agent, and no " +
			"coordinator of either project, can give it. Read the row back with project_crossings, " +
			"and re-send this write once it says APPROVED.",
	}
	// Makes the new task a subtask of one that already exists, on task_create and every
	// task_create_batch item alike. Not nullable for the same reason as projectId: on a create
	// there is no existing link to clear.
	parentTaskIDProp := map[string]interface{}{
		"type": "string",
		"description": "Make this task a subtask of an EXISTING task you own — how to break a piece of " +
			"work into steps that stay attached to it. The parent must be in the SAME project as this " +
			"task, so a subtask of a project's task normally passes both parentTaskId and that same " +
			"projectId; a parent filed under no project needs projectId omitted here too. The project " +
			"is NOT inherited from the parent — a mismatch (or a parent that does not exist, or belongs " +
			"to somebody else) is rejected rather than filed loose. Names a task that already exists: " +
			"to hang an item under another item of this same task_create_batch call, whose id does not " +
			"exist yet, use `parentRef` instead. Either spelling is membership, not ordering — when a " +
			"task RUNS is dependsOnTaskIds/dependsOnRefs, a separate question.",
	}
	// The same filing on the edit door, where it also has to be REMOVABLE. A task filed under the
	// wrong project was frozen there: `task_create` takes `projectId` and `task_update` did not, so
	// work the server had filed by inference — a coordinator's session, not the caller's word — had
	// no agent-facing way back out, and a person had to send the PATCH by hand. Nullable, unlike the
	// create prop above: on a create there is nothing to detach from.
	updateProjectIDProp := map[string]interface{}{
		"type": []string{"string", "null"},
		"description": "Which project this task is filed under. Omit to leave the filing alone, " +
			"send a project id to (re)file it there, send null to take it out of every project (the " +
			"task stays; only the membership goes, and where the work was noticed is still recorded " +
			"beside it). This is how a mis-filing is corrected, including one the " +
			"SERVER made: a task created in a session without a projectId is filed under the " +
			"project that session coordinates. WHO may correct it is not symmetric and the server " +
			"decides: the ACCOUNT OWNER may file work anywhere and may unfile it, while a session " +
			"acting under a project scope is refused UNMAPPED_PROJECT_WORK for null (work under no " +
			"goal is counted by nothing) and PROJECT_SCOPE_MISMATCH for another project unless it " +
			"ASKS for either with `handoff` (null with `handoff` asks for the task to be taken out " +
			"of its project). Asking moves nothing by itself: the server files a " +
			"move request and answers CROSS_PROJECT_APPROVAL_REQUIRED (filed now) or " +
			"APPROVAL_PENDING (one is already waiting for this task and project), and the task " +
			"stays where it is. No tool can answer that request; once the ACCOUNT OWNER confirms " +
			"it, the task moves at once and nothing has to be sent again. Read it with " +
			"project_crossings, and see `handoff` for who may ask and which moves are refused. " +
			"Refused too while this task has subtasks, or verifications pointing at it, that the " +
			"move would leave in another project. A criterion declaration does not travel: a " +
			"requested move withdraws the one the task has in its current project by itself, while " +
			"the owner's own move has to take it back in the same write (criterionKey: null) or " +
			"name a criterion the new project states — a criterion is one project's statement of " +
			"what it wants.",
	}
	// The same declaration on the edit door — and deliberately NOT the same sentence. On a create a
	// declaration asks for permission, and the writer files the work itself once it is APPROVED; on
	// this door it asks for a MOVE, and the account owner's confirmation is the move (2026-10-06). A
	// model told the create door's "re-send this write once it says APPROVED" would wait for a state
	// a move never stops in, so this one says what the request files, who may make it, what it may
	// carry and which moves are refused before anybody is asked.
	updateHandoffProp := map[string]interface{}{
		"type": "object",
		"properties": map[string]interface{}{
			"reason": map[string]interface{}{
				"type":      "string",
				"maxLength": 1000,
				"description": "Why this work belongs over there, in one sentence. Shown to whoever " +
					"answers the crossing; read by no gate.",
			},
		},
		"description": "DECLARE that this write moves the task into another project, which makes it " +
			"a REQUEST for the move. Send it together with the projectId it moves the task into — a " +
			"crossing has to say where it is going — or with projectId null to ask for the task " +
			"to be taken out of every project (only from the project it is in, and with no " +
			"criterionKey: a task in no project serves no criterion). Presence is the declaration and it CARRIES NO AUTHORITY: " +
			"it moves nothing, it asks. The server files a MOVE_TASK request and answers " +
			"CROSS_PROJECT_APPROVAL_REQUIRED (filed now) or APPROVAL_PENDING (a request for this " +
			"task and project is already waiting and comes back as it stands; to change it, the " +
			"owner refuses it and you ask again), naming it by handoffId, and the task stays where " +
			"it is. Only the ACCOUNT OWNER answers it, on the project page — no agent, and no " +
			"coordinator of either project, can. Their confirmation IS the move: the task joins " +
			"the target project (or, for null, leaves its project) at once and nothing has to be sent again; read the request back " +
			"with project_crossings. Who may ask: a session whose own project — the one a " +
			"coordinator coordinates, or the project of the task an execution session runs — is " +
			"the move's source or its target; any other session is refused PROJECT_SCOPE_MISMATCH. " +
			"What it may carry: projectId, handoff and optionally criterionKey, a key of the TARGET " +
			"project's criteria (project_get) that the task declares once it has moved; what it " +
			"declares in its current project is withdrawn by the move, and any other field is " +
			"refused MOVE_TASK_EXTRA_FIELDS — send that in a separate task_update. Which moves are " +
			"refused before anybody is asked: OUT of a settled (DONE or CANCELLED) project, only a " +
			"task that serves none of that project's acceptance criteria may be moved; INTO a " +
			"settled project, nothing may (PROJECT_REOPEN_REQUIRED); and a task whose landing is " +
			"queued or running is refused MOVE_TASK_LANDING_IN_FLIGHT until that job has ended.",
	}
	// The same link on the edit door, where it also has to be removable. A decomposition is
	// usually understood after the tasks exist — a step turns out to belong under a different
	// piece of work, or under none — so re-parenting has to be expressible without deleting and
	// recreating the task, which would lose its comments, its sessions and its edges. Nullable,
	// unlike the create prop above: on a create there is no existing link to clear.
	updateParentTaskIDProp := map[string]interface{}{
		"type": []string{"string", "null"},
		"description": "Make this task a subtask of another task you own, or pass null to detach it " +
			"and leave it standing on its own; omit it to leave the current parent alone. The parent " +
			"must be in the SAME project as this task — re-file one of them first if they differ. " +
			"Refused when it would make a task its own parent, or name one of its own subtasks as its " +
			"parent (that closes a loop). Membership, not ordering: this says what the task is PART OF " +
			"and changes nothing about when it runs — that is dependsOnTaskIds.",
	}
	// Both task write doors have a field of their own for what proves the work is done, so their
	// `description` must stop asking for one: promptDesc above tells the caller to put acceptance
	// criteria inside the prompt, and next to acceptanceCriteria that is an instruction to write the
	// same thing twice — two copies that drift, with nothing saying which one settles the task.
	// Shared by task_create, every task_create_batch item and task_update, because a prompt edited
	// through the update door must not reintroduce the copy the create door just gave up.
	// session_create deliberately keeps promptDesc: it takes no acceptanceCriteria, so for it the
	// prompt really is the only place the criteria can live.
	taskDescriptionProp := map[string]interface{}{
		"type": "string",
		"description": "Write this as a self-contained, executable prompt for the task — background, " +
			"files involved, and concrete steps — so an agent with no prior conversation context can " +
			"pick it up and act on it directly. Say what to DO here; what would PROVE it done belongs " +
			"in `acceptanceCriteria`, not repeated here.",
	}
	// States what would settle this one task, on task_create and every task_create_batch item alike.
	// Capped here at the server's own limit so an over-long value is caught before the round trip.
	acceptanceCriteriaProp := map[string]interface{}{
		"type":      "string",
		"maxLength": maxTaskAcceptanceCriteriaChars,
		"description": fmt.Sprintf("What would settle that THIS task is done: the observable, "+
			"independently verifiable result — a command that passes, a file that exists, a number "+
			"that moved — stated so somebody who did not watch the work can check it. Distinct from "+
			"`description`, which says what work to PERFORM, and from the project's own "+
			"acceptanceCriteria (project_get), which settles the whole goal rather than this one "+
			"step. Coexists with projectId and parentTaskId: a subtask filed under a project still "+
			"states what would settle itself, not what would settle its parent or its project. Up "+
			"to %d characters.", maxTaskAcceptanceCriteriaChars),
	}
	criterionOverrideReasonProp := map[string]interface{}{
		"type":      "string",
		"minLength": 1,
		"maxLength": maxTaskCriterionOverrideReasonChars,
		"description": "Why this task deliberately keeps the declared completionCriterion after " +
			"TASK_CRITERION_SHAPE_ADVICE questioned it. Omit on the first attempt. If the server " +
			"suggests another criterion, either adopt that suggestion or retry with this non-blank " +
			"audit explanation; Orbit stores it on the task and task_get reads it back.",
	}
	// The same field on the EDIT door, where it answers a different question. Creating a task
	// states a criterion for the first time; changing one rewrites what counts as done on work
	// that already exists, which is the cheapest way around a completion decision and used to cost
	// nothing at all. It still succeeds — a mis-declared criterion is ordinary, and one that cannot
	// be corrected is a deadlock — but it now has to say why, and the why is kept.
	criterionChangeReasonProp := map[string]interface{}{
		"type":      "string",
		"minLength": 1,
		"maxLength": maxTaskCriterionOverrideReasonChars,
		"description": "Why this edit CHANGES completionCriterion. Required exactly when the write " +
			"lands on a different criterion than the task already carries — including when you " +
			"never name the criterion and it moves anyway, as sending acceptanceCommand alone " +
			"derives EXECUTABLE. Without it the write is refused as " +
			"TASK_COMPLETION_CRITERION_CHANGE_UNEXPLAINED and nothing is written; blank or " +
			"whitespace is not a reason. Orbit stores it together with the criterion being left " +
			"behind, and task_get returns both as completionCriterionChange. Declaring a criterion " +
			"at creation is unaffected, and so is re-sending the value this task already has.",
	}
	// Why only the account owner can settle an OWNER_CONFIRMED task (ownerConfirmationReasons),
	// and the one sentence that may go with it. On the edit door both are nullable: null takes the
	// reason back together with its sentence.
	ownerConfirmationReasonProp := map[string]interface{}{
		"type":        "string",
		"enum":        ownerConfirmationReasons,
		"description": ownerConfirmationReasonDescription,
	}
	ownerConfirmationReasonNoteProp := map[string]interface{}{
		"type":      "string",
		"minLength": 1,
		"maxLength": maxOwnerConfirmationReasonNoteChars,
		"description": "One optional sentence beside ownerConfirmationReason saying what is at stake " +
			"— which release, which table, whose account. Never sent without ownerConfirmationReason.",
	}
	updateOwnerConfirmationReasonProp := map[string]interface{}{
		"type": []string{"string", "null"},
		"enum": func() []interface{} {
			values := make([]interface{}, 0, len(ownerConfirmationReasons)+1)
			for _, reason := range ownerConfirmationReasons {
				values = append(values, reason)
			}
			return append(values, nil)
		}(),
		"description": ownerConfirmationReasonDescription + " On this edit door it is asked only " +
			"when the write moves the criterion, the project or the criterion the task serves; omit it " +
			"to keep the stored reason, pass null to clear it together with its sentence. A write that " +
			"takes the task off OWNER_CONFIRMED clears both by itself.",
	}
	updateOwnerConfirmationReasonNoteProp := map[string]interface{}{
		"type":      []string{"string", "null"},
		"maxLength": maxOwnerConfirmationReasonNoteChars,
		"description": "Replace the sentence beside ownerConfirmationReason; null clears it. It " +
			"needs a reason to go with, stored or sent.",
	}
	// Which of the PROJECT's stated acceptance criteria a new task serves. Required of a project's
	// one-shot judgment session and of nobody else, so the description says who has to send it
	// rather than marking it required — a person filing work has never had to justify it to a gate.
	criterionKeyProp := map[string]interface{}{
		"type":      "string",
		"maxLength": 64,
		"description": "Which of the PROJECT's stated acceptance criteria this new task serves — " +
			"one of the `key` values project_get returns beside each criterion. A project " +
			"coordinator's one-shot judgment session MUST send it and the server refuses the create " +
			"without it; every other caller may omit it. It is what bounds a coordinator filing " +
			"more work on the fact that the criteria are FINITE and a person wrote them: work that " +
			"serves none of them is work the project was not asked for. A key is the criterion's " +
			"own id: rewriting its text does not change it, and `revision` beside it says which " +
			"wording you read.",
	}
	// The same field on the edit door, where it also has to be removable. Criteria are usually
	// written before the work is understood, so what settles a task is whatever it says at the end,
	// not what it was created with — an agent that discovers the real test has to be able to record
	// it, and one that finds the recorded test was wrong has to be able to take it back. Nullable,
	// unlike the create prop above: on a create there is no existing value to clear.
	updateAcceptanceCriteriaProp := map[string]interface{}{
		"type":      []string{"string", "null"},
		"maxLength": maxTaskAcceptanceCriteriaChars,
		"description": fmt.Sprintf("What would settle that THIS task is done: the observable, "+
			"independently verifiable result — a command that passes, a file that exists, a number "+
			"that moved — stated so somebody who did not watch the work can check it. Whole-field "+
			"replacement, not an append: OMIT it to leave the task's current criteria exactly as they "+
			"are, pass a string to REPLACE them (the empty string records that the task has none "+
			"worth stating), pass null to CLEAR them. Expect to use it after creation — what proves a "+
			"task done is often only knowable once the work is understood. Distinct from "+
			"`description`, which says what work to PERFORM, and from the project's own "+
			"acceptanceCriteria (project_get), which settles the whole goal rather than this one "+
			"step: editing a task's criteria never touches its project's, and copying the project's "+
			"onto a task claims one step settles everything. Up to %d characters.",
			maxTaskAcceptanceCriteriaChars),
	}
	// The same declaration on the edit door, where it also has to be removable and, above all,
	// re-statable. A task's criterion declaration used to be frozen at creation, so a declaration
	// measured against wording that has since moved was marked stale and the remedy that mark
	// names — read the criterion again and declare again — was unreachable from any tool.
	updateCriterionKeyProp := map[string]interface{}{
		"type":      []string{"string", "null"},
		"maxLength": 64,
		"description": "Which of the PROJECT's stated acceptance criteria this task serves — one of " +
			"the `key` values project_get returns beside each criterion. Omit to leave the " +
			"declaration alone, send a key to declare or CORRECT it, send null to take it back (the " +
			"task stays; only the relation goes). Sending a key records the criterion's revision AS " +
			"IT STANDS NOW, so re-sending the same key after that criterion was reworded is how work " +
			"declared against the older wording is brought back up to date — that is what this field " +
			"is for. The key must be one the task's OWN project states; a task in no project cannot " +
			"declare one, and neither refusal is silent. A run writes this for its own task only: " +
			"another task's is refused with CRITERION_KEY_FROM_RUN_REFUSED, since what a task serves " +
			"decides whether the criterion is satisfied.",
	}
	labelsProp := map[string]interface{}{
		"type":        "array",
		"items":       str,
		"maxItems":    maxTaskLabels,
		"description": "Grouping labels for this task, orthogonal to listId: the list decides how the task runs, a label only says which tasks belong together, so a task has one list and any number of labels. Use them for the axis the list cannot express — the batch, dataset, shard or upstream commit a task belongs to — and label facts, not judgements: `CC-MAIN-2017-34` groups reliably because it is copied from the work, `important` does not because the next call spells it differently. Matched exactly, case included. task_list filters on them and task_labels reports each label's progress, so a label nobody will query is just a longer title.",
	}
	obj := func(props map[string]interface{}, required ...string) map[string]interface{} {
		schema := map[string]interface{}{"type": "object", "properties": props}
		if len(required) > 0 {
			schema["required"] = required
		}
		return schema
	}
	// The fields provider_create and provider_update both write.
	providerRuntimeProp := map[string]interface{}{
		"type": "string",
		"enum": providerProtocols,
		"description": "The protocol the endpoint speaks (the field keeps its old name): claude (the default; the " +
			"Anthropic Messages API, e.g. vLLM's /v1/messages), codex (the OpenAI Responses API), kimi (Moonshot's API), " +
			"antigravity (the Gemini API) or cursor (a Cursor User API Key, which needs no baseUrl or models: it goes in " +
			"under the Cursor preset, on Cursor's own API, and its models are Cursor CLI's own on each runner). It decides " +
			"which engines can run the key rather than naming one: the protocol's own CLI and OpenCode, DeepSeek Harness " +
			"too for a DeepSeek key, only Claude Code for a Claude subscription token, and only Cursor CLI for a Cursor " +
			"key (provider_list's `engines`).",
	}
	providerBaseURLProp := map[string]interface{}{
		"type": "string",
		"description": "The endpoint as an engine running on the key will call it, e.g. http://127.0.0.1:8000 — resolved on " +
			"the machine the session runs on. Required on create, but for a Cursor key, which is on Cursor's own API.",
	}
	providerAPIKeyProp := map[string]interface{}{
		"type":        "string",
		"description": "The key the endpoint expects. An endpoint that checks none still needs a non-empty placeholder.",
	}
	providerModelsProp := map[string]interface{}{
		"type":        "array",
		"description": "The models it serves; on update this replaces the whole list. Required on create, but for a Cursor key.",
		"items": obj(map[string]interface{}{
			"value": map[string]interface{}{"type": "string", "description": "The model id the endpoint serves, passed to the engine as its model (e.g. qwen3.8-27b-fp8)."},
			"label": str,
			"contextWindow": map[string]interface{}{
				"type":        "integer",
				"description": "The model's real context window in tokens. Claude Code assumes 200k for a model it does not know, and an endpoint started with less refuses every request past it.",
			},
			"reasoningLevels": map[string]interface{}{
				"type":  "array",
				"items": map[string]interface{}{"type": "string", "enum": []string{"low", "medium", "high", "xhigh", "max"}},
				"description": "Claude Code only: the efforts this model accepts. Every session's effort is moved onto " +
					"the nearest of them — no effort counts as high, what Claude Code sends by default — and [] means the " +
					"model takes no effort at all. Omit it and effort is passed through unchanged.",
			},
		}, "value"),
	}
	projectCriterionTextProp := map[string]interface{}{
		"type":      "string",
		"minLength": 1,
		"maxLength": maxProjectAcceptanceCriteriaChars,
		"description": "One atomic, independently judgeable project outcome. Keep it on one line " +
			"during the legacy compatibility window; inline Markdown is allowed.",
	}
	projectCriterionMethodProp := map[string]interface{}{
		"type":      "string",
		"minLength": 1,
		"maxLength": maxProjectAcceptanceVerificationMethodChars,
		"description": "Required. The concrete procedure and evidence that decides whether this " +
			"assertion holds (for example a command plus expected exit code, a named spec, or a " +
			"human review against identified direct evidence). A code comment is not a method.",
	}
	// A criterion states a condition and how to read it, and stops there. It carried a peer
	// criterion kind, a command, an expected exit code and an evidence Task until migration 0233
	// removed all four: the work now declares WHICH criterion it serves (task.criterionDefinitionId,
	// migration 0232), and sending any of the four back is refused rather than ignored.
	projectCriterionProps := func(allowID bool) map[string]interface{} {
		props := map[string]interface{}{
			"text":                              projectCriterionTextProp,
			"verificationMethod":                projectCriterionMethodProp,
			"completionCriterionOverrideReason": map[string]interface{}{"type": "string", "maxLength": 2000, "description": "Why a caller kept a declaration questioned by the shared N23 advisory."},
		}
		if allowID {
			props["id"] = map[string]interface{}{"type": "string"}
		}
		return props
	}
	projectCriteriaCreateProp := map[string]interface{}{
		"type":     "array",
		"maxItems": maxProjectAcceptanceCriteriaItems,
		"description": "The project's acceptance criteria as explicit assertion + method items. " +
			"This is the runner write shape; both fields are required.",
		"items": obj(projectCriterionProps(false), "text", "verificationMethod"),
	}
	projectCriteriaUpdateProp := map[string]interface{}{
		"type":     "array",
		"maxItems": maxProjectAcceptanceCriteriaItems,
		"description": "Whole structured replacement; text and verificationMethod are required. " +
			"Preserve an item's id from project_get to " +
			"edit or reorder it without replacing its identity; omit id to add a new item. " +
			"[] drops every criterion rather than clearing the set, and a drop is held like any " +
			"edit that does not tighten the ruler — see acceptanceCriteriaHold in the response. " +
			"currentStatus is derived and is not an input. Legacy acceptanceCriteria is not a " +
			"runner write shape.",
		"items": obj(projectCriterionProps(true), "text", "verificationMethod"),
	}
	// How long acceptanceCommand may run. One number, and deliberately only one: it buys
	// wall-clock, it is used exactly as given, and there is no ceiling to negotiate it against and
	// no admission that could refuse it before the command starts.
	acceptanceTimeoutSecondsDescription := "Wall-clock budget for acceptanceCommand, in seconds. " +
		"Omit for the one-hour default, which holds an ordinary test suite — declare a number to " +
		"bound the command more tightly than that, or to buy a suite that needs longer than an hour. " +
		"Applies only to this task's acceptance command; an interactive `!`-shell " +
		"is unaffected. Exceeding it kills the command and reports -1, which derives FAILED like any " +
		"other disagreeing exit code — a budget is not a second chance, so size it above a passing run."
	acceptanceTimeoutSecondsProp := map[string]interface{}{
		"type": "integer", "minimum": 1, "maximum": 86400,
		"description": acceptanceTimeoutSecondsDescription,
	}
	// runAt is the one-time scheduled start the server's once-a-minute sweep keeps
	// (dispatchDueScheduledTasks). Stated once for task_create, every task_create_batch item and
	// task_update, so what a due schedule still has to meet cannot drift between the three doors.
	runAtDescription := "A one-time scheduled start: an ISO 8601 date-time (e.g. \"2026-09-21T12:34:00Z\") at or after which the server starts this task by itself. " +
		"It is not a deadline — dueDate is a date nothing dispatches on, runAt is a trigger. " +
		"Once it is due, the server's scan, which runs once a minute, starts the task for you the way task_start would, whether or not autoRunWhenReady is set: that flag is the separate trigger for prerequisites finishing, and it too holds off until a future runAt arrives. " +
		"The run it starts clears runAt back to null, so a schedule fires once. " +
		"A due schedule still starts only a task that is OPEN, not held (dispatchHold false), with an assignee bound to a runner, every prerequisite satisfied and no session already occupying it; until then it is kept rather than spent, and every later scan tries again. " +
		"A time already past is started by the next scan. " +
		"task_start ignores runAt and starts the task immediately, and that run clears runAt as well."
	runAtProp := map[string]interface{}{"type": "string", "description": runAtDescription}
	// What autoRunWhenReady never does, stated once for task_create, every task_create_batch item and
	// task_update. No automatic starter selects a task in no project that has no prerequisites — the
	// dependency sweep wants an edge, the independent release a project — and "all of its zero
	// prerequisites are DONE" reads as ready to anybody who has not been told (2026-10-16: two such
	// tasks, left on the default true, sat OPEN for 12 minutes and 4 hours until somebody started them).
	autoRunUnfiledNoPrerequisites := "A task in no project that has no prerequisites is never started by this flag, however ready it looks: start it with task_start, or give it a runAt."
	// startNow, on the two create doors (task_start_now.go). Kept apart from autoRunWhenReady, which
	// answers when prerequisites finish: startNow answers "the person wants this run now".
	autoRunIsNotStartNow := "This flag waits for prerequisites; when the person wants the work run now, pass startNow instead."
	startNowProp := map[string]interface{}{
		"type": "boolean",
		"description": "Start this task as soon as it is created. Pass it when the person wants the work run now: " +
			"one approval then covers both the create and the start — the confirmation card reads \"1 starts running " +
			"within the minute\", and once they approve, the task is created and started at once, the way task_start " +
			"starts one — so do not ask them a second time, and do not call task_start after. It writes runAt = now " +
			"into the create, so it cannot be combined with runAt. If that immediate start is refused (a prerequisite " +
			"still open, the assignee's runner offline, its project not started…), the task is still created, the " +
			"result says the start was deferred, and the server's once-a-minute scan starts it as soon as it can. Not " +
			"autoRunWhenReady, which is about prerequisites finishing: startNow is about now.",
	}
	batchStartNowProp := map[string]interface{}{
		"type": "boolean",
		"description": "Start this item as soon as the batch is created. Pass it for the items the person wants run " +
			"now: the item gets runAt = now, so the batch card counts it among those starting within the minute, and " +
			"after the create the server's once-a-minute scan starts it — items are not started one by one. The one " +
			"approval of the batch covers it, so do not ask them again. Cannot be combined with runAt. Not " +
			"autoRunWhenReady, which is about prerequisites finishing.",
	}
	updateRunAtProp := map[string]interface{}{
		"type":        []string{"string", "null"},
		"description": "Omit to leave the schedule as it is, null to cancel it, a date-time to set or move it. " + runAtDescription,
	}
	// SR5's escape hatch (`codeless`), on the three task doors. Stated here once per door so what it
	// costs to declare cannot drift between task_create, the batch items and task_update: nothing at
	// creation, and on an existing task a reason — and never for one that already has commits.
	createCodelessProp := map[string]interface{}{
		"type": "boolean",
		"description": "Declare that this task produces no code — a rollout, a walkthrough, a verification, " +
			"research — even though its project is bound to a codebase. A codeless task resolves no source " +
			"and takes no part in its acceptance criterion's landing: the criterion does not wait for its " +
			"work to reach main, where a task with no commit to land would hold it off LANDED, and the project " +
			"off done. Omit it for work that commits code. No reason is needed here; turning an existing task " +
			"codeless later is task_update with codeless and codelessReason, and is refused for a task that " +
			"already has commits of its own.",
	}
	updateCodelessProp := map[string]interface{}{
		"type": "boolean",
		"description": "true declares that this task produces no code, so it takes no part in its " +
			"acceptance criterion's landing and the criterion stops waiting for its work to reach main. It " +
			"needs codelessReason in the same call (refused TASK_CODELESS_REASON_REQUIRED without it), and " +
			"is refused TASK_CODELESS_HAS_COMMITS for a task that already has commits of its own — a merge " +
			"that moved a target, or a work session that reported changes on its branch: that work has to " +
			"land. false takes the declaration back and needs no reason. Omit to leave it; re-sending the " +
			"value the task already has changes nothing.",
	}
	codelessReasonProp := map[string]interface{}{
		"type":      "string",
		"maxLength": 2000,
		"description": "Why this task produces no code, in a sentence. Required exactly when this call " +
			"turns the task codeless; stored on the task beside the declaration (task_get returns it as " +
			"codelessReason) and cleared when the declaration is taken back. Ignored on any other call.",
	}
	// The verifier to write BESIDE this subject, in the same call. Deliberately not part of
	// taskCreateProps: the batch door pairs its own items with verifiesRef, the server refuses this
	// field on a batch item, and a schema that advertised it there would invite a call that cannot
	// work. Its fields are only what makes the check a check — the link to the subject and the
	// project it lands in are the relation's, and the server fills them in.
	verificationProp := obj(map[string]interface{}{
		"title":       str,
		"description": taskDescriptionProp,
		"assigneeId": map[string]interface{}{
			"type":        []string{"string", "null"},
			"description": "The workspace that runs the check. Must be owned by the caller.",
		},
	}, "title")
	verificationProp["description"] = "Create the verifier that settles this task, in the SAME call. A task declaring " +
		"completionCriterion VERIFICATION with completionPolicy VERIFICATION_PASSED is a subject: it " +
		"has no work of its own to run, and only a PASS recorded by a separate verification task " +
		"pointing at it can settle it. Nothing on the server files that task automatically, so a " +
		"subject written alone is refused (VERIFICATION_SUBJECT_NEEDS_VERIFIER) — name the verifier " +
		"here instead and both rows are written in one transaction, the check pointing at this task. " +
		"On the batch door the pairing is verifiesRef between two items of the call. Give the verifier " +
		"an assigneeId if it should be able to run, since a check with no assignee waits for somebody " +
		"to hand it one."

	forkFromSessionProp := map[string]interface{}{
		"type": "boolean",
		"description": "Start this task from what this session has now: its branch tip, plus the edits it has not " +
			"committed yet. The task still gets its own checkout and branch — it never shares this session's " +
			"directory — and it runs on this machine only, so its assignee must be a workspace on this machine. " +
			"Not allowed for a task in a project with a code binding. Always this session; there is no id to pass.",
	}
	// The fields of one new task, shared by task_create and every task_create_batch item.
	// A fresh map per call so a caller can extend its copy without touching the other's.
	taskCreateProps := func() map[string]interface{} {
		return map[string]interface{}{
			"title":       str,
			"description": taskDescriptionProp,
			"attachmentIds": map[string]interface{}{
				"type":        "array",
				"items":       str,
				"description": "Ids of existing Orbit attachments owned by the caller, such as uploaded files or images from a session. Copies them into this task's inputs in the same transaction as creation; originals are preserved and each run receives its own copies. Pass attachment ids, not local file paths or URLs. Omit when no attachments are needed.",
			},
			"listId":     map[string]interface{}{"type": []string{"string", "null"}},
			"assigneeId": map[string]interface{}{"type": []string{"string", "null"}},
			"projectId":  projectIDProp,
			"fixesOpenItemId": map[string]interface{}{
				"type": "string",
				"description": "Attach this task to an OPEN integration or TASK_FAILED item as its concrete fix. " +
					"The item must be in the same project and assigned to the owner or coordinating session; " +
					"an item may have multiple fixing tasks.",
			},
			"handoff":            handoffProp,
			"parentTaskId":       parentTaskIDProp,
			"acceptanceCriteria": acceptanceCriteriaProp,
			"criterionKey":       criterionKeyProp,
			"codeless":           createCodelessProp,
			"completionCriterion": map[string]interface{}{
				"type":        "string",
				"enum":        []string{"EXECUTABLE", "VERIFICATION", "EVIDENCE_JUDGMENT", "OWNER_CONFIRMED"},
				"description": "The task's one normal completion criterion. EXECUTABLE uses acceptanceCommand plus acceptanceExpectedExitCode; VERIFICATION uses an independent task's verdict with completionPolicy VERIFICATION_PASSED; EVIDENCE_JUDGMENT uses one decision on the task's own submitted evidence, by a session that did not do the work — outside a project, the session that filed the task, which is handed each revision; OWNER_CONFIRMED (completionPolicy MANUAL, no acceptanceCommand, no verifiesTaskId) is settled only by the account owner confirming it in the Orbit app — no agent session can confirm it, a coordinator included, so a run of it finishes the work, says what it did, and ends its turn — and a session declaring it outside an Automatic project names why in ownerConfirmationReason. They are peer choices, not a fallback chain. Runner task creation always requires this explicit field; related command, policy, and verifier fields do not replace it. Two facts about the VERIFICATION shape decide whether that row lives. completionPolicy VERIFICATION_PASSED makes it a pure gate, and a pure gate is NOT dispatchable: a manual execute is refused with 409 and auto-dispatch passes over it, so a row that has work of its own declares MANUAL. And the server never files the verifier for you — the check has to arrive in the SAME call, as `verification` on a single create or `verifiesRef` on a batch item. Without it the row waits on a check nobody is going to file.",
			},
			"completionCriterionOverrideReason": criterionOverrideReasonProp,
			"ownerConfirmationReason":           ownerConfirmationReasonProp,
			"ownerConfirmationReasonNote":       ownerConfirmationReasonNoteProp,
			"acceptanceCommand": map[string]interface{}{
				"type":        "string",
				"minLength":   1,
				"description": "The one EXECUTABLE shell acceptance command. Set it together with acceptanceExpectedExitCode; after the execution turn, the existing task session runs it and the server derives DONE/FAILED from the exit code without an LLM judgement. If one command is not enough, split the task.",
			},
			"acceptanceExpectedExitCode": map[string]interface{}{
				"type": "integer",
				"description": "The exit code that derives DONE for acceptanceCommand. The command runs once and its exit code is compared with this one: equal derives DONE, anything else derives FAILED. " +
					"The comparison is literal and covers every way the command can end: a command killed at its budget, cancelled, signalled, or that failed to start is reported as -1 and derives FAILED too, indistinguishably from a run that returned the wrong code. " +
					"Size acceptanceTimeoutSeconds so a passing suite fits inside it. Set both fields together.",
			},
			"acceptanceTimeoutSeconds": acceptanceTimeoutSecondsProp,
			"dueDate":                  str,
			"runAt":                    runAtProp,
			"engine":                   engineProp,
			"provider":                 providerProp,
			"model":                    modelProp,
			"modelHint":                modelHintProp,
			"modelHintReason":          modelHintReasonProp,
			"dependsOnTaskIds": map[string]interface{}{
				"type":        "array",
				"items":       str,
				"description": "Prerequisite task ids this task waits on (each must be owned by the caller). The task is BLOCKED until every prerequisite is DONE, then runs. Use this instead of writing 'wait for X' preconditions into the description. Cannot form a cycle.",
			},
			"autoRunWhenReady": map[string]interface{}{
				"type":        "boolean",
				"description": "Start this task without a manual start once it is ready (default true): once all its prerequisites are DONE, and — for a task in a project — once the project has started, even with no prerequisites at all. " + autoRunUnfiledNoPrerequisites + " " + autoRunIsNotStartNow + " Needs an assignee bound to a runner. Set false to leave it OPEN for a human/agent to start.",
			},
			"completionPolicy": map[string]interface{}{
				"type":        "string",
				"enum":        []string{"MANUAL", "ALL_CHILDREN_DONE", "VERIFICATION_PASSED"},
				"description": "How this task rolls up subtasks. MANUAL (default) performs no child aggregation; the declared completionCriterion decides DONE. ALL_CHILDREN_DONE derives completion when every direct subtask is DONE or CANCELLED and at least one is DONE — and reopens it if one is later reopened, added or fails, so a parent never claims more than its subtasks support. VERIFICATION_PASSED uses independent PASS verdict evidence. Direct status DONE is never a completion mechanism.",
			},
			"verifiesTaskId": map[string]interface{}{
				"type":        "string",
				"description": "File this task as a VERIFICATION of that task: it exists to check whether the named task actually did what it claims. This is what makes a check a structured relation instead of a naming convention — it is the precondition for task_update's `verdict`, and the only thing `completionPolicy: VERIFICATION_PASSED` counts. The subject must be owned by you, must not be this task, must not itself be a verification, and must be in the SAME project (a check filed across that line is counted by nobody). A verification is expected to run as its OWN session: concluding one from the session that ran the subject is refused.",
			},
			"supersedesTaskId": map[string]interface{}{
				"type": "string",
				"description": "The attempt this new task REPLACES, recorded in the same write that " +
					"creates it. The predecessor keeps the CANCELLED or FAILED it ended with — the " +
					"original outcome is the fact being preserved — and gains a pointer to this task " +
					"plus terminalReason SUPERSEDED, so \"who ended up doing this\" becomes a relation " +
					"a query can follow instead of a sentence in a description. Use this rather than " +
					"creating the replacement and linking it afterwards: the two-call version has a " +
					"window, and an attempt left in that window reads to every downstream gate as an " +
					"ordinary unfinished failure — this deployment re-dispatched one months later. " +
					"Refused if the predecessor is still open, belongs to another owner or another " +
					"project, or has already been replaced (two racing replacements give one winner " +
					"and one error, never a pointer that depends on timing).",
			},
			"labels":          labelsProp,
			"forkFromSession": forkFromSessionProp,
		}
	}
	taskBatchItemProps := func() map[string]interface{} {
		props := taskCreateProps()
		props["startNow"] = batchStartNowProp
		props["ref"] = map[string]interface{}{
			"type":        "string",
			"description": "A short label for this item, unique within the batch, so later items can depend on it via dependsOnRefs. Not stored — it only wires the batch together, and comes back on the created task so you can map it to the real id.",
		}
		props["dependsOnRefs"] = map[string]interface{}{
			"type":        "array",
			"items":       str,
			"description": "Refs of EARLIER items in this same batch that must finish before this one runs. Use this for prerequisites created by this call (their ids don't exist yet) and dependsOnTaskIds for tasks that already exist.",
		}
		props["verifiesRef"] = map[string]interface{}{
			"type":        "string",
			"description": "Ref of an EARLIER item in this same batch that this item VERIFIES — how a phase and the check on that phase land in one atomic call. Use verifiesTaskId instead for a subject that already exists; naming both is rejected. The item it points at must carry the same projectId as this one and must not itself be a verification. This is the pairing that makes a VERIFICATION_PASSED parent expressible: filed as two calls, the window between them is a parent that can never complete. It is also the only thing that files the verifier at all — the server never creates one for you — so a subject declaring completionPolicy VERIFICATION_PASSED that nothing points at in this same call is a pure gate nothing dispatches (a manual execute is refused with 409) and nothing can complete.",
		}
		props["parentRef"] = map[string]interface{}{
			"type":        "string",
			"description": "Ref of an EARLIER item in this same batch that this item is a PART OF — how a plan lands as a tree in one call, since the parent it names is being created by this very batch and has no id yet. Use parentTaskId instead for a parent that already exists; naming both is rejected, because it names two parents. The item it points at must carry the same projectId as this one (the project is never inherited). Membership, not ordering: dependsOnRefs decides when this item may run, parentRef only says what it is part of.",
		}
		return props
	}
	ops := make([]*operation, 0, 128)
	add := func(gate operationGate, descriptors ...map[string]interface{}) {
		for _, descriptor := range descriptors {
			extra := map[string]interface{}{}
			for key, value := range descriptor {
				switch key {
				case "name", "description", "inputSchema":
				default:
					extra[key] = value
				}
			}
			if len(extra) == 0 {
				extra = nil
			}
			ops = append(ops, &operation{
				Tool: descriptor["name"].(string),
				Gate: gate,
				MCP: &operationMCP{
					Description: descriptor["description"].(string),
					InputSchema: descriptor["inputSchema"].(map[string]interface{}),
					Extra:       extra,
				},
			})
		}
	}

	add(gateAlways, []map[string]interface{}{
		{
			"name":        "task_list",
			"description": fmt.Sprintf("List the caller's newest tasks, without their descriptions (task_get returns one task in full). Optionally filter by status, listId, projectId, labels or minPriority. By default it answers one compact row per task — id, title, status, projectId, parentTaskId, assigneeId, listId, labels, priority, updatedAt — held under %d characters, with a first line naming the cursor of the next page; so which project a task belongs to, what it is part of and where it stands in its list's queue are readable without fetching each task. summary=false answers full rows, acceptanceCriteria included.", toolResultBudget),
			"inputSchema": obj(map[string]interface{}{
				"status": status,
				"listId": str,
				"projectId": map[string]interface{}{
					"type": "string",
					"description": "Only tasks filed under this project — the read a project coordinator " +
						"wants, since every other filter here answers across all projects. Use project_get " +
						"for what the project is FOR (goal, acceptanceCriteria, instructions); this returns " +
						"the work filed under it. A project that does not exist, or belongs to somebody " +
						"else, lists as empty, exactly like any other filter matching nothing.",
				},
				"labels": map[string]interface{}{
					"type":        "array",
					"items":       str,
					"description": "Only tasks carrying ALL of these labels. Matched exactly, case included. Use task_labels first when the exact spelling of a label is not already known.",
				},
				"minPriority": map[string]interface{}{
					"type":        "integer",
					"minimum":     taskPriorityMin,
					"maximum":     taskPriorityMax,
					"description": "Only tasks whose priority is at least this. 1 is \"the ones somebody raised\" with task_update's priority, so listId + status OPEN + minPriority 1 is a list's raised queue in one call — where finding them otherwise means paging through the whole list. 0 includes everything nobody touched, and a negative floor reaches the tasks somebody lowered. Omit for no floor.",
				},
				"limit":   map[string]interface{}{"type": "integer", "minimum": 1, "maximum": maxTaskListLimit, "description": fmt.Sprintf("Maximum tasks to return (default %d in summary form, %d with summary=false; server cap %d). A summary page that would pass %d characters comes back smaller, with the cursor that continues it.", defaultTaskSummaryLimit, defaultTaskListLimit, maxTaskListLimit, toolResultBudget)},
				"summary": map[string]interface{}{"type": "boolean", "description": fmt.Sprintf("Default true: one compact row per task (id, title, status, projectId, parentTaskId, assigneeId, listId, labels, priority, updatedAt), the page held under %d characters, and a first line naming the cursor of the next page. false returns full rows, as large as they are.", toolResultBudget)},
				"cursor":  map[string]interface{}{"type": "string", "description": "Continue a listing: the cursor the previous call's first line named, with the same filters."},
			}),
		},
		{
			"name":        "task_labels",
			"description": "Every label in use with its own status breakdown (total/open/inProgress/done/failed/cancelled), newest work included. This is the tool for \"how far along is each batch\" — it answers for all labels in one call, where task_list would have to be run once per label. Optionally scope to one listId. Also the way to discover how labels are actually spelled before filtering on one.",
			"inputSchema": obj(map[string]interface{}{
				"listId": str,
			}),
		},
		{
			"name":        "task_get",
			"description": "Get one task with its comments and linked sessions. To wait for a task to finish, call task_await instead of polling this. The top-level lastProgressAt, progressState and convergenceCounters belong to the project's convergence accounting, not to reported progress: what the task's run reported with task_progress_report is in `progress` (phase, current, total, message, revision, lastProgressAt), the same read task_progress_report gives when called with none of its fields; a task that never reported shows revision 0 with nothing in it. `integration.landTask` says what the platform is doing with the task's newest landing, and its `landingSessionId` addresses the LANDING session that records that attempt — read it with session_get, which serves the landing view by that id (the id is settled when the landing opens, so the link resolves before the job's first claim).",
			"inputSchema": obj(map[string]interface{}{"taskId": taskIDProp}),
		},
		{
			"name":        "task_evidence_list",
			"description": fmt.Sprintf("List the task's explicit structured completion-evidence revisions in stable task-local order, each carrying its decision — a SEND_BACK's note included — once it has been answered. This reads the evidence ledger directly; comments, final replies and Session lifecycle state are not evidence. By default it answers the newest %d revisions in summary form (claim and decision note shortened, checks and gaps counted), under %d characters; revision=<n> answers one revision in full, before=<n> the page before it, and summary=false the whole ledger.", evidenceSummaryPageSize, toolResultBudget),
			"inputSchema": obj(map[string]interface{}{
				"taskId":   taskIDProp,
				"summary":  map[string]interface{}{"type": "boolean", "description": "Default true: the newest page in summary form. false returns every revision in full."},
				"revision": map[string]interface{}{"type": []string{"string", "integer"}, "description": "One revision, in full, as the summary's `revision` names it (a number or its digits)."},
				"before":   map[string]interface{}{"type": []string{"string", "integer"}, "description": "The summary page of revisions older than this one — the value the previous page's first line names (a number or its digits)."},
			}),
		},
		{
			"name":        "task_evidence_submit",
			"description": "Submit the completion-evidence envelope as a first-class immutable fact from the current task Session. The server checks it in three layers: the three fields are required, `gapClauses` is the one optional field, and no other is accepted; every citation is resolved against rows of THIS task under THIS owner and at least one must resolve, or the whole submission is refused; and a declared command must equal the cited tool_call's input.command byte for byte, with a declared success over a failed call refused. The envelope names no standard: Orbit records the one the task is held to (its declared criterion, else its own acceptance criteria) with the revision itself, and an older client's `criterion` is accepted and ignored. The receipt echoes citations[].resolved, so you learn whether your handles held instead of inferring it from the absence of an error, and criterionMatch, the standard Orbit recorded. A retry key and canonical evidence digest replay the same revision; substantively changed evidence appends one. This does not write task.status, change Session state, add a comment or send a notification.",
			"inputSchema": obj(map[string]interface{}{
				"taskId": taskIDProp,
				"evidence": map[string]interface{}{
					"type":        "object",
					"description": "The envelope, three fields: `claim` (what you assert you completed), `checks` (each {kind, ref}, kind one of TOOL_CALL / COMMIT / ARTIFACT / FILE, ref naming a row recorded under this task — a TOOL_CALL may also carry `command` and `succeeded`, which are checked against the cited row; a FILE ref is the id file_upload returned for a file or folder bundle of this task, and one that names none refuses the whole submission; Orbit writes the file's sha256 into the check, so the digest binds those bytes and you leave it out), and `gaps` (what this evidence does NOT establish, each a plain sentence; [] says nothing is missing). Optionally `gapClauses`, parallel to `gaps`: when a gap leaves a clause of the task's standard unproven, add {gap, criterionClause, followUpTaskId?} — gap is its 0-based index in `gaps`, criterionClause names the clause it hits, followUpTaskId the task in this project that will prove it (file it with task_create first; one that is not a task of this project is refused). Evidence with a clause-naming gap and no followUpTaskId cannot be CONFIRMed, only sent back, so mark every gap that hits the standard and name its follow-up. Do not copy command output in: it is part of the evidence digest, where whitespace is significant, and Orbit already stores it on the cited row. Work whose answer is only an exit code belongs to EXECUTABLE acceptance, not here. Object-key order is not significant; array order and string whitespace are.",
				},
				"idempotencyKey": map[string]interface{}{
					"type":        "string",
					"minLength":   1,
					"maxLength":   200,
					"description": "Stable identity reused for every transport retry of this submission.",
				},
			}, "evidence"),
		},
		{
			"name":        "task_evidence_decide",
			"description": "Record THIS session's decision about one version of another task's completion evidence: CONFIRM that the evidence settles the criterion it quotes, or SEND_BACK with a note saying what the next revision has to show. It writes one row and the status that row derives (a CONFIRM of an EVIDENCE_JUDGMENT task's current revision settles it DONE); a SEND_BACK's note is then delivered to the run that submitted the revision as a platform message, so the next attempt knows what to show, and the decision — note included — is readable on the revision in task_evidence_list. Seven things are checked at decision time and each refusal names what to do instead: the revision you answer must still be the task's LATEST (EVIDENCE_JUDGMENT_EVIDENCE_SUPERSEDED — read task_evidence_list again and decide the current one); the criterion the evidence quotes must still be worded the way the project states it today (EVIDENCE_JUDGMENT_CRITERION_MOVED — the standard moved, so ask for evidence against the new one); this session must not have done the work being judged (EVIDENCE_JUDGMENT_REQUIRES_INDEPENDENT_SESSION — a run cannot decide its own evidence, which is what makes a CONFIRM a check rather than a signature on your own homework); a session that acts for one project — its coordinator, a judgment session opened for it, a run of one of its tasks — must not decide a task that is in another project (EVIDENCE_JUDGMENT_TASK_IN_ANOTHER_PROJECT — a task's evidence is decided from the project it is in now, and a task moved out takes its undecided evidence with it, so the project it left can no longer decide it); a run of another task, or a conversation a run opened, must not decide it unless the evidence is addressed to that session, as the subject of the task it verifies or a task in no project it dispatched (EVIDENCE_JUDGMENT_FROM_RUN_REFUSED — a task's evidence is decided by the project's coordinator or a judgment session opened for the project, by the session that dispatched a task in no project, by a run of a task that verifies this one, or by the account owner in the app); a CONFIRM is refused while a gap names a clause of the task's standard in `gapClauses` without a followUpTaskId, or names one that is not a task in the same project (EVIDENCE_JUDGMENT_GAP_WITHOUT_FOLLOW_UP — a gap that hits the standard is accepted only with the task that will prove it: SEND_BACK asking for one; a plain-text gap with no clause does not block a CONFIRM, and SEND_BACK is never blocked by gaps); and SEND_BACK must carry a note. One version is decided once: answering it again says the same thing or is refused as already decided. Outside a project, the session that filed an EVIDENCE_JUDGMENT task is handed each revision its run submits (an <orbit-evidence-review> message naming the taskId and evidenceRevision): deciding it is that session's job, and the account owner is asked only if it has not decided within 30 minutes or has ended.",
			"inputSchema": obj(map[string]interface{}{
				"taskId": taskIDProp,
				"decision": map[string]interface{}{
					"type":        "string",
					"enum":        []string{"CONFIRM", "SEND_BACK"},
					"description": "CONFIRM records that this evidence settles the criterion. SEND_BACK records that it does not; the task stays OPEN and waits for the next revision.",
				},
				"evidenceRevision": map[string]interface{}{
					"type":        "string",
					"description": "The revision being answered, exactly as task_evidence_list returns it. Required and compared against the task's latest, so there is deliberately no way to say 'whatever is current' — an answer has to name the version it read.",
				},
				"note": map[string]interface{}{
					"type":        "string",
					"minLength":   1,
					"maxLength":   4000,
					"description": "Required on SEND_BACK: what the next evidence revision has to show. It is delivered to the run that submitted the revision as a platform message, so it is what the next attempt aims at. Optional on CONFIRM.",
				},
			}, "decision", "evidenceRevision"),
		},
		{
			"name":        "task_attribution",
			"description": "Read one task's attribution boundary — four answers in one read. `owning`: the project this work COUNTS TOWARDS, with its title, Base62 id and status; that column is the only authoritative attribution there is. `discovery`: where the work was NOTICED — the project it was found in, the trigger event, the source task and the source session — carried as evidence and labelled `EVIDENCE_ONLY`, because finding work somewhere grants nothing about where you may file it. `crossing`: the declared cross-project crossing that touches this task, with the stable code and required action a writer meeting it is given. `blocker`: the attribution blocker holding this work up, with its code, its owner and the one sentence that would clear it. Every absent fact is null beside a reason, so \"nothing is holding this up\" and \"this build cannot tell you\" read differently. The acceptance lane this read used to carry — which stated criteria cite the task, and what each was judged to be — went with migration 0229: the criteria are still stated, and nothing judges them. Read it BEFORE writing where you are not certain the work belongs — the alternative is learning it from the refusal, which is after the decision was made.",
			"inputSchema": obj(map[string]interface{}{"taskId": taskIDProp}),
		},
		{
			"name": "project_get",
			"description": "Read one project's durable context: its goal, what would settle that " +
				"the goal was reached (acceptanceCriteria), how the work is to be done " +
				"(instructions), its status, the session and workspace it is coordinated from, and " +
				"how its tasks are distributed (_count and tasksByStatus). This is what a project " +
				"coordinator works FROM — read it before deciding what to file or whether the work " +
				"is finished, because none of it is repeated in a task's description. It also " +
				"carries `blockers`: every structured reason this project did not move, each with " +
				"the one sentence it is asking for (`requiredAction`) — read `blockers.open` when " +
				"the work is stopped and you cannot see why, and end one with " +
				"project_blocker_resolve when you can say what changed. Landing work it reports " +
				"in flight carries `landingSessionId`, and a criterion waiting on a landing says so " +
				"through its landing reason; that id is the LANDING session recording the attempt — " +
				"open it with session_get rather than reading the integration tables yourself. " +
				"Returns the " +
				"shape of the project, not its tasks: use task_list for those. Reads the projects " +
				"of the account this runner belongs to; write these same fields with " +
				"project_create and project_update.",
			"inputSchema": obj(map[string]interface{}{
				"projectId": map[string]interface{}{
					"type":        "string",
					"description": "The project to read, as shown in its web UI URL (/projects/<id>).",
				},
			}, "projectId"),
		},
		{
			"name": "project_integration_get",
			"description": "Read one project's integration line — where its finished work lands and what " +
				"is happening to it right now. Returns the queue (every QUEUED and RUNNING job across " +
				"all three kinds: a task landing, a merge candidate's check, and a merge into main), why " +
				"each waits or where it stopped (blockingReason), every current generation with its " +
				"jobId, generation, state, phase, errorCode, round and the check it is running, each " +
				"task's newest landing through the same read model the task page uses, and each live or " +
				"last-merged candidate's newest check and merge. READ THIS TOOL for the integration line; " +
				"do NOT query the production database directly — these are the same facts, served by the " +
				"interface that is allowed to serve them. Read only. The acting session must belong to " +
				"the project (its coordinator, a session of one of its tasks, or a child of one); another " +
				"project's session is refused, and another account's project answers 404. jobId names " +
				"one attempt and serves what its checks printed under `log` and its timeline under " +
				"`timeline`; claim, round and check narrow either page, cursor continues the log " +
				"page and timelineCursor continues the timeline page. Without jobId the line is " +
				"served as it always was.",
			"inputSchema": obj(map[string]interface{}{
				"projectId": map[string]interface{}{
					"type":        "string",
					"description": "The project to read, as shown in its web UI URL (/projects/<id>).",
				},
				"jobId": map[string]interface{}{
					"type":        "string",
					"description": "Narrow the page to one job, as the queue or a task's landing names it.",
				},
				"claim": map[string]interface{}{
					"type":        "integer",
					"description": "Narrow the page to one claim generation, from 0 (the enqueue).",
				},
				"round": map[string]interface{}{
					"type":        "integer",
					"description": "Narrow the page to one round inside the claim, from 0 (the facts from before its first round).",
				},
				"check": map[string]interface{}{
					"type":        "integer",
					"description": "Narrow the check log to one check's position in the run, from 1.",
				},
				"cursor": map[string]interface{}{
					"type":        "string",
					"description": "Continue the check log page from this cursor.",
				},
				"timelineCursor": map[string]interface{}{
					"type":        "string",
					"description": "Continue the attempt timeline page from this cursor.",
				},
			}, "projectId"),
		},
		{
			"name":        "project_crossings",
			"description": "Read every declared cross-project crossing this project is an end of, in BOTH directions — the ones asking to move work INTO it and the ones asking to move work OUT. Each row names the two ends by title and by id, what the crossing is about, its state (PENDING / APPROVED / DENIED / APPLIED), the crossing key that identifies the MOVE rather than the row, and when it was asked, answered and expires. Read it when a write was refused CROSS_PROJECT_APPROVAL_REQUIRED or APPROVAL_PENDING: that refusal is about a row in this list, and this is how you learn whether the question is still waiting, was refused, or has already been spent. There is deliberately no tool that ANSWERS one — the approver of a cross-project crossing is the account owner, never the target project's coordinator, because one agent accepting work on another goal's behalf is precisely the failure this boundary exists to prevent. Say what is waiting and on whom; do not answer it.",
			"inputSchema": obj(map[string]interface{}{
				"projectId": map[string]interface{}{
					"type":        "string",
					"description": "The project to read, as shown in its web UI URL (/projects/<id>).",
				},
				"state": map[string]interface{}{
					"type":        "string",
					"enum":        []string{"PENDING", "APPROVED", "DENIED", "APPLIED"},
					"description": "Only crossings in that state. Omit for all of them.",
				},
			}, "projectId"),
		},
		{
			"name": "merge_receipt",
			"description": "Record that a session's branch was merged, for a merge Orbit did not " +
				"perform — the `git merge --ff-only` an agent runs in its own worktree, which is how " +
				"branches actually land. Without it the control plane has nothing: merge status blank " +
				"and \"already in main\" false, permanently, because the only code that ever writes " +
				"those is Orbit's own Merge button. The receipt is append-only and names the session, " +
				"its task, its project, and every SHA the claim can be re-checked against. Recording " +
				"the same merge twice is a no-op: the second call returns the first receipt. Give " +
				"FULL 40-character object names — an abbreviated SHA is refused, because it resolves " +
				"against a repository that has since gained objects and can silently come to mean a " +
				"different commit. Result ALREADY_MERGED has a precondition, checked here before " +
				"anything is sent: `sourceSha` must already be in the target — `git merge-base " +
				"--is-ancestor` in the repository this runs in, against `targetShaAfter`, else " +
				"`targetShaBefore`, else `origin/<targetBranch>`. The receipt is refused when it is " +
				"not, and when git cannot tell (fetch first, or run from inside the repository). " +
				"Work that landed by cherry-pick or rebase is a DIFFERENT commit on the target: name " +
				"that commit, never the original branch tip. A receipt for a task's branch also ends " +
				"the account owner's merge card still offering that branch (asking or blocked): after " +
				"you cherry-pick, rebase or squash a task's work onto its line by hand, record it at " +
				"once with that task's work session and sourceBranch = the task's branch, or the owner " +
				"keeps being asked to merge work that is already there. A receipt's sourceSha goes into every " +
				"dependent task's dependency closure, and one the target does not contain keeps them " +
				"refused DEPENDENCY_BASE_NOT_LANDED, because a receipt cannot be taken back. " +
				"`rebaseBaseSha` is the field people skip and the one that decides " +
				"whether the tests that passed were about this tree: omit it only if the source was " +
				"genuinely not rebased. This is not an orchestration power and needs no orchestration " +
				"grant: it records work that already happened, inside your own tenant.",
			"inputSchema": obj(map[string]interface{}{
				"sessionId": map[string]interface{}{
					"type":        "string",
					"description": "The session whose branch was merged; defaults to the current session.",
				},
				"result": map[string]interface{}{
					"type":        "string",
					"enum":        []string{"MERGED", "ALREADY_MERGED", "CONFLICT", "ERROR"},
					"description": "MERGED moved the target. ALREADY_MERGED is a RESULT, not a no-op — it is the answer when the target already contained this work, which is the external fast-forward case and every re-run. CONFLICT names the paths in `conflicts`; ERROR is everything else.",
				},
				"sourceSha":       map[string]interface{}{"type": "string", "description": "The full 40-character tip that was merged. For ALREADY_MERGED, a commit the target contains: after a cherry-pick or rebase, the commit on the target that carries the work, not the original branch tip."},
				"targetBranch":    map[string]interface{}{"type": "string", "description": "The branch it was merged into."},
				"sourceBranch":    map[string]interface{}{"type": "string", "description": "Defaults to the session's own recorded branch."},
				"targetShaBefore": map[string]interface{}{"type": "string", "description": "The target tip before the merge."},
				"targetShaAfter":  map[string]interface{}{"type": "string", "description": "The target tip after it. REQUIRED for result MERGED: a merge that cannot say where the target ended up is a claim, not a receipt."},
				"rebaseBaseSha":   map[string]interface{}{"type": "string", "description": "The base the source was rebased onto before this merge was computed. Omitted means it was not rebased."},
				"conflicts": map[string]interface{}{
					"type": "array", "items": map[string]interface{}{"type": "string"},
					"description": "Paths git reported as conflicting. Only for result CONFLICT.",
				},
				"message": map[string]interface{}{"type": "string", "description": "Git's message, for a conflict or an error."},
			}, "result", "sourceSha", "targetBranch"),
		},
		{
			"name": "merge_receipts",
			"description": "List the merges recorded against a session's branch, newest first: what " +
				"was merged, into what, the target tip before and after, the base the source was " +
				"rebased onto, the result and any conflicting paths. The durable answer to \"did this " +
				"session's work land\", which the session's own merge status cannot give — that column " +
				"is the Merge button's live state and is deliberately cleared when a session resumes.",
			"inputSchema": obj(map[string]interface{}{
				"sessionId": map[string]interface{}{
					"type":        "string",
					"description": "The session to read; defaults to the current session.",
				},
				"limit": map[string]interface{}{"type": "integer", "description": "Maximum receipts to return (default 50, cap 200)."},
			}),
		},
		{
			"name": "project_merge_evidence",
			"description": "Record what a target branch was observed to CONTAIN — the merge half " +
				"of a project's acceptance evidence. Hash the content you actually read (a " +
				"normalized `git grep` result, a blob or tree digest, a rendered diff), never " +
				"`git branch --contains`: after a squash merge that answer is a guaranteed false " +
				"negative while the content is plainly there. Same content as the last " +
				"observation and only the observation time moves; different content writes a new " +
				"row one refGeneration up, which is what makes 'the branch changed and changed " +
				"back' visible to a database that cannot lock a git ref. Different content advances " +
				"the evidence version automatically. Nothing judges the observation: migration 0229 " +
				"removed the project acceptance judgment, so this records what was seen and stops there.",
			"inputSchema": obj(map[string]interface{}{
				"projectId": map[string]interface{}{
					"type":        "string",
					"description": "The project this observation belongs to.",
				},
				"requirementId": map[string]interface{}{
					"type":        "string",
					"description": "What was required, in the words the acceptance criteria use.",
				},
				"targetBranch": map[string]interface{}{
					"type":        "string",
					"description": "Where it had to land, e.g. main or feat/project.",
				},
				"contentHash": map[string]interface{}{
					"type":        "string",
					"description": "sha256 of the observed content, 64 hex characters.",
				},
				"source": map[string]interface{}{
					"type":        "string",
					"description": "Who observed it. Defaults to MERGE_EVIDENCE_WRITER.",
				},
				"detail": map[string]interface{}{
					"type":        "object",
					"description": "The raw observation behind the hash: the command, its output, the blob ids.",
				},
			}, "projectId", "requirementId", "targetBranch", "contentHash"),
		},
		{
			"name": "project_create",
			"description": "Create a project in the account this runner belongs to — the durable " +
				"context a whole body of work is carried out from, as opposed to a task, which is " +
				"one piece of that work. Use it when you are asked to set up or plan out a body of " +
				"work: state what it is trying to achieve (goal), what would settle that the goal " +
				"was reached (acceptanceCriteriaItems), and how the work is to be done (instructions). " +
				"You have the authority to write these fields — record what you were asked for " +
				"rather than waiting for somebody to type it in. You do not have to be asked to " +
				"propose one either, but the bar is high: most work that comes up is one task, and " +
				"a project earns its keep only when a plan you have ALREADY worked out comes to 4 " +
				"or more steps that depend on one another, or the work plainly wants several agents " +
				"on different parts of it over days. Below that, file a task. Above it, say so in a " +
				"sentence or two and say why — a project moves the plan out of this conversation " +
				"and into the task graph, so when this session ends or your context runs out the " +
				"plan is still there and whoever picks it up next does not have to re-derive it. " +
				"This call is how you ask: it puts a confirmation card in front of the user and BLOCKS " +
				"until they answer, and nothing is created if they decline — then a task is the right " +
				"record, and do not ask twice about the same body of work. The " +
				"project starts OPEN and holds no tasks — file them afterwards with task_create / " +
				"task_create_batch passing its projectId, which is what connects the work to what " +
				"it is for. Created from inside a session, the project is bound to THIS session " +
				"as its coordinator, in the same write that creates it, along with the workspace " +
				"this session runs in — so opening the project's coordinator later comes back to " +
				"this conversation rather than starting a fresh one that knows none of it. There " +
				"is nothing to pass and nothing to choose; created outside a session there is no " +
				"such binding. One session coordinates at most one project, so a second project " +
				"recorded from this conversation is not coordinated by it: the server opens the " +
				"new project its own coordinator conversation in the same workspace, and says so " +
				"in the result. Existing " +
				"legacy acceptanceCriteria text remains readable through project_get and writable " +
				"through the old user/JWT API compatibility path. It is not an agent fallback: this " +
				"runner tool refuses it because a criterion is authored one item at a time, each " +
				"with its own assertion text and reader-facing verificationMethod.",
			"inputSchema": obj(map[string]interface{}{
				"title": map[string]interface{}{
					"type":        "string",
					"description": "What this body of work is called.",
				},
				"goal": map[string]interface{}{
					"type":        "string",
					"description": "What this project is trying to achieve, in at most 4,000 characters.",
				},
				"acceptanceCriteriaItems": projectCriteriaCreateProp,
				"instructions": map[string]interface{}{
					"type": "string",
					"description": "How this project's work is to be done: standing guidance that applies across its tasks. Max 10,000 characters. " +
						"How work reaches a branch is not set here: it is the account owner's delivery setting, " +
						"integration.deliveryMode in project_get (PLATFORM until the owner chooses) — AGENT_PUSH: agents " +
						"push their own commits to the upstream; PLATFORM: Orbit lands the work and agents do not push the " +
						"target branch. Read it before you write anything about how work reaches a branch; where these " +
						"instructions and that setting disagree, the setting wins.",
				},
				"workspaceId": map[string]interface{}{
					"type": "string",
					"description": "Open this project's coordinator in THIS workspace, instead of making " +
						"the conversation you are in its coordinator. Naming one opens it: a project " +
						"that names a coordination workspace has a coordinator, and recording the " +
						"workspace alone would make the project read back as a conversation that went " +
						"to Trash. Send it when the project should be coordinated somewhere other than " +
						"here — including when you are already coordinating another project, though " +
						"that case needs nothing from you: the server opens the new project its own " +
						"conversation in this same workspace and tells you it did. Omit it and the " +
						"session you are in becomes the coordinator, which is what you want when you " +
						"just planned this work here. Requires orchestration to be enabled for this " +
						"session, because it names a workspace rather than inheriting one.",
				},
			}, "title"),
		},
		{
			"name": "project_update",
			"description": "Update a project in the account this runner belongs to: rename it, " +
				"revise what it is trying to achieve (goal), what would settle that the goal was " +
				"reached (acceptanceCriteriaItems) or how the work is to be done (instructions), and " +
				"cancel or reopen work. You have authority to write these configuration fields. " +
				"Sending acceptanceCriteriaItems is judged by its direction before it is written: an " +
				"edit that plainly tightens the ruler replaces the criteria in force immediately — " +
				"adding an item, reordering, or stepping an item's verificationMethod up the " +
				"HUMAN → VERIFICATION → EXECUTABLE ladder — and any other edit (dropping an item, " +
				"rewriting an item's text, or rewording verificationMethod any other way) is NOT " +
				"applied: it is held as a proposal for the account owner to decide. [] drops every " +
				"criterion rather than clearing the set, so it is held whenever there is one to drop. " +
				"Which one you got is on the " +
				"response: acceptanceCriteriaHold means held, and the criteria in that same body are " +
				"the ones still in force, so go on being judged against them. The set is " +
				"the standard this project is judged by, so read project_get first and send the " +
				"complete set you mean. " +
				"Existing legacy acceptanceCriteria text remains readable through project_get and " +
				"writable through the old user/JWT API compatibility path. It is not an agent " +
				"fallback: this runner tool refuses it because a criterion is authored one item at " +
				"a time; use acceptanceCriteriaItems with explicit text and verificationMethod on " +
				"every item. A " +
				"project's one-shot JUDGMENT session " +
				"(the one a committed fact opens, not the user-origin conversation) cannot " +
				"write acceptance criteria. Status is not writable from inside a session: a call " +
				"made from a conversation that carries status is refused whole, and nothing that " +
				"call sent is written — where a project stands is a statement about all of it, and " +
				"an agent that could write it could close the project it was given instead of " +
				"finishing it. Report what you found and leave that one to the account owner. " +
				"Only the fields you pass are sent, so " +
				"revising the goal never blanks the instructions: omit a field to leave it " +
				"untouched, pass a string to replace it, pass null to clear it. CANCELLED says the " +
				"goal will not be pursued; OPEN reopens it. Read project_get first when the current context is not " +
				"already known — each prose field is a whole-field replacement, not an append.",
			"inputSchema": obj(map[string]interface{}{
				"projectId": map[string]interface{}{
					"type":        "string",
					"description": "The project to update, as shown in its web UI URL (/projects/<id>).",
				},
				"title": str,
				"goal": map[string]interface{}{
					"type":        []string{"string", "null"},
					"description": "Replace what this project is trying to achieve (max 4,000 characters), or null to leave it with no stated goal.",
				},
				"acceptanceCriteriaItems": projectCriteriaUpdateProp,
				"instructions": map[string]interface{}{
					"type": []string{"string", "null"},
					"description": "Replace how this project's work is to be done (max 10,000 characters), or null to leave it with no standing instructions. " +
						"Before you write anything about how work reaches a branch, read integration.deliveryMode in " +
						"project_get: AGENT_PUSH means agents push their own commits to the upstream, PLATFORM means Orbit " +
						"lands the work and agents do not push the target branch. Where these instructions and that setting " +
						"disagree, the setting wins.",
				},
				"status": map[string]interface{}{
					"type":        "string",
					"enum":        []string{"OPEN", "DONE", "CANCELLED"},
					"description": "OPEN reopens work; CANCELLED abandons it; DONE says the goal was reached. Refused whenever this tool is called from inside a session, which is every call you make: the field is here for the headless owner-operated `orbit project update` path.",
				},
				"integration": map[string]interface{}{
					"type": "object",
					"description": "Where this project's finished tasks land, and what is " +
						"checked before they do, as {line: MAIN | PROJECT_BRANCH, " +
						"projectBranchName, upstreamRef, mergeCheckCommand, " +
						"mergeCheckTimeoutSeconds, landingCheckCommand, landingCheckTimeoutSeconds}. " +
						"Landing settings fall back to the merge settings when null. The two halves are not the same decision. " +
						"THE LINE — line, projectBranchName, upstreamRef — is the account owner's " +
						"to choose, and a request carrying one is refused whenever this tool is " +
						"called from inside a session, which is every call you make: read it back " +
						"from project_get, which carries it as `integration`, and say what you would " +
						"change rather than changing it. THE MERGE CHECK — mergeCheckCommand, " +
						"mergeCheckTimeoutSeconds, landingCheckCommand, landingCheckTimeoutSeconds — " +
						"are yours to propose: this call first puts the " +
						"project, what the check is now and what it would become on a confirmation " +
						"card and BLOCKS until the owner answers, and the change takes effect only " +
						"if they approve it. Nothing is written if they decline, and a second " +
						"change is a second question — an approval covers the exact command and " +
						"timeout it named and nothing else. Send mergeCheckCommand: null to remove " +
						"the check. Once a project has started integrating the line is locked, and " +
						"a request to move it is refused even from the owner: to change it, its " +
						"project branch reaches main first.",
				},
				"nonCode": map[string]interface{}{
					"type": "boolean",
					"description": "Mark this project non-code (true) or clear the mark (false). A project is " +
						"non-code only by this explicit mark, never inferred: set it when the project's goal is " +
						"met by work that changes no code in this repository (a filing, an approval, research). " +
						"A marked project reads no landing — its criteria carry no landingReason, the done check " +
						"reports nothing unlanded, and recording it done stores no landing gaps — while whether " +
						"each criterion is met is unchanged. Only the conversation this project is coordinated " +
						"from may write it; project_get returns it with nonCodeSetBy (OWNER or COORDINATOR), " +
						"nonCodeSetBySessionId, nonCodeSetAt and nonCodeReason.",
				},
				"nonCodeReason": map[string]interface{}{
					"type": "string",
					"description": "Optional, sent only with nonCode: one short sentence (at most 280 characters) " +
						"saying why, e.g. \"All work is documents and vendor accounts; no repository.\" The owner " +
						"sees it under \"Marked by the coordinator\" on the project page and the done card. Each " +
						"nonCode write replaces it; omit it to store none.",
				},
				"expectedConfigRevision": map[string]interface{}{
					"type": "string",
					"description": "The configRevision you read from project_status, as a " +
						"compare-and-swap: the write commits only if the project is still at that " +
						"revision, and is refused with STALE_CONFIG_REVISION otherwise, with " +
						"nothing written. Pass it when you read the project first and are acting " +
						"on what you read — the owner may have changed its coordination settings " +
						"since, and being told beats silently overwriting a decision you did not " +
						"see. Omit it if you did not read one; the write then behaves as it always " +
						"has.",
				},
			}, "projectId"),
		},
		{
			"name": "project_blocker_resolve",
			"description": "End one of a project's open blockers, saying why it no longer blocks. " +
				"The write half of what project_get shows: its `blockers.open` is where the id, the " +
				"kind and the `requiredAction` come from, and this is how one of those rows ends " +
				"when the condition behind it is gone. " +
				"It first puts the blocker and your reason on a confirmation card and BLOCKS until " +
				"the account owner answers — nothing is written if they decline, and a decline is an " +
				"answer (the blocker stays open and the reason they give says what they want " +
				"instead), so do not resolve it another way. Resolve one when you can say what " +
				"changed: the work landed, the question was answered elsewhere, the condition no " +
				"longer holds. Do NOT use it to get past a wait you simply disagree with — a " +
				"HUMAN_DECISION_REQUIRED blocker is the project asking for a judgment that is not " +
				"yours to make, and the card is where you ARGUE for it, not a formality around it. " +
				"The row records resolved_by = COORDINATOR (this agent, with your reason on it) " +
				"rather than USER: the owner authorized the write, and the sentence is yours. " +
				"A resolution is final — an already-resolved blocker is refused rather than " +
				"restated — and a condition that comes back raises a new episode of its own.",
			"inputSchema": obj(map[string]interface{}{
				"projectId": map[string]interface{}{
					"type":        "string",
					"description": "The project the blocker is on, as shown in its web UI URL (/projects/<id>).",
				},
				"blockerId": map[string]interface{}{
					"type":        "string",
					"description": "The blocker to end, spelled as project_get spells it in blockers.open[].id.",
				},
				"reason": map[string]interface{}{
					"type": "string",
					"description": "Why this no longer blocks — what changed, in one or two sentences. " +
						"This is what the owner decides on, and it stays on the row as the " +
						"resolution note afterwards.",
				},
			}, "projectId", "blockerId", "reason"),
		},
		{
			"name": "ask_owner",
			"description": "Put a question to the account owner about the project you coordinate, " +
				"and keep working. The question becomes a card in front of them — the wording you " +
				"give, your options, which one you recommend, what it is holding up — and their " +
				"answer comes back to you later as a message of its own. This call does NOT block: " +
				"it returns the moment the question is filed, so ask and then go do whatever else " +
				"is not waiting on the answer. " +
				"Ask when the decision is genuinely theirs and you would otherwise guess: which of " +
				"two ready tasks goes first when both rewrite the same file, whether work that " +
				"turned out bigger than its task said is still wanted, which way to go at a fork " +
				"the project's own instructions do not settle. Do NOT ask what you can read " +
				"(project_get, task_get, the repository), what the acceptance criteria already " +
				"answer, or for permission to do something you were told to do — a question costs " +
				"a person's attention, and one that answers itself spends it for nothing. " +
				"Give OPTIONS whenever you can name the alternatives: a question with options is " +
				"one tap to answer, and a question without is a paragraph somebody has to write. " +
				"Say which one you recommend and why in its description — you know the work best; " +
				"they are deciding, not designing. " +
				"Only the conversation this project is coordinated FROM may ask, because the " +
				"question is filed in the project's name. For a run question, set forRunQuestion to its request-id, " +
				"give your recommendation, then use session_reply to pass the owner’s answer back to the run.",
			"inputSchema": obj(map[string]interface{}{
				"projectId": map[string]interface{}{
					"type":        "string",
					"description": "The project you coordinate, as shown in its web UI URL (/projects/<id>).",
				},
				"question": map[string]interface{}{
					"type": "string",
					"description": "What you are asking, in the owner's terms rather than the " +
						"codebase's: what has to be decided and why it is theirs. Up to 2000 " +
						"characters, shown on the card exactly as written.",
				},
				"options": map[string]interface{}{
					"type": "array",
					"description": "The alternatives, 2 to 4 of them — or leave it out entirely for " +
						"a question only prose can answer. Each option is { label, description }: " +
						"the label is what the owner taps, the description is the consequence of " +
						"choosing it.",
					"items": obj(map[string]interface{}{
						"label":       map[string]interface{}{"type": "string"},
						"description": map[string]interface{}{"type": "string"},
					}, "label"),
				},
				"recommendedOption": map[string]interface{}{
					"type":        "integer",
					"description": "Index into options of the one you recommend. Say why in that option's description.",
				},
				"blocksTaskIds": map[string]interface{}{
					"type":        "array",
					"items":       map[string]interface{}{"type": "string"},
					"description": "The tasks that are waiting on this answer, so the card shows what it is holding up.",
				},
				"ifUnanswered": map[string]interface{}{
					"type": "string",
					"description": "What happens if nobody answers — \"nothing starts\", \"I will go " +
						"with the first option tomorrow\". Shown on the card as written, so the " +
						"owner can decide how urgent this is.",
				},
				"forRunQuestion": map[string]interface{}{"type": "string", "description": "The request-id of the run question you cannot answer without the owner."},
				"clientQuestionId": map[string]interface{}{
					"type": "string",
					"description": "Your own key for this question. A call retried under the same key " +
						"files one question rather than asking twice; omit it and every call is a " +
						"new question.",
				},
			}, "projectId", "question"),
		},
		{
			"name": "request_owner_action",
			"description": "Use for anything only the account owner can DO or PROVIDE, from any session. " +
				"The request becomes a card in front of them, with a state of its own. This call does NOT " +
				"block: it returns once the request is filed, and the outcome (done, declined with a " +
				"reason, expired or withdrawn) arrives later as a turn in this conversation, so file it " +
				"and go on with whatever is not waiting on it. " +
				"Never ask for a secret in chat, in notify, or in a task comment: prefer kind SECRET for " +
				"any credential (API key, token, password, private key). A SECRET request says what is " +
				"needed and where it goes, never its value; the owner enters the value on the card. " +
				"Kinds: DECISION for a choice only the owner can make (options and recommendedOption); " +
				"SECRET for a credential (secretSpec); MANUAL_STEP for something only a person can do, " +
				"such as a sign-in, a purchase or a change on their own device (steps); CONFIRM for a " +
				"yes or no on something you are about to rely on. options and recommendedOption are " +
				"only for DECISION, steps only for MANUAL_STEP and secretSpec only for SECRET; any other " +
				"mix is refused. " +
				"Do NOT file what you can read or do yourself: a request costs a person's attention.",
			"inputSchema": obj(map[string]interface{}{
				"kind": map[string]interface{}{
					"type":        "string",
					"enum":        []string{"DECISION", "SECRET", "MANUAL_STEP", "CONFIRM"},
					"description": "What you need from the owner. Use SECRET for any credential.",
				},
				"title": map[string]interface{}{
					"type":        "string",
					"description": "The line the owner reads first, and the body of the push notification. Up to 200 characters.",
				},
				"why": map[string]interface{}{
					"type":        "string",
					"description": "What this unblocks and why only the owner can do it. Up to 2000 characters.",
				},
				"blocksTaskIds": map[string]interface{}{
					"type":        "array",
					"items":       map[string]interface{}{"type": "string"},
					"description": "The tasks waiting on this request, so the card shows what it is holding up.",
				},
				"ifUnanswered": map[string]interface{}{
					"type": "string",
					"description": "What happens if nobody answers, shown on the card as written so the " +
						"owner can judge how urgent this is. Up to 500 characters.",
				},
				"steps": map[string]interface{}{
					"type": "array",
					"description": "MANUAL_STEP only, and required there: what the owner has to do, in " +
						"order, up to 20. Each step is { text, command, link }: command is something " +
						"they can copy and run, link a page they open to do the step.",
					"items": obj(map[string]interface{}{
						"text":    map[string]interface{}{"type": "string"},
						"command": map[string]interface{}{"type": "string"},
						"link":    map[string]interface{}{"type": "string"},
					}, "text"),
				},
				"secretSpec": map[string]interface{}{
					"type": "object",
					"description": "SECRET only, and required there: what is needed and where it goes, " +
						"never its value. Name exactly one destination, envVar or filePath. It is delivered " +
						"to the runner this session runs on, and only commands of this session (or of its " +
						"task) can use it; it is removed when the task or session ends, when it expires, or " +
						"when the owner revokes it.",
					"properties": map[string]interface{}{
						"name": map[string]interface{}{"type": "string", "description": "What the owner is asked for, as they would call it."},
						"envVar": map[string]interface{}{"type": "string", "description": "The environment variable it " +
							"becomes, matching ^[A-Z][A-Z0-9_]{0,63}$. Not ORBIT_*, PATH, HOME, LD_*, DYLD_*, BASH_ENV, " +
							"ENV, NODE_OPTIONS or PYTHON*. It is never in your own environment: once the request " +
							"is done, run the command that needs it as `orbit secret exec NAME -- <command>` " +
							"(or that same line with bg_run), and only that command gets it."},
						"filePath": map[string]interface{}{"type": "string", "description": "The file it is written to " +
							"(0600), absolute or ~/..., under the runner user's home and not existing yet; not " +
							"inside Orbit's directory, a workspace, a git repository or a coding engine's own " +
							"directory, and not through a symbolic link."},
					},
					"required": []string{"name"},
				},
				"options": map[string]interface{}{
					"type": "array",
					"description": "DECISION only: the alternatives, up to 4. Each option is { label, " +
						"description }: the label is what the owner taps, the description is the " +
						"consequence of choosing it.",
					"items": obj(map[string]interface{}{
						"label":       map[string]interface{}{"type": "string"},
						"description": map[string]interface{}{"type": "string"},
					}, "label"),
				},
				"recommendedOption": map[string]interface{}{
					"type":        "integer",
					"description": "DECISION only: index into options of the one you recommend.",
				},
				"expiresIn": map[string]interface{}{
					"type": "integer",
					"description": fmt.Sprintf("Seconds from now after which the request expires if still "+
						"unanswered (1 to %d). Leave it out for a request that stays open until it is answered.",
						maxOwnerRequestExpiresIn),
				},
				"clientRequestId": map[string]interface{}{
					"type": "string",
					"description": "Your own key for this request. A call retried under the same key " +
						"returns the request already filed; omit it and every call is a new request.",
				},
			}, "kind", "title", "why"),
		},
		{
			"name": "withdraw_owner_request",
			"description": "Withdraw a request you filed with request_owner_action. A request still waiting " +
				"for the owner is closed as withdrawn. A SECRET request that is done ends the secret's grant: " +
				"it is removed from the runner and `orbit secret exec` stops giving it out. Use it as soon as " +
				"you no longer need a secret, or when a request was filed with a mistake.",
			"inputSchema": obj(map[string]interface{}{
				"requestId": map[string]interface{}{"type": "string", "description": "The id request_owner_action returned."},
				"reason":    map[string]interface{}{"type": "string", "description": "Why, shown to the owner."},
			}, "requestId"),
		},
		{
			"name": "project_request_start",
			"description": "Ask the account owner to start the project you coordinate. Until they " +
				"start it, task_start is refused for its tasks, and this is how the start is put in " +
				"front of them: call it once the plan is written — the criteria stated, the work filed " +
				"as tasks under the project, and EVERY acceptance criterion served by at least one task " +
				"(criterionKey on task_create/task_update). Orbit checks the plan first. If it is not " +
				"ready the call is refused and nothing is filed, with every reason listed at once, each " +
				"with what to do: no criteria or no tasks, a criterion no task serves, a task whose " +
				"assignee is not on a runner, a project branch asked for with no repository to hold it. " +
				"Fix them all and call again. If it is ready, the request is filed and this returns AT " +
				"ONCE — it does not wait for the owner — with the request's itemId and any warnings: " +
				"a criterion served only by work that looks like it produces no code (OWNER_CONFIRMED, or " +
				"EVIDENCE_JUDGMENT with no acceptance command) and does not declare codeless; tasks set " +
				"to start by hand (autoRunWhenReady=false); and Automatic on a project branch with no " +
				"merge check. The warnings are yours: the owner's card does not show them, so act on " +
				"the ones that are right and leave the rest — declare the work that commits nothing " +
				"codeless, and the first goes away. The owner then sees a \"Start this project?\" card " +
				"with your settings as suggestions — Automatic on whatever you send — may change any of " +
				"them, and presses Start; you are told when the project starts. Suggest what you would " +
				"choose and say why in one sentence. Asking " +
				"again replaces the open request, and changing the plan before the start — tasks, " +
				"dependencies or criteria — voids it, so ask again after the plan changes. Only the " +
				"conversation the project is coordinated from may ask, and only before it has started.",
			"inputSchema": obj(map[string]interface{}{
				"projectId": map[string]interface{}{
					"type":        "string",
					"description": "The project you coordinate, as shown in its web UI URL (/projects/<id>).",
				},
				"line": map[string]interface{}{
					"type": "string",
					"enum": []string{"PROJECT_BRANCH", "MAIN"},
					"description": "Where its finished tasks land. PROJECT_BRANCH: on the project's own " +
						"branch first, where tasks that depend on each other are checked together before " +
						"main. MAIN: directly into main, for a single task or an urgent fix — every merge " +
						"into main then asks the owner.",
				},
				"projectBranchName": map[string]interface{}{
					"type": "string",
					"description": "With PROJECT_BRANCH only: the branch as a full ref (refs/heads/…). " +
						"Leave it out for refs/heads/project/<project id>.",
				},
				"upstreamRef": map[string]interface{}{
					"type": "string",
					"description": "The project's main branch, as a full ref (refs/heads/…): the branch its " +
						"tasks start from and its finished work is finally merged into, with either line. " +
						"Leave it out when project_get's integration.lastMainBranch has a value: the account " +
						"owner has already chosen one for this repository. When it is null, run `git " +
						"symbolic-ref --short refs/remotes/origin/HEAD` in your checkout and send the name it " +
						"prints after origin/ as refs/heads/<name> (origin/master becomes refs/heads/master); if " +
						"that fails, leave it out. It is only a suggestion: the owner's card puts their own " +
						"last choice for this repository ahead of it, and nothing is written until they press " +
						"Start.",
				},
				"automatic": map[string]interface{}{
					"type": "boolean",
					"description": "Whether you run the project for the owner: you decide when each task is " +
						"done, handle conflicts and failed checks, and the project branch merges into main " +
						"once its merge check passes (with none, once it rebases cleanly). false brings those " +
						"to the owner; the project runs either way. Leave it out for on. The owner's card " +
						"opens with Automatic on whatever you send; if you would keep it off, say why in why.",
				},
				"maxConcurrentTasks": map[string]interface{}{
					"type":        "integer",
					"minimum":     1,
					"maximum":     maxProjectConcurrentTasks,
					"description": "How many of its tasks may run at once.",
				},
				"mergeCheckCommand": map[string]interface{}{
					"type": "string",
					"description": "The command run on the combined tree before anything lands — on the " +
						"project branch and again before main. Leave it out for none; with Automatic on a " +
						"project branch that is a warning, since the branch would merge into main untested.",
				},
				"landingCheckCommand": map[string]interface{}{
					"type": "string", "description": "The project landing check. Null falls back to the merge check.",
				},
				"landingCheckTimeoutSeconds": map[string]interface{}{
					"type": "integer", "minimum": 1, "description": "Landing check budget in seconds; null falls back to the merge check budget.",
				},
				"mergeCheckTimeoutSeconds": map[string]interface{}{
					"type":    "integer",
					"minimum": 1,
					"description": "That check's budget in seconds — how long it may run on the combined " +
						"tree before the landing is stopped. Leave it out for the one-hour default. A " +
						"suggestion like the command: the owner's card opens with what you send and may " +
						"change it before pressing Start.",
				},
				"why": map[string]interface{}{
					"type": "string",
					"description": "One sentence on why the plan is ready and why these settings, shown " +
						"to the owner on the card as written.",
				},
			}, "projectId", "line", "maxConcurrentTasks", "why"),
		},
		{
			"name": "project_request_done",
			"description": "Ask the account owner to record the project you coordinate done. Orbit " +
				"records a project done by itself when it can prove every criterion — met by its work, " +
				"and that work on main. Call this when it cannot, and you have checked the project is " +
				"done anyway: give your call in a sentence or two (judgment) and one gap for each thing " +
				"Orbit cannot prove — the criterion's key (criterionKey, as project_get gives it), why " +
				"Orbit cannot prove it, what you checked instead, and where that evidence is. Orbit " +
				"checks the project first. If it is not ready the call is refused and nothing is filed, " +
				"with every reason listed at once, each with what to do: a criterion its work has not " +
				"met, a task running, queued or IN_PROGRESS, an item waiting on the owner, a landing or " +
				"a merge into main queued or running. Fix them all and call again. If it is ready, the " +
				"request is filed and this returns AT ONCE — it does not wait for the owner — with the " +
				"request's itemId and a warning for every criterion not landed on main, with why (in " +
				"flight, on the project branch, nothing to land, no receipt, codeless), which the owner " +
				"reads beside your gaps. The owner then sees an \"Is this project done?\" card and " +
				"records the project done on it, and your conversation shows Ready to close. Asking " +
				"again replaces the open request, and the project moving before the owner answers — its " +
				"criteria, a task, a run or a landing — voids it, so ask again once it has settled. Only " +
				"the conversation the project is coordinated from may ask.",
			"inputSchema": obj(map[string]interface{}{
				"projectId": map[string]interface{}{
					"type":        "string",
					"description": "The project you coordinate, as shown in its web UI URL (/projects/<id>).",
				},
				"judgment": map[string]interface{}{
					"type": "string",
					"description": "Your call on whether the project is done, in a sentence or two — the " +
						"first thing the owner reads on the card, as written.",
				},
				"gaps": map[string]interface{}{
					"type": "array",
					"description": "One entry for each thing Orbit cannot prove — [] when it can prove " +
						"everything. Several entries may name one criterion.",
					"items": obj(map[string]interface{}{
						"criterionKey": map[string]interface{}{
							"type":        "string",
							"description": "The criterion it is about: its key, as project_get gives it.",
						},
						"title": map[string]interface{}{
							"type": "string",
							"description": "A few words naming the gap, the card's headline for it — " +
								"e.g. \"Go-live has nothing to land\".",
						},
						"whyNotProven": map[string]interface{}{
							"type":        "string",
							"description": "Why Orbit cannot prove this criterion by itself.",
						},
						"coordinatorChecked": map[string]interface{}{
							"type":        "string",
							"description": "What you checked instead, and what you found.",
						},
						"evidenceRefs": map[string]interface{}{
							"type":  "array",
							"items": map[string]interface{}{"type": "string"},
							"description": "Where that evidence is — task ids, comment links, commits, " +
								"URLs. At least one.",
						},
					}, "criterionKey", "whyNotProven", "coordinatorChecked", "evidenceRefs"),
				},
			}, "projectId", "judgment", "gaps"),
		},
		{
			"name": "criterion_confirm",
			"description": "Confirm that one of this project's acceptance criteria holds, for a " +
				"criterion met by confirmation (satisfiedBy CONFIRMATION in project_get's " +
				"acceptanceCriteriaItems; set it with project_update). Only the conversation " +
				"coordinating this project may call it. The confirmation names the criterion's " +
				"current revision: it stops counting the moment the criterion's text, method or mode " +
				"is revised, and the criterion is unmet again until somebody confirms the new one. " +
				"Pass `revision` (the one you read) so a criterion revised under you is refused " +
				"(409 CRITERION_REVISION_MOVED) rather than confirmed. A criterion met by its tasks " +
				"is refused (409 CRITERION_NOT_CONFIRMATION_MODE). To have an agent decide instead, " +
				"start an Agent check with criterion_check_start.",
			"inputSchema": obj(map[string]interface{}{
				"projectId": map[string]interface{}{
					"type":        "string",
					"description": "The project, as shown in its web UI URL (/projects/<id>).",
				},
				"criterionId": map[string]interface{}{
					"type":        "string",
					"description": "The criterion, as project_get spells it in acceptanceCriteriaItems[].id.",
				},
				"note": map[string]interface{}{
					"type":        "string",
					"description": "Optional: what you checked. Shown beside the confirmation.",
				},
				"attachmentIds": map[string]interface{}{
					"type":        "array",
					"items":       map[string]interface{}{"type": "string"},
					"description": "Optional: uploads (file_upload ids) that back it up.",
				},
				"revision": map[string]interface{}{
					"type":        "integer",
					"description": "Optional: the criterion revision you read; refused if it has moved.",
				},
			}, "projectId", "criterionId"),
		},
		{
			"name": "criterion_confirmation_withdraw",
			"description": "Withdraw the standing confirmation of one of this project's criteria met " +
				"by confirmation, whoever gave it — the owner, this coordinator or an Agent check. " +
				"The criterion is unmet again until somebody confirms it. The confirmation stays on " +
				"record, stamped as withdrawn. Only the conversation coordinating this project may " +
				"call it; a criterion with nothing standing is refused (409 CRITERION_NOTHING_TO_WITHDRAW).",
			"inputSchema": obj(map[string]interface{}{
				"projectId": map[string]interface{}{
					"type":        "string",
					"description": "The project, as shown in its web UI URL (/projects/<id>).",
				},
				"criterionId": map[string]interface{}{
					"type":        "string",
					"description": "The criterion, as project_get spells it in acceptanceCriteriaItems[].id.",
				},
			}, "projectId", "criterionId"),
		},
		{
			"name": "criterion_check_start",
			"description": "Start an Agent check of one of this project's criteria met by " +
				"confirmation: a run, dispatched as a codeless task of this project, that reads the " +
				"criterion and its verification method and reports PASS or FAIL. A PASS confirms the " +
				"criterion's current revision (confirmer AGENT_CHECK); a FAIL is recorded as a failed " +
				"attempt and leaves it unmet. Returns at once with the check's task id; the verdict " +
				"shows in project_get's confirmation. Only the conversation coordinating this project " +
				"may call it.",
			"inputSchema": obj(map[string]interface{}{
				"projectId": map[string]interface{}{
					"type":        "string",
					"description": "The project, as shown in its web UI URL (/projects/<id>).",
				},
				"criterionId": map[string]interface{}{
					"type":        "string",
					"description": "The criterion, as project_get spells it in acceptanceCriteriaItems[].id.",
				},
				"workspaceId": map[string]interface{}{
					"type":        "string",
					"description": "Optional: the workspace whose agent runs the check. Defaults to this project's coordinator workspace.",
				},
				"instructions": map[string]interface{}{
					"type":        "string",
					"description": "Optional: anything the check should know beyond the criterion and its method.",
				},
			}, "projectId", "criterionId"),
		},
		{
			"name": "criterion_check_report",
			"description": "Report the verdict of the Agent check this session is running: PASS when " +
				"the criterion it was started for holds by its verification method, FAIL otherwise — " +
				"including when you could not establish it. Call it once, at the end. Only a session " +
				"started as an Agent check may call it (404 CRITERION_CHECK_NOT_FOUND otherwise).",
			"inputSchema": obj(map[string]interface{}{
				"verdict": map[string]interface{}{
					"type":        "string",
					"enum":        []string{"PASS", "FAIL"},
					"description": "PASS or FAIL.",
				},
				"note": map[string]interface{}{
					"type":        "string",
					"description": "What you checked and what you found. Shown beside the verdict.",
				},
				"attachmentIds": map[string]interface{}{
					"type":        "array",
					"items":       map[string]interface{}{"type": "string"},
					"description": "Optional: uploads (file_upload ids) that back it up.",
				},
			}, "verdict"),
		},
		{
			"name": "open_item_resolve",
			"description": "Close one of this project's exception items that you have handled, and " +
				"say why. Every other ending of an item is a fact the platform reads for itself — a " +
				"task that moved on, a landing that happened, a promotion that was decided — and " +
				"this is the one it cannot: work that landed BY HAND, outside the integration line " +
				"(a branch you replayed onto the target yourself), leaves no row it can read and a " +
				"branch tip that stops being an ancestor of anything, so the item about it goes on " +
				"saying \"this did not land\" and nothing will ever close it. Only the item's " +
				"assignee may close it that way: the conversation the project is coordinated from " +
				"for an item that is yours, and the account owner in the app for anything. A question " +
				"is withdrawn by the conversation that asked it. The reason is required — it is the " +
				"whole of what the record gains, since nobody could verify the ending — and an item " +
				"that has already ended (by a fact or by an earlier press) is refused rather than " +
				"rewritten: an ending is final. An item whose kind has a press of its own, a merge " +
				"card or a paused project, is refused here: it is decided by confirming, declining or " +
				"resuming, and closing it by hand would leave what it is about with no card in front " +
				"of anybody. Closing the last failure item about a task branch's blocked merge " +
				"candidate ends that candidate too, and its card leaves the owner's page; when the " +
				"work went in as other commits, record merge_receipt for the task's branch as well.",
			"inputSchema": obj(map[string]interface{}{
				"projectId": map[string]interface{}{
					"type":        "string",
					"description": "The project the item is filed under, as shown in its web UI URL (/projects/<id>).",
				},
				"itemId": map[string]interface{}{
					"type":        "string",
					"description": "The item, as project_get or the \"open items\" list spells it.",
				},
				"note": map[string]interface{}{
					"type": "string",
					"description": "Why this no longer needs anybody. Up to 2000 characters, and it " +
						"stays on the row as the reason the item was closed by hand.",
				},
			}, "projectId", "itemId", "note"),
		},
		{
			"name": "open_item_hand_over",
			"description": "Hand one of this project's open coordinator items to the account owner, and " +
				"say why. This is a deliberate decision, not the escalation clock: the item becomes OWNER " +
				"/ HANDED_OVER, the explanation and this coordinator session stay on the row, and the owner " +
				"is notified after the compare-and-set commits. Only the conversation coordinating this " +
				"project may call it; an item that is already closed, already the owner's, or has no hand-over " +
				"door in the open-item matrix is refused. Use integration_retry for a retryable task landing or promotion " +
				"check, and ask_owner when the owner must choose; use this door when the coordinator cannot " +
				"settle the item and needs to hand it over. It does not rerun or close the item. The note is " +
				"required and is limited to 2000 characters.",
			"inputSchema": obj(map[string]interface{}{
				"projectId": map[string]interface{}{
					"type":        "string",
					"description": "The project you coordinate, as shown in its web UI URL (/projects/<id>).",
				},
				"itemId": map[string]interface{}{
					"type":        "string",
					"description": "The open item to hand to the owner, as project_get or the open-items list spells it.",
				},
				"note": map[string]interface{}{
					"type":        "string",
					"description": "Why the coordinator cannot settle it. Required, up to 2000 characters, and kept on the item.",
				},
			}, "projectId", "itemId", "note"),
		},
		{
			"name": "integration_retry",
			"description": "Run one of your project's failed integrations again. With taskId: a task " +
				"that is DONE whose newest landing onto the project's integration line ended CHECK_FAILED " +
				"(a check on the combined tree disagreed, or ran out of time — CHECK_TIMED_OUT) or ERROR " +
				"(the integration machinery stopped). With promotionId instead: a blocked merge of the " +
				"project branch into main — the item that names no task — whose check or landing ended " +
				"the same way; what is rerun is the candidate's check, and a check that passes leaves the " +
				"merge exactly as it was authorized: the account owner's card, or the Automatic setting. " +
				"This is the only way either is attempted again: the platform never reruns one by itself, " +
				"and task_start runs the task again on a new branch without ever queueing another landing " +
				"of the work it finished. It is a decision, not a reflex — read the item first, and rerun " +
				"only when you can say why this run will come out differently (the merge check's baseline " +
				"was repaired, the check timed out, the machinery failed). A red that belongs to the " +
				"delivery is sent back (task_reopen) or replaced instead, and a CONFLICT is refused here: " +
				"only a branch that changed answers one. A conflict at MAIN_SYNC (absorbing the upstream " +
				"into the project branch) is the project line's, not the delivery's: absorb the upstream on " +
				"the project line first, by having the task's run put a merge commit of the project branch " +
				"tip and the upstream tip, conflicts resolved, into its source branch and do nothing else " +
				"(task_reopen) — with both tips in it, its next landing lands by MERGE. Queues exactly " +
				"one new job, which carries your reason and the failure class it reruns, and answers with " +
				"`landingSessionId` — the LANDING session that records the new attempt, readable with " +
				"session_get; your open items " +
				"about the failure stay open and " +
				"read as being handled until that job reports — if it lands or passes they are marked " +
				"handled in your name with your reason, and if it fails again they are marked superseded " +
				"by the new item its failure opens. If the coordinator cannot settle the item, use " +
				"open_item_hand_over with an explanation; if changing a merge-check command, time limit or " +
				"another owner-only choice is required, use ask_owner with options. This tool never hands " +
				"an item to the owner and never answers that choice. Refused with the reason when the task's landing or the " +
				"candidate is already queued or running (a task's landing whose runner stopped reporting " +
				"past its limit is the exception: it is ended as ERROR first — RUNNER_LOST, or " +
				"PUSH_OUTCOME_UNKNOWN for a landing whose legacy claim cannot prove nothing was pushed — " +
				"and run again), when " +
				"the failure's item is the account owner's " +
				"(escalated, or a project that is not Automatic), when the owner has an open blocker on " +
				"the task, or when the task or candidate is not this project's. Only the conversation the " +
				"project is coordinated from may call it.",
			"inputSchema": obj(map[string]interface{}{
				"projectId": map[string]interface{}{
					"type":        "string",
					"description": "The project you coordinate, as shown in its web UI URL (/projects/<id>).",
				},
				"taskId": map[string]interface{}{
					"type":        "string",
					"description": "The DONE task whose failed landing to run again. Give this or promotionId, not both.",
				},
				"promotionId": map[string]interface{}{
					"type": "string",
					"description": "The blocked candidate — the merge of the project branch into main — whose " +
						"check to run again, as its item names it. Give this or taskId, not both.",
				},
				"reason": map[string]interface{}{
					"type": "string",
					"description": "Why this run will come out differently — what changed since the failed " +
						"one. Up to 2000 characters; it stays on the new job and on every item it handles.",
				},
			}, "projectId", "reason"),
		},
		{
			"name": "integration_abandon",
			"description": "End a running integration job whose runner has stopped reporting, as the " +
				"conversation that coordinates this project. This is the door for a job no result will " +
				"ever reach: a runner that crashed, was fenced, or belongs to a disabled account never " +
				"takes its claim over, and the job holds its repository-and-branch slot for ever. The " +
				"server's gate is the claim's lease: it must have expired (ten minutes without a report, " +
				"or — for a legacy claim in a check — the check's budget plus the lease), and the job must " +
				"still be RUNNING; no item ownership, Automatic switch or owner blocker is consulted. The " +
				"job ends as ERROR, and the record says whether it is known that nothing was pushed " +
				"(RUNNER_LOST: a merge-check job, which never pushes, or a landing whose current claim " +
				"is v2 and recorded no PUSH) or that it may have been pushed (PUSH_OUTCOME_UNKNOWN: every " +
				"legacy landing claim). Nothing is queued in its place, and the project branch or main " +
				"is left exactly as it was; a candidate the job was merging is blocked. An abandoned " +
				"generation opens the same INTEGRATION_ERROR item a runner-reported error would — it is " +
				"the item through which you reach integration_retry — except when it had already been " +
				"asked to stop (cancel_requested_at set): a stopped generation opens no card, because " +
				"stop and abandon both mean it is not wanted. Refused when the job is not running (INTEGRATION_ABANDON_NOT_RUNNING), " +
				"when its runner is still reporting (INTEGRATION_ABANDON_LEASE_LIVE), and for a job or " +
				"project of another account; only the project's current coordinator conversation may call " +
				"it.",
			"inputSchema": obj(map[string]interface{}{
				"projectId": map[string]interface{}{
					"type":        "string",
					"description": "The project you coordinate, as shown in its web UI URL (/projects/<id>).",
				},
				"jobId": map[string]interface{}{
					"type":        "string",
					"description": "The running job to abandon, as the integration view or the job list names it.",
				},
				"reason": map[string]interface{}{
					"type": "string",
					"description": "Why this job's runner is not coming back. Required, up to 2000 " +
						"characters, and kept on the job as the record of why the work was given up.",
				},
			}, "projectId", "jobId", "reason"),
		},
		{
			"name":        "integration_request_promotion",
			"description": "Request a promotion of this project's integration branch into main before all criteria are satisfied. Only the project's current coordinator conversation may ask. Give a nonblank reason of at most 2000 characters. The request remains pending until one candidate consumes it in the candidate's transaction. The landing queue must still be empty and the tip uncovered. Normal promotion checks and owner or Automatic authorization still apply; this request does not authorize a merge.",
			"inputSchema": obj(map[string]interface{}{
				"projectId": map[string]interface{}{"type": "string", "description": "project whose integration branch should be promoted"},
				"reason":    map[string]interface{}{"type": "string", "description": "why this promotion is needed now; 1 to 2000 characters after trimming"},
			}, "projectId", "reason"),
		},
		{
			"name": "integration_observe",
			"description": "Ask Orbit to look again, now, at whether your project's finished work is on its " +
				"line, as the conversation that coordinates the project. Orbit records a task's work as " +
				"landed when it sees the commit the task delivered there — an observation fetches and reads, " +
				"and never merges, pushes or runs a check. It looks by itself after the facts that may move " +
				"the line (a work session's turn, a recorded receipt); this is the door to look again when " +
				"something else changed: an agent pushed after its task finished, a later task carried the " +
				"work there, or a runner that could not fetch the repository can again. It queues one " +
				"observation of the project, or joins the one already queued (the answer says queued: " +
				"false), and every task waiting to be seen is looked at when a runner takes it. Your open " +
				"\"Not on <branch> yet\" items (LANDING_UNOBSERVED) about those tasks read as being handled " +
				"until it reports: when it sees a task's commit, the landing is recorded, the item closes as " +
				"landed and the tasks waiting on it start; when it does not, the item stays open as it was — " +
				"then name the commit on the line that carries the work with merge_receipt, or send the task " +
				"back with task_reopen. An observation that succeeds also closes the item about the " +
				"project's failing observations. It needs a runner that declares integration-observe/v1 with " +
				"a checkout of the repository, and waits queued until there is one. Refused for a project " +
				"with no repository bound, and unless you are the project's current coordinator conversation.",
			"inputSchema": obj(map[string]interface{}{
				"projectId": map[string]interface{}{
					"type":        "string",
					"description": "The project you coordinate, as shown in its web UI URL (/projects/<id>).",
				},
				"reason": map[string]interface{}{
					"type": "string",
					"description": "Why the work may be on the line now — what changed since Orbit last " +
						"looked. Required, up to 2000 characters, and kept on the items the observation handles.",
				},
			}, "projectId", "reason"),
		},
		{
			"name": "integration_skip_merge_check",
			"description": "Queue ONE landing of a DONE task again with the project's merge check NOT " +
				"RUN — skipped, never passed — and only with the account owner's yes on a confirmation " +
				"card. Use it when the check is what is red rather than the delivery: a command that " +
				"cannot pass where the runner runs it (a shell without GNU timeout or bash 4, a missing " +
				"tool, a baseline the machine does not have). Every other door is wrong for that red: " +
				"integration_retry runs the same command against the same machine and is red again by " +
				"construction, task_reopen sends back work that is not at fault, and the check COMMAND " +
				"is the account owner's to change (project_update can PROPOSE one; they decide on its " +
				"card) — which is the decision this card puts in front of them for this one landing " +
				"instead. What it does: reads the project, the task and the failed landing first, raises " +
				"the card (the project, the task, the check command verbatim, what stopped, and your " +
				"reason), and queues exactly one LAND_TASK generation only if they answer yes; a decline " +
				"queues nothing and the landing stands as it failed. ONCE: the project's mergeCheckCommand " +
				"setting is untouched, the next landing and every merge into main are checked as before, " +
				"and the generation this queues records the check it skipped, your reason and the card " +
				"the owner approved it on — as does any item that landing goes on to open. Refused for " +
				"anything but a landing that stopped on a check (CHECK_FAILED, including a check that ran " +
				"out of its budget): a CONFLICT is the branch's, an ERROR is the machinery's (use " +
				"integration_retry), and a landing already in flight refuses — and the same three " +
				"refusals integration_retry has apply (a failure whose item is the account owner's, a " +
				"project that is not Automatic, a task of another project). Only the conversation the " +
				"project is coordinated from may call it.",
			"inputSchema": obj(map[string]interface{}{
				"projectId": map[string]interface{}{
					"type":        "string",
					"description": "The project you coordinate, as shown in its web UI URL (/projects/<id>).",
				},
				"taskId": map[string]interface{}{
					"type": "string",
					"description": "The DONE task whose failed landing should go on without the project's " +
						"merge check. Its newest landing must have ended CHECK_FAILED.",
				},
				"reason": map[string]interface{}{
					"type": "string",
					"description": "Why this check should not hold up this landing — what makes it red " +
						"about the check rather than the work. Up to 2000 characters; the owner decides " +
						"on it, and it stays on the generation and on every record of it.",
				},
			}, "projectId", "taskId", "reason"),
		},
		{
			"name": "project_delete",
			"description": "Permanently delete an empty project in the account this runner belongs " +
				"to. This cannot be undone. A project that still holds tasks is refused atomically: " +
				"none of those tasks is deleted or detached, because the project records what each " +
				"task is for. Move them to another project or delete them first.",
			"inputSchema": obj(map[string]interface{}{
				"projectId": map[string]interface{}{
					"type":        "string",
					"description": "The empty project to permanently delete, as shown in its web UI URL (/projects/<id>).",
				},
			}, "projectId"),
		},
		{
			"name":        "task_dependency_graph",
			"description": "Read the multi-level upstream dependency DAG for a task before changing its ordering. Returns the focus task, its transitive prerequisites, and directed prerequisite-to-dependent edges; taskId defaults to the current task. The server bounds traversal and reports when the result is truncated.",
			"inputSchema": obj(map[string]interface{}{
				"taskId":   taskIDProp,
				"maxDepth": map[string]interface{}{"type": "integer", "minimum": 1, "maximum": 32, "description": "Maximum prerequisite levels to traverse (default 8, server cap 32)."},
				"maxNodes": map[string]interface{}{"type": "integer", "minimum": 1, "maximum": 500, "description": "Maximum task nodes to return (default 100, server cap 500)."},
			}),
		},
		{
			"name":        "task_dependency_add",
			"description": "Add one dependency edge: taskId waits for dependsOnTaskId. The server rejects cross-owner tasks, self-dependencies, duplicate edges, and cycles. Prefer this granular edit after reading task_dependency_graph when preserving every other edge. Point the edge at the SUBJECT, not at its verification task: waiting until A is verified is dependsOnTaskId=A, and once anything checks A the server holds that edge until A's latest check has actually PASSED — a check that finished DONE with a FAIL verdict does not release it, and filing a new check closes the question again. An edge naming the check resolves to the same gate, so older plans keep working; it just reads as being about one run. A verifier's own edges are its own run's: another run is refused with VERIFIER_WRITE_FROM_RUN_REFUSED.",
			"inputSchema": obj(map[string]interface{}{
				"taskId": taskIDProp,
				"dependsOnTaskId": map[string]interface{}{
					"type":        "string",
					"description": "Prerequisite task id that must finish before taskId can run.",
				},
			}, "dependsOnTaskId"),
		},
		{
			"name":        "task_dependency_remove",
			"description": "Idempotently remove one dependency edge from taskId to dependsOnTaskId, leaving every other edge unchanged; an already-absent edge is a no-op. Read task_dependency_graph first when the surrounding DAG is not already known. A verifier's own edges are its own run's: another run is refused with VERIFIER_WRITE_FROM_RUN_REFUSED.",
			"inputSchema": obj(map[string]interface{}{
				"taskId": taskIDProp,
				"dependsOnTaskId": map[string]interface{}{
					"type":        "string",
					"description": "Prerequisite task id whose edge should be removed from taskId.",
				},
			}, "dependsOnTaskId"),
		},
		{
			"name":        "task_create",
			"description": "Create ONE task (attributed to this agent). Newly discovered work belongs here by default — see project_create for the narrow case (a plan already worked out that comes to 4+ dependent steps, or work that plainly wants several agents over days) worth proposing a project for instead. Proposing one does not block this call: if the answer is no, or you did not ask, a task is the right record. Creating several related tasks after that decision? Use task_create_batch instead — it writes them, and the dependency edges between them, in a single atomic call. When the person wants the work run now, pass `startNow: true`: one approval then covers the create and the start, so do not ask them a second time and do not call task_start after. Without it this only records the task; call task_start when it should run, or pass runAt to have the server start it at a set time. It first puts a confirmation card in front of the user and BLOCKS until they answer: nothing is written if they decline, so do not create it another way. Always write `description` as a self-contained, executable prompt an agent can act on without prior context (background, files involved, steps). assigneeId defaults to this agent when omitted (pass null to leave it unassigned). assigneeId/listId/projectId/parentTaskId must be owned by the caller; dueDate is an ISO date string. Pass `projectId` to file the task under a project — orthogonal to listId, which decides dispatch policy, where the project states what the work is for. Pass `parentTaskId` to make it a subtask of an existing task, which must be in the same project as this one — a subtask of a project's task normally passes both, since the project is not inherited from the parent. Ask what would settle THIS task before you write it, and pass the answer as `acceptanceCriteria` — the observable result a reader who did not watch the work can verify, as opposed to `description`, which says what work to perform. If the person you are working with has not told you, do NOT call this tool yet: ask them in the conversation — offer what you would propose, if that helps them answer — and end your turn with the question. The criteria are theirs to state, and the confirmation card this call raises is not where they become theirs: it is a yes/no on a task whose criteria were already agreed by the time it appears. Filing criteria you wrote alone is the one way this goes wrong, because every later reader takes them for the person's own standard. Where a single command decides it — a test suite, a build, a lint — pass `acceptanceCommand` with `acceptanceExpectedExitCode` as well: the task's own session runs it, and the server derives DONE or FAILED from the exit code, so the task settles itself and no person is asked to read anything. That is what the question buys. A task filed with neither leaves the session that did the work no legal way to finish it, and the attempt ends at ATTEMPT_ENDED_WITHOUT_JUDGMENT_PATH — a human is handed the evidence to judge by hand, which is the outcome this field exists to make unnecessary. When the person genuinely cannot say yet what would prove the work done, file the task without one and record the criteria with task_update once the work says what they are — an unproven task is an ordinary task — but never write criteria they did not state. Always declare completionCriterion explicitly; EVIDENCE_JUDGMENT is available but never inferred by this runner write, and related command, policy, or verifier fields do not replace the declaration. A row declaring VERIFICATION with completionPolicy VERIFICATION_PASSED is a pure gate: it is NOT dispatchable — a manual execute is refused with 409 and auto-dispatch passes over it — so declare MANUAL on a row that has work of its own. The server never files the verifier for you either: pass `verification: {title, assigneeId}` in this same call to write the check beside its subject. If TASK_CRITERION_SHAPE_ADVICE questions the chosen criterion, adopt its suggestedCriterion or retry with a non-blank completionCriterionOverrideReason, which is stored for later readers. Declaring OWNER_CONFIRMED on a task in no project, or in a project whose Automatic is off, also takes ownerConfirmationReason (DEPLOY, IRREVERSIBLE, OWNER_DEVICE_OR_ACCOUNT or OWNER_TRADE_OFF) — without one the call is refused 409 OWNER_CONFIRMATION_REASON_REQUIRED. Work a test or a reviewer can settle is EVIDENCE_JUDGMENT instead, and outside a project it is yours to settle: each evidence revision its run submits is handed to this session as an <orbit-evidence-review> message to decide with task_evidence_decide, and the owner is asked only if you have not decided within 30 minutes or have ended. To order work, pass `dependsOnTaskIds` to declare prerequisites natively — do NOT bake ordering into the description as manual preconditions. Prerequisites name the SUBJECT of the work, not its verification task — the server already holds a dependency on a verified task until its check PASSES. Pass `codeless: true` for work that produces no code — a rollout, a walkthrough, a verification, research — so the acceptance criterion it serves does not wait for a commit that will never exist.",
			"inputSchema": func() map[string]interface{} {
				props := taskCreateProps()
				// On the single door only: see verificationProp.
				props["verification"] = verificationProp
				props["startNow"] = startNowProp
				props["idempotencyKey"] = map[string]interface{}{
					"type":        "string",
					"minLength":   1,
					"maxLength":   200,
					"description": taskCreateIdempotencyKeyDescription,
				}
				return obj(props, "title", "completionCriterion")
			}(),
		},
		{
			"name":        "task_create_batch",
			"description": fmt.Sprintf("Create up to %d tasks in one atomic call (attributed to this agent) — the batch form of task_create, and the right tool whenever a plan produces more than one task. Nothing is written unless every item is valid. Every item declares completionCriterion explicitly; EVIDENCE_JUDGMENT is available but never inferred from omission, and a verifier relation (including verifiesRef), executable pair, or completion policy does not replace that declaration. An item declaring OWNER_CONFIRMED in no project, or in a project whose Automatic is off, carries ownerConfirmationReason (DEPLOY, IRREVERSIBLE, OWNER_DEVICE_OR_ACCOUNT or OWNER_TRADE_OFF), or the whole batch is refused 409 OWNER_CONFIRMATION_REASON_REQUIRED with that item's itemIndex; work a test or a reviewer can settle is EVIDENCE_JUDGMENT, which outside a project this session decides on each evidence revision it is handed. An item declaring VERIFICATION with completionPolicy VERIFICATION_PASSED is a pure gate: it is NOT dispatchable — a manual execute is refused with 409 and auto-dispatch passes over it — and the server never files its verifier for you, so `verifiesRef` from a later item of this same call is what pairs it; unpaired, that row can never complete. Items are created in order, and a later item can depend on an earlier one WITHOUT knowing its id: give the earlier item a `ref` and list that ref in the later item's `dependsOnRefs` (e.g. [{ref:\"s0\",…},{ref:\"s1\",dependsOnRefs:[\"s0\"]}]). `dependsOnTaskIds` still takes ids of tasks that already exist; the two combine. Each item takes the same fields as task_create, `projectId` and `acceptanceCriteria` included, so a plan for one project files every task it produces under that project in the same call, each carrying what would settle it. Ask, per item, what would settle it — of the person you are working with, in the conversation, before writing the batch — and put their answer in that item's `acceptanceCriteria`. If they have not said it for every item, do NOT write the batch yet: ask, and end your turn with the question. An item's criteria are theirs to state, not yours to guess, and the card this call raises is a yes/no on the plan rather than where they are agreed — a plan filed with criteria of your own makes every later reader treat your guess as their standard. Where a single command decides it — a test suite, a build, a lint — give the item `acceptanceCommand` with `acceptanceExpectedExitCode` too, and the item settles itself from the exit code instead of waiting on a person to read its evidence. An item filed with neither leaves its session no legal way to finish, and it ends at ATTEMPT_ENDED_WITHOUT_JUDGMENT_PATH — so a plan that skips this question is a plan that comes back to a human one task at a time. Items nest the same way they order: `parentRef` names an EARLIER item's ref as this item's PARENT, so a plan lands as a tree — its steps written as parts of the piece of work being planned, in the same call that creates it. `parentTaskId` stays for hanging items under a task that ALREADY exists (same project as the item); one item cannot carry both. The two ref fields answer different questions: `dependsOnRefs` is when an item may run, parentRef is what it is a part of. Returns the created tasks in input order, each echoing its `ref`. Tasks are only recorded, except an item carrying `startNow: true` — pass it for the items the person wants run now, and the server's once-a-minute scan starts each within the minute without asking them again; for the rest, call task_start for one that should run now, or give an item runAt to have the server start it at a set time. This BLOCKS until a human approves the batch: they see what would be created and, above all, how many of it starts running within the minute. Send the batch you actually mean — a rejected one costs the whole call, not one item.", maxTaskBatchCreate),
			"inputSchema": obj(map[string]interface{}{
				"tasks": map[string]interface{}{
					"type":     "array",
					"minItems": 1,
					"maxItems": maxTaskBatchCreate,
					"items": func() map[string]interface{} {
						return obj(taskBatchItemProps(), "title", "completionCriterion")
					}(),
					"description": "The tasks to create, in dependency order (prerequisites first).",
				},
				"idempotencyKey": map[string]interface{}{
					"type":        "string",
					"minLength":   1,
					"maxLength":   200,
					"description": taskBatchIdempotencyKeyDescription,
				},
				"dryRun": map[string]interface{}{
					"type":        "boolean",
					"description": "Judge this plan and write NONE of it — not one task, and not even the approval question a declared cross-project crossing would otherwise file. Answers with `plan` (where every item would land: project id, title and status), `findings` (every check that refuses or warns, in a fixed order) and `wouldWrite` (how many rows the real call would add). Use it whenever you are not certain which project a plan files into: a refusal tells you which item is wrong, and this tells you where the items that are RIGHT would go. It asks nobody for approval, because it starts nothing.",
				},
			}, "tasks"),
		},
		{
			"name":        "task_batch_pin",
			"description": "Re-pin many tasks at once: set `engine`, `provider` and/or `model` on every task a selector matches, in ONE request that writes only the rows whose pin really changes. The door for \"change the model of every task in this project\" — task_update can only spell that as one call per task, which is a hundred thousand round trips and as many non-HOT rewrites of rows whose model did not change: the project this exists for re-pinned 109,875 tasks one PATCH at a time, 81,219 of them inside one pg_stat_statements window, at 91.4 shared buffers and 7.4 kB of WAL each. Measured on a throwaway fixture carrying this table's real 29 indexes, walking a hundred thousand rows that way takes 218.6 s against a single project-scoped UPDATE's 31.0 s, for the same rows written. A row already carrying the target value is not written at all, so its `updated_at` is not bumped: that column's one reader is the project list's lastActivityAt, and skipping no-ops makes it more accurate, not less. `taskIds` and the filter NARROW each other — a caller naming both gets the intersection — and at least one of `taskIds`, `projectId`, `listId` or `labels` is required: a request naming none is refused (PIN_BATCH_NO_SELECTOR) rather than read as \"every task this owner has\". `engine`/`provider`/`model` are three-state exactly as on task_update — omitted leaves the current pin alone, null returns the task to inheriting its assignee workspace's, a string pins it — and naming none of them is refused (PIN_BATCH_NOTHING_TO_WRITE). A provider is checked once against the engine it is written with (named alone, it pins the engine it runs on by default); an engine named alone keeps each task's provider pin, so it is checked against every provider pin the selection holds, and the whole batch is refused, naming those that cannot run on it. Tasks with a run in flight are re-pinned like any other: this writes the task row only, a run already holding the task keeps the model it started on, and the disagreement is reported when the NEXT run starts, as TASK_RUN_PIN_CONFLICT. Returns `{changed}`: how many rows were actually written.",
			"inputSchema": obj(map[string]interface{}{
				"taskIds": map[string]interface{}{
					"type":        "array",
					"minItems":    1,
					"items":       map[string]interface{}{"type": "string"},
					"description": "An explicit set of tasks to re-pin. Narrows the filter when both are given. Only tasks this owner has ever match: an id that is not theirs, or does not exist, matches nothing.",
				},
				"projectId": map[string]interface{}{
					"type":        "string",
					"description": "Re-pin every task filed under this project. The id is the one in the web UI URL (/projects/<id>); a raw UUID works too. This is the selector the door exists for — a client cannot spell a 100,000-task project as an id list without reading the whole project first and posting megabytes of ids — and it is applied by the database, so the whole project is selected by one request.",
				},
				"listId": map[string]interface{}{
					"type":        "string",
					"description": "Re-pin every task filed in this list.",
				},
				"labels": map[string]interface{}{
					"type":        "array",
					"items":       map[string]interface{}{"type": "string"},
					"description": "Re-pin every task carrying ALL of these labels. Matched exactly, case included; task_labels reports how each one is actually spelled.",
				},
				"engine":   engineProp,
				"provider": providerProp,
				"model":    modelProp,
			}),
		},
		{
			"name":        "task_update",
			"description": "Update a task's fields. Direct status DONE is refused for every actor; the refusal names the declared EXECUTABLE, VERIFICATION, EVIDENCE_JUDGMENT, or OWNER_CONFIRMED path, and an OWNER_CONFIRMED task is confirmed only by the account owner in the Orbit app. A write that lands a task on OWNER_CONFIRMED in no project, or in a project whose Automatic is off — by changing the criterion, the project or the criterion it serves — needs ownerConfirmationReason (stored or sent), or it is refused 409 OWNER_CONFIRMATION_REASON_REQUIRED and nothing is written. FAILED remains writable as a run's conservative self-report. A run, or a conversation a run opened, may not write completionCriterion, acceptanceCommand, acceptanceExpectedExitCode, completionPolicy or acceptanceCriteria on another task unless it filed that task itself and the task serves no acceptance criterion of its project: it is refused with COMPLETION_STANDARD_FROM_RUN_REFUSED, and the account owner, the project's coordinator or a judgment session can make the edit. When setting `description`, write it as a self-contained, executable prompt an agent can act on without prior context (background, files involved, steps) — what would PROVE the task done goes in `acceptanceCriteria`, not into the prompt. `acceptanceCriteria` is editable for the whole life of the task, which is where it usually gets written: omit it to leave the current criteria untouched, pass a string to replace them, pass null to clear them. It states what settles THIS task, not the project it is filed under (project_get). `parentTaskId` moves this task under another one you own (same project, never itself or one of its own subtasks) — membership only, with no effect on when it runs. `projectId` re-files this task under another project, or null takes it out of every project — how a mis-filing is corrected. The account owner writes it directly; a session acting under a project scope is refused UNMAPPED_PROJECT_WORK for null and PROJECT_SCOPE_MISMATCH for another project unless it asks for either with `handoff`: the server then files a move request, answers CROSS_PROJECT_APPROVAL_REQUIRED or APPROVAL_PENDING and leaves the task where it is, and the account owner's confirmation moves the task at once, with nothing to send again (read the request with project_crossings; `handoff` says who may ask and which moves are refused). Pass null for assigneeId/listId/parentTaskId/projectId/dueDate/runAt/engine/provider/model/modelHint/modelHintReason to clear them. `codeless: true` declares that the task produces no code, which takes it out of its acceptance criterion's landing: it needs `codelessReason` in the same call, and is refused for a task that already has commits of its own.",
			"inputSchema": obj(map[string]interface{}{
				"taskId":      taskIDProp,
				"title":       str,
				"description": taskDescriptionProp,
				"status":      taskUpdateStatus,
				"listId":      map[string]interface{}{"type": []string{"string", "null"}},
				"projectId":   updateProjectIDProp,
				"fixesOpenItemId": map[string]interface{}{
					"type":        []string{"string", "null"},
					"description": "Attach this task to an OPEN integration or TASK_FAILED item as its concrete fix. Omit to preserve the current link; pass null to detach it. The item must be in the same project and assigned to the owner or coordinating session.",
				},
				"handoff":            updateHandoffProp,
				"assigneeId":         map[string]interface{}{"type": []string{"string", "null"}},
				"parentTaskId":       updateParentTaskIDProp,
				"dueDate":            map[string]interface{}{"type": []string{"string", "null"}},
				"runAt":              updateRunAtProp,
				"engine":             engineProp,
				"provider":           providerProp,
				"model":              modelProp,
				"modelHint":          modelHintProp,
				"modelHintReason":    modelHintReasonProp,
				"acceptanceCriteria": updateAcceptanceCriteriaProp,
				"criterionKey":       updateCriterionKeyProp,
				"codeless":           updateCodelessProp,
				"codelessReason":     codelessReasonProp,
				"completionCriterion": map[string]interface{}{
					"type":        "string",
					"enum":        []string{"EXECUTABLE", "VERIFICATION", "EVIDENCE_JUDGMENT", "OWNER_CONFIRMED"},
					"description": "Replace the task's one normal completion criterion. Omit to preserve it; a criterion cannot be cleared. EXECUTABLE, VERIFICATION, EVIDENCE_JUDGMENT and OWNER_CONFIRMED are peers, not an escalation order. OWNER_CONFIRMED is settled only by the account owner confirming the task in the Orbit app: no agent session can confirm it, a coordinator included. Changing it to a different value requires completionCriterionOverrideReason in the same call.",
				},
				"completionCriterionOverrideReason": criterionChangeReasonProp,
				"ownerConfirmationReason":           updateOwnerConfirmationReasonProp,
				"ownerConfirmationReasonNote":       updateOwnerConfirmationReasonNoteProp,
				"acceptanceCommand": map[string]interface{}{
					"type":        []string{"string", "null"},
					"description": "The one EXECUTABLE shell acceptance command. Set it together with acceptanceExpectedExitCode; null/null clears executable acceptance. Omit both to preserve them. One command only — split the task if that is insufficient.",
				},
				"acceptanceExpectedExitCode": map[string]interface{}{
					"type": []string{"integer", "null"},
					"description": "The exit code that mechanically derives DONE. The recorded exit code is compared with this one; anything else derives FAILED. " +
						"The comparison is literal and covers every way the command can end: killed at its budget, cancelled, signalled, or failed to start is reported as -1 and derives FAILED too. " +
						"Set or clear it together with acceptanceCommand.",
				},
				"acceptanceTimeoutSeconds": map[string]interface{}{
					"type":        []string{"integer", "null"},
					"description": acceptanceTimeoutSecondsDescription + " Pass null to return this task to the default.",
				},
				"dependsOnTaskIds": map[string]interface{}{
					"type":        "array",
					"items":       str,
					"description": "Complete replacement for this task's prerequisite ids. Omit to leave dependencies unchanged; pass [] to clear all prerequisites. Each id must be owned by the caller, and the replacement cannot form a cycle.",
				},
				"autoRunWhenReady": map[string]interface{}{
					"type":        "boolean",
					"description": "Once all prerequisites are DONE, auto-run this task without a manual start. Needs an assignee bound to a runner. " + autoRunUnfiledNoPrerequisites,
				},
				"priority": map[string]interface{}{
					"type":        []string{"integer", "null"},
					"minimum":     taskPriorityMin,
					"maximum":     taskPriorityMax,
					"description": taskPriorityDescription,
				},
				"completionPolicy": map[string]interface{}{
					"type":        "string",
					"enum":        []string{"MANUAL", "ALL_CHILDREN_DONE", "VERIFICATION_PASSED"},
					"description": "How this task rolls up subtasks. MANUAL (default) performs no child aggregation; the declared completionCriterion decides DONE. ALL_CHILDREN_DONE derives completion when every direct subtask is DONE or CANCELLED and at least one is DONE — and reopens it if one is later reopened, added or fails. VERIFICATION_PASSED uses independent PASS verdict evidence. Direct status DONE is never a completion mechanism. Switching back to MANUAL stops child recomputation without undoing what it last concluded.",
				},
				"verifiesTaskId": map[string]interface{}{
					"type":        []string{"string", "null"},
					"description": "The task this one exists to check. Omit to leave the relation alone, null to detach it, an id to point this task at that subject — the same rules as on task_create. Refused once this verification has concluded anything: the consequences already applied name the subject they were about, so re-pointing it afterwards would leave them asserting something about a task this check no longer verifies. File a new verification instead.",
				},
				"verdict": map[string]interface{}{
					"type":        []string{"string", "null"},
					"enum":        []interface{}{"PASS", "FAIL", "INCONCLUSIVE", nil},
					"description": "This VERIFICATION task's conclusion about the task it verifies. Only a task with verifiesTaskId set can carry one. Omit to leave it alone, null to revoke it — revoking a PASS reopens a subject that VERIFICATION_PASSED had completed.",
				},
				"labels": map[string]interface{}{
					"type":        "array",
					"items":       str,
					"maxItems":    maxTaskLabels,
					"description": "Complete replacement for this task's labels. Omit to leave them unchanged; pass [] to clear them all.",
				},
				"supersededByTaskId": map[string]interface{}{
					"type":        []string{"string", "null"},
					"description": "The later attempt that took this one's place. This is what makes \"we re-ran it from scratch\" a relation instead of a sentence in a comment: it names the successor, so a reader of the cancelled attempt can follow the chain to whoever ended up doing the work, and a list can tell an attempt that was REPLACED from one that was simply dropped. Only a CANCELLED or FAILED task may name one, the successor must be owned by you and in the SAME project, and the chain may not close a loop. It writes nothing to `status` — the original outcome is the fact being preserved, not the one being tidied away. Omit to leave the link alone, null to unlink.",
				},
				"terminalReason": map[string]interface{}{
					"type":        []string{"string", "null"},
					"enum":        []interface{}{"SUPERSEDED", "ABANDONED", nil},
					"description": "Why this task stopped, when its status alone does not say. Setting supersededByTaskId implies SUPERSEDED and needs no second spelling; ABANDONED is the other case — dropped on purpose, with nothing replacing it. FAILED and CANCELLED are not values here because they are already `status`.",
				},
			}),
		},
		{
			"name":        "task_reopen",
			"description": "Take a stopped task — DONE, CANCELLED or FAILED — back to OPEN, in place, so THIS task carries the next attempt rather than a new one being filed. One write: status OPEN, plus clearing any SUPERSEDED/ABANDONED retirement in the same request, which is the whole point of the tool — Run refuses a replaced attempt (§13.6 SU6, 'the work is being done by the successor') and the same guard refuses the status write that would clear the record unless it is named, so `task_update {status: OPEN}` alone cannot pick a superseded attempt back up. History stays: evidence, comments, dependencies, the project it is filed under and its criterion declaration. The run's progress does not — reopening starts a new lifecycle epoch, so a report aimed at the old revision loses its compare-and-set. Nothing is derived from this write: a task serving one of its project's acceptance criteria takes that project out of DONE (the status is a projection of the work), and a verification task holding a verdict is refused with the sentence that says to revoke it first — do not work around that reframing it as this call; revoking a PASS reopens the subject it settled. taskId defaults to the current task.",
			"inputSchema": obj(map[string]interface{}{"taskId": taskIDProp}),
		},
		{
			"name":        "task_delete",
			"description": "Permanently delete a task. This cannot be undone. Comments and dependency edges are deleted; finished sessions are retained and detached from the task, but a run still in flight is stopped — with the task gone it has no way left to finish. A run may delete only a task it filed itself, one that serves no acceptance criterion of its project, is not a verifier and has none; anything else is refused with TASK_DELETE_FROM_RUN_REFUSED, and the account owner, the project's coordinator or a judgment session can delete it. taskId defaults to the current task.",
			"inputSchema": obj(map[string]interface{}{"taskId": taskIDProp}),
		},
		{
			"name":        "task_start",
			"description": "Start a task immediately on its assigned agent. Creates or resumes the task-linked session and queues it for the assignee's runner. The task must have an assignee bound to a runner and all prerequisites must be complete. Returns the session id; taskId defaults to the current task.",
			"inputSchema": obj(map[string]interface{}{"taskId": taskIDProp}),
		},
		{
			"name":        "task_comment",
			"description": "Add a comment to a task (attributed to this agent).",
			"inputSchema": obj(map[string]interface{}{"taskId": taskIDProp, "body": str}, "body"),
		},
		{
			"name": "task_request_confirmation",
			"description": "Declare that this task's work is finished, so the account owner is asked to " +
				"confirm it — the ONLY thing that asks them. An OWNER_CONFIRMED task with no declaration " +
				"leaves the owner with no card: it stays OPEN and is confirmed only from its detail panel. " +
				"Call it from the task's own run, inside the turn that did the work, once the work is done " +
				"and before ending the turn. The question is put to the owner when this run has stopped " +
				"working (nothing queued behind that turn, no background job or sub-workspace of its own in " +
				"flight, no wake-up it asked for), over the report that turn ends on — declaring while more " +
				"work is coming asks nothing yet. Calling it twice in one turn is one declaration. " +
				"Confirming done, or sending back with a reason, is the account owner's own act in the app; " +
				"no agent session can do it. If the task has a reviewer, Orbit asks it first and the owner's " +
				"card waits until the review is in.",
			"inputSchema": obj(map[string]interface{}{"taskId": taskIDProp}),
		},
		// The reviewer's two answers to a confirmation request it was handed
		// (docs/owner-confirmation-review-contract.md §3.5, §8).
		confirmationReviewDescriptor(obj),
		confirmationReturnDescriptor(obj),
		// A task's structured progress, which the progress watches read (task_progress.go).
		taskProgressDescriptor(obj, taskIDProp),
		{
			"name":        "tasklist_list",
			"description": "List the caller's task lists (groups) with task counts.",
			"inputSchema": obj(map[string]interface{}{}),
		},
		{
			"name":        "tasklist_create",
			"description": "Create a task list (group).",
			"inputSchema": obj(map[string]interface{}{"title": str}, "title"),
		},
		{
			"name": "tasklist_get",
			"description": "Get one task list's dispatch policy and progress: its standing instructions, " +
				"paused flag, concurrency cap, foreman settings, task counts by status, how many " +
				"sessions are live, and when it last started anything. Returns the shape of the list, " +
				"not its tasks — use task_list for those. `failuresByCause` attributes this list's " +
				"failed runs to what actually broke, so the right lever gets pulled: `quota` means " +
				"wait or switch provider, `infrastructure` means a runner was down, `contentFilter` " +
				"means the request itself was refused, `unattributed` needs a human. Note that none " +
				"of these is fixed by rewriting instructions — check the attribution before " +
				"concluding a campaign has a prompt problem.",
			"inputSchema": obj(map[string]interface{}{"listId": str}, "listId"),
		},
		{
			"name": "tasklist_update",
			"description": "Change a task list's dispatch policy. `instructions` are standing instructions " +
				"spliced into every task run's prompt in this list, so one write changes how every " +
				"task not yet started will be run — prefer it over editing task descriptions one by " +
				"one. `paused` stops dispatch without touching runs already in flight. " +
				"`maxConcurrent` caps how many of this list's tasks run at once. Send only the fields " +
				"you mean to change, and a `note` saying why: every change is recorded as a revision " +
				"attributed to this agent and session, and a human can restore an earlier one.",
			"inputSchema": obj(map[string]interface{}{
				"listId":              str,
				"title":               str,
				"instructions":        str,
				"paused":              map[string]interface{}{"type": "boolean"},
				"verifyOnDone":        map[string]interface{}{"type": "boolean"},
				"maxConcurrent":       map[string]interface{}{"type": "integer"},
				"foremanWorkspaceId":  str,
				"foremanStallMinutes": map[string]interface{}{"type": "integer"},
				"note":                str,
			}, "listId"),
		},
		{
			"name": "tasklist_propose_dag",
			"description": "Propose a batch of dependency changes to a list's DAG, for a human to " +
				"approve. Use this to restructure — re-point prerequisites, parallelise a chain, " +
				"insert a blocking task — instead of task_dependency_add/remove one edge at a time: " +
				"the batch is previewed, approved and applied as one unit, so dispatch never sees a " +
				"half-rewritten graph and starts the wrong work. This BLOCKS until the human decides. " +
				"They see what you are writing plus what results from it — above all which tasks " +
				"become runnable, because those start within the minute. `note` is what they judge " +
				"it by: say what the restructure is for, not what the edges are.",
			"inputSchema": obj(map[string]interface{}{
				"listId": str,
				"ops": map[string]interface{}{
					"type":        "array",
					"description": "Each edge to add or remove. `taskId` waits on `dependsOnTaskId`. The dependent must be in this list; the prerequisite may be anywhere.",
					"items": obj(map[string]interface{}{
						"op":              map[string]interface{}{"type": "string", "enum": []string{"add", "remove"}},
						"taskId":          str,
						"dependsOnTaskId": str,
					}, "op", "taskId", "dependsOnTaskId"),
				},
				"note": str,
			}, "listId", "ops"),
		},
		{
			"name": "tasklist_delete",
			"description": "Delete a task list. The list's tasks are NOT deleted — they are detached and " +
				"become listless, keeping their assignees, dependencies and sessions; what is destroyed " +
				"is the grouping, its standing instructions, and its policy revisions. This cannot be " +
				"undone. To stop a list from dispatching without discarding any of that, set `paused` " +
				"with tasklist_update instead.",
			"inputSchema": obj(map[string]interface{}{"listId": str}, "listId"),
		},
		{
			"name": "provider_list",
			"description": "List the provider slugs `provider` accepts here. A provider is where a session's credential " +
				"comes from; the engine is the CLI that runs it (claude, codex, kimi, antigravity, opencode, dsh). Each " +
				"entry carries `engines`: the engines it can run, the one it runs on when no `engine` is named first. The " +
				"built-in entries (builtin true) are each engine's own sign-in on the runner — opencode is OpenCode's own " +
				"configuration, and dsh is DeepSeek Harness on the owner's first enabled DeepSeek key; the rest are this " +
				"account's API keys, each with the protocol its endpoint speaks (`runtime`) and the models it offers, and " +
				"its account pools. One key can run on several engines: a DeepSeek key on Claude Code, OpenCode and " +
				"DeepSeek Harness. Read this before pinning a `provider` or an `engine` on a task or session: a key's slug " +
				"is derived from its label, not chosen, so it cannot be guessed from the vendor's name, and a slug that is " +
				"not on this list is refused with \"provider not available\".",
			"inputSchema": obj(map[string]interface{}{}),
		},
		{
			"name": "provider_create",
			"description": "Configure a provider on this account — an API key and the endpoint it is for, typically a " +
				"self-hosted endpoint such as a local vLLM serving the Anthropic Messages API — so sessions and tasks can " +
				"get their credential from it by the slug this returns (derived from `label`, and listed by provider_list " +
				"with the engines it can run, which its `runtime` protocol decides). A provider holds a credential and is the account " +
				"owner's to add: if they have not asked for this one, do NOT call this tool — ask them and end your turn. " +
				"It puts the provider on a confirmation card in front of the owner, with the key shown only as set, and " +
				"BLOCKS until they answer: nothing is written if they decline, so do not create it another way. `baseUrl` " +
				"is resolved on the machine each session runs on, so http://127.0.0.1:8000 is that runner's own port — " +
				"run the session on an agent whose runner hosts the endpoint. The key is stored encrypted and no read " +
				"returns it, this tool's answer included (`hasApiKey`); like every tool input it is recorded in this " +
				"conversation, so for a real secret prefer `orbit provider create --api-key-file -`. A Cursor User API Key " +
				"(`runtime` cursor) takes only `label` and `apiKey`, and runs on Cursor CLI alone.",
			"inputSchema": obj(map[string]interface{}{
				"label":        map[string]interface{}{"type": "string", "description": "Display name; the slug is derived from it."},
				"runtime":      providerRuntimeProp,
				"baseUrl":      providerBaseURLProp,
				"apiKey":       providerAPIKeyProp,
				"models":       providerModelsProp,
				"defaultModel": map[string]interface{}{"type": "string", "description": "The model a session that names none runs on; defaults to the first of `models`."},
			}, "label", "apiKey"),
		},
		{
			"name": "provider_update",
			"description": "Change one of this account's own providers, named by the slug provider_list shows — never a " +
				"shared one. Pass only what changes: `models` REPLACES the whole list, and an omitted `apiKey` keeps the " +
				"stored key. A `runtime` (protocol) change is refused while an open session or a task pin uses the key on " +
				"an engine the new protocol cannot run. It puts the change on a confirmation card in front of the account " +
				"owner (a new key shown only as set) and BLOCKS until they answer: nothing is written if they decline. A " +
				"running session keeps the endpoint it was started with until it next restarts.",
			"inputSchema": obj(map[string]interface{}{
				"slug":         map[string]interface{}{"type": "string", "description": "The provider's slug, as provider_list shows it."},
				"label":        str,
				"runtime":      providerRuntimeProp,
				"baseUrl":      providerBaseURLProp,
				"apiKey":       providerAPIKeyProp,
				"models":       providerModelsProp,
				"defaultModel": str,
			}, "slug"),
		},
		{
			"name": "provider_delete",
			"description": "Remove one of this account's own providers, named by the slug provider_list shows. New sessions " +
				"and tasks can no longer name it, and nothing already on it moves to another engine or to the runner's own " +
				"sign-in: its sessions keep their engine and wait, as on a disabled provider, until they are switched to " +
				"another provider that engine runs, and a task pinned to it cannot start again until it is re-pinned. It " +
				"puts the deletion on a confirmation card in front of the account owner and BLOCKS until they answer: " +
				"nothing is removed if they decline.",
			"inputSchema": obj(map[string]interface{}{
				"slug": map[string]interface{}{"type": "string", "description": "The provider's slug, as provider_list shows it."},
			}, "slug"),
		},
		{
			"name": "notify",
			"description": "In a task run of an Automatic project this goes to the project's coordinator, not to the owner's devices. " +
				"Read recipient in the result to see who got it: coordinator, or owner when Orbit fell back. " +
				"Tell the human this session belongs to that something happened, on their phone and Mac, " +
				"with a line you write: the thing they said they were waiting for is done, or something went wrong " +
				"that they would want to hear about before they next look. " +
				"Notify is only for telling. If you need a credential, or anything else only the owner can do or " +
				"provide, do not call this tool: use request_owner_action, which files a card with a state and brings " +
				"the outcome back to you. Never ask for a credential here. " +
				"Say what happened in one sentence — it is read on a lock screen, and anything past " +
				"~200 characters is cut. They can reply straight from the notification, which arrives in this session. " +
				"NOT for progress updates, step-by-step narration, or anything they will see when they next look: this " +
				"interrupts a person, and one that did not need to be sent teaches them to ignore the next one. " +
				"At most one per session per minute. Read the result rather than assuming it landed — `delivered` is " +
				"false with a `reason` when they have no device registered, have turned these off, or were just " +
				"alerted; nothing is lost when it does (your message is still in the transcript), but nobody was told, " +
				"so keep going rather than wait for a reply that isn't coming.",
			"inputSchema": obj(map[string]interface{}{
				"message": map[string]interface{}{
					"type":        "string",
					"description": "The line to show. The session's title is already the alert's heading, so don't restate it — say only what happened.",
				},
			}, "message"),
		},
		{
			"name": "schedule_wakeup",
			"description": "Wake this session later, once or on a loop. Orbit's server holds the timer: when it is due, " +
				"a turn starts in this session carrying your reason and prompt — even if this engine was recycled or the " +
				"runner restarted in the meantime, and even while a Monitor or background job is still running. Use it " +
				"instead of Claude's ScheduleWakeup and CronCreate, which are refused here because their timers live inside " +
				"the engine process. Once: delaySeconds and reason. One such wakeup waits per session: a new call replaces " +
				"the pending one. On a loop: recurring: true with everySeconds and prompt. The server schedules every tick " +
				"itself until `until`, so do not call schedule_wakeup again each turn to keep the loop going: a tick that " +
				"cannot run (the runner offline, the session failed) is counted as missed, and the next one is scheduled all " +
				"the same. One loop runs per session, and a new recurring call replaces it; a one-shot wakeup and a loop " +
				"never replace each other. stop: true cancels the pending wakeup and ends the loop. To wait for something " +
				"that ends by itself outside Orbit (CI, a build, a deploy), prefer bg_run with wakeOnExit; for Orbit tasks " +
				"and sessions, call task_await or session_await. Both wake you when it happens.",
			"inputSchema": obj(map[string]interface{}{
				"delaySeconds": map[string]interface{}{
					"type": "number",
					"description": "Once: seconds from now to wake up, clamped to [60, 3600]; required unless stop or recurring is true. " +
						"On a loop: when the first tick is due, clamped to [60, 86400]; everySeconds when omitted.",
				},
				"reason": map[string]interface{}{
					"type":        "string",
					"description": "One sentence on what you are waiting for; it is said back to you when you are woken. Required for one wakeup; a loop may leave it out.",
				},
				"prompt": map[string]interface{}{
					"type":        "string",
					"description": "What the woken turn should do: the next step, or the /loop input to continue with. Required with recurring: it is what every tick's turn does.",
				},
				"recurring": map[string]interface{}{
					"type":        "boolean",
					"description": "Hold a loop instead of one wakeup: a tick every everySeconds until `until`, each starting a turn with prompt.",
				},
				"everySeconds": map[string]interface{}{
					"type":        "number",
					"description": "A loop's interval in seconds, clamped to [60, 86400]. Required with recurring.",
				},
				"until": map[string]interface{}{
					"type":        "string",
					"description": "When a loop ends by itself, as an ISO 8601 date-time: 7 days out when omitted, 30 days out at most.",
				},
				"stop": map[string]interface{}{
					"type":        "boolean",
					"description": "Cancel the pending wakeup and end the running loop instead of scheduling anything. Calling it again changes nothing.",
				},
			}),
		},
	}...)
	{
		sessionIDProp := map[string]interface{}{"type": "string", "description": "Target session id."}
		sessionStatus := map[string]interface{}{"type": "string", "enum": []string{"PENDING", "RUNNING", "AWAITING_INPUT", "SUCCEEDED", "FAILED", "CANCELLED", "INTERRUPTED"}}
		// Agent config shared by agent_create/agent_update. env is stored (and injected into the
		// engine process) as a flat string map, so the whole map is replaced on every write.
		envProp := map[string]interface{}{
			"type":                 "object",
			"additionalProperties": str,
			"description":          "Environment variables injected into the agent's engine process, as a flat string→string map. REPLACES the whole map. Existing values are intentionally secret and are not returned by agent_list, so provide the complete desired map.",
		}
		// What agent_create and agent_update say about the owner's card. The server refuses these fields
		// without one, so an agent reads it here rather than in a refusal.
		agentCardNote := " `env`, `workDir`, `systemPrompt`, `appendSystemPrompt`, `runnerId` and `enableWorktree` decide what this agent's next session runs and where, so a call naming any of them first puts the write — the agent, each variable's name and value, what each field becomes — on a confirmation card in front of the account owner, in every permission mode, and BLOCKS until they answer: nothing is written if they decline. `name`, `description` and `defaultMergeTarget` alone need no card."

		mergeTargetProp := map[string]interface{}{
			"type":        "string",
			"description": "Branch this agent's sessions merge into by default. Omit to leave the runner's auto-detect (main, else master).",
		}
		add(gateOrchestration,
			map[string]interface{}{
				"name":        "session_create",
				"description": "Spawn a new agent session to run a sub-task immediately (L3 orchestration). Returns the new session's id and status at once. To learn when it finishes its turn, call session_await with that id and end your turn instead of polling session_get, or pass wait to hold this call for a bounded time. Write `prompt` as a self-contained, executable brief (background, files, steps, acceptance) — the sub-agent has no prior context. When the user @mentions an agent in their message, pass that agent's name as `agentName` to run the sub-task under it (use agent_list to discover names); otherwise it runs under the current agent. Requires orchestration to be enabled for this agent. Fails with \"already has N unfinished sessions\" when this run is holding too much unfinished work at once — that is backpressure, not an error in your request: let some of the sessions you started finish, then spawn again.",
				"inputSchema": obj(map[string]interface{}{
					"prompt":    promptDesc,
					"agentId":   map[string]interface{}{"type": []string{"string", "null"}, "description": "Which agent runs it (by id); defaults to the current agent."},
					"agentName": map[string]interface{}{"type": "string", "description": "Route to an agent by name (e.g. from an @mention). Resolved to that owner's agent; ignored if agentId is set."},
					"title":     str,
					"model":     str,
					"engine": map[string]interface{}{
						"type": "string",
						"enum": append([]string{}, engineNames...),
						"description": "The CLI that runs the session: \"claude\" (Claude Code), \"codex\" (Codex), \"kimi\" (Kimi Code), \"antigravity\" (Antigravity CLI), \"opencode\" (OpenCode), \"dsh\" (DeepSeek Harness) or \"cursor\" (Cursor CLI). It is the session's for life: a session never changes engine, so another engine means another session. " +
							"With `provider` the two must be a pair that runs: a provider can run only the engines provider_list names for it, and any other is refused PROVIDER_ENGINE_INCOMPATIBLE. " +
							"Alone, it runs on that engine's own credential — its sign-in on the runner, OpenCode's own configuration, or for \"dsh\" the owner's first enabled DeepSeek key (refused DEEPSEEK_KEY_REQUIRED without one). " +
							"Omit it to run on the engine `provider` runs on by default, or with neither, where the target agent's project last started.",
					},
					"provider": map[string]interface{}{"type": "string", "description": "Where the session's credential comes from: an engine's own sign-in on the runner (\"claude\", \"codex\", \"kimi\", \"antigravity\"), \"opencode\" for OpenCode's own configuration, an account pool, or one of the owner's API keys — provider_list shows every slug with the engines it can run. " +
						"Named without `engine`, it runs on the engine that provider runs on by default, as it always did: a sign-in on its own engine, a key on its own protocol's CLI (a DeepSeek key on Claude Code), and the built-in \"dsh\" as DeepSeek Harness on the owner's first enabled DeepSeek key. " +
						"Omit both to start where the target agent's project last started — an agent has no engine or provider of its own."},
					// The catalogue declares the whole contract — every mode, and the prose with no
					// machine-specific note — so its identity is the same on every runner. The
					// projection narrows it to what THIS machine can run: a root runner drops
					// "bypassPermissions", which claude refuses under root by exiting during
					// startup (catalogToolDescriptors -> applyPermissionModeOffer).
					"permissionMode": map[string]interface{}{
						"type":        "string",
						"enum":        append([]string{}, allPermissionModes...),
						"description": strings.TrimSpace("How much the sub-session may do without a human: \"plan\" investigates and proposes without touching anything, \"default\" asks before each unapproved action, \"acceptEdits\" pre-approves file edits only, \"auto\" lets the model decide when to ask and is the mode for unattended work that has to run commands, \"dontAsk\" never asks but refuses anything not already approved, commands and background jobs included, \"bypassPermissions\" never asks and allows everything. Omit to use the owner's account default. It can never be wider than this session's own mode: a wider mode is refused, and when the default is wider the sub-session runs in this session's own mode. A mode that asks parks the sub-session on an approval card until a human answers, so pick one only if someone is watching. "),
					},
					"worktree": map[string]interface{}{"type": "boolean", "description": "Pass false to run the session in the agent's own checkout, with no branch and no worktree, even when the agent isolates each session in a worktree. For work that changes no code (investigating, reading logs, answering a question, read-only queries): it leaves no unmerged branch behind. Not for code changes: the session edits the checkout every other non-isolated session shares, and has no branch to merge. Omit it to follow the agent's own setting; true cannot turn isolation on for an agent that has it off."},
					"wait":     map[string]interface{}{"type": "boolean", "description": "Wait for the new session's first turn to settle and return its full state inline: up to about 10 minutes, less when this session was itself spawned by a wait. The wait is recorded on Orbit's server as a watch before it starts, so when that time runs out or the connection drops, the call returns the session as last seen with the watch under \"watch\", and the watch wakes this session when the turn settles; end your turn then instead of polling. If the server does not record the watch, the result says no server-held watch backs the wait, and a refused watch returns at once. Default false: returns immediately."},
				}, "prompt"),
			},
			map[string]interface{}{
				"name":        "session_list",
				"description": "List this owner's sessions (optionally filter by status or parentSessionId). Use to see what other sessions are doing and to collect the children you spawned (pass your own session id as parentSessionId).",
				"inputSchema": obj(map[string]interface{}{"status": sessionStatus, "parentSessionId": str}),
			},
			map[string]interface{}{
				"name":        "session_search",
				"description": "Find this owner's sessions by keyword or id — a session id (the Base62 short id these tools return and Orbit URLs carry), a raw UUID from an older link, or an 8–12 character UUID prefix resolves the corresponding session (all matches are returned if a prefix is ambiguous); text search matches session titles, opening prompts, last replies, branch names and the joined agent/task names, plus the conversation text itself for queries of 3+ characters (the response's `contentSearched` says whether message bodies were in scope). Spans Open, Completed and Trash; each hit carries `matchField`, a text snippet, lifecycleState and completedAt/deletedAt so you can tell where it lives. Hits are ranked by where the query matched, how exactly, and how recently the session was touched, then capped at `limit` — compare `total` against the number of hits to see whether a common word matched far more than came back, and narrow the query if it did. During rolling upgrades, filingState and archivedAt may also appear as compatibility aliases. Use session_list instead to see what is running right now.",
				"inputSchema": obj(map[string]interface{}{
					"query": map[string]interface{}{"type": "string", "description": "Text to look for, or a session id (Base62; a raw UUID or an 8–12 character UUID prefix also resolves). Text is matched literally (case-insensitive), not as a regex or keyword set."},
					"limit": map[string]interface{}{"type": "integer", "description": "Max hits to return. Default 20, capped at 50."},
				}, "query"),
			},
			map[string]interface{}{
				"name":        "session_get",
				"description": fmt.Sprintf("Get one session's current status and latest output (to collect a spawned sub-task's result). To wait for a session, call session_await instead of calling this in a loop. A record over %d characters is shortened to fit: the prompt first, then changedFiles, lastToolUse, lastUserText and error; lastAssistantText and result stay whole unless nothing else is left to shorten. What was shortened is named in truncatedFields; summary=false returns the full record.", toolResultBudget),
				"inputSchema": obj(map[string]interface{}{
					"sessionId": sessionIDProp,
					"summary":   map[string]interface{}{"type": "boolean", "description": "Default true: the record held under the budget. false returns it in full."},
				}, "sessionId"),
			},
			map[string]interface{}{
				"name":        "session_send",
				"description": "Send a message to a session you started (e.g. correct a sub-agent that's going off track, or answer one that is waiting for you). The server decides where it lands and reports it in `placement`: `steer` writes it into the turn already running, which gets no independent reply and cannot be withdrawn, while `accepted`/`queued` files it as that session's next turn. A session that has ended refuses the message unless you pass resumeIfEnded. Reuse clientTurnId after an uncertain response. Pass expectReply to make it a request: the call still returns at once (with `requestId` and `replyBy`), and the answer — or why there is none — comes back to you later as a turn of its own. An ordered pair of sessions may exchange at most 60 messages in any rolling 5 minutes (requests, project_send and message-carrying interrupts included); a send over that is refused with SESSION_MESSAGE_RATE_LIMITED and is not retryable — wait for the window or call session_await on the recipient. Sending to other sessions is unaffected.",
				"inputSchema": obj(withSessionRequestProps(map[string]interface{}{
					"sessionId":     sessionIDProp,
					"message":       str,
					"clientTurnId":  map[string]interface{}{"type": "string", "description": "Optional idempotency key. Re-sending the same CURRENT_WORK payload with this key returns its existing receipt instead of delivering twice — use it when retrying a call whose answer you never saw. Omitted, every call is a new logical send."},
					"resumeIfEnded": map[string]interface{}{"type": "boolean", "description": "Restart the session if it has ended, instead of refusing the message. The engine respawns with the conversation restored and this message becomes its first turn; the reply reports `revived: true`. This starts a run and holds a runner slot, so ask for it only when you mean to continue THAT conversation — otherwise start a new session. A live session is unaffected. Still refuses, naming the reason, when the session has no runner, its runner is offline, or its conversation cannot be restored."},
				}), "sessionId", "message"),
			},
			// The other end of a request: the session asked answers it. Gated with session_send, whose
			// requests it answers (contract §3.2).
			sessionReplyDescriptor(obj),
			map[string]interface{}{
				"name":        "session_interrupt",
				"description": "Interrupt a session's current turn (the process stays alive; you can session_send afterward). Interrupting DROPS whatever was queued behind that turn — stopping means stop. To stop the turn and redirect it, pass `message`: that files the follow-up in the same operation, after the drop, so it survives and runs as the next turn. Accepting this is not a promise the engine stopped; the session's transcript carries an `interrupt` event when it actually did. A `message` counts against the same per-pair cap as session_send (60 in any rolling 5 minutes; over it, SESSION_MESSAGE_RATE_LIMITED and nothing is dropped).",
				"inputSchema": obj(map[string]interface{}{
					"sessionId":    sessionIDProp,
					"message":      map[string]interface{}{"type": "string", "description": "What to do instead, sent atomically with the stop. Omitted → a plain interrupt, and anything queued behind the running turn is dropped with nothing put in its place."},
					"clientTurnId": map[string]interface{}{"type": "string", "description": "Optional idempotency key for the follow-up; a retry with the same key re-files neither the interrupt nor the message. Ignored without `message`."},
				}, "sessionId"),
			},
			map[string]interface{}{
				"name":        "session_merge",
				"description": "Merge a session's git worktree branch into its target branch (default: the runner's main/master). Only for worktree-isolated sessions; fails cleanly on conflict. Without waitSeconds this only QUEUES the merge and the reply says nothing about whether it worked — read the outcome with merge_receipts. With waitSeconds the reply waits for the outcome and carries the receipt itself.",
				"inputSchema": obj(map[string]interface{}{
					"sessionId":    sessionIDProp,
					"targetBranch": str,
					"waitSeconds":  map[string]interface{}{"type": "integer", "minimum": 1, "maximum": maxMergeWaitSeconds, "description": fmt.Sprintf("Wait up to this many seconds (1-%d) for the merge to finish, and return its receipt inline: result, landed, the target tip it produced, and every conflicting path when it conflicted. The runner picks a queued merge up on its NEXT HEARTBEAT, which ticks every 30 seconds, so a wait under that reports no outcome even for a merge that then succeeds — 60 is a sane floor. Running out of wait is not a failure and never claims one: the reply says it has no outcome, names the operation, and points at merge_receipts. Omitted, the merge is only queued.", maxMergeWaitSeconds)},
				}, "sessionId"),
			},
			map[string]interface{}{
				"name":        "session_end",
				"description": "End a session (park it; it can be resumed later). Frees its runner slot.",
				"inputSchema": obj(map[string]interface{}{"sessionId": sessionIDProp}, "sessionId"),
			},
			map[string]interface{}{
				"name":        "session_complete",
				"description": "Complete a session. Ends it if live and moves it from Open to Completed; it can still be moved back to Open later.",
				"inputSchema": obj(map[string]interface{}{"sessionId": sessionIDProp}, "sessionId"),
			},
			map[string]interface{}{
				"name":        "session_delete",
				"description": "Move a session to Trash. Ends it first if it is live, but retains its transcript and other data so a human can restore it later. This is not a permanent purge.",
				"inputSchema": obj(map[string]interface{}{"sessionId": sessionIDProp}, "sessionId"),
			},
			map[string]interface{}{
				"name":        "agent_list",
				"description": "List this owner's agents/workspaces (id, name, workDir, runner, and the engine and provider the project last ran on: lastEngine, lastProvider). Use the list to discover which agent to route a sub-task to — resolve an @mention to a name/id, then pass it to session_create (agentName or agentId).",
				"inputSchema": obj(map[string]interface{}{}),
			},
			map[string]interface{}{
				"name":        "agent_create",
				"description": "Create a new agent/workspace under this owner, bound to the current runner unless runnerId is given — e.g. to stand up a specialized sub-agent to delegate to. An agent has no engine or provider of its own, so pass `engine` and/or `provider` to session_create when a session needs a specific one. NOTE: the orchestration permission cannot be set here; only a human can grant it in the web UI." + agentCardNote,
				"inputSchema": obj(map[string]interface{}{
					"name":               str,
					"description":        str,
					"systemPrompt":       str,
					"appendSystemPrompt": str,
					"workDir":            map[string]interface{}{"type": "string", "description": "Project directory on the runner the agent runs in."},
					"runnerId":           map[string]interface{}{"type": "string", "description": "Runner to bind to; defaults to the current runner. Use runner_list to look up a runner's id."},
					"enableWorktree":     map[string]interface{}{"type": "boolean", "description": "Run each of the agent's sessions in its own git worktree."},
					"env":                envProp,
					"defaultMergeTarget": mergeTargetProp,
				}, "name"),
			},
			map[string]interface{}{
				"name":        "agent_update",
				"description": "Update an existing agent's fields (name, system prompt, workDir, etc.). An agent has no engine or provider to set — those are per session. Cannot change the orchestration permission (human-only, web UI)." + agentCardNote,
				"inputSchema": obj(map[string]interface{}{
					"agentId":            map[string]interface{}{"type": "string", "description": "Agent id to update."},
					"name":               str,
					"description":        str,
					"systemPrompt":       str,
					"appendSystemPrompt": str,
					"workDir":            str,
					"runnerId":           map[string]interface{}{"type": "string", "description": "Runner to bind the agent to. Use runner_list to look up a runner's id."},
					"enableWorktree":     map[string]interface{}{"type": "boolean"},
					"env":                envProp,
					"defaultMergeTarget": mergeTargetProp,
				}, "agentId"),
			},
			map[string]interface{}{
				"name": "agent_delete",
				"description": "Delete one of this owner's agents/workspaces, named by the id agent_list shows. It leaves the account's list but is not erased: " +
					"its sessions and tasks are kept and stay linked to it, as when it is deleted from its runner's page in the Orbit app. " +
					"An agent that still coordinates a project is refused, and so is the agent this session runs in. " +
					"It puts the agent — its name, its folder and its runner — on a confirmation card in front of the account owner and BLOCKS until they answer: " +
					"nothing is deleted if they decline. Returns what was deleted.",
				"inputSchema": obj(map[string]interface{}{
					"agentId": map[string]interface{}{"type": "string", "description": "Agent id to delete, as agent_list shows it."},
				}, "agentId"),
			},
			map[string]interface{}{
				"name": "runner_list",
				"description": "List this owner's runners — the machines that run sessions — including one no agent is bound to yet. Read-only. " +
					"Use it to look up a runner's id to pass as runnerId to agent_create or agent_update. " +
					"Each runner has id, name and displayName; online, whether it is reachable now, decided as the web runner list decides it " +
					"(status is what the runner last reported about itself, and stays ONLINE on a machine that vanished without signing off, so read online, not status); " +
					"status, version, lastHeartbeatAt and maxConcurrent; os, and engines — each installed engine CLI with auth \"yes\", \"no\" or \"unknown\" for whether it is signed in — when its heartbeats reported them; " +
					"and workspaceCount, the number of agents bound to it.",
				"inputSchema": obj(map[string]interface{}{}),
			},
			// The runner page's Install and Update engines, for the runners runner_list names. On the
			// orchestration gate: it runs an installer on a machine of the account, any machine of it.
			map[string]interface{}{
				"name": "runner_engine_install",
				"description": "Install an engine CLI on one of this owner's runners, or update the engine CLIs there — what pressing Install, or Update engines, on that runner's page in the Orbit app does. " +
					"This runs that engine's own official installer on that machine: the request is the consent for that engine there, whether or not the runner was registered to install engines on its own. " +
					"Only available in a session with orchestration enabled, and it reaches every runner of the account. No command is taken from you, only one of the known engines. " +
					"The runner must be online (runner_list's online); its next heartbeat hands it the request. " +
					"Returns the runner's engine relay at once, as runner_engine_install_status reads it: status \"pending\" until the runner picks the request up, then \"installing\" with the command it runs, then \"done\" or \"failed\" with what the machine said. " +
					"Follow it with runner_engine_install_status; an install can take minutes. " +
					"One install or update runs on a runner at a time.",
				"inputSchema": obj(map[string]interface{}{
					"runnerId": map[string]interface{}{"type": "string", "description": "The runner to install on. Use runner_list to look up a runner's id."},
					"engine": map[string]interface{}{
						"type":        "string",
						"enum":        append([]string{}, engineNames...),
						"description": "The engine CLI: \"claude\" (Claude Code), \"codex\" (Codex), \"kimi\" (Kimi Code), \"antigravity\" (Antigravity CLI), \"opencode\" (OpenCode), \"dsh\" (DeepSeek Harness) or \"cursor\" (Cursor CLI).",
					},
					"update": map[string]interface{}{"type": "boolean", "description": "Run the runner's engine update pass instead of installing engine: every engine CLI installed on that machine is updated, this one among them, and one with a session running there is left until that session finishes and named in the result. Default false."},
				}, "runnerId", "engine"),
			},
			map[string]interface{}{
				"name": "runner_engine_install_status",
				"description": "Where an engine install or update on one of this owner's runners stands — the state that runner's page in the Orbit app shows. Read-only; only available in a session with orchestration enabled. " +
					"status is null when nothing is in flight, \"pending\" until the runner picks the request up, \"installing\" with the command it runs, then \"done\" or \"failed\", with that command and the machine's own message — for a failed install, also what to run by hand. " +
					"mode is \"install\" (of engine) or \"update\" (of every engine CLI there, engine null). " +
					"A finished install is cleared, status null again, by the heartbeat that reports its engine installed: runner_list then shows it among the runner's engines. A finished update stays until it is dismissed in the app.",
				"inputSchema": obj(map[string]interface{}{
					"runnerId": map[string]interface{}{"type": "string", "description": "The runner to read. Use runner_list to look up a runner's id."},
				}, "runnerId"),
			},
			map[string]interface{}{
				"name": "runner_delete",
				"description": "Delete one of this owner's runners — a machine runner_list shows — with every agent/workspace bound to it, as Delete on that runner's page in the Orbit app does. " +
					"The machine itself is untouched: it can no longer reach Orbit, and registering it again adds it back; a rented machine still has to be released where it was rented. " +
					"A managed runner is refused, and so is the runner this session runs on. " +
					"It puts the runner — its name, whether it is online, and the workspaces that go with it — on a confirmation card in front of the account owner and BLOCKS until they answer: " +
					"nothing is deleted if they decline. Returns what was deleted. Only available in a session with orchestration enabled.",
				"inputSchema": obj(map[string]interface{}{
					"runnerId": map[string]interface{}{"type": "string", "description": "The runner to delete. Use runner_list to look up a runner's id."},
				}, "runnerId"),
			},
			// A project tool on the orchestration gate rather than beside the other project_* ones:
			// this is the one project door that can OPEN a conversation, and it spends a live
			// session credential exactly as `session_create` does. A caller without the grant gets
			// no tool rather than a tool whose every call is refused.
			map[string]interface{}{
				"name": "project_ensure_coordinator",
				"description": "The session that coordinates a project, opening the next " +
					"conversation only when the standing one can no longer be handed a message. " +
					"A replacement is opened ONLY when the conversation the project points at " +
					"cannot receive — no runner, an offline runner, a run that never started, a " +
					"row in Trash, or a run that was replaced (§13.6 SU6) — so a conversation " +
					"somebody is still in, or an ended one its runner can still revive, is never " +
					"displaced: that case comes back `created: false` with the same `sessionId` " +
					"and not one row written, and reads as \"that session is the one to send to\" " +
					"(`session send` with `resumeIfEnded`). `created: true` carries " +
					"`replacedSessionId` and `replaceReason`, saying what the replacement left " +
					"behind. This is not a way to end a conversation: that press is the account " +
					"owner's and stays behind their confirmation card. The acting session is never " +
					"the one replaced, and a project with no coordinator at all gets its FIRST " +
					"one, freely landed where its work already runs. The refusal that stays is " +
					"COORDINATOR_UNAVAILABLE (409, owner: USER), left exactly as the server raised " +
					"it: it names the account owner's `requiredAction` (rebind), because where a " +
					"project's coordination lives is their decision — so that refusal is theirs to " +
					"act on, and a retry answers the same thing.",
				"inputSchema": obj(map[string]interface{}{
					"projectId": map[string]interface{}{
						"type":        "string",
						"description": "The project whose coordinator to take, as shown in its web UI URL (/projects/<id>).",
					},
				}, "projectId"),
			},
			// The other delivery to that same conversation, and the one that does not go stale:
			// project_ensure_coordinator answers with a session id, and between that answer and a
			// send to it a rotation fits through — the id then names a conversation that no longer
			// coordinates anything, and the message reaches a reader instead of the project. So this
			// addresses the PROJECT and the server resolves the conversation at the moment of
			// delivery. It spends the same live orchestration credential, which is why it sits here
			// rather than beside the ungated project_* tools above.
			map[string]interface{}{
				"name": "project_send",
				"description": "Hand one message to this project's coordinator. The project is the " +
					"ADDRESS: the coordinator is resolved at the moment of delivery, so nothing this " +
					"call resolved earlier can go stale — which is the whole difference between this " +
					"and `project_ensure_coordinator` followed by a send to the id it answers with. A " +
					"conversation that can be handed the message is delivered to and NOT displaced, " +
					"an ended one whose runner can still revive it included: that case REVIVES it " +
					"(what `session_send` with `resumeIfEnded` does) rather than replacing it. Only a " +
					"conversation that cannot take a message at all is replaced — by the rotation " +
					"`project_ensure_coordinator` performs, under the same conditions — and the " +
					"message goes to the replacement in the same call. The response says what " +
					"happened rather than what was asked for: `created` and `sessionId` name the " +
					"conversation the message is on, and `replacedSessionId`/`replaceReason` are " +
					"present only when this call rotated to get there. The refusal that stays is " +
					"COORDINATOR_UNAVAILABLE (409, owner: USER, requiredAction: rebind), which names " +
					"the account owner because where a project's coordination lives is their decision " +
					"— a retry answers the same thing; a write refused after a coordinator WAS found " +
					"comes back as COORDINATOR_MESSAGE_UNDELIVERED with the sentence that refused it " +
					"inside. The acting session is the authority and there is no headless form. Reuse " +
					"clientTurnId after an uncertain response. With expectReply the message is a " +
					"request to the coordinator it was DELIVERED to: the answer comes back to you as a " +
					"turn, and if that conversation is rotated out first the outcome is RECIPIENT_ENDED " +
					"— ask again and it reaches the new one. It counts against session_send's cap on " +
					"the pair (you → the coordinator): 60 messages in any rolling 5 minutes, then " +
					"SESSION_MESSAGE_RATE_LIMITED, not retryable.",
				"inputSchema": obj(withSessionRequestProps(map[string]interface{}{
					"projectId": map[string]interface{}{
						"type":        "string",
						"description": "The project whose coordinator the message is for, as shown in its web UI URL (/projects/<id>).",
					},
					"message": map[string]interface{}{
						"type":        "string",
						"description": "The message to deliver to that project's coordinator.",
					},
					"clientTurnId": map[string]interface{}{
						"type":        "string",
						"description": "Optional idempotency key the message is written under. Re-sending the same message with this key returns the turn it already filed instead of delivering a second copy — use it when retrying a call whose answer you never saw. Omitted, the server mints one and every call is a new message.",
					},
				}), "projectId", "message"),
			},
		)
	}
	// Waiting on Orbit's own work (watch_tools.go). session_await watches sessions, so it rides the
	// gate the session tools ride; the rest need only a session to wake.
	add(gateOrchestration, sessionAwaitDescriptor(obj))
	add(gateAlways, watchToolDescriptors(obj)...)
	// Reading what your own workspace shares and proposing what you learned is not a power over
	// anybody else's session, so the wiki tools are offered to every agent, as the task tools are
	// (wiki_tools.go; they are left out entirely when the wiki is off).
	add(gateAlways, wikiToolDescriptors(obj)...)
	add(gateAlways, fileToolDescriptors(obj)...)
	// Always advertised: an agent that cannot see the tool falls back to
	// Bash(run_in_background), and a session without the runner socket gets a
	// refusal that says why rather than a silently engine-owned process.
	add(gateAlways, bgToolDescriptors(obj)...)
	add(gatePermissionPrompt, map[string]interface{}{
		// Claude Code's --permission-prompt-tool target. Claude calls it (not the
		// agent) when a tool needs permission; it blocks on a human allow/deny.
		"name":        "permission_prompt",
		"description": "Internal: handles Claude Code tool-permission prompts. Not for direct use.",
		"inputSchema": obj(map[string]interface{}{
			"tool_name":   str,
			"input":       map[string]interface{}{"type": "object"},
			"tool_use_id": str,
		}),
	})
	return finishOperationCatalog(ops)
}

// watchToolDescriptors is the agent-facing contract of the watch tools every in-session agent has.
// session_await is sessionAwaitDescriptor: it watches sessions, so it rides the orchestration gate.
func watchToolDescriptors(obj func(map[string]interface{}, ...string) map[string]interface{}) []map[string]interface{} {
	watchIDProp := map[string]interface{}{
		"type":        "string",
		"description": "The watch id, as watch_create, task_await, session_await or watch_list returned it.",
	}
	predicateVersionProp := map[string]interface{}{
		"type": "integer",
		"enum": watchPredicateVersions,
		"description": "The grammar version the predicate is written in: 1, 2 or 3, as described under predicate. Omit it " +
			"and the lowest version that has every term the predicate uses is sent.",
	}
	keyProp := map[string]interface{}{"type": "string", "minLength": 1, "maxLength": 200, "description": watchIdempotencyKeyDescription}
	return []map[string]interface{}{
		{
			"name": "watch_create",
			"description": "Ask Orbit to watch Orbit tasks or sessions and wake this session when a condition holds. This is " +
				"how to wait on Orbit's own work: do not poll it with sleep, Bash loops, Monitor, bg_run or schedule_wakeup. " +
				"Orbit's server holds the watch, so it outlives this call, this engine being recycled and the runner " +
				"restarting. A condition reads Orbit's own records only (a task's status or reported progress, a session's " +
				"state, a session's bg_run job going quiet) and never runs a command: to watch a system outside Orbit, run a " +
				"polling script with bg_run that prints only when what it polls changes, with wakeOnStall. " +
				"Name an explicit set of targets, fixed when the watch is made, and a predicate. The first time " +
				"the predicate holds, Orbit records one Match and starts a turn in THIS session carrying a structured payload " +
				"(watchId, generation, reason, changedTargets, latestSnapshot). A watch that ends without matching (it " +
				"expired, its permission was revoked, or every target is gone) also starts one turn saying so; a cancelled " +
				"one wakes nobody. After creating it, end your turn: nothing more is needed to be woken. For the common " +
				"waits, task_await and session_await build the predicate for you. Watching sessions needs orchestration, as " +
				"reading them does.",
			"inputSchema": obj(map[string]interface{}{
				"targets": map[string]interface{}{
					"type":     "array",
					"minItems": 1,
					"maxItems": watchMaxTargets,
					"items": obj(map[string]interface{}{
						"kind": map[string]interface{}{"type": "string", "enum": []string{"TASK", "SESSION"}},
						"id":   map[string]interface{}{"type": "string"},
					}, "kind", "id"),
					"description": "The tasks and sessions to watch, by id. The set is fixed when the watch is made: to wait " +
						"on a task list or a project, list its tasks first and name them.",
				},
				"predicate":        map[string]interface{}{"type": "object", "description": watchPredicateGrammar},
				"predicateVersion": predicateVersionProp,
				"action": map[string]interface{}{
					"type": "string",
					"enum": []string{"RESUME_SESSION", "NOTIFY_USER"},
					"description": "RESUME_SESSION, the default, starts a turn in this session. NOTIFY_USER sends the person " +
						"a notification instead and wakes nobody.",
				},
				"ttlSeconds": map[string]interface{}{
					"type":    "integer",
					"minimum": watchMinTTLSeconds,
					"maximum": watchMaxTTLSeconds,
					"description": "How long the watch may wait, from now: 60 seconds to 30 days, 24 hours when omitted. If " +
						"it runs out before the condition holds, this session is woken once with EXPIRED and the latest snapshot.",
				},
				"idempotencyKey": keyProp,
			}, "targets", "predicate"),
		},
		{
			"name": "watch_get",
			"description": "Read one of this session's watches in full: its state, each target as last evaluated, every " +
				"Match with its snapshot, and whether each wake or notification was delivered (a dead letter shows why). Read " +
				"it after being woken, or to see why a watch has not fired yet; do not call it in a loop to wait, since the " +
				"watch wakes you.",
			"inputSchema": obj(map[string]interface{}{"watchId": watchIDProp}, "watchId"),
		},
		{
			"name": "watch_list",
			"description": "List this session's watches, newest first and at most 100: each one's id, state, action, " +
				"condition, targets and deadline, when the server evaluates it next (nextEvaluateAt, null once it has ended) " +
				"and last did (lastEvaluatedAt), and how many of its wakes or notifications were never delivered " +
				"(deadLetterCount; watch_get says why). This is how to find a watch made before an engine restart or a compaction.",
			"inputSchema": obj(map[string]interface{}{
				"state": map[string]interface{}{"type": "string", "enum": watchStates, "description": "Only watches in this state."},
			}),
		},
		{
			"name": "watch_update",
			"description": "Change the condition or the deadline of one of this session's live (ACTIVE or PAUSED) watches. " +
				"Its targets and its action stay as created: to watch something else, cancel it and create another. An " +
				"edited watch is evaluated again under what it now says.",
			"inputSchema": obj(map[string]interface{}{
				"watchId":          watchIDProp,
				"predicate":        map[string]interface{}{"type": "object", "description": watchPredicateGrammar},
				"predicateVersion": predicateVersionProp,
				"ttlSeconds": map[string]interface{}{
					"type":        "integer",
					"minimum":     watchMinTTLSeconds,
					"maximum":     watchMaxTTLSeconds,
					"description": "The new deadline, counted from now: 60 seconds to 30 days.",
				},
			}, "watchId"),
		},
		{
			"name": "watch_cancel",
			"description": "Cancel one of this session's watches. A cancelled watch wakes nobody, so cancel only a wait " +
				"you no longer need. A watch that already matched or ended cannot be cancelled.",
			"inputSchema": obj(map[string]interface{}{"watchId": watchIDProp}, "watchId"),
		},
		{
			"name": "task_await",
			"description": "Be woken when Orbit tasks finish. This is the one call for \"wake me when these tasks are all " +
				"DONE, CANCELLED or FAILED, or as soon as any of them fails\": it asks Orbit's server to watch exactly these " +
				"tasks for this session and returns at once, so end your turn then. When the condition holds, Orbit starts a " +
				"turn here saying which tasks changed, with a snapshot of all of them; if the watch expires first, one turn " +
				"says so. Use it instead of polling task_get or task_list, sleeping, or looping in Bash. The result names the " +
				"watch: watch_get reads it and watch_cancel stops it.",
			"inputSchema": obj(map[string]interface{}{
				"taskIds": map[string]interface{}{
					"type":     "array",
					"minItems": 1,
					"maxItems": watchMaxTargets,
					"items":    map[string]interface{}{"type": "string"},
					"description": "The tasks to wait for, by id. The set is fixed when the watch is made: to wait on a " +
						"task list or a project, list its tasks first and name them.",
				},
				"until": map[string]interface{}{
					"type":        "string",
					"enum":        awaitPresetNames(taskAwaitPresets),
					"description": "What to wait for. " + awaitPresetProse(taskAwaitPresets) + ".",
				},
				"ttlSeconds": map[string]interface{}{
					"type":        "integer",
					"minimum":     watchMinTTLSeconds,
					"maximum":     watchMaxTTLSeconds,
					"description": "How long to wait at most, from now: 60 seconds to 30 days, 24 hours when omitted.",
				},
				"idempotencyKey": keyProp,
			}, "taskIds"),
		},
	}
}

func sessionAwaitDescriptor(obj func(map[string]interface{}, ...string) map[string]interface{}) map[string]interface{} {
	return map[string]interface{}{
		"name": "session_await",
		"description": "Be woken when other Orbit sessions finish their turn, need a person, or end: the sub-sessions you " +
			"started with session_create, for instance. It asks Orbit's server to watch exactly these sessions for this " +
			"session and returns at once, so end your turn then. When the condition holds, Orbit starts a turn here with " +
			"each session's state; if the watch expires first, one turn says so. Use it instead of polling session_get, " +
			"sleeping, or looping in Bash. A session cannot await itself.",
		"inputSchema": obj(map[string]interface{}{
			"sessionIds": map[string]interface{}{
				"type":        "array",
				"minItems":    1,
				"maxItems":    watchMaxTargets,
				"items":       map[string]interface{}{"type": "string"},
				"description": "The sessions to wait for, by id.",
			},
			"until": map[string]interface{}{
				"type":        "string",
				"enum":        awaitPresetNames(sessionAwaitPresets),
				"description": "What to wait for. " + awaitPresetProse(sessionAwaitPresets) + ".",
			},
			"ttlSeconds": map[string]interface{}{
				"type":        "integer",
				"minimum":     watchMinTTLSeconds,
				"maximum":     watchMaxTTLSeconds,
				"description": "How long to wait at most, from now: 60 seconds to 30 days, 24 hours when omitted.",
			},
			"idempotencyKey": map[string]interface{}{"type": "string", "minLength": 1, "maxLength": 200, "description": watchIdempotencyKeyDescription},
		}, "sessionIds"),
	}
}

// wikiToolDescriptors is the agent-facing contract of the wiki tools. Unlike the task tools these
// are not gated on orchestration: reading what your own workspace shares and proposing what you
// learned is not a power over anybody else's session. They ARE gated on the wiki being on at all
// (wiki_rollout below), and every one of them carries an outputSchema and annotations: two declare
// themselves read-only, and the one that writes declares that it is not destructive — it keeps every
// revision, and what ends a lineage waits for the owner.
func wikiToolDescriptors(obj func(map[string]interface{}, ...string) map[string]interface{}) []map[string]interface{} {
	str := map[string]interface{}{"type": "string"}
	queryProp := map[string]interface{}{
		"type": "string",
		"description": "What to look for: words, or one repo-relative path (a path goes to the path leg, and " +
			"so do the entries whose anchors or pitfall triggers sit under it).",
	}
	kindsProp := map[string]interface{}{
		"type":        "array",
		"items":       map[string]interface{}{"type": "string", "enum": wikiEntryKinds},
		"description": "Only entries of these kinds.",
	}
	topicProp := map[string]interface{}{"type": "string", "description": "Only entries filed under this topic slug."}
	pathsProp := map[string]interface{}{
		"type":  "array",
		"items": str,
		"description": "Repo-relative paths: entries anchored or triggered under one of them are recalled by the " +
			"path leg, whether or not the query names them.",
	}
	limitProp := map[string]interface{}{
		"type":        "integer",
		"minimum":     1,
		"maximum":     wikiSearchLimitMax,
		"description": "How many entries to return at most, 1 to " + strconv.Itoa(wikiSearchLimitMax) + ".",
	}
	return []map[string]interface{}{
		{
			"name": "wiki_search",
			"description": "What the Orbit wiki already knows about this codebase, as entries: a keyword and path " +
				"search over titles, summaries, aliases and anchor paths. It returns entries and nothing else — id, " +
				"kind, title, summary, trust, anchorState, the legs that matched, a score, and how old each one is: " +
				"when it was recorded, when its current revision was written, and the commit and time its anchors were " +
				"last checked at — so read one in full with wiki_get when the summary is not enough. A verified anchor " +
				"was found as recorded, which does not say the entry still holds: weigh an old one against the code. " +
				"Search BEFORE proposing: a near neighbour is better " +
				"reinforced than duplicated, and the answer to a proposal names what it resembles. A session reads " +
				"only the space its workspace is bound to, plus the proposals it made itself and the owner has not " +
				"decided yet; another session's pending proposal is not visible here.",
			"inputSchema": obj(map[string]interface{}{
				"query": queryProp,
				"kinds": kindsProp,
				"topic": topicProp,
				"paths": pathsProp,
				"limit": limitProp,
			}, "query"),
			"outputSchema": obj(map[string]interface{}{
				"q":        map[string]interface{}{"type": "string", "description": "The query as the server normalized it."},
				"semantic": map[string]interface{}{"type": "boolean", "description": "Whether a semantic leg ran. Off in phase 1."},
				"hits": map[string]interface{}{
					"type":        "array",
					"description": "The entries, best first. Empty when nothing matched.",
					"items": obj(map[string]interface{}{
						"id":          map[string]interface{}{"type": "string", "description": "The entry id, for wiki_get."},
						"kind":        map[string]interface{}{"type": "string", "enum": wikiEntryKinds},
						"title":       str,
						"summary":     map[string]interface{}{"type": "string", "description": "One sentence: the whole of what a card shows."},
						"trust":       map[string]interface{}{"type": "string", "enum": wikiTrustLevels},
						"anchorState": map[string]interface{}{"type": "string", "enum": []string{"unchecked", "verified", "changed", "missing"}},
						"match": map[string]interface{}{
							"type":        "array",
							"items":       map[string]interface{}{"type": "string", "enum": wikiSearchMatches},
							"description": "Which legs found it: keyword, path, or (phase 2) semantic.",
						},
						"score": map[string]interface{}{"type": "number", "description": "The fused rank. Compare within one answer only."},
						// How old the entry is (contract `agentSurface.toolSpecs.wiki_search.age`). Each is left
						// out where the server sent none: a check not made yet, or a server that predates them.
						"recordedAt": map[string]interface{}{"type": "string", "description": "When the entry was first recorded, ISO 8601 in UTC. No amend moves it."},
						"changedAt":  map[string]interface{}{"type": "string", "description": "When its current revision was written, ISO 8601 in UTC: the last change to what it says."},
						"anchorCheckedRef": map[string]interface{}{"type": "string",
							"description": "The commit its anchors were last checked at. Absent until a check; it can be older than changedAt."},
						"anchorCheckedAt": map[string]interface{}{"type": "string",
							"description": "When that check was made, ISO 8601 in UTC. A check finds the anchors as recorded or not; it does not re-read what the entry says."},
					}, "id", "kind", "title"),
				},
			}, "hits"),
			"annotations": map[string]interface{}{"readOnlyHint": true},
		},
		{
			"name": "wiki_get",
			"description": "Read whole wiki entries by id, as wiki_search returned them: the content, its anchors each " +
				"with the last check of it (the ref and when), and — with include: sources, the default — the records " +
				"it came from, each with the orbit-* link that reaches that record. Read the sources before you rely " +
				"on an entry and before you propose against it: a claim whose sources you cannot open is a claim you " +
				"cannot check. 1 to " + strconv.Itoa(wikiGetIDsMax) + " ids; an id this session may not read answers " +
				"under errors[] rather than failing the whole call.",
			"inputSchema": obj(map[string]interface{}{
				"ids": map[string]interface{}{
					"type":        "array",
					"minItems":    1,
					"maxItems":    wikiGetIDsMax,
					"items":       str,
					"description": "The entry ids to read, at most " + strconv.Itoa(wikiGetIDsMax) + ".",
				},
				"include": map[string]interface{}{
					"type":  "array",
					"items": map[string]interface{}{"type": "string", "enum": append(append([]string{}, wikiIncludes...), "none")},
					"description": "What each entry carries. sources (the default) adds the records it came from; history " +
						"adds every revision, and the door answers that with the sources too; anchors ride the entry and " +
						"are always there. none reads the entry alone, and cannot be combined with the others.",
				},
			}, "ids"),
			"outputSchema": obj(map[string]interface{}{
				"entries": map[string]interface{}{
					"type":        "array",
					"description": "The entries that were read, in the order they were asked for.",
					"items":       map[string]interface{}{"type": "object"},
				},
				"errors": map[string]interface{}{
					"type":        "array",
					"description": "Ids that could not be read, each with what the server said.",
					"items": obj(map[string]interface{}{
						"id":      str,
						"code":    map[string]interface{}{"type": "string", "description": "The refusal code, when the server gave one."},
						"message": str,
					}, "id", "message"),
				},
			}, "entries"),
			"annotations": map[string]interface{}{"readOnlyHint": true},
		},
		{
			"name":        "wiki_propose",
			"description": wikiProposeDescription,
			"inputSchema": obj(map[string]interface{}{
				"ops": map[string]interface{}{
					"type":     "array",
					"minItems": 1,
					"maxItems": wikiOpsPerTurn,
					"items": obj(map[string]interface{}{
						"op": map[string]interface{}{"type": "string", "enum": wikiOpNames},
						"entry": obj(map[string]interface{}{
							"kind":    map[string]interface{}{"type": "string", "enum": wikiEntryKinds},
							"title":   str,
							"summary": str,
							"fields":  map[string]interface{}{"type": "object", "description": "The kind's own fields; the server refuses WIKI_SCHEMA naming every one that failed."},
							"topics":  map[string]interface{}{"type": "array", "items": str},
							"aliases": map[string]interface{}{"type": "array", "items": str},
							"anchors": map[string]interface{}{"type": "array", "items": map[string]interface{}{"type": "object"}},
						}, "kind", "title", "summary", "fields"),
						"entryId":          map[string]interface{}{"type": "string", "description": "The entry the op is about: required by every op but add."},
						"baseRevision":     map[string]interface{}{"type": "integer", "description": "The revision the op was written against, required by amend, supersede and retire and forbidden by the others."},
						"changes":          map[string]interface{}{"type": "object", "description": "amend: any of title, summary, fields, topics, aliases, anchors; a key given replaces that key whole, a key omitted carries over."},
						"answersChallenge": map[string]interface{}{"type": "string", "description": "amend, optional: the id of a pending challenge op of this very entry. When the amend takes effect it closes that challenge, and the entry returns to the push if nothing else holds it out — the id is the challenge's opId, and an amend that names none closes none."},
						"reason":           map[string]interface{}{"type": "string", "description": "retire or challenge: why, in text; Review shows it beside the op."},
						"sources": map[string]interface{}{
							"type":        "array",
							"items":       map[string]interface{}{"type": "object"},
							"description": "The records this came from: {kind, ref|session, quote}. Reinforce requires at least one, and a quote must be a substring of the record it cites. " + wikiSourceRefs,
						},
					}, "op"),
					"description": "The batch, at most " + strconv.Itoa(wikiOpsPerTurn) + " ops per turn, each answered on its own by its position.",
				},
				"rationale": map[string]interface{}{
					"type":        "string",
					"description": "Why this batch is worth recording, in text. Required, and shown to the owner in Review.",
				},
				"idempotencyKey": map[string]interface{}{
					"type":      "string",
					"minLength": 1,
					"maxLength": 200,
					"description": "Required, and yours to choose: the same key with the same request returns the recorded " +
						"answer instead of proposing again, so a retry after an answer you never saw is safe.",
				},
				"dryRun": map[string]interface{}{
					"type":        "boolean",
					"description": "Check every op and answer as the request would, recording nothing and publishing nothing.",
				},
				"replaces": map[string]interface{}{"type": "string", "description": wikiReplacesDescription},
			}, "ops", "rationale", "idempotencyKey"),
			"outputSchema": obj(map[string]interface{}{
				"changesetId": map[string]interface{}{
					"type":        []string{"string", "null"},
					"description": "The changeset this batch was recorded as; null when nothing was recorded (a dry run, or every op refused).",
				},
				"replayed": map[string]interface{}{"type": "boolean", "description": "True when this is the recorded answer to an earlier request under the same idempotencyKey."},
				// A wiki chat's answer (contract `agentSurface.chat.propose`): one card the owner may press, nothing written.
				"status":  map[string]interface{}{"type": "string", "enum": []string{"draft"}, "description": "In a wiki chat: draft — the ops that passed are one card for the owner to apply, and nothing of the wiki changed."},
				"draftId": map[string]interface{}{"type": "string", "description": "In a wiki chat: the card the ops that passed became. Pass it as replaces when you revise it."},
				"similar": map[string]interface{}{
					"type":        "array",
					"description": "In a wiki chat: the entries the card's adds and supersedes resemble, shown on the card before the press.",
					"items":       map[string]interface{}{"type": "object"},
				},
				"rewrites": map[string]interface{}{
					"type":        "array",
					"description": "In a wiki chat: the sections the card's press would rewrite, each with where it is and its title.",
					"items":       map[string]interface{}{"type": "object"},
				},
				"ops": map[string]interface{}{
					"type":        "array",
					"description": "One answer per op, by its 0-based position in the request.",
					"items": obj(map[string]interface{}{
						"seq":    map[string]interface{}{"type": "integer"},
						"status": map[string]interface{}{"type": "string", "enum": []string{"pending", "applied", "conflict", "refused", "draft"}},
						"opId":   map[string]interface{}{"type": []string{"string", "null"}},
						"entryId": map[string]interface{}{
							"type":        []string{"string", "null"},
							"description": "The entry the op is about; null on a dry run, which records nothing.",
						},
						"revision":        map[string]interface{}{"type": []string{"integer", "null"}, "description": "applied: the revision that was written."},
						"baseRevision":    map[string]interface{}{"type": "integer", "description": "conflict: the revision the op was written against."},
						"currentRevision": map[string]interface{}{"type": "integer", "description": "conflict: the revision the entry is at now."},
						"current":         map[string]interface{}{"type": "object", "description": "conflict: the entry's current content, as changes over the base."},
						"diff":            map[string]interface{}{"type": "string", "description": "conflict: what changed between the two revisions."},
						"reasons": map[string]interface{}{
							"type":        "array",
							"description": "refused: why, each with the contract's code.",
							"items": obj(map[string]interface{}{
								"code":    str,
								"message": str,
								"errors":  map[string]interface{}{"type": "array", "items": map[string]interface{}{"type": "object"}},
							}, "code", "message"),
						},
						"similar": map[string]interface{}{
							"type":        "array",
							"description": "add or supersede: the entries this one resembles, so a duplicate is visible before the owner sees it.",
							"items":       map[string]interface{}{"type": "object"},
						},
					}, "seq", "status"),
				},
			}, "ops"),
			// readOnlyHint false and destructiveHint false, both said out loud: a proposal writes,
			// and what it writes takes nothing away from anybody — the entry an amendment is about
			// keeps its earlier revisions, and a retire is the owner's to accept.
			// (design §5.2: wiki_propose carries no destructiveHint.)
			"annotations": map[string]interface{}{"readOnlyHint": false, "destructiveHint": false},
		},
		{
			"name":        "wiki_note",
			"description": wikiNoteDescription,
			"inputSchema": obj(map[string]interface{}{
				"text": map[string]interface{}{
					"type":        "string",
					"maxLength":   wikiNoteTextMaxChars,
					"description": "The claim, in one or two sentences, at most " + strconv.Itoa(wikiNoteTextMaxChars) + " characters.",
				},
				"paths": map[string]interface{}{
					"type":        "array",
					"maxItems":    wikiNotePathsMax,
					"items":       map[string]interface{}{"type": "string", "maxLength": wikiNotePathMaxChars},
					"description": "Repo-relative paths the claim is about, at most " + strconv.Itoa(wikiNotePathsMax) + ": they are kept with its text, and help maintenance find the records that bear on it.",
				},
				"corrects": map[string]interface{}{
					"type":        "string",
					"description": "The id of an entry this says is wrong, as wiki_search returned it. The entry is flagged at once, and the owner answers the flag in Review. In a wiki chat the flag is a card the owner may apply instead.",
				},
				"replaces": map[string]interface{}{"type": "string", "description": wikiReplacesDescription},
			}, "text"),
			"outputSchema": obj(map[string]interface{}{
				"noted":   map[string]interface{}{"type": "boolean", "description": "True: the claim is kept. It is not in the wiki."},
				"noteId":  map[string]interface{}{"type": "string", "description": "The note the claim is kept as."},
				"created": map[string]interface{}{"type": "boolean", "description": "False when the space already held this text, so nothing new was written."},
				"readBy":  map[string]interface{}{"type": "string", "description": "What reads the note against the session's records, in the server's words."},
				"challenged": obj(map[string]interface{}{
					"status":      map[string]interface{}{"type": "string", "enum": []string{"applied", "pending", "refused", "draft"}, "description": "refused: the entry is not flagged, and reasons say why. draft, in a wiki chat: the flag is a card for the owner to apply, and the entry is not flagged yet. Anything else: it is flagged. The note is kept either way."},
					"draftId":     map[string]interface{}{"type": "string", "description": "draft: the card the flag became."},
					"changesetId": map[string]interface{}{"type": []string{"string", "null"}},
					"opId":        map[string]interface{}{"type": []string{"string", "null"}},
					"entryId":     map[string]interface{}{"type": []string{"string", "null"}},
					"reasons":     map[string]interface{}{"type": "array", "items": map[string]interface{}{"type": "object"}},
				}, "status"),
			}, "noted", "noteId", "created", "readBy"),
			// It keeps a claim, and at most flags an entry for the owner to answer: nothing is taken away.
			"annotations": map[string]interface{}{"readOnlyHint": false, "destructiveHint": false},
		},
		{
			"name":        "wiki_draft",
			"description": wikiDraftDescription,
			"inputSchema": obj(map[string]interface{}{
				"kind": map[string]interface{}{
					"type":        "string",
					"enum":        wikiDraftKinds,
					"description": "rewrite: these sections lag behind main and are written again from it. plan: a change to how documents are planned or written — one or several in one card — sent as change.",
				},
				"sections": map[string]interface{}{
					"type":     "array",
					"minItems": 1,
					"maxItems": wikiDraftSectionsMax,
					"items": obj(map[string]interface{}{
						"doc":     map[string]interface{}{"type": "string", "description": "The document's slug, as the page and its attachments name it."},
						"section": map[string]interface{}{"type": "string", "description": "The section's key."},
					}, "doc", "section"),
					"description": "rewrite: 1 to " + strconv.Itoa(wikiDraftSectionsMax) + " written sections of the confirmed plan, each { doc, section }.",
				},
				"change": map[string]interface{}{"type": "object", "description": "plan: the change, { docs, categories? } — docs, each document " +
					"whole as it should read (the plan page attaches one), one of the plan's by its slug or a new one; categories, the ones " +
					"it opens that the plan does not have. One card changes several documents at once: to split a document, send it without " +
					"the sections that move and a new document holding them. A writing requirement goes into the covers of the sections it " +
					"is for: the writer reads covers, so the next rewrite keeps it."},
				"reason": map[string]interface{}{
					"type":        "string",
					"description": "Why, in a sentence or two: what lags behind main, or what the plan should do. The card shows it.",
				},
				"replaces": map[string]interface{}{"type": "string", "description": wikiReplacesDescription},
				"idempotencyKey": map[string]interface{}{
					"type":        "string",
					"minLength":   1,
					"maxLength":   200,
					"description": "Required, and yours to choose: the same key with the same request answers with the card it made.",
				},
			}, "kind", "reason", "idempotencyKey"),
			"outputSchema": obj(map[string]interface{}{
				"status":   map[string]interface{}{"type": "string", "enum": []string{"draft"}, "description": "draft: a card for the owner to press; nothing was written."},
				"draftId":  map[string]interface{}{"type": "string", "description": "The card. Pass it as replaces when you revise it."},
				"kind":     map[string]interface{}{"type": "string", "enum": wikiDraftKinds},
				"replayed": map[string]interface{}{"type": "boolean", "description": "True when this is the card an earlier call under the same idempotencyKey made."},
				"rewrites": map[string]interface{}{
					"type":        "array",
					"description": "The sections the press would rewrite, each with where it is and its title.",
					"items":       map[string]interface{}{"type": "object"},
				},
			}, "status", "draftId", "kind"),
			// It makes a card and nothing else: no accept, no confirm, no page overwritten (contract `notTools`).
			"annotations": map[string]interface{}{"readOnlyHint": false, "destructiveHint": false},
		},
	}
}

// fileToolDescriptors is the agent-facing contract of the file tools. Not gated on orchestration: keeping and reading
// back your own files is no power over anybody else's session.
func fileToolDescriptors(obj func(map[string]interface{}, ...string) map[string]interface{}) []map[string]interface{} {
	return []map[string]interface{}{
		{
			"name": "file_upload",
			"description": "Keep a file or a folder in Orbit instead of in the repository: this is where screenshots and " +
				"reports go. It returns id, sha256, sizeBytes and link, an orbit-attachment: link to put in a reply as " +
				"![name](link) for an image or [name](link) for anything else. A directory becomes one folder bundle with " +
				"a manifest of its relative paths, and each file is listed with its own id. Symbolic links are not " +
				"followed; they, empty files and anything else that cannot be kept are listed under skipped. One file may " +
				"be 25 MiB and a folder " + strconv.Itoa(fileBundleMaxFiles) + " files; a folder over either is refused whole. " +
				"A file expires 14 days after upload unless evidence cites it; once a version citing it is sent back or " +
				"replaced, 30 days after that. Its name, size, sha256 and test summary stay; only the bytes go. Use pin or " +
				"file_pin for a file that has to outlast that.",
			"inputSchema": obj(map[string]interface{}{
				"path": map[string]interface{}{
					"type": "string",
					"description": "The file or directory, absolute or relative to the working directory. Its real " +
						"location, links resolved, has to be inside this session's checkout or its uploads directory, " +
						"as with a file a reply links; anywhere else is refused, so copy a file there first.",
				},
				"taskId": map[string]interface{}{
					"type": "string",
					"description": "The task this session is running; leaving it out means the same. A file stays with the " +
						"session that uploads it and counts as that session's task, so any other task's id is refused. To " +
						"give a file to another task as an input, use task_create's attachmentIds; a folder goes file by " +
						"file, by the ids in its files list.",
				},
				"label": map[string]interface{}{
					"type":        "string",
					"maxLength":   fileLabelMaxChars,
					"description": "What this is, in a few words, kept with the file. On a directory it is the bundle's.",
				},
				"as": map[string]interface{}{
					"type": "string",
					"enum": []string{fileAsTestReport},
					"description": "test-report reads one Playwright JSON or JUnit XML report and keeps a summary with the " +
						"file, answered as testReport: total, passed, failed, skipped, duration, and failed and skipped test " +
						"names. It stays after the file expires, and evidence citing the file shows it. Anything else, a " +
						"directory included, is kept as a plain file and note says so.",
				},
				"pin": map[string]interface{}{
					"type":        "boolean",
					"description": "Keep it past the date it would expire on, as file_pin does. On a directory it covers the whole bundle.",
				},
			}, "path"),
			"annotations": map[string]interface{}{"readOnlyHint": false, "destructiveHint": false},
		},
		{
			"name": "file_fetch",
			"description": "Download a file into this session's uploads directory, outside the repository, and return its " +
				"absolute path: one this session uploaded, or one cited by completion evidence this session judges. The " +
				"bytes are checked against the sha256 Orbit holds. Given a folder bundle's " +
				"id, it saves the manifest and lists the bundle's files with their ids, so that you fetch only the ones " +
				"you need.",
			"inputSchema": obj(map[string]interface{}{
				"id": map[string]interface{}{
					"type":        "string",
					"description": "The file's or the bundle's id, as file_upload or file_list gave it.",
				},
			}, "id"),
			// It changes nothing in Orbit, and it does write a file here.
			"annotations": map[string]interface{}{"readOnlyHint": false, "destructiveHint": false},
		},
		{
			"name": "file_pin",
			"description": "Keep a file past the date it would expire on, or with unpin let that date apply again: one " +
				"this session uploaded, or one cited by completion evidence this session judges. A folder bundle's id covers " +
				"the files in it. Pinning an expired file brings it back while its bytes are still kept, and says so if they " +
				"have gone.",
			"inputSchema": obj(map[string]interface{}{
				"id": map[string]interface{}{
					"type":        "string",
					"description": "The file's or the bundle's id, as file_upload or file_list gave it.",
				},
				"unpin": map[string]interface{}{
					"type":        "boolean",
					"description": "Take the pin away. If its date has passed, the file expires at the next cleanup, within the hour.",
				},
			}, "id"),
			"annotations": map[string]interface{}{"readOnlyHint": false, "destructiveHint": false},
		},
		{
			"name": "file_list",
			"description": "List the files of one task, one session or one evidence version, newest first, each with id, " +
				"sha256, sizeBytes and link. With none of the three it lists this session's. A task's files are its inputs " +
				"and what the sessions that ran it kept with file_upload. A folder is one row of kind bundle: file_fetch it " +
				"for the files inside. This says what exists; file_fetch reads this session's own files and those cited by " +
				"evidence it judges.",
			"inputSchema": obj(map[string]interface{}{
				"taskId":     map[string]interface{}{"type": "string", "description": "List this task's files."},
				"sessionId":  map[string]interface{}{"type": "string", "description": "List this session's files."},
				"evidenceId": map[string]interface{}{"type": "string", "description": "List this evidence version's files."},
			}),
			"annotations": map[string]interface{}{"readOnlyHint": true},
		},
	}
}

// bgToolDescriptors is the agent-facing contract for the four tools. It takes
// toolDescriptors' own schema helper so both surfaces are built the same way.
func bgToolDescriptors(obj func(map[string]interface{}, ...string) map[string]interface{}) []map[string]interface{} {
	jobIDProp := map[string]interface{}{
		"type":        "string",
		"description": "The jobId bg_run returned.",
	}
	return []map[string]interface{}{
		{
			"name": "bg_run",
			"description": "Run a command in the background, hosted by the Orbit runner rather than by this" +
				" coding-engine process. Use this instead of Bash with run_in_background: a shell started that" +
				" way is a child of the engine, so recycling the engine (idle TTL, memory pressure) kills it" +
				" mid-build. A job started here ends only when it exits, when the session ends, or when you" +
				" kill it. A merge or commit of this session neither waits for it nor stops it: both run" +
				" beside it and name it in their receipt, and a commit takes any file it is still writing as" +
				" that file stands. Read its output with bg_output. To be woken when it ends or has news, set" +
				" wakeOnExit or wakeOnOutput; to be woken if it goes quiet while still running, set wakeOnStall:" +
				" Orbit then tells this session what happened, even if this coding-engine process has been" +
				" recycled in the meantime — so a wait for CI or a deploy can end your turn instead of holding it" +
				" open. News that comes while you are idle opens a new turn. A job that exits while you are still" +
				" working in a turn is written into that turn, read at your next tool call, where this engine" +
				" accepts a message mid-turn; new output and silence always wait for your next turn. Whether a job" +
				" may start follows this session's permission mode: Plan and Don't Ask refuse it, Default and Accept" +
				" Edits show the owner a card first, in which case this may answer that the job is waiting for them" +
				" (status waiting_for_owner), and Auto and Bypass start it.",
			"inputSchema": obj(map[string]interface{}{
				"command": map[string]interface{}{
					"type":        "string",
					"description": "The shell command, exactly as you would type it. Pipes and redirection are fine — this is one string, not an argv, so no extra quoting is needed.",
				},
				"kind": map[string]interface{}{
					"type": "string",
					"enum": []string{bgKindService, bgKindJob, bgKindWatch},
					"description": "What this process is FOR, which decides what happens to it when the checkout has to be" +
						" drained. \"service\" is valuable while it runs and cheap to restart (dev server, watcher): it is" +
						" killed at once. \"job\" is valuable when it finishes and expensive to restart (build, test suite," +
						" migration): it is waited for. \"watch\" only waits for something else to happen (CI, a deploy, a" +
						" review) — drained like a job, but it does not count against this machine's capacity, so use it" +
						" with wakeOnExit for a long wait; not for Orbit tasks or sessions, which task_await and session_await" +
						" wait for with no process at all. Nothing in a command line tells these apart, so say which.",
				},
				"wakeOnExit": map[string]interface{}{
					"type": "boolean",
					"description": "Wake this session when the command exits, naming the job, how it ended (exit code, or" +
						" why it was killed), the end of its output and the output file: in a new turn, or written into" +
						" the turn you are working in if it exits mid-turn, where this engine accepts a message mid-turn." +
						" Not sent when you kill it yourself or when the session ends.",
				},
				"wakeOnOutput": map[string]interface{}{
					"type": "boolean",
					"description": "Wake this session when the command writes new output. Output gathers for 10 seconds" +
						" before it wakes you, and one job wakes you at most once a minute, so a burst of log lines is" +
						" one turn. For a command that prints only when something happens.",
				},
				"wakeOnStall": map[string]interface{}{
					"type": "object",
					"description": "Wake this session if the command, still running, writes nothing for afterSeconds:" +
						" naming the job, how long it has run, when it last wrote anything, the end of its output and" +
						" the output file. One silence wakes you once, however long it lasts; once the job writes" +
						" again, its next silence of that length wakes you again. For a job that may hang rather than" +
						" fail — or for something outside this machine, run as a polling script that prints only when" +
						" the state it watches changes. A value that is not {\"afterSeconds\": N} with N a whole number" +
						fmt.Sprintf(" of seconds from %d to %d is refused, and the job is not started.", bgWakeOnStallMinSeconds, bgWakeOnStallMaxSeconds),
					"properties": map[string]interface{}{
						"afterSeconds": map[string]interface{}{
							"type":        "integer",
							"minimum":     bgWakeOnStallMinSeconds,
							"maximum":     bgWakeOnStallMaxSeconds,
							"description": "How many seconds without new output count as gone quiet.",
						},
					},
					"required":             []string{"afterSeconds"},
					"additionalProperties": false,
				},
				"cwd": map[string]interface{}{
					"type":        "string",
					"description": "Working directory; defaults to the session's checkout. Must be inside it (or the session's uploads dir).",
				},
				"description": map[string]interface{}{
					"type":        "string",
					"description": "Short human label, shown wherever the job is listed.",
				},
				"env": map[string]interface{}{
					"type":        "object",
					"description": "Extra environment variables, layered over the agent's own.",
				},
			}, "command", "kind"),
		},
		{
			"name": "bg_output",
			"description": "Read a runner-hosted job's output. Returns its status and, once it has ended, the exact exit" +
				" code the runner's own wait() reported. Pass the previous call's nextOffset as sinceOffset to read only" +
				" what is new. The output file belongs to the runner, so this keeps working across an engine restart.",
			"inputSchema": obj(map[string]interface{}{
				"jobId": jobIDProp,
				"tail": map[string]interface{}{
					"type":        "number",
					"description": "Read at most this many bytes from the end (default 16384). Mutually exclusive with sinceOffset.",
				},
				"sinceOffset": map[string]interface{}{
					"type":        "number",
					"description": "Read from this byte offset — the nextOffset of your previous read. Mutually exclusive with tail.",
				},
			}, "jobId"),
		},
		{
			"name": "bg_kill",
			"description": "Stop a runner-hosted job. A job that already ended on its own is reported as it actually" +
				" ended, with its real exit code, rather than as killed.",
			"inputSchema": obj(map[string]interface{}{"jobId": jobIDProp}, "jobId"),
		},
		{
			"name": "bg_list",
			"description": "List this session's runner-hosted background jobs. This is how you find work you left running" +
				" before an engine restart or a compaction — the ids stay valid for the life of the session.",
			"inputSchema": obj(map[string]interface{}{
				"includeFinished": map[string]interface{}{
					"type":        "boolean",
					"description": "Also list jobs that have already ended (default false).",
				},
			}),
		},
	}
}

func taskProgressDescriptor(obj func(map[string]interface{}, ...string) map[string]interface{}, taskIDProp map[string]interface{}) map[string]interface{} {
	return map[string]interface{}{
		"name": "task_progress_report",
		"description": "Report where an Orbit task stands, or read it. A report states a position: a phase (a named " +
			"stage such as \"tests\"), a current count and the total it counts toward, with an optional message for " +
			"whoever reads it. Progress is only what is reported here: Orbit never infers it from your Bash output, a " +
			"transcript, a comment or a message. Only a change of phase, current or total is progress and moves " +
			"lastProgressAt, which a watch waiting for a stall reads; a message alone, or the same report repeated, is " +
			"not progress. Each field you pass replaces that field and null clears it; a field you omit is kept. Given " +
			"none of phase, current, total or message, it reads the progress and its revision instead. With " +
			"expectedRevision the report applies only if the progress is still at the revision you read: on 409 " +
			"PROGRESS_REVISION_CONFLICT, read it again, then report against the revision it shows. A DONE, CANCELLED or " +
			"FAILED task is refused with 409 TASK_NOT_OPEN; reopening it starts a new epoch with nothing reported. " +
			"taskId defaults to the current task.",
		"inputSchema": obj(map[string]interface{}{
			"taskId": taskIDProp,
			"phase": map[string]interface{}{
				"type":        []string{"string", "null"},
				"minLength":   1,
				"maxLength":   taskProgressMaxPhaseChars,
				"description": "The named stage the task is in, such as \"tests\". null clears it.",
			},
			"current": map[string]interface{}{
				"type":        []string{"integer", "null"},
				"minimum":     0,
				"maximum":     taskProgressMaxCount,
				"description": "How many units of the work are done. null clears it; a total needs a current beside it.",
			},
			"total": map[string]interface{}{
				"type":        []string{"integer", "null"},
				"minimum":     1,
				"maximum":     taskProgressMaxCount,
				"description": "How many units there are in all. It needs a current beside it, and current may not pass it. null clears it.",
			},
			"message": map[string]interface{}{
				"type":        []string{"string", "null"},
				"minLength":   1,
				"maxLength":   taskProgressMaxMessageChars,
				"description": "A note for whoever reads the progress. Never progress on its own, and no watch reads it. null clears it.",
			},
			"expectedRevision": map[string]interface{}{
				"type":        "integer",
				"minimum":     0,
				"description": "The revision you last read. The report applies only if the progress is still at it, and is refused with 409 PROGRESS_REVISION_CONFLICT otherwise. Omit it to report regardless.",
			},
		}),
	}
}

func confirmationReviewDescriptor(obj func(map[string]interface{}, ...string) map[string]interface{}) map[string]interface{} {
	list := func(description string, item map[string]interface{}, max int) map[string]interface{} {
		return map[string]interface{}{"type": "array", "maxItems": max, "items": item, "description": description}
	}
	return map[string]interface{}{
		"name": "task_confirmation_review",
		"description": "Record your review of an OWNER_CONFIRMED task's confirmation request — the one an " +
			"<orbit-confirmation-review> block handed you. The owner is not asked until you record it (or its " +
			"window runs out); once you do, their card shows it under REVIEW with your session's name, and Orbit " +
			"writes the card's first line from your lists: the first needsYou question, else how many lines you " +
			"could not check. Your judgment is shown last, quoted. Put each line in the list it belongs to — " +
			"checked, notChecked (with whyNotProven and what you checked instead), needsYou (only what the owner " +
			"alone can decide, each with 2–4 options and the one you recommend; the card preselects it) and " +
			"leftOpen — each with the evidence it rests on. You cannot confirm the task: only the owner can. " +
			"Call it from the turn the block was delivered in; a retry in that turn returns what you already " +
			"recorded. To send the work back to its run instead, use task_confirmation_return.",
		"inputSchema": obj(map[string]interface{}{
			"taskId":      confirmationReviewTaskIDProp(),
			"requestId":   confirmationRequestIDProp(),
			"reviewedSha": confirmationReviewedShaProp(),
			"judgment": map[string]interface{}{
				"type":        "string",
				"minLength":   1,
				"maxLength":   500,
				"description": "Your call, in a sentence or two. Shown last on the card, quoted; it never becomes the first line.",
			},
			"checked": list("What you checked and found to hold (at most 20). "+confirmationReviewItemsNote,
				confirmationReviewItemSchema(nil), 20),
			"notChecked": list("What you could not check (at most 20), each with whyNotProven and, in coordinatorChecked, what you checked instead. "+confirmationReviewItemsNote,
				confirmationReviewItemSchema(map[string]interface{}{
					"whyNotProven":       map[string]interface{}{"type": "string", "maxLength": 500},
					"coordinatorChecked": map[string]interface{}{"type": "string", "maxLength": 500},
				}), 20),
			"needsYou": list("What only the owner can decide (at most 10): a question with 2–4 options and recommendedOption, the index the card preselects. Leave it empty once the owner has already decided. "+confirmationReviewItemsNote,
				confirmationReviewItemSchema(map[string]interface{}{
					"options": map[string]interface{}{
						"type":     "array",
						"minItems": 2,
						"maxItems": 4,
						"items": map[string]interface{}{
							"type": "object",
							"properties": map[string]interface{}{
								"label":       map[string]interface{}{"type": "string", "minLength": 1, "maxLength": 200},
								"description": map[string]interface{}{"type": "string", "maxLength": 500},
							},
							"required":             []string{"label"},
							"additionalProperties": false,
						},
					},
					"recommendedOption": map[string]interface{}{"type": "integer", "minimum": 0},
				}, "options", "recommendedOption"), 10),
			"leftOpen": list("What is left open after this work (at most 20). "+confirmationReviewItemsNote,
				confirmationReviewItemSchema(nil), 20),
		}, "taskId", "requestId", "judgment"),
	}
}

func confirmationReturnDescriptor(obj func(map[string]interface{}, ...string) map[string]interface{}) map[string]interface{} {
	return map[string]interface{}{
		"name": "task_confirmation_return",
		"description": "Send an OWNER_CONFIRMED task's confirmation request back to its run, when something " +
			"must change before the owner looks. Your reason is delivered to the run as its next message, " +
			"signed by Orbit as from its reviewer, and the owner is not asked; the run declares the work " +
			"finished again when it is fixed. Once per request, and at most 3 times between two decisions of the " +
			"owner's — after that, record a review and leave the rest to the owner. Not while the project's " +
			"Automatic is off or its coordinator is paused, nor once the run has ended or the owner has sent it " +
			"back. If the owner has already confirmed the task, this records your problems under their receipt " +
			"and tells them, and the run is not messaged. Call it from the turn the review block was delivered in.",
		"inputSchema": obj(map[string]interface{}{
			"taskId":      confirmationReviewTaskIDProp(),
			"requestId":   confirmationRequestIDProp(),
			"reviewedSha": confirmationReviewedShaProp(),
			"reason": map[string]interface{}{
				"type":        "string",
				"minLength":   1,
				"maxLength":   4000,
				"description": "What must change, delivered to the run as its next message.",
			},
			"problems": map[string]interface{}{
				"type":        "array",
				"minItems":    1,
				"maxItems":    10,
				"items":       confirmationReviewItemSchema(nil),
				"description": "What is wrong (1–10 lines), each with its evidence. " + confirmationReviewItemsNote,
			},
		}, "taskId", "requestId", "reason", "problems"),
	}
}

// sessionReplyDescriptor is the recipient's tool: the answer to a request it was sent.
func sessionReplyDescriptor(obj func(map[string]interface{}, ...string) map[string]interface{}) map[string]interface{} {
	return map[string]interface{}{
		"name": "session_reply",
		"description": "Answer a run question (<orbit-run-question>) with answers, one entry per question: " +
			"{question: index, option: index}, {question: index, options: [indices]} for multiple choice, or {question: index, text: words}. " +
			"If the decision belongs to the owner, use ask_owner with forRunQuestion and your recommendation first. " +
			"For a run question the answer resolves the blocked question tool; it does not queue a reply turn. " +
			"Otherwise answer a request another Orbit session sent you — a message whose " +
			"<orbit-session-message> block carries request-id and asks for a reply. Give `option` (the index " +
			"of the answer you choose) when it offered options, `message`, or both; without options, " +
			"`message` is required. If you cannot do what was asked, say so here: an answer is better than " +
			"none. The asker gets it as a turn of its own. Only the session the request was sent to can " +
			"answer it, and only once — a request that already has an outcome is refused with " +
			"REQUEST_CLOSED (send an ordinary session_send to add something after that).",
		"inputSchema": obj(map[string]interface{}{
			"answers": map[string]interface{}{"type": "array", "items": obj(map[string]interface{}{
				"question": map[string]interface{}{"type": "integer", "minimum": 0},
				"option":   map[string]interface{}{"type": "integer", "minimum": 0},
				"options":  map[string]interface{}{"type": "array", "items": map[string]interface{}{"type": "integer", "minimum": 0}},
				"text":     map[string]interface{}{"type": "string"},
			}, "question")},
			"requestId": map[string]interface{}{"type": "string", "description": "The request-id from the <orbit-session-message> or <orbit-run-question> block."},
			"message":   map[string]interface{}{"type": "string", "description": "Your answer, in words."},
			"option":    map[string]interface{}{"type": "integer", "minimum": 0, "maximum": 3, "description": "The index of the option you choose, when the request offered options."},
		}, "requestId"),
	}
}

var agentCLICapabilities = []cliCapabilitySpec{
	{Tool: "agent_list", Argv: []string{"orbit", "agent", "list"}, Usage: "orbit agent list [--json]", Arguments: []string{"--json"}},
	{Tool: "agent_create", Argv: []string{"orbit", "agent", "create"}, Usage: "orbit agent create --name NAME [options]", Arguments: []string{"--name <text> (required)", "--description <text>", "--system-prompt <text>", "--append-system-prompt <text>", "--work-dir <path>", "--runner-id <id>", "--enable-worktree[=true|false]", "--env <KEY=VALUE> (repeatable; replaces all)", "--default-merge-target <branch>", "--json"}, Mutates: true},
	{Tool: "agent_update", Argv: []string{"orbit", "agent", "update"}, Usage: "orbit agent update AGENT_ID [options]", Arguments: []string{"[agent-id] (required)", "--name <text>", "--description <text>", "--system-prompt <text>", "--append-system-prompt <text>", "--work-dir <path>", "--runner-id <id>", "--enable-worktree[=true|false]", "--env <KEY=VALUE> (repeatable; replaces all)", "--default-merge-target <branch>", "--json"}, Mutates: true},
	{Tool: "agent_delete", Argv: []string{"orbit", "agent", "delete"}, Usage: "orbit agent delete AGENT_ID [--json]", Arguments: []string{"[agent-id] (required)", "--json"}, Mutates: true},
}

var providerCLICapabilities = []cliCapabilitySpec{
	{Tool: "provider_list", Argv: []string{"orbit", "provider", "list"}, Usage: "orbit provider list [--json]", Arguments: []string{"--json"}},
	{Tool: "provider_create", Argv: []string{"orbit", "provider", "create"}, Usage: "orbit provider create --label LABEL --base-url URL (--api-key KEY | --api-key-file -) --models JSON [options]", Arguments: []string{"--label <text> (required)", "--runtime <claude|codex|kimi|antigravity|cursor> (the protocol the endpoint speaks: Anthropic Messages, OpenAI Responses, Moonshot, Gemini or a Cursor User API Key; it decides which engines can run the key)", "--base-url <url> (required but for --runtime cursor; resolved on the runner the session runs on)", "--api-key <key> | --api-key-file - (required)", "--models <json array> (required but for --runtime cursor; [{value,label,contextWindow?,reasoningLevels?}])", "--default-model <model id>", "--json"}, Mutates: true},
	{Tool: "provider_update", Argv: []string{"orbit", "provider", "update"}, Usage: "orbit provider update SLUG [options]", Arguments: []string{"[slug] (required)", "--label <text>", "--runtime <claude|codex|kimi|antigravity|cursor> (the protocol the endpoint speaks)", "--base-url <url>", "--api-key <key> | --api-key-file -", "--models <json array> (replaces the list)", "--default-model <model id>", "--json"}, Mutates: true},
	{Tool: "provider_delete", Argv: []string{"orbit", "provider", "delete"}, Usage: "orbit provider delete SLUG [--json]", Arguments: []string{"[slug] (required)", "--json"}, Mutates: true},
}

var projectCLICapabilities = []cliCapabilitySpec{
	{Tool: "project_get", Argv: []string{"orbit", "project", "get"}, Usage: "orbit project get PROJECT_ID [--json]", Arguments: []string{"[project-id] (required)", "--json"}},
	{Tool: "project_integration_get", Argv: []string{"orbit", "project", "integration"}, Usage: "orbit project integration PROJECT_ID [--job-id ID] [--claim N] [--round N] [--check N] [--cursor CURSOR] [--timeline-cursor CURSOR] [--json]", Arguments: []string{"[project-id] (required)", "--job-id <id> (narrow the read to one job)", "--claim <n> (narrow the page to one claim generation, from 0)", "--round <n> (narrow the page to one round inside the claim, from 0, the facts before its first round)", "--check <n> (narrow the check log to one check's position, from 1)", "--cursor <cursor> (continue the check log page)", "--timeline-cursor <cursor> (continue the attempt timeline page)", "--json"}, Description: "Read this project's integration line: every QUEUED and RUNNING job across all three kinds (LAND_TASK, CHECK_PROMOTION, LAND_PROMOTION) in the queue's order, why each waits or where it stopped (blockingReason), every current generation with its jobId, generation, state, phase, errorCode, round and the check it is running, each task's newest landing, and each live or last-merged candidate's newest check and merge. Read this instead of querying the production database: these are the same facts, served by the interface that is allowed to serve them. Read only. Inside a session the acting session must belong to the project — its coordinator, a session of one of its tasks, or a child of one; another project's session is refused, as is another account's project. --job-id names one attempt and serves what its checks printed under `log` and its timeline under `timeline`; --claim, --round and --check narrow either page, --cursor continues the log page and --timeline-cursor continues the timeline page."},
	{Tool: "project_crossings", Argv: []string{"orbit", "project", "crossings"}, Usage: "orbit project crossings PROJECT_ID [--state STATE] [--json]", Arguments: []string{"[project-id] (required)", "--state <PENDING|APPROVED|DENIED|APPLIED> (only crossings in that state)", "--json"}, Description: "Read every declared cross-project crossing this project is an end of, in BOTH directions — the ones asking to move work INTO it and the ones asking to move work OUT. Each row names the two ends by title and by id, what the crossing is about, its state, the crossing key that identifies the move itself, and when it was asked, answered and expires. Read it when a write was refused CROSS_PROJECT_APPROVAL_REQUIRED or APPROVAL_PENDING: that refusal is about a row in this list, and this is how you learn whether the question has been asked, is still waiting, was refused, or has already been spent. Read only, and deliberately: the approver of a cross-project crossing is the USER, never the target project's coordinator — one agent accepting work on another goal's behalf is the failure the boundary exists to prevent — so point the account owner at the project page to answer it."},
	{Tool: "project_ensure_coordinator", Argv: []string{"orbit", "project", "ensure-coordinator"}, Usage: "orbit project ensure-coordinator PROJECT_ID [--json]", Arguments: []string{"[project-id] (required)", "--json"}, Description: "The session that coordinates this project, opening a replacement ONLY when the conversation the project points at can no longer be handed a message — no runner, an offline runner, a run that never started, a row in Trash, or a run that was replaced (§13.6 SU6) — and never displacing a conversation that can still receive one: alive, or ended in a way its runner can still revive, comes back as created:false with that same sessionId and not one row written. So created:false means that session is the one to send to (`orbit session send --resume-if-ended`), and created:true carries replacedSessionId and replaceReason saying what the replacement left behind. The refusal that stays is COORDINATOR_UNAVAILABLE (owner: USER, requiredAction: rebind): the project's coordination workspace is disabled, trashed or no longer recorded, and where a project's coordination lives is the account owner's decision (§8.2) — so that refusal is theirs to act on, and a retry answers the same thing. The acting session is never the one replaced, and a project with no coordinator at all gets its FIRST one, freely landed where its work already runs. This command acts for the session it runs in, and it is advertised only where the orchestration grant it spends exists.", Mutates: true, RequiresOrchestration: true},
	{Tool: "project_send", Argv: []string{"orbit", "project", "send"}, Usage: "orbit project send PROJECT_ID (--message TEXT | --message-file -) [--client-turn-id ID] [--json]", Arguments: []string{"[project-id] (required)", "--message <text> | --message-file - (required)", "--client-turn-id <id> (idempotency key: repeat it on a retry to get the same turn back)", "--expect-reply", "--reply-options <json array of {label, description}>", "--reply-within-seconds <n> (60-2592000)", "--json"}, Description: "Hand one message to this project's coordinator, addressed by the PROJECT rather than by a session id: the conversation is resolved at the moment the message is DELIVERED, which is the whole of what this adds to project_ensure_coordinator — the id that call answers with is invalidated by a rotation the caller cannot see, and a message sent to it then reaches a reader instead of the project. A conversation that can be handed the message is delivered to and NOT displaced, an ended one whose runner can still revive it included: that case is a REVIVE (what `orbit session send --resume-if-ended` does) rather than a replacement. Only a conversation that cannot take a message at all is replaced — by the same rotation ensure-coordinator performs — and the message goes to the replacement in the same call. The response says what happened rather than what was asked for: created and sessionId name the conversation the message is on, and replacedSessionId/replaceReason are present only when this call rotated to get there. The refusal that stays is COORDINATOR_UNAVAILABLE (409, owner: USER, requiredAction: rebind) — where a project's coordination lives is the account owner's decision, so that one is theirs to act on and a retry answers the same thing — while a write refused after a coordinator WAS found comes back as COORDINATOR_MESSAGE_UNDELIVERED with the sentence that refused it inside. --client-turn-id is the key the message is written under and what makes a retry safe: repeat a call whose answer you never saw with the same key and the same message, and you get that same turn back instead of a second copy; omitted, the server mints one and every call is a new message. The acting session is the authority and there is no headless form: an agent delivers from a session this runner is running, and this command is advertised only where the orchestration grant it spends exists. --expect-reply makes it a request to the coordinator it is delivered to: the call returns at once with requestId and replyBy, and the outcome comes back to this session as a turn.", Mutates: true, RequiresOrchestration: true},
	{Tool: "project_blocker_resolve", Argv: []string{"orbit", "project", "resolve-blocker"}, Usage: "orbit project resolve-blocker PROJECT_ID --blocker-id ID --reason TEXT [--json]", Arguments: []string{"[project-id] (required)", "--blocker-id <id> (required; as 'orbit project get' spells it in blockers.open[].id)", "--reason <text> (required; why this no longer blocks)", "--json"}, Description: "End one of a project's open blockers, saying why it no longer blocks — the write half of what `orbit project get` shows in blockers.open. Run from inside a session it first puts the blocker and your reason on a confirmation card and waits for the account owner's answer: nothing is written if they decline, and the reason they give says what they want instead. Typed at a terminal outside a session there is nobody to ask and the resolution is written straight away, because that caller is the owner. Resolve one when you can say what changed — the work landed, the question was answered elsewhere, the condition no longer holds — and not to get past a wait you disagree with: a HUMAN_DECISION_REQUIRED blocker is the project asking for a judgment, and the card is where you argue for it rather than a formality around it. An agent's resolution records resolved_by = COORDINATOR with the reason it gave; a resolution is final, so an already-resolved blocker is refused rather than restated, and a condition that returns raises a new episode.", Mutates: true},
	{Tool: "integration_request_promotion", Argv: []string{"orbit", "project", "request-promotion"}, Usage: "orbit project request-promotion PROJECT_ID --reason TEXT [--json]", Arguments: []string{"[project-id] (required)", "--reason <text> (required; why this promotion is needed now)", "--json"}, Description: "Request a promotion as the project's current coordinator conversation. Consumed once a candidate is created; normal checks and merge authorization still apply.", Mutates: true, SessionOnly: true},
	{Tool: "integration_skip_merge_check", Argv: []string{"orbit", "project", "skip-merge-check"}, Usage: "orbit project skip-merge-check PROJECT_ID TASK_ID --reason TEXT [--json]", Arguments: []string{"[project-id] (required)", "[task-id] (required; the DONE task whose failed landing should go on without the project's merge check)", "--reason <text> (required; why this check should not hold up this landing)", "--json"}, Description: "Queue ONE landing of a DONE task again with the project's merge check NOT RUN — skipped, never passed — and only with the account owner's yes. For the red that is about the check rather than the delivery: a command that cannot pass where the runner runs it. Every other door is wrong for that red: integration_retry runs the same command against the same machine and is red again by construction, task_reopen sends back work that is not at fault, and the check COMMAND is the owner's to change. Inside a session it first puts the project, the task, the check command and your reason on a confirmation card and waits for the owner's answer: a decline queues nothing and the landing stands as it failed. Typed at a terminal as yourself (`orbit login`) there is no card, because you are the person it would ask, and the row records you as the one who approved it. Only a landing that stopped on a check qualifies; a conflict is the branch's and an integration error is the machinery's (integration_retry answers those). The project's mergeCheckCommand setting is untouched: the next landing and every merge into main are checked as before, and the generation this queues records the skipped check, the reason and who approved it. Only the conversation the project is coordinated from may ask, and only where the failure is still the coordinator's to decide.", Mutates: true},
	{Tool: "project_request_start", Argv: []string{"orbit", "project", "request-start"}, Usage: "orbit project request-start PROJECT_ID --line LINE [--automatic[=BOOL]] --max-concurrent-tasks N --why TEXT [options]", Arguments: []string{"[project-id] (required)", "--line <PROJECT_BRANCH|MAIN> (required)", "--project-branch-name <ref> (PROJECT_BRANCH only; a full refs/heads/... ref)", "--upstream-ref <ref> (the project's main branch, a full refs/heads/... ref and a suggestion: leave it out when project get shows integration.lastMainBranch; when that is null, read `git symbolic-ref --short refs/remotes/origin/HEAD` and pass origin/<name> as refs/heads/<name>)", "--automatic[=BOOL] (default on)", "--max-concurrent-tasks <n> (required, 1-100)", "--merge-check-command <text>", "--merge-check-timeout-seconds <n> (that check's budget in seconds; leave it out for the one-hour default)", "--landing-check-command <text>", "--landing-check-timeout-seconds <n>", "--why <text> (required; shown to the owner on the card)", "--json"}, Description: "Ask the account owner to start the project this session coordinates. Until they start it, task_start is refused for its tasks; run this once the plan is written — the criteria stated, the work filed as tasks under the project, and every acceptance criterion served by at least one task. Orbit checks the plan first: a plan that is not ready is refused (START_REQUEST_NOT_READY) with every reason at once and what to do about each — no criteria or no tasks, a criterion no task serves, a task whose assignee is not on a runner, a project branch with no repository — and nothing is filed. A ready plan is filed and the command returns at once with the request's itemId and any warnings (a criterion served only by work that looks like it produces no code and does not declare codeless, tasks set to start by hand, Automatic on a project branch with no merge check) — the coordinator's to act on, which the owner's card does not show; the owner sees a \"Start this project?\" card with the settings as suggestions and Automatic on, and the coordinator is told when the project starts. Asking again replaces the open request; changing the plan before the start voids it. Acts for the session it runs in: only the project's coordinating conversation may ask.", Mutates: true, SessionOnly: true},
	{Tool: "project_request_done", Argv: []string{"orbit", "project", "request-done"}, Usage: "orbit project request-done PROJECT_ID --judgment TEXT (--gaps JSON | --gaps-file -) [--json]", Arguments: []string{"[project-id] (required)", "--judgment <text> (required; your call, shown first on the card)", "--gaps <json array> | --gaps-file - (required; one {criterionKey, title, whyNotProven, coordinatorChecked, evidenceRefs} per thing Orbit cannot prove, [] for none)", "--json"}, Description: "Ask the account owner to record the project this session coordinates done. Orbit records a project done by itself when it can prove every criterion; run this when it cannot and you have checked the project is done anyway, with your call in a sentence or two and one gap per thing Orbit cannot prove — the criterion's key, why Orbit cannot prove it, what you checked instead, and where that evidence is. Orbit checks the project first: one that is not ready is refused (DONE_REQUEST_NOT_READY) with every reason at once and what to do about each — a criterion its work has not met, a task running, queued or IN_PROGRESS, an item waiting on the owner, a landing or a merge into main in flight — and nothing is filed. A ready project is filed and the command returns at once with the request's itemId and a warning for every criterion not landed on main, with why; the owner sees an \"Is this project done?\" card and records the project done on it. Asking again replaces the open request; the project moving before the owner answers voids it. Acts for the session it runs in: only the project's coordinating conversation may ask.", Mutates: true, SessionOnly: true},
	{Tool: "project_merge_evidence", Argv: []string{"orbit", "project", "merge-evidence"}, Usage: "orbit project merge-evidence PROJECT_ID --requirement-id ID --target-branch REF --content-hash SHA256 [options]", Arguments: []string{"[project-id] (required)", "--requirement-id <text> (required)", "--target-branch <ref> (required)", "--content-hash <sha256> (required, 64 hex characters)", "--source <text>", "--detail <json>", "--json"}, Description: "Record what a target branch was observed to CONTAIN — the merge half of a project's acceptance evidence. Hash the content you actually read (a normalized `git grep` result, a blob or tree digest, a rendered diff), never `git branch --contains`: after a squash merge that answer is a guaranteed false negative while the content is plainly there. Same content as the last observation and only the observation time moves; different content writes a new row one refGeneration up and advances the evidence version automatically. Nothing judges the observation: migration 0229 removed the project acceptance judgment, so this records what was seen and stops there.", Mutates: true},
	{Tool: "project_create", Argv: []string{"orbit", "project", "create"}, Usage: "orbit project create --title TITLE [options]", Arguments: []string{"--title <text> (required)", "--goal <text> | --goal-file - (what the work is trying to achieve; max 4,000 characters)", "--acceptance-criteria-items <json array> | --acceptance-criteria-items-file - (every item requires text + verificationMethod)", "--instructions <text> | --instructions-file - (how the work is to be done; max 10,000 characters)", "--workspace-id <id> (open the coordinator in this workspace instead of in the calling session; needs orchestration enabled)", "--integration-line <MAIN|PROJECT_BRANCH>", "--project-branch <ref>", "--upstream-ref <ref>", "--merge-check-command <text>", "--merge-check-timeout-seconds <n>", "--landing-check-command <text>", "--landing-check-timeout-seconds <n>", "--escalate-after-seconds <n>", "--json"}, Description: "Create a project under this runner's owner — the durable context a body of work is carried out from, as opposed to a task, which is one piece of that work. Use --acceptance-criteria-items for project outcomes; each item requires assertion text and a reader-facing verificationMethod. Nothing in Orbit evaluates them: migration 0229 removed the project acceptance judgment, so a criterion is a stated condition and no more. Inside a session it first puts a confirmation card in front of the user and waits for the answer: nothing is created if they decline. The project starts OPEN and holds no tasks; file them with `orbit task create --project-id <id>` afterwards. Inside a session the project is also bound to that session as its coordinator, and to the workspace it runs in, in the same write that creates it — so opening the coordinator later returns to this conversation rather than starting another; one session coordinates at most one project — record a second from the same conversation and the server opens THAT project its own coordinator in the same workspace and says so — and headless there is no session and so no such binding. --workspace-id says the coordinator belongs elsewhere: it OPENS the conversation there, since a project that names a coordination workspace has a coordinator, and it needs orchestration enabled because it names a workspace rather than inheriting one. The whole integration object — the line (where this project's finished tasks land, with the project branch and upstream as full refs), the merge check run on the combined tree before a landing, and the window an exception waits on the coordinator — is the account owner's at creation, so it is accepted at a terminal and refused for an agent session: a merge-check card names the project it changes and this one does not exist yet, and the line is decided at the first integration and locked from then on. A session sets the merge check afterwards with `orbit project update --merge-check-command`, which asks the owner first.", Mutates: true},
	{Tool: "project_update", Argv: []string{"orbit", "project", "update"}, Usage: "orbit project update PROJECT_ID [options]", Arguments: []string{"[project-id] (required)", "--title <text>", "--goal <text> | --goal-file - | --clear-goal", "--acceptance-criteria-items <json array> | --acceptance-criteria-items-file - (structured whole replacement; text + verificationMethod required; only a tightening lands immediately, and [] drops every criterion, which is held)", "--instructions <text> | --instructions-file - | --clear-instructions", "--status <OPEN|DONE|CANCELLED>", "--integration-line <MAIN|PROJECT_BRANCH>", "--project-branch <ref>", "--upstream-ref <ref>", "--merge-check-command <text>", "--merge-check-timeout-seconds <n>", "--landing-check-command <text>", "--landing-check-timeout-seconds <n>", "--delivery-mode <PLATFORM|AGENT_PUSH>", "--non-code <true|false>", "--non-code-reason <text>", "--expected-config-revision <n>", "--json"}, Description: "Update a project you own. The integration settings are two decisions in one object. THE LINE — --integration-line, --project-branch, --upstream-ref — is where this project's finished tasks land (MAIN, or a project branch that reaches main later), and it is the account owner's to choose: accepted at a terminal, refused for an agent session. Unchosen, it is decided at the first integration (code tasks that depend on one another go through a project branch) and locked from then on. --delivery-mode (PLATFORM: Orbit lands finished work; AGENT_PUSH: the agents push it to main themselves, MAIN line only) is the owner's in the same way, and stays changeable after the line locks. THE MERGE CHECK — --merge-check-command, --merge-check-timeout-seconds — is what runs on the combined tree before a landing, and inside a session it is yours to PROPOSE: this command first puts the project, the check as it stands and the check you are asking for on a confirmation card and waits for the account owner, and the change takes effect only if they approve it; nothing is written if they decline, and a second change is a second question, because an approval covers the exact command and timeout it named. At a terminal there is nobody to ask and the write goes straight through. Structured acceptance items are a whole-collection replacement, and only a tightening edit lands immediately — adding an item, reordering, or stepping an item's verificationMethod up the HUMAN → VERIFICATION → EXECUTABLE ladder. Any other edit (dropping an item, rewriting an item's text, or rewording verificationMethod any other way) is held as a proposal for the account owner to decide, reported as acceptanceCriteriaHold with the criteria left as they were; so [] drops every criterion rather than clearing the collection, and is held whenever there is one to drop. Every item requires text and verificationMethod; preserve ids from project_get to retain identity, omit id to add. Nothing evaluates them. At least one flag is required, and --expected-config-revision does not count as one. Only one --*-file flag per invocation, since they all read the same stdin.", Mutates: true},
	{Tool: "project_delete", Argv: []string{"orbit", "project", "delete"}, Usage: "orbit project delete PROJECT_ID [--json]", Arguments: []string{"[project-id] (required)", "--json"}, Description: "Permanently delete an empty project in the account this runner belongs to. This cannot be undone. A project that still holds tasks is refused without deleting or detaching any of them, because a task's project records what that task is for; move those tasks to another project or delete them first.", Mutates: true},
}

var notifyCLICapabilities = []cliCapabilitySpec{
	{
		Tool:        "notify",
		Argv:        []string{"orbit", "notify"},
		Usage:       "orbit notify --message TEXT [--json]",
		Arguments:   []string{"--message <text> (required)", "--json"},
		Description: "In a task run of an Automatic project this goes to the project's coordinator, not to the owner's devices. Read recipient in the result to see who got it: coordinator, or owner when Orbit fell back. Alert the human this runs for on their devices, with a line you write. For when you need something only they can give and are otherwise stuck, or the thing they were waiting for is done — not for progress updates. Inside a session they can reply from the notification. At most one per session per minute; read the result, which says whether anybody was actually alerted.",
		Mutates:     true,
	},
}

var sessionCLICapabilities = []cliCapabilitySpec{
	{Tool: "session_create", Argv: []string{"orbit", "session", "create"}, Usage: "orbit session create (--prompt TEXT | --prompt-file -) [options]", Arguments: []string{"--prompt <text> | --prompt-file - (required)", "--agent-id <id> | --agent-name <name>", "--title <text>", "--model <model>", engineArgument(), "--provider <slug> (the credential: an engine's own sign-in, opencode, an account pool or an API key; orbit provider list names each with the engines it runs)", canonicalPermissionModeFlagSpec(), "--no-worktree (run in the agent's own checkout with no branch or worktree; for work that changes no code)", "--wait[=true|false]", "--json"}, Mutates: true},
	// No MCP tool stands behind this one, so its description is its own: the transcript it imports
	// is on this machine's disk, which the CLI here reads, and an agent asked to bring a terminal's
	// conversation into Orbit runs it as itself. The headless door below describes it for the
	// credential that door answers for.
	{Tool: "session_import", Argv: []string{"orbit", "session", "import"}, Usage: "orbit session import CLAUDE_SESSION_ID [--workspace ID] [--json]", Arguments: []string{"[claude-session-id] (required)", "--workspace <id>", "--json"}, Mutates: true,
		Description: "Import a Claude Code transcript from this machine's ~/.claude/projects as an Orbit session on this runner, whose first message resumes the conversation. The workspace defaults to the one on this machine containing the transcript's recorded cwd; when several do, the import is refused with their ids and --workspace picks one."},
	{Tool: "session_list", Argv: []string{"orbit", "session", "list"}, Usage: "orbit session list [--status STATUS] [--parent-session-id ID] [--json]", Arguments: []string{"--status <PENDING|RUNNING|AWAITING_INPUT|SUCCEEDED|FAILED|CANCELLED|INTERRUPTED>", "--parent-session-id <id>", "--json"}},
	{Tool: "session_search", Argv: []string{"orbit", "session", "search"}, Usage: "orbit session search --query TEXT [--limit N] [--json]", Arguments: []string{"--query <text> (required)", "--limit <n>", "--json"}},
	{Tool: "session_get", Argv: []string{"orbit", "session", "get"}, Usage: "orbit session get SESSION_ID [--summary] [--json]", Arguments: []string{"[session-id] (required)", "--summary (the record shortened to fit 20,000 characters, the collected reply kept whole; what the MCP tool answers by default, where summary=false asks for the full record)", "--json"}},
	{Tool: "session_await", Argv: []string{"orbit", "session", "await"}, Usage: "orbit session await --session-id ID[,ID...] [--until PRESET] [--ttl-seconds N] [--idempotency-key KEY] [--json]", Arguments: awaitCLIArguments("session-id", "sessionIds", sessionAwaitPresets), Mutates: true},
	{Tool: "session_send", Argv: []string{"orbit", "session", "send"}, Usage: "orbit session send SESSION_ID (--message TEXT | --message-file -) [--client-turn-id ID] [--resume-if-ended] [--expect-reply [--reply-options JSON] [--reply-within-seconds N]] [--json]", Arguments: []string{"[session-id] (required)", "--message <text> | --message-file - (required)", "--client-turn-id <id>", "--resume-if-ended", "--expect-reply", "--reply-options <json array of {label, description}>", "--reply-within-seconds <n> (60-2592000)", "--json"}, Mutates: true},
	{Tool: "session_reply", Argv: []string{"orbit", "session", "reply"}, Usage: "orbit session reply REQUEST_ID (--message TEXT | --message-file - | --option N | --answers-json FILE) [--json]", Arguments: []string{"[request-id] (required)", "--message <text> | --message-file -", "--option <n>", "--answers-json <file|->", "--json"}, Mutates: true},
	{Tool: "session_interrupt", Argv: []string{"orbit", "session", "interrupt"}, Usage: "orbit session interrupt SESSION_ID [--message TEXT | --message-file -] [--client-turn-id ID] [--json]", Arguments: []string{"[session-id] (required)", "--message <text> | --message-file -", "--client-turn-id <id>", "--json"}, Mutates: true},
	{Tool: "session_merge", Argv: []string{"orbit", "session", "merge"}, Usage: "orbit session merge SESSION_ID [--target-branch BRANCH] [--wait-seconds N] [--json]", Arguments: []string{"[session-id] (required)", "--target-branch <branch>", "--wait-seconds <n> (1-300; wait for the outcome and return the receipt instead of just queueing)", "--json"}, Mutates: true},
	{Tool: "session_end", Argv: []string{"orbit", "session", "end"}, Usage: "orbit session end SESSION_ID [--json]", Arguments: []string{"[session-id] (required)", "--json"}, Mutates: true},
	{Tool: "session_complete", Argv: []string{"orbit", "session", "complete"}, Usage: "orbit session complete SESSION_ID [--json]", Arguments: []string{"[session-id] (required)", "--json"}, Mutates: true},
	{Tool: "session_delete", Argv: []string{"orbit", "session", "delete"}, Usage: "orbit session delete SESSION_ID [--json]", Arguments: []string{"[session-id] (required)", "--json"}, Mutates: true},
}

// mergeReceiptCLICapabilities are advertised UNGATED, beside the project reads and for the same
// reason they are: recording that a merge happened, and reading what was recorded, is not an
// orchestration power over another session — it is evidence about the caller's own work, and the
// agent most likely to need it is the plain single-session one with no session_* tools at all.
var mergeReceiptCLICapabilities = []cliCapabilitySpec{
	{Tool: "merge_receipt", Argv: []string{"orbit", "session", "merge-receipt"}, Usage: "orbit session merge-receipt SESSION_ID --result RESULT --source-sha SHA --target-branch BRANCH [options]", Arguments: []string{"[session-id] (required)", "--result <MERGED|ALREADY_MERGED|CONFLICT|ERROR> (required)", "--source-sha <sha> (required)", "--target-branch <branch> (required)", "--source-branch <branch>", "--target-sha-before <sha>", "--target-sha-after <sha> (required for MERGED)", "--rebase-base-sha <sha>", "--conflict <path> (repeatable)", "--message <text>", "--json"}, Mutates: true},
	{Tool: "merge_receipts", Argv: []string{"orbit", "session", "merge-receipts"}, Usage: "orbit session merge-receipts SESSION_ID [--limit N] [--json]", Arguments: []string{"[session-id] (required)", "--limit <n>", "--json"}},
}

var runnerCLICapabilities = []cliCapabilitySpec{
	{Tool: "runner_list", Argv: []string{"orbit", "runner", "list"}, Usage: "orbit runner list [--json]", Arguments: []string{"--json"}},
	{Tool: "runner_engine_install", Argv: []string{"orbit", "runner", "install"}, Usage: "orbit runner install --runner-id ID --engine ENGINE [--update] [--wait] [--json]", Arguments: []string{"--runner-id <id> (required)", engineArgument() + " (required)", "--update (every engine CLI on the runner, instead of installing --engine)", "--wait (until the runner reports the outcome)", "--json"}, Mutates: true},
	{Tool: "runner_engine_install_status", Argv: []string{"orbit", "runner", "install-status"}, Usage: "orbit runner install-status --runner-id ID [--json]", Arguments: []string{"--runner-id <id> (required)", "--json"}},
	{Tool: "runner_delete", Argv: []string{"orbit", "runner", "delete"}, Usage: "orbit runner delete --runner-id ID [--json]", Arguments: []string{"--runner-id <id> (required)", "--json"}, Mutates: true},
}

// watchCLICapabilities are listed inside a session only (SessionOnly). session_await is not here: it sits
// with the session commands, behind the orchestration gate session_get is behind.
var watchCLICapabilities = []cliCapabilitySpec{
	{Tool: "watch_create", Argv: []string{"orbit", "watch", "create"}, Usage: "orbit watch create --target KIND:ID [--target KIND:ID ...] (--predicate JSON | --predicate-file -) [options]", Arguments: []string{"--target <TASK|SESSION>:<id> (targets; repeatable, at least one)", "--predicate <json> | --predicate-file - (required; grammar versions 1 to 3)", "--predicate-version <n> (predicateVersion 1, 2 or 3; default: the lowest the predicate needs)", "--action <RESUME_SESSION|NOTIFY_USER> (default RESUME_SESSION)", "--ttl-seconds <n> (60-2592000; default 86400)", "--idempotency-key <key>", "--json"}, Mutates: true, SessionOnly: true},
	{Tool: "watch_get", Argv: []string{"orbit", "watch", "get"}, Usage: "orbit watch get WATCH_ID [--json]", Arguments: []string{"[watch-id] (required)", "--json"}, SessionOnly: true},
	{Tool: "watch_list", Argv: []string{"orbit", "watch", "list"}, Usage: "orbit watch list [--state STATE] [--json]", Arguments: []string{"--state <" + strings.Join(watchStates, "|") + ">", "--json"}, SessionOnly: true},
	{Tool: "watch_update", Argv: []string{"orbit", "watch", "update"}, Usage: "orbit watch update WATCH_ID [--predicate JSON | --predicate-file -] [--ttl-seconds N] [--json]", Arguments: []string{"[watch-id] (required)", "--predicate <json> | --predicate-file -", "--predicate-version <n> (predicateVersion 1, 2 or 3; default: the lowest the predicate needs)", "--ttl-seconds <n> (60-2592000, counted from now)", "--json"}, Mutates: true, SessionOnly: true},
	{Tool: "watch_cancel", Argv: []string{"orbit", "watch", "cancel"}, Usage: "orbit watch cancel WATCH_ID [--json]", Arguments: []string{"[watch-id] (required)", "--json"}, Mutates: true, SessionOnly: true},
	{Tool: "task_await", Argv: []string{"orbit", "task", "await"}, Usage: "orbit task await --task-id ID[,ID...] [--until PRESET] [--ttl-seconds N] [--idempotency-key KEY] [--json]", Arguments: awaitCLIArguments("task-id", "taskIds", taskAwaitPresets), Mutates: true, SessionOnly: true},
}

// wikiCLICapabilities are listed inside a session only (SessionOnly): every one of them reads or
// proposes as the session it runs in, and a terminal outside one has nothing to act for.
var wikiCLICapabilities = []cliCapabilitySpec{
	{
		Tool:  "wiki_search",
		Argv:  []string{"orbit", "wiki", "search"},
		Usage: "orbit wiki search <query> [--kind KIND]... [--topic SLUG] [--path PATH]... [--limit N] [--json]",
		Arguments: []string{
			"[query] (required; the words to look for, or one repo-relative path)",
			"--kind <" + strings.Join(wikiEntryKinds, "|") + "> (kinds; repeatable)",
			"--topic <slug>",
			"--path <repo-relative path> (paths; repeatable)",
			"--limit <n> (1-" + fmt.Sprint(wikiSearchLimitMax) + ")",
			"--json",
		},
		SessionOnly: true,
	},
	{
		Tool:  "wiki_get",
		Argv:  []string{"orbit", "wiki", "get"},
		Usage: "orbit wiki get <id>[,<id>...] [--include WHAT]... [--json]",
		Arguments: []string{
			"[ids] (required; 1 to " + fmt.Sprint(wikiGetIDsMax) + " entry ids, comma-separated or repeated)",
			"--include <" + strings.Join(append(append([]string{}, wikiIncludes...), "none"), "|") + "> (repeatable; default sources)",
			"--json",
		},
		SessionOnly: true,
	},
	{
		Tool:  "wiki_propose",
		Argv:  []string{"orbit", "wiki", "propose"},
		Usage: "orbit wiki propose (--ops JSON | --ops-file -) [--rationale TEXT | --rationale-file -] [--idempotency-key KEY] [--dry-run] [--replaces ID] [--json]",
		Arguments: []string{
			`--ops <json> | --ops-file - (required; the ops array, or a whole {"ops":...} body)`,
			"--rationale <text> | --rationale-file - (required)",
			"--idempotency-key <key> (required)",
			"--dry-run (dryRun)",
			"--replaces <card id> (in a wiki chat)",
			"--json",
		},
		Mutates:     true,
		SessionOnly: true,
	},
	{
		Tool:  "wiki_note",
		Argv:  []string{"orbit", "wiki", "note"},
		Usage: "orbit wiki note (<text> | --text TEXT | --text-file -) [--path PATH]... [--corrects ID] [--replaces ID] [--json]",
		Arguments: []string{
			"[text] | --text <text> | --text-file - (required; one claim, at most " + fmt.Sprint(wikiNoteTextMaxChars) + " characters)",
			"--path <repo-relative path> (paths; repeatable, at most " + fmt.Sprint(wikiNotePathsMax) + ")",
			"--corrects <entry id>",
			"--replaces <card id> (in a wiki chat)",
			"--json",
		},
		Mutates:     true,
		SessionOnly: true,
	},
	{
		Tool:  "wiki_draft",
		Argv:  []string{"orbit", "wiki", "draft"},
		Usage: "orbit wiki draft --kind rewrite --section DOC/KEY... --reason TEXT --idempotency-key KEY [--replaces ID] [--change JSON] [--json]",
		Arguments: []string{
			"--kind <" + strings.Join(wikiDraftKinds, "|") + "> (required)",
			"--section <doc/key> (sections; repeatable, 1 to " + fmt.Sprint(wikiDraftSectionsMax) + ")",
			"--reason <text> (required)",
			"--idempotency-key <key> (required)",
			"--replaces <card id>",
			"--change <json> (plan: the change, { docs, categories? })",
			"--json",
		},
		Mutates:     true,
		SessionOnly: true,
	},
	{
		// A verb with no MCP tool beside it (contract `agentSurface.verify.tool`): it waits for the server's
		// verdicts, which is a command's wait, so its description is its own rather than a descriptor's.
		Tool:  "wiki_verify",
		Argv:  []string{"orbit", "wiki", "verify"},
		Usage: "orbit wiki verify --space ID [--json]",
		Arguments: []string{
			"--space <id> (required; the automatic space this session proposed into)",
			"--json",
		},
		Description: wikiVerifyDescription,
		InputSchema: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"space": map[string]interface{}{"type": "string", "description": "The automatic space this session proposed into."},
			},
			"required": []string{"space"},
		},
		Mutates:     true,
		SessionOnly: true,
	},
}

// wikiImportCLICapabilities is the import's own family table: `orbit wiki import` has no MCP tool
// beside it (contract `import.cli.tool`), so its description and schema are its own, and it acts for
// the session it runs in like every wiki verb.
var wikiImportCLICapabilities = []cliCapabilitySpec{{
	Tool:  "wiki_import",
	Argv:  []string{"orbit", "wiki", "import"},
	Usage: "orbit wiki import --from <dir|file> --space ID [--max-ops N] [--concurrency N] [--state FILE] [--json]",
	Arguments: []string{
		"--from <dir|file> (required; a Markdown file, or a directory of them)",
		"--space <id> (required; the space to import into)",
		"--max-ops <n> (1-30; default 30)",
		"--concurrency <n> (1-8; default 4)",
		"--state <file> (default under $ORBIT_HOME/wiki-import)",
		"--json",
	},
	Description: wikiImportDescription,
	InputSchema: map[string]interface{}{
		"type": "object",
		"properties": map[string]interface{}{
			"from":        map[string]interface{}{"type": "string", "description": "A Markdown file, or a directory whose *.md files are imported."},
			"space":       map[string]interface{}{"type": "string", "description": "The space to import into."},
			"max-ops":     map[string]interface{}{"type": "integer", "minimum": 1, "maximum": wikiImportOpsPerRun, "description": "The ops this run proposes at most."},
			"concurrency": map[string]interface{}{"type": "integer", "minimum": 1, "maximum": wikiImportMaxConcurrency, "description": "The files the server's model reads at once."},
			"state":       map[string]interface{}{"type": "string", "description": "Where this machine remembers the import."},
		},
		"required": []string{"from", "space"},
	},
	Mutates:     true,
	SessionOnly: true,
}}

// fileCLICapabilities are the file tools' commands. upload, fetch and pin are SessionOnly: a terminal outside a session
// has no session for a file to stay with, or uploads directory for one to arrive in.
var fileCLICapabilities = []cliCapabilitySpec{
	{
		Tool:  "file_upload",
		Argv:  []string{"orbit", "file", "upload"},
		Usage: "orbit file upload <path> [--task-id ID] [--label TEXT] [--as test-report] [--pin] [--json]",
		Arguments: []string{
			"[path] (required; a file or a directory)",
			"--task-id <id> (this session's own task; any other is refused)",
			"--label <text>",
			"--as test-report (keep a summary of a Playwright JSON or JUnit XML report)",
			"--pin (keep it past the date it would expire on)",
			"--json",
		},
		Mutates:     true,
		SessionOnly: true,
	},
	{
		Tool:        "file_fetch",
		Argv:        []string{"orbit", "file", "fetch"},
		Usage:       "orbit file fetch <id> [--json]",
		Arguments:   []string{"[id] (required; a file's or a bundle's)", "--json"},
		SessionOnly: true,
	},
	{
		Tool:        "file_pin",
		Argv:        []string{"orbit", "file", "pin"},
		Usage:       "orbit file pin <id> [--unpin] [--json]",
		Arguments:   []string{"[id] (required; a file's or a bundle's)", "--unpin", "--json"},
		Mutates:     true,
		SessionOnly: true,
	},
	{
		Tool:  "file_list",
		Argv:  []string{"orbit", "file", "list"},
		Usage: "orbit file list [--task-id ID | --session-id ID | --evidence-id ID] [--json]",
		Arguments: []string{
			"--task-id <id>",
			"--session-id <id>",
			"--evidence-id <id>",
			"--json",
		},
	},
}

// The commands that act as the person (§7.3), in `orbit capabilities`. Human terminal doors, withheld
// from a running agent (HeadlessOnly): inside a session the CLI acts as the session and ignores
// personal access tokens, so an agent could only be refused by them. No MCP tool stands beside them
// and none is needed — MCP runs only inside sessions (§2) — so each carries its own schema, and the
// parity test, which asks every MCP tool for a command and not the reverse, asks nothing of them.
var userCLICapabilities = []cliCapabilitySpec{
	{
		Tool:  "login",
		Argv:  []string{"orbit", "login"},
		Usage: "orbit login [--server URL] [--name NAME] [--scopes PRESET|LIST] [--expires 90d|never], or orbit login --with-token [--server URL] < token.txt",
		Arguments: []string{
			"--server <url> (default: ORBIT_SERVER_URL, the saved login's server, this runner's server, or the built-in one)",
			"--name <name> (the token's name; default: orbit CLI on <this host's name>)",
			"--scopes <read-only|read-write|scope,scope,...> (default read-only)",
			"--expires <30d|90d|365d|never> (default 90d)",
			"--with-token (read an issued token from stdin, never from an argument, instead of signing in through the browser)",
		},
		Description: "Log in as yourself: ask the server for a personal access token, open <server>/cli-login to approve it signed in to Orbit, wait for it, check it and save it in $ORBIT_HOME/user.json (0600) — or, with --with-token, read one issued under Settings → Access tokens from stdin. Warns when this machine's runner runs as the same OS user, whose agents could read that file.",
		Mutates:     true,
		InputSchema: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"server":    map[string]interface{}{"type": "string", "description": "The Orbit server's URL."},
				"name":      map[string]interface{}{"type": "string", "description": "The token's name."},
				"scopes":    map[string]interface{}{"type": "string", "description": "read-only, read-write, or scopes separated by commas."},
				"expires":   map[string]interface{}{"type": "string", "enum": []string{"30d", "90d", "365d", "never"}},
				"withToken": map[string]interface{}{"type": "boolean", "description": "Read an issued token from stdin instead of signing in through the browser."},
			},
		},
		HeadlessOnly: true,
	},
	{
		Tool:        "logout",
		Argv:        []string{"orbit", "logout"},
		Usage:       "orbit logout [--keep-token]",
		Arguments:   []string{"--keep-token (only remove the saved login; the token keeps working)"},
		Description: "Revoke the personal access token `orbit login` saved and remove $ORBIT_HOME/user.json. Nothing is removed when the server cannot revoke it.",
		Mutates:     true,
		InputSchema: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"keepToken": map[string]interface{}{"type": "boolean", "description": "Only remove the saved login; the token keeps working until it expires or is revoked."},
			},
		},
		HeadlessOnly: true,
	},
	{
		Tool:         "whoami",
		Argv:         []string{"orbit", "whoami"},
		Usage:        "orbit whoami [--json]",
		Arguments:    []string{"--json"},
		Description:  "Show who the CLI acts as — session, service token, you, or this machine's runner — and which rule chose it; as you, the token's email, name, scopes, workspaces and expiry, as the server reports them.",
		InputSchema:  map[string]interface{}{"type": "object", "properties": map[string]interface{}{}},
		HeadlessOnly: true,
	},
	{
		Tool:  "api",
		Argv:  []string{"orbit", "api"},
		Usage: "orbit api [-X METHOD] PATH [--data JSON | --data-file -] [--paginate] [--json]",
		Arguments: []string{
			"-X <GET|POST|PUT|PATCH|DELETE> (default GET, or POST with a body)",
			"<path> (required; under /api, e.g. /api/tasks)",
			"--data <json>",
			"--data-file - (read the JSON body from stdin)",
			"--paginate (follow nextCursor and print every page)",
			"--json",
		},
		Description: "Call the Orbit REST API as yourself with your personal access token, like `gh api`: one request under /api on your server, the answer printed. A non-2xx answer exits non-zero; 401 means the token is invalid, revoked or expired.",
		Mutates:     true,
		InputSchema: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"method":   map[string]interface{}{"type": "string", "enum": []string{"GET", "POST", "PUT", "PATCH", "DELETE"}},
				"path":     map[string]interface{}{"type": "string", "description": "A path under /api, such as /api/tasks."},
				"data":     map[string]interface{}{"type": "string", "description": "The JSON request body."},
				"dataFile": map[string]interface{}{"type": "string", "enum": []string{"-"}, "description": "Read the JSON request body from stdin."},
				"paginate": map[string]interface{}{"type": "boolean", "description": "Follow nextCursor and print every page."},
			},
			"required": []string{"path"},
		},
		HeadlessOnly: true,
	},
}

var baseCLICapabilities = withTaskCompletionCapabilityArgs([]cliCapabilitySpec{
	{Tool: "task_list", Argv: []string{"orbit", "task", "list"}, Usage: "orbit task list [--status STATUS] [--list-id ID] [--project-id ID] [--label L] [--min-priority N] [--limit N | --all] [--cursor C] [--summary] [--json]", Arguments: []string{"--status <OPEN|IN_PROGRESS|DONE|CANCELLED|FAILED>", "--list-id <id>", "--project-id <id> (only tasks filed under this project; unknown or another owner's lists empty)", "--label <labels[,labels...]> (repeatable; matches tasks carrying ALL of them)", "--min-priority <int> (minPriority: only tasks whose priority is at least this; 1 = the ones somebody raised)", "--limit <n> (default 100, max 200)", "--all (every match as NDJSON, paged; excludes --limit)", "--cursor <c> (resume an interrupted --all, or continue a --summary page)", "--summary (summary rows under 20,000 characters, with the next page's cursor; what the MCP tool answers by default, where summary=false asks for full rows)", "--json"}},
	{Tool: "task_labels", Argv: []string{"orbit", "task", "labels"}, Usage: "orbit task labels [--list-id ID] [--json]", Arguments: []string{"--list-id <id>", "--json"}, Description: "Every label in use with its own status breakdown, counted over every task carrying it. One call answers for all labels, where task_list --label answers for one; also how to discover how a label is spelled before filtering on it."},
	{Tool: "task_get", Argv: []string{"orbit", "task", "get"}, Usage: "orbit task get [task-id] [--json]", Arguments: []string{"[task-id] (defaults to ORBIT_TASK_ID)", "--json"}},
	{Tool: "task_evidence_list", Argv: []string{"orbit", "task", "evidence-list"}, Usage: "orbit task evidence-list [task-id] [--summary [--before N]] [--revision N] [--json]", Arguments: []string{"[task-id] (defaults to ORBIT_TASK_ID)", "--summary (the newest 10 revisions in summary form under 20,000 characters; what the MCP tool answers by default, where summary=false asks for the whole ledger)", "--before <n> (with --summary: the page of revisions older than n)", "--revision <n> (one revision in full)", "--json"}, Description: "List immutable structured completion-evidence revisions in task-local order. Reads no comments and depends on no Session lifecycle state."},
	{Tool: "task_evidence_submit", Argv: []string{"orbit", "task", "evidence-submit"}, Usage: "orbit task evidence-submit [task-id] (--evidence JSON | --evidence-file -) [--source-session-id ID] [--idempotency-key KEY] [--json]", Arguments: []string{"[task-id] (defaults to ORBIT_TASK_ID)", "--evidence <JSON object> | --evidence-file - (required)", "--source-session-id <id> (defaults to ORBIT_SESSION_ID)", "--idempotency-key <key> (max 200 characters)", "--json"}, Description: "Submit an explicit structured completion-evidence fact from a task Session. It appends or replays a revision without changing Task or Session state and without adding a comment.", Mutates: true},
	{Tool: "task_create", Argv: []string{"orbit", "task", "create"}, Usage: "orbit task create --title TITLE [options]", Arguments: []string{"--title <text> (required)", "--description <text> | --description-file -", "--assignee-id <id> | --unassigned", "--list-id <id>", "--project-id <id> (file the task under this project; orthogonal to --list-id, must be owned by the caller)", "--handoff-reason <text> (handoff: DECLARE that this create crosses into the project --project-id names, and why. Only meaningful beside an explicit --project-id — a crossing has to name where it is going — and it carries no authority: it makes the crossing askable, and the ACCOUNT OWNER answers. Undeclared, a write into another project is refused PROJECT_SCOPE_MISMATCH; declared, it waits as CROSS_PROJECT_APPROVAL_REQUIRED or APPROVAL_PENDING, read back with `orbit project crossings`)", "--parent-task-id <id> (create it as a subtask of this existing task; must be owned by the caller and in the same project)", "--verifies-task-id <id> (file it as a verification of this existing task: what makes a check a structured relation, and the precondition for a verdict; same project, not itself, and not itself a verification)", "--supersedes-task-id <id> (record in this same write that the new task REPLACES that stopped attempt: the predecessor must be CANCELLED or FAILED, owned by you and in the same project, and must not already have been replaced)", "--acceptance-criteria <text> | --acceptance-criteria-file - (what would settle that this task is done; max 4,000 characters)", "--criterion-key <key> (criterionKey: which of the PROJECT's stated acceptance criteria this work serves, as a key from project_get; required of a project's judgment session and optional for everybody else)", "--codeless[=true|false] (codeless: this work produces no code — a rollout, a walkthrough, research — so it takes no part in its acceptance criterion's landing; no reason is needed at creation)", "--due-date <ISO date>", "--run-at <ISO 8601 date-time> (runAt: a one-time scheduled start, not a deadline — the server's once-a-minute scan starts the task once the time has come, whether or not --auto-run-when-ready is set, and only while it is OPEN, not held, with an assignee bound to a runner, its prerequisites satisfied and no session occupying it; the run it starts clears it)", "--start-now (startNow: start the task as soon as it is created, for work the person wants run now — one approval covers the create and the start, so do not ask them again or run orbit task start after; it writes a --run-at of now, so it cannot be combined with --run-at, and a refused start leaves the task created with the start deferred to the server's once-a-minute scan)", "--fork-from-session (forkFromSession: start the task from this session's work, its uncommitted edits included, on this machine and in its own checkout; refused with FORK_SUBMODULE_NOT_SHAREABLE when a submodule has work the snapshot cannot carry)", "--idempotency-key <key> (idempotencyKey: " + taskCreateIdempotencyKeyDescription + ")", engineArgument() + " (pin the CLI its runs use)", "--provider <slug> (pin where their credential comes from: an engine's own sign-in, opencode, an account pool or an API key; named alone it pins the engine it runs on by default too)", "--model <model>", "--depends-on <id[,id...]> (repeatable)", "--attachment-id <id[,id...]> (repeatable; attachmentIds: copy uploaded attachments you own as task inputs, preserving the originals)", "--label <labels[,labels...]> (repeatable)", "--auto-run-when-ready[=true|false] (autoRunWhenReady: start the task without a manual start once it is ready. " + taskAutoRunUnfiledNoPrerequisites + ")", "--completion-policy <MANUAL|ALL_CHILDREN_DONE|VERIFICATION_PASSED> (how this task's own completion is decided once it has subtasks; MANUAL, the default, never completes it automatically)", "--json"}, Description: "Create a task. Inside a session it is attributed to this agent (ORBIT_AGENT_ID), the same as the MCP task tools; the runner's machine credential has no card-free form of this write, so a headless process must act as the account owner with a personal access token (`ORBIT_USER_TOKEN`) or `orbit login`, which writes through the user route and is recorded as the person. ORBIT_AGENT_ID is also the default assignee. This only records the task unless --start-now is passed; otherwise call task_start when it should run. Inside a session it first puts a confirmation card in front of the user and waits for the answer: nothing is written if they decline. Every runner task creation requires --completion-criterion explicitly; EVIDENCE_JUDGMENT remains available when intended but is never inferred from omission, and verifier, executable, or policy flags do not replace the declaration. --project-id files the task under a project you own, which is orthogonal to --list-id: the project says what the work is for, the list decides how it is dispatched. --parent-task-id makes it a subtask of an existing task, which must be in the same project as this one — pass both flags for a subtask under a project's task, since the project is not inherited from the parent. --acceptance-criteria states what would settle that this task is done — the observable, verifiable result, as opposed to --description, which says what work to perform, and to the project's own acceptance criteria, which settle the whole goal; the server accepts up to 4,000 characters. --acceptance-criteria-file reads it from stdin ('-' only) and cannot be combined with --description-file, which reads the same stream. --supersedes-task-id records, in the same transaction that creates this task, that it replaces an attempt that already stopped: the predecessor keeps the CANCELLED or FAILED it ended with and gains a pointer to this task plus terminalReason SUPERSEDED. Use it instead of creating the replacement and remembering to link it afterwards — the link is what every downstream reader actually consults, and an attempt that never got one is re-dispatched by the control loop as an ordinary unfinished failure.", Mutates: true},
	{Tool: "task_evidence_decide", Argv: []string{"orbit", "task", "evidence-decide"}, Usage: "orbit task evidence-decide [task-id] --decision CONFIRM|SEND_BACK --evidence-revision N [--note TEXT] [--json]", Arguments: []string{"[task-id] (defaults to ORBIT_TASK_ID)", "--decision <CONFIRM|SEND_BACK> (required)", "--evidence-revision <N> (required, as evidence-list returns it)", "--note <text> (required for SEND_BACK, max 4000 characters)", "--json"}, Description: "Record this session's decision about ONE version of a task's completion evidence, as one row and nothing else — no task status, no session state, no comment. The revision answered must still be the task's latest, the criterion the evidence quotes must still be worded the way the project states it today, the deciding session must not have done the work, a session acting for one project may not decide a task in another — a moved task's evidence is decided by the project it is in now — and a run of another task may not decide evidence that is not addressed to it: each refusal carries its code and the action that would clear it. SEND_BACK carries a note saying what the next revision must show and leaves the task OPEN. The deciding Session is ORBIT_SESSION_ID, never a flag.", Mutates: true},
	{Tool: "task_attribution", Argv: []string{"orbit", "task", "attribution"}, Usage: "orbit task attribution [task-id] [--json]", Arguments: []string{"[task-id] (defaults to ORBIT_TASK_ID)", "--json"}, Description: "Read one task's attribution boundary — where this work COUNTS (the project's title, Base62 id and status: the only authoritative attribution there is), where it was NOTICED (the discovery project, trigger event, source task and source session — evidence, and labelled as evidence, because finding work somewhere grants nothing about where it may be filed), the declared cross-project crossing that touches it with the stable code and required action a writer meeting it is given, and the attribution blocker holding it up. The acceptance lane went with migration 0229, which removed the project acceptance judgment: the criteria are still stated, and nothing judges them. Every absent fact is null beside a reason, so \"nothing is holding this up\" and \"this build cannot tell you\" read differently. Read it BEFORE writing where you are not certain the work belongs: the alternative is learning it from the refusal, which is after the decision was made."},
	{Tool: "task_create_batch", Argv: []string{"orbit", "task", "create-batch"}, Usage: "orbit task create-batch (--tasks JSON | --tasks-file -) [--json]", Arguments: []string{"--tasks <json array> | --tasks-file - (required; every item requires explicit completionCriterion, an item that crosses into another project carries \"handoff\": {\"reason\": \"...\"} beside its own projectId, and an OWNER_CONFIRMED item outside an Automatic project carries \"ownerConfirmationReason\")", "--dry-run (judge the plan and write nothing; report where each item would land)", "--idempotency-key <key> (idempotencyKey: " + taskBatchIdempotencyKeyDescription + ")", "--json"}, Description: "Create several tasks in one atomic call — the batch form of task_create. JSON is an array of task objects taking the same fields as task_create, including \"attachmentIds\" (copy uploaded attachments you own as task inputs, preserving the originals) \"runAt\" (an item's one-time scheduled start, as --run-at is on task create) and \"startNow\" (the item's runAt becomes now, so the server's once-a-minute scan starts it after the create; not with \"runAt\") among them; nothing is written unless every item is valid. Every item declares completionCriterion explicitly; EVIDENCE_JUDGMENT is available but never inferred, and verifier, executable, or policy fields do not replace the declaration. An item may carry \"ref\", and a later item may list that ref in \"dependsOnRefs\" to depend on it without knowing its id yet, or name it in \"parentRef\" to be created as a subtask of it — so a plan lands as a tree in one call. The two answer different questions: dependsOnRefs is when an item may run, parentRef is what it is a part of. \"parentTaskId\" is the same link to a task that already exists (same project as the item); one item cannot carry both. Attribution matches task_create: this agent inside a session. Inside a session a real write (not --dry-run) first puts the batch on a confirmation card and waits for the user's answer; nothing is written if they decline. The runner's machine credential has no card-free form of this write — a headless process must act as the account owner with a personal access token (`ORBIT_USER_TOKEN`) or `orbit login`. ORBIT_AGENT_ID is also each item's default assignee. --dry-run judges the plan and writes none of it — not one task, and not even the approval question a declared cross-project crossing would otherwise file — answering instead with where every item WOULD land (project id, title and status), every finding that refuses or warns, and how many rows the real call would add. Use it before filing a plan whose attribution you are not certain of: a refusal tells you which item is wrong, and a dry run tells you where the ones that are RIGHT would go.", Mutates: true},
	{Tool: "task_batch_pin", Argv: []string{"orbit", "task", "batch-pin"}, Usage: "orbit task batch-pin (--task-id ID | --project ID | --list-id ID | --label L) (--engine ENGINE | --clear-engine) (--provider SLUG | --clear-provider) (--model MODEL | --clear-model) [--json]", Arguments: []string{"--task-id <id[,id...]> (repeatable; narrows rather than excludes — naming it beside a filter re-pins the intersection)", "--project <id> (taskIds: re-pin every task filed under this project — the selector this command exists for, since a project of a hundred thousand tasks cannot be spelled as an id list)", "--list-id <id>", "--label <labels[,labels...]> (repeatable; matches tasks carrying ALL of them)", engineArgument() + " | --clear-engine (an engine named alone is checked against every provider pin the selection holds, and the whole batch is refused when one cannot run on it)", "--provider <slug> | --clear-provider (named alone it pins the engine it runs on by default too)", "--model <model> | --clear-model", "--json"}, Description: "Re-pin many tasks at once: set engine, provider and/or model on every task a selector matches, in ONE request that writes only the rows whose pin really changes. The door for \"change the model of every task in this project\", which task_update can only spell as one call per task — a hundred thousand round trips and as many non-HOT rewrites, of the rows whose model did not change included. A row already carrying the target value is not written at all, so its updated_at is not bumped; that column's one reader is the project list's lastActivityAt, so this makes it more accurate, not less. At least one selector is required (a request naming none is refused rather than read as \"every task this owner has\"), and at least one of engine/provider/model (naming none writes nothing). Tasks with a run in flight are re-pinned like any other: a session already holding the task keeps the model it started on, and the disagreement is reported when the NEXT attempt starts, as TASK_RUN_PIN_CONFLICT. Prints {\"changed\": N}.", Mutates: true},
	{Tool: "task_update", Argv: []string{"orbit", "task", "update"}, Usage: "orbit task update [task-id] [options]", Arguments: []string{"[task-id] (defaults to ORBIT_TASK_ID)", "--title <text>", "--description <text> | --description-file -", "--status <OPEN|IN_PROGRESS|DONE|CANCELLED|FAILED> (DONE is refused; satisfy the task's declared criterion instead)", "--assignee-id <id> | --clear-assignee", "--list-id <id> | --clear-list", "--project <id> | --no-project (projectId: which project this task is filed under — how a mis-filing is corrected once the task exists. --no-project takes it out of every project, --project files it under another one. The ACCOUNT OWNER writes either directly; a session acting under a project scope is refused UNMAPPED_PROJECT_WORK for the first and PROJECT_SCOPE_MISMATCH for the second unless it asks for either with --handoff-reason, which files a request, answers CROSS_PROJECT_APPROVAL_REQUIRED or APPROVAL_PENDING and leaves the task where it is. The owner's confirmation moves the task at once, with nothing to send again; read the request with `orbit project crossings` — no agent answers it)", "--handoff-reason <text> (handoff: ASK for the move --project or --no-project names, and why. Needs one of the two — a move has to say where it is going, and --no-project asks for the task to be taken out of every project, from the project it is in and with no --criterion-key — and carries no authority: it files a MOVE_TASK request, and the task stays where it is until the ACCOUNT OWNER confirms it, which moves the task at once with nothing to send again. Only a session whose own project is the move's source or its target may ask, any other is refused PROJECT_SCOPE_MISMATCH; the request carries --project, --handoff-reason and optionally --criterion-key, a criterion of the TARGET project that the task declares once moved, while what it declares in its current project is withdrawn. Out of a settled (DONE or CANCELLED) project only a task serving none of that project's acceptance criteria may move; into a settled project nothing may (PROJECT_REOPEN_REQUIRED))", "--parent-task-id <id> | --clear-parent (move this task under that task, or detach it; same project, never itself or one of its own subtasks)", "--verifies-task-id <id> | --clear-verifies (point this task at the task it verifies, or detach it; refused once this verification has concluded anything)", "--due-date <ISO date> | --clear-due-date", "--run-at <ISO 8601 date-time> | --clear-run-at (runAt: set or move this task's one-time scheduled start, or cancel it; passing neither leaves it as it is)", engineArgument() + " | --clear-engine (pin the CLI its runs use, or clear only that pin; named alone it keeps the provider pin, which then has to run on it)", "--provider <slug> | --clear-provider (pin where their credential comes from, or clear only that pin; named alone it pins the engine it runs on by default too)", "--model <model> | --clear-model", "--acceptance-criteria <text> | --acceptance-criteria-file - | --clear-acceptance-criteria (replaces what would settle that this task is done; max 4,000 characters)", "--criterion-key <key> | --clear-criterion-key (criterionKey: which of the PROJECT's stated acceptance criteria this task serves, as a key from project_get; re-sending the same key re-records that criterion's CURRENT revision, which is how work declared against wording that has since moved is brought up to date, and clearing takes the declaration back without touching the task)", "--codeless[=true|false] (codeless: declare that this task produces no code, which takes it out of its acceptance criterion's landing, or take the declaration back with =false; declaring needs --codeless-reason and is refused for a task that already has commits of its own)", "--codeless-reason <text> (codelessReason: why this task produces no code; required when the call turns the task codeless, stored on the task beside the declaration)", "--depends-on <id[,id...]> (repeatable; replaces all)", "--clear-dependencies", "--label <labels[,labels...]> (repeatable; replaces all) | --clear-labels", "--auto-run-when-ready[=true|false] (autoRunWhenReady: start the task without a manual start once it is ready. " + taskAutoRunUnfiledNoPrerequisites + ")", "--priority <int> | --clear-priority (priority: where this task stands in its list's queue — when the list has more ready tasks than free slots, the server's automatic dispatch gives the next slot to the highest priority first; 0 is the default and equal priorities keep the order they had, a negative value goes after everything left at 0; it starts nothing and gets past no gate, and --clear-priority returns it to 0)", "--completion-policy <MANUAL|ALL_CHILDREN_DONE|VERIFICATION_PASSED> (how this task's completion is decided once it has subtasks)", "--verdict <PASS|FAIL|INCONCLUSIVE> | --clear-verdict (this VERIFICATION task's conclusion about the task it verifies; revoking a PASS reopens a subject VERIFICATION_PASSED had completed)", "--superseded-by-task-id <id> | --clear-superseded ( the later attempt that replaced this one; only a CANCELLED or FAILED task may name one, and it must be in the same project)", "--terminal-reason <SUPERSEDED|ABANDONED> | --clear-terminal-reason (terminalReason: why this task stopped, when its status alone does not say)", "--json"}, Description: "Update a task. Only the flags you pass are sent, so a partial edit never blanks the rest of the task. --project with --handoff-reason asks for a move rather than making one: the request waits for the account owner, and their confirmation moves the task, with nothing to send again. Direct status DONE is refused for every actor; the structured refusal names the declared EXECUTABLE, VERIFICATION, or EVIDENCE_JUDGMENT path. FAILED remains writable as a run's conservative self-report. --parent-task-id moves the task under another task you own and --clear-parent detaches it, which is how a decomposition is corrected once the tasks exist rather than by deleting and recreating them; the parent must be in the same project, and neither a task itself nor one of its own subtasks may be named (both close a loop). It is membership, not ordering — when a task runs is --depends-on. --acceptance-criteria replaces what would settle that this task is done — the observable, verifiable result, as opposed to --description, which says what work to perform, and to the project's own acceptance criteria, which settle the whole goal rather than this one task. It is a whole-field replacement: omitting it preserves the task's current criteria, text replaces them (\"\" records that there are none worth stating), and --clear-acceptance-criteria removes them, which is why clearing cannot be combined with either form. Expect to use it after creation — what proves a task done is often only clear once the work is understood. The server accepts up to 4,000 characters. --acceptance-criteria-file reads the replacement from stdin ('-' only) and cannot be combined with --description-file, which reads the same stream.", Mutates: true},
	{Tool: "task_reopen", Argv: []string{"orbit", "task", "reopen"}, Usage: "orbit task reopen [task-id] [--json]", Arguments: []string{"[task-id] (defaults to ORBIT_TASK_ID)", "--json"}, Description: "Take a stopped task — DONE, CANCELLED or FAILED — back to OPEN in place, so this same task carries the next attempt instead of a new one being filed. History is kept (evidence, comments, dependencies, the project it is filed under, its criterion declaration); the run's progress is not, because reopening starts a new lifecycle epoch. A SUPERSEDED/ABANDONED retirement is cleared in the same write, which is what makes a replaced attempt runnable again — Run refuses one while that record stands. Refusals are the server's own and pass through unread: a verification task carrying a verdict is told to revoke it first.", Mutates: true},
	{Tool: "task_delete", Argv: []string{"orbit", "task", "delete"}, Usage: "orbit task delete [task-id] [--json]", Arguments: []string{"[task-id] (defaults to ORBIT_TASK_ID)", "--json"}, Mutates: true},
	{Tool: "task_start", Argv: []string{"orbit", "task", "start"}, Usage: "orbit task start [task-id] [--json]", Arguments: []string{"[task-id] (defaults to ORBIT_TASK_ID)", "--json"}, Mutates: true},
	{Tool: "task_comment", Argv: []string{"orbit", "task", "comment"}, Usage: "orbit task comment [task-id] (--body TEXT | --body-file -) [--json]", Arguments: []string{"[task-id] (defaults to ORBIT_TASK_ID)", "--body <text> | --body-file - (required)", "--json"}, Description: "Add a comment to a task, authored by this agent inside a session (like the MCP path) or by the runner owner when run headless.", Mutates: true},
	{Tool: "task_request_confirmation", Argv: []string{"orbit", "task", "request-confirmation"}, Usage: "orbit task request-confirmation [task-id] [--json]", Arguments: []string{"[task-id] (defaults to ORBIT_TASK_ID)", "--json"}, Description: "Declare, as this run, that the task's work is finished — the one thing that asks an OWNER_CONFIRMED task's owner. With no declaration there is no card: the task stays OPEN and is confirmed only from its detail panel. Requires ORBIT_SESSION_ID and a turn in flight, and is accepted only from the task's own execution session. The question waits for the turn that ends the run (nothing queued, no background job or sub-workspace of its own in flight, no wake-up it asked for), so declaring while more work is coming asks nothing yet; declaring again in one turn is one declaration. Confirming or sending back is the account owner's own act in the app.", Mutates: true},
	{Tool: "task_confirmation_review", Argv: []string{"orbit", "task", "confirmation-review"}, Usage: "orbit task confirmation-review [task-id] (--input JSON | --input-file -) [--json]", Arguments: []string{"[task-id] (or the input's taskId: the review block's task=\"…\"; no ORBIT_TASK_ID default)", "--input <JSON object> | --input-file - (required): {taskId, requestId, reviewedSha, judgment, checked, notChecked, needsYou, leftOpen}", "--json"}, Description: "Record your review of an OWNER_CONFIRMED task's confirmation request — the one an <orbit-confirmation-review> block handed this session. The owner is not asked until it is recorded or its window runs out; then their card shows it under REVIEW, and Orbit writes the card's first line from your lists (the first needsYou question, else how many lines you could not check). needsYou lines carry 2–4 options and the one you recommend. Only the session the request was handed to may record it, from inside a turn (ORBIT_SESSION_ID); a retry in the same turn returns what was recorded. It cannot confirm the task: only the owner can.", Mutates: true},
	{Tool: "task_confirmation_return", Argv: []string{"orbit", "task", "confirmation-return"}, Usage: "orbit task confirmation-return [task-id] (--input JSON | --input-file -) [--json]", Arguments: []string{"[task-id] (or the input's taskId: the review block's task=\"…\"; no ORBIT_TASK_ID default)", "--input <JSON object> | --input-file - (required): {taskId, requestId, reviewedSha, reason, problems}", "--json"}, Description: "Send an OWNER_CONFIRMED task's confirmation request back to its run, when something must change before the owner looks: the reason is the run's next message and the owner is not asked. Once per request and at most 3 times between two decisions of the owner's; refused while the project's Automatic is off or its coordinator is paused, once the run has ended, or after the owner sent it back. After the owner has confirmed, the problems are recorded under their receipt and they are told instead. Only the session the request was handed to for review may call it, from inside a turn.", Mutates: true},
	{Tool: "task_progress_report", Argv: []string{"orbit", "task", "progress"}, Usage: "orbit task progress [task-id] [--phase TEXT | --clear-phase] [--current N | --clear-current] [--total N | --clear-total] [--message TEXT | --clear-message] [--expected-revision N] [--json]", Arguments: []string{"[task-id] (defaults to ORBIT_TASK_ID)", "--phase <text> | --clear-phase", "--current <n> | --clear-current", "--total <n> | --clear-total (needs a current it bounds)", "--message <text> | --clear-message (never progress on its own)", "--expected-revision <n> (expectedRevision: report only if the progress is still at this revision)", "--json"}, Mutates: true},
	{Tool: "task_dependency_graph", Argv: []string{"orbit", "task", "dependency-graph"}, Usage: "orbit task dependency-graph [task-id] [--max-depth N] [--max-nodes N] [--json]", Arguments: []string{"[task-id] (defaults to ORBIT_TASK_ID)", "--max-depth <n> (server default when unset)", "--max-nodes <n> (server default when unset)", "--json"}},
	{Tool: "task_dependency_add", Argv: []string{"orbit", "task", "dependency-add"}, Usage: "orbit task dependency-add [task-id] --depends-on ID [--json]", Arguments: []string{"[task-id] (defaults to ORBIT_TASK_ID)", "--depends-on <id> (required)", "--json"}, Description: "Add one dependency edge: taskId waits for --depends-on. Point it at the SUBJECT rather than at that subject's verification task: once anything checks that task, the server holds the edge until its latest check has PASSED. An edge naming the check resolves to the same gate, so older plans keep working.", Mutates: true},
	{Tool: "task_dependency_remove", Argv: []string{"orbit", "task", "dependency-remove"}, Usage: "orbit task dependency-remove [task-id] --depends-on ID [--json]", Arguments: []string{"[task-id] (defaults to ORBIT_TASK_ID)", "--depends-on <id> (required)", "--json"}, Mutates: true},
	{Tool: "tasklist_list", Argv: []string{"orbit", "task-list", "list"}, Usage: "orbit task-list list [--json]", Arguments: []string{"--json"}},
	{Tool: "tasklist_create", Argv: []string{"orbit", "task-list", "create"}, Usage: "orbit task-list create --title TITLE [--json]", Arguments: []string{"--title <text> (required)", "--json"}, Mutates: true},
	{Tool: "tasklist_get", Argv: []string{"orbit", "task-list", "get"}, Usage: "orbit task-list get LIST_ID [--json]", Arguments: []string{"[list-id] (required)", "--json"}},
	{Tool: "tasklist_update", Argv: []string{"orbit", "task-list", "update"}, Usage: "orbit task-list update LIST_ID [options]", Arguments: []string{"[list-id] (required)", "--title <text>", "--instructions <text> | --instructions-file -", "--paused[=true|false]", "--verify-on-done[=true|false]", "--max-concurrent <n> | --clear-max-concurrent", "--foreman-workspace-id <id> | --clear-foreman", "--foreman-stall-minutes <n>", "--note <text>", "--json"}, Description: "Change a task list's dispatch policy. In a session the change is attributed to this agent (like the MCP path); headless it falls back to the runner owner. Every change is recorded as a restorable revision.", Mutates: true},
	{Tool: "tasklist_propose_dag", Argv: []string{"orbit", "task-list", "propose-dag"}, Usage: "orbit task-list propose-dag LIST_ID --add A:B [--remove C:D] [--apply] [--json]", Arguments: []string{"[list-id] (required)", "--add <task-id>:<depends-on-id> (repeatable, sets ops)", "--remove <task-id>:<depends-on-id> (repeatable, sets ops)", "--note <text>", "--apply", "--json"}, Description: "Preview a batch of dependency changes to a list's DAG, and with --apply write it. Inside a session it asks exactly as the MCP tool does: the preview fills one approval card, and nothing is written before the answer. A process in no session is the owner's own terminal, so it applies directly. The preview names what would be written and, more usefully, which tasks change dependency state as a result.", Mutates: true},
	{Tool: "tasklist_delete", Argv: []string{"orbit", "task-list", "delete"}, Usage: "orbit task-list delete LIST_ID [--json]", Arguments: []string{"[list-id] (required)", "--json"}, Description: "Delete a task list. Its tasks are not deleted — they are detached and become listless; the grouping, its standing instructions and its policy revisions are what go, and that cannot be undone. To stop dispatch without discarding them, pass --paused true to task-list update instead.", Mutates: true},
})

func withTaskCompletionCapabilityArgs(capabilities []cliCapabilitySpec) []cliCapabilitySpec {
	// Kept beside the flag implementation instead of expanding the already very wide legacy
	// capability literals above. The capability document must name every MCP field the equivalent
	// CLI can send; completionCriterion and EXECUTABLE's pair stay beside their flag implementation.
	for i := range capabilities {
		switch capabilities[i].Tool {
		case "task_create":
			capabilities[i].Arguments = append(
				capabilities[i].Arguments,
				"--fixes-open-item-id <id> (fixesOpenItemId: attach to an OPEN integration/TASK_FAILED item)",
				"--model-hint <S|M|L|XL> (modelHint: suggested difficulty, distinct from the model hard pin)",
				"--model-hint-reason <text> (modelHintReason: one sentence, max 500 characters)",
				"--clear-model-hint (explicitly send null for both suggestion fields)",
				"--completion-criterion <EXECUTABLE|VERIFICATION|EVIDENCE_JUDGMENT> (required for every runner task creation; EVIDENCE_JUDGMENT is never inferred)",
				"--completion-criterion-override-reason <text> (non-blank audit reason for keeping a criterion after TASK_CRITERION_SHAPE_ADVICE)",
				"--owner-confirmation-reason <DEPLOY|IRREVERSIBLE|OWNER_DEVICE_OR_ACCOUNT|OWNER_TRADE_OFF> (ownerConfirmationReason: why only the account owner can settle an OWNER_CONFIRMED task; required of a session declaring it outside an Automatic project, else 409 OWNER_CONFIRMATION_REASON_REQUIRED)",
				"--owner-confirmation-reason-note <text> (ownerConfirmationReasonNote: one sentence beside that reason, max 500 characters)",
				"--acceptance-command <shell> (the one EXECUTABLE command; use with --acceptance-expected-exit-code)",
				"--acceptance-expected-exit-code <n> (exit code that derives DONE; use with --acceptance-command)",
				"--acceptance-timeout-seconds <n> (acceptanceTimeoutSeconds: how long that command may run, 1..86400; omit for the one-hour default)",
				"--verification-title <text> (verification: create the verifier that settles this task, in the SAME call. A task declaring VERIFICATION with completionPolicy VERIFICATION_PASSED is a subject — no work of its own, settled only by a PASS a separate check records — and nothing on the server files that check, so a subject written alone is refused VERIFICATION_SUBJECT_NEEDS_VERIFIER. On the batch door the same pairing is a later item naming this item's ref in verifiesRef)",
				"--verification-assignee-id <id> (the workspace that runs the verifier named by --verification-title)",
				"--verification-description <text> (what that verifier is asked to check)",
			)
		case "task_update":
			capabilities[i].Arguments = append(
				capabilities[i].Arguments,
				"--fixes-open-item-id <id> | --clear-fixes-open-item (fixesOpenItemId: attach or detach a concrete exception fix)",
				"--model-hint <S|M|L|XL> (modelHint: replace the difficulty suggestion; omit to preserve)",
				"--model-hint-reason <text> (modelHintReason: replace its reason verbatim, max 500 characters)",
				"--clear-model-hint (send null to clear both suggestion fields)",
				"--completion-criterion <EXECUTABLE|VERIFICATION|EVIDENCE_JUDGMENT> (replace the task's one normal completion criterion)",
				"--completion-criterion-override-reason <text> (completionCriterionOverrideReason: non-blank reason for CHANGING the criterion, required whenever the write lands on a different one than the task carries — including a change derived from --acceptance-command rather than named; stored beside the criterion left behind)",
				"--owner-confirmation-reason <DEPLOY|IRREVERSIBLE|OWNER_DEVICE_OR_ACCOUNT|OWNER_TRADE_OFF> (ownerConfirmationReason: replace why only the account owner can settle an OWNER_CONFIRMED task; asked when the write lands it there outside an Automatic project)",
				"--owner-confirmation-reason-note <text> (ownerConfirmationReasonNote: replace the sentence beside that reason)",
				"--clear-owner-confirmation-reason (send null to clear the reason and its sentence)",
				"--acceptance-command <shell> (replace the one EXECUTABLE command)",
				"--acceptance-expected-exit-code <n> (replace the exit code that derives DONE)",
				"--acceptance-timeout-seconds <n> | --clear-acceptance-timeout (acceptanceTimeoutSeconds: replace that command's wall-clock budget, or return it to the one-hour default)",
				"--clear-executable-acceptance (clear both EXECUTABLE fields)",
			)
		}
	}
	return capabilities
}

// finishOperationCatalog joins the declared descriptors, the CLI specs and the metadata into the
// rows the surfaces project. It is called once; a duplicate declaration is a programming error and
// panics here rather than letting one surface silently shadow another.
func finishOperationCatalog(ops []*operation) []*operation {
	byTool := make(map[string]*operation, len(ops)+len(catalogMCPExemptions))
	for _, op := range ops {
		if _, dup := byTool[op.Tool]; dup {
			panic("operation catalog: two MCP descriptors named " + op.Tool)
		}
		byTool[op.Tool] = op
	}

	// The CLI specs, in the family lists below. A spec with no descriptor is a CLI-only command
	// and needs a declared reason; a second command for one operation is a bug.
	families := []struct {
		name string
		list []cliCapabilitySpec
	}{
		{"task", baseCLICapabilities},
		{"provider", providerCLICapabilities},
		{"project", projectCLICapabilities},
		{"notify", notifyCLICapabilities},
		{"session", sessionCLICapabilities},
		{"merge", mergeReceiptCLICapabilities},
		{"agent", agentCLICapabilities},
		{"runner", runnerCLICapabilities},
		{"watch", watchCLICapabilities},
		{"wiki", wikiCLICapabilities},
		{"wiki", wikiImportCLICapabilities},
		{"file", fileCLICapabilities},
		{"account", userCLICapabilities},
	}
	for _, family := range families {
		for i := range family.list {
			spec := family.list[i]
			op := byTool[spec.Tool]
			if op == nil {
				reason := catalogMCPExemptions[spec.Tool]
				if reason == "" {
					panic("operation catalog: CLI command " + spec.Tool + " has no MCP descriptor and no declared MCP exemption")
				}
				op = &operation{Tool: spec.Tool, MCPExempt: reason}
				ops = append(ops, op)
				byTool[spec.Tool] = op
			}
			if op.CLI != nil {
				panic("operation catalog: two CLI commands for " + spec.Tool)
			}
			specCopy := spec
			op.CLI = &specCopy
			op.CLIFamily = family.name
		}
	}

	for _, op := range ops {
		meta, declared := catalogMetadata[op.Tool]
		if !declared {
			// Left empty so TestEveryOperationHasCatalogMetadata can name it; a surface still
			// works, it just says nothing about the operation beyond its own text.
			continue
		}
		op.Object = meta.Object
		op.Intent = meta.Intent
		op.Approval = meta.Approval
		op.ApprovalKey = meta.ApprovalKey
		op.ApprovalDetail = meta.ApprovalDetail
		op.Destructive = meta.Destructive
		op.Risk = meta.Risk
		op.Idempotency = meta.Idempotency
		op.Retry = meta.Retry
		op.SuccessEvidence = meta.SuccessEvidence
		op.NextStep = meta.NextStep
		op.Returns = meta.Returns
		op.Exclusive = meta.Exclusive
	}

	for _, op := range ops {
		if op.CLI != nil {
			op.Mutates = op.CLI.Mutates
		} else {
			mutates, declared := catalogMCPOnlyMutations[op.Tool]
			if !declared {
				panic("operation catalog: no CLI spec for " + op.Tool + " and no declared mutation")
			}
			op.Mutates = mutates
		}
		if op.CLI == nil && op.CLIExempt == "" {
			op.CLIExempt = catalogCLIExemptions[op.Tool]
		}
		if op.MCP == nil && op.MCPExempt == "" {
			panic("operation catalog: " + op.Tool + " has neither an MCP descriptor nor a declared MCP exemption")
		}
		if op.MCP != nil && op.CLI == nil && op.CLIExempt == "" {
			panic("operation catalog: " + op.Tool + " is MCP-only with no declared CLI exemption")
		}

		// ── defaults, in the order that matters ──
		if op.Approval == "" {
			op.Approval = approvalKindNone
		}
		if op.Idempotency == "" {
			switch {
			case !op.Mutates:
				op.Idempotency = idempotencyRead
			case catalogCallerKeyOperations[op.Tool]:
				op.Idempotency = idempotencyCallerKey
			default:
				op.Idempotency = idempotencyNone
			}
		}
		if op.Risk == "" {
			switch {
			case op.Destructive || op.Approval != approvalKindNone:
				op.Risk = riskHigh
			case op.Mutates:
				op.Risk = riskMedium
			default:
				op.Risk = riskLow
			}
		}
		if op.Retry == "" {
			op.Retry = catalogRetryRule(op.Idempotency)
		}
		if op.SuccessEvidence == "" {
			if op.Mutates {
				op.SuccessEvidence = "The written entity's id and status in the tool result."
			} else {
				op.SuccessEvidence = "The entity document the read returned."
			}
		}
		if op.Returns == "" {
			op.Returns = catalogReturnsDefault(op)
		}
		// What Plan does with the call: a read runs, its own gate decides where it has one, a write runs only
		// when it changes no work (catalogPlanRunsWrites), and every other write is refused.
		switch {
		case catalogPlanOwnGates[op.Tool] != "":
			op.Plan, op.PlanReason = planOwnGate, catalogPlanOwnGates[op.Tool]
		case !op.Mutates:
			op.Plan = planRuns
		case catalogPlanRunsWrites[op.Tool] != "":
			op.Plan, op.PlanReason = planRuns, catalogPlanRunsWrites[op.Tool]
		default:
			op.Plan = planRefused
		}
		if op.MCP != nil {
			op.MCP.Extra = withCatalogAnnotations(op)
		}

		// Strict input (tool_schema.go): an object that declares its properties is closed to every
		// other key, and the descriptor says so — the schema a caller reads is the one its call is
		// judged by.
		if op.MCP != nil && !openInputTools[op.Tool] {
			op.MCP.InputSchema = closedObjectSchemas(op.MCP.InputSchema)
		}
		// Every receipt tool answers with the receipt (tool_receipt.go); the creates and updates of
		// the five objects, and the start, also advertise its schema as their outputSchema, so a
		// client can check the answer it relies on most.
		if receiptSchemaTools[op.Tool] && op.answersWithReceipt() {
			extra := make(map[string]interface{}, len(op.MCP.Extra)+1)
			for key, value := range op.MCP.Extra {
				extra[key] = value
			}
			extra["outputSchema"] = toolReceiptOutputSchema()
			op.MCP.Extra = extra
		}
	}

	sort.SliceStable(ops, func(i, j int) bool { return ops[i].Tool < ops[j].Tool })
	return ops
}

// withCatalogAnnotations is the descriptor's extra keys with the MCP tool annotations the catalogue states about the
// operation: readOnlyHint (it writes nothing), destructiveHint (a write that destroys, said either way for a write)
// and openWorldHint (catalogOpenWorld). An engine reads these to decide whether a call needs a person, so they are
// what keeps Orbit's own reads from raising one (docs/orbit-agent-contract.md §4.1): Claude Code's Plan mode runs
// a call it is told is read-only and holds any other, and Codex asks for consent only for a call that is not
// read-only and is destructive or open-world. A descriptor that declares annotations of its own keeps them: those
// were written for that tool (the wiki and file tools'), and the catalogue only fills in what they leave out.
func withCatalogAnnotations(op *operation) map[string]interface{} {
	annotations := map[string]interface{}{
		"readOnlyHint":  !op.Mutates,
		"openWorldHint": catalogOpenWorld[op.Tool],
	}
	if op.Mutates {
		annotations["destructiveHint"] = op.Destructive
	}
	extra := make(map[string]interface{}, len(op.MCP.Extra)+1)
	for key, value := range op.MCP.Extra {
		extra[key] = value
	}
	if declared, ok := extra["annotations"].(map[string]interface{}); ok {
		for key, value := range declared {
			annotations[key] = value
		}
	}
	extra["annotations"] = annotations
	return extra
}

// receiptSchemaTools advertise the receipt's schema as their outputSchema: the creates and updates of
// tasks, projects, task lists, sessions and agents (docs/orbit-agent-contract.md §6.1), and the start.
// Every other receipt tool answers with the same document without restating its schema, which is
// published once in contracts/orbit-agent.contract.json.
var receiptSchemaTools = map[string]bool{
	"task_create": true, "task_create_batch": true, "task_update": true, "task_start": true,
	"project_create": true, "project_update": true,
	"tasklist_create": true, "tasklist_update": true,
	"session_create": true,
	"agent_create":   true, "agent_update": true,
}

func catalogRetryRule(kind operationIdempotency) string {
	switch kind {
	case idempotencyRead:
		return "Safe to retry until it answers."
	case idempotencyCallerKey:
		return "Retry only with the same key: the server returns the first result instead of writing twice."
	case idempotencyServerKey:
		return "A redelivered turn's write is deduplicated by the server; a fresh call from a later turn is not — re-read before sending it again."
	default:
		return "Not idempotent: re-read to prove the first attempt did not land before sending it again."
	}
}

func catalogReturnsDefault(op *operation) string {
	if !op.Mutates {
		if op.Object == objectWatch {
			return "The watch document (JSON)."
		}
		return "The " + string(op.Object) + " document (JSON)."
	}
	return "The written " + string(op.Object) + " document, or its id and status (JSON)."
}

// catalogMetadata is the hand-written half of the catalogue: one row per operation. Object and
// Intent are required of every row; the rest is filled by the rule in finishOperationCatalog
// unless the operation needs a narrower statement.
var catalogMetadata = map[string]operationMeta{
	// ── tasks ──
	"task_list": {
		Object: objectTask,
		Intent: "See what work exists, filtered by status, list, project, label or priority.",
	},
	"task_labels": {
		Object: objectTask,
		Intent: "See every label in use and how its tasks are progressing.",
	},
	"task_get": {
		Object: objectTask,
		Intent: "Read one task's full record.",
	},
	"task_evidence_list": {
		Object: objectTask,
		Intent: "Read a task's immutable completion-evidence revisions.",
	},
	"task_evidence_submit": {
		Object:          objectTask,
		Intent:          "Submit a structured completion-evidence revision for a task.",
		SuccessEvidence: "The appended evidence revision and the identity the server recorded with it.",
		NextStep:        "task_evidence_list to read the revision back.",
	},
	"task_evidence_decide": {
		Object: objectTask,
		Intent: "Decide one version of a task's completion evidence, as the session it is addressed to.",
		Risk:   riskHigh,
	},
	"task_attribution": {
		Object: objectTask,
		Intent: "Read where a task counts, where it was noticed, and what is blocking it.",
	},
	"task_dependency_graph": {
		Object: objectTask,
		Intent: "Read a task's dependency graph.",
	},
	"task_dependency_add": {
		Object:   objectTask,
		Intent:   "Make one task wait for another.",
		NextStep: "task_dependency_graph to see the edge in place.",
	},
	"task_dependency_remove": {
		Object: objectTask,
		Intent: "Remove a dependency edge.",
	},
	"task_create": {
		Object:          objectTask,
		Intent:          "Record one durable piece of work.",
		Approval:        approvalKindCard,
		ApprovalKey:     "orbit_task_create",
		SuccessEvidence: "The task's id and status, and the fields that decide its future (projectId, listId, assigneeId, completionCriterion, runAt/autoRunWhenReady when set).",
		Idempotency:     idempotencyCallerKey,
		Retry:           "Send idempotencyKey and a retry with the same key is safe in any turn: the server answers with the first task instead of writing twice. Without a key only a redelivered turn's create is deduplicated — re-read before sending it again.",
		NextStep:        "task_start when it should run; task_get to read it back.",
		Exclusive:       [][]string{{"startNow", "runAt"}, {"verification", "verifiesTaskId"}},
	},
	"task_create_batch": {
		Object:          objectTask,
		Intent:          "Record a whole plan of tasks, with their edges, in one atomic call.",
		Approval:        approvalKindCard,
		ApprovalKey:     "orbit_task_batch",
		SuccessEvidence: "Every item's id and status, the ref-to-id mapping, and the count written; a dry run answers dryRun:true and where each item would land instead.",
		Idempotency:     idempotencyCallerKey,
		Retry:           "Send idempotencyKey and a retry with the same key is safe in any turn: the server answers with the tasks the first send wrote. Without a key only a redelivered turn's batch is deduplicated — re-read before sending it again.",
		NextStep:        "task_list --project-id to see the filed plan.",
		Exclusive:       [][]string{{"tasks[].startNow", "tasks[].runAt"}, {"tasks[].parentTaskId", "tasks[].parentRef"}, {"tasks[].verifiesTaskId", "tasks[].verifiesRef"}},
	},
	"task_batch_pin": {
		Object: objectTask,
		Intent: "Re-pin many tasks' engine, provider or model in one request.",
	},
	"task_update": {
		Object: objectTask,
		Intent: "Change a task's fields, dependencies or pins.",
	},
	"task_reopen": {
		Object:   objectTask,
		Intent:   "Take a stopped task back to OPEN in place so the next attempt reuses it.",
		NextStep: "task_start when it should run again.",
	},
	"task_delete": {
		Object:      objectTask,
		Intent:      "Delete a task permanently.",
		Destructive: true,
	},
	"task_start": {
		Object:          objectTask,
		Intent:          "Start a task now on its assignee.",
		Risk:            riskHigh,
		SuccessEvidence: "The started (or resumed) session's id and status.",
		NextStep:        "task_await to be woken when the run ends.",
	},
	"task_comment": {
		Object: objectTask,
		Intent: "Add a comment to a task.",
	},
	"task_request_confirmation": {
		Object:   objectOwner,
		Intent:   "Declare the task's work finished so the account owner is asked to confirm it.",
		Approval: approvalKindOwner,
	},
	"task_confirmation_review": {
		Object: objectTask,
		Intent: "Record this session's review of an owner-confirmation request.",
	},
	"task_confirmation_return": {
		Object: objectTask,
		Intent: "Send an owner-confirmation request back to its run with what must change.",
	},
	"task_progress_report": {
		Object: objectTask,
		Intent: "Report structured progress on the task this run is doing.",
	},

	// ── task lists ──
	"tasklist_list": {
		Object: objectTaskList,
		Intent: "See the task lists and what each holds.",
	},
	"tasklist_create": {
		Object: objectTaskList,
		Intent: "Create a dispatch policy for a class of work.",
	},
	"tasklist_get": {
		Object: objectTaskList,
		Intent: "Read one task list's dispatch policy and progress.",
	},
	"tasklist_update": {
		Object: objectTaskList,
		Intent: "Change a task list's concurrency, pause, instructions or foreman settings.",
	},
	"tasklist_propose_dag": {
		Object:      objectTaskList,
		Intent:      "Preview or apply a batch of dependency changes to a list.",
		Approval:    approvalKindCard,
		ApprovalKey: "orbit_dag_change",
	},
	"tasklist_delete": {
		Object:      objectTaskList,
		Intent:      "Delete a task list; its tasks are detached, not deleted.",
		Destructive: true,
	},

	// ── projects and their integration line ──
	"project_get": {
		Object: objectProject,
		Intent: "Read a project's goal, acceptance criteria, status and integration.",
	},
	"project_integration_get": {
		Object: objectProject,
		Intent: "Read a project's landing and merge-check integration settings.",
	},
	"project_crossings": {
		Object: objectProject,
		Intent: "Read the cross-project move requests awaiting the account owner.",
	},
	"project_create": {
		Object:          objectProject,
		Intent:          "Record a whole body of work with its own goal and acceptance.",
		Approval:        approvalKindCard,
		ApprovalKey:     "orbit_project_create",
		SuccessEvidence: "The project's id and status, and the criterion set as written.",
		NextStep:        "task_create to file the first task under it.",
	},
	"project_update": {
		Object:         objectProject,
		Intent:         "Change a project's goal, criteria, instructions or integration.",
		Approval:       approvalKindCard,
		ApprovalKey:    "orbit_project_update_integration",
		ApprovalDetail: "Only an update that changes the merge check is put on a card; the landing line and delivery mode are the owner's at a terminal and refused for a session, and a rename, goal or instruction change needs no card.",
	},
	"project_blocker_resolve": {
		Object:      objectProject,
		Intent:      "Resolve a project blocker.",
		Approval:    approvalKindCard,
		ApprovalKey: "orbit_blocker_resolve",
	},
	"project_request_start": {
		Object:   objectProject,
		Intent:   "Ask the account owner to start a project.",
		Approval: approvalKindOwner,
	},
	"project_request_done": {
		Object:   objectProject,
		Intent:   "Ask the account owner to settle a project as done.",
		Approval: approvalKindOwner,
	},
	"project_delete": {
		Object:      objectProject,
		Intent:      "Delete an empty project permanently.",
		Destructive: true,
	},
	"project_ensure_coordinator": {
		Object: objectProject,
		Intent: "Open a project's coordinator conversation when the standing one cannot be reached.",
		Risk:   riskHigh,
	},
	"project_send": {
		Object: objectProject,
		Intent: "Send one message to a project's coordinator.",
	},
	"project_merge_evidence": {
		Object: objectMergeReceipt,
		Intent: "Record what a target branch was observed to contain, as a project's merge evidence.",
	},
	"merge_receipt": {
		Object:          objectMergeReceipt,
		Intent:          "Record that a merge happened, as evidence about the caller's own work.",
		SuccessEvidence: "The recorded receipt, which a later read returns.",
	},
	"merge_receipts": {
		Object: objectMergeReceipt,
		Intent: "Read the merge receipts recorded for a session.",
	},

	// ── the project integration line's coordinator doors ──
	"criterion_confirm": {
		Object: objectProject,
		Intent: "Confirm a project criterion as the project's coordinator.",
		Risk:   riskHigh,
	},
	"criterion_confirmation_withdraw": {
		Object: objectProject,
		Intent: "Withdraw a criterion confirmation as the project's coordinator.",
		Risk:   riskHigh,
	},
	"criterion_check_start": {
		Object: objectProject,
		Intent: "Start a criterion check as the project's coordinator.",
		Risk:   riskHigh,
	},
	"criterion_check_report": {
		Object: objectProject,
		Intent: "Report the Agent check this session is running.",
		Risk:   riskHigh,
	},
	"open_item_resolve": {
		Object: objectProject,
		Intent: "Close an open integration or task-failure item.",
	},
	"open_item_hand_over": {
		Object:   objectOwner,
		Intent:   "Hand an open item to the account owner.",
		Approval: approvalKindOwner,
	},
	"integration_retry": {
		Object:    objectProject,
		Intent:    "Retry a failed landing as the project's coordinator.",
		Exclusive: [][]string{{"taskId", "promotionId"}},
	},
	"integration_abandon": {
		Object:      objectProject,
		Intent:      "Abandon a running landing job.",
		Destructive: true,
	},
	"integration_request_promotion": {
		Object:   objectProject,
		Intent:   "Ask the account owner to promote an integration branch.",
		Approval: approvalKindOwner,
	},
	"integration_observe": {
		Object: objectProject,
		Intent: "Ask for the project's integration line to be observed again.",
	},
	"integration_skip_merge_check": {
		Object:      objectProject,
		Intent:      "Skip a merge check for one landing.",
		Approval:    approvalKindCard,
		ApprovalKey: "orbit_integration_skip_merge_check",
	},

	// ── the owner's own doors ──
	"ask_owner": {
		Object:   objectOwner,
		Intent:   "Ask the account owner a question.",
		Approval: approvalKindOwner,
	},
	"request_owner_action": {
		Object:   objectOwner,
		Intent:   "Ask the account owner to perform a consequential action.",
		Approval: approvalKindOwner,
	},
	"withdraw_owner_request": {
		Object: objectOwner,
		Intent: "Withdraw a request this session filed with the account owner.",
	},
	"notify": {
		Object: objectOwner,
		Intent: "Alert the person this run works for on their devices.",
	},

	// ── sessions ──
	"session_create": {
		Object:          objectSession,
		Intent:          "Open a new conversation to run a sub-task immediately.",
		Risk:            riskHigh,
		SuccessEvidence: "The new session's id and status.",
		NextStep:        "session_await with the id, then end the turn.",
	},
	"session_import": {
		Object: objectSession,
		Intent: "Import a Claude Code transcript from this machine as an Orbit session.",
	},
	"session_list": {
		Object: objectSession,
		Intent: "See the sessions this agent may read.",
	},
	"session_search": {
		Object: objectSession,
		Intent: "Search sessions by their text.",
	},
	"session_get": {
		Object: objectSession,
		Intent: "Read one session's state.",
	},
	"session_send": {
		Object:          objectSession,
		Intent:          "Send a message to a session.",
		SuccessEvidence: "The turn the message was written as (its id and when it will be delivered).",
	},
	"session_reply": {
		Object:          objectSession,
		Intent:          "Answer a request this session was sent.",
		SuccessEvidence: "The answer as recorded on the request.",
	},
	"session_interrupt": {
		Object: objectSession,
		Intent: "Interrupt a session's turn.",
	},
	"session_merge": {
		Object: objectSession,
		Intent: "Merge a session's branch into its target.",
		Risk:   riskHigh,
	},
	"session_end": {
		Object: objectSession,
		Intent: "End a session.",
	},
	"session_complete": {
		Object: objectSession,
		Intent: "Move a session to Completed.",
	},
	"session_delete": {
		Object: objectSession,
		Intent: "Move a session to Trash.",
	},
	"session_await": {
		Object:          objectWatch,
		Intent:          "Be woken when sessions finish their turn, need a person, or end.",
		SuccessEvidence: "The watch id and when it will next be evaluated.",
		NextStep:        "End the turn; the watch wakes this session.",
	},
	"schedule_wakeup": {
		Object: objectSession,
		Intent: "Schedule a wake-up in this session, once or on a loop.",
	},

	// ── agents, runners, providers ──
	"agent_list": {
		Object: objectAgent,
		Intent: "See the agents work can run under.",
	},
	"agent_create": {
		Object:         objectAgent,
		Intent:         "Create an agent: where and under which identity work runs.",
		Approval:       approvalKindCard,
		ApprovalKey:    "orbit_agent_create",
		ApprovalDetail: "A write naming env, workDir, systemPrompt, appendSystemPrompt, runnerId or enableWorktree is put on a card; name, description and defaultMergeTarget alone are not.",
	},
	"agent_update": {
		Object:         objectAgent,
		Intent:         "Change an agent's defaults, location or environment.",
		Approval:       approvalKindCard,
		ApprovalKey:    "orbit_agent_update",
		ApprovalDetail: "The same card rule as agent_create, asked only when one of the fields that decides the next run's start changes.",
	},
	"agent_delete": {
		Object:      objectAgent,
		Intent:      "Delete an agent.",
		Approval:    approvalKindCard,
		ApprovalKey: "orbit_agent_delete",
		Destructive: true,
	},
	"runner_list": {
		Object: objectRunner,
		Intent: "See the runners of this account and whether they are online.",
	},
	"runner_engine_install": {
		Object: objectRunner,
		Intent: "Install or update an engine CLI on one of this account's runners.",
		Risk:   riskHigh,
	},
	"runner_engine_install_status": {
		Object: objectRunner,
		Intent: "Read where an engine install or update stands.",
	},
	"runner_delete": {
		Object:      objectRunner,
		Intent:      "Delete a runner and the agents bound to it.",
		Approval:    approvalKindCard,
		ApprovalKey: "orbit_runner_delete",
		Destructive: true,
	},
	"provider_list": {
		Object: objectProvider,
		Intent: "See the credential providers and the engines each can run.",
	},
	"provider_create": {
		Object:      objectProvider,
		Intent:      "Add a credential provider.",
		Approval:    approvalKindCard,
		ApprovalKey: "orbit_provider_create",
	},
	"provider_update": {
		Object:      objectProvider,
		Intent:      "Change a credential provider.",
		Approval:    approvalKindCard,
		ApprovalKey: "orbit_provider_update",
	},
	"provider_delete": {
		Object:      objectProvider,
		Intent:      "Delete a credential provider.",
		Approval:    approvalKindCard,
		ApprovalKey: "orbit_provider_delete",
		Destructive: true,
	},

	// ── waiting on Orbit's own work ──
	"watch_create": {
		Object:          objectWatch,
		Intent:          "Ask Orbit to wake this session when a condition holds.",
		SuccessEvidence: "The watch id, its state and when it will next be evaluated.",
		NextStep:        "End the turn; the watch wakes this session.",
	},
	"watch_get": {
		Object: objectWatch,
		Intent: "Read one watch in full, including why it has not fired.",
	},
	"watch_list": {
		Object: objectWatch,
		Intent: "See this session's watches.",
	},
	"watch_update": {
		Object: objectWatch,
		Intent: "Change a watch's condition or deadline.",
	},
	"watch_cancel": {
		Object: objectWatch,
		Intent: "Cancel a watch so it wakes nobody.",
	},
	"task_await": {
		Object:          objectWatch,
		Intent:          "Be woken when tasks finish, or as soon as one fails.",
		SuccessEvidence: "The watch id and when it will next be evaluated.",
		NextStep:        "End the turn; the watch wakes this session.",
	},

	// ── wiki, files, background jobs ──
	"wiki_search": {
		Object: objectWiki,
		Intent: "Search the shared wiki for what is known.",
	},
	"wiki_get": {
		Object: objectWiki,
		Intent: "Read one or more wiki entries.",
	},
	"wiki_propose": {
		Object:          objectWiki,
		Intent:          "Propose a change to the shared wiki.",
		SuccessEvidence: "The proposal's id and the review state it entered.",
	},
	"wiki_note": {
		Object:          objectWiki,
		Intent:          "Record one claim or pitfall in the shared wiki.",
		SuccessEvidence: "The note's id and where it was filed.",
	},
	"wiki_draft": {
		Object:          objectWiki,
		Intent:          "Draft a wiki page section for review.",
		SuccessEvidence: "The draft card's id and the section it targets.",
	},
	"wiki_import": {
		Object: objectWiki,
		Intent: "Import a Markdown file or tree into a wiki space.",
	},
	"wiki_verify": {
		Object: objectWiki,
		Intent: "Wait for the server's verdicts on a wiki import.",
	},
	"file_upload": {
		Object:          objectFile,
		Intent:          "Upload a file as an attachment this session's reply can carry.",
		SuccessEvidence: "The upload's file or attachment id, and a link that works in a reply.",
		NextStep:        "Reference it as orbit-attachment:<id>.",
	},
	"file_fetch": {
		Object: objectFile,
		Intent: "Read a file's bytes back.",
	},
	"file_pin": {
		Object: objectFile,
		Intent: "Keep a file so it survives the turn.",
	},
	"file_list": {
		Object: objectFile,
		Intent: "See the files this session keeps.",
	},
	"bg_run": {
		Object: objectBackgroundJob,
		Intent: "Run a command in the background on this runner.",
		Risk:   riskHigh,
	},
	"bg_output": {
		Object:    objectBackgroundJob,
		Intent:    "Read a background job's output.",
		Exclusive: [][]string{{"sinceOffset", "tail"}},
	},
	"bg_kill": {
		Object:      objectBackgroundJob,
		Intent:      "Stop a background job.",
		Destructive: true,
	},
	"bg_list": {
		Object: objectBackgroundJob,
		Intent: "See this session's background jobs.",
	},

	// ── the engine's own bridge, and the person's account ──
	"permission_prompt": {
		Object: objectPermission,
		Intent: "Answer an engine tool-permission prompt from the account owner.",
		Risk:   riskLow,
	},
	"login": {
		Object: objectAccount,
		Intent: "Sign this machine in to an Orbit account.",
	},
	"logout": {
		Object: objectAccount,
		Intent: "Sign this machine out.",
	},
	"whoami": {
		Object: objectAccount,
		Intent: "Tell the person who this process acts as.",
	},
	"api": {
		Object: objectAccount,
		Intent: "Call any user REST route with the person's own token.",
		Risk:   riskHigh,
	},
}

// cliCapabilityAvailability is how a capability's two doors are reached. It is descriptive only:
// buildCLICapabilities remains the one place that decides what a given process is offered.
type cliCapabilityAvailability struct {
	MCP string `json:"mcp"`
	CLI string `json:"cli"`
}

func (op *operation) availability() cliCapabilityAvailability {
	// Each side is the gates that must hold, joined with "+": the base gate, then the optional
	// surface switches this operation also needs. "always"/"absent" stand alone.
	var mcp []string
	if op.MCP == nil {
		mcp = append(mcp, "absent")
	} else {
		switch op.Gate {
		case gateOrchestration:
			mcp = append(mcp, "orchestration")
		case gatePermissionPrompt:
			mcp = append(mcp, "engine")
		default:
			mcp = append(mcp, "always")
		}
		mcp = catalogSurfaceSwitch(mcp, op)
	}
	var cli []string
	if op.CLI == nil {
		cli = append(cli, "absent")
	} else {
		switch {
		case op.CLI.HeadlessOnly:
			cli = append(cli, "headless")
		case op.CLI.RequiresOrchestration:
			cli = append(cli, "orchestration")
		case op.CLI.SessionOnly:
			cli = append(cli, "session")
		case op.CLIFamily == "session", op.CLIFamily == "agent", op.CLIFamily == "runner":
			// These families are appended only when the orchestration grant exists; the headless
			// subset is reached through a service-token scope instead.
			cli = append(cli, "orchestration")
		default:
			cli = append(cli, "always")
		}
		cli = catalogSurfaceSwitch(cli, op)
	}
	return cliCapabilityAvailability{MCP: strings.Join(mcp, "+"), CLI: strings.Join(cli, "+")}
}

// catalogSurfaceSwitch adds the optional watch/wiki switch an operation rides, folding "always"
// into the switch because the switch already implies the ordinary case.
func catalogSurfaceSwitch(parts []string, op *operation) []string {
	switch {
	case op.CLIFamily == "watch" || op.Tool == "session_await":
		parts = append(parts, "watch_switch")
	case op.CLIFamily == "wiki":
		parts = append(parts, "wiki_switch")
	}
	if len(parts) > 1 && parts[0] == "always" {
		return parts[1:]
	}
	return parts
}

// claudeToolName is how Claude Code names one of this catalogue's MCP tools in its own tool
// settings (the --permission-prompt-tool target and hook matchers): mcp__orbit__<name>. Every
// literal of that shape in the runner comes through here, so a tool renamed in the catalogue
// cannot leave a stale name in Claude's configuration.
func claudeToolName(tool string) string { return "mcp__orbit__" + tool }

// canonicalPermissionModeFlagSpec is the catalogue's flag form of the permission-mode list: every
// mode, in the order the pickers show them. buildCLICapabilities narrows it to this machine at
// projection time, the same way the tool schema is narrowed.
func canonicalPermissionModeFlagSpec() string {
	return "--permission-mode <" + strings.Join(allPermissionModes, "|") + ">"
}

// runtimeCLIArguments is the capability's argument list as THIS machine advertises it. The
// catalogue keeps the canonical list so its identity does not depend on the runner; the one
// argument that varies (the modes a root runner cannot offer) is narrowed here.
func runtimeCLIArguments(op *operation) []string {
	if op == nil || op.CLI == nil {
		return nil
	}
	args := append([]string{}, op.CLI.Arguments...)
	if op.Tool == "session_create" {
		for i, arg := range args {
			if strings.HasPrefix(arg, "--permission-mode ") {
				args[i] = permissionModeFlagSpec()
			}
		}
	}
	return args
}

// applyPermissionModeOffer narrows the catalogue's canonical session_create permission-mode enum
// and description to what THIS machine can run. The catalogue keeps the full list so its content
// hash is the same on every runner and in CI; the tool list, and the capability schema built from
// it, still advertise only modes this runner can actually start (a root runner cannot run
// bypassPermissions: claude exits during startup, before a turn).
func applyPermissionModeOffer(descriptor map[string]interface{}) map[string]interface{} {
	schema, _ := descriptor["inputSchema"].(map[string]interface{})
	props, _ := schema["properties"].(map[string]interface{})
	mode, _ := props["permissionMode"].(map[string]interface{})
	if mode == nil {
		return descriptor
	}
	modeCopy := make(map[string]interface{}, len(mode))
	for key, value := range mode {
		modeCopy[key] = value
	}
	modeCopy["enum"] = offeredPermissionModes()
	base, _ := modeCopy["description"].(string)
	modeCopy["description"] = strings.TrimSpace(base + " " + rootWithheldPermissionModeNote())
	propsCopy := make(map[string]interface{}, len(props))
	for key, value := range props {
		propsCopy[key] = value
	}
	propsCopy["permissionMode"] = modeCopy
	schemaCopy := make(map[string]interface{}, len(schema))
	for key, value := range schema {
		schemaCopy[key] = value
	}
	schemaCopy["properties"] = propsCopy
	descriptorCopy := make(map[string]interface{}, len(descriptor))
	for key, value := range descriptor {
		descriptorCopy[key] = value
	}
	descriptorCopy["inputSchema"] = schemaCopy
	return descriptorCopy
}

func catalogToolDescriptors(includePermissionPrompt, includeOrchestration bool) []map[string]interface{} {
	all := operationCatalog().Ops
	tools := make([]map[string]interface{}, 0, len(all))
	for _, op := range all {
		if op.MCP == nil {
			continue
		}
		switch op.Gate {
		case gateOrchestration:
			if !includeOrchestration {
				continue
			}
		case gatePermissionPrompt:
			if !includePermissionPrompt {
				continue
			}
		}
		descriptor := map[string]interface{}{
			"name":        op.Tool,
			"description": op.MCP.Description,
			"inputSchema": op.MCP.InputSchema,
		}
		for key, value := range op.MCP.Extra {
			descriptor[key] = value
		}
		if op.Tool == "session_create" {
			descriptor = applyPermissionModeOffer(descriptor)
		}
		tools = append(tools, descriptor)
	}
	return tools
}

// builtOperationCatalog is the catalogue as the surfaces see it: rows in a stable order, an index
// by tool, and the content hash the capabilities document carries.
type builtOperationCatalog struct {
	Ops    []*operation
	ByTool map[string]*operation
	Hash   string
}

// operationCatalog builds the catalogue for the caller's environment. It is deliberately not
// cached: the permission-mode offer and the root note are resolved when a surface is projected, and
// a caller that flips runsAsRoot (a test, or a runner that changes identity) has to see the new
// answer — caching froze the first build's environment and made the tool list say the wrong thing.
func operationCatalog() *builtOperationCatalog {
	ops := buildOperationCatalog()
	byTool := make(map[string]*operation, len(ops))
	for _, op := range ops {
		byTool[op.Tool] = op
	}
	return &builtOperationCatalog{Ops: ops, ByTool: byTool, Hash: operationCatalogHash(ops)}
}

func catalogOperation(tool string) *operation {
	if built := operationCatalog(); built != nil {
		return built.ByTool[tool]
	}
	return nil
}

// operationCatalogHash covers the whole catalogue: identity, metadata, availability and the
// content of both surfaces. encoding/json sorts map keys, so the digest is stable across runs and
// machines. A copy edit, a schema change, a new operation or a new gate all move it.
func operationCatalogHash(ops []*operation) string {
	type row struct {
		Tool            string                 `json:"tool"`
		Object          operationObject        `json:"object"`
		Intent          string                 `json:"intent"`
		Risk            operationRisk          `json:"risk"`
		Mutates         bool                   `json:"mutates"`
		Approval        operationApproval      `json:"approval"`
		ApprovalKey     string                 `json:"approvalKey,omitempty"`
		ApprovalDetail  string                 `json:"approvalDetail,omitempty"`
		Destructive     bool                   `json:"destructive"`
		Idempotency     operationIdempotency   `json:"idempotency"`
		Retry           string                 `json:"retry"`
		SuccessEvidence string                 `json:"successEvidence"`
		NextStep        string                 `json:"nextStep,omitempty"`
		Returns         string                 `json:"returns"`
		Plan            operationPlan          `json:"plan"`
		PlanReason      string                 `json:"planReason,omitempty"`
		Gate            operationGate          `json:"gate"`
		MCPDescription  string                 `json:"mcpDescription,omitempty"`
		MCPInputSchema  map[string]interface{} `json:"mcpInputSchema,omitempty"`
		MCPExtra        map[string]interface{} `json:"mcpExtra,omitempty"`
		CLIArgv         []string               `json:"cliArgv,omitempty"`
		CLIUsage        string                 `json:"cliUsage,omitempty"`
		CLIArguments    []string               `json:"cliArguments,omitempty"`
		CLIMutates      bool                   `json:"cliMutates,omitempty"`
		CLIExempt       string                 `json:"cliExempt,omitempty"`
		MCPExempt       string                 `json:"mcpExempt,omitempty"`
	}
	rows := make([]row, 0, len(ops))
	for _, op := range ops {
		r := row{
			Tool:            op.Tool,
			Object:          op.Object,
			Intent:          op.Intent,
			Risk:            op.Risk,
			Mutates:         op.Mutates,
			Approval:        op.Approval,
			ApprovalKey:     op.ApprovalKey,
			ApprovalDetail:  op.ApprovalDetail,
			Destructive:     op.Destructive,
			Idempotency:     op.Idempotency,
			Retry:           op.Retry,
			SuccessEvidence: op.SuccessEvidence,
			NextStep:        op.NextStep,
			Returns:         op.Returns,
			Plan:            op.Plan,
			PlanReason:      op.PlanReason,
			Gate:            op.Gate,
			CLIExempt:       op.CLIExempt,
			MCPExempt:       op.MCPExempt,
		}
		if op.MCP != nil {
			r.MCPDescription = op.MCP.Description
			r.MCPInputSchema = op.MCP.InputSchema
			r.MCPExtra = op.MCP.Extra
		}
		if op.CLI != nil {
			r.CLIArgv = op.CLI.Argv
			r.CLIUsage = op.CLI.Usage
			r.CLIArguments = op.CLI.Arguments
			r.CLIMutates = op.CLI.Mutates
		}
		rows = append(rows, r)
	}
	// Order-independence: the catalog is already sorted, but the hash must not depend on it.
	sort.Slice(rows, func(i, j int) bool { return rows[i].Tool < rows[j].Tool })
	blob, err := json.Marshal(rows)
	if err != nil {
		// The catalogue is built from map literals and strings; a marshal failure is not a state a
		// running binary can recover from honestly, so it answers with no hash rather than a lie.
		return ""
	}
	sum := sha256.Sum256(blob)
	return hex.EncodeToString(sum[:])
}
