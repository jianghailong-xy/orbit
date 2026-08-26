package main

import (
	"flag"
	"fmt"
	"io"
	"strings"
)

// `orbit agent` — the CLI half of the MCP agent_* tools, for an in-session agent that reaches
// Orbit through a shell instead of through MCP. Same routes, same bodies, same gate: these are
// orchestration verbs, so they need a live session whose agent has enableOrchestration. No
// service-token scope names them, which requireCLIOrchestrationContext reports for us.

const agentHelp = `orbit agent — inspect and configure Orbit agents

Usage:
  orbit agent list [--json]
  orbit agent create --name NAME [options]
  orbit agent update AGENT_ID [options]

An agent is a machine plus a project directory. It has no provider of its own — pass
--provider to 'orbit session create' when a session needs a specific one. The orchestration
permission cannot be set here: only a human can grant it in the web UI.

Creating with --repo-url and no --work-dir queues a clone on the selected runner. The create
response and 'orbit agent list' report provisionState: READY is usable, CLONING is still in
flight, and FAILED carries git's stderr in provisionError.

These commands run inside a live Orbit session whose agent has enableOrchestration enabled.
Run 'orbit agent <command> --help' for options.
`

var agentActionHelp = map[string]string{
	"list": `orbit agent list — list this owner's agents

Usage:
  orbit agent list [--json]

Reports id, name, repoUrl, workDir, runner, provisionState/provisionError and the provider each
project last ran on — enough to poll a clone and to resolve an @mention to the --agent-id /
--agent-name of 'orbit session create'. READY is usable, CLONING is still cloning, and FAILED
carries git's stderr in provisionError.
`,
	"create": `orbit agent create — create an agent

Usage:
  orbit agent create --name NAME [options]

Options:
  --name NAME                    (required)
  --description TEXT
  --system-prompt TEXT
  --append-system-prompt TEXT
  --work-dir PATH                Project directory on the runner
  --runner-id ID                 Defaults to the current runner
  --repo-url URL                 Clone this git remote when --work-dir is omitted
  --enable-worktree[=BOOL]       Run each of the agent's sessions in its own git worktree
  --env KEY=VALUE                Repeatable; REPLACES the whole environment map
  --default-merge-target BRANCH  Branch this agent's sessions merge into by default
  --json

The response includes repoUrl, provisionState and provisionError. READY means the directory is
usable; CLONING means clone is still in flight and sessions cannot start; FAILED means clone
stopped and provisionError contains git's stderr. Poll 'orbit agent list' after CLONING.
`,
	"update": `orbit agent update — update an agent's configuration

Usage:
  orbit agent update AGENT_ID [options]

Options:
  --name NAME
  --description TEXT
  --system-prompt TEXT
  --append-system-prompt TEXT
  --work-dir PATH
  --runner-id ID
  --enable-worktree[=BOOL]
  --env KEY=VALUE                Repeatable; REPLACES the whole environment map
  --default-merge-target BRANCH
  --json

Existing env values are secret and never returned by 'orbit agent list', so pass the
complete desired map whenever --env is used at all.
`,
}

var agentCLICapabilities = []cliCapabilitySpec{
	{Tool: "agent_list", Argv: []string{"orbit", "agent", "list"}, Usage: "orbit agent list [--json]", Arguments: []string{"--json"}},
	{Tool: "agent_create", Argv: []string{"orbit", "agent", "create"}, Usage: "orbit agent create --name NAME [options]", Arguments: []string{"--name <text> (required)", "--description <text>", "--system-prompt <text>", "--append-system-prompt <text>", "--work-dir <path>", "--runner-id <id>", "--repo-url <url> (without --work-dir, clone on the selected runner)", "--enable-worktree[=true|false]", "--env <KEY=VALUE> (repeatable; replaces all)", "--default-merge-target <branch>", "--json"}, Mutates: true},
	{Tool: "agent_update", Argv: []string{"orbit", "agent", "update"}, Usage: "orbit agent update AGENT_ID [options]", Arguments: []string{"[agent-id] (required)", "--name <text>", "--description <text>", "--system-prompt <text>", "--append-system-prompt <text>", "--work-dir <path>", "--runner-id <id>", "--enable-worktree[=true|false]", "--env <KEY=VALUE> (repeatable; replaces all)", "--default-merge-target <branch>", "--json"}, Mutates: true},
}

func cmdAgentCLI(args []string, out io.Writer) error {
	if len(args) == 0 || args[0] == "--help" || args[0] == "-h" {
		_, err := fmt.Fprint(out, agentHelp)
		return err
	}
	if args[0] == "help" {
		if len(args) == 1 {
			_, err := fmt.Fprint(out, agentHelp)
			return err
		}
		h, ok := agentActionHelp[args[1]]
		if !ok {
			return fmt.Errorf("unknown command %q", args[1])
		}
		_, err := fmt.Fprint(out, h)
		return err
	}
	action := args[0]
	h, known := agentActionHelp[action]
	if !known {
		return fmt.Errorf("unknown command %q\n\n%s", action, agentHelp)
	}
	if wantsHelp(args[1:]) {
		_, err := fmt.Fprint(out, h)
		return err
	}
	// Named "agent <verb>" so no service-token scope can match it: these verbs exist only inside
	// a session, and the gate says so instead of pointing at a scope nobody can mint.
	ctx, err := requireCLIOrchestrationContext("agent " + action)
	if err != nil {
		return err
	}

	switch action {
	case "list":
		return cliAgentList(args[1:], out, ctx)
	case "create":
		return cliAgentCreate(args[1:], out, ctx)
	case "update":
		return cliAgentUpdate(args[1:], out, ctx)
	default:
		panic("unreachable agent command")
	}
}

// envFlag collects repeated --env KEY=VALUE into the flat map the API stores. Split on the first
// '=' only, so a value may contain as many as it likes.
type envFlag map[string]string

func (v *envFlag) String() string { return "" }
func (v *envFlag) Set(s string) error {
	key, value, found := strings.Cut(s, "=")
	if key = strings.TrimSpace(key); !found || key == "" {
		return fmt.Errorf("--env expects KEY=VALUE, got %q", s)
	}
	if *v == nil {
		*v = envFlag{}
	}
	(*v)[key] = value
	return nil
}

// The safe workspace write fields, in MCP's own spelling. repoURL is registered only for create.
type agentCLIWriteFlags struct {
	name               *string
	description        *string
	systemPrompt       *string
	appendSystemPrompt *string
	workDir            *string
	runnerID           *string
	repoURL            *string
	enableWorktree     *bool
	defaultMergeTarget *string
	env                envFlag
}

func registerAgentWriteFlags(fs *flag.FlagSet, includeRepoURL bool) *agentCLIWriteFlags {
	f := &agentCLIWriteFlags{
		name:               fs.String("name", "", "agent name"),
		description:        fs.String("description", "", "agent description"),
		systemPrompt:       fs.String("system-prompt", "", "replace the agent's system prompt"),
		appendSystemPrompt: fs.String("append-system-prompt", "", "append to the agent's system prompt"),
		workDir:            fs.String("work-dir", "", "project directory on the runner"),
		runnerID:           fs.String("runner-id", "", "runner to bind the agent to"),
		enableWorktree:     fs.Bool("enable-worktree", false, "run each session in its own git worktree"),
		defaultMergeTarget: fs.String("default-merge-target", "", "default merge target branch"),
	}
	if includeRepoURL {
		f.repoURL = fs.String("repo-url", "", "git remote to clone when work-dir is omitted")
	}
	fs.Var(&f.env, "env", "environment variable KEY=VALUE (repeatable; replaces the whole map)")
	return f
}

// agentWriteBody renders the flags that were actually given. An empty string is refused rather
// than sent: the API replaces whatever it receives, so a bare --name would silently blank a field.
func (f *agentCLIWriteFlags) body(fs *flag.FlagSet, body map[string]interface{}) error {
	for flagName, target := range map[string]*string{
		"name":                 f.name,
		"description":          f.description,
		"system-prompt":        f.systemPrompt,
		"append-system-prompt": f.appendSystemPrompt,
		"work-dir":             f.workDir,
		"runner-id":            f.runnerID,
		"repo-url":             f.repoURL,
		"default-merge-target": f.defaultMergeTarget,
	} {
		if !flagWasSet(fs, flagName) {
			continue
		}
		if strings.TrimSpace(*target) == "" {
			return fmt.Errorf("--%s cannot be empty", flagName)
		}
		body[agentCLIBodyField[flagName]] = *target
	}
	if flagWasSet(fs, "enable-worktree") {
		body["enableWorktree"] = *f.enableWorktree
	}
	if f.env != nil {
		body["env"] = map[string]string(f.env)
	}
	return nil
}

// agentCLIBodyField maps a flag to the API field it writes, so the two spellings stay together.
var agentCLIBodyField = map[string]string{
	"name":                 "name",
	"description":          "description",
	"system-prompt":        "systemPrompt",
	"append-system-prompt": "appendSystemPrompt",
	"work-dir":             "workDir",
	"runner-id":            "runnerId",
	"repo-url":             "repoUrl",
	"default-merge-target": "defaultMergeTarget",
}

func cliAgentList(args []string, out io.Writer, ctx cliOrchestrationContext) error {
	fs := newCLIFlagSet("orbit agent list")
	jsonOut := fs.Bool("json", false, "emit compact JSON")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if err := rejectTrailing(fs); err != nil {
		return err
	}
	t, err := cliSessionTransport(ctx)
	if err != nil {
		return err
	}
	raw, err := t.listAgents(ctx.sessionID, ctx.token)
	if err != nil {
		return fmt.Errorf("list agents: %w", err)
	}
	return writeCLIRawJSON(out, raw, *jsonOut)
}

func cliAgentCreate(args []string, out io.Writer, ctx cliOrchestrationContext) error {
	fs := newCLIFlagSet("orbit agent create")
	fields := registerAgentWriteFlags(fs, true)
	jsonOut := fs.Bool("json", false, "emit compact JSON")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if err := rejectTrailing(fs); err != nil {
		return err
	}
	if strings.TrimSpace(*fields.name) == "" {
		return fmt.Errorf("--name is required")
	}
	body := map[string]interface{}{}
	if err := fields.body(fs, body); err != nil {
		return err
	}
	t, err := cliSessionTransport(ctx)
	if err != nil {
		return err
	}
	raw, err := t.createAgent(ctx.sessionID, ctx.token, body)
	if err != nil {
		return fmt.Errorf("create agent: %w", err)
	}
	return writeCLIRawJSON(out, raw, *jsonOut)
}

func cliAgentUpdate(args []string, out io.Writer, ctx cliOrchestrationContext) error {
	id, rest := peelLeadingID(args)
	fs := newCLIFlagSet("orbit agent update")
	fields := registerAgentWriteFlags(fs, false)
	jsonOut := fs.Bool("json", false, "emit compact JSON")
	if err := fs.Parse(rest); err != nil {
		return err
	}
	id, err := resolveAgentCLIId(id, fs.Args())
	if err != nil {
		return err
	}
	body := map[string]interface{}{}
	if err := fields.body(fs, body); err != nil {
		return err
	}
	if len(body) == 0 {
		return fmt.Errorf("no fields to update")
	}
	t, err := cliSessionTransport(ctx)
	if err != nil {
		return err
	}
	raw, err := t.updateAgent(ctx.sessionID, ctx.token, id, body)
	if err != nil {
		return fmt.Errorf("update agent: %w", err)
	}
	return writeCLIRawJSON(out, raw, *jsonOut)
}

// resolveAgentCLIId mirrors the session id rules: one id, taken from either position, and never
// something that could steer the request off the agent route.
func resolveAgentCLIId(leading string, trailing []string) (string, error) {
	if leading != "" && len(trailing) > 0 {
		return "", fmt.Errorf("unexpected arguments: %s", strings.Join(trailing, " "))
	}
	if leading == "" {
		if len(trailing) > 1 {
			return "", fmt.Errorf("expected one agent id, got: %s", strings.Join(trailing, " "))
		}
		if len(trailing) == 1 {
			leading = trailing[0]
		}
	}
	if leading == "" {
		return "", fmt.Errorf("agent id is required")
	}
	if err := validatePathSegmentID(leading); err != nil {
		return "", fmt.Errorf("agent %w", err)
	}
	return leading, nil
}
