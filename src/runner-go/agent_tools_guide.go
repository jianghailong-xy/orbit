package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// The Agent Tools guide: how agents use Orbit, written for the person who works with them
// (docs/orbit-agent-contract.md §2.7). The agent learns the same rules from its primer, the tools'
// descriptions and the `guide` tool; this is the person's side of the same contract, so that what they
// can see does not depend on reading the Orbit repository.
//
// One source, five outputs, each held to it by agent_tools_guide_test.go (re-rendered with
// ORBIT_UPDATE_AGENT_TOOLS_GUIDE=1):
//
//   - docs/agent-tools-guide.md, the public document;
//   - src/web/src/lib/agentToolsGuide.generated.json, which the web console's Agent tools drawer reads;
//   - src/macos/OrbitKit/Sources/OrbitKit/AgentTools/AgentToolsGuide.generated.swift, the same JSON for
//     the macOS sheet;
//   - the managed playbooks skill, written for Claude Code as a plugin passed with --plugin-dir and for
//     Codex as a skill root handed to its app server (skills/extraRoots/set), with its text snapshotted
//     under testdata/agent-tools/.
//
// Everything that names an operation comes from the operation catalogue or the route guide
// (agent_guide.go): the routes and rules are guideRoutes and guideRules, an example's MCP arguments are
// checked against the tool's own schema and its CLI line against the command's own flag parser, and a
// family is the set of catalogued MCP tools it is drawn from. What a section says in prose is authored
// here, once.
//
// The skill carries only the long recipes (a worked-out plan, a batch from a file, handing work off,
// finding out why a tool is missing). Nothing depends on it: the primer, the tools' descriptions and
// `guide` are enough for every single call, and the primer never names it.

// agentToolsGuideVersion is the version of this guide's content and of the playbooks skill rendered
// from it. A section, an example or a playbook added, removed or rewritten is a new version.
const agentToolsGuideVersion = "1.0.0"

// The managed skill's names. Claude Code namespaces a plugin's skills by the plugin, so the plugin
// "orbit" with the skill "playbooks" is offered as `orbit:playbooks`; Codex lists a skill by its own name.
const (
	claudeManagedPluginName = "orbit"
	claudeManagedSkillName  = "playbooks"
	codexManagedSkillName   = "orbit-playbooks"
)

// claudeManagedSkillID is the name Claude Code lists the skill under (its init frame's `skills`).
const claudeManagedSkillID = claudeManagedPluginName + ":" + claudeManagedSkillName

// ── the content ───────────────────────────────────────────────────────────────────────────────────

// agentToolsSection is one part of "How agents use Orbit": a title, the one sentence it rests on, the
// points that follow from it, and things a person can say that this part answers.
type agentToolsSection struct {
	ID     string   `json:"id"`
	Title  string   `json:"title"`
	Lead   string   `json:"lead"`
	Points []string `json:"points"`
	Asks   []string `json:"asks,omitempty"`
}

// agentToolsSectionIDs are the sections the guide must carry, in order (the acceptance of P1-03): MCP
// first, the record and the private plan, object routing, create versus start, the CLI's place, and
// what to do when something is missing.
var agentToolsSectionIDs = []string{"mcp-first", "record-vs-plan", "which-object", "create-vs-start", "cli", "troubleshooting"}

func agentToolsSections() []agentToolsSection {
	return []agentToolsSection{
		{
			ID:    "mcp-first",
			Title: "MCP first, the CLI by exception",
			Lead: "An agent reaches Orbit through Orbit's MCP tools whenever its tool list has them: they are checked " +
				"against their schema, need no shell, and carry this session's identity without an argument.",
			Points: []string{
				"Claude Code lists them as mcp__orbit__<tool>; Codex and the other engines show the same server's tools under their own prefix.",
				"Every write answers with a receipt: ok, outcome, the entity's id and its status. A write happened only when the receipt says ok: true and outcome: written.",
				"When the agent is unsure which tool fits or how to call it, it calls guide: with no arguments for the routes, with a topic for the recipe. guide is listed in every session, whatever its switches.",
				"MCP and the CLI reach the same server with the same approvals, attribution and ids: a task created on one is read on the other with no translation.",
			},
			Asks: []string{
				"Which Orbit tools do you have in this session?",
				"Call guide and tell me which tool records a follow-up.",
			},
		},
		{
			ID:    "record-vs-plan",
			Title: "Your record and the agent's private plan",
			Lead:  "Orbit is your durable record; the engine's own todo or plan tool is the agent's private scratch.",
			Points: []string{
				"A plan the engine keeps lives in this conversation only: nobody else sees it, and a compaction can drop it.",
				"Work you want kept or followed up goes to Orbit, where it has an id and a status that you, the apps and later sessions can read.",
				"The agent never calls a private plan a task, and never says it filed something without an id Orbit returned.",
				"When you say \"keep that plan\", the plan becomes one task_create_batch: one task per item, its order as dependsOnRefs, its parts as parentRef, in one call and one card.",
			},
			Asks: []string{
				"Think this migration through first; don't file anything yet.",
				"OK, keep that plan in Orbit.",
			},
		},
		{
			ID:    "which-object",
			Title: "Which object a request belongs to",
			Lead:  "Each request goes to the object that answers its question; when two fit, the smaller one wins.",
			Points: append(objectPoints(), []string{
				"Not every request is an Orbit write: answering a question, explaining or editing code records nothing.",
			}...),
			Asks: []string{
				"Remember to rotate the staging key.",
				"What is still open in the agent-contract project?",
			},
		},
		{
			ID:    "create-vs-start",
			Title: "Creating is not starting",
			Lead:  "task_create records work and runs nothing in the call; starting it is a decision of its own.",
			Points: []string{
				"task_start runs work that is already recorded, on its assignee, once its prerequisites are DONE.",
				"task_create with startNow: true records the work and starts it on one card.",
				"runAt starts it once, at a set time; it is not a deadline (that is dueDate).",
				"autoRunWhenReady defaults to true: an assigned task in a started project starts by itself once every prerequisite is DONE. To hold work until you say so, the agent passes autoRunWhenReady: false.",
				"Your own \"Create and start\" on the card starts it even if the agent asked for no start, and the agent does not undo that.",
			},
			Asks: []string{
				"File this for later; nobody should start it until I say so.",
				"Run the recorded migration task now.",
			},
		},
		{
			ID:    "cli",
			Title: "When the CLI is the right tool",
			Lead: "The Orbit CLI is for what MCP does not do well: pipes and scripts, bulk input from a file or stdin, " +
				"the few operations with no MCP tool, and commands that must outlive the turn.",
			Points: append([]string{
				"The agent runs it by the absolute path Orbit gives it, never an orbit found on PATH: a project-local binary is not this runner's CLI.",
				"It finds a command with orbit guide [topic] --json or orbit capabilities --id <id> --json, and runs the argv they return.",
				"--receipt prints the same receipt the MCP tool answers with, and the command exits 0 exactly when it wrote; --json prints the entity alone.",
				"Never to get around a card, a refusal or a switch: the CLI reaches the same server under the same approvals, so a declined card or a missing switch there is the same answer.",
				"Outside a session, a script files work as you, with a personal access token (ORBIT_USER_TOKEN): the runner's own credential has no card-free door.",
			}, cliOnlyPoint()...),
			Asks: []string{
				"File the 30 issues in issues.csv as tasks.",
				"Give me a command I can put in cron that files tomorrow's checklist.",
			},
		},
		{
			ID:    "troubleshooting",
			Title: "When something is missing",
			Lead: "Every refusal says why and what to do, and none of them is solved by another door: the switches stay where " +
				"they are, and Agent tools shows which one is off.",
			Points: []string{
				"Agent tools on the session shows whether its engine started Orbit's MCP server, and in the engine's own words why not.",
				"A missing family of tools is a switch: Session orchestration for sessions, agents and runners; Watch for waits; the wiki for the wiki.",
				"A refused call answers with a receipt whose error.code and error.retry say what to do; the table below reads them for you.",
			},
			Asks: []string{
				"Why can't you start a session for this?",
				"Call guide and tell me which Orbit tools you have and why any are missing.",
			},
		},
	}
}

// objectPoints is the contract's five objects (§1.1) as the guide states them, each with the question it
// answers, and the routing rules R2-R5.
func objectPoints() []string {
	labels := map[string]string{"project": "Project", "task": "Task", "task_list": "Task list", "session": "Session", "agent": "Agent"}
	var points []string
	for _, object := range guideObjects {
		points = append(points, labels[object.ID]+": "+object.Question)
	}
	return points
}

// cliOnlyPoint names the agent-facing operations the catalogue serves only at the CLI, read from the
// catalogue so the sentence cannot fall behind it.
func cliOnlyPoint() []string {
	var names []string
	for _, op := range operationCatalog().Ops {
		if op.MCP == nil && op.CLI != nil && !op.CLI.HeadlessOnly {
			names = append(names, op.Tool)
		}
	}
	if len(names) == 0 {
		return nil
	}
	sort.Strings(names)
	return []string{"The operations with no MCP tool are " + strings.Join(names, ", ") + "; the agent runs them at the CLI."}
}

// agentToolsTrouble is one row of "when something is missing": what the person sees, why, and what to do.
// Code is the receipt's error.code when the row is a refusal (held to the codes Orbit really answers).
type agentToolsTrouble struct {
	ID      string `json:"id"`
	Symptom string `json:"symptom"`
	Cause   string `json:"cause"`
	Fix     string `json:"fix"`
	Code    string `json:"code,omitempty"`
}

func agentToolsTroubles() []agentToolsTrouble {
	return []agentToolsTrouble{
		{ID: "not-connected", Symptom: "The agent has no Orbit tools.",
			Cause: "Its engine did not start Orbit's MCP server. Agent tools on the session shows Not connected, with the engine's own reason.",
			Fix:   "The agent can still use the Orbit CLI by the absolute path in its instructions, under the same approvals. A new session starts the server again."},
		{ID: "orchestration-off", Code: "ORCHESTRATION_OFF", Symptom: "No session, agent or runner tools, and a hand-off is filed as a task.",
			Cause: "Session orchestration is off for this account.",
			Fix:   "Turn it on in Settings → Session orchestration. A session started before that gets the tools when its engine next starts; turning it off takes effect at once."},
		{ID: "watch-off", Symptom: "No task_await, session_await or watch tools.",
			Cause: "Watch is off for this account on this Orbit server.",
			Fix:   "Nothing to change in the session: the agent looks again in a later turn instead of waiting."},
		{ID: "wiki-off", Symptom: "No wiki tools.",
			Cause: "The wiki is off for this account on this Orbit server.",
			Fix:   "The agent works from the code and from what you tell it."},
		{ID: "plan-mode", Code: "SESSION_IN_PLAN_MODE", Symptom: "A write is refused with SESSION_IN_PLAN_MODE.",
			Cause: "The session is in Plan: Orbit's reads, waits and questions for you run, and every other write waits for the plan's approval.",
			Fix:   "Approve the plan or change the session's permission mode; the agent makes the write then."},
		{ID: "mode-unreadable", Code: "PERMISSION_MODE_UNREADABLE", Symptom: "A write is refused with PERMISSION_MODE_UNREADABLE.",
			Cause: "The session's process could not read its permission mode from the runner, so it wrote nothing.",
			Fix:   "The same call is safe to send again. If it keeps happening, the runner restarted under the session: start a new one."},
		{ID: "declined", Code: "APPROVAL_DECLINED", Symptom: "The agent says you declined a card.",
			Cause: "You answered the card with no.",
			Fix:   "Nothing was written, and the agent does not create it another way. Ask again in your own words if you change your mind."},
		{ID: "waiting", Code: "AWAITING_OWNER", Symptom: "A write is waiting.",
			Cause: "Its card is waiting for your answer; the runner holds the call meanwhile.",
			Fix:   "Answer the card in the app; the agent is woken with your answer. A card that waits is not a no."},
		{ID: "chat", Symptom: "The agent replies to what you wrote on a card instead of filing.",
			Cause: "You pressed Chat about this: that is a conversation, not a no, and nothing was written.",
			Fix:   "Once you agree, the agent calls again, changed as agreed, and you get a new card."},
		{ID: "invalid", Code: "INVALID_ARGUMENTS", Symptom: "A call is refused with INVALID_ARGUMENTS.",
			Cause: "Its arguments do not fit the tool's schema; the receipt names every field that does not.",
			Fix:   "The agent fixes the fields it names and calls again: nothing was sent."},
		{ID: "unknown", Code: "NO_RESPONSE", Symptom: "A create comes back with outcome unknown.",
			Cause: "It was sent and no answer came back, so it may have landed.",
			Fix:   "The agent reads first (task_list) and only then decides; a create keyed with idempotencyKey is resent by the runner under the same key and cannot file twice."},
		{ID: "machine-credential", Code: "TASK_WRITE_NEEDS_OWNER_CARD", Symptom: "A script on the runner is refused with TASK_WRITE_NEEDS_OWNER_CARD.",
			Cause: "Outside a session, the runner's own credential cannot file work: that would be a way around your cards.",
			Fix:   "Run the script with your personal access token (ORBIT_USER_TOKEN); the work is recorded as you."},
		{ID: "wrong-binary", Symptom: "An orbit command behaves unlike the agent's tools.",
			Cause: "A different orbit was found on PATH, such as a project-local build.",
			Fix:   "The agent runs the absolute path in its instructions; capabilities --json names the cliVersion that answered."},
	}
}

// agentToolsExample is one worked example: what a person says, what the agent does, the calls it makes on
// each surface, and what proves it. The MCP calls are held to the tools' schemas and the CLI lines to the
// commands' flag parsers (TestAgentToolsExamplesAreAcceptedByTheirSurfaces); a line starting with "orbit"
// is a command, any other is the shell around it.
type agentToolsExample struct {
	ID       string           `json:"id"`
	Title    string           `json:"title"`
	Ask      string           `json:"ask"`
	Does     string           `json:"does"`
	MCP      []agentToolsCall `json:"mcp"`
	CLI      [][]string       `json:"cli"`
	Script   string           `json:"script,omitempty"`
	Proof    string           `json:"proof"`
	Scenario string           `json:"scenario"`
	Playbook string           `json:"playbook,omitempty"`
}

type agentToolsCall struct {
	Tool      string                 `json:"tool"`
	Arguments map[string]interface{} `json:"arguments"`
}

// agentToolsExampleIDs are the examples the guide must carry (the acceptance of P1-03): record a task,
// keep a plan of several steps, hand work off now, and a batch from a script.
var agentToolsExampleIDs = []string{"record-task", "keep-plan", "delegate-now", "batch-script"}

func agentToolsExamples() []agentToolsExample {
	planItems := []interface{}{
		map[string]interface{}{"ref": "s1", "title": "Add the new columns", "description": "<what to do, the files, the steps>",
			"completionCriterion": "EVIDENCE_JUDGMENT", "acceptanceCriteria": "<what settles it>"},
		map[string]interface{}{"ref": "s2", "title": "Backfill the rows", "description": "<what to do, the files, the steps>",
			"completionCriterion": "EVIDENCE_JUDGMENT", "acceptanceCriteria": "<what settles it>", "dependsOnRefs": []interface{}{"s1"}},
		map[string]interface{}{"ref": "s3", "title": "Switch the reads over", "description": "<what to do, the files, the steps>",
			"completionCriterion": "EVIDENCE_JUDGMENT", "acceptanceCriteria": "<what settles it>", "dependsOnRefs": []interface{}{"s2"},
			"autoRunWhenReady": false},
	}
	return []agentToolsExample{
		{
			ID:    "record-task",
			Title: "Record a task",
			Ask:   "File this for later: rotate the staging API key. Nobody should start it until I say so.",
			Does: "Says what it is about to file, then makes one task_create with autoRunWhenReady: false and a key derived " +
				"from the work. You answer one card; nothing starts.",
			MCP: []agentToolsCall{{Tool: "task_create", Arguments: map[string]interface{}{
				"title":               "Rotate the staging API key",
				"description":         "<background, where the key lives, the steps>",
				"completionCriterion": "EVIDENCE_JUDGMENT",
				"acceptanceCriteria":  "<what you said would settle it>",
				"autoRunWhenReady":    false,
				"idempotencyKey":      "rotate-staging-api-key",
			}}},
			CLI: [][]string{{"orbit", "task", "create", "--title", "Rotate the staging API key",
				"--description", "<background, where the key lives, the steps>",
				"--completion-criterion", "EVIDENCE_JUDGMENT", "--acceptance-criteria", "<what you said would settle it>",
				"--auto-run-when-ready=false", "--idempotency-key", "rotate-staging-api-key", "--receipt"}},
			Proof:    "The receipt reads ok: true, outcome: written, with the task's id and status OPEN; the agent links it as the task's name, and no session starts.",
			Scenario: "E1-record-task, E3-create-no-start",
		},
		{
			ID:    "keep-plan",
			Title: "Keep a plan of several steps",
			Ask:   "Keep that three-step migration plan in Orbit, in order, and hold the last step until I say so.",
			Does: "Turns its private plan into one task_create_batch: one item per step, each later step dependsOnRefs " +
				"the one before, the held step with autoRunWhenReady: false. One card covers the whole plan.",
			MCP: []agentToolsCall{
				{Tool: "task_create_batch", Arguments: map[string]interface{}{"tasks": planItems, "dryRun": true}},
				{Tool: "task_create_batch", Arguments: map[string]interface{}{"tasks": planItems, "idempotencyKey": "orders-migration-plan"}},
			},
			CLI: [][]string{
				{"orbit", "task", "create-batch", "--tasks-file", "-", "--dry-run", "--json"},
				{"orbit", "task", "create-batch", "--tasks-file", "-", "--idempotency-key", "orders-migration-plan", "--receipt"},
			},
			Proof:    "The receipt reads ok: true, outcome: written, with three ids in input order, each with its ref; the order is visible as dependencies when the tasks are read back.",
			Scenario: "E2-private-plan, E4-batch-plan",
			Playbook: "keep-a-plan",
		},
		{
			ID:    "delegate-now",
			Title: "Hand work off now",
			Ask:   "Have someone fix the flaky watch test right now.",
			Does: "Recorded work: task_start on it. Work not recorded yet: task_create with startNow: true, one card for both. " +
				"A conversation of its own: session_create, which needs Session orchestration; without it the agent files a task " +
				"and tells you where the switch is.",
			MCP: []agentToolsCall{
				{Tool: "task_start", Arguments: map[string]interface{}{"taskId": "<taskId>"}},
				{Tool: "task_create", Arguments: map[string]interface{}{
					"title": "Fix the flaky watch test", "description": "<the failing test, how it fails, where>",
					"completionCriterion": "EVIDENCE_JUDGMENT", "acceptanceCriteria": "<what settles it>",
					"startNow": true, "idempotencyKey": "fix-flaky-watch-test"}},
				{Tool: "session_create", Arguments: map[string]interface{}{"prompt": "<the whole brief: what, where, how to check>"}},
			},
			CLI: [][]string{
				{"orbit", "task", "start", "<taskId>", "--receipt"},
				{"orbit", "task", "create", "--title", "Fix the flaky watch test", "--description", "<the failing test, how it fails, where>",
					"--completion-criterion", "EVIDENCE_JUDGMENT", "--acceptance-criteria", "<what settles it>",
					"--start-now", "--idempotency-key", "fix-flaky-watch-test", "--receipt"},
				{"orbit", "session", "create", "--prompt", "<the whole brief: what, where, how to check>", "--receipt"},
			},
			Proof:    "A started session's id: task_start's receipt names it, a startNow create carries it as start.sessionId, and session_create's receipt is the session itself.",
			Scenario: "E6-immediate-delegation, E7-no-orchestration",
			Playbook: "delegate-now",
		},
		{
			ID:    "batch-script",
			Title: "File many tasks from a script",
			Ask:   "File the 30 issues in issues.txt as tasks, held until I start them.",
			Does: "Uses the CLI's bulk door instead of one task_create per line: a script turns the file into one --tasks " +
				"document (at most 50 items), a dry run shows where it lands, and one create-batch writes it on one card.",
			MCP: []agentToolsCall{},
			CLI: [][]string{
				{"orbit", "task", "create-batch", "--tasks-file", "-", "--dry-run", "--json"},
				{"orbit", "task", "create-batch", "--tasks-file", "-", "--idempotency-key", "issues-txt-part-1", "--receipt"},
			},
			Script:   agentToolsBatchScript,
			Proof:    "--receipt prints one receipt with every item's id in input order, and the command exits 0 exactly when it wrote. Outside a session the same command runs with ORBIT_USER_TOKEN and is recorded as you.",
			Scenario: "E4-batch-plan",
			Playbook: "batch-script",
		},
	}
}

// agentToolsPlaybook is one long recipe of the managed skill: when to use it, and its steps. ASCII, like
// every other text Orbit puts in front of a model.
type agentToolsPlaybook struct {
	ID    string   `json:"id"`
	Title string   `json:"title"`
	When  string   `json:"when"`
	Steps []string `json:"steps"`
	Code  string   `json:"code,omitempty"`
}

// agentToolsBatchScript is the batch example's whole script: one --tasks document from a text file, a dry run
// and the write. Its two orbit lines are the example's CLI lines, which the test runs through the parser.
const agentToolsBatchScript = "jq -R -s 'split(\"\\n\") | map(select(length > 0)) | {tasks: map({title: ., description: (\"Fix: \" + .), " +
	"completionCriterion: \"EVIDENCE_JUDGMENT\", acceptanceCriteria: \"<what settles it>\", autoRunWhenReady: false})}' issues.txt > plan.json\n" +
	"orbit task create-batch --tasks-file - --dry-run --json < plan.json\n" +
	"orbit task create-batch --tasks-file - --idempotency-key issues-txt-part-1 --receipt < plan.json"

func agentToolsPlaybooks() []agentToolsPlaybook {
	return []agentToolsPlaybook{
		{
			ID:    "keep-a-plan",
			Title: "Keep a worked-out plan",
			When:  "The person asks you to keep a plan that is already worked out and counted, or several related pieces of work at once.",
			Steps: []string{
				"Pick the record. One item is one task_create. Several related items are one task_create_batch (at most 50). A body of work with its own goal and acceptance, 4 or more dependent steps or several agents over days, may be proposed as project_create first; its card is the person's answer, and a no means tasks.",
				"Give every item a ref (s1, s2, ...). Order with dependsOnRefs (when an item may run) and nest with parentRef (what it is part of). dependsOnTaskIds and parentTaskId name tasks that already exist.",
				"Ask the person what would settle each item and pass their words as acceptanceCriteria; declare completionCriterion on every item. If they have not said, ask and end your turn.",
				"Hold what must not start: autoRunWhenReady: false on that item. startNow: true only on an item they want running now.",
				"Unsure where it lands? Call task_create_batch with dryRun: true first: it writes nothing and asks nobody.",
				"Say in a sentence or two what you are about to file, then call task_create_batch once, keyed with an idempotencyKey derived from the plan.",
				"Read the receipt: ok: true, outcome: written, items[] in input order, each with its id. Link each as [title](orbit-task:<id>). A declined card is a refusal: do not file it another way.",
			},
		},
		{
			ID:    "batch-script",
			Title: "File many tasks from a file",
			When:  "The work arrives as a file or a list too long to type: issues in a text file or a CSV, lines of a checklist.",
			Steps: []string{
				"Use the CLI's bulk door, by the absolute path your instructions give, never one task_create per line.",
				"Build one --tasks document of at most 50 items with a script; every item carries title, description, completionCriterion and acceptanceCriteria, and autoRunWhenReady: false when it must wait.",
				"Preview it: orbit task create-batch --tasks-file - --dry-run --json writes nothing and says where every item would land.",
				"Write it: orbit task create-batch --tasks-file - --idempotency-key <a slug of the batch> --receipt. Inside a session it puts one card in front of the person; it exits 0 exactly when it wrote.",
				"More than 50 items: split them into parts, each with its own key. A part that fails can be sent again with the same key and cannot file twice.",
				"Outside a session (cron, CI) run the same command with the person's own token: ORBIT_USER_TOKEN=<token> orbit task create-batch ... is recorded as them and needs no card. The runner's machine credential cannot file work on its own (TASK_WRITE_NEEDS_OWNER_CARD).",
			},
			Code: agentToolsBatchScript,
		},
		{
			ID:    "delegate-now",
			Title: "Hand work off now",
			When:  "The person wants work running now, by another agent or in a conversation of its own.",
			Steps: []string{
				"Recorded already, with every prerequisite DONE: task_start on it. Its receipt names the started session.",
				"Not recorded yet: task_create with startNow: true. One card covers the create and the start; do not call task_start after it.",
				"The person wants a separate conversation rather than a work item: session_create on an agent. It exists only with Session orchestration on, and a sub-session never gets a wider permission mode than yours.",
				"No session_* tools in your list: orchestration is off. Record the work as a task, tell the person the switch is in Settings -> Session orchestration, and never claim a delegation.",
				"Then wait without polling: task_await or session_await, and end your turn. Orbit starts a new turn in this session when it finishes.",
			},
		},
		{
			ID:    "diagnose",
			Title: "Find out why an Orbit tool is missing or refused",
			When:  "A tool you expected is not in your list, or a call was refused and you are not sure why.",
			Steps: []string{
				"Call guide: it is listed in every session and only reads. Its index says, route by route, whether the route is available here and why not.",
				"No Orbit tools at all: your engine did not start Orbit's MCP server. Use the CLI at the absolute path your instructions give: orbit guide --json, then orbit capabilities --summary --json, whose unavailable and withheld groups say why each command is missing.",
				"A refused call: read its receipt, not its prose. error.code says what happened and error.retry what to do: resend, reread_first, fix_input, do_not_retry or wait.",
				"Never get around a refusal by changing surfaces: MCP and the CLI reach the same server under the same approvals, so the answer would be the same, and a second ask without a new question.",
				"Tell the person what is missing and where the switch is; the switches are theirs to change.",
			},
		},
	}
}

// ── families ─────────────────────────────────────────────────────────────────────────────────────

// agentToolsFamily is one group of Orbit's MCP tools as a person reads them: what they act on. Every
// catalogued MCP tool but the engine's permission bridge belongs to exactly one family
// (TestEveryOrbitToolHasOneFamily): the orchestration family is every tool the account's switch gates,
// and the rest go by the object the catalogue says they act on.
type agentToolsFamily struct {
	ID    string   `json:"id"`
	Label string   `json:"label"`
	Tools []string `json:"tools,omitempty"`
}

// agentToolsFamilyDefs is the families in the order a person reads them, with the catalogue objects each
// is drawn from. The orchestration family takes its tools by gate, before any object family.
var agentToolsFamilyDefs = []struct {
	ID      string
	Label   string
	Objects []string
}{
	{"tasks", "Tasks", []string{"task"}},
	{"projects", "Projects", []string{"project"}},
	{"task-lists", "Task lists", []string{"task_list"}},
	{"waits", "Waits", []string{"watch"}},
	{"files", "Files", []string{"file"}},
	{"background", "Background jobs", []string{"background_job", "session"}},
	{"owner", "Questions for you", []string{"owner"}},
	{"wiki", "Wiki", []string{"wiki"}},
	{"providers", "Providers", []string{"provider"}},
	{"merge-receipts", "Merge receipts", []string{"merge_receipt"}},
	{"guide", "Guide", []string{"catalog"}},
	{"orchestration", "Sessions, agents and runners", nil},
}

// agentToolsFamilyOf is the family an MCP tool belongs to, or "" for the engine's permission bridge.
func agentToolsFamilyOf(op *operation) string {
	if op == nil || op.MCP == nil || op.Gate == gatePermissionPrompt {
		return ""
	}
	if op.Gate == gateOrchestration {
		return "orchestration"
	}
	for _, family := range agentToolsFamilyDefs {
		for _, object := range family.Objects {
			if string(op.Object) == object {
				return family.ID
			}
		}
	}
	return ""
}

// agentToolsFamilies is every family with the MCP tools the catalogue puts in it.
func agentToolsFamilies() []agentToolsFamily {
	byFamily := map[string][]string{}
	for _, op := range operationCatalog().Ops {
		if id := agentToolsFamilyOf(op); id != "" {
			byFamily[id] = append(byFamily[id], op.Tool)
		}
	}
	families := make([]agentToolsFamily, 0, len(agentToolsFamilyDefs))
	for _, def := range agentToolsFamilyDefs {
		tools := byFamily[def.ID]
		sort.Strings(tools)
		families = append(families, agentToolsFamily{ID: def.ID, Label: def.Label, Tools: tools})
	}
	return families
}

// ── what the agent reads ─────────────────────────────────────────────────────────────────────────

// agentToolsLayer is one source of instructions an engine's model reads, in the order the engine puts it
// in front of the model, with the role it reads it in. Measured 2026-11-14 by recording each engine's own
// request to a local stub: Claude Code 2.1.325 (Anthropic messages) and Codex 0.167.2 (an app server
// thread on a Responses endpoint).
//
// When lists what must hold for the layer to be there, all of it; none means always. "base": the workspace
// replaces the engine's own prompt, and "no_base" is the engine's own prompt where it does not. "workspace":
// the workspace has runtime instructions of its own. A Codex carrier ("additional_context",
// "developer_message", "turn_input"): Orbit's runtime instructions travel by one of three, chosen by the Codex
// version (codexInstructionModeForUserAgent), and the workspace's travel with them.
type agentToolsLayer struct {
	ID        string   `json:"id"`
	Title     string   `json:"title"`
	Role      string   `json:"role"`
	RoleLabel string   `json:"roleLabel"`
	Detail    string   `json:"detail"`
	Source    string   `json:"source"`
	When      []string `json:"when,omitempty"`
}

// agentToolsLayerConditions is every condition a layer may name.
var agentToolsLayerConditions = map[string]bool{
	"base": true, "no_base": true, "workspace": true,
	"additional_context": true, "developer_message": true, "turn_input": true,
}

// agentToolsInstructionsNote is what the list of layers rests on, said under it.
const agentToolsInstructionsNote = "Orbit's own instructions are the same words on every engine: they begin with the primer, and " +
	"nothing in a repository, a CLAUDE.md or an AGENTS.md, adds to them or takes them away. Where they disagree with " +
	"your own message, your message steers the turn."

func agentToolsLayers() map[string][]agentToolsLayer {
	primer := "The primer " + agentPrimerVersion + ", then the CLI's absolute path, files, evidence, progress, waits and the wiki."
	return map[string][]agentToolsLayer{
		providerClaude: {
			{ID: "engine", Title: "Claude Code's system prompt", Role: "system", RoleLabel: "System", Source: "engine", When: []string{"no_base"},
				Detail: "The engine's own."},
			{ID: "workspace-base", Title: "This workspace's base instructions", Role: "system", RoleLabel: "System", Source: "workspace", When: []string{"base"},
				Detail: "In place of Claude Code's own system prompt (--system-prompt)."},
			{ID: "workspace", Title: "This workspace's runtime instructions", Role: "system", RoleLabel: "System · appended", Source: "workspace", When: []string{"workspace"},
				Detail: "Appended to the system prompt (--append-system-prompt), before Orbit's."},
			{ID: "orbit", Title: "Orbit's runtime instructions", Role: "system", RoleLabel: "System · appended", Source: "orbit",
				Detail: primer + " Appended to the system prompt, so a compaction does not touch them."},
			{ID: "repository", Title: "CLAUDE.md files", Role: "user", RoleLabel: "Project context", Source: "repository",
				Detail: "Put by Claude Code at the top of your first message, as a reminder that they override its defaults. Orbit neither reads nor changes them."},
			{ID: "person", Title: "Your messages", Role: "user", RoleLabel: "User", Source: "person",
				Detail: "With the task or project context Orbit attaches to them."},
			{ID: "mcp", Title: "Orbit MCP server instructions", Role: "system", RoleLabel: "System message", Source: "orbit",
				Detail: "The primer again, in the system message Claude Code adds after your first message, beside the environment and the list of skills."},
			{ID: "skill", Title: "Orbit playbooks · " + claudeManagedSkillID, Role: "on_demand", RoleLabel: "On demand", Source: "orbit",
				Detail: "Listed in that system message by name; its recipes are read only when the agent opens it, and nothing depends on it."},
		},
		providerCodex: {
			{ID: "engine", Title: "Codex's base instructions", Role: "developer", RoleLabel: "Developer", Source: "engine", When: []string{"no_base"},
				Detail: "The engine's own."},
			{ID: "workspace-base", Title: "This workspace's base instructions", Role: "developer", RoleLabel: "Developer", Source: "workspace", When: []string{"base"},
				Detail: "In place of Codex's own base instructions (baseInstructions)."},
			{ID: "skill", Title: "Orbit playbooks · " + codexManagedSkillName, Role: "on_demand", RoleLabel: "On demand", Source: "orbit",
				Detail: "Listed among Codex's skills by name and description; its recipes are read only when the agent opens it, and nothing depends on it."},
			{ID: "repository", Title: "AGENTS.md files", Role: "user", RoleLabel: "Project context", Source: "repository",
				Detail: "Read by Codex from the checkout. Orbit neither reads nor changes them."},
			{ID: "workspace", Title: "This workspace's runtime instructions", Role: "developer", RoleLabel: "Developer", Source: "workspace", When: []string{"workspace", "additional_context"},
				Detail: "Application context, just before Orbit's."},
			{ID: "orbit", Title: "Orbit's runtime instructions", Role: "developer", RoleLabel: "Developer", Source: "orbit", When: []string{"additional_context"},
				Detail: primer + " Application context, sent with every turn, so a compaction cannot drop them."},
			{ID: "workspace", Title: "This workspace's runtime instructions", Role: "developer", RoleLabel: "Developer", Source: "workspace", When: []string{"workspace", "developer_message"},
				Detail: "In the same developer message as Orbit's, before them."},
			{ID: "orbit", Title: "Orbit's runtime instructions", Role: "developer", RoleLabel: "Developer", Source: "orbit", When: []string{"developer_message"},
				Detail: primer + " One developer message, sent again after a compaction."},
			{ID: "workspace", Title: "This workspace's runtime instructions", Role: "user", RoleLabel: "User · turn input", Source: "workspace", When: []string{"workspace", "turn_input"},
				Detail: "In the same block as Orbit's, before them."},
			{ID: "orbit", Title: "Orbit's runtime instructions", Role: "user", RoleLabel: "User · turn input", Source: "orbit", When: []string{"turn_input"},
				Detail: primer + " At the top of every turn's input."},
			{ID: "person", Title: "Your messages", Role: "user", RoleLabel: "User", Source: "person",
				Detail: "Codex's own base instructions put your message ahead of a skill or a repository file."},
			{ID: "mcp", Title: "Orbit MCP server instructions", Role: "tools", RoleLabel: "With the tools", Source: "orbit",
				Detail: "Shown with Orbit's tools, cut to their first 250 characters; the runtime instructions above carry the whole primer either way."},
		},
	}
}

// ── the permission modes, the switch and the status ──────────────────────────────────────────────

// agentToolsMode is what one permission mode means for Orbit's own calls, in one sentence for a person.
// The authority is docs/permission-matrix.md; TestAgentToolsModesAgreeWithTheMatrix holds the words that
// matter (refused, card) to the matrix's own cells.
type agentToolsMode struct {
	Mode  string `json:"mode"`
	Label string `json:"label"`
	Orbit string `json:"orbit"`
}

func agentToolsModes() []agentToolsMode {
	return []agentToolsMode{
		{"plan", "Plan", "Orbit's reads, waits and questions for you run. Every other Orbit write is refused with SESSION_IN_PLAN_MODE until the plan is approved, and background jobs are refused."},
		{"default", "Default", "Orbit's reads and waits run unasked. A create, a batch, a project, a provider or an agent change puts a card in front of you first, and a background job asks before it starts."},
		{"acceptEdits", "Accept Edits", "As Default for Orbit's calls: a create, a batch or a project still puts a card in front of you, and a background job asks before it starts."},
		{"dontAsk", "Don't Ask", "Orbit's reads and writes run unasked, except a write that needs your card, which still asks. Background jobs are refused."},
		{"auto", "Auto", "Orbit's calls run, and a write that needs your card still asks; on Codex a destructive call goes to Codex's own review first. Background jobs start without asking."},
		{"bypassPermissions", "Bypass", "Orbit's calls run, and a write that needs your card still asks. Background jobs start without asking."},
	}
}

// agentToolsOrchestration is what the account's switch grants, said for a person: the tools are the
// orchestration family's.
type agentToolsOrchestration struct {
	On  string `json:"on"`
	Off string `json:"off"`
}

var agentToolsOrchestrationText = agentToolsOrchestration{
	On: "Session orchestration is on for this account: the agent may open and steer sessions, and manage this account's " +
		"agents and runners. A sub-session never gets a wider permission mode than this one.",
	Off: "Session orchestration is off for this account, so the agent has no session, agent or runner tools and records a " +
		"hand-off as a task instead. Turn it on in Settings → Session orchestration.",
}

// agentToolsStatusText is what Agent tools says about the session's MCP connection, by the status the
// runner's report carries (agentToolsMCPStatuses). {engine} is the engine's name and version, {tools} the
// number of Orbit tools it lists.
var agentToolsStatusText = map[string]string{
	"connected":      "{engine} started Orbit's MCP server and lists {tools} Orbit tools.",
	"starting":       "{engine} is still starting Orbit's MCP server.",
	"failed":         "{engine} could not start Orbit's MCP server.",
	"needs_auth":     "{engine} is waiting for a sign-in before it starts Orbit's MCP server.",
	"cancelled":      "{engine} stopped starting Orbit's MCP server.",
	"not_configured": "{engine} was started without Orbit's MCP server.",
	"not_reported":   "This session's engine does not report its MCP connections to the runner.",
	"fallback":       "Orbit's runtime instructions still reached the agent, so it can use the Orbit CLI by its absolute path, under the same approvals. A new session starts the server again.",
}

// agentToolsMCPStatuses are the statuses a report carries, in the order the clients map them.
var agentToolsMCPStatuses = []string{"connected", "starting", "failed", "needs_auth", "cancelled", "not_configured"}

// ── the document ─────────────────────────────────────────────────────────────────────────────────

// agentToolsGuideDoc is the guide as the clients read it (agentToolsGuide.generated.json).
type agentToolsGuideDoc struct {
	GuideVersion  string                       `json:"guideVersion"`
	Generated     string                       `json:"generated"`
	Sections      []agentToolsSection          `json:"sections"`
	Routes        []agentToolsRoute            `json:"routes"`
	Rules         []string                     `json:"rules"`
	Troubleshoot  []agentToolsTrouble          `json:"troubleshooting"`
	Examples      []agentToolsExample          `json:"examples"`
	Playbooks     []agentToolsPlaybook         `json:"playbooks"`
	Families      []agentToolsFamily           `json:"families"`
	Instructions  map[string][]agentToolsLayer `json:"instructions"`
	InstructNote  string                       `json:"instructionsNote"`
	Modes         []agentToolsMode             `json:"permissionModes"`
	Orchestration agentToolsOrchestration      `json:"orchestration"`
	Status        map[string]string            `json:"status"`
	Skill         agentToolsSkillNames         `json:"skill"`
	SwitchReasons map[string]string            `json:"switchReasons"`
	EngineNames   map[string]string            `json:"engineNames"`
}

// agentToolsRoute is one intent route (R1.x) for a person: what they say, the object and the operations.
type agentToolsRoute struct {
	Route      string   `json:"route"`
	Intent     string   `json:"intent"`
	Object     string   `json:"object"`
	Operations []string `json:"operations"`
	Topic      string   `json:"topic,omitempty"`
}

type agentToolsSkillNames struct {
	Claude  string `json:"claude"`
	Codex   string `json:"codex"`
	Purpose string `json:"purpose"`
}

// agentToolsSwitchReasons is why a family is withheld, by the report's reason (agentToolsReport), in the
// person's words.
var agentToolsSwitchReasons = map[string]string{
	"orchestration": "Session orchestration is off for this account.",
	"watches":       "Watch is off for this account on this Orbit server.",
	"wiki":          "The wiki is off for this account on this Orbit server.",
	"not_connected": "The MCP server is not connected.",
}

// agentToolsEngineNames is how a person reads each engine's name.
var agentToolsEngineNames = map[string]string{
	providerClaude: "Claude Code",
	providerCodex:  "Codex",
}

const agentToolsSkillPurpose = "Orbit's long recipes: keeping a worked-out plan as one batch, filing many tasks from a file " +
	"with the CLI, handing work off now, and finding out why an Orbit tool is missing or refused. Optional: guide " +
	"and the tools' own descriptions are enough for any single call."

func agentToolsGuideDocument() agentToolsGuideDoc {
	var routes []agentToolsRoute
	for _, route := range guideRoutes {
		ops := append([]string{}, route.Ops...)
		if ops == nil {
			ops = []string{}
		}
		routes = append(routes, agentToolsRoute{Route: route.Route, Intent: route.Intent, Object: route.Object, Operations: ops, Topic: route.Topic})
	}
	return agentToolsGuideDoc{
		GuideVersion:  agentToolsGuideVersion,
		Generated:     "src/runner-go/agent_tools_guide.go",
		Sections:      agentToolsSections(),
		Routes:        routes,
		Rules:         guideRules,
		Troubleshoot:  agentToolsTroubles(),
		Examples:      agentToolsExamples(),
		Playbooks:     agentToolsPlaybooks(),
		Families:      agentToolsFamilies(),
		Instructions:  agentToolsLayers(),
		InstructNote:  agentToolsInstructionsNote,
		Modes:         agentToolsModes(),
		Orchestration: agentToolsOrchestrationText,
		Status:        agentToolsStatusText,
		Skill:         agentToolsSkillNames{Claude: claudeManagedSkillID, Codex: codexManagedSkillName, Purpose: agentToolsSkillPurpose},
		SwitchReasons: agentToolsSwitchReasons,
		EngineNames:   agentToolsEngineNames,
	}
}

// renderAgentToolsGuideJSON is the clients' copy of the guide: indented, keys in a stable order, ending in
// a newline, with nothing escaped that does not need to be.
func renderAgentToolsGuideJSON() string {
	var b strings.Builder
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(agentToolsGuideDocument()); err != nil {
		panic(err)
	}
	return b.String()
}

// renderAgentToolsGuideSwift is the same JSON as a Swift source file, for OrbitKit: a raw string, so the
// JSON is carried byte for byte and decoded where it is read.
func renderAgentToolsGuideSwift() string {
	json := renderAgentToolsGuideJSON()
	if strings.Contains(json, "\\#") || strings.Contains(json, "\"\"\"#") {
		panic("the guide's JSON would end or escape inside OrbitKit's raw string")
	}
	return "// Generated from src/runner-go/agent_tools_guide.go by its test (ORBIT_UPDATE_AGENT_TOOLS_GUIDE=1) — do not edit.\n" +
		"// The same document as src/web/src/lib/agentToolsGuide.generated.json: the Agent Tools guide the macOS\n" +
		"// sheet reads (AgentToolsGuide.swift decodes it).\n\n" +
		"// swiftlint:disable all\n" +
		"let agentToolsGuideJSON = #\"\"\"\n" + strings.TrimRight(json, "\n") + "\n\"\"\"#\n"
}

// ── the public document ──────────────────────────────────────────────────────────────────────────

func renderAgentToolsGuideMarkdown() string {
	doc := agentToolsGuideDocument()
	var b strings.Builder
	fmt.Fprintf(&b, "# How agents use Orbit\n\n")
	fmt.Fprintf(&b, "> Generated from `src/runner-go/agent_tools_guide.go` — do not edit by hand. Guide %s, written from Agent Contract %s, operation catalogue %s and primer %s.\n\n",
		agentToolsGuideVersion, agentContractVersion, operationCatalogVersion, agentPrimerVersion)
	b.WriteString("This is the person's side of the [Orbit Agent Contract](orbit-agent-contract.md): what an agent in an Orbit session ")
	b.WriteString("does with Orbit, and why. The agent learns the same rules from its primer, its tools' descriptions and the `guide` ")
	b.WriteString("tool. The web console and the macOS app show this guide in **Agent tools**: a session's More actions → Agent tools, ")
	b.WriteString("and Workspace settings → Agent environment → Agent tools, beside what that session or workspace is actually given. ")
	b.WriteString("The same rows make the playbooks skill Orbit gives Claude Code and Codex, and a test holds this file, the apps' copy ")
	b.WriteString("and the skill to them.\n\n")

	b.WriteString("## Contents\n\n")
	for _, s := range doc.Sections {
		fmt.Fprintf(&b, "- [%s](#%s)\n", s.Title, markdownAnchor(s.Title))
	}
	b.WriteString("- [Try asking: four examples](#try-asking-four-examples)\n")
	b.WriteString("- [Workflows: the guide's recipes](#workflows-the-guides-recipes)\n")
	b.WriteString("- [What the agent reads, and in what order](#what-the-agent-reads-and-in-what-order)\n")
	b.WriteString("- [Permission modes and Orbit's calls](#permission-modes-and-orbits-calls)\n")
	b.WriteString("- [Orbit's tools by family](#orbits-tools-by-family)\n")
	b.WriteString("- [The playbooks skill](#the-playbooks-skill)\n\n")

	for _, s := range doc.Sections {
		fmt.Fprintf(&b, "## %s\n\n%s\n\n", s.Title, s.Lead)
		for _, p := range s.Points {
			fmt.Fprintf(&b, "- %s\n", p)
		}
		b.WriteString("\n")
		switch s.ID {
		case "which-object":
			b.WriteString("| Route | What the person says | Object | Operations |\n| --- | --- | --- | --- |\n")
			for _, r := range doc.Routes {
				ops := "nothing to record"
				if len(r.Operations) > 0 {
					ops = "`" + strings.Join(r.Operations, "`, `") + "`"
				}
				fmt.Fprintf(&b, "| %s | %s | %s | %s |\n", r.Route, escapeTable(r.Intent), r.Object, ops)
			}
			b.WriteString("\n")
			for _, rule := range doc.Rules {
				fmt.Fprintf(&b, "- %s\n", rule)
			}
			b.WriteString("\n")
		case "troubleshooting":
			b.WriteString("| What you see | Why | What to do | Receipt code |\n| --- | --- | --- | --- |\n")
			for _, t := range doc.Troubleshoot {
				code := "—"
				if t.Code != "" {
					code = "`" + t.Code + "`"
				}
				fmt.Fprintf(&b, "| %s | %s | %s | %s |\n", escapeTable(t.Symptom), escapeTable(t.Cause), escapeTable(t.Fix), code)
			}
			b.WriteString("\n")
		}
		if len(s.Asks) > 0 {
			b.WriteString("Try asking: ")
			for i, ask := range s.Asks {
				if i > 0 {
					b.WriteString(" · ")
				}
				fmt.Fprintf(&b, "*\"%s\"*", ask)
			}
			b.WriteString("\n\n")
		}
	}

	b.WriteString("## Try asking: four examples\n\n")
	b.WriteString("Each example is what you might say, what the agent does, the calls it makes on each surface and what proves ")
	b.WriteString("it. The MCP calls pass their tools' own schemas and the command lines their commands' own flag parsers; `<…>` ")
	b.WriteString("marks a value the agent fills in, and the CLI runs by the absolute path Orbit gives the agent.\n\n")
	for i, ex := range doc.Examples {
		fmt.Fprintf(&b, "### %d. %s\n\n> *\"%s\"*\n\n%s\n\n", i+1, ex.Title, ex.Ask, ex.Does)
		for _, call := range ex.MCP {
			fmt.Fprintf(&b, "MCP `%s`:\n\n```json\n%s\n```\n\n", call.Tool, agentToolsJSON(call.Arguments))
		}
		if ex.Script != "" {
			fmt.Fprintf(&b, "CLI:\n\n```sh\n%s\n```\n\n", ex.Script)
		} else if len(ex.CLI) > 0 {
			b.WriteString("CLI:\n\n```sh\n")
			for _, line := range ex.CLI {
				fmt.Fprintf(&b, "%s\n", shellJoin(line))
			}
			b.WriteString("```\n\n")
		}
		fmt.Fprintf(&b, "**What proves it:** %s *(Contract scenarios %s.)*\n\n", ex.Proof, ex.Scenario)
	}

	b.WriteString(renderAgentToolsWorkflows())

	b.WriteString("## What the agent reads, and in what order\n\n")
	b.WriteString("In the order each engine puts them in front of its model, with the role it reads them in, as measured on ")
	b.WriteString("2026-11-14 by recording each engine's own request (Claude Code 2.1.325, Codex 0.167.2). Agent tools on a ")
	b.WriteString("session lists the layers that session really has.\n\n")
	for _, engine := range []string{providerClaude, providerCodex} {
		fmt.Fprintf(&b, "### %s\n\n| # | Instructions | Role | Set by | Detail |\n| --- | --- | --- | --- | --- |\n", agentToolsEngineNames[engine])
		n := 0
		for _, layer := range doc.Instructions[engine] {
			n++
			when := agentToolsLayerWhen(layer.When)
			fmt.Fprintf(&b, "| %d | %s%s | %s | %s | %s |\n", n, escapeTable(layer.Title), when, layer.RoleLabel, agentToolsSourceLabels[layer.Source], escapeTable(layer.Detail))
		}
		b.WriteString("\n")
	}
	fmt.Fprintf(&b, "%s\n\n", doc.InstructNote)

	b.WriteString("## Permission modes and Orbit's calls\n\n")
	b.WriteString("What each mode means for Orbit's own calls; the authority, per engine and surface, is ")
	b.WriteString("[permission-matrix.md](permission-matrix.md).\n\n| Mode | Orbit's calls |\n| --- | --- |\n")
	for _, m := range doc.Modes {
		fmt.Fprintf(&b, "| %s | %s |\n", m.Label, escapeTable(m.Orbit))
	}
	fmt.Fprintf(&b, "\n**Session orchestration.** %s %s\n\n", doc.Orchestration.On, doc.Orchestration.Off)

	b.WriteString("## Orbit's tools by family\n\n")
	b.WriteString("Agent tools on a session counts each family as that session's engine lists it. The orchestration family is ")
	b.WriteString("every tool the Session orchestration switch gates; the rest go by what the [operation catalogue](operation-catalog.md) ")
	b.WriteString("says they act on. Claude Code also lists `permission_prompt`, its permission bridge, which is not for the agent to call.\n\n")
	b.WriteString("| Family | Tools |\n| --- | --- |\n")
	for _, f := range doc.Families {
		fmt.Fprintf(&b, "| %s (%d) | `%s` |\n", f.Label, len(f.Tools), strings.Join(f.Tools, "`, `"))
	}
	b.WriteString("\n")

	b.WriteString("## The playbooks skill\n\n")
	fmt.Fprintf(&b, "%s Claude Code loads it as `%s`, from a plugin the runner writes into the session's own directory and passes ", agentToolsSkillPurpose, claudeManagedSkillID)
	fmt.Fprintf(&b, "with `--plugin-dir`; Codex lists it as `%s`, from a skill root the runner hands its app server ", codexManagedSkillName)
	b.WriteString("(`skills/extraRoots/set`). Neither touches your own Claude Code or Codex configuration, and Agent tools shows ")
	b.WriteString("whether this session's engine took it. Its recipes, word for word:\n\n")
	b.WriteString(renderPlaybooksBody(2))
	return strings.TrimRight(b.String(), "\n") + "\n"
}

// renderAgentToolsWorkflows is the route guide's topics (agent_guide.go) for a person: what each is for, what
// they might say, and each step's MCP tool and CLI command as the operation catalogue declares them, so the
// person reads the recipes the agent is handed by guide, generated from the same rows.
func renderAgentToolsWorkflows() string {
	var b strings.Builder
	built := operationCatalog()
	b.WriteString("## Workflows: the guide's recipes\n\n")
	fmt.Fprintf(&b, "The recipes the `guide` tool hands an agent (guide %s), generated from the operation catalogue: each ", agentGuideVersion)
	b.WriteString("step's MCP tool and the CLI command that does the same, and whether a person must answer first. `?` marks a ")
	b.WriteString("step taken only when it applies. The agent reads the same recipe, with this session's availability, from ")
	b.WriteString("`guide` with the topic, or `orbit guide <topic> --json`.\n\n")
	for _, topic := range guideTopics {
		fmt.Fprintf(&b, "### `%s` — %s\n\n", topic.ID, strings.TrimSuffix(topic.Intent, "."))
		if len(topic.Asks) > 0 {
			b.WriteString("Try asking: ")
			for i, ask := range topic.Asks {
				if i > 0 {
					b.WriteString(" · ")
				}
				fmt.Fprintf(&b, "*\"%s\"*", ask)
			}
			b.WriteString("\n\n")
		}
		b.WriteString("| Step | MCP | CLI | Approval | Why |\n| --- | --- | --- | --- | --- |\n")
		for i, step := range topic.Steps {
			op := built.ByTool[step.Op]
			if op == nil {
				continue
			}
			mcp, cli := "—", "—"
			if op.MCP != nil {
				mcp = "`" + op.Tool + "`"
			}
			if op.CLI != nil {
				cli = "`" + strings.Join(op.CLI.Argv, " ") + "`"
			}
			optional := ""
			if step.Optional {
				optional = "?"
			}
			fmt.Fprintf(&b, "| %d%s | %s | %s | %s | %s |\n", i+1, optional, mcp, cli, op.Approval, escapeTable(step.Why))
		}
		fmt.Fprintf(&b, "\n**Done when:** %s\n\n", topic.Done)
	}
	return b.String()
}

// agentToolsLayerWhen says in the document when a layer is there, or nothing for always.
func agentToolsLayerWhen(conditions []string) string {
	var said []string
	for _, c := range conditions {
		switch c {
		case "base":
			said = append(said, "when the workspace sets base instructions")
		case "no_base":
			said = append(said, "unless the workspace replaces it")
		case "workspace":
			said = append(said, "when the workspace has instructions")
		case "additional_context":
			said = append(said, "Codex 0.135 and later")
		case "developer_message":
			said = append(said, "Codex 0.125 to 0.134")
		case "turn_input":
			said = append(said, "Codex before 0.125")
		}
	}
	if len(said) == 0 {
		return ""
	}
	return " *(" + strings.Join(said, "; ") + ")*"
}

// renderPlaybooksBody is the playbooks, each a heading at depth+1, as the skill and the document both say them.
func renderPlaybooksBody(depth int) string {
	var b strings.Builder
	hashes := strings.Repeat("#", depth+1)
	for _, p := range agentToolsPlaybooks() {
		fmt.Fprintf(&b, "%s %s\n\nWhen: %s\n\n", hashes, p.Title, p.When)
		for i, step := range p.Steps {
			fmt.Fprintf(&b, "%d. %s\n", i+1, step)
		}
		b.WriteString("\n")
		if p.Code != "" {
			fmt.Fprintf(&b, "```sh\n%s\n```\n\n", p.Code)
		}
	}
	return b.String()
}

// agentToolsSourceLabels is who sets a layer, as the document says it.
var agentToolsSourceLabels = map[string]string{
	"engine": "The engine", "workspace": "The workspace", "orbit": "Orbit", "repository": "The repository", "person": "You",
}

// agentToolsJSON is v as one line of JSON with nothing escaped that a reader would have to decode.
func agentToolsJSON(v interface{}) string {
	var b strings.Builder
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		panic(err)
	}
	return strings.TrimRight(b.String(), "\n")
}

// markdownAnchor is GitHub's anchor for a heading: lower case, spaces as hyphens, punctuation dropped.
func markdownAnchor(title string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(title) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '-', r == '_':
			b.WriteRune(r)
		case r == ' ':
			b.WriteRune('-')
		}
	}
	return b.String()
}

// ── the managed skill ────────────────────────────────────────────────────────────────────────────

// renderManagedSkill is the SKILL.md one engine is given: the frontmatter in the engine's naming, then the
// playbooks. ASCII, like the rest of what Orbit puts in front of a model (TestManagedSkillIsASCIIAndOffThePath).
func renderManagedSkill(engine string) string {
	name := codexManagedSkillName
	if engine == providerClaude {
		name = claudeManagedSkillName
	}
	var b strings.Builder
	fmt.Fprintf(&b, "---\nname: %s\ndescription: %s\n---\n\n", name, agentToolsSkillPurpose)
	fmt.Fprintf(&b, "# Orbit playbooks %s\n\n", agentToolsGuideVersion)
	b.WriteString("Long recipes for Orbit, written from the Orbit Agent Contract " + agentContractVersion + ". They add steps to what you ")
	b.WriteString("already know; they change no rule. For a single call, guide (no arguments for the routes, a topic for the ")
	b.WriteString("recipe) and the tool's own description are enough, and they win if anything here disagrees with them. Name ")
	b.WriteString("tools as your tool list does; run the Orbit CLI only by the absolute path your instructions give.\n\n")
	b.WriteString(renderPlaybooksBody(1))
	return b.String()
}

// claudeManagedPluginManifest is the plugin.json that makes the directory a plugin Claude Code loads with
// --plugin-dir.
func claudeManagedPluginManifest() string {
	blob, _ := json.Marshal(map[string]interface{}{
		"name":        claudeManagedPluginName,
		"version":     agentToolsGuideVersion,
		"description": "Orbit's managed playbooks for this session. Written by the Orbit runner; edits are overwritten.",
	})
	return string(blob) + "\n"
}

// writeClaudeManagedPlugin writes the playbooks plugin into the session's scratch dir and returns the
// directory to pass with --plugin-dir, or "" when it could not be written: the skill is never on the
// critical path, so a failure leaves the spawn as it was.
func writeClaudeManagedPlugin(scratchDir string) string {
	if scratchDir == "" {
		return ""
	}
	dir := filepath.Join(scratchDir, "orbit-plugin")
	files := map[string]string{
		filepath.Join(dir, ".claude-plugin", "plugin.json"):              claudeManagedPluginManifest(),
		filepath.Join(dir, "skills", claudeManagedSkillName, "SKILL.md"): renderManagedSkill(providerClaude),
	}
	for path, content := range files {
		if err := writeManagedFile(path, content); err != nil {
			logln("orbit playbooks plugin not written:", err)
			return ""
		}
	}
	return dir
}

// writeCodexManagedSkillRoot writes the playbooks skill under the session's scratch dir and returns the
// root to hand Codex's app server (skills/extraRoots/set), or "" when it could not be written.
func writeCodexManagedSkillRoot(scratchDir string) string {
	if scratchDir == "" {
		return ""
	}
	root := filepath.Join(scratchDir, "orbit-skills")
	if err := writeManagedFile(filepath.Join(root, codexManagedSkillName, "SKILL.md"), renderManagedSkill(providerCodex)); err != nil {
		logln("orbit playbooks skill not written:", err)
		return ""
	}
	return root
}

// writeManagedFile writes content to path through a temporary file and a rename, so an engine reading the
// skill as a re-spawn rewrites it never reads half of it.
func writeManagedFile(path, content string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, []byte(content), 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}
