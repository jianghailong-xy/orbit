package main

import (
	"encoding/json"
	"fmt"
	"io"
	"strings"
)

// The Orbit guide: the operation catalogue arranged by what a person asks for (docs/orbit-agent-contract.md
// §1.3, §2.5). It is one catalogued operation with two doors — the MCP tool `guide` and `orbit guide` — and
// both answer the same document:
//
//   - with no topic, the index: the five objects and the question each answers, the contract's intent
//     routes (R1.x) each with the operations and the topic that covers it, the routing rules, and the topics;
//   - with a topic, that topic's shortest recipe: its steps in order, each a catalogued operation with its
//     MCP tool and CLI argv, whether it is available here and why not, whether it writes and who must
//     approve, a minimal example on both surfaces and what proves it succeeded — and the rules that span
//     the tools, which the tools' own descriptions used to repeat.
//
// Everything a step says about its operation comes from the catalogue row; a topic adds only the order,
// why each step is there, and the arguments that make the generic example this recipe's. It is read-only
// and always listed, whatever the session's switches, so that an agent whose tools are missing can still
// learn why. The routes and objects are held to contracts/orbit-agent.contract.json by
// TestGuideRoutesAreTheContractsRoutes.

// agentGuideVersion is the version of the guide's content and shape. A topic added, removed or rewritten
// is a new version.
const agentGuideVersion = "1.0.0"

// guideObject is one of the contract's five objects (§1.1) and the question it answers.
type guideObject struct {
	ID       string `json:"id"`
	Question string `json:"question"`
}

var guideObjects = []guideObject{
	{"project", "What is the whole thing for, and what settles it?"},
	{"task", "What is the one piece of work?"},
	{"task_list", "How is this class of work dispatched?"},
	{"session", "What is running right now?"},
	{"agent", "Where does it run, and under which identity?"},
}

// guideRoute is one row of the contract's routing table (R1): what the person says, the object it
// belongs to, the operations that answer it, and the topic that walks through them. "none" is a valid
// object: not every request is an Orbit write.
type guideRoute struct {
	Route  string
	Intent string
	Object string
	Topic  string
	Ops    []string
}

var guideRoutes = []guideRoute{
	{"R1.1", "Remember this, file it, do it later, someone should fix it", "task", "task-create", []string{"task_create"}},
	{"R1.2", "Keep this plan: it is already worked out and counted", "task[]", "task-batch", []string{"task_create_batch"}},
	{"R1.3", "Set up this whole body of work, with its own goal and acceptance (4+ dependent steps, or several agents over days)", "project", "project-create", []string{"project_create"}},
	{"R1.4", "Run it now; it is already recorded", "task", "task-start", []string{"task_start"}},
	{"R1.5", "Run it now; it is not recorded yet", "task", "task-start", []string{"task_create"}},
	{"R1.6", "Do it at a set time", "task", "task-schedule", []string{"task_create", "task_update"}},
	{"R1.7", "Hand this to another agent as its own conversation", "session", "delegate", []string{"session_create"}},
	{"R1.8", "What is the state of this project, task or session?", "none", "inspect", []string{"project_get", "task_get", "task_list", "session_get"}},
	{"R1.9", "Wait for it to finish", "watch", "wait", []string{"task_await", "session_await", "watch_create"}},
	{"R1.10", "Remember this lesson or pitfall about a file or a pattern", "wiki", "wiki", []string{"wiki_search", "wiki_propose", "wiki_note"}},
	{"R1.11", "Keep this file, or read one back", "file", "files", []string{"file_upload", "file_fetch", "file_list"}},
	{"R1.12", "This class of work needs its own dispatch policy", "task_list", "task-list", []string{"tasklist_create", "tasklist_update"}},
	{"R1.13", "Which agent should run this, or change an agent's defaults", "agent", "agent", []string{"agent_list", "agent_create", "agent_update"}},
	{"R1.14", "Answer, explain, or edit code", "none", "", nil},
}

// guideRules are the contract's routing rules R2–R5, as contracts/orbit-agent.contract.json states them.
var guideRules = []string{
	"R2: The smaller object wins: one task beats a project; one task beats a batch of one.",
	"R3: Never double-record: not a task per step of the current task, not a task for the current task, not a session to do what this turn can do.",
	"R4: Read before write when the destination is uncertain: task_list --project-id, project_get, or task_create_batch dryRun.",
	"R5: An engine plan/todo is private scratch; never call it an Orbit record, never claim a task without its id, never refuse to record work because a private plan covers it.",
}

// guideStep is one step of a recipe: a catalogued operation, why it is there, and the arguments that make
// the catalogue's minimal example this recipe's. A nil value leaves that field out of the example.
type guideStep struct {
	Op       string
	Why      string
	Optional bool
	Example  map[string]interface{}
}

type guideTopic struct {
	ID      string
	Intent  string
	Steps   []guideStep
	Rules   []string
	Done    string
	Related []string
}

// guideTopics is every topic, in the order the index lists them.
var guideTopics = []guideTopic{
	{
		ID:     "task-create",
		Intent: "Record one piece of work the user wants kept, followed up or done later.",
		Steps: []guideStep{
			{Op: "task_list", Optional: true, Why: "When the work may already be recorded, or you are not sure which project it belongs to, read before you write (R4).",
				Example: map[string]interface{}{"projectId": "<projectId>", "status": "OPEN"}},
			{Op: "task_create", Why: "Write it. The call puts a confirmation card in front of the user and waits for their answer; nothing is written if they decline."},
			{Op: "task_get", Optional: true, Why: "Read it back when the claim matters.", Example: map[string]interface{}{"taskId": "<taskId>"}},
		},
		Rules: []string{
			"Say in a sentence or two what you are about to file and why, then call. The card is the user's yes: a declined card (APPROVAL_DECLINED) is a refusal, so do not create it another way. A chat answer is not a no: answer the owner, then call again, changed as agreed.",
			"Newly discovered work belongs in one task by default. Several related tasks from a plan already worked out are task-batch, written with their edges in one atomic call. A project is worth proposing only for a plan of 4+ dependent steps, or work that plainly wants several agents over days (project-create); proposing one does not block this call, and if the answer is no, or you did not ask, a task is the right record.",
			"Creating is not starting, but autoRunWhenReady defaults to true: an assigned task starts by itself once every prerequisite is DONE and, in a project, the project has started. Pass autoRunWhenReady: false when the person said nothing should run until they say so. To run it now pass startNow: true (task-start); at a set time, runAt (task-schedule).",
			"Ask the person what would settle the task before you write it, and pass their answer as acceptanceCriteria: the observable result a reader who did not watch the work can verify, where description says what work to perform. If they have not said, ask and end your turn with the question; never file criteria they did not state. Where one command decides it, pass acceptanceCommand with acceptanceExpectedExitCode and the task settles itself; a task filed with neither leaves its run no legal way to finish (ATTEMPT_ENDED_WITHOUT_JUDGMENT_PATH).",
			"Declare completionCriterion every time. EVIDENCE_JUDGMENT is work a reviewer settles: outside a project each evidence revision its run submits reaches this session as an <orbit-evidence-review> message to decide with task_evidence_decide, and the owner is asked only if you have not decided within 30 minutes. OWNER_CONFIRMED outside an Automatic project takes ownerConfirmationReason. VERIFICATION with completionPolicy VERIFICATION_PASSED is a pure gate: pass verification: {title, assigneeId} in the same call. If TASK_CRITERION_SHAPE_ADVICE questions the criterion, adopt its suggestedCriterion or retry with completionCriterionOverrideReason.",
			"projectId files the task under a project (what the work is for) and listId under a dispatch policy; the two are orthogonal. parentTaskId makes it a subtask of a task in the same project. Order work with dependsOnTaskIds naming the subject of the work, never with preconditions written into the description. codeless: true marks work that produces no code.",
			"Key the create with an idempotencyKey derived from the work, so a retry after a timeout or in a later turn answers with the first task instead of filing a second.",
		},
		Done:    "The task_create receipt reads ok: true and outcome: written, with the task's id and status. Name it to the user as [title](orbit-task:<id>).",
		Related: []string{"task-batch", "project-create", "task-start", "task-schedule"},
	},
	{
		ID:     "task-batch",
		Intent: "Keep a plan that is already worked out: several tasks with their order and parts, in one call.",
		Steps: []guideStep{
			{Op: "task_create_batch", Optional: true, Why: "When you are not sure where the plan files, judge it first: a dry run writes nothing, asks nobody, and answers where every item would land.",
				Example: map[string]interface{}{"dryRun": true, "idempotencyKey": nil}},
			{Op: "task_create_batch", Why: "Write the whole plan. One card covers every item, and nothing is written unless every item is valid."},
			{Op: "task_list", Optional: true, Why: "See the filed plan.", Example: map[string]interface{}{"projectId": "<projectId>"}},
		},
		Rules: []string{
			"A plan already worked out and counted is one task_create_batch (at most 50 items), not a task_create per step; a plan of one item is one task (R2).",
			"A later item depends on an earlier one without knowing its id: give the earlier item a ref and list it in the later item's dependsOnRefs. parentRef names an earlier item as this item's parent, so the plan lands as a tree: dependsOnRefs is when an item may run, parentRef what it is part of. dependsOnTaskIds and parentTaskId still name tasks that already exist.",
			"Ask, per item, what would settle it, and put the person's answer in that item's acceptanceCriteria; if they have not said it for every item, ask and end your turn. An item a single command decides takes acceptanceCommand with acceptanceExpectedExitCode.",
			"Every item declares completionCriterion. A VERIFICATION item with completionPolicy VERIFICATION_PASSED is a pure gate, paired by a later item's verifiesRef in the same call.",
			"Items are only recorded, except one carrying startNow: true, which the server starts within the minute. autoRunWhenReady defaults to true per item, so give an item the person wants held autoRunWhenReady: false.",
			"Key the batch with an idempotencyKey: the same key answers with the tasks the first send wrote, item for item.",
		},
		Done:    "The receipt reads ok: true and outcome: written, with every item's id and status in input order, each echoing its ref.",
		Related: []string{"task-create", "project-create"},
	},
	{
		ID:     "project-create",
		Intent: "Record a whole body of work with its own goal and acceptance, coordinated from this conversation.",
		Steps: []guideStep{
			{Op: "project_create", Why: "Propose it in a sentence or two first; the card is the user's answer, and a yes makes this conversation the project's coordinator.",
				Example: map[string]interface{}{
					"goal": "<what the work is trying to achieve>",
					"acceptanceCriteriaItems": []interface{}{
						map[string]interface{}{"text": "<what would settle it>", "verificationMethod": "<how a reader checks it>"},
					},
				}},
			{Op: "task_create_batch", Optional: true, Why: "File its worked-out plan under it: give every item the projectId the project's receipt returned."},
		},
		Rules: []string{
			"A project is the exception to the smaller object (R2): propose one only for a plan already worked out that comes to 4 or more dependent steps, or work that plainly wants several agents over days. If they decline, a task is the right record; do not propose the same body of work twice.",
			"Call project_create from this same session, so this conversation becomes its coordinator; do not switch or open a session for it.",
			"Its acceptance is its own: each acceptanceCriteriaItems entry carries text and verificationMethod, and a task names the criterion it serves with criterionKey.",
			"Inside a task run, newly discovered work is filed as a task, which lands under the same project by itself; a separate undertaking may be put in front of the user with project_create.",
		},
		Done:    "The project_create receipt reads ok: true and outcome: written, with the project's id. Name it as [title](orbit-project:<id>).",
		Related: []string{"task-batch", "task-create"},
	},
	{
		ID:     "task-start",
		Intent: "Run work now: recorded work on its assignee, or new work created and started on one card.",
		Steps: []guideStep{
			{Op: "task_start", Why: "Recorded work runs now on its assignee; its prerequisites must be DONE.", Example: map[string]interface{}{"taskId": "<taskId>"}},
			{Op: "task_create", Optional: true, Why: "Work not recorded yet: create and start it on one card with startNow: true, and do not call task_start after.",
				Example: map[string]interface{}{"startNow": true}},
			{Op: "task_await", Optional: true, Why: "Be woken when the run ends instead of polling; end your turn after it."},
		},
		Rules: []string{
			"Start is its own decision: task_start runs recorded work, startNow: true records and starts it in one approval, runAt schedules one start, and autoRunWhenReady (default true) starts an assigned task by itself once it is ready.",
			"After startNow do not ask the person a second time and do not call task_start; never start a task they said must wait.",
		},
		Done:    "task_start's receipt names the started (or resumed) session's id and status; a startNow create's receipt carries it as start.sessionId.",
		Related: []string{"task-create", "wait"},
	},
	{
		ID:     "task-schedule",
		Intent: "Have the server start work once, at a set time.",
		Steps: []guideStep{
			{Op: "task_create", Why: "New work: create it with runAt.", Example: map[string]interface{}{"runAt": "<ISO 8601 date-time with zone>"}},
			{Op: "task_update", Optional: true, Why: "Recorded work: set its runAt.", Example: map[string]interface{}{"taskId": "<taskId>", "runAt": "<ISO 8601 date-time with zone>"}},
		},
		Rules: []string{
			"runAt is a one-time scheduled start, not a deadline (that is dueDate): the server's once-a-minute scan starts the task once the time has come. startNow and runAt are exclusive.",
			"Write the time in ISO 8601 with its zone, and say it back to the person in theirs.",
		},
		Done:    "The receipt reads ok: true and outcome: written, and the task carries runAt as written.",
		Related: []string{"task-create", "task-start"},
	},
	{
		ID:     "delegate",
		Intent: "Hand work that should run now to another agent as its own conversation.",
		Steps: []guideStep{
			{Op: "session_create", Why: "Open the conversation on an agent; the sub-session follows its own permission mode."},
			{Op: "session_await", Optional: true, Why: "Be woken when it finishes a turn; end your turn after it."},
		},
		Rules: []string{
			"Session, agent and runner tools exist only while the account's Session orchestration switch is on. Without them do not try `orbit session`: record the work as a task (task-create), tell the user the switch is in Settings -> Session orchestration, and never claim a delegation.",
			"Never open a session for what this turn can do, or for work already recorded as this session's task (R3). Work the user wants tracked is a task first: a session is one execution and can end, the task outlives it.",
		},
		Done:    "session_create's receipt names the new session's id and status. Name it as [title](orbit-session:<id>).",
		Related: []string{"task-create", "wait"},
	},
	{
		ID:     "inspect",
		Intent: "Read the state of a project, a task or a session before deciding anything.",
		Steps: []guideStep{
			{Op: "project_get", Optional: true, Why: "A project's goal, acceptance criteria, instructions, blockers and task counts."},
			{Op: "task_get", Why: "One task in full, with its comments and sessions; with no id, the task this session runs.", Example: map[string]interface{}{"taskId": "<taskId>"}},
			{Op: "task_list", Optional: true, Why: "Tasks filtered by project, status, list or label, as compact rows.", Example: map[string]interface{}{"projectId": "<projectId>"}},
			{Op: "session_get", Optional: true, Why: "One session's record."},
		},
		Rules: []string{
			"After a compaction or a resume, read the object again: never rebuild an id, a status or an approval from memory or a summary.",
			"There is no project list: a project id comes from a task's projectId, the project's page, or the user.",
			"Reads ask nobody and are safe to retry.",
		},
		Done:    "The document the read returned; quote ids from it, not from memory.",
		Related: []string{"wait"},
	},
	{
		ID:     "wait",
		Intent: "Wait for Orbit work to finish without holding the turn open.",
		Steps: []guideStep{
			{Op: "task_await", Why: "Tasks reaching a status: create the wait and end your turn; Orbit starts a new one when it holds."},
			{Op: "session_await", Optional: true, Why: "Sessions finishing a turn."},
			{Op: "watch_create", Optional: true, Why: "Any other condition on Orbit's own objects."},
		},
		Rules: []string{
			"Do not poll with sleep, Bash loops, background jobs or schedule_wakeup: create the wait and end your turn. Orbit holds it on the server and starts a turn in this session with a structured payload when it holds, even if this engine was recycled meanwhile.",
			"Give a wait an idempotencyKey, so a retry does not create a second one.",
		},
		Done:    "The await's receipt names the watch it created; the wake-up arrives as a new turn saying what changed.",
		Related: []string{"task-start", "delegate"},
	},
	{
		ID:     "wiki",
		Intent: "Find what is already known about a file or a pattern, and keep what you learned.",
		Steps: []guideStep{
			{Op: "wiki_search", Why: "Search by the file's path, or by words, before changing it or proposing: a near neighbour is better reinforced than duplicated."},
			{Op: "wiki_get", Optional: true, Why: "Read an entry in full, with the records it came from."},
			{Op: "wiki_propose", Optional: true, Why: "Record what you learned; the space's review mode decides, not you."},
			{Op: "wiki_note", Optional: true, Why: "Leave a claim for maintenance to check against the records."},
		},
		Rules: []string{
			"Before changing a file, search the wiki with its path for known pitfalls.",
			"Read an entry's sources before relying on it, and weigh an old one against the code.",
		},
		Done:    "wiki_propose answers with what the review mode did with the proposal, as its outputSchema states.",
		Related: []string{"files"},
	},
	{
		ID:     "files",
		Intent: "Keep a screenshot, report or log in Orbit instead of the repository, or read one back.",
		Steps: []guideStep{
			{Op: "file_upload", Why: "Keep the file; it reads only this session's checkout and uploads directory."},
			{Op: "file_list", Optional: true, Why: "What this task's sessions have uploaded."},
			{Op: "file_fetch", Optional: true, Why: "Read a file back by id."},
		},
		Rules: []string{
			"A file linked in a reply reaches the user only from the working directory or this session's uploads directory: copy it there first, and keep files that do not belong in the repository out of the checkout.",
			"Cite an uploaded file in evidence as a FILE check, by the id file_upload returned.",
		},
		Done:    "file_upload answers the file's id, sha256, sizeBytes and an orbit-attachment: link to put in a reply.",
		Related: []string{"finish-task"},
	},
	{
		ID:     "task-list",
		Intent: "Give a class of work its own dispatch policy: a concurrency cap, a pause, standing instructions.",
		Steps: []guideStep{
			{Op: "tasklist_list", Optional: true, Why: "The lists that exist."},
			{Op: "tasklist_create", Why: "A new list."},
			{Op: "tasklist_update", Optional: true, Why: "Its maxConcurrent, its pause, or the instructions spliced into each run's prompt."},
		},
		Rules: []string{
			"Most tasks need no list. A list decides when work may run, never what the work is: it is not a plan, a project or a folder.",
			"Pausing holds dispatch; it does not stop runs already in flight, and a paused list stays paused until someone unpauses it.",
		},
		Done:    "The receipt reads ok: true and outcome: written, with the list's id.",
		Related: []string{"task-create"},
	},
	{
		ID:     "agent",
		Intent: "Choose where work runs and under which identity, or change an agent's defaults.",
		Steps: []guideStep{
			{Op: "agent_list", Why: "The agents (workspaces) there are, where each runs and under which identity."},
			{Op: "agent_update", Optional: true, Why: "Change one's defaults; the owner answers a card first."},
			{Op: "agent_create", Optional: true, Why: "A new agent; the owner answers a card first."},
		},
		Rules: []string{
			"The whole agent family needs Session orchestration; without it, assign tasks to the agents a task row already names.",
			"An agent holds no engine or provider of its own: a task or a session pins those.",
		},
		Done:    "The agent receipt's id and status, once the owner's card answer allowed it.",
		Related: []string{"delegate"},
	},
	{
		ID:     "finish-task",
		Intent: "Carry the task this session runs to its end: progress, checks and the evidence its criterion decides by.",
		Steps: []guideStep{
			{Op: "task_get", Why: "Read the task this session runs (no id needed), its acceptance criteria and its comments, before acting."},
			{Op: "task_progress_report", Why: "Report each change of phase or count; Orbit reads progress from this report alone.",
				Example: map[string]interface{}{"phase": "<phase>", "current": 1, "total": 3}},
			{Op: "bg_run", Optional: true, Why: "Run the checks you will cite as runner-hosted jobs, and cite each job id as a TOOL_CALL."},
			{Op: "task_evidence_submit", Why: "Submit claim, checks and gaps; the task's declared criterion decides DONE."},
			{Op: "task_comment", Optional: true, Why: "If the work failed or could not be finished, say why first, then set FAILED with task_update."},
		},
		Rules: []string{
			"A direct DONE is refused for everyone: the criterion the task declares (EXECUTABLE, VERIFICATION, EVIDENCE_JUDGMENT, OWNER_CONFIRMED) decides.",
			"Evidence cites what Orbit recorded for this task (a bg_run job id, a commit, an uploaded file's id); do not paste command output into it.",
			"Never leave a task you could not finish IN_PROGRESS: explain with task_comment, then task_update status FAILED.",
		},
		Done:    "task_evidence_submit's receipt echoes every citation with whether it resolved; at least one must.",
		Related: []string{"files", "wait"},
	},
}

func guideTopicByID(id string) *guideTopic {
	for i := range guideTopics {
		if guideTopics[i].ID == id {
			return &guideTopics[i]
		}
	}
	return nil
}

func guideTopicIDs() []string {
	ids := make([]string, len(guideTopics))
	for i, topic := range guideTopics {
		ids[i] = topic.ID
	}
	return ids
}

// ── the catalogue row ───────────────────────────────────────────────────────────────────────────

// guideToolDescriptor is the guide's MCP descriptor: always listed, read-only by its own annotation (so a
// client's plan mode may call it), with an outputSchema of its own because its answer is a document, not
// a receipt.
func guideToolDescriptor(obj func(map[string]interface{}, ...string) map[string]interface{}) map[string]interface{} {
	return map[string]interface{}{
		"name": "guide",
		"description": "Orbit's map of its own operations, read-only and always listed. With no arguments it " +
			"answers the objects and the intent routes: which object and operation each kind of request belongs " +
			"to, and the topic that covers it. With a topic it answers that topic's shortest recipe: each step's " +
			"tool and CLI argv, whether it is available in this session and why not, whether it writes and who " +
			"must approve, a minimal example and what proves it succeeded, plus the rules that span the tools. " +
			"Call it before a write you are unsure how to make, or when a tool you expected is missing.",
		"inputSchema": obj(map[string]interface{}{
			"topic": map[string]interface{}{
				"type": "string",
				"enum": guideTopicIDs(),
				"description": "The topic to answer; omit it for the index, which names every topic with " +
					"the request it covers.",
			}}),
		"outputSchema": map[string]interface{}{
			"title": "OrbitGuideV1",
			"type":  "object",
			"properties": map[string]interface{}{
				"view":           map[string]interface{}{"type": "string", "enum": []string{"guide", "guide-topic"}},
				"guideVersion":   map[string]interface{}{"type": "string"},
				"catalogVersion": map[string]interface{}{"type": "string"},
				"catalogHash":    map[string]interface{}{"type": "string"},
				"context":        map[string]interface{}{"type": "object"},
			},
			"required": []string{"view", "guideVersion", "catalogVersion", "context"},
		},
		"annotations": map[string]interface{}{"readOnlyHint": true},
	}
}

// guideCLICapabilities is the guide's command: ungated like the tool, and offered in every context.
var guideCLICapabilities = []cliCapabilitySpec{{
	Tool:      "guide",
	Argv:      []string{"orbit", "guide"},
	Usage:     "orbit guide [TOPIC] [--json]",
	Arguments: []string{"[topic] (one of the topics the index lists; omit it for the index)", "--json"},
}}

// ── the document ────────────────────────────────────────────────────────────────────────────────

// guideContext is who asked and what this session can reach: the answers to "may I" that every step's
// availability is computed from.
type guideContext struct {
	Surface       string `json:"surface"`
	Actor         string `json:"actor"`
	SessionID     string `json:"sessionId,omitempty"`
	AgentID       string `json:"agentId,omitempty"`
	TaskID        string `json:"taskId,omitempty"`
	Orchestration bool   `json:"orchestration"`
	Watches       bool   `json:"watches"`
	Wiki          bool   `json:"wiki"`
}

// guideFacts is a guide's context plus what it reads availability from: the MCP server's own switches,
// and the CLI's offer when there is an executable to offer it from.
type guideFacts struct {
	context   guideContext
	onlyTools map[string]bool
	cli       *cliDiscovery
}

// guideRouteView is one route as the index answers it. mutates, approval and availability are its first
// operation's: the one the route sends a request to, of which the rest are alternatives.
type guideRouteView struct {
	Route             string            `json:"route"`
	Intent            string            `json:"intent"`
	Object            string            `json:"object"`
	Topic             string            `json:"topic,omitempty"`
	Operations        []string          `json:"operations"`
	Mutates           bool              `json:"mutates"`
	Approval          operationApproval `json:"approval,omitempty"`
	Available         bool              `json:"available"`
	UnavailableReason string            `json:"unavailableReason,omitempty"`
}

type guideTopicRef struct {
	Topic  string `json:"topic"`
	Intent string `json:"intent"`
}

// guideNext is how to ask the guide and the catalogue for more, on either surface.
type guideNext struct {
	Topic      guideCall `json:"topic"`
	Capability []string  `json:"capability,omitempty"`
	Summary    []string  `json:"summary,omitempty"`
}

type guideCall struct {
	MCP  map[string]interface{} `json:"mcp"`
	Argv []string               `json:"argv,omitempty"`
}

type guideIndexDocument struct {
	View           string           `json:"view"`
	GuideVersion   string           `json:"guideVersion"`
	CatalogVersion string           `json:"catalogVersion"`
	CatalogHash    string           `json:"catalogHash"`
	Context        guideContext     `json:"context"`
	Objects        []guideObject    `json:"objects"`
	Routes         []guideRouteView `json:"routes"`
	Rules          []string         `json:"rules"`
	Topics         []guideTopicRef  `json:"topics"`
	Next           guideNext        `json:"next"`
}

// guideSurface is one step on one surface: the tool or the argv, whether it runs here, and its example.
type guideSurface struct {
	Tool              string                 `json:"tool,omitempty"`
	Argv              []string               `json:"argv,omitempty"`
	Available         bool                   `json:"available"`
	UnavailableReason string                 `json:"unavailableReason,omitempty"`
	Arguments         map[string]interface{} `json:"arguments,omitempty"`
	Example           []string               `json:"example,omitempty"`
}

type guideStepView struct {
	Step            int               `json:"step"`
	ID              string            `json:"id"`
	Why             string            `json:"why"`
	Optional        bool              `json:"optional,omitempty"`
	Mutates         bool              `json:"mutates"`
	Approval        operationApproval `json:"approval"`
	ApprovalKey     string            `json:"approvalKey,omitempty"`
	SuccessEvidence string            `json:"successEvidence"`
	MCP             *guideSurface     `json:"mcp,omitempty"`
	CLI             *guideSurface     `json:"cli,omitempty"`
}

type guideTopicDocument struct {
	View           string          `json:"view"`
	GuideVersion   string          `json:"guideVersion"`
	CatalogVersion string          `json:"catalogVersion"`
	CatalogHash    string          `json:"catalogHash"`
	Topic          string          `json:"topic"`
	Intent         string          `json:"intent"`
	Routes         []string        `json:"routes,omitempty"`
	Context        guideContext    `json:"context"`
	Steps          []guideStepView `json:"steps"`
	Rules          []string        `json:"rules"`
	Done           string          `json:"done"`
	Related        []string        `json:"related,omitempty"`
}

// mcpAvailability is whether op's MCP tool is served in this session, and why not.
func (f guideFacts) mcpAvailability(op *operation) (bool, string) {
	if op.MCP == nil {
		return false, "no MCP tool (" + op.MCPExempt + "); run its CLI command"
	}
	if f.onlyTools != nil && !f.onlyTools[op.Tool] {
		return false, op.Tool + " is not served in this session"
	}
	switch op.Gate {
	case gateOrchestration:
		if !f.context.Orchestration {
			return false, orchestrationOffMsg
		}
	case gatePermissionPrompt:
		return false, "the engine's own permission bridge, not for direct use"
	}
	if watchToolNames[op.Tool] && !f.context.Watches {
		return false, watchesOffMessage(op.Tool)
	}
	if wikiToolNames[op.Tool] && !f.context.Wiki {
		return false, wikiOffMessage(op.Tool)
	}
	return true, ""
}

func (f guideFacts) available(op *operation) (bool, string) {
	if f.context.Surface == "cli" && f.cli != nil {
		return f.cli.cliAvailability(op)
	}
	return f.mcpAvailability(op)
}

func (f guideFacts) exe() string {
	if f.cli == nil {
		return ""
	}
	return f.cli.exe
}

func guideCatalogIdentity(built *builtOperationCatalog) (string, string) {
	return operationCatalogVersion, built.Hash
}

func (f guideFacts) index(built *builtOperationCatalog) guideIndexDocument {
	version, hash := guideCatalogIdentity(built)
	doc := guideIndexDocument{
		View:           "guide",
		GuideVersion:   agentGuideVersion,
		CatalogVersion: version,
		CatalogHash:    hash,
		Context:        f.context,
		Objects:        guideObjects,
		Rules:          guideRules,
	}
	for _, route := range guideRoutes {
		view := guideRouteView{Route: route.Route, Intent: route.Intent, Object: route.Object, Topic: route.Topic,
			Operations: append([]string{}, route.Ops...), Available: true}
		if view.Operations == nil {
			view.Operations = []string{}
		}
		if len(route.Ops) > 0 {
			if op := built.ByTool[route.Ops[0]]; op != nil {
				view.Mutates, view.Approval = op.Mutates, op.Approval
				view.Available, view.UnavailableReason = f.available(op)
			}
		}
		doc.Routes = append(doc.Routes, view)
	}
	for _, topic := range guideTopics {
		doc.Topics = append(doc.Topics, guideTopicRef{Topic: topic.ID, Intent: topic.Intent})
	}
	doc.Next.Topic.MCP = map[string]interface{}{"tool": "guide", "arguments": map[string]interface{}{"topic": "<topic>"}}
	if exe := f.exe(); exe != "" {
		doc.Next.Topic.Argv = []string{exe, "guide", "<topic>", "--json"}
		doc.Next.Capability = []string{exe, "capabilities", "--id", "<id>", "--json"}
		doc.Next.Summary = []string{exe, "capabilities", "--summary", "--json"}
	}
	return doc
}

func (f guideFacts) topic(built *builtOperationCatalog, topic *guideTopic) guideTopicDocument {
	version, hash := guideCatalogIdentity(built)
	doc := guideTopicDocument{
		View:           "guide-topic",
		GuideVersion:   agentGuideVersion,
		CatalogVersion: version,
		CatalogHash:    hash,
		Topic:          topic.ID,
		Intent:         topic.Intent,
		Context:        f.context,
		Rules:          topic.Rules,
		Done:           topic.Done,
		Related:        topic.Related,
	}
	for _, route := range guideRoutes {
		if route.Topic == topic.ID {
			doc.Routes = append(doc.Routes, route.Route)
		}
	}
	for i, step := range topic.Steps {
		op := built.ByTool[step.Op]
		if op == nil {
			continue
		}
		view := guideStepView{
			Step:            i + 1,
			ID:              op.Tool,
			Why:             step.Why,
			Optional:        step.Optional,
			Mutates:         op.Mutates,
			Approval:        op.Approval,
			ApprovalKey:     op.ApprovalKey,
			SuccessEvidence: op.SuccessEvidence,
		}
		withStep := guideStepOperation(op, step.Example)
		available, reason := f.mcpAvailability(op)
		if op.MCP != nil || f.context.Surface == "mcp" {
			view.MCP = &guideSurface{Available: available, UnavailableReason: reason}
			if op.MCP != nil {
				view.MCP.Tool = op.Tool
				view.MCP.Arguments = catalogMCPExample(withStep)
			}
		}
		if exe := f.exe(); exe != "" {
			cliAvailable, cliReason := f.cli.cliAvailability(op)
			view.CLI = &guideSurface{Available: cliAvailable, UnavailableReason: cliReason}
			if op.CLI != nil {
				view.CLI.Argv = append([]string{exe}, op.CLI.Argv[1:]...)
				view.CLI.Example = catalogCLIExample(withStep, exe)
			}
		}
		doc.Steps = append(doc.Steps, view)
	}
	return doc
}

// guideStepOperation is op with this step's arguments layered over the row's declared example: what the
// generic example becomes in this recipe. A nil value takes the field out.
func guideStepOperation(op *operation, overrides map[string]interface{}) *operation {
	if len(overrides) == 0 {
		return op
	}
	example := make(map[string]interface{}, len(op.Example)+len(overrides))
	for key, value := range op.Example {
		example[key] = value
	}
	for key, value := range overrides {
		if value == nil {
			delete(example, key)
			continue
		}
		example[key] = value
	}
	copied := *op
	copied.Example = example
	return &copied
}

// guideAnswer is the guide's document for a topic, or the index for "".
func guideAnswer(f guideFacts, topic string) (interface{}, error) {
	built := operationCatalog()
	if topic == "" {
		return f.index(built), nil
	}
	t := guideTopicByID(topic)
	if t == nil {
		return nil, fmt.Errorf("no guide topic %q; the topics are %s", topic, strings.Join(guideTopicIDs(), ", "))
	}
	return f.topic(built, t), nil
}

// ── the MCP door ────────────────────────────────────────────────────────────────────────────────

func (s *mcpServer) guideFacts() guideFacts {
	actor := "runner_owner"
	if strings.TrimSpace(s.sessionID) != "" && strings.TrimSpace(s.agentID) != "" {
		actor = "agent"
	}
	f := guideFacts{
		context: guideContext{
			Surface:       "mcp",
			Actor:         actor,
			SessionID:     s.sessionID,
			AgentID:       s.agentID,
			TaskID:        s.taskID,
			Orchestration: s.orchestrationEnabled(),
			Watches:       !s.watchesOff,
			Wiki:          !s.wikiOff,
		},
		onlyTools: s.onlyTools,
	}
	if exe := orbitCLIExecutable(); exe != "" {
		f.cli = newCLIDiscovery(exe)
	}
	return f
}

func (s *mcpServer) callGuide(args map[string]interface{}) map[string]interface{} {
	doc, err := guideAnswer(s.guideFacts(), strings.TrimSpace(getString(args, "topic")))
	if err != nil {
		return toolResult(err.Error(), true)
	}
	blob, err := json.Marshal(doc)
	if err != nil {
		return toolResult("guide: "+err.Error(), true)
	}
	// The structured content is the document itself, as its outputSchema says; the text is the same
	// document for a client that reads only text.
	var data map[string]interface{}
	if err := json.Unmarshal(blob, &data); err != nil {
		return toolResult("guide: "+err.Error(), true)
	}
	return toolResultWithData(string(blob), data, false)
}

// ── the CLI door ────────────────────────────────────────────────────────────────────────────────

func cliGuideFacts(executable string) guideFacts {
	d := newCLIDiscovery(executable)
	return guideFacts{
		context: guideContext{
			Surface:       "cli",
			Actor:         d.doc.Context.Actor,
			SessionID:     d.doc.Context.SessionID,
			AgentID:       d.doc.Context.AgentID,
			TaskID:        d.doc.Context.TaskID,
			Orchestration: d.facts.orchestration,
			Watches:       d.facts.watches,
			Wiki:          d.facts.wiki,
		},
		cli: d,
	}
}

func cmdGuideCLI(args []string, out io.Writer) error {
	topic, rest := peelLeadingID(args)
	fs := newCLIFlagSet("orbit guide")
	jsonOut := fs.Bool("json", false, "emit JSON")
	if err := fs.Parse(rest); err != nil {
		return err
	}
	if topic == "" && fs.NArg() == 1 {
		topic = fs.Arg(0)
	} else if err := rejectTrailing(fs); err != nil {
		return err
	}
	executable := orbitCLIExecutable()
	if executable == "" {
		return fmt.Errorf("cannot resolve a safe absolute path to the Orbit executable")
	}
	doc, err := guideAnswer(cliGuideFacts(executable), topic)
	if err != nil {
		return err
	}
	if *jsonOut {
		enc := json.NewEncoder(out)
		enc.SetEscapeHTML(false)
		return enc.Encode(doc)
	}
	_, err = io.WriteString(out, guideText(doc))
	return err
}

// guideText is the guide for a person at a terminal: the same content, in lines.
func guideText(doc interface{}) string {
	var b strings.Builder
	switch d := doc.(type) {
	case guideIndexDocument:
		fmt.Fprintf(&b, "Orbit guide %s (operation catalog v%s)\n\nWhat the person asks for, and where it goes:\n", d.GuideVersion, d.CatalogVersion)
		for _, route := range d.Routes {
			topic := "-"
			if route.Topic != "" {
				topic = route.Topic
			}
			ops := strings.Join(route.Operations, ", ")
			if ops == "" {
				ops = "nothing to record"
			}
			fmt.Fprintf(&b, "  %-6s %-15s %s\n         %s\n", route.Route, topic, route.Intent, ops)
			if !route.Available {
				fmt.Fprintf(&b, "         not available here: %s\n", route.UnavailableReason)
			}
		}
		b.WriteString("\nRules:\n")
		for _, rule := range d.Rules {
			fmt.Fprintf(&b, "  %s\n", rule)
		}
		b.WriteString("\nRun 'orbit guide TOPIC' for a topic's recipe.\n")
	case guideTopicDocument:
		fmt.Fprintf(&b, "%s — %s\n", d.Topic, d.Intent)
		for _, step := range d.Steps {
			optional := ""
			if step.Optional {
				optional = " (optional)"
			}
			fmt.Fprintf(&b, "\n%d. %s%s — %s\n", step.Step, step.ID, optional, step.Why)
			if step.CLI != nil && len(step.CLI.Example) > 0 {
				fmt.Fprintf(&b, "   %s\n", shellJoin(step.CLI.Example))
			}
			if step.CLI != nil && !step.CLI.Available {
				fmt.Fprintf(&b, "   not available here: %s\n", step.CLI.UnavailableReason)
			}
			fmt.Fprintf(&b, "   success: %s\n", step.SuccessEvidence)
		}
		b.WriteString("\nRules:\n")
		for _, rule := range d.Rules {
			fmt.Fprintf(&b, "  - %s\n", rule)
		}
		fmt.Fprintf(&b, "\nDone when: %s\n", d.Done)
	}
	return b.String()
}
