package main

import (
	"flag"
	"fmt"
	"io"
	"os"
	"strings"
)

// `orbit project` — the CLI half of the project_* MCP tools. A project is the durable context a
// coordinator works from: what the work is for (goal), what would settle that it is finished
// (acceptanceCriteria), and how it is to be done (instructions). None of that is in a task's
// description, and a coordinator session that cannot read it is left inferring the objective from
// whichever task it happens to be looking at.
//
// An agent may also state it. `create` records a project it was asked to set up, and `update`
// revises the prose or settles the status when the work lands — the same fields, through the same
// server DTOs, as the person typing them into the web UI. Everything else about a project (listing
// them, deleting one, opening its coordinator) is still the human's door.
//
// `create` is the one that carries the session it ran in, because a project recorded from inside a
// session is bound to that session as its coordinator, together with the workspace it runs in.
// Opening the coordinator is still the human's door; which conversation it opens is settled at
// creation, so that door leads back here rather than somewhere new.
//
// Scope is the runner's owner throughout: the credential names a machine, so the only account
// these commands can read or write is the one that machine belongs to.

const projectHelp = `orbit project — read and write an Orbit project's durable context

Usage:
  orbit project get PROJECT_ID [--json]
  orbit project status PROJECT_ID [--json]
  orbit project verifications PROJECT_ID [--json]
  orbit project create --title TITLE [options]
  orbit project update PROJECT_ID [options]

Run 'orbit project <command> --help' for options.
`

var projectActionHelp = map[string]string{
	"get": `orbit project get — one project's goal, acceptance criteria and instructions

Usage:
  orbit project get PROJECT_ID [--json]

Returns the project a coordinator works from: its title, goal, acceptanceCriteria and
instructions, its status, the session and workspace it is coordinated from, and how its
tasks are distributed (_count plus tasksByStatus).

Returns the shape of the project, not its tasks — use ` + "`orbit task list`" + ` for those.
PROJECT_ID is the id shown in the web UI URL (e.g. /projects/<id>); a raw UUID works too.
`,
	"status": `orbit project status — what the coordinator is doing, and why it is not doing more

Usage:
  orbit project status PROJECT_ID [--json]

The answer to "why is this project not moving". One read, eleven sections:

  project        title, lifecycle status and how its tasks are distributed
  coordination   which agent coordinates it, where it runs, the coordination session and
                 which generation that is (the agent outlives every one of them)
  policy         whether the coordinator is switched on at all, how far it may go when it
                 runs (MANUAL / GUARDED_AUTO / AUTO), and configRevision
  consumption    tasks in flight against the cap, coordinator sessions against the daily
                 budget — the same numbers the admission gates compare against
  runtime        run state, whether a pass holds the lease and until when, fencing token
  nextWake       when it looks again and why, plus the candidates that lost
  decisions      the last few judgments: what each decided, and the actions and idempotency
                 keys it produced
  pendingActions claimed but not yet published — what is in flight this second
  blockers       what is stopping it, who can fix it, what would clear it, when it is
                 rechecked, and the resolved episodes
  events         durable signals still pending, with attempts and backoff, plus recent ones
  acceptance     the stated criteria, the last acceptance run, verdict tallies and the
                 per-branch merge evidence

A fact that is absent is null with a reason beside it — agentIdAbsentReason,
leaseAbsentReason, candidatesAbsentReason — never a missing field. "Nothing is blocking
this project" and "this build cannot tell you" are different answers and read differently.

Read only. Asking the coordinator to run now is the account owner's, through the Orbit web
app or the user API; a runner credential names a machine, and a machine that could trigger
its own coordinator would be driving the project MANUAL says only a person drives.

PROJECT_ID is the id shown in the web UI URL (e.g. /projects/<id>); a raw UUID works too.
`,
	"verifications": `orbit project verifications — what the checks concluded, and what they hold up

Usage:
  orbit project verifications PROJECT_ID [--json]

Returns three lists:
  verifications  each check in the project, its subject, its verdict, and which conclusion
                 that is (verdictRevision — a re-run gets a new one, so the same verdict
                 twice is two findings rather than one)
  failures       what each FAIL or INCONCLUSIVE left behind: the defect subtask filed under
                 the subject, the action that raised it, and whether a later PASS resolved it
  blockedTasks   the tasks that cannot be dispatched because of an unresolved failure, and
                 the reason for each (SUBJECT_DEFECT_OPEN, or UPSTREAM for a dependent)

Read it when a task looks ready and is not running. A blocked task looks like an ordinary
OPEN task on purpose — the block is a dispatch precondition, not a status anybody rewrote —
so this is the only place that says why.

A FAIL sends its subject back to OPEN and files the defect on its own. Fixing the defect is
what makes the subject runnable again; the check still has to run again before the work
downstream is released, because an old verdict never becomes a pass by itself.

PROJECT_ID is the id shown in the web UI URL (e.g. /projects/<id>); a raw UUID works too.
`,
	"create": `orbit project create — record a new project

Usage:
  orbit project create --title TITLE [options]

Options:
  --title TEXT                     what this body of work is called (required)
  --goal TEXT                      what the project is trying to achieve (max 4,000 characters)
  --goal-file -                    read the goal from stdin
  --acceptance-criteria TEXT       what would settle that the goal was reached (max 4,000)
  --acceptance-criteria-file -     read the acceptance criteria from stdin
  --instructions TEXT              how this project's work is to be done (max 10,000 characters)
  --instructions-file -            read the instructions from stdin
  --json                           emit compact JSON

The project is created under this runner's owner and starts OPEN. It holds no tasks yet —
file them with ` + "`orbit task create --project-id <id>`" + ` once it exists.

Run inside a session, the project is bound to THAT session as its coordinator — and to the
workspace it runs in — in the same write that creates the project, so opening the coordinator
later comes back to this conversation instead of starting a new one. A session coordinates at
most one project, so recording a second from the same session is refused and nothing is created.
Run headless there is no session to bind and no such binding: the coordinator is opened wherever
the project's work turns out to run, or wherever you say.

Only one --*-file flag per invocation: they all read the same stdin, and the second read
would silently come back empty.
`,
	"update": `orbit project update — revise a project's context, or settle where it stands

Usage:
  orbit project update PROJECT_ID [options]

Options:
  --title TEXT                     rename the project
  --goal TEXT                      replace what the project is trying to achieve (max 4,000)
  --goal-file -                    read the replacement goal from stdin
  --clear-goal                     leave the project with no stated goal
  --acceptance-criteria TEXT       replace what would settle the goal was reached (max 4,000)
  --acceptance-criteria-file -     read the replacement acceptance criteria from stdin
  --clear-acceptance-criteria      leave the project with no stated acceptance criteria
  --instructions TEXT              replace how the work is to be done (max 10,000 characters)
  --instructions-file -            read the replacement instructions from stdin
  --clear-instructions             leave the project with no standing instructions
  --status OPEN|DONE|CANCELLED     where the work stands
  --expected-config-revision N     only write if the project is still at that configRevision
  --json                           emit compact JSON

Only the flags you pass are sent, so revising the goal never blanks the instructions.
Each prose field is a whole-field replacement: text replaces it, --clear-<field> removes it,
and naming both for one field is refused rather than resolved by a preference order.

--status DONE says the goal was reached and CANCELLED says it will not be; neither is a way
to file the project out of sight. At least one flag is required — an update naming no field
is refused here rather than sent as a request that would change nothing, and the fence below
does not count as one: it names nothing to write.

--expected-config-revision is a compare-and-swap. Pass the configRevision you read from
'orbit project status' and the write commits only if the project is still at it; otherwise
it is refused with STALE_CONFIG_REVISION and nothing is written. Use it when you read the
project first and are acting on what you read — the account owner may have changed its
coordination settings since, and being told beats overwriting a decision you did not see.
Omit it and the write behaves exactly as it always has.

Only one --*-file flag per invocation: they all read the same stdin.
`,
}

var projectCLICapabilities = []cliCapabilitySpec{
	{Tool: "project_get", Argv: []string{"orbit", "project", "get"}, Usage: "orbit project get PROJECT_ID [--json]", Arguments: []string{"[project-id] (required)", "--json"}},
	{Tool: "project_status", Argv: []string{"orbit", "project", "status"}, Usage: "orbit project status PROJECT_ID [--json]", Arguments: []string{"[project-id] (required)", "--json"}, Description: "Read everything the control loop knows about one project — the answer to \"why is this project not moving\", which is otherwise spread over seven tables and usually misread as \"it is broken\". Returns its run state and lifecycle; which agent coordinates it, where, and the coordination session and generation; whether the coordinator is switched on and how far it may go (MANUAL / GUARDED_AUTO / AUTO) with the configRevision a control write states back; tasks in flight against the cap and coordinator sessions against the daily budget, counted exactly as the admission gates count them; whether a pass holds the lease; when it next wakes, why, and which candidates lost; the last few decisions with the actions and idempotency keys they produced; actions claimed but not yet published; what is blocking it, who can fix it, what would clear it and when it is rechecked; durable signals still pending with their attempts and backoff; and the acceptance evidence — stated criteria, last acceptance run, verdict tallies and per-branch merge state. Every absent fact is null beside a reason, so \"nothing is blocking this\" and \"this cannot be reported\" are different answers."},
	{Tool: "project_verifications", Argv: []string{"orbit", "project", "verifications"}, Usage: "orbit project verifications PROJECT_ID [--json]", Arguments: []string{"[project-id] (required)", "--json"}, Description: "Read what every verification in one project concluded and what those conclusions are still holding up: each check's verdict and verdictRevision, the defect subtask each FAIL filed under its subject, the action that raised it, whether a later PASS resolved it, and blockedTasks — the exact tasks that cannot be dispatched because of an unresolved failure, with the reason. Read it when a task looks ready and is not running: a blocked task looks like an ordinary OPEN task on purpose, because the block is a dispatch precondition rather than a status anybody rewrote."},
	{Tool: "project_create", Argv: []string{"orbit", "project", "create"}, Usage: "orbit project create --title TITLE [options]", Arguments: []string{"--title <text> (required)", "--goal <text> | --goal-file - (what the work is trying to achieve; max 4,000 characters)", "--acceptance-criteria <text> | --acceptance-criteria-file - (what would settle that the goal was reached; max 4,000 characters)", "--instructions <text> | --instructions-file - (how the work is to be done; max 10,000 characters)", "--json"}, Description: "Create a project under this runner's owner — the durable context a body of work is carried out from, as opposed to a task, which is one piece of that work. Use it when you are asked to set up or plan out a body of work: --goal says what it is trying to achieve, --acceptance-criteria what would settle that the goal was reached, and --instructions how the work is to be done. The project starts OPEN and holds no tasks; file them with `orbit task create --project-id <id>` afterwards. Inside a session the project is also bound to that session as its coordinator, and to the workspace it runs in, in the same write that creates it — so opening the coordinator later returns to this conversation rather than starting another; one session coordinates at most one project, and headless there is no session and so no such binding.", Mutates: true},
	{Tool: "project_update", Argv: []string{"orbit", "project", "update"}, Usage: "orbit project update PROJECT_ID [options]", Arguments: []string{"[project-id] (required)", "--title <text>", "--goal <text> | --goal-file - | --clear-goal", "--acceptance-criteria <text> | --acceptance-criteria-file - | --clear-acceptance-criteria", "--instructions <text> | --instructions-file - | --clear-instructions", "--status <OPEN|DONE|CANCELLED>", "--expected-config-revision <n>", "--json"}, Description: "Update a project you own. Only the flags you pass are sent, so revising the goal never blanks the instructions. Each prose field is a whole-field replacement: text replaces it and --clear-<field> removes it, which is why naming both for one field is refused. --status DONE records that the goal was reached and CANCELLED that it will not be — say so when the work actually lands, and note that neither is a way to file the project out of sight. At least one flag is required, and --expected-config-revision does not count as one: it is a compare-and-swap that names nothing to write. Pass it the configRevision you read from `orbit project status` and the write commits only if the project is still at it — otherwise it is refused with STALE_CONFIG_REVISION and nothing is written, which is what stops you silently overwriting a coordination setting the account owner changed after you read it. Only one --*-file flag per invocation, since they all read the same stdin.", Mutates: true},
}

func cmdProjectCLI(args []string, in io.Reader, out io.Writer) error {
	if len(args) == 0 || args[0] == "--help" || args[0] == "-h" {
		_, err := fmt.Fprint(out, projectHelp)
		return err
	}
	if args[0] == "help" {
		if len(args) == 1 {
			_, err := fmt.Fprint(out, projectHelp)
			return err
		}
		h, ok := projectActionHelp[args[1]]
		if !ok {
			return fmt.Errorf("unknown command %q", args[1])
		}
		_, err := fmt.Fprint(out, h)
		return err
	}
	action := args[0]
	h, known := projectActionHelp[action]
	if !known {
		return fmt.Errorf("unknown command %q\n\n%s", action, projectHelp)
	}
	if wantsHelp(args[1:]) {
		_, err := fmt.Fprint(out, h)
		return err
	}
	switch action {
	case "create":
		return cliProjectCreate(args[1:], in, out)
	case "update":
		return cliProjectUpdate(args[1:], in, out)
	case "status":
		return cliProjectCoordinatorStatus(args[1:], out)
	case "verifications":
		return cliProjectVerifications(args[1:], out)
	default:
		return cliProjectGet(args[1:], out)
	}
}

func cliProjectGet(args []string, out io.Writer) error {
	id, rest := peelLeadingID(args)
	fs := newCLIFlagSet("orbit project get")
	jsonOut := fs.Bool("json", false, "emit compact JSON")
	if err := fs.Parse(rest); err != nil {
		return err
	}
	if err := rejectTrailing(fs); err != nil {
		return err
	}
	// No ORBIT_PROJECT_ID fallback, unlike the task commands: the runner injects no such id, so
	// there is no current project to default to and guessing one would read the wrong project.
	if id == "" {
		return fmt.Errorf("project id is required")
	}
	t, err := cliTransport()
	if err != nil {
		return err
	}
	raw, err := t.getProject(id)
	if err != nil {
		return fmt.Errorf("get project: %w", err)
	}
	return writeCLIRawJSON(out, raw, *jsonOut)
}

// cliProjectCoordinatorStatus is the control loop's own state at a terminal: one GET, one raw body
// through. Same shape as the two reads either side of it — the server decides what the sections
// are, and a second opinion formatted here would be one that drifts from the API and the web UI.
func cliProjectCoordinatorStatus(args []string, out io.Writer) error {
	id, rest := peelLeadingID(args)
	fs := newCLIFlagSet("orbit project status")
	jsonOut := fs.Bool("json", false, "emit compact JSON")
	if err := fs.Parse(rest); err != nil {
		return err
	}
	if err := rejectTrailing(fs); err != nil {
		return err
	}
	if id == "" {
		return fmt.Errorf("project id is required")
	}
	t, err := cliTransport()
	if err != nil {
		return err
	}
	raw, err := t.getProjectCoordinatorStatus(id)
	if err != nil {
		return fmt.Errorf("get project status: %w", err)
	}
	return writeCLIRawJSON(out, raw, *jsonOut)
}

// cliProjectVerifications is the read half of §13.2 at a terminal: what the checks concluded and
// which tasks are waiting on one. Same shape as `get` — one path segment, one raw body through.
func cliProjectVerifications(args []string, out io.Writer) error {
	id, rest := peelLeadingID(args)
	fs := newCLIFlagSet("orbit project verifications")
	jsonOut := fs.Bool("json", false, "emit compact JSON")
	if err := fs.Parse(rest); err != nil {
		return err
	}
	if err := rejectTrailing(fs); err != nil {
		return err
	}
	if id == "" {
		return fmt.Errorf("project id is required")
	}
	t, err := cliTransport()
	if err != nil {
		return err
	}
	raw, err := t.getProjectVerifications(id)
	if err != nil {
		return fmt.Errorf("get project verifications: %w", err)
	}
	return writeCLIRawJSON(out, raw, *jsonOut)
}

// isDecimalRevision is the same shape the server's CONFIG_REVISION_PATTERN validates.
//
// Checked here so a typo is a message naming what the value should be rather than a 400 the caller
// has to decode — and kept a STRING rather than parsed, because `configRevision` is a bigint column
// served as a decimal string: turning it into a number here would silently round the exact value
// `orbit project status` printed.
func isDecimalRevision(value string) bool {
	if value == "" || len(value) > 20 {
		return false
	}
	for _, r := range value {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

// projectStatuses is what --status accepts, and the same three values the server's UpdateProjectDto
// validates against. Checked here so a typo is a message naming the alternatives rather than a 400
// the caller has to decode.
var projectStatuses = []string{"OPEN", "DONE", "CANCELLED"}

func validateProjectCLIStatus(status string) error {
	for _, valid := range projectStatuses {
		if status == valid {
			return nil
		}
	}
	return fmt.Errorf("--status must be one of %s", strings.Join(projectStatuses, ", "))
}

// projectStdinFlags rejects naming more than one --*-file flag in a single invocation.
//
// They all read the same stdin, one field at a time, and nothing downstream can notice that the
// first read drained the stream: the second field arrives as an empty string and the command
// reports success having blanked it. Caught before any read and before any request — a direct
// value for one field and stdin for another stays legal, because that is unambiguous.
func projectStdinFlags(fs *flag.FlagSet, names ...string) error {
	set := []string{}
	for _, name := range names {
		if flagWasSet(fs, name) {
			set = append(set, "--"+name)
		}
	}
	if len(set) > 1 {
		return fmt.Errorf("%s all read stdin and cannot be used together; pass one of them inline",
			strings.Join(set, " and "))
	}
	return nil
}

func cliProjectCreate(args []string, in io.Reader, out io.Writer) error {
	fs := newCLIFlagSet("orbit project create")
	title := fs.String("title", "", "what this body of work is called")
	goal := fs.String("goal", "", "what the project is trying to achieve")
	goalFile := fs.String("goal-file", "", "read the goal from stdin (-)")
	acceptanceCriteria := fs.String("acceptance-criteria", "", "what would settle that the goal was reached")
	acceptanceCriteriaFile := fs.String("acceptance-criteria-file", "", "read the acceptance criteria from stdin (-)")
	instructions := fs.String("instructions", "", "how this project's work is to be done")
	instructionsFile := fs.String("instructions-file", "", "read the instructions from stdin (-)")
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
	if err := projectStdinFlags(fs, "goal-file", "acceptance-criteria-file", "instructions-file"); err != nil {
		return err
	}
	body := map[string]interface{}{"title": *title}
	goalText, goalSet, err := readCLIText(in, *goal, flagWasSet(fs, "goal"), *goalFile, flagWasSet(fs, "goal-file"), "goal")
	if err != nil {
		return err
	}
	if goalSet {
		body["goal"] = goalText
	}
	criteria, criteriaSet, err := readCLIText(in, *acceptanceCriteria, flagWasSet(fs, "acceptance-criteria"), *acceptanceCriteriaFile, flagWasSet(fs, "acceptance-criteria-file"), "acceptance-criteria")
	if err != nil {
		return err
	}
	if criteriaSet {
		body["acceptanceCriteria"] = criteria
	}
	instructionsText, instructionsSet, err := readCLIText(in, *instructions, flagWasSet(fs, "instructions"), *instructionsFile, flagWasSet(fs, "instructions-file"), "instructions")
	if err != nil {
		return err
	}
	if instructionsSet {
		body["instructions"] = instructionsText
	}
	t, err := cliTransport()
	if err != nil {
		return err
	}
	// The session this ran in, the same env var `orbit task create` attributes a task with and
	// `orbit notify` routes an alert by. Here the server reads it to record that session's
	// workspace as the new project's coordinator default, so the project can be coordinated
	// straight away rather than only once one of its tasks has an assignee to borrow from.
	// Headless (launchd/cron, no ORBIT_SESSION_ID) sends no header and gets no default, which is
	// the honest answer: no session, no workspace to inherit.
	raw, err := t.createProject(strings.TrimSpace(os.Getenv("ORBIT_SESSION_ID")), body)
	if err != nil {
		return fmt.Errorf("create project: %w", err)
	}
	return writeCLIRawJSON(out, raw, *jsonOut)
}

func cliProjectUpdate(args []string, in io.Reader, out io.Writer) error {
	id, rest := peelLeadingID(args)
	fs := newCLIFlagSet("orbit project update")
	title := fs.String("title", "", "rename the project")
	goal := fs.String("goal", "", "replace what the project is trying to achieve")
	goalFile := fs.String("goal-file", "", "read the replacement goal from stdin (-)")
	clearGoal := fs.Bool("clear-goal", false, "leave the project with no stated goal")
	acceptanceCriteria := fs.String("acceptance-criteria", "", "replace what would settle that the goal was reached")
	acceptanceCriteriaFile := fs.String("acceptance-criteria-file", "", "read the replacement acceptance criteria from stdin (-)")
	clearAcceptanceCriteria := fs.Bool("clear-acceptance-criteria", false, "leave the project with no stated acceptance criteria")
	instructions := fs.String("instructions", "", "replace how this project's work is to be done")
	instructionsFile := fs.String("instructions-file", "", "read the replacement instructions from stdin (-)")
	clearInstructions := fs.Bool("clear-instructions", false, "leave the project with no standing instructions")
	status := fs.String("status", "", "where the work stands: OPEN, DONE or CANCELLED")
	expectedConfigRevision := fs.String("expected-config-revision", "", "only write if the project is still at this configRevision")
	jsonOut := fs.Bool("json", false, "emit compact JSON")
	if err := fs.Parse(rest); err != nil {
		return err
	}
	if err := rejectTrailing(fs); err != nil {
		return err
	}
	if id == "" {
		return fmt.Errorf("project id is required")
	}
	if flagWasSet(fs, "status") {
		if err := validateProjectCLIStatus(*status); err != nil {
			return err
		}
	}
	// Clearing and replacing are opposite instructions about the same field, so naming both is not
	// a preference order to resolve — including when the replacement is on stdin, which is why this
	// is caught before anything reads it.
	for _, field := range []struct {
		name  string
		clear bool
	}{
		{"goal", *clearGoal},
		{"acceptance-criteria", *clearAcceptanceCriteria},
		{"instructions", *clearInstructions},
	} {
		if !field.clear {
			continue
		}
		if flagWasSet(fs, field.name) {
			return fmt.Errorf("--clear-%s and --%s cannot be used together", field.name, field.name)
		}
		if flagWasSet(fs, field.name+"-file") {
			return fmt.Errorf("--clear-%s and --%s-file cannot be used together", field.name, field.name)
		}
	}
	if err := projectStdinFlags(fs, "goal-file", "acceptance-criteria-file", "instructions-file"); err != nil {
		return err
	}
	body := map[string]interface{}{}
	if flagWasSet(fs, "title") {
		if strings.TrimSpace(*title) == "" {
			return fmt.Errorf("--title cannot be empty")
		}
		body["title"] = *title
	}
	// Whole-field replacement with an explicit way to remove it: null clears, a string replaces,
	// and an absent flag sends nothing so the project keeps what it already states. Free text
	// rather than an id, so `--goal ""` is a caller deliberately recording none rather than a typo.
	goalText, goalSet, err := readCLIText(in, *goal, flagWasSet(fs, "goal"), *goalFile, flagWasSet(fs, "goal-file"), "goal")
	if err != nil {
		return err
	}
	if *clearGoal {
		body["goal"] = nil
	} else if goalSet {
		body["goal"] = goalText
	}
	criteria, criteriaSet, err := readCLIText(in, *acceptanceCriteria, flagWasSet(fs, "acceptance-criteria"), *acceptanceCriteriaFile, flagWasSet(fs, "acceptance-criteria-file"), "acceptance-criteria")
	if err != nil {
		return err
	}
	if *clearAcceptanceCriteria {
		body["acceptanceCriteria"] = nil
	} else if criteriaSet {
		body["acceptanceCriteria"] = criteria
	}
	instructionsText, instructionsSet, err := readCLIText(in, *instructions, flagWasSet(fs, "instructions"), *instructionsFile, flagWasSet(fs, "instructions-file"), "instructions")
	if err != nil {
		return err
	}
	if *clearInstructions {
		body["instructions"] = nil
	} else if instructionsSet {
		body["instructions"] = instructionsText
	}
	if flagWasSet(fs, "status") {
		body["status"] = *status
	}
	// An update naming no field would be a request the server accepts and that changes nothing —
	// which reads to the caller as "the edit went through". Refused here instead, and counted
	// BEFORE the fence goes in: the fence names nothing to write, so an invocation carrying only
	// it is exactly the no-op this refuses.
	if len(body) == 0 {
		return fmt.Errorf("no fields to update")
	}
	if flagWasSet(fs, "expected-config-revision") {
		if !isDecimalRevision(*expectedConfigRevision) {
			return fmt.Errorf("--expected-config-revision must be the decimal configRevision from `orbit project status`")
		}
		body["expectedConfigRevision"] = *expectedConfigRevision
	}
	t, err := cliTransport()
	if err != nil {
		return err
	}
	raw, err := t.updateProject(id, body)
	if err != nil {
		return fmt.Errorf("update project: %w", err)
	}
	return writeCLIRawJSON(out, raw, *jsonOut)
}
