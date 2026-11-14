package main

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
)

// A DAG restructure, asked for the one way both surfaces ask.
//
// The batch of dependency edits can release a column of work into the dispatcher at once, which is
// why its MCP tool puts it on the owner's card before writing any of it. The CLI door did not: it
// applied on `--apply` because "at a terminal the human is already the one deciding" — true of a
// person typing, false of an agent that reaches the same binary through its shell, which is the
// caller that exists. This file is the shared path: both doors preview, both raise the same card,
// both apply only on the same answer. A process with no session sends the apply with no card, and
// the server refuses it (TASK_WRITE_NEEDS_OWNER_CARD, task-write-approval.ts): the machine
// credential has no card-free form of this write, exactly as the creates have none.

// dagChangeWithApproval previews a restructure, puts it in front of the owner and, once allowed,
// applies it. `ops` and `note` are what the caller asked for; the preview is the server's answer,
// which both the card and the person read.
//
// A decision that is not a yes is returned in `declined` rather than as an error: a person saying
// no is an answer to the question, and its shape is `declinedCardRefusal`. Anything that went wrong
// — the door, the preview, applying after a yes — is an `err`, because those are not answers.
//
// No session means no card (`declined` is always nil): there is no conversation to put a question
// in, so the apply goes to the server as it is, which refuses it on the machine credential.
func dagChangeWithApproval(
	t *Transport, sessionID, listID string, ops []interface{}, note string,
) (applied json.RawMessage, declined *ApprovalDecisionResponse, err error) {
	body := map[string]interface{}{"ops": ops}
	if strings.TrimSpace(note) != "" {
		body["note"] = note
	}
	if strings.TrimSpace(sessionID) == "" {
		applied, err = t.dagApply(listID, body, "")
		return applied, nil, err
	}
	preview, err := t.dagPreview(listID, body)
	if err != nil {
		return nil, nil, fmt.Errorf("dag preview failed: %w", err)
	}
	// A batch that cannot be applied is not a decision to put in front of a human — it is a mistake
	// to hand straight back, with the cycle named so it can be fixed in one more turn.
	var p struct {
		Cycle []struct {
			Title string `json:"title"`
		} `json:"cycle"`
		EffectiveCount int `json:"effectiveCount"`
		NoopCount      int `json:"noopCount"`
	}
	if err := json.Unmarshal(preview, &p); err == nil {
		if len(p.Cycle) > 0 {
			titles := make([]string, 0, len(p.Cycle))
			for _, c := range p.Cycle {
				titles = append(titles, c.Title)
			}
			return nil, nil, fmt.Errorf("rejected: these changes would create a cycle: %s", strings.Join(titles, " -> "))
		}
		if p.EffectiveCount == 0 {
			return nil, nil, fmt.Errorf("nothing to do: every proposed edge is already in the state you asked for (%s no-op(s)). Re-read the graph with task_dependency_graph before proposing again.", strconv.Itoa(p.NoopCount))
		}
	}
	input := map[string]interface{}{"listId": listID, "ops": ops, "preview": json.RawMessage(preview)}
	if strings.TrimSpace(note) != "" {
		input["note"] = note
	}
	id, err := t.createApproval(context.Background(), sessionID, map[string]interface{}{
		"toolName": dagApprovalToolName,
		"input":    input,
	})
	if err != nil {
		return nil, nil, fmt.Errorf("could not register approval: %w", err)
	}
	// Unbounded, exactly like permissionPrompt: this asks a human who may be asleep, and a
	// deadline here would turn "not answered yet" into a silent abandonment of the restructure.
	dec, err := awaitApprovalDecision(context.Background(), t, sessionID, id)
	if err != nil {
		return nil, nil, fmt.Errorf("approval poll failed: %w", err)
	}
	if dec.Status != "ALLOWED" {
		return nil, dec, nil
	}
	applied, err = t.dagApply(listID, body, strings.TrimSpace(sessionID))
	if err != nil {
		// Approved but unapplicable: the graph moved while the card was open. Say so plainly — the
		// alternative is an agent that believes it restructured the list.
		return nil, nil, fmt.Errorf("approved, but applying failed: %w", err)
	}
	return applied, nil, nil
}
