package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"
	"unicode/utf8"
)

const maxSubagentRatingNoteChars = 500

const subagentRateDescription = "Rate a SubAgent run this session started, once you have used its result. " +
	"Score 1 = you discarded it or had to redo the work yourself, 2 = mostly redone, 3 = usable after fixes, " +
	"4 = minor fixes, 5 = used as-is. The note is an optional short reason. " +
	"Rating the same run again replaces its rating. Only the session that started the run can rate it, " +
	"and the run must have ended. Rating is optional and nothing waits on it. " +
	"The owner sees the ratings beside each model in Settings › Providers › Model tiers. " +
	"Ratings are for display only and never affect model routing."

const subagentRateUsage = "orbit subagent rate RUN_ID --score N [--note TEXT] [--json]"

const subagentHelp = `orbit subagent — rate a SubAgent run this session started

Usage:
  ` + subagentRateUsage + `

Run 'orbit subagent rate --help' for options.
`

var subagentActionHelp = map[string]string{
	"rate": `orbit subagent rate — rate how useful a SubAgent's result was

Usage:
  ` + subagentRateUsage + `

Options:
  RUN_ID        The runId returned by delegate. Required.
  --score N     An integer from 1 to 5. Required.
  --note TEXT   A short reason for the score, up to 500 characters.
  --json        Emit compact JSON.

` + subagentRateDescription + `
The command acts as the session it runs in (ORBIT_SESSION_ID).
`,
}

var subagentCLICapabilities = []cliCapabilitySpec{
	{
		Tool:        "subagent_rate",
		Argv:        []string{"orbit", "subagent", "rate"},
		Usage:       subagentRateUsage,
		Arguments:   []string{"[run-id] (required; RUN_ID returned by delegate)", "--score <n> (required; integer 1–5)", "--note <text>", "--json"},
		Mutates:     true,
		SessionOnly: true,
	},
}

func cmdSubagentCLI(args []string, out io.Writer) error {
	if len(args) == 0 || args[0] == "--help" || args[0] == "-h" || (args[0] == "help" && len(args) == 1) {
		_, err := fmt.Fprint(out, subagentHelp)
		return err
	}
	if args[0] == "help" {
		help, ok := subagentActionHelp[args[1]]
		if !ok {
			return fmt.Errorf("unknown command %q", args[1])
		}
		_, err := fmt.Fprint(out, help)
		return err
	}
	if args[0] != "rate" {
		return fmt.Errorf("unknown command %q", args[0])
	}
	if wantsHelp(args[1:]) {
		_, err := fmt.Fprint(out, subagentActionHelp["rate"])
		return err
	}
	fs := newCLIFlagSet("orbit subagent rate")
	score := fs.Int("score", 0, "an integer from 1 to 5")
	note := fs.String("note", "", "a short reason for the score")
	jsonOut := fs.Bool("json", false, "emit compact JSON")
	runID, flags := peelLeadingID(args[1:])
	if err := fs.Parse(flags); err != nil {
		return err
	}
	if runID == "" || fs.NArg() != 0 {
		return fmt.Errorf("orbit subagent rate takes one run id. Usage: %s", subagentRateUsage)
	}

	sessionID := strings.TrimSpace(os.Getenv("ORBIT_SESSION_ID"))
	if _, err := userModeGate("subagent rate"); err != nil {
		return err
	}
	t, err := cliTransport()
	if err != nil {
		return err
	}
	argsMap := map[string]interface{}{"runId": runID, "score": *score}
	if flagWasSet(fs, "note") {
		argsMap["note"] = *note
	}
	raw, err := runSubagentRate(t, sessionID, argsMap)
	if err != nil {
		return err
	}
	return writeCLIRawJSON(out, raw, *jsonOut)
}

func runSubagentRate(t *Transport, sessionID string, args map[string]interface{}) (json.RawMessage, error) {
	if os.Getenv(envSubagentRunID) != "" {
		return nil, fmt.Errorf("a SubAgent cannot rate a SubAgent run")
	}
	if sessionID == "" {
		return nil, fmt.Errorf("rating requires the calling session (ORBIT_SESSION_ID)")
	}
	score, ok := schemaNumber(args["score"])
	if !ok || score < 1 || score > 5 || score != float64(int(score)) {
		return nil, fmt.Errorf("score must be an integer from 1 to 5")
	}
	body := map[string]interface{}{"score": int(score)}
	if value, present := args["note"]; present {
		note, ok := value.(string)
		if !ok || utf8.RuneCountInString(note) > maxSubagentRatingNoteChars {
			return nil, fmt.Errorf("note must be a string of at most %d characters", maxSubagentRatingNoteChars)
		}
		body["note"] = note
	}
	return t.rateSubagentRun(sessionID, getString(args, "runId"), body)
}
