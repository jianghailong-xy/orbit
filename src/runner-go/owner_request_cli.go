package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"
	"time"
)

// `orbit owner-request` — the CLI half of the MCP request_owner_action tool. It builds the same arguments the tool
// takes and hands them to ownerRequestBody, so one filing is the same request body from either door.

const ownerRequestHelp = `orbit owner-request — ask the account owner for something only they can do or provide

Usage:
  orbit owner-request --kind KIND --title TEXT --why TEXT [options] [--json]

Kinds: DECISION, SECRET, MANUAL_STEP, CONFIRM, WIKI_CREATE, CHANGE. Runs only inside a session: the
request is filed as that session, and its outcome arrives later as a turn in the conversation. This
command does not wait.

To propose a runner's Max Concurrent (kind CHANGE), the owner applies it with one press and you never
write the setting yourself:
  orbit owner-request --kind CHANGE --runner ID_OR_NAME --max-concurrent 6 \
    --title "Lower wikova to 6 concurrent sessions" --why "It has run at 12/12 for 40 minutes."
When the outcome arrives, read "applied", not "requested": the owner may choose a different number.

Options:
  --kind KIND                 What you need from the owner (required)
  --title TEXT                The line the owner reads first (required for every kind but WIKI_CREATE)
  --why TEXT                  What this unblocks and why only the owner can do it (required)
  --runner ID|NAME            CHANGE only: the runner whose setting you propose; a name is looked up in 'orbit runner list'
  --max-concurrent N          CHANGE only: the Max Concurrent you propose (1 or more)
  --blocks-task-id ID         A task waiting on this request; repeat the flag for more
  --if-unanswered TEXT        What happens if nobody answers
  --steps JSON                MANUAL_STEP only: array of {text, command, link}
  --secret-spec JSON          SECRET only: {name, envVar | filePath}
  --options JSON              DECISION only: array of {label, description}
  --recommended-option N      DECISION only: index into options
  --expires-in SECONDS        Seconds after which the request expires if unanswered
  --client-request-id ID      Your own key: a retried call under the same key returns the request already filed
  --json                      Emit compact JSON
`

type ownerRequestRunnerRow struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	DisplayName string `json:"displayName"`
}

// resolveOwnerRequestRunner turns --runner into a runner id. A value that is a listed id stays as it is; a listed name
// becomes its id. When the runner list is not available to this session, the value is taken as an id and the server
// refuses an id that is not the owner's.
func resolveOwnerRequestRunner(value string) string {
	ctx, err := requireCLIOrchestrationContext("runner list")
	if err != nil {
		return value
	}
	t, err := cliSessionTransport(ctx)
	if err != nil {
		return value
	}
	raw, err := t.listRunners(ctx.sessionID, ctx.token)
	if err != nil {
		return value
	}
	return pickRunnerID(raw, value)
}

// pickRunnerID finds value among a runner list's ids and names. An id wins over a name, and a name that two runners
// share is left as typed, so the server's refusal names the problem instead of the wrong machine being changed.
func pickRunnerID(list json.RawMessage, value string) string {
	var rows []ownerRequestRunnerRow
	if json.Unmarshal(list, &rows) != nil {
		return value
	}
	found := ""
	for _, row := range rows {
		if row.ID == value {
			return value
		}
	}
	for _, row := range rows {
		if row.Name == value || (row.DisplayName != "" && row.DisplayName == value) {
			if found != "" && found != row.ID {
				return value
			}
			found = row.ID
		}
	}
	if found == "" {
		return value
	}
	return found
}

// ownerRequestCLIArgs is the request_owner_action argument map a command line stands for.
func ownerRequestCLIArgs(args []string, resolveRunner func(string) string) (map[string]interface{}, bool, error) {
	fs := newCLIFlagSet("orbit owner-request")
	kind := fs.String("kind", "", "what you need from the owner")
	title := fs.String("title", "", "the line the owner reads first")
	why := fs.String("why", "", "what this unblocks")
	runner := fs.String("runner", "", "CHANGE only: runner id or name")
	maxConcurrent := fs.Int("max-concurrent", 0, "CHANGE only: the Max Concurrent to propose")
	var blocks csvFlag
	fs.Var(&blocks, "blocks-task-id", "a task waiting on this request (repeatable)")
	ifUnanswered := fs.String("if-unanswered", "", "what happens if nobody answers")
	steps := fs.String("steps", "", "MANUAL_STEP only: JSON array")
	secretSpec := fs.String("secret-spec", "", "SECRET only: JSON object")
	options := fs.String("options", "", "DECISION only: JSON array")
	recommended := fs.Int("recommended-option", 0, "DECISION only: index into options")
	expiresIn := fs.Int("expires-in", 0, "seconds until the request expires")
	clientRequestID := fs.String("client-request-id", "", "your own key for this request")
	jsonOut := fs.Bool("json", false, "emit compact JSON")
	if err := fs.Parse(args); err != nil {
		return nil, false, err
	}
	if err := rejectTrailing(fs); err != nil {
		return nil, false, err
	}
	out := map[string]interface{}{"kind": *kind, "title": *title, "why": *why}
	if flagWasSet(fs, "runner") || flagWasSet(fs, "max-concurrent") {
		if strings.TrimSpace(*runner) == "" || !flagWasSet(fs, "max-concurrent") {
			return nil, false, fmt.Errorf("--runner and --max-concurrent go together")
		}
		out["change"] = map[string]interface{}{
			"runnerId":      resolveRunner(strings.TrimSpace(*runner)),
			"maxConcurrent": float64(*maxConcurrent),
		}
	}
	if len(blocks) > 0 {
		ids := make([]interface{}, 0, len(blocks))
		for _, id := range blocks {
			ids = append(ids, id)
		}
		out["blocksTaskIds"] = ids
	}
	if flagWasSet(fs, "if-unanswered") {
		out["ifUnanswered"] = *ifUnanswered
	}
	if flagWasSet(fs, "client-request-id") {
		out["clientRequestId"] = *clientRequestID
	}
	if flagWasSet(fs, "expires-in") {
		out["expiresIn"] = float64(*expiresIn)
	}
	if flagWasSet(fs, "recommended-option") {
		out["recommendedOption"] = float64(*recommended)
	}
	for _, j := range []struct{ flag, key, value string }{
		{"steps", "steps", *steps}, {"secret-spec", "secretSpec", *secretSpec}, {"options", "options", *options},
	} {
		if !flagWasSet(fs, j.flag) {
			continue
		}
		var v interface{}
		if err := json.Unmarshal([]byte(j.value), &v); err != nil {
			return nil, false, fmt.Errorf("--%s is not valid JSON: %w", j.flag, err)
		}
		out[j.key] = v
	}
	return out, *jsonOut, nil
}

func cmdOwnerRequestCLI(args []string, out io.Writer) error {
	if wantsHelp(args) {
		_, err := fmt.Fprint(out, ownerRequestHelp)
		return err
	}
	sessionID := strings.TrimSpace(os.Getenv("ORBIT_SESSION_ID"))
	if sessionID == "" {
		return fmt.Errorf("owner-request files as the session it runs in: run it inside an Orbit session")
	}
	callArgs, jsonOut, err := ownerRequestCLIArgs(args, resolveOwnerRequestRunner)
	if err != nil {
		return err
	}
	body, err := ownerRequestBody(callArgs, time.Now())
	if err != nil {
		return err
	}
	if spec, ok := body["secretSpec"]; ok {
		if err := checkSecretSpec(spec); err != nil {
			return fmt.Errorf("owner-request refused: %w", err)
		}
	}
	t, err := cliTransport()
	if err != nil {
		return err
	}
	raw, err := t.fileOwnerRequest(sessionID, body)
	if err != nil {
		return fmt.Errorf("owner-request: %w", err)
	}
	return writeCLIRawJSON(out, raw, jsonOut)
}
