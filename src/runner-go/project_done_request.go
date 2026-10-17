package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

// project_request_done, and its CLI twin `orbit project request-done`: a project's coordinator asks
// the account owner to record the project done, with its call and every gap Orbit cannot prove.
//
// The server checks the project first (apiserver `project-done-request.ts`) and answers one that is
// not ready with 409 DONE_REQUEST_NOT_READY carrying EVERY finding, so a coordinator fixes it in one
// pass. What is here is the half of that which belongs to the runner, as for project_request_start:
// the request body, checked for shape before a round trip, and the findings rendered one per line.

// doneRequestFinding is one finding of the server's check (@orbit/shared ProjectDoneFinding).
type doneRequestFinding struct {
	Severity       string `json:"severity"`
	Code           string `json:"code"`
	Message        string `json:"message"`
	RequiredAction string `json:"requiredAction"`
	Criterion      *struct {
		Key     string `json:"key"`
		Ordinal int    `json:"ordinal"`
		Text    string `json:"text"`
	} `json:"criterion"`
	Reason string `json:"reason"`
	Tasks  []struct {
		TaskID string `json:"taskId"`
		Title  string `json:"title"`
	} `json:"tasks"`
	Items []struct {
		ItemID string `json:"itemId"`
		Kind   string `json:"kind"`
		Title  string `json:"title"`
	} `json:"items"`
	Jobs []struct {
		IntegrationJobID string `json:"integrationJobId"`
		Kind             string `json:"kind"`
		State            string `json:"state"`
		TaskID           string `json:"taskId"`
	} `json:"jobs"`
}

// doneGapFields are the parts of a gap the owner decides on, and what each is for.
var doneGapFields = []struct{ name, purpose string }{
	{"criterionKey", "the key of the criterion it is about, as project_get gives it"},
	{"whyNotProven", "why Orbit cannot prove this criterion by itself"},
	{"coordinatorChecked", "what you checked instead"},
}

// projectDoneRequestBody is the request, from the tool's arguments: the coordinator's call and every
// gap. Refused here for a shape the server would only refuse, so a typo costs no round trip; whether
// the project is ready is the server's to say.
func projectDoneRequestBody(args map[string]interface{}) (map[string]interface{}, error) {
	judgment := strings.TrimSpace(getString(args, "judgment"))
	if judgment == "" {
		return nil, errors.New("judgment is required: your call on whether the project is done, in a " +
			"sentence or two — the first thing the owner reads on the card")
	}
	raw, present := args["gaps"]
	if !present || raw == nil {
		return nil, errors.New("gaps is required: one entry for each thing Orbit cannot prove — [] " +
			"when it can prove them all")
	}
	list, ok := raw.([]interface{})
	if !ok {
		return nil, errors.New("gaps must be an array of {criterionKey, title, whyNotProven, " +
			"coordinatorChecked, evidenceRefs}")
	}
	gaps := make([]interface{}, 0, len(list))
	for i, item := range list {
		given, ok := item.(map[string]interface{})
		if !ok {
			return nil, fmt.Errorf("gaps[%d] must be an object {criterionKey, title, whyNotProven, "+
				"coordinatorChecked, evidenceRefs}", i)
		}
		gap := map[string]interface{}{}
		for _, field := range doneGapFields {
			value := strings.TrimSpace(getString(given, field.name))
			if value == "" {
				return nil, fmt.Errorf("gaps[%d].%s is required: %s", i, field.name, field.purpose)
			}
			gap[field.name] = value
		}
		if title := strings.TrimSpace(getString(given, "title")); title != "" {
			gap["title"] = title
		}
		refs, ok := doneGapEvidenceRefs(given["evidenceRefs"])
		if !ok {
			return nil, fmt.Errorf("gaps[%d].evidenceRefs is required: where that evidence is — "+
				"task ids, comment links, commits, URLs — as an array of strings", i)
		}
		gap["evidenceRefs"] = refs
		gaps = append(gaps, gap)
	}
	return map[string]interface{}{"judgment": judgment, "gaps": gaps}, nil
}

// doneGapEvidenceRefs reads a gap's evidence references: at least one, each a non-blank string. A
// lone string is read as one reference, the way a model sometimes sends an array of one.
func doneGapEvidenceRefs(raw interface{}) ([]string, bool) {
	var items []interface{}
	switch value := raw.(type) {
	case string:
		items = []interface{}{value}
	case []interface{}:
		items = value
	case []string:
		for _, ref := range value {
			items = append(items, ref)
		}
	default:
		return nil, false
	}
	refs := make([]string, 0, len(items))
	for _, item := range items {
		ref, ok := item.(string)
		if !ok || strings.TrimSpace(ref) == "" {
			return nil, false
		}
		refs = append(refs, strings.TrimSpace(ref))
	}
	return refs, len(refs) > 0
}

// formatDoneFindings renders findings one per line: the code and what it found, what it is about,
// and what to do.
func formatDoneFindings(findings []doneRequestFinding) string {
	var b strings.Builder
	for _, finding := range findings {
		fmt.Fprintf(&b, "- %s: %s\n", finding.Code, finding.Message)
		if finding.Criterion != nil {
			fmt.Fprintf(&b, "  criterion %d (%s): %s\n",
				finding.Criterion.Ordinal, finding.Criterion.Key, finding.Criterion.Text)
		}
		if finding.Reason != "" {
			fmt.Fprintf(&b, "  reason: %s\n", finding.Reason)
		}
		for _, task := range finding.Tasks {
			fmt.Fprintf(&b, "  task %s: %s\n", task.TaskID, task.Title)
		}
		for _, item := range finding.Items {
			fmt.Fprintf(&b, "  item %s (%s): %s\n", item.ItemID, item.Kind, item.Title)
		}
		for _, job := range finding.Jobs {
			fmt.Fprintf(&b, "  job %s: %s %s", job.IntegrationJobID, job.Kind, job.State)
			if job.TaskID != "" {
				fmt.Fprintf(&b, " (task %s)", job.TaskID)
			}
			b.WriteString("\n")
		}
		if finding.RequiredAction != "" {
			fmt.Fprintf(&b, "  do: %s\n", finding.RequiredAction)
		}
	}
	return b.String()
}

// splitDoneFindings separates what refuses from what only warns, each in the server's order.
func splitDoneFindings(findings []doneRequestFinding) (refusals, warnings []doneRequestFinding) {
	for _, finding := range findings {
		if finding.Severity == "REFUSE" {
			refusals = append(refusals, finding)
		} else {
			warnings = append(warnings, finding)
		}
	}
	return refusals, warnings
}

// projectDoneRequestFiled says what a filed request means for the caller, then the request itself.
func projectDoneRequestFiled(raw json.RawMessage) string {
	var filed struct {
		ItemID      string               `json:"itemId"`
		AlreadyOpen bool                 `json:"alreadyOpen"`
		Warnings    []doneRequestFinding `json:"warnings"`
	}
	_ = json.Unmarshal(raw, &filed)
	var b strings.Builder
	if filed.AlreadyOpen {
		fmt.Fprintf(&b, "This request is already open (%s) — the same call and gaps, about the same "+
			"project — so nothing new was filed.\n", filed.ItemID)
	} else {
		fmt.Fprintf(&b, "The request is with the account owner (%s). They see an \"Is this project "+
			"done?\" card with your call and the gaps you named, and record the project done on it; "+
			"nothing is waiting on this call.\n", filed.ItemID)
	}
	b.WriteString("The project moving before they answer — its criteria, a task, a run or a landing — " +
		"voids this request: ask again once it has settled.\n")
	if len(filed.Warnings) > 0 {
		b.WriteString("The owner reads these beside it:\n")
		b.WriteString(formatDoneFindings(filed.Warnings))
	}
	return b.String() + prettyJSON(raw)
}

// projectDoneRequestRefusal renders a refusal: a project that is not ready as the list of what to
// fix, and anything else as the transport says it.
func projectDoneRequestRefusal(err error) string {
	var httpErr *transportHTTPError
	if !errors.As(err, &httpErr) || httpErr.code() != "DONE_REQUEST_NOT_READY" {
		return "request done failed: " + err.Error()
	}
	var body struct {
		Findings []doneRequestFinding `json:"findings"`
	}
	if json.Unmarshal([]byte(httpErr.body), &body) != nil || len(body.Findings) == 0 {
		return "request done failed: " + err.Error()
	}
	refusals, warnings := splitDoneFindings(body.Findings)
	var b strings.Builder
	b.WriteString("The project is not ready to be recorded done, and nothing was filed " +
		"(DONE_REQUEST_NOT_READY). Fix each of these, then call project_request_done again:\n")
	b.WriteString(formatDoneFindings(refusals))
	if len(warnings) > 0 {
		b.WriteString("And these would not refuse it, but the owner will read them beside it:\n")
		b.WriteString(formatDoneFindings(warnings))
	}
	return strings.TrimRight(b.String(), "\n")
}
