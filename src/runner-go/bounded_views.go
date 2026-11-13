package main

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"unicode/utf8"
)

// The bounded views of task_list, task_evidence_list and session_get. Every result an agent reads
// stays in its context and is sent again on every later turn, so the default answer of these three
// reads is held under one budget; the full record is one argument away (summary=false). On
// 2026-11-12 a coordinator taking over a 63-task project spent its first turn on a 184,025-character
// task_list (refused), an 81,579-character evidence ledger and a 42,200-character session_get.
//
// The budget is in bytes, which bounds characters too: a character is never fewer than one byte.
const toolResultBudget = 20000

const (
	defaultTaskSummaryLimit = 50
	evidenceSummaryPageSize = 10
	summaryTitleLimit       = 160
	evidenceTextLimit       = 400
	sessionFieldFloor       = 1000
	changedFilesShown       = 50
)

// clipText keeps at most limit characters of s, saying how much was dropped.
func clipText(s string, limit int) string {
	if utf8.RuneCountInString(s) <= limit {
		return s
	}
	runes := []rune(s)
	return string(runes[:limit]) + fmt.Sprintf("… [%d of %d characters]", limit, len(runes))
}

// taskSummaryRow is one task_list row in summary form: where the task is and what it is, never
// what it says. task_get answers the rest.
func taskSummaryRow(row map[string]interface{}) map[string]interface{} {
	out := map[string]interface{}{}
	for _, key := range []string{"id", "title", "status", "projectId", "parentTaskId", "assigneeId", "listId", "labels", "priority", "updatedAt"} {
		v, ok := row[key]
		if !ok || v == nil {
			continue
		}
		if s, isString := v.(string); isString {
			if s == "" {
				continue
			}
			if key == "title" {
				v = clipText(s, summaryTitleLimit)
			}
		}
		if list, isList := v.([]interface{}); isList && len(list) == 0 {
			continue
		}
		if n, isNumber := v.(float64); isNumber && key == "priority" && n == 0 {
			continue
		}
		out[key] = v
	}
	return out
}

// renderTaskSummaryPage is one page of task_list in summary form: a header saying how to go on,
// then one compact JSON object per task.
func renderTaskSummaryPage(items json.RawMessage, nextCursor string) (string, error) {
	var rows []map[string]interface{}
	if err := json.Unmarshal(items, &rows); err != nil {
		return "", fmt.Errorf("task page is not a list of tasks: %w", err)
	}
	var b strings.Builder
	more := "This is the last page."
	if nextCursor != "" {
		more = fmt.Sprintf("More: call task_list again with the same filters and cursor=%q.", nextCursor)
	}
	fmt.Fprintf(&b, "%d task(s), one summary row each (task_get returns one task in full; summary=false returns full rows). %s\n", len(rows), more)
	for _, row := range rows {
		line, err := json.Marshal(taskSummaryRow(row))
		if err != nil {
			return "", err
		}
		b.Write(line)
		b.WriteByte('\n')
	}
	return b.String(), nil
}

// boundedTaskSummary fetches and renders the largest page, from limit down, that fits the budget.
// A smaller page is fetched again rather than cut, so the cursor it names continues exactly where
// the rows shown end.
func boundedTaskSummary(fetch func(limit int) (json.RawMessage, string, error), limit int) (string, error) {
	for {
		items, next, err := fetch(limit)
		if err != nil {
			return "", err
		}
		text, err := renderTaskSummaryPage(items, next)
		if err != nil {
			return "", err
		}
		if len(text) <= toolResultBudget || limit == 1 {
			return text, nil
		}
		limit /= 2
	}
}

// evidenceSummary is one evidence revision in summary form: what was claimed and what came of it.
func evidenceSummary(rev map[string]interface{}) map[string]interface{} {
	out := map[string]interface{}{}
	for _, key := range []string{"revision", "submittedAt", "sourceSessionId"} {
		if v, ok := rev[key]; ok && v != nil {
			out[key] = v
		}
	}
	if evidence, ok := rev["evidence"].(map[string]interface{}); ok {
		if claim, ok := evidence["claim"].(string); ok {
			out["claim"] = clipText(claim, evidenceTextLimit)
		}
		if checks, ok := evidence["checks"].([]interface{}); ok {
			out["checks"] = len(checks)
		}
		if gaps, ok := evidence["gaps"].([]interface{}); ok {
			out["gaps"] = len(gaps)
		}
	}
	if decision, ok := rev["decision"].(map[string]interface{}); ok && decision != nil {
		d := map[string]interface{}{}
		for _, key := range []string{"decision", "decidedAt", "decidedByType"} {
			if v, ok := decision[key]; ok && v != nil {
				d[key] = v
			}
		}
		if note, ok := decision["note"].(string); ok && note != "" {
			d["note"] = clipText(note, evidenceTextLimit)
		}
		out["decision"] = d
	} else {
		out["decision"] = nil
	}
	return out
}

func revisionNumber(rev map[string]interface{}) string {
	switch v := rev["revision"].(type) {
	case string:
		return v
	case float64:
		return fmt.Sprintf("%d", int64(v))
	}
	return ""
}

// renderEvidenceView answers task_evidence_list from the whole ledger: one revision in full when
// revision is named, otherwise the newest page (before the revision `before` names, when set) in
// summary form. Revisions stay in task-local order, oldest first.
func renderEvidenceView(raw json.RawMessage, revision, before string) (string, error) {
	var revs []map[string]interface{}
	if err := json.Unmarshal(raw, &revs); err != nil {
		return "", fmt.Errorf("evidence ledger is not a list of revisions: %w", err)
	}
	if revision != "" {
		for _, rev := range revs {
			if revisionNumber(rev) == revision {
				one, err := json.Marshal(rev)
				if err != nil {
					return "", err
				}
				return prettyJSON(one), nil
			}
		}
		return "", fmt.Errorf("this task has no evidence revision %s", revision)
	}
	end := len(revs)
	if before != "" {
		end = -1
		for i, rev := range revs {
			if revisionNumber(rev) == before {
				end = i
				break
			}
		}
		if end < 0 {
			return "", fmt.Errorf("this task has no evidence revision %s", before)
		}
	}
	for size := evidenceSummaryPageSize; ; size /= 2 {
		start := end - size
		if start < 0 {
			start = 0
		}
		text, err := renderEvidencePage(revs, start, end)
		if err != nil {
			return "", err
		}
		if len(text) <= toolResultBudget || size <= 1 {
			return text, nil
		}
	}
}

func renderEvidencePage(revs []map[string]interface{}, start, end int) (string, error) {
	page := make([]map[string]interface{}, 0, end-start)
	for _, rev := range revs[start:end] {
		page = append(page, evidenceSummary(rev))
	}
	body, err := json.Marshal(page)
	if err != nil {
		return "", err
	}
	var b strings.Builder
	if len(page) == 0 {
		fmt.Fprintf(&b, "No evidence revisions to show (%d in the ledger).\n", len(revs))
	} else {
		fmt.Fprintf(&b, "Revisions %s–%s of %d, in summary form, oldest first. One revision in full: revision=<n>. The whole ledger: summary=false.",
			revisionNumber(revs[start]), revisionNumber(revs[end-1]), len(revs))
		if start > 0 {
			fmt.Fprintf(&b, " Older: before=%q.", revisionNumber(revs[start]))
		}
		b.WriteByte('\n')
	}
	b.WriteString(prettyJSON(body))
	return b.String(), nil
}

// The session fields a bounded session_get gives up, in order: the ones the caller rarely came
// for first. lastAssistantText and result — what collecting a sub-task's work reads — go last, and
// only when the record cannot fit with them whole.
var sessionClipOrder = []string{"prompt", "changedFiles", "lastToolUse", "lastUserText", "error", "lastAssistantText", "result"}

// boundSessionRecord answers session_get in bounded form: the record as it is when it fits, and
// otherwise with its largest free-text fields cut down, in sessionClipOrder, until it does. What
// was cut is named in `truncatedFields` with its original size.
func boundSessionRecord(raw json.RawMessage) (string, error) {
	text := prettyJSON(raw)
	if len(text) <= toolResultBudget {
		return text, nil
	}
	var record map[string]interface{}
	if err := json.Unmarshal(raw, &record); err != nil {
		return text, nil // not an object: nothing to cut by field
	}
	truncated := map[string]interface{}{}
	render := func() (string, error) {
		if len(truncated) > 0 {
			record["truncatedFields"] = truncated
		}
		body, err := json.Marshal(record)
		if err != nil {
			return "", err
		}
		out := prettyJSON(body)
		if len(truncated) > 0 {
			names := make([]string, 0, len(truncated))
			for name := range truncated {
				names = append(names, name)
			}
			sort.Strings(names)
			out = fmt.Sprintf("Shortened to fit: %s (sizes in truncatedFields). The full record: session_get with summary=false.\n%s",
				strings.Join(names, ", "), out)
		}
		return out, nil
	}
	for _, field := range sessionClipOrder {
		over := len(text) - toolResultBudget
		if over <= 0 {
			break
		}
		switch v := record[field].(type) {
		case string:
			n := utf8.RuneCountInString(v)
			// Cut by what is over plus room for the notes, never below a readable floor.
			keep := n - over - 400
			if keep < sessionFieldFloor {
				keep = sessionFieldFloor
			}
			if keep >= n {
				continue
			}
			record[field] = clipText(v, keep)
			truncated[field] = map[string]interface{}{"characters": n}
		case []interface{}:
			if len(v) <= changedFilesShown {
				continue
			}
			record[field] = v[:changedFilesShown]
			truncated[field] = map[string]interface{}{"entries": len(v)}
		default:
			continue
		}
		var err error
		if text, err = render(); err != nil {
			return "", err
		}
	}
	return text, nil
}
