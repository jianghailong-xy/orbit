package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net"
	"net/url"
	"regexp"
	"strconv"
	"strings"
)

// The recovery contract (docs/recovery-contract.md, contracts/recovery.contract.json): one envelope
// that says, for any failed or advised call, what happened to the write and what the caller may do
// next. This is the Go reading of it, held to the same vectors as the TypeScript one in
// src/shared/src/recovery.ts (contracts/recovery.fixtures.json, recovery_test.go).
//
// The branch is decided by stable fields only: the code, the status, the server's `recovery`
// block, `retryable`, `advisory`/`kind`, `owner` and the retry hints. `message` and a prose
// `requiredAction` are carried through for people and never read. And the server names a semantic
// actionCode, never an MCP tool or a CLI command: which one carries it out is this client's mapping.

const recoveryContractVersion = 1

type recoveryResource struct {
	Type string `json:"type"`
	ID   string `json:"id"`
}

type recoveryRetry struct {
	Policy       string `json:"policy"`
	AfterSeconds *int   `json:"afterSeconds"`
}

type recoveryEnvelope struct {
	ContractVersion  int                `json:"contractVersion"`
	Code             string             `json:"code"`
	Message          string             `json:"message"`
	Kind             string             `json:"kind"`
	Status           *int               `json:"status"`
	Effect           string             `json:"effect"`
	Retry            recoveryRetry      `json:"retry"`
	Actor            string             `json:"actor"`
	Owner            *string            `json:"owner"`
	ActionCode       *string            `json:"actionCode"`
	RequiredAction   *string            `json:"requiredAction"`
	UserConfirmation string             `json:"userConfirmation"`
	Resources        []recoveryResource `json:"resources"`
}

// recoveryObservation is one failure as this client met it, before it is read. Source is HTTP,
// NETWORK (no answer arrived), LOCAL (refused here before sending) or UNKNOWN.
type recoveryObservation struct {
	Source        string             `json:"source"`
	Status        int                `json:"status"`
	Headers       map[string]string  `json:"headers"`
	Body          string             `json:"body"`
	RequestIDSent bool               `json:"requestIdSent"`
	Code          string             `json:"code"`
	Message       string             `json:"message"`
	Resources     []recoveryResource `json:"resources"`
}

var (
	recoveryKinds             = []string{"REFUSAL", "ADVISORY", "VALIDATION", "TRANSPORT", "UNKNOWN"}
	recoveryEffects           = []string{"NONE", "COMMITTED", "UNKNOWN"}
	recoveryRetryPolicies     = []string{"SAFE", "SAME_REQUEST_ID", "VERIFY_THEN_RETRY", "AFTER_STATE_CHANGE", "NEVER"}
	recoveryActors            = []string{"CALLER", "COORDINATOR", "USER", "SYSTEM"}
	recoveryUserConfirmations = []string{"REQUIRED", "NOT_REQUIRED"}
	recoveryActionCodePattern = regexp.MustCompile(`^[A-Z][A-Z0-9_]*$`)
	recoveryActionCodes       = []string{
		"RETRY", "RETRY_SAME_REQUEST", "VERIFY_STATE", "FIX_REQUEST", "USE_NEW_REQUEST_ID",
		"ANSWER_ADVICE", "AWAIT_OWNER_DECISION", "FILE_IN_OWN_PROJECT_OR_REQUEST_HANDOFF",
	}
	// "" stands for no default action.
	recoveryDefaultActionByPolicy = map[string]string{
		"SAFE": "RETRY", "SAME_REQUEST_ID": "RETRY_SAME_REQUEST", "VERIFY_THEN_RETRY": "VERIFY_STATE",
		"AFTER_STATE_CHANGE": "", "NEVER": "FIX_REQUEST",
	}
	recoveryLegacyOwnerToActor  = map[string]string{"USER": "USER", "COORDINATOR": "COORDINATOR", "SYSTEM": "SYSTEM"}
	recoveryLegacyResourceKeys  = [][2]string{{"taskId", "TASK"}, {"sessionId", "SESSION"}, {"projectId", "PROJECT"}, {"crossingId", "CROSSING"}, {"triggerId", "REQUEST"}}
	recoveryStatusSafe          = []int{408, 429}
	recoveryStatusAfterStateChg = []int{401, 403, 409, 412, 423, 424, 428}
)

// recoveryLegacyCode is what a code served before the `recovery` block existed stands for.
type recoveryLegacyCode struct {
	RetryPolicy      string `json:"retryPolicy"`
	Effect           string `json:"effect"`
	ActionCode       string `json:"actionCode,omitempty"`
	Actor            string `json:"actor,omitempty"`
	UserConfirmation string `json:"userConfirmation,omitempty"`
}

var recoveryLegacyCodes = map[string]recoveryLegacyCode{
	taskRunRequestInProgress:      {RetryPolicy: "SAME_REQUEST_ID", Effect: "NONE"},
	"TASK_RUN_REQUEST_UNREADABLE": {RetryPolicy: "SAME_REQUEST_ID", Effect: "NONE"},
	"TASK_RUN_REQUEST_MISMATCH":   {RetryPolicy: "NEVER", Effect: "NONE", ActionCode: "USE_NEW_REQUEST_ID"},
	"TRANSIENT_DB_CONFLICT":       {RetryPolicy: "SAFE", Effect: "NONE"},
	"DATABASE_UNAVAILABLE":        {RetryPolicy: "SAFE", Effect: "NONE"},
	crossProjectApprovalRequired: {RetryPolicy: "AFTER_STATE_CHANGE", Effect: "NONE", ActionCode: "AWAIT_OWNER_DECISION",
		Actor: "USER", UserConfirmation: "REQUIRED"},
	crossProjectApprovalPending: {RetryPolicy: "AFTER_STATE_CHANGE", Effect: "NONE", ActionCode: "AWAIT_OWNER_DECISION",
		Actor: "USER", UserConfirmation: "REQUIRED"},
	"TASK_CRITERION_SHAPE_ADVICE": {RetryPolicy: "NEVER", Effect: "NONE", ActionCode: "ANSWER_ADVICE"},
}

func recoveryOneOf(values []string, v interface{}) string {
	s, _ := v.(string)
	for _, value := range values {
		if s == value {
			return s
		}
	}
	return ""
}

func recoveryContainsInt(values []int, v int) bool {
	for _, value := range values {
		if value == v {
			return true
		}
	}
	return false
}

func recoveryNonEmpty(v interface{}) string {
	s, _ := v.(string)
	return s
}

func recoverySeconds(v interface{}) *int {
	f, ok := v.(float64)
	if !ok || f < 0 || math.IsInf(f, 0) || math.IsNaN(f) {
		return nil
	}
	n := int(math.Ceil(f))
	return &n
}

func recoveryMillisToSeconds(v interface{}) *int {
	f, ok := v.(float64)
	if !ok || f < 0 || math.IsInf(f, 0) || math.IsNaN(f) {
		return nil
	}
	n := int(math.Ceil(f / 1000))
	return &n
}

func recoveryHeaderDigits(headers map[string]string, name string) *int {
	for k, v := range headers {
		if !strings.EqualFold(k, name) || v == "" || strings.Trim(v, "0123456789") != "" {
			continue
		}
		n, err := strconv.Atoi(v)
		if err != nil {
			return nil
		}
		return &n
	}
	return nil
}

func recoveryActionCodeOf(v interface{}) string {
	s, _ := v.(string)
	if recoveryActionCodePattern.MatchString(s) {
		return s
	}
	return ""
}

func recoveryValidResources(v interface{}) ([]recoveryResource, bool) {
	list, ok := v.([]interface{})
	if !ok {
		return nil, false
	}
	out := []recoveryResource{}
	for _, item := range list {
		r, ok := item.(map[string]interface{})
		if !ok || recoveryNonEmpty(r["type"]) == "" || recoveryNonEmpty(r["id"]) == "" {
			return nil, false
		}
		out = append(out, recoveryResource{Type: r["type"].(string), ID: r["id"].(string)})
	}
	return out, true
}

func optionalString(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func newRecoveryEnvelope(code, message, kind, effect, policy string) recoveryEnvelope {
	return recoveryEnvelope{
		ContractVersion:  recoveryContractVersion,
		Code:             code,
		Message:          message,
		Kind:             kind,
		Effect:           effect,
		Retry:            recoveryRetry{Policy: policy},
		Actor:            "CALLER",
		UserConfirmation: "NOT_REQUIRED",
		Resources:        []recoveryResource{},
	}
}

// The actions that send the same request again: only a write known not to have happened may lead to one.
var recoveryResendActionCodes = []string{"RETRY", "RETRY_SAME_REQUEST"}

// The resource type that names a request id the server can read an earlier answer back by.
const recoveryRequestIDResourceType = "REQUEST"

// recoveryCandidate is what the parser resolved from the fields, before the cross-field invariants.
type recoveryCandidate struct {
	effect           string
	policy           string
	actionCode       string // the stated action; "" when none was stated
	afterSeconds     *int
	userConfirmation string
	hasRequestID     bool // a request id provably exists: one was sent, or the answer names one
	success          bool // a 2xx answer, never given a default action
}

func recoveryIsResend(action string) bool {
	for _, a := range recoveryResendActionCodes {
		if a == action {
			return true
		}
	}
	return false
}

// normalizeRecovery applies the contract's cross-field invariants (contracts/recovery.contract.json
// `invariants`), the same steps in the same order as src/shared/src/recovery.ts normalizeRecovery: no
// combination of fields, stated or inferred, may advise a resend that could apply a write twice.
func normalizeRecovery(c recoveryCandidate) (policy, action string, afterSeconds *int) {
	policy, action = c.policy, c.actionCode
	switch {
	case c.effect == "COMMITTED":
		policy = "NEVER"
	case c.effect == "UNKNOWN":
		if policy != "SAME_REQUEST_ID" || !c.hasRequestID {
			policy = "VERIFY_THEN_RETRY"
		}
	case policy == "SAME_REQUEST_ID" && !c.hasRequestID:
		policy = "VERIFY_THEN_RETRY"
	}
	confirm := c.userConfirmation == "REQUIRED"
	if confirm && (policy == "SAFE" || policy == "SAME_REQUEST_ID") {
		if c.effect == "UNKNOWN" {
			policy = "VERIFY_THEN_RETRY"
		} else {
			policy = "AFTER_STATE_CHANGE"
		}
	}
	if c.effect == "UNKNOWN" {
		action = recoveryDefaultActionByPolicy[policy]
	} else {
		if action != "" && recoveryIsResend(action) {
			if confirm {
				action = "AWAIT_OWNER_DECISION"
			} else if action != recoveryDefaultActionByPolicy[policy] {
				action = ""
			}
		}
		if action == "" && c.effect != "COMMITTED" && !c.success {
			action = recoveryDefaultActionByPolicy[policy]
			if action == "" && confirm {
				action = "AWAIT_OWNER_DECISION"
			}
		}
	}
	if policy != "NEVER" {
		afterSeconds = c.afterSeconds
	}
	return policy, action, afterSeconds
}

// finishRecovery holds env to the invariants: its effect, userConfirmation and resources are final, its
// Retry.Policy is the resolved one, and statedAction/afterSeconds are what the fields said.
func finishRecovery(env *recoveryEnvelope, statedAction string, afterSeconds *int, requestIDSent, success bool) {
	hasRequestID := requestIDSent
	for _, r := range env.Resources {
		if r.Type == recoveryRequestIDResourceType {
			hasRequestID = true
		}
	}
	policy, action, after := normalizeRecovery(recoveryCandidate{
		effect: env.Effect, policy: env.Retry.Policy, actionCode: statedAction, afterSeconds: afterSeconds,
		userConfirmation: env.UserConfirmation, hasRequestID: hasRequestID, success: success,
	})
	env.Retry = recoveryRetry{Policy: policy, AfterSeconds: after}
	env.ActionCode = optionalString(action)
}

// parseRecovery reads one failure into the envelope. It answers false only for a successful HTTP
// answer with no `recovery` block, which is a result rather than something to recover from.
func parseRecovery(obs recoveryObservation) (recoveryEnvelope, bool) {
	switch obs.Source {
	case "LOCAL":
		code := obs.Code
		if !strings.HasPrefix(code, "LOCAL_") {
			code = "LOCAL_" + code
		}
		env := newRecoveryEnvelope(code, obs.Message, "VALIDATION", "NONE", "NEVER")
		if obs.Resources != nil {
			env.Resources = obs.Resources
		}
		finishRecovery(&env, "", nil, false, false)
		return env, true
	case "NETWORK", "UNKNOWN":
		policy := "VERIFY_THEN_RETRY"
		if obs.RequestIDSent {
			policy = "SAME_REQUEST_ID"
		}
		env := newRecoveryEnvelope("UNKNOWN_ERROR", obs.Message, "UNKNOWN", "UNKNOWN", policy)
		if obs.Source == "NETWORK" {
			env = newRecoveryEnvelope("TRANSPORT_NO_ANSWER", obs.Message, "TRANSPORT", "UNKNOWN", policy)
		}
		finishRecovery(&env, "", nil, obs.RequestIDSent, false)
		return env, true
	}
	return parseHTTPRecovery(obs)
}

func parseHTTPRecovery(obs recoveryObservation) (recoveryEnvelope, bool) {
	status := obs.Status
	var body map[string]interface{}
	if json.Unmarshal([]byte(obs.Body), &body) != nil {
		body = nil
	}
	success := status >= 200 && status < 300
	stated, hasStated := body["recovery"].(map[string]interface{})
	if success && !hasStated {
		return recoveryEnvelope{}, false
	}

	serverCode := recoveryNonEmpty(body["code"])
	code := serverCode
	if code == "" {
		code = "HTTP_" + strconv.Itoa(status)
	}
	message := "HTTP " + strconv.Itoa(status)
	switch m := body["message"].(type) {
	case string:
		if m != "" {
			message = m
		}
	case []interface{}:
		parts := make([]string, 0, len(m))
		for _, p := range m {
			s, ok := p.(string)
			if !ok {
				parts = nil
				break
			}
			parts = append(parts, s)
		}
		if len(parts) > 0 {
			message = strings.Join(parts, "; ")
		}
	}
	advisory := body["advisory"] == true || body["kind"] == "ADVISORY"
	kind := "TRANSPORT"
	switch {
	case advisory || success:
		kind = "ADVISORY"
	case serverCode != "":
		kind = "REFUSAL"
	case body != nil && (status == 400 || status == 422):
		kind = "VALIDATION"
	}

	legacy, hasLegacy := recoveryLegacyCodes[serverCode]
	retryable, statedRetryable := body["retryable"].(bool)

	policy := recoveryOneOf(recoveryRetryPolicies, stated["retryPolicy"])
	if policy == "" && hasLegacy {
		policy = legacy.RetryPolicy
	}
	if policy == "" {
		switch {
		case success:
			policy = "NEVER"
		case statedRetryable && retryable:
			policy = "SAFE"
		case advisory:
			policy = "NEVER"
		case recoveryContainsInt(recoveryStatusSafe, status):
			policy = "SAFE"
		case recoveryContainsInt(recoveryStatusAfterStateChg, status):
			policy = "AFTER_STATE_CHANGE"
		case status >= 400 && status < 500:
			policy = "NEVER"
		case status >= 500 && statedRetryable && !retryable:
			policy = "NEVER"
		case obs.RequestIDSent:
			policy = "SAME_REQUEST_ID"
		default:
			policy = "VERIFY_THEN_RETRY"
		}
	}

	effect := recoveryOneOf(recoveryEffects, stated["effect"])
	if effect == "" && hasLegacy {
		effect = legacy.Effect
	}
	if effect == "" {
		switch {
		case success:
			effect = "COMMITTED"
		case (statedRetryable && retryable) || status < 500:
			effect = "NONE"
		default:
			effect = "UNKNOWN"
		}
	}

	env := newRecoveryEnvelope(code, message, kind, effect, policy)
	env.Status = &status
	var afterSeconds *int
	for _, candidate := range []*int{
		recoverySeconds(stated["retryAfterSeconds"]),
		recoverySeconds(body["retryAfterSeconds"]),
		recoveryMillisToSeconds(body["retryAfterMs"]),
	} {
		if candidate != nil {
			afterSeconds = candidate
			break
		}
	}
	if afterSeconds == nil {
		if ms := recoveryHeaderDigits(obs.Headers, "Retry-After-Ms"); ms != nil {
			afterSeconds = recoveryMillisToSeconds(float64(*ms))
		} else {
			afterSeconds = recoveryHeaderDigits(obs.Headers, "Retry-After")
		}
	}

	owner := recoveryNonEmpty(body["owner"])
	requiredAction := recoveryNonEmpty(body["requiredAction"])
	env.Owner = optionalString(owner)
	env.RequiredAction = optionalString(requiredAction)

	switch {
	case recoveryOneOf(recoveryActors, stated["actor"]) != "":
		env.Actor = stated["actor"].(string)
	case hasLegacy && legacy.Actor != "":
		env.Actor = legacy.Actor
	case recoveryLegacyOwnerToActor[owner] != "":
		env.Actor = recoveryLegacyOwnerToActor[owner]
	}

	action := recoveryActionCodeOf(stated["actionCode"])
	if action == "" && hasLegacy {
		action = legacy.ActionCode
	}
	if action == "" {
		action = recoveryActionCodeOf(requiredAction)
	}

	if c := recoveryOneOf(recoveryUserConfirmations, stated["userConfirmation"]); c != "" {
		env.UserConfirmation = c
	} else if hasLegacy && legacy.UserConfirmation != "" {
		env.UserConfirmation = legacy.UserConfirmation
	}

	if resources, ok := recoveryValidResources(stated["resources"]); ok {
		env.Resources = resources
	} else {
		for _, pair := range recoveryLegacyResourceKeys {
			if id := recoveryNonEmpty(body[pair[0]]); id != "" {
				env.Resources = append(env.Resources, recoveryResource{Type: pair[1], ID: id})
			}
		}
	}
	finishRecovery(&env, action, afterSeconds, obs.RequestIDSent, success)
	return env, true
}

// recoveryLocalError is a refusal made here, before anything was sent: its code is the envelope's
// (LOCAL_ is added when missing), its message what a person reads.
type recoveryLocalError struct {
	code    string
	message string
}

func (e *recoveryLocalError) Error() string { return e.message }

// recoveryOf reads any error a call returned into the envelope. requestIDSent says whether the
// request carried an id that makes resending it read the first answer back.
func recoveryOf(err error, requestIDSent bool) recoveryEnvelope {
	var httpErr *transportHTTPError
	if errors.As(err, &httpErr) {
		headers := map[string]string{}
		if httpErr.retryAfter != "" {
			headers["Retry-After"] = httpErr.retryAfter
		}
		env, ok := parseRecovery(recoveryObservation{Source: "HTTP", Status: httpErr.statusCode, Headers: headers,
			Body: httpErr.body, RequestIDSent: requestIDSent})
		if ok {
			return env
		}
	}
	var local *recoveryLocalError
	if errors.As(err, &local) {
		env, _ := parseRecovery(recoveryObservation{Source: "LOCAL", Code: local.code, Message: local.message})
		return env
	}
	var netErr net.Error
	var urlErr *url.Error
	if errors.As(err, &netErr) || errors.As(err, &urlErr) || errors.Is(err, context.DeadlineExceeded) ||
		errors.Is(err, io.ErrUnexpectedEOF) || errors.Is(err, io.EOF) {
		env, _ := parseRecovery(recoveryObservation{Source: "NETWORK", Message: err.Error(), RequestIDSent: requestIDSent})
		return env
	}
	message := ""
	if err != nil {
		message = err.Error()
	}
	env, _ := parseRecovery(recoveryObservation{Source: "UNKNOWN", Message: message, RequestIDSent: requestIDSent})
	return env
}
