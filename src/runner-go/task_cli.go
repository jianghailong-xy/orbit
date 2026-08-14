package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"
)

// Task list paging, mirroring the apiserver's own page defaults. The endpoint used to return an
// owner's entire task history in one body; both callers now ask for a bounded page.
const (
	defaultTaskListLimit = 100
	maxTaskListLimit     = 200
)

const taskHelp = `orbit task — manage Orbit tasks

Usage:
  orbit task list [--status STATUS] [--list-id ID] [--limit N] [--json]
  orbit task get [task-id] [--json]
  orbit task create --title TITLE [options]
  orbit task create-batch (--tasks JSON | --tasks-file -) [--json]
  orbit task update [task-id] [options]
  orbit task delete [task-id] [--json]
  orbit task start [task-id] [--json]
  orbit task comment [task-id] (--body TEXT | --body-file -) [--json]
  orbit task dependency-graph [task-id] [--max-depth N] [--max-nodes N] [--json]
  orbit task dependency-add [task-id] --depends-on ID [--json]
  orbit task dependency-remove [task-id] --depends-on ID [--json]

When task-id is omitted, ORBIT_TASK_ID is used if this command is running inside
an Orbit task session. Run 'orbit task <command> --help' for command options.
`

const taskListHelp = `orbit task-list — manage Orbit task lists

Usage:
  orbit task-list list [--json]
  orbit task-list create --title TITLE [--json]
  orbit task-list get LIST_ID [--json]
  orbit task-list update LIST_ID [options]
`

var taskActionHelp = map[string]string{
	"list": `orbit task list — list tasks

Usage:
  orbit task list [--status OPEN|IN_PROGRESS|DONE|CANCELLED] [--list-id ID] [--limit N] [--json]

Returns the newest tasks first, without their descriptions (use ` + "`orbit task get`" + ` for one
task in full). --limit defaults to 100 and may not exceed 200.
`,
	"get": `orbit task get — get a task, its comments, and linked sessions

Usage:
  orbit task get [task-id] [--json]

task-id defaults to ORBIT_TASK_ID inside an Orbit task session.
`,
	"create": `orbit task create — create a task

Usage:
  orbit task create --title TITLE [options]

Options:
  --description TEXT
  --description-file -        Read the description from stdin; filesystem paths are rejected
  --assignee-id ID            Defaults to ORBIT_AGENT_ID inside an agent session
  --unassigned                Explicitly leave the task unassigned
  --list-id ID
  --due-date ISO_DATE
  --provider SLUG             Pin the run to a provider; defaults to the assignee's project
  --model MODEL               Pin the run to a model within that provider
  --depends-on ID[,ID...]     Repeatable prerequisite task ids
  --auto-run-when-ready[=BOOL]
  --json
`,
	"create-batch": `orbit task create-batch — create several tasks in one atomic call

Usage:
  orbit task create-batch (--tasks JSON | --tasks-file -) [--json]

JSON is an array of task objects (or {"tasks": [...]}), each taking the same fields
as 'orbit task create': title (required), description, assigneeId, listId, dueDate,
provider, model, dependsOnTaskIds, autoRunWhenReady. Nothing is written unless every
item is valid.

To make one item depend on another item of the same batch — whose id does not exist
yet — give the earlier item a "ref" and list it in the later item's "dependsOnRefs":

  [{"title":"Build","ref":"build"},
   {"title":"Deploy","dependsOnRefs":["build"]}]

A ref must name an EARLIER item; "dependsOnTaskIds" still takes ids of tasks that
already exist. assigneeId defaults to ORBIT_AGENT_ID per item (pass null to leave an
item unassigned). --tasks-file accepts only '-' (stdin).
`,
	"update": `orbit task update — update a task

Usage:
  orbit task update [task-id] [options]

Options:
  --title TITLE
  --description TEXT
  --description-file -        Read the description from stdin; filesystem paths are rejected
  --status OPEN|IN_PROGRESS|DONE|CANCELLED
  --assignee-id ID | --clear-assignee
  --list-id ID | --clear-list
  --due-date ISO_DATE | --clear-due-date
  --provider SLUG | --clear-provider
  --model MODEL | --clear-model
  --depends-on ID[,ID...]     Replace all prerequisites; repeatable
  --clear-dependencies        Remove all prerequisites
  --auto-run-when-ready[=BOOL]
  --json

task-id defaults to ORBIT_TASK_ID inside an Orbit task session.
`,
	"delete": `orbit task delete — permanently delete a task

Usage:
  orbit task delete [task-id] [--json]

This cannot be undone. Comments and dependency edges are deleted; linked sessions
are retained and detached from the task.

task-id defaults to ORBIT_TASK_ID inside an Orbit task session.
`,
	"start": `orbit task start — run a task on its assigned agent

Usage:
  orbit task start [task-id] [--json]

task-id defaults to ORBIT_TASK_ID inside an Orbit task session.
`,
	"comment": `orbit task comment — add a comment to a task

Usage:
  orbit task comment [task-id] (--body TEXT | --body-file -) [--json]

--body-file accepts only '-' (stdin), so the CLI itself never opens an arbitrary
path. task-id defaults to ORBIT_TASK_ID inside an Orbit task session.
`,
}

var taskListActionHelp = map[string]string{
	"list": `orbit task-list list — list task lists

Usage:
  orbit task-list list [--json]
`,
	"get": `orbit task-list get — one task list's dispatch policy and progress

Usage:
  orbit task-list get LIST_ID [--json]
`,
	"update": `orbit task-list update — change a task list's dispatch policy

Usage:
  orbit task-list update LIST_ID [options]

Options:
  --title TEXT                    rename the list (not recorded as a policy revision)
  --instructions TEXT             standing instructions spliced into every task run in this list
  --instructions-file -           read those instructions from stdin
  --paused true|false             hold or resume dispatch; runs already in flight are untouched
  --max-concurrent N              cap this list's concurrently running tasks
  --clear-max-concurrent          remove that cap
  --foreman-workspace-id ID       workspace that runs this list's coordination when it stalls
  --foreman-stall-minutes N       minutes of no activity before a foreman is filed
  --clear-foreman                 stop filing a foreman for this list
  --note TEXT                     why — recorded on the revision this change creates

Every policy change is recorded as a restorable revision. Only the flags you pass are
sent, so a partial edit never blanks the rest of the policy.
`,
	"create": `orbit task-list create — create a task list

Usage:
  orbit task-list create --title TITLE [--json]
`,
}

// cmdTaskCLI is the native, agent-safe adapter for the Task subset of Orbit's
// built-in MCP tools. It calls Transport directly instead of piping JSON-RPC to
// `orbit mcp`, keeping CLI errors and output independent from the MCP envelope.
func cmdTaskCLI(args []string, in io.Reader, out io.Writer) error {
	if len(args) == 0 || args[0] == "--help" || args[0] == "-h" {
		_, err := fmt.Fprint(out, taskHelp)
		return err
	}
	if args[0] == "help" {
		if len(args) == 1 {
			_, err := fmt.Fprint(out, taskHelp)
			return err
		}
		h, ok := taskActionHelp[args[1]]
		if !ok {
			return fmt.Errorf("unknown command %q", args[1])
		}
		_, err := fmt.Fprint(out, h)
		return err
	}
	action := args[0]
	if wantsHelp(args[1:]) {
		h, ok := taskActionHelp[action]
		if !ok {
			return fmt.Errorf("unknown command %q", action)
		}
		_, err := fmt.Fprint(out, h)
		return err
	}

	switch action {
	case "list":
		return cliTaskList(args[1:], out)
	case "get":
		return cliTaskGet(args[1:], out)
	case "create":
		return cliTaskCreate(args[1:], in, out)
	case "create-batch":
		return cliTaskCreateBatch(args[1:], in, out)
	case "update":
		return cliTaskUpdate(args[1:], in, out)
	case "delete":
		return cliTaskDelete(args[1:], out)
	case "start":
		return cliTaskStart(args[1:], out)
	case "comment":
		return cliTaskComment(args[1:], in, out)
	case "dependency-graph":
		return cliTaskDependencyGraph(args[1:], out)
	case "dependency-add":
		return cliTaskDependencyAdd(args[1:], out)
	case "dependency-remove":
		return cliTaskDependencyRemove(args[1:], out)
	default:
		return fmt.Errorf("unknown command %q\n\n%s", action, taskHelp)
	}
}

// cliTaskDependencyGraph mirrors the task_dependency_graph MCP tool: read the DAG a
// task sits in. --max-depth/--max-nodes default to 0, which the transport omits so the
// server applies its own caps — the same "unset means default" the MCP tool relies on.
func cliTaskDependencyGraph(args []string, out io.Writer) error {
	id, rest := peelLeadingID(args)
	fs := newCLIFlagSet("orbit task dependency-graph")
	maxDepth := fs.Int("max-depth", 0, "max dependency depth to walk (server default when unset)")
	maxNodes := fs.Int("max-nodes", 0, "max nodes to return (server default when unset)")
	jsonOut := fs.Bool("json", false, "emit compact JSON")
	if err := fs.Parse(rest); err != nil {
		return err
	}
	id, err := resolveTaskCLIId(id, fs.Args())
	if err != nil {
		return err
	}
	t, err := cliTransport()
	if err != nil {
		return err
	}
	raw, err := t.taskDependencyGraph(id, *maxDepth, *maxNodes)
	if err != nil {
		return fmt.Errorf("get task dependency graph: %w", err)
	}
	return writeCLIRawJSON(out, raw, *jsonOut)
}

// cliTaskDependencyAdd mirrors task_dependency_add: add one edge, taskId waits for the
// --depends-on prerequisite. The granular edit that preserves every other edge, unlike
// `task update --depends-on` which replaces the whole set.
func cliTaskDependencyAdd(args []string, out io.Writer) error {
	id, rest := peelLeadingID(args)
	fs := newCLIFlagSet("orbit task dependency-add")
	dependsOn := fs.String("depends-on", "", "prerequisite task id this task waits for (required)")
	jsonOut := fs.Bool("json", false, "emit compact JSON")
	if err := fs.Parse(rest); err != nil {
		return err
	}
	id, err := resolveTaskCLIId(id, fs.Args())
	if err != nil {
		return err
	}
	if strings.TrimSpace(*dependsOn) == "" {
		return fmt.Errorf("--depends-on is required")
	}
	t, err := cliTransport()
	if err != nil {
		return err
	}
	raw, err := t.addTaskDependency(id, *dependsOn)
	if err != nil {
		return fmt.Errorf("add task dependency: %w", err)
	}
	return writeCLIRawJSON(out, raw, *jsonOut)
}

// cliTaskDependencyRemove mirrors task_dependency_remove: drop one edge, leaving the
// rest of the DAG intact. Removing an absent edge is a no-op, matching the MCP tool.
func cliTaskDependencyRemove(args []string, out io.Writer) error {
	id, rest := peelLeadingID(args)
	fs := newCLIFlagSet("orbit task dependency-remove")
	dependsOn := fs.String("depends-on", "", "prerequisite task id to detach (required)")
	jsonOut := fs.Bool("json", false, "emit compact JSON")
	if err := fs.Parse(rest); err != nil {
		return err
	}
	id, err := resolveTaskCLIId(id, fs.Args())
	if err != nil {
		return err
	}
	if strings.TrimSpace(*dependsOn) == "" {
		return fmt.Errorf("--depends-on is required")
	}
	t, err := cliTransport()
	if err != nil {
		return err
	}
	raw, err := t.removeTaskDependency(id, *dependsOn)
	if err != nil {
		return fmt.Errorf("remove task dependency: %w", err)
	}
	return writeCLIRawJSON(out, raw, *jsonOut)
}

func cmdTaskListCLI(args []string, in io.Reader, out io.Writer) error {
	if len(args) == 0 || args[0] == "--help" || args[0] == "-h" {
		_, err := fmt.Fprint(out, taskListHelp)
		return err
	}
	if args[0] == "help" {
		if len(args) == 1 {
			_, err := fmt.Fprint(out, taskListHelp)
			return err
		}
		h, ok := taskListActionHelp[args[1]]
		if !ok {
			return fmt.Errorf("unknown command %q", args[1])
		}
		_, err := fmt.Fprint(out, h)
		return err
	}
	action := args[0]
	if wantsHelp(args[1:]) {
		h, ok := taskListActionHelp[action]
		if !ok {
			return fmt.Errorf("unknown command %q", action)
		}
		_, err := fmt.Fprint(out, h)
		return err
	}
	switch action {
	case "list":
		return cliTaskListList(args[1:], out)
	case "create":
		return cliTaskListCreate(args[1:], out)
	case "get":
		return cliTaskListGet(args[1:], out)
	case "update":
		return cliTaskListUpdate(args[1:], in, out)
	default:
		return fmt.Errorf("unknown command %q\n\n%s", action, taskListHelp)
	}
}

func cliTransport() (*Transport, error) {
	if err := configStoragePrivate(); err != nil {
		if os.IsNotExist(err) {
			return nil, fmt.Errorf("no runner config — run `orbit register` first")
		}
		return nil, fmt.Errorf("runner credential storage is not private (%v); restart the Orbit runner once to migrate it", err)
	}
	cfg := loadConfig()
	if cfg == nil {
		return nil, fmt.Errorf("no runner config — run `orbit register` first")
	}
	return NewTransport(cfg.ServerURL, cfg.RunnerToken), nil
}

func newCLIFlagSet(name string) *flag.FlagSet {
	fs := flag.NewFlagSet(name, flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	return fs
}

func flagWasSet(fs *flag.FlagSet, name string) bool {
	set := false
	fs.Visit(func(f *flag.Flag) {
		if f.Name == name {
			set = true
		}
	})
	return set
}

func peelLeadingID(args []string) (string, []string) {
	if len(args) > 0 && args[0] != "-" && !strings.HasPrefix(args[0], "-") {
		return args[0], args[1:]
	}
	return "", args
}

func resolveTaskCLIId(leading string, trailing []string) (string, error) {
	if leading != "" && len(trailing) > 0 {
		return "", fmt.Errorf("unexpected arguments: %s", strings.Join(trailing, " "))
	}
	if leading == "" {
		if len(trailing) > 1 {
			return "", fmt.Errorf("expected at most one task id, got: %s", strings.Join(trailing, " "))
		}
		if len(trailing) == 1 {
			leading = trailing[0]
		}
	}
	if leading == "" {
		leading = strings.TrimSpace(os.Getenv("ORBIT_TASK_ID"))
	}
	if leading == "" {
		return "", fmt.Errorf("task id is required (or set ORBIT_TASK_ID inside a task session)")
	}
	if err := validatePathSegmentID(leading); err != nil {
		return "", fmt.Errorf("task %w", err)
	}
	return leading, nil
}

func rejectTrailing(fs *flag.FlagSet) error {
	if fs.NArg() > 0 {
		return fmt.Errorf("unexpected arguments: %s", strings.Join(fs.Args(), " "))
	}
	return nil
}

func validateTaskCLIStatus(status string) error {
	if status == "" {
		return nil
	}
	switch status {
	case "OPEN", "IN_PROGRESS", "DONE", "CANCELLED":
		return nil
	default:
		return fmt.Errorf("status must be one of OPEN, IN_PROGRESS, DONE, CANCELLED")
	}
}

func writeCLIRawJSON(out io.Writer, raw json.RawMessage, compact bool) error {
	if len(raw) == 0 {
		_, err := fmt.Fprintln(out, "null")
		return err
	}
	var buf bytes.Buffer
	var err error
	if compact {
		err = json.Compact(&buf, raw)
	} else {
		err = json.Indent(&buf, raw, "", "  ")
	}
	if err != nil {
		return fmt.Errorf("server returned invalid JSON: %w", err)
	}
	buf.WriteByte('\n')
	_, err = out.Write(buf.Bytes())
	return err
}

func readCLIText(in io.Reader, direct string, directSet bool, file string, fileSet bool, field string) (string, bool, error) {
	if directSet && fileSet {
		return "", false, fmt.Errorf("--%s and --%s-file cannot be used together", field, field)
	}
	if !fileSet {
		return direct, directSet, nil
	}
	if file != "-" {
		return "", false, fmt.Errorf("--%s-file accepts only '-' (stdin)", field)
	}
	b, err := io.ReadAll(in)
	if err != nil {
		return "", false, fmt.Errorf("read %s from stdin: %w", field, err)
	}
	return string(b), true, nil
}

type csvFlag []string

func (v *csvFlag) String() string { return strings.Join(*v, ",") }
func (v *csvFlag) Set(s string) error {
	for _, item := range strings.Split(s, ",") {
		if item = strings.TrimSpace(item); item != "" {
			*v = append(*v, item)
		}
	}
	return nil
}

func uniqueStrings(in []string) []string {
	seen := make(map[string]bool, len(in))
	out := make([]string, 0, len(in))
	for _, s := range in {
		if s != "" && !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	return out
}

func cliTaskList(args []string, out io.Writer) error {
	fs := newCLIFlagSet("orbit task list")
	status := fs.String("status", "", "task status")
	listID := fs.String("list-id", "", "task list id")
	limit := fs.Int("limit", defaultTaskListLimit, "maximum tasks to return")
	jsonOut := fs.Bool("json", false, "emit compact JSON")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if err := rejectTrailing(fs); err != nil {
		return err
	}
	if err := validateTaskCLIStatus(*status); err != nil {
		return err
	}
	if flagWasSet(fs, "status") && *status == "" {
		return fmt.Errorf("--status cannot be empty")
	}
	if *limit < 1 || *limit > maxTaskListLimit {
		return fmt.Errorf("--limit must be between 1 and %d", maxTaskListLimit)
	}
	t, err := cliTransport()
	if err != nil {
		return err
	}
	raw, err := t.listTasks(*status, *listID, *limit)
	if err != nil {
		return fmt.Errorf("list tasks: %w", err)
	}
	// A full page is the one case where the answer is silently partial, and stdout has to stay
	// parseable — so say so on stderr instead.
	if countJSONArray(raw) >= *limit {
		fmt.Fprintf(os.Stderr, "orbit task list: showing the newest %d tasks; narrow with --status/--list-id or raise --limit\n", *limit)
	}
	return writeCLIRawJSON(out, raw, *jsonOut)
}

func cliTaskGet(args []string, out io.Writer) error {
	id, rest := peelLeadingID(args)
	fs := newCLIFlagSet("orbit task get")
	jsonOut := fs.Bool("json", false, "emit compact JSON")
	if err := fs.Parse(rest); err != nil {
		return err
	}
	id, err := resolveTaskCLIId(id, fs.Args())
	if err != nil {
		return err
	}
	t, err := cliTransport()
	if err != nil {
		return err
	}
	raw, err := t.getTask(id)
	if err != nil {
		return fmt.Errorf("get task: %w", err)
	}
	return writeCLIRawJSON(out, raw, *jsonOut)
}

func cliTaskCreate(args []string, in io.Reader, out io.Writer) error {
	fs := newCLIFlagSet("orbit task create")
	title := fs.String("title", "", "task title")
	description := fs.String("description", "", "task description")
	descriptionFile := fs.String("description-file", "", "read description from stdin (-)")
	assigneeID := fs.String("assignee-id", "", "assignee agent id")
	unassigned := fs.Bool("unassigned", false, "leave task unassigned")
	listID := fs.String("list-id", "", "task list id")
	dueDate := fs.String("due-date", "", "ISO due date")
	provider := fs.String("provider", "", "run on this provider instead of the assignee's")
	model := fs.String("model", "", "run on this model instead of the assignee's")
	var dependsOn csvFlag
	fs.Var(&dependsOn, "depends-on", "comma-separated prerequisite task ids (repeatable)")
	autoRun := fs.Bool("auto-run-when-ready", false, "auto-run after dependencies complete")
	jsonOut := fs.Bool("json", false, "emit compact JSON")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if err := rejectTrailing(fs); err != nil {
		return err
	}
	if strings.TrimSpace(*title) == "" {
		return fmt.Errorf("--title is required")
	}
	if *unassigned && flagWasSet(fs, "assignee-id") {
		return fmt.Errorf("--unassigned and --assignee-id cannot be used together")
	}
	desc, descSet, err := readCLIText(in, *description, flagWasSet(fs, "description"), *descriptionFile, flagWasSet(fs, "description-file"), "description")
	if err != nil {
		return err
	}
	body := map[string]interface{}{"title": *title}
	if descSet {
		body["description"] = desc
	}
	if *unassigned {
		body["assigneeId"] = nil
	} else if flagWasSet(fs, "assignee-id") {
		if strings.TrimSpace(*assigneeID) == "" {
			return fmt.Errorf("--assignee-id cannot be empty; use --unassigned")
		}
		body["assigneeId"] = *assigneeID
	} else if agentID := strings.TrimSpace(os.Getenv("ORBIT_AGENT_ID")); agentID != "" {
		body["assigneeId"] = agentID
	}
	if flagWasSet(fs, "list-id") {
		if strings.TrimSpace(*listID) == "" {
			return fmt.Errorf("--list-id cannot be empty")
		}
		body["listId"] = *listID
	}
	if flagWasSet(fs, "due-date") {
		if strings.TrimSpace(*dueDate) == "" {
			return fmt.Errorf("--due-date cannot be empty")
		}
		body["dueDate"] = *dueDate
	}
	if flagWasSet(fs, "provider") {
		if strings.TrimSpace(*provider) == "" {
			return fmt.Errorf("--provider cannot be empty")
		}
		body["provider"] = *provider
	}
	if flagWasSet(fs, "model") {
		if strings.TrimSpace(*model) == "" {
			return fmt.Errorf("--model cannot be empty")
		}
		body["model"] = *model
	}
	if deps := uniqueStrings(dependsOn); len(deps) > 0 {
		body["dependsOnTaskIds"] = deps
	}
	if flagWasSet(fs, "auto-run-when-ready") {
		body["autoRunWhenReady"] = *autoRun
	}
	t, err := cliTransport()
	if err != nil {
		return err
	}
	// Inside a session, attribute the task to the acting agent exactly as the MCP task tools do —
	// both read the same ORBIT_AGENT_ID, and the two write paths must not disagree on who created a
	// task. Passing the session also links the task to it and lets the server dedup a redelivered
	// turn's re-created tasks (see TasksService idempotency). ORBIT_AGENT_ID stays the default
	// assignee regardless.
	agentID, sessionID := cliTaskAttribution()
	raw, err := t.createTask(agentID, sessionID, body)
	if err != nil {
		return fmt.Errorf("create task: %w", err)
	}
	return writeCLIRawJSON(out, raw, *jsonOut)
}

// cliTaskAttribution returns the (agentId, sessionId) a CLI write is attributed to. Inside a
// session the runner injects both, and the CLI claims agent authorship like the MCP server. A
// headless process (launchd/cron) has no ORBIT_SESSION_ID: it keeps runner-owner attribution,
// because its runner credential is shared and must not let any script pose as an agent by setting
// an env var. The credential itself is always the runner token either way; only attribution moves.
func cliTaskAttribution() (agentID, sessionID string) {
	sessionID = strings.TrimSpace(os.Getenv("ORBIT_SESSION_ID"))
	if sessionID == "" {
		return "", ""
	}
	return strings.TrimSpace(os.Getenv("ORBIT_AGENT_ID")), sessionID
}

// cliCapabilityActor names who the mutating commands in the capability document will be recorded
// as. It reads the same resolution the writes use: with no agent id the server falls back to the
// owner even inside a session, so both halves of the pair must be present to claim agent
// authorship.
func cliCapabilityActor() string {
	if agentID, sessionID := cliTaskAttribution(); agentID != "" && sessionID != "" {
		return "agent"
	}
	return "runner_owner"
}

func cliTaskCreateBatch(args []string, in io.Reader, out io.Writer) error {
	fs := newCLIFlagSet("orbit task create-batch")
	tasks := fs.String("tasks", "", "JSON array of task objects")
	tasksFile := fs.String("tasks-file", "", "read the JSON array from stdin (-)")
	jsonOut := fs.Bool("json", false, "emit compact JSON")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if err := rejectTrailing(fs); err != nil {
		return err
	}
	raw, rawSet, err := readCLIText(in, *tasks, flagWasSet(fs, "tasks"), *tasksFile, flagWasSet(fs, "tasks-file"), "tasks")
	if err != nil {
		return err
	}
	if !rawSet {
		return fmt.Errorf("--tasks or --tasks-file is required")
	}
	items, err := parseTaskBatchItems(raw)
	if err != nil {
		return err
	}
	t, err := cliTransport()
	if err != nil {
		return err
	}
	// In-session agent attribution + session link, same as `orbit task create`.
	agentID, sessionID := cliTaskAttribution()
	out2, err := t.createTasksBatch(agentID, sessionID, map[string]interface{}{"tasks": items})
	if err != nil {
		return fmt.Errorf("create tasks: %w", err)
	}
	return writeCLIRawJSON(out, out2, *jsonOut)
}

// parseTaskBatchItems accepts either a bare JSON array of task objects or the request
// shape {"tasks": [...]}, and applies the same per-item defaults as `orbit task create`.
func parseTaskBatchItems(raw string) ([]map[string]interface{}, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return nil, fmt.Errorf("tasks is empty")
	}
	var items []map[string]interface{}
	if trimmed[0] == '{' {
		var wrapper struct {
			Tasks []map[string]interface{} `json:"tasks"`
		}
		if err := json.Unmarshal([]byte(trimmed), &wrapper); err != nil {
			return nil, fmt.Errorf("tasks must be a JSON array of task objects: %w", err)
		}
		items = wrapper.Tasks
	} else if err := json.Unmarshal([]byte(trimmed), &items); err != nil {
		return nil, fmt.Errorf("tasks must be a JSON array of task objects: %w", err)
	}
	if len(items) == 0 {
		return nil, fmt.Errorf("tasks must contain at least one task")
	}
	if len(items) > maxTaskBatchCreate {
		return nil, fmt.Errorf("tasks accepts at most %d items per call", maxTaskBatchCreate)
	}
	agentID := strings.TrimSpace(os.Getenv("ORBIT_AGENT_ID"))
	for i, item := range items {
		if item == nil {
			return nil, fmt.Errorf("tasks[%d] must be an object", i)
		}
		title, _ := item["title"].(string)
		if strings.TrimSpace(title) == "" {
			return nil, fmt.Errorf("tasks[%d]: title is required", i)
		}
		if _, ok := item["assigneeId"]; !ok && agentID != "" {
			item["assigneeId"] = agentID
		}
	}
	return items, nil
}

func cliTaskUpdate(args []string, in io.Reader, out io.Writer) error {
	id, rest := peelLeadingID(args)
	fs := newCLIFlagSet("orbit task update")
	title := fs.String("title", "", "task title")
	description := fs.String("description", "", "task description")
	descriptionFile := fs.String("description-file", "", "read description from stdin (-)")
	status := fs.String("status", "", "task status")
	assigneeID := fs.String("assignee-id", "", "assignee agent id")
	clearAssignee := fs.Bool("clear-assignee", false, "clear assignee")
	listID := fs.String("list-id", "", "task list id")
	clearList := fs.Bool("clear-list", false, "clear task list")
	dueDate := fs.String("due-date", "", "ISO due date")
	clearDueDate := fs.Bool("clear-due-date", false, "clear due date")
	provider := fs.String("provider", "", "run on this provider instead of the assignee's")
	clearProvider := fs.Bool("clear-provider", false, "inherit the assignee's provider again")
	model := fs.String("model", "", "run on this model instead of the assignee's")
	clearModel := fs.Bool("clear-model", false, "inherit the assignee's model again")
	var dependsOn csvFlag
	fs.Var(&dependsOn, "depends-on", "replace all prerequisite task ids (comma-separated, repeatable)")
	clearDependencies := fs.Bool("clear-dependencies", false, "clear all prerequisite task ids")
	autoRun := fs.Bool("auto-run-when-ready", false, "auto-run after dependencies complete")
	jsonOut := fs.Bool("json", false, "emit compact JSON")
	if err := fs.Parse(rest); err != nil {
		return err
	}
	id, err := resolveTaskCLIId(id, fs.Args())
	if err != nil {
		return err
	}
	if err := validateTaskCLIStatus(*status); err != nil {
		return err
	}
	if flagWasSet(fs, "status") && *status == "" {
		return fmt.Errorf("--status cannot be empty")
	}
	if *clearAssignee && flagWasSet(fs, "assignee-id") {
		return fmt.Errorf("--clear-assignee and --assignee-id cannot be used together")
	}
	if *clearList && flagWasSet(fs, "list-id") {
		return fmt.Errorf("--clear-list and --list-id cannot be used together")
	}
	if *clearDueDate && flagWasSet(fs, "due-date") {
		return fmt.Errorf("--clear-due-date and --due-date cannot be used together")
	}
	if *clearProvider && flagWasSet(fs, "provider") {
		return fmt.Errorf("--clear-provider and --provider cannot be used together")
	}
	if *clearModel && flagWasSet(fs, "model") {
		return fmt.Errorf("--clear-model and --model cannot be used together")
	}
	if *clearDependencies && flagWasSet(fs, "depends-on") {
		return fmt.Errorf("--clear-dependencies and --depends-on cannot be used together")
	}
	if flagWasSet(fs, "depends-on") && len(dependsOn) == 0 {
		return fmt.Errorf("--depends-on cannot be empty; use --clear-dependencies")
	}
	desc, descSet, err := readCLIText(in, *description, flagWasSet(fs, "description"), *descriptionFile, flagWasSet(fs, "description-file"), "description")
	if err != nil {
		return err
	}
	body := map[string]interface{}{}
	if flagWasSet(fs, "title") {
		if strings.TrimSpace(*title) == "" {
			return fmt.Errorf("--title cannot be empty")
		}
		body["title"] = *title
	}
	if descSet {
		body["description"] = desc
	}
	if flagWasSet(fs, "status") {
		body["status"] = *status
	}
	if *clearAssignee {
		body["assigneeId"] = nil
	} else if flagWasSet(fs, "assignee-id") {
		if strings.TrimSpace(*assigneeID) == "" {
			return fmt.Errorf("--assignee-id cannot be empty; use --clear-assignee")
		}
		body["assigneeId"] = *assigneeID
	}
	if *clearList {
		body["listId"] = nil
	} else if flagWasSet(fs, "list-id") {
		if strings.TrimSpace(*listID) == "" {
			return fmt.Errorf("--list-id cannot be empty; use --clear-list")
		}
		body["listId"] = *listID
	}
	if *clearDueDate {
		body["dueDate"] = nil
	} else if flagWasSet(fs, "due-date") {
		if strings.TrimSpace(*dueDate) == "" {
			return fmt.Errorf("--due-date cannot be empty; use --clear-due-date")
		}
		body["dueDate"] = *dueDate
	}
	if *clearProvider {
		body["provider"] = nil
	} else if flagWasSet(fs, "provider") {
		if strings.TrimSpace(*provider) == "" {
			return fmt.Errorf("--provider cannot be empty; use --clear-provider")
		}
		body["provider"] = *provider
	}
	if *clearModel {
		body["model"] = nil
	} else if flagWasSet(fs, "model") {
		if strings.TrimSpace(*model) == "" {
			return fmt.Errorf("--model cannot be empty; use --clear-model")
		}
		body["model"] = *model
	}
	if *clearDependencies {
		body["dependsOnTaskIds"] = []string{}
	} else if flagWasSet(fs, "depends-on") {
		body["dependsOnTaskIds"] = uniqueStrings(dependsOn)
	}
	if flagWasSet(fs, "auto-run-when-ready") {
		body["autoRunWhenReady"] = *autoRun
	}
	if len(body) == 0 {
		return fmt.Errorf("no fields to update")
	}
	t, err := cliTransport()
	if err != nil {
		return err
	}
	raw, err := t.updateTask(id, body)
	if err != nil {
		return fmt.Errorf("update task: %w", err)
	}
	return writeCLIRawJSON(out, raw, *jsonOut)
}

func cliTaskDelete(args []string, out io.Writer) error {
	id, rest := peelLeadingID(args)
	fs := newCLIFlagSet("orbit task delete")
	jsonOut := fs.Bool("json", false, "emit compact JSON")
	if err := fs.Parse(rest); err != nil {
		return err
	}
	id, err := resolveTaskCLIId(id, fs.Args())
	if err != nil {
		return err
	}
	t, err := cliTransport()
	if err != nil {
		return err
	}
	raw, err := t.deleteTask(id)
	if err != nil {
		return fmt.Errorf("delete task: %w", err)
	}
	return writeCLIRawJSON(out, raw, *jsonOut)
}

func cliTaskStart(args []string, out io.Writer) error {
	id, rest := peelLeadingID(args)
	fs := newCLIFlagSet("orbit task start")
	jsonOut := fs.Bool("json", false, "emit compact JSON")
	if err := fs.Parse(rest); err != nil {
		return err
	}
	id, err := resolveTaskCLIId(id, fs.Args())
	if err != nil {
		return err
	}
	t, err := cliTransport()
	if err != nil {
		return err
	}
	raw, err := t.startTask(id)
	if err != nil {
		return fmt.Errorf("start task: %w", err)
	}
	return writeCLIRawJSON(out, raw, *jsonOut)
}

func cliTaskComment(args []string, in io.Reader, out io.Writer) error {
	id, rest := peelLeadingID(args)
	fs := newCLIFlagSet("orbit task comment")
	bodyText := fs.String("body", "", "comment body")
	bodyFile := fs.String("body-file", "", "read body from stdin (-)")
	jsonOut := fs.Bool("json", false, "emit compact JSON")
	if err := fs.Parse(rest); err != nil {
		return err
	}
	id, err := resolveTaskCLIId(id, fs.Args())
	if err != nil {
		return err
	}
	body, bodySet, err := readCLIText(in, *bodyText, flagWasSet(fs, "body"), *bodyFile, flagWasSet(fs, "body-file"), "body")
	if err != nil {
		return err
	}
	if !bodySet || strings.TrimSpace(body) == "" {
		return fmt.Errorf("--body or --body-file - is required")
	}
	t, err := cliTransport()
	if err != nil {
		return err
	}
	// In-session comments are authored by the acting agent (same ORBIT_AGENT_ID the MCP path uses);
	// a headless comment stays runner-owner.
	agentID, _ := cliTaskAttribution()
	raw, err := t.commentTask(id, agentID, body)
	if err != nil {
		return fmt.Errorf("comment on task: %w", err)
	}
	return writeCLIRawJSON(out, raw, *jsonOut)
}

func cliTaskListList(args []string, out io.Writer) error {
	fs := newCLIFlagSet("orbit task-list list")
	jsonOut := fs.Bool("json", false, "emit compact JSON")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if err := rejectTrailing(fs); err != nil {
		return err
	}
	t, err := cliTransport()
	if err != nil {
		return err
	}
	raw, err := t.listTaskLists()
	if err != nil {
		return fmt.Errorf("list task lists: %w", err)
	}
	return writeCLIRawJSON(out, raw, *jsonOut)
}

func cliTaskListGet(args []string, out io.Writer) error {
	id, rest := peelLeadingID(args)
	fs := newCLIFlagSet("orbit task-list get")
	jsonOut := fs.Bool("json", false, "emit compact JSON")
	if err := fs.Parse(rest); err != nil {
		return err
	}
	if err := rejectTrailing(fs); err != nil {
		return err
	}
	if id == "" {
		return fmt.Errorf("list id is required")
	}
	t, err := cliTransport()
	if err != nil {
		return err
	}
	raw, err := t.getTaskList(id)
	if err != nil {
		return fmt.Errorf("get task list: %w", err)
	}
	return writeCLIRawJSON(out, raw, *jsonOut)
}

func cliTaskListUpdate(args []string, in io.Reader, out io.Writer) error {
	id, rest := peelLeadingID(args)
	fs := newCLIFlagSet("orbit task-list update")
	title := fs.String("title", "", "task list title")
	instructions := fs.String("instructions", "", "standing instructions for every task in the list")
	instructionsFile := fs.String("instructions-file", "", "read instructions from a file, or - for stdin")
	paused := fs.String("paused", "", "true|false — hold or resume dispatch for the whole list")
	maxConcurrent := fs.Int("max-concurrent", 0, "cap the list's concurrently running tasks")
	clearMaxConcurrent := fs.Bool("clear-max-concurrent", false, "remove the concurrency cap")
	foremanWorkspace := fs.String("foreman-workspace-id", "", "workspace that runs this list's coordination")
	clearForeman := fs.Bool("clear-foreman", false, "stop filing a foreman for this list")
	foremanStall := fs.Int("foreman-stall-minutes", 0, "minutes of no activity before a foreman is filed")
	note := fs.String("note", "", "why this change is being made; recorded on the revision")
	jsonOut := fs.Bool("json", false, "emit compact JSON")
	if err := fs.Parse(rest); err != nil {
		return err
	}
	if err := rejectTrailing(fs); err != nil {
		return err
	}
	if id == "" {
		return fmt.Errorf("list id is required")
	}
	body := map[string]interface{}{}
	// Only flags the caller actually passed are sent: a partial edit must never blank the rest of
	// the policy, and "absent" has to stay distinguishable from "cleared".
	if flagWasSet(fs, "title") {
		body["title"] = *title
	}
	text, textSet, err := readCLIText(in, *instructions, flagWasSet(fs, "instructions"),
		*instructionsFile, flagWasSet(fs, "instructions-file"), "instructions")
	if err != nil {
		return err
	}
	if textSet {
		body["instructions"] = text
	}
	if flagWasSet(fs, "paused") {
		switch *paused {
		case "true":
			body["paused"] = true
		case "false":
			body["paused"] = false
		default:
			return fmt.Errorf("--paused must be true or false")
		}
	}
	if *clearMaxConcurrent {
		body["maxConcurrent"] = nil
	} else if flagWasSet(fs, "max-concurrent") {
		body["maxConcurrent"] = *maxConcurrent
	}
	if *clearForeman {
		body["foremanWorkspaceId"] = nil
		body["foremanStallMinutes"] = nil
	} else {
		if flagWasSet(fs, "foreman-workspace-id") {
			body["foremanWorkspaceId"] = *foremanWorkspace
		}
		if flagWasSet(fs, "foreman-stall-minutes") {
			body["foremanStallMinutes"] = *foremanStall
		}
	}
	if flagWasSet(fs, "note") {
		body["note"] = *note
	}
	if len(body) == 0 {
		return fmt.Errorf("nothing to update")
	}
	t, err := cliTransport()
	if err != nil {
		return err
	}
	raw, err := t.updateTaskList(id, os.Getenv("ORBIT_AGENT_ID"), body)
	if err != nil {
		return fmt.Errorf("update task list: %w", err)
	}
	return writeCLIRawJSON(out, raw, *jsonOut)
}

func cliTaskListCreate(args []string, out io.Writer) error {
	fs := newCLIFlagSet("orbit task-list create")
	title := fs.String("title", "", "task list title")
	jsonOut := fs.Bool("json", false, "emit compact JSON")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if err := rejectTrailing(fs); err != nil {
		return err
	}
	if strings.TrimSpace(*title) == "" {
		return fmt.Errorf("--title is required")
	}
	t, err := cliTransport()
	if err != nil {
		return err
	}
	raw, err := t.createTaskList(*title)
	if err != nil {
		return fmt.Errorf("create task list: %w", err)
	}
	return writeCLIRawJSON(out, raw, *jsonOut)
}

type cliCapabilitySpec struct {
	Tool        string
	Argv        []string
	Usage       string
	Arguments   []string
	Description string
	Mutates     bool
}

var baseCLICapabilities = []cliCapabilitySpec{
	{Tool: "task_list", Argv: []string{"orbit", "task", "list"}, Usage: "orbit task list [--status STATUS] [--list-id ID] [--limit N] [--json]", Arguments: []string{"--status <OPEN|IN_PROGRESS|DONE|CANCELLED>", "--list-id <id>", "--limit <n> (default 100, max 200)", "--json"}},
	{Tool: "task_get", Argv: []string{"orbit", "task", "get"}, Usage: "orbit task get [task-id] [--json]", Arguments: []string{"[task-id] (defaults to ORBIT_TASK_ID)", "--json"}},
	{Tool: "task_create", Argv: []string{"orbit", "task", "create"}, Usage: "orbit task create --title TITLE [options]", Arguments: []string{"--title <text> (required)", "--description <text> | --description-file -", "--assignee-id <id> | --unassigned", "--list-id <id>", "--due-date <ISO date>", "--provider <slug>", "--model <model>", "--depends-on <id[,id...]> (repeatable)", "--auto-run-when-ready[=true|false]", "--json"}, Description: "Create a task. Inside a session it is attributed to this agent (ORBIT_AGENT_ID), the same as the MCP task tools; run headless with no session it is attributed to the runner owner. ORBIT_AGENT_ID is also the default assignee. This only records the task; call task_start when it should run immediately.", Mutates: true},
	{Tool: "task_create_batch", Argv: []string{"orbit", "task", "create-batch"}, Usage: "orbit task create-batch (--tasks JSON | --tasks-file -) [--json]", Arguments: []string{"--tasks <json array> | --tasks-file - (required)", "--json"}, Description: "Create several tasks in one atomic call — the batch form of task_create. JSON is an array of task objects taking the same fields as task_create; nothing is written unless every item is valid. An item may carry \"ref\", and a later item may list that ref in \"dependsOnRefs\" to depend on it without knowing its id yet. Attribution matches task_create: this agent inside a session, the runner owner headless. ORBIT_AGENT_ID is also each item's default assignee.", Mutates: true},
	{Tool: "task_update", Argv: []string{"orbit", "task", "update"}, Usage: "orbit task update [task-id] [options]", Arguments: []string{"[task-id] (defaults to ORBIT_TASK_ID)", "--title <text>", "--description <text> | --description-file -", "--status <OPEN|IN_PROGRESS|DONE|CANCELLED>", "--assignee-id <id> | --clear-assignee", "--list-id <id> | --clear-list", "--due-date <ISO date> | --clear-due-date", "--provider <slug> | --clear-provider", "--model <model> | --clear-model", "--depends-on <id[,id...]> (repeatable; replaces all)", "--clear-dependencies", "--auto-run-when-ready[=true|false]", "--json"}, Mutates: true},
	{Tool: "task_delete", Argv: []string{"orbit", "task", "delete"}, Usage: "orbit task delete [task-id] [--json]", Arguments: []string{"[task-id] (defaults to ORBIT_TASK_ID)", "--json"}, Mutates: true},
	{Tool: "task_start", Argv: []string{"orbit", "task", "start"}, Usage: "orbit task start [task-id] [--json]", Arguments: []string{"[task-id] (defaults to ORBIT_TASK_ID)", "--json"}, Mutates: true},
	{Tool: "task_comment", Argv: []string{"orbit", "task", "comment"}, Usage: "orbit task comment [task-id] (--body TEXT | --body-file -) [--json]", Arguments: []string{"[task-id] (defaults to ORBIT_TASK_ID)", "--body <text> | --body-file - (required)", "--json"}, Description: "Add a comment to a task, authored by this agent inside a session (like the MCP path) or by the runner owner when run headless.", Mutates: true},
	{Tool: "task_dependency_graph", Argv: []string{"orbit", "task", "dependency-graph"}, Usage: "orbit task dependency-graph [task-id] [--max-depth N] [--max-nodes N] [--json]", Arguments: []string{"[task-id] (defaults to ORBIT_TASK_ID)", "--max-depth <n> (server default when unset)", "--max-nodes <n> (server default when unset)", "--json"}},
	{Tool: "task_dependency_add", Argv: []string{"orbit", "task", "dependency-add"}, Usage: "orbit task dependency-add [task-id] --depends-on ID [--json]", Arguments: []string{"[task-id] (defaults to ORBIT_TASK_ID)", "--depends-on <id> (required)", "--json"}, Mutates: true},
	{Tool: "task_dependency_remove", Argv: []string{"orbit", "task", "dependency-remove"}, Usage: "orbit task dependency-remove [task-id] --depends-on ID [--json]", Arguments: []string{"[task-id] (defaults to ORBIT_TASK_ID)", "--depends-on <id> (required)", "--json"}, Mutates: true},
	{Tool: "tasklist_list", Argv: []string{"orbit", "task-list", "list"}, Usage: "orbit task-list list [--json]", Arguments: []string{"--json"}},
	{Tool: "tasklist_create", Argv: []string{"orbit", "task-list", "create"}, Usage: "orbit task-list create --title TITLE [--json]", Arguments: []string{"--title <text> (required)", "--json"}, Mutates: true},
	{Tool: "tasklist_get", Argv: []string{"orbit", "task-list", "get"}, Usage: "orbit task-list get LIST_ID [--json]", Arguments: []string{"[list-id] (required)", "--json"}},
	{Tool: "tasklist_update", Argv: []string{"orbit", "task-list", "update"}, Usage: "orbit task-list update LIST_ID [options]", Arguments: []string{"[list-id] (required)", "--title <text>", "--instructions <text> | --instructions-file -", "--paused[=true|false]", "--max-concurrent <n> | --clear-max-concurrent", "--foreman-workspace-id <id> | --clear-foreman", "--foreman-stall-minutes <n>", "--note <text>", "--json"}, Description: "Change a task list's dispatch policy. In a session the change is attributed to this agent (like the MCP path); headless it falls back to the runner owner. Every change is recorded as a restorable revision.", Mutates: true},
}

type cliCapability struct {
	ID             string                 `json:"id"`
	Argv           []string               `json:"argv"`
	HelpArgv       []string               `json:"helpArgv"`
	Usage          string                 `json:"usage"`
	Arguments      []string               `json:"arguments"`
	Description    string                 `json:"description"`
	MCPInputSchema map[string]interface{} `json:"mcpInputSchema"`
	Mutates        bool                   `json:"mutates"`
}

type cliCapabilityContext struct {
	Actor     string `json:"actor"`
	SessionID string `json:"sessionId,omitempty"`
	AgentID   string `json:"agentId,omitempty"`
	TaskID    string `json:"taskId,omitempty"`
	// Present when this process holds a minted service credential, so a headless operator can
	// see which grant is in play without decoding the token by hand.
	ServiceToken *cliServiceTokenContext `json:"serviceToken,omitempty"`
}

type cliServiceTokenContext struct {
	Scopes  []string `json:"scopes"`
	AgentID string   `json:"agentId,omitempty"`
}

type cliCapabilitiesDocument struct {
	SchemaVersion     int                  `json:"schemaVersion"`
	CLIVersion        string               `json:"cliVersion"`
	Registered        bool                 `json:"registered"`
	UnavailableReason string               `json:"unavailableReason,omitempty"`
	Context           cliCapabilityContext `json:"context"`
	Capabilities      []cliCapability      `json:"capabilities"`
}

func buildCLICapabilities(executable string) cliCapabilitiesDocument {
	ctx := cliCapabilityContext{
		SessionID: strings.TrimSpace(os.Getenv("ORBIT_SESSION_ID")),
		AgentID:   strings.TrimSpace(os.Getenv("ORBIT_AGENT_ID")),
		TaskID:    strings.TrimSpace(os.Getenv("ORBIT_TASK_ID")),
		// Derived from the write path itself rather than restated, so the document cannot claim
		// one author while the tasks it creates record another: in a session these commands
		// stamp the acting agent, headless they write as the runner owner.
		Actor: cliCapabilityActor(),
	}
	// A minted service credential names its own scopes, so it decides what this process may do —
	// including inside a session, where it was passed deliberately rather than injected.
	service := decodeServiceTokenClaims(currentServiceToken())
	includeOrchestration := service == nil && mcpOrchestrationEnabled() && ctx.SessionID != ""
	// No session context at all => a headless process (launchd/cron), which reaches only what its
	// credential grants. An in-session agent whose agent has orchestration off is NOT headless:
	// it keeps seeing no session_* capability.
	includeHeadlessSession := service != nil || (!includeOrchestration && ctx.SessionID == "")
	if service != nil {
		ctx.ServiceToken = &cliServiceTokenContext{Scopes: service.Scopes, AgentID: service.AgentID}
	}
	descriptors := make(map[string]map[string]interface{})
	for _, d := range toolDescriptors(false, includeOrchestration || includeHeadlessSession) {
		name, _ := d["name"].(string)
		descriptors[name] = d
	}
	specs := append([]cliCapabilitySpec{}, baseCLICapabilities...)
	if includeOrchestration {
		specs = append(specs, sessionCLICapabilities...)
		// The agent verbs ride the same gate as the session ones and have no headless form:
		// no service-token scope names them, so they never appear outside a live session.
		specs = append(specs, agentCLICapabilities...)
	} else if includeHeadlessSession {
		specs = append(specs, headlessSessionCLICapabilities(headlessAllowedActions(service))...)
	}
	commands := make([]cliCapability, 0, len(specs))
	for _, spec := range specs {
		d := descriptors[spec.Tool]
		description, _ := d["description"].(string)
		if spec.Description != "" {
			description = spec.Description
		}
		schema, _ := d["inputSchema"].(map[string]interface{})
		argv := append([]string{}, spec.Argv...)
		argv[0] = executable
		commands = append(commands, cliCapability{
			ID:             spec.Tool,
			Argv:           argv,
			HelpArgv:       append(append([]string{}, argv...), "--help"),
			Usage:          spec.Usage,
			Arguments:      append([]string{}, spec.Arguments...),
			Description:    description,
			MCPInputSchema: schema,
			Mutates:        spec.Mutates,
		})
	}
	registered := false
	unavailableReason := ""
	if err := configStoragePrivate(); err == nil {
		registered = loadConfig() != nil
	} else if !os.IsNotExist(err) {
		unavailableReason = "runner credential storage is not private; restart the Orbit runner once to migrate it"
	}
	return cliCapabilitiesDocument{
		SchemaVersion:     1,
		CLIVersion:        version,
		Registered:        registered,
		UnavailableReason: unavailableReason,
		Context:           ctx,
		Capabilities:      commands,
	}
}

func cmdCapabilitiesCLI(args []string, out io.Writer) error {
	fs := newCLIFlagSet("orbit capabilities")
	jsonOut := fs.Bool("json", false, "emit JSON")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if err := rejectTrailing(fs); err != nil {
		return err
	}
	executable := orbitCLIExecutable()
	if executable == "" {
		return fmt.Errorf("cannot resolve a safe absolute path to the Orbit executable")
	}
	doc := buildCLICapabilities(executable)
	if *jsonOut {
		enc := json.NewEncoder(out)
		enc.SetEscapeHTML(false)
		return enc.Encode(doc)
	}
	if _, err := fmt.Fprintf(out, "Orbit CLI %s — agent-safe capabilities\n", doc.CLIVersion); err != nil {
		return err
	}
	for _, c := range doc.Capabilities {
		if _, err := fmt.Fprintf(out, "  %s\n      %s\n", c.Usage, c.Description); err != nil {
			return err
		}
	}
	return nil
}
