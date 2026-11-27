package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// subagentUsageLimitMarkers are @orbit/shared USAGE_LIMIT_ERROR_MARKERS: the providers' own words for a spent
// quota. Keep them identical.
var subagentUsageLimitMarkers = []string{
	"hit your usage limit",
	"hit your session limit",
	"hit your 5-hour limit",
	"hit your weekly limit",
}

// subagentUsageLimitMaxOffset is USAGE_LIMIT_MARKER_MAX_OFFSET: a spent quota is the whole reply and opens it; a
// reply that quotes one further in is an ordinary answer.
const subagentUsageLimitMaxOffset = 40

// isUsageLimitText is isUsageLimitErrorText in @orbit/shared.
func isUsageLimitText(text string) bool {
	lower := strings.ToLower(strings.TrimLeft(text, " \t\r\n"))
	for _, marker := range subagentUsageLimitMarkers {
		if at := strings.Index(lower, marker); at >= 0 && at <= subagentUsageLimitMaxOffset {
			return true
		}
	}
	return false
}

// subagentLoginFailureOpenings are how a sign-in failure may open when the engine does not wrap it in
// "Failed to authenticate". Keep them identical to LOGIN_FAILURE_OPENINGS in @orbit/shared runFailureKind.ts.
var subagentLoginFailureOpenings = []string{"not logged in", "oauth session expired"}

// isSubagentLoginFailure is isLoginFailureText in @orbit/shared: the runtime's "Failed to authenticate"
// (isAuthError, which leaves out a dropped connection), or a text that opens as one of subagentLoginFailureOpenings.
func isSubagentLoginFailure(text string) bool {
	if isAuthError(text) {
		return true
	}
	lower := strings.ToLower(strings.TrimLeft(text, " \t\r\n"))
	for _, opening := range subagentLoginFailureOpenings {
		if strings.HasPrefix(lower, opening) {
			return true
		}
	}
	return false
}

// subagentLimitFailure is a child's end as §4.3 moves it, with the engine's own words for it: a spent quota or a
// failed login — which Claude Code reports as its whole reply with a "success" result — or a model at capacity
// (isCodexCapacityError), which only a failed end is read for. False for a run that ended any other way, whose
// end is its result. The server decides whether a move is made (not on an account's failure when the caller named
// the model) and holds the bound on moves (SUBAGENT_MAX_MOVES).
func subagentLimitFailure(res ExecResult, err error) (string, bool) {
	// What the child's adapter classified decides first (docs/routing-account-health-design.md §7.3): a spent
	// quota, a model at capacity, and an account that refused the run — its credential, an action it needs, or a
	// use it does not allow. Any other classified kind (a connection failure, a refused request) is the run's result.
	if res.Failure != nil {
		switch res.Failure.Kind {
		case failureUsageLimit, failureCapacity, failureCredentialRefused, failureAccountAction, failureAccessDenied:
			if text := strings.TrimSpace(firstNonEmpty(res.ErrorMsg, res.Result)); text != "" {
				return text, true
			}
			return strings.TrimSpace(res.Failure.Said), true
		default:
			return "", false
		}
	}
	var texts []string
	if err != nil {
		texts = append(texts, err.Error())
	}
	texts = append(texts, res.Result, res.ErrorMsg)
	for _, text := range texts {
		if isUsageLimitText(text) || isSubagentLoginFailure(text) {
			return strings.TrimSpace(text), true
		}
	}
	if err == nil && res.Status == stSucceeded {
		return "", false
	}
	for _, text := range texts {
		if isCodexCapacityError(text) {
			return strings.TrimSpace(text), true
		}
	}
	// An unclassified failure before the engine produced anything (§5.2) moves too: the account would not start it.
	// Not a dropped connection, which says nothing of the account; the server reads the words the same way.
	if res.Admission != nil && *res.Admission {
		for _, text := range texts {
			if isConnectionFailure(text) {
				return "", false
			}
		}
		if text := strings.TrimSpace(firstNonEmpty(res.ErrorMsg, res.Result, errorText(err))); text != "" {
			return text, true
		}
	}
	return "", false
}

// errorText is err's message, "" for none.
func errorText(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

// subagentFallbackResponse is the server's answer to the ask for the next candidate (SubagentFallbackResponse).
type subagentFallbackResponse struct {
	RunID   string          `json:"runId"`
	Attempt int             `json:"attempt"`
	Reason  string          `json:"reason"`
	Exec    AgentExecConfig `json:"exec"`
}

// nextSubagentCandidate asks the server where a run goes after its child failed on a limit: the next candidate of
// its tier, from the decision the run opened with. The error is the refusal's own sentence when the server has
// none to give (NO_SUBAGENT_PROVIDER, SUBAGENT_FALLBACK_SPENT, SUBAGENT_NOT_A_LIMIT_FAILURE).
func (s *bgJobService) nextSubagentCandidate(runID, failure string, child ExecResult, def subagentDefinition) (subagentFallbackResponse, error) {
	body := subagentFallbackBody(failure, child, def)
	var next subagentFallbackResponse
	err := s.t.do(nil, "POST", "/runner/sessions/"+s.sessionID+"/subagents/"+runID+"/fallback", body, &next, 30*time.Second)
	if err != nil {
		var refused *transportHTTPError
		if errors.As(err, &refused) && refused.code() != "" {
			return next, fmt.Errorf("%s: %s", refused.code(), refusalMessage(refused))
		}
		return next, err
	}
	if next.Exec.Provider == "" && next.Exec.Model == "" {
		return next, errors.New("the server named no candidate to move to")
	}
	return next, nil
}

// subagentFallbackBody is the ask for the next candidate: the child's failure in its words (error, which an older
// server reads), and what its adapter classified it as and its admission (§5.1), when it knows them.
func subagentFallbackBody(failure string, child ExecResult, def subagentDefinition) map[string]interface{} {
	body := map[string]interface{}{"error": failure, "readonly": def.Readonly}
	if !def.builtin() && def.PermissionMode != "" {
		body["permissionMode"] = def.PermissionMode
	}
	if child.Failure != nil {
		body["failure"] = child.Failure
	}
	if child.Admission != nil {
		body["admission"] = *child.Admission
	}
	return body
}

// refusalMessage is a refusal's own sentence, else its raw body.
func refusalMessage(e *transportHTTPError) string {
	var body struct {
		Message any `json:"message"`
	}
	if err := json.Unmarshal([]byte(e.body), &body); err == nil {
		if message, ok := body.Message.(string); ok && message != "" {
			return message
		}
	}
	return e.body
}

// subagentAttemptDir is where attempt n of a run keeps its engine's scratch and state: the run's own dir for the
// first, a dir of its own for each move, so a new engine never reads the state of the one that hit its limit.
func subagentAttemptDir(runDir string, attempt int) string {
	if attempt <= 1 {
		return runDir
	}
	return filepath.Join(runDir, "attempt-"+strconv.Itoa(attempt))
}
