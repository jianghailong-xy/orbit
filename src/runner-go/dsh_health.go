package main

import (
	"errors"
	"regexp"
	"strings"
	"sync/atomic"
)

// DshRuntimeHealth keeps local availability separate from an actual model request.
// ACP authenticate is a no-op and must never change RequestValidation.
type DshRuntimeHealth struct {
	VersionCompatible    bool   `json:"versionCompatible"`
	CredentialPresent    bool   `json:"credentialPresent"`
	ModelCatalogReadable bool   `json:"modelCatalogReadable"`
	RequestValidation    string `json:"requestValidation"`  // unknown | valid | invalid
	SandboxEnforcement   string `json:"sandboxEnforcement"` // unknown until separately probed
	Diagnostic           string `json:"diagnostic,omitempty"`
}

var dshCatalogRead atomic.Bool

func noteDshCatalogRead(readable bool) { dshCatalogRead.Store(readable) }
func dshCatalogReadable() bool         { return dshCatalogRead.Load() }

func dshRuntimeHealth(version string, credentialPresent, catalogReadable bool) *DshRuntimeHealth {
	return &DshRuntimeHealth{
		VersionCompatible:    version == dshSupportedVersion,
		CredentialPresent:    credentialPresent,
		ModelCatalogReadable: catalogReadable,
		RequestValidation:    "unknown",
		SandboxEnforcement:   "unknown",
	}
}

// dshCallError is a JSON-RPC error reply. Its text is the already-redacted diagnostic every
// caller saw before; upstreamStatus is the HTTP status the error data carried, 0 when none did.
type dshCallError struct {
	text           string
	upstreamStatus int
}

func (e *dshCallError) Error() string { return e.text }

// dshUpstreamStatus reads an HTTP status from ACP error data. dsh 0.2.0-rc.2 sends none for a
// failed turn (P0/P6: "Internal error: turn failed: <upstream message>", no data), so this only
// decides when a build does; the wording below covers the shape measured today.
func dshUpstreamStatus(data interface{}) int {
	object, ok := data.(map[string]interface{})
	if !ok {
		return 0
	}
	for _, key := range []string{"status", "statusCode", "status_code", "httpStatus"} {
		if code, ok := object[key].(float64); ok && code >= 100 && code < 600 && code == float64(int(code)) {
			return int(code)
		}
	}
	if nested, ok := object["error"]; ok {
		return dshUpstreamStatus(nested)
	}
	return 0
}

// The real DeepSeek 401 names the masked key between the words (P6: "Authentication Fails, Your
// api key: ****0000 is invalid"), so "api key is invalid" alone never matched it.
var dshKeyRejectedPattern = regexp.MustCompile(`api key(?:: *\S+)? is invalid`)

var dshKeyRejectedEvidence = []string{"invalid api key", "api key is invalid", "authentication_error", "authentication fails", "unauthorized", "status 401", "status code 401", "http 401", "revoked api key", "api key has been revoked", "invalid credentials"}

// dshRequestValidation is called only after a model request, never a handshake or
// a catalogue read. ACP's generic -32603 also covers rate limits and server errors;
// only explicit authentication evidence makes an unsuccessful request invalid. An upstream
// status in the error data decides before any wording: 401 is a rejected key, anything else is not.
func dshRequestValidation(resultErr error, requestSucceeded bool, _ string) (string, string) {
	if requestSucceeded && resultErr == nil {
		return "valid", ""
	}
	if resultErr == nil {
		return "unknown", ""
	}
	message := resultErr.Error()
	lower := strings.ToLower(message)
	if strings.HasPrefix(message, "DSH_REQUEST_FAILED") {
		return "unknown", "DSH_REQUEST_FAILED"
	}
	if strings.Contains(message, "DSH_CREDENTIAL_MISSING") {
		return "invalid", "DSH_CREDENTIAL_MISSING"
	}
	if strings.Contains(message, "DSH_CREDENTIAL_INVALID") {
		return "invalid", "DSH_CREDENTIAL_INVALID"
	}
	for _, evidence := range []string{"no api key", "missing api key"} {
		if strings.Contains(lower, evidence) {
			return "invalid", "DSH_CREDENTIAL_MISSING"
		}
	}
	var call *dshCallError
	if errors.As(resultErr, &call) && call.upstreamStatus != 0 {
		if call.upstreamStatus == 401 {
			return "invalid", "DSH_CREDENTIAL_INVALID"
		}
		return "unknown", "DSH_REQUEST_FAILED"
	}
	for _, evidence := range dshKeyRejectedEvidence {
		if strings.Contains(lower, evidence) {
			return "invalid", "DSH_CREDENTIAL_INVALID"
		}
	}
	if dshKeyRejectedPattern.MatchString(lower) {
		return "invalid", "DSH_CREDENTIAL_INVALID"
	}
	// Diagnostics travel in ordinary health/API output. Keep the exact upstream
	// message out of that output even when an opaque key is not known to this caller.
	return "unknown", "DSH_REQUEST_FAILED"
}

// dshTurnError is a failed turn's error as reported. A key problem, and any verdict an upstream
// status decided, leads with its code, so the clients' repair reads the runner's verdict rather
// than re-deriving it from wording the status already overruled.
func dshTurnError(err error) string {
	text := err.Error()
	_, code := dshRequestValidation(err, false, "")
	var call *dshCallError
	structured := errors.As(err, &call) && call.upstreamStatus != 0
	if (structured || code == "DSH_CREDENTIAL_INVALID" || code == "DSH_CREDENTIAL_MISSING") && code != "" && !strings.HasPrefix(text, code) {
		return code + ": " + text
	}
	return text
}
