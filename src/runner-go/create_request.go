package main

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
)

// project_create and session_create under a request id (docs/recovery-contract.md §6).
//
// Every create is named once, at the invocation: the id is drawn here, above any resend, and travels in
// X-Orbit-Request-Id. The control plane keeps a receipt under it (apiserver create-request-receipts.ts),
// so the same id sent again — concurrently, or after an answer that was lost — is answered with the
// Project or Session the first delivery created, and never creates a second one. A caller that never saw
// the answer passes the id back as requestId (MCP) or --request-id (CLI).
//
// Nothing here resends a create on its own. When the outcome is unknown — no answer, a body cut off after
// the status line, an uncoded 5xx — the call fails with a partial receipt instead: the request id, what is
// known of the outcome, and the one safe next step. Without an id the same failure would say only to
// look first (VERIFY_THEN_RETRY), and an unknown outcome is never resent automatically either way.

const requestIDHeader = "X-Orbit-Request-Id"

// createReceiptLabel heads the partial receipt a failed create prints below the failure.
const createReceiptLabel = "receipt:"

// requestIDPattern is the server's: 1 to 200 characters of letters, digits, '.', '_', ':' or '-'.
var requestIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$`)

// createRequestID is the id one create invocation is sent under: the caller's own when it gave one (a repeat
// of a request whose answer it never saw), otherwise a new one.
func createRequestID(given string) (string, error) {
	if id := strings.TrimSpace(given); id != "" {
		if !requestIDPattern.MatchString(id) {
			return "", &recoveryLocalError{code: "LOCAL_REQUEST_ID_INVALID",
				message: "requestId must be 1 to 200 characters of letters, digits, '.', '_', ':' or '-'"}
		}
		return id, nil
	}
	return newRunRequestToken()
}

// createRequestHeaders adds the request id to the headers a create already sends.
func createRequestHeaders(headers map[string]string, requestID string) map[string]string {
	if requestID == "" {
		return headers
	}
	out := make(map[string]string, len(headers)+1)
	for k, v := range headers {
		out[k] = v
	}
	out[requestIDHeader] = requestID
	return out
}

// createRequestFailure is the partial receipt a create that failed answers with.
type createRequestFailure struct {
	// NOT_CREATED when the server refused it and nothing was written, UNKNOWN when nobody can yet say.
	Outcome   string           `json:"outcome"`
	RequestID string           `json:"requestId"`
	Recovery  recoveryEnvelope `json:"recovery"`
	Next      string           `json:"next"`
}

// describeCreateFailure is what a failed create tells its caller. retry names how to send it again on this
// surface (the tool, or the CLI command), look how to check whether it exists.
func describeCreateFailure(what, retry, look, requestID string, err error) string {
	env := recoveryOf(err, requestID != "")
	failure := createRequestFailure{Outcome: "NOT_CREATED", RequestID: requestID, Recovery: env}
	switch {
	case env.Effect == "UNKNOWN":
		failure.Outcome = "UNKNOWN"
	case env.Effect == "COMMITTED":
		failure.Outcome = "CREATED"
	}
	switch env.Retry.Policy {
	case "SAME_REQUEST_ID":
		failure.Next = fmt.Sprintf("It is not known whether the %s was created. Send %s again with the same arguments and "+
			"requestId %q: that answers with the %s this request created, or creates it once. Never send it without that "+
			"requestId, which could create a second one.", what, retry, requestID, what)
	case "VERIFY_THEN_RETRY":
		failure.Next = fmt.Sprintf("It is not known whether the %s was created. Look for it first (%s), and create it again "+
			"under a new requestId only if it is not there.", what, look)
	case "SAFE":
		failure.Next = fmt.Sprintf("Nothing was created. Send %s again with requestId %q.", retry, requestID)
	default:
		failure.Next = "Nothing was created by this request; what refused it is above."
		if failure.Outcome == "UNKNOWN" {
			failure.Next = fmt.Sprintf("Look for the %s first (%s) before creating anything again.", what, look)
		}
	}
	receipt, _ := json.MarshalIndent(failure, "", "  ")
	return fmt.Sprintf("create %s failed: %s\n\n%s\n%s", what, err.Error(), createReceiptLabel, receipt)
}

// createRequestMerge is base with extra's headers laid over it; base itself is left as it was.
func createRequestMerge(base, extra map[string]string) map[string]string {
	if len(extra) == 0 {
		return base
	}
	out := make(map[string]string, len(base)+len(extra))
	for k, v := range base {
		out[k] = v
	}
	for k, v := range extra {
		out[k] = v
	}
	return out
}
