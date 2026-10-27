package main

import (
	"fmt"
	"io"
)

// `orbit runner` — the CLI half of the MCP runner_list tool: the account's runners, for the
// --runner-id that 'orbit agent create' and 'orbit agent update' take. Same route, same gate as the
// tool: an orchestration verb, like the agent ones, so it needs a live session while its account has
// Session orchestration on, and no service-token scope names it.

const runnerHelp = `orbit runner — list this account's runners

Usage:
  orbit runner list [--json]

A runner is a machine that runs Orbit sessions. Its id is what --runner-id takes in
'orbit agent create' and 'orbit agent update'.

These commands run inside a live Orbit session while the account's Session orchestration
switch is on.
Run 'orbit runner <command> --help' for options.
`

var runnerActionHelp = map[string]string{
	"list": `orbit runner list — list this account's runners

Usage:
  orbit runner list [--json]

Reports every runner on the account, including one no agent is bound to yet: its id, name
and displayName; whether it is online now, decided as the web runner list decides it; its
status, version, last heartbeat and maxConcurrent; its OS and installed engines, each with
whether it is signed in, when its heartbeats reported them; and how many agents are bound
to it. Pass an id as --runner-id to 'orbit agent create' or 'orbit agent update'.

Options:
  --json                         Emit compact JSON
`,
}

var runnerCLICapabilities = []cliCapabilitySpec{
	{Tool: "runner_list", Argv: []string{"orbit", "runner", "list"}, Usage: "orbit runner list [--json]", Arguments: []string{"--json"}},
}

func cmdRunnerCLI(args []string, out io.Writer) error {
	if len(args) == 0 || args[0] == "--help" || args[0] == "-h" {
		_, err := fmt.Fprint(out, runnerHelp)
		return err
	}
	if args[0] == "help" {
		if len(args) == 1 {
			_, err := fmt.Fprint(out, runnerHelp)
			return err
		}
		h, ok := runnerActionHelp[args[1]]
		if !ok {
			return fmt.Errorf("unknown command %q", args[1])
		}
		_, err := fmt.Fprint(out, h)
		return err
	}
	action := args[0]
	h, known := runnerActionHelp[action]
	if !known {
		return fmt.Errorf("unknown command %q\n\n%s", action, runnerHelp)
	}
	if wantsHelp(args[1:]) {
		_, err := fmt.Fprint(out, h)
		return err
	}
	// Named "runner <verb>" so no service-token scope can match it, as the agent verbs are.
	ctx, err := requireCLIOrchestrationContext("runner " + action)
	if err != nil {
		return err
	}

	switch action {
	case "list":
		return cliRunnerList(args[1:], out, ctx)
	default:
		panic("unreachable runner command")
	}
}

func cliRunnerList(args []string, out io.Writer, ctx cliOrchestrationContext) error {
	fs := newCLIFlagSet("orbit runner list")
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
	raw, err := t.listRunners(ctx.sessionID, ctx.token)
	if err != nil {
		return fmt.Errorf("list runners: %w", err)
	}
	return writeCLIRawJSON(out, raw, *jsonOut)
}
