package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

// project_request_start, and its CLI twin `orbit project request-start`: a project's coordinator
// asks the account owner to start the project once its plan is ready.
//
// The server checks the plan first (apiserver `project-start-request.ts`) and answers a plan that is
// not ready with 409 START_REQUEST_NOT_READY carrying EVERY finding, so a coordinator fixes it in one
// pass. What is here is the half of that which belongs to the runner: the request body, checked for
// shape before a round trip, and the findings rendered one per line — the raw body says the same
// things buried in one line of JSON, and the whole point of returning them all at once is that the
// reader can act on each.

// maxProjectConcurrentTasks is the server's own bound (`MAX_PROJECT_CONCURRENT_TASKS`).
const maxProjectConcurrentTasks = 100

// startRequestFinding is one finding of the server's readiness check (@orbit/shared
// ProjectStartFinding).
type startRequestFinding struct {
	Severity       string `json:"severity"`
	Code           string `json:"code"`
	Message        string `json:"message"`
	RequiredAction string `json:"requiredAction"`
	Criterion      *struct {
		Key     string `json:"key"`
		Ordinal int    `json:"ordinal"`
		Text    string `json:"text"`
	} `json:"criterion"`
	Tasks []struct {
		TaskID string `json:"taskId"`
		Title  string `json:"title"`
	} `json:"tasks"`
}

// projectStartRequestBody is the request, from the tool's arguments: every setting the start card
// asks about, and why. Refused here for a shape the server would only refuse, so a typo costs no
// round trip; what the plan itself lacks is the server's to say.
func projectStartRequestBody(args map[string]interface{}) (map[string]interface{}, error) {
	line := strings.TrimSpace(getString(args, "line"))
	if line != "PROJECT_BRANCH" && line != "MAIN" {
		return nil, errors.New("line must be PROJECT_BRANCH (tasks land on the project's own branch " +
			"first) or MAIN (directly into main)")
	}
	automatic, ok := args["automatic"].(bool)
	if !ok {
		return nil, errors.New("automatic is required: true to have the coordinator run the project " +
			"for the owner, false to bring those decisions to them")
	}
	maxConcurrent, err := getBoundedOptionalNumber(args, "maxConcurrentTasks", maxProjectConcurrentTasks)
	if err != nil {
		return nil, err
	}
	if maxConcurrent == 0 {
		return nil, fmt.Errorf("maxConcurrentTasks is required: how many of its tasks may run at once, "+
			"1 to %d", maxProjectConcurrentTasks)
	}
	why := strings.TrimSpace(getString(args, "why"))
	if why == "" {
		return nil, errors.New("why is required: one sentence on why the plan is ready, shown to the " +
			"owner on the card")
	}
	body := map[string]interface{}{
		"line":               line,
		"automatic":          automatic,
		"maxConcurrentTasks": maxConcurrent,
		"why":                why,
	}
	if branch := strings.TrimSpace(getString(args, "projectBranchName")); branch != "" {
		if line == "MAIN" {
			return nil, errors.New("projectBranchName names a project branch, and a project that " +
				"lands directly into main has none")
		}
		body["projectBranchName"] = branch
	}
	if check := strings.TrimSpace(getString(args, "mergeCheckCommand")); check != "" {
		body["mergeCheckCommand"] = check
	}
	return body, nil
}

// formatStartFindings renders findings one per line: the code and what it found, what it is about,
// and what to do.
func formatStartFindings(findings []startRequestFinding) string {
	var b strings.Builder
	for _, finding := range findings {
		fmt.Fprintf(&b, "- %s: %s\n", finding.Code, finding.Message)
		if finding.Criterion != nil {
			fmt.Fprintf(&b, "  criterion %d (%s): %s\n",
				finding.Criterion.Ordinal, finding.Criterion.Key, finding.Criterion.Text)
		}
		for _, task := range finding.Tasks {
			fmt.Fprintf(&b, "  task %s: %s\n", task.TaskID, task.Title)
		}
		if finding.RequiredAction != "" {
			fmt.Fprintf(&b, "  do: %s\n", finding.RequiredAction)
		}
	}
	return b.String()
}

// splitStartFindings separates what refuses from what only warns, each in the server's order.
func splitStartFindings(findings []startRequestFinding) (refusals, warnings []startRequestFinding) {
	for _, finding := range findings {
		if finding.Severity == "REFUSE" {
			refusals = append(refusals, finding)
		} else {
			warnings = append(warnings, finding)
		}
	}
	return refusals, warnings
}

// projectStartRequestFiled says what a filed request means for the caller, then the request itself.
func projectStartRequestFiled(raw json.RawMessage) string {
	var filed struct {
		ItemID      string                `json:"itemId"`
		AlreadyOpen bool                  `json:"alreadyOpen"`
		Warnings    []startRequestFinding `json:"warnings"`
	}
	_ = json.Unmarshal(raw, &filed)
	var b strings.Builder
	if filed.AlreadyOpen {
		fmt.Fprintf(&b, "This request is already open (%s) — the same settings and reason, about the "+
			"same plan — so nothing new was filed.\n", filed.ItemID)
	} else {
		fmt.Fprintf(&b, "The start request is with the account owner (%s). They see a \"Start this "+
			"project?\" card with your settings as suggestions, may change any of them, and press Start; "+
			"nothing is waiting on this call.\n", filed.ItemID)
	}
	b.WriteString("You are told when the project starts (\"From Orbit · project started\"); until then " +
		"task_start is refused for its tasks. Changing the plan — its tasks, their dependencies or the " +
		"criteria — voids this request: ask again once the plan is ready again.\n")
	if len(filed.Warnings) > 0 {
		b.WriteString("The owner reads these beside it:\n")
		b.WriteString(formatStartFindings(filed.Warnings))
	}
	return b.String() + prettyJSON(raw)
}

// projectStartRequestRefusal renders a refusal: a plan that is not ready as the list of what to fix,
// and anything else as the transport says it.
func projectStartRequestRefusal(err error) string {
	var httpErr *transportHTTPError
	if !errors.As(err, &httpErr) || httpErr.code() != "START_REQUEST_NOT_READY" {
		return "request start failed: " + err.Error()
	}
	var body struct {
		Findings []startRequestFinding `json:"findings"`
	}
	if json.Unmarshal([]byte(httpErr.body), &body) != nil || len(body.Findings) == 0 {
		return "request start failed: " + err.Error()
	}
	refusals, warnings := splitStartFindings(body.Findings)
	var b strings.Builder
	b.WriteString("The plan is not ready to start, and nothing was filed (START_REQUEST_NOT_READY). " +
		"Fix each of these, then call project_request_start again:\n")
	b.WriteString(formatStartFindings(refusals))
	if len(warnings) > 0 {
		b.WriteString("And these would not refuse it, but the owner will read them beside it:\n")
		b.WriteString(formatStartFindings(warnings))
	}
	return strings.TrimRight(b.String(), "\n")
}
