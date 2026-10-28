package main

import (
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"time"
)

// `orbit runner` — the CLI half of the MCP runner tools: the account's runners, for the --runner-id
// that 'orbit agent create' and 'orbit agent update' take, an engine CLI installed on one of them, and
// one of them deleted on the account owner's confirmation card.
// Same routes, same gate as the tools: orchestration verbs, like the agent ones, so they need a live
// session while its account has Session orchestration on, and no service-token scope names them.

const runnerHelp = `orbit runner — list this account's runners, install engine CLIs on them, and delete them

Usage:
  orbit runner list [--json]
  orbit runner install --runner-id ID --engine ENGINE [--update] [--wait] [--json]
  orbit runner install-status --runner-id ID [--json]
  orbit runner delete --runner-id ID [--json]

A runner is a machine that runs Orbit sessions. Its id is what --runner-id takes here and in
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
	"install": `orbit runner install — install or update an engine CLI on one of this account's runners

Usage:
  orbit runner install --runner-id ID --engine ENGINE [--update] [--wait] [--json]

Asks the runner to run ENGINE's own recommended installer on its machine, as pressing Install
on that runner's page in the Orbit app does. The request is the consent for that engine on
that machine, so it runs whether or not the runner was registered to install engines on its
own; no command is taken from here, only one of the engines below. The runner must be online:
its next heartbeat picks the request up, and it reports the command it runs, then whether it
worked.

With --update the runner runs its engine update pass instead, as Update engines in the app
does: every engine CLI installed on that machine is updated, ENGINE among them, and one with a
session running there is left until that session finishes and named in the result.

Any session that can run this can install an engine CLI on every runner of the account.

Prints the runner's engine relay as 'orbit runner install-status' reports it. With --wait it
polls until the runner reports the outcome — an install can take minutes — and prints that:
the command the runner ran and what came of it. A failed install exits non-zero.

Options:
  --runner-id ID                 Runner to install on (required); 'orbit runner list' shows the ids
  --engine ENGINE                claude, codex, kimi, antigravity, opencode, dsh or cursor (required)
  --update                       Update every engine CLI on the runner instead of installing ENGINE
  --wait                         Wait until the runner reports the outcome, and print it
  --json                         Emit compact JSON
`,
	"install-status": `orbit runner install-status — where an engine install or update on a runner stands

Usage:
  orbit runner install-status --runner-id ID [--json]

Reports the runner's engine relay as its page in the Orbit app shows it. status is null when
nothing is in flight, pending until the runner picks the request up, installing with the
command it runs, then done or failed, with that command and what the machine said — for a
failed install, also what to run by hand. mode is install (of engine) or update (of every
engine CLI there). A finished install is cleared, back to null, by the heartbeat that reports
its engine installed; 'orbit runner list' then shows it among the runner's engines. A finished
update stays until it is dismissed in the app.

Options:
  --runner-id ID                 Runner to read (required); 'orbit runner list' shows the ids
  --json                         Emit compact JSON
`,
	"delete": `orbit runner delete — delete one of this account's runners, and the workspaces bound to it

Usage:
  orbit runner delete --runner-id ID [--json]

Removes the runner from the account with every workspace bound to it, as Delete on the runner's
page in the Orbit app does. The machine itself is untouched: it can no longer reach Orbit, and
registering it again adds it back. A rented machine still has to be released where it was rented.
A managed runner is refused, and so is the runner this session runs on.

It first puts the runner — its name, whether it is online, and the workspaces that go with it —
on a confirmation card in front of the account owner, and waits for their answer: nothing is
deleted if they decline. Prints what was deleted.

Options:
  --runner-id ID                 Runner to delete (required); 'orbit runner list' shows the ids
  --json                         Emit compact JSON
`,
}

var runnerCLICapabilities = []cliCapabilitySpec{
	{Tool: "runner_list", Argv: []string{"orbit", "runner", "list"}, Usage: "orbit runner list [--json]", Arguments: []string{"--json"}},
	{Tool: "runner_engine_install", Argv: []string{"orbit", "runner", "install"}, Usage: "orbit runner install --runner-id ID --engine ENGINE [--update] [--wait] [--json]", Arguments: []string{"--runner-id <id> (required)", engineArgument() + " (required)", "--update (every engine CLI on the runner, instead of installing --engine)", "--wait (until the runner reports the outcome)", "--json"}, Mutates: true},
	{Tool: "runner_engine_install_status", Argv: []string{"orbit", "runner", "install-status"}, Usage: "orbit runner install-status --runner-id ID [--json]", Arguments: []string{"--runner-id <id> (required)", "--json"}},
	{Tool: "runner_delete", Argv: []string{"orbit", "runner", "delete"}, Usage: "orbit runner delete --runner-id ID [--json]", Arguments: []string{"--runner-id <id> (required)", "--json"}, Mutates: true},
}

// runnerDeleteApprovalToolName keys the card a runner delete is asked on. The server matches the delete
// against it by this name (apiserver runner-api/runner-delete-approval.ts), so both ends spell it alike.
const runnerDeleteApprovalToolName = "orbit_runner_delete"

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
	case "install":
		return cliRunnerInstall(args[1:], out, ctx)
	case "install-status":
		return cliRunnerInstallStatus(args[1:], out, ctx)
	case "delete":
		return cliRunnerDelete(args[1:], out, ctx)
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

func cliRunnerInstall(args []string, out io.Writer, ctx cliOrchestrationContext) error {
	fs := newCLIFlagSet("orbit runner install")
	runnerID := fs.String("runner-id", "", "runner to install on")
	engine := fs.String("engine", "", "the engine CLI to install")
	update := fs.Bool("update", false, "update every engine CLI on the runner instead")
	wait := fs.Bool("wait", false, "wait until the runner reports the outcome")
	jsonOut := fs.Bool("json", false, "emit compact JSON")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if err := rejectTrailing(fs); err != nil {
		return err
	}
	id := strings.TrimSpace(*runnerID)
	if id == "" {
		return fmt.Errorf("--runner-id is required; 'orbit runner list' shows the ids")
	}
	// Which engines exist is the server's to say, as it is for --engine everywhere else.
	name := strings.TrimSpace(*engine)
	if name == "" {
		return fmt.Errorf("--engine is required: one of %s", strings.Join(engineNames, ", "))
	}
	mode := "install"
	if *update {
		mode = "update"
	}
	t, err := cliSessionTransport(ctx)
	if err != nil {
		return err
	}
	raw, err := t.requestEngineInstall(ctx.sessionID, ctx.token, id, name, mode)
	if err != nil {
		return fmt.Errorf("request the %s: %w", mode, err)
	}
	if !*wait {
		return writeCLIRawJSON(out, raw, *jsonOut)
	}
	final, waitErr := waitForEngineRelay(t, ctx, id, name, mode, raw)
	if final != nil {
		if err := writeCLIRawJSON(out, final, *jsonOut); err != nil {
			return err
		}
	}
	return waitErr
}

func cliRunnerInstallStatus(args []string, out io.Writer, ctx cliOrchestrationContext) error {
	fs := newCLIFlagSet("orbit runner install-status")
	runnerID := fs.String("runner-id", "", "runner to read")
	jsonOut := fs.Bool("json", false, "emit compact JSON")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if err := rejectTrailing(fs); err != nil {
		return err
	}
	id := strings.TrimSpace(*runnerID)
	if id == "" {
		return fmt.Errorf("--runner-id is required; 'orbit runner list' shows the ids")
	}
	t, err := cliSessionTransport(ctx)
	if err != nil {
		return err
	}
	raw, err := t.engineInstallState(ctx.sessionID, ctx.token, id)
	if err != nil {
		return fmt.Errorf("read the install status: %w", err)
	}
	return writeCLIRawJSON(out, raw, *jsonOut)
}

// cliRunnerDelete asks the account owner on a confirmation card, then deletes on their yes. The card names
// the runner by id alone: what the owner reads about it is the server's to fill in.
func cliRunnerDelete(args []string, out io.Writer, ctx cliOrchestrationContext) error {
	fs := newCLIFlagSet("orbit runner delete")
	runnerID := fs.String("runner-id", "", "runner to delete")
	jsonOut := fs.Bool("json", false, "emit compact JSON")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if err := rejectTrailing(fs); err != nil {
		return err
	}
	id := strings.TrimSpace(*runnerID)
	if id == "" {
		return fmt.Errorf("--runner-id is required; 'orbit runner list' shows the ids")
	}
	if err := validatePathSegmentID(id); err != nil {
		return fmt.Errorf("runner %w", err)
	}
	t, err := cliSessionTransport(ctx)
	if err != nil {
		return err
	}
	if declined, err := askBeforeCreate(t, ctx.sessionID, runnerDeleteApprovalToolName, map[string]interface{}{"runnerId": id}); err != nil {
		return fmt.Errorf("delete runner: %w", err)
	} else if declined != "" {
		return fmt.Errorf("delete runner: the human rejected this deletion, and nothing was deleted: %s", declined)
	}
	raw, err := t.deleteRunner(ctx.sessionID, ctx.token, id)
	if err != nil {
		return fmt.Errorf("delete runner: %w", err)
	}
	return writeCLIRawJSON(out, raw, *jsonOut)
}

// How `orbit runner install --wait` polls. The control plane fails a relay the runner has not settled
// 12 minutes after it started, on the runner's next heartbeat (INSTALL_RELAY_TIMEOUT_MS), so the limit
// outlasts that by a heartbeat and then some: a wait that ends on its own limit is a runner that went quiet.
// Vars so the tests need not wait.
var (
	engineInstallWaitInterval = 3 * time.Second
	engineInstallWaitLimit    = 13 * time.Minute
)

// engineRelayState is a runner's engine relay as GET /runner/runners/:id/engine-install answers it, which is
// the web runner page's own (RunnerInstallState); a null reads "".
type engineRelayState struct {
	Status  string `json:"status"`
	Engine  string `json:"engine"`
	Command string `json:"command"`
	Message string `json:"message"`
	Mode    string `json:"mode"`
}

// waitForEngineRelay polls the runner's engine relay until the request this command made has an outcome:
// the answer to print, and the error to exit with after printing it.
func waitForEngineRelay(t *Transport, ctx cliOrchestrationContext, runnerID, engine, mode string, raw json.RawMessage) (json.RawMessage, error) {
	deadline := time.Now().Add(engineInstallWaitLimit)
	seen := raw
	for {
		var state engineRelayState
		if err := json.Unmarshal(raw, &state); err != nil {
			return nil, fmt.Errorf("read the install status: %w", err)
		}
		switch {
		case state.Status == "":
			return engineRelayCleared(t, ctx, runnerID, engine, mode, seen, raw)
		case state.Mode != mode || mode == "install" && state.Engine != engine:
			// One relay per machine: a later request — the owner's in the app, or another session's — took it.
			return raw, fmt.Errorf("the runner's engine relay was taken by another request before this one reported an outcome")
		case state.Status == "done":
			return raw, nil
		case state.Status == "failed":
			return raw, fmt.Errorf("the runner reports the %s failed", mode)
		}
		seen = raw
		if time.Now().After(deadline) {
			return raw, fmt.Errorf("no outcome from the runner after %s (still %s); 'orbit runner install-status --runner-id %s' shows where it stands",
				engineInstallWaitLimit, state.Status, runnerID)
		}
		time.Sleep(engineInstallWaitInterval)
		next, err := t.engineInstallState(ctx.sessionID, ctx.token, runnerID)
		if err != nil {
			return seen, fmt.Errorf("read the install status: %w", err)
		}
		raw = next
	}
}

// engineRelayCleared answers a relay that went back to nothing in flight while this command waited. Two
// things clear it: the heartbeat that reports a finished install's engine installed, which retires it at
// once — so a wait usually ends here rather than on "done" — and the owner dismissing it in the app. The
// runner list tells them apart: retired, the engine is among the runner's installed ones, and the request's
// last state is answered as done. An update's outcome is only ever dismissed.
func engineRelayCleared(t *Transport, ctx cliOrchestrationContext, runnerID, engine, mode string, seen, cleared json.RawMessage) (json.RawMessage, error) {
	dismissed := fmt.Errorf("the %s was dismissed in the Orbit app before the runner reported an outcome", mode)
	if mode != "install" {
		return cleared, dismissed
	}
	raw, err := t.listRunners(ctx.sessionID, ctx.token)
	if err != nil {
		return cleared, fmt.Errorf("the runner's engine relay was cleared, and the runner list that says whether %s is installed could not be read: %w", engine, err)
	}
	var runners []struct {
		ID       string `json:"id"`
		PublicID string `json:"publicId"`
		Engines  []struct {
			Engine string `json:"engine"`
		} `json:"engines"`
	}
	if err := json.Unmarshal(raw, &runners); err != nil {
		return cleared, fmt.Errorf("read the runner list: %w", err)
	}
	for _, r := range runners {
		if r.ID != runnerID && r.PublicID != runnerID {
			continue
		}
		for _, e := range r.Engines {
			if e.Engine != engine {
				continue
			}
			var state map[string]interface{}
			if err := json.Unmarshal(seen, &state); err != nil {
				return cleared, fmt.Errorf("read the install status: %w", err)
			}
			state["status"] = "done"
			return json.Marshal(state)
		}
		return cleared, dismissed
	}
	return cleared, fmt.Errorf("the runner's engine relay was cleared, and 'orbit runner list' lists no runner %s to say whether %s is installed there: pass --runner-id as it lists it", runnerID, engine)
}
