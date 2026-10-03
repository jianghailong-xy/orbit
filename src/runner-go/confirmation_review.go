package main

import (
	"encoding/json"
	"fmt"
	"io"
	"strings"
)

// A confirmation request's reviewer answers it here (docs/owner-confirmation-review-contract.md §3.5,
// §8): the session an OWNER_CONFIRMED task's request was handed to for review records a structured
// review for the owner, or sends the request back to the task's run. Both doors take the whole input
// as one JSON object, exactly as the review block asks for it; the control plane reads it field by
// field and refuses an unknown key rather than dropping it. The task is the one the review block names
// — never ORBIT_TASK_ID, because the reviewer is not that task's run.

const confirmationReviewItemsNote = "Each line: text (1–300 characters), optionally criterionKey (the project " +
	"criterion it is about) and evidenceRefs (up to 10: a commit, a CI run URL, an Orbit id, a command and its result)."

func confirmationReviewItemSchema(extra map[string]interface{}, required ...string) map[string]interface{} {
	props := map[string]interface{}{
		"text":         map[string]interface{}{"type": "string", "minLength": 1, "maxLength": 300},
		"criterionKey": map[string]interface{}{"type": "string", "description": "The project criterion this line is about, as project_get returns its key."},
		"evidenceRefs": map[string]interface{}{"type": "array", "maxItems": 10, "items": map[string]interface{}{"type": "string", "maxLength": 500}},
	}
	for k, v := range extra {
		props[k] = v
	}
	return map[string]interface{}{
		"type":                 "object",
		"properties":           props,
		"required":             append([]string{"text"}, required...),
		"additionalProperties": false,
	}
}

func confirmationReviewTaskIDProp() map[string]interface{} {
	return map[string]interface{}{
		"type":        "string",
		"description": "The task under review: the task=\"…\" the review block names. Required — you are its reviewer, not its run, so it does not default to your own task.",
	}
}

func confirmationRequestIDProp() map[string]interface{} {
	return map[string]interface{}{
		"type":        "string",
		"description": "The request-id=\"…\" the review block names (a UUID).",
	}
}

func confirmationReviewedShaProp() map[string]interface{} {
	return map[string]interface{}{
		"type":        "string",
		"description": "The commit you reviewed, 40 lowercase hex — the block's sha=\"…\". Required when the block names one, and must be left out when it names none. A review of another commit is accepted and shown to the owner as outdated.",
	}
}

func confirmationReviewDescriptor(obj func(map[string]interface{}, ...string) map[string]interface{}) map[string]interface{} {
	list := func(description string, item map[string]interface{}, max int) map[string]interface{} {
		return map[string]interface{}{"type": "array", "maxItems": max, "items": item, "description": description}
	}
	return map[string]interface{}{
		"name": "task_confirmation_review",
		"description": "Record your review of an OWNER_CONFIRMED task's confirmation request — the one an " +
			"<orbit-confirmation-review> block handed you. The owner is not asked until you record it (or its " +
			"window runs out); once you do, their card shows it under REVIEW with your session's name, and Orbit " +
			"writes the card's first line from your lists: the first needsYou question, else how many lines you " +
			"could not check. Your judgment is shown last, quoted. Put each line in the list it belongs to — " +
			"checked, notChecked (with whyNotProven and what you checked instead), needsYou (only what the owner " +
			"alone can decide, each with 2–4 options and the one you recommend; the card preselects it) and " +
			"leftOpen — each with the evidence it rests on. You cannot confirm the task: only the owner can. " +
			"Call it from the turn the block was delivered in; a retry in that turn returns what you already " +
			"recorded. To send the work back to its run instead, use task_confirmation_return.",
		"inputSchema": obj(map[string]interface{}{
			"taskId":      confirmationReviewTaskIDProp(),
			"requestId":   confirmationRequestIDProp(),
			"reviewedSha": confirmationReviewedShaProp(),
			"judgment": map[string]interface{}{
				"type":        "string",
				"minLength":   1,
				"maxLength":   500,
				"description": "Your call, in a sentence or two. Shown last on the card, quoted; it never becomes the first line.",
			},
			"checked": list("What you checked and found to hold (at most 20). "+confirmationReviewItemsNote,
				confirmationReviewItemSchema(nil), 20),
			"notChecked": list("What you could not check (at most 20), each with whyNotProven and, in coordinatorChecked, what you checked instead. "+confirmationReviewItemsNote,
				confirmationReviewItemSchema(map[string]interface{}{
					"whyNotProven":       map[string]interface{}{"type": "string", "maxLength": 500},
					"coordinatorChecked": map[string]interface{}{"type": "string", "maxLength": 500},
				}), 20),
			"needsYou": list("What only the owner can decide (at most 10): a question with 2–4 options and recommendedOption, the index the card preselects. Leave it empty once the owner has already decided. "+confirmationReviewItemsNote,
				confirmationReviewItemSchema(map[string]interface{}{
					"options": map[string]interface{}{
						"type":     "array",
						"minItems": 2,
						"maxItems": 4,
						"items": map[string]interface{}{
							"type": "object",
							"properties": map[string]interface{}{
								"label":       map[string]interface{}{"type": "string", "minLength": 1, "maxLength": 200},
								"description": map[string]interface{}{"type": "string", "maxLength": 500},
							},
							"required":             []string{"label"},
							"additionalProperties": false,
						},
					},
					"recommendedOption": map[string]interface{}{"type": "integer", "minimum": 0},
				}, "options", "recommendedOption"), 10),
			"leftOpen": list("What is left open after this work (at most 20). "+confirmationReviewItemsNote,
				confirmationReviewItemSchema(nil), 20),
		}, "taskId", "requestId", "judgment"),
	}
}

func confirmationReturnDescriptor(obj func(map[string]interface{}, ...string) map[string]interface{}) map[string]interface{} {
	return map[string]interface{}{
		"name": "task_confirmation_return",
		"description": "Send an OWNER_CONFIRMED task's confirmation request back to its run, when something " +
			"must change before the owner looks. Your reason is delivered to the run as its next message, " +
			"signed by Orbit as from its reviewer, and the owner is not asked; the run declares the work " +
			"finished again when it is fixed. Once per request, and at most 3 times between two decisions of the " +
			"owner's — after that, record a review and leave the rest to the owner. Not while the project's " +
			"Automatic is off or its coordinator is paused, nor once the run has ended or the owner has sent it " +
			"back. If the owner has already confirmed the task, this records your problems under their receipt " +
			"and tells them, and the run is not messaged. Call it from the turn the review block was delivered in.",
		"inputSchema": obj(map[string]interface{}{
			"taskId":      confirmationReviewTaskIDProp(),
			"requestId":   confirmationRequestIDProp(),
			"reviewedSha": confirmationReviewedShaProp(),
			"reason": map[string]interface{}{
				"type":        "string",
				"minLength":   1,
				"maxLength":   4000,
				"description": "What must change, delivered to the run as its next message.",
			},
			"problems": map[string]interface{}{
				"type":        "array",
				"minItems":    1,
				"maxItems":    10,
				"items":       confirmationReviewItemSchema(nil),
				"description": "What is wrong (1–10 lines), each with its evidence. " + confirmationReviewItemsNote,
			},
		}, "taskId", "requestId", "reason", "problems"),
	}
}

// answerConfirmationReview is both tools' dispatch: the task in the path, everything else as the
// body, under the session that is calling — the reviewer is that session or nobody.
func (s *mcpServer) answerConfirmationReview(name string, args map[string]interface{}) map[string]interface{} {
	id := strings.TrimSpace(getString(args, "taskId"))
	if id == "" {
		return toolResult("taskId is required: name the task the review block is about (its task=\"…\")", true)
	}
	if strings.TrimSpace(s.sessionID) == "" {
		return toolResult(name+" requires an Orbit Session: a review is recorded by the session the request was handed to", true)
	}
	body := map[string]interface{}{}
	for key, value := range args {
		if key != "taskId" {
			body[key] = value
		}
	}
	var raw json.RawMessage
	var err error
	if name == "task_confirmation_review" {
		raw, err = s.t.reviewOwnerConfirmation(id, s.agentID, s.sessionID, body)
	} else {
		raw, err = s.t.returnOwnerConfirmation(id, s.agentID, s.sessionID, body)
	}
	if err != nil {
		return toolResult(strings.TrimPrefix(name, "task_")+" failed: "+err.Error(), true)
	}
	return toolResult(prettyJSON(raw), false)
}

const taskConfirmationReviewHelp = `orbit task confirmation-review — record your review of a confirmation request

Usage:
  orbit task confirmation-review [task-id] (--input JSON | --input-file -) [--json]

The input is one JSON object, the same one task_confirmation_review takes:
  {"taskId", "requestId", "reviewedSha", "judgment", "checked": [...], "notChecked": [...],
   "needsYou": [...], "leftOpen": [...]}
Each line is {"text", "criterionKey"?, "evidenceRefs"?}; a notChecked line may add "whyNotProven" and
"coordinatorChecked", and a needsYou line needs "options" (2–4 of {"label", "description"?}) and
"recommendedOption". taskId and requestId are the ones the <orbit-confirmation-review> block names;
task-id given here takes the place of the input's taskId. --input-file accepts only '-' (stdin).

Requires ORBIT_SESSION_ID: only the session the request was handed to may review it, from inside a
turn. Recording it lets the owner's card ask them; you cannot confirm the task yourself.
`

const taskConfirmationReturnHelp = `orbit task confirmation-return — send a confirmation request back to its run

Usage:
  orbit task confirmation-return [task-id] (--input JSON | --input-file -) [--json]

The input is one JSON object, the same one task_confirmation_return takes:
  {"taskId", "requestId", "reviewedSha", "reason", "problems": [{"text", "criterionKey"?, "evidenceRefs"?}, ...]}
The reason is delivered to the run as its next message and the owner is not asked. Once per request,
and at most 3 times between two decisions of the owner's. If the owner has already confirmed the task,
the problems are recorded under their receipt and they are told instead. --input-file accepts only '-'.

Requires ORBIT_SESSION_ID: only the session the request was handed to for review may return it.
`

// cliTaskConfirmationAnswer is both commands: the input object read whole, the task taken from the
// argument or the input, and the call made under ORBIT_SESSION_ID.
func cliTaskConfirmationAnswer(action string, args []string, in io.Reader, out io.Writer) error {
	id, rest := peelLeadingID(args)
	fs := newCLIFlagSet("orbit task " + action)
	inputText := fs.String("input", "", "the whole input as one JSON object")
	inputFile := fs.String("input-file", "", "read the input JSON from stdin (-)")
	jsonOut := fs.Bool("json", false, "emit compact JSON")
	if err := fs.Parse(rest); err != nil {
		return err
	}
	if (id != "" && fs.NArg() > 0) || fs.NArg() > 1 {
		return fmt.Errorf("unexpected arguments: %s", strings.Join(fs.Args(), " "))
	}
	if id == "" && fs.NArg() == 1 {
		id = fs.Arg(0)
	}
	rawInput, inputSet, err := readCLIText(in, *inputText, flagWasSet(fs, "input"), *inputFile, flagWasSet(fs, "input-file"), "input")
	if err != nil {
		return err
	}
	if !inputSet || strings.TrimSpace(rawInput) == "" {
		return fmt.Errorf("--input or --input-file - is required")
	}
	var input map[string]interface{}
	if err := json.Unmarshal([]byte(rawInput), &input); err != nil || input == nil {
		if err == nil {
			err = fmt.Errorf("root is not an object")
		}
		return fmt.Errorf("the input must be one JSON object: %w", err)
	}
	if named, ok := input["taskId"].(string); ok && strings.TrimSpace(named) != "" {
		if id != "" && id != strings.TrimSpace(named) {
			return fmt.Errorf("task-id %q and the input's taskId %q name different tasks", id, named)
		}
		id = strings.TrimSpace(named)
	}
	if id == "" {
		return fmt.Errorf("the task is required: give task-id or the input's taskId (the review block's task=\"…\")")
	}
	delete(input, "taskId")
	agentID, sessionID := cliTaskAttribution()
	if sessionID == "" {
		return fmt.Errorf("ORBIT_SESSION_ID is required: a review is recorded by the session the request was handed to")
	}
	t, err := cliTransport()
	if err != nil {
		return err
	}
	var raw json.RawMessage
	if action == "confirmation-review" {
		raw, err = t.reviewOwnerConfirmation(id, agentID, sessionID, input)
	} else {
		raw, err = t.returnOwnerConfirmation(id, agentID, sessionID, input)
	}
	if err != nil {
		return fmt.Errorf("%s: %w", action, err)
	}
	return writeCLIRawJSON(out, raw, *jsonOut)
}
