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

const taskHelp = `orbit task — manage Orbit tasks

Usage:
  orbit task list [--status STATUS] [--list-id ID] [--json]
  orbit task get [task-id] [--json]
  orbit task create --title TITLE [options]
  orbit task update [task-id] [options]
  orbit task start [task-id] [--json]
  orbit task comment [task-id] (--body TEXT | --body-file -) [--json]

When task-id is omitted, ORBIT_TASK_ID is used if this command is running inside
an Orbit task session. Run 'orbit task <command> --help' for command options.
`

const taskListHelp = `orbit task-list — manage Orbit task lists

Usage:
  orbit task-list list [--json]
  orbit task-list create --title TITLE [--json]
`

var taskActionHelp = map[string]string{
	"list": `orbit task list — list tasks

Usage:
  orbit task list [--status OPEN|IN_PROGRESS|DONE|CANCELLED] [--list-id ID] [--json]
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
  --depends-on ID[,ID...]     Repeatable prerequisite task ids
  --auto-run-when-ready[=BOOL]
  --json
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
  --depends-on ID[,ID...]     Replace all prerequisites; repeatable
  --clear-dependencies        Remove all prerequisites
  --auto-run-when-ready[=BOOL]
  --json

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
	case "update":
		return cliTaskUpdate(args[1:], in, out)
	case "start":
		return cliTaskStart(args[1:], out)
	case "comment":
		return cliTaskComment(args[1:], in, out)
	default:
		return fmt.Errorf("unknown command %q\n\n%s", action, taskHelp)
	}
}

func cmdTaskListCLI(args []string, out io.Writer) error {
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
	t, err := cliTransport()
	if err != nil {
		return err
	}
	raw, err := t.listTasks()
	if err != nil {
		return fmt.Errorf("list tasks: %w", err)
	}
	return writeCLIRawJSON(out, filterTasks(raw, *status, *listID), *jsonOut)
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
	// The current runner credential is owner-wide rather than session-scoped.
	// Keep ORBIT_AGENT_ID as a convenient default assignee, but do not trust
	// environment variables as author-attribution headers.
	raw, err := t.createTask("", "", body)
	if err != nil {
		return fmt.Errorf("create task: %w", err)
	}
	return writeCLIRawJSON(out, raw, *jsonOut)
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
	raw, err := t.commentTask(id, "", body)
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
	{Tool: "task_list", Argv: []string{"orbit", "task", "list"}, Usage: "orbit task list [--status STATUS] [--list-id ID] [--json]", Arguments: []string{"--status <OPEN|IN_PROGRESS|DONE|CANCELLED>", "--list-id <id>", "--json"}},
	{Tool: "task_get", Argv: []string{"orbit", "task", "get"}, Usage: "orbit task get [task-id] [--json]", Arguments: []string{"[task-id] (defaults to ORBIT_TASK_ID)", "--json"}},
	{Tool: "task_create", Argv: []string{"orbit", "task", "create"}, Usage: "orbit task create --title TITLE [options]", Arguments: []string{"--title <text> (required)", "--description <text> | --description-file -", "--assignee-id <id> | --unassigned", "--list-id <id>", "--due-date <ISO date>", "--depends-on <id[,id...]> (repeatable)", "--auto-run-when-ready[=true|false]", "--json"}, Description: "Create a task as the runner owner. ORBIT_AGENT_ID is used only as the default assignee; runner-wide CLI credentials do not claim agent authorship. This only records the task; call task_start when it should run immediately.", Mutates: true},
	{Tool: "task_update", Argv: []string{"orbit", "task", "update"}, Usage: "orbit task update [task-id] [options]", Arguments: []string{"[task-id] (defaults to ORBIT_TASK_ID)", "--title <text>", "--description <text> | --description-file -", "--status <OPEN|IN_PROGRESS|DONE|CANCELLED>", "--assignee-id <id> | --clear-assignee", "--list-id <id> | --clear-list", "--due-date <ISO date> | --clear-due-date", "--depends-on <id[,id...]> (repeatable; replaces all)", "--clear-dependencies", "--auto-run-when-ready[=true|false]", "--json"}, Mutates: true},
	{Tool: "task_start", Argv: []string{"orbit", "task", "start"}, Usage: "orbit task start [task-id] [--json]", Arguments: []string{"[task-id] (defaults to ORBIT_TASK_ID)", "--json"}, Mutates: true},
	{Tool: "task_comment", Argv: []string{"orbit", "task", "comment"}, Usage: "orbit task comment [task-id] (--body TEXT | --body-file -) [--json]", Arguments: []string{"[task-id] (defaults to ORBIT_TASK_ID)", "--body <text> | --body-file - (required)", "--json"}, Description: "Add a comment to a task as the runner owner. Runner-wide CLI credentials do not claim agent authorship.", Mutates: true},
	{Tool: "tasklist_list", Argv: []string{"orbit", "task-list", "list"}, Usage: "orbit task-list list [--json]", Arguments: []string{"--json"}},
	{Tool: "tasklist_create", Argv: []string{"orbit", "task-list", "create"}, Usage: "orbit task-list create --title TITLE [--json]", Arguments: []string{"--title <text> (required)", "--json"}, Mutates: true},
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
		Actor:     "runner_owner",
	}
	includeOrchestration := mcpOrchestrationEnabled() && ctx.SessionID != ""
	descriptors := make(map[string]map[string]interface{})
	for _, d := range toolDescriptors(false, includeOrchestration) {
		name, _ := d["name"].(string)
		descriptors[name] = d
	}
	specs := append([]cliCapabilitySpec{}, baseCLICapabilities...)
	if includeOrchestration {
		specs = append(specs, sessionCLICapabilities...)
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
