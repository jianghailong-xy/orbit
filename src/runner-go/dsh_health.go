package main

import (
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

// dshRequestValidation is called only after a model request, never a handshake or
// a catalogue read. ACP's generic -32603 also covers rate limits and server errors;
// only explicit authentication evidence makes an unsuccessful request invalid.
func dshRequestValidation(resultErr error, requestSucceeded bool, _ string) (string, string) {
	if requestSucceeded && resultErr == nil {
		return "valid", ""
	}
	if resultErr == nil {
		return "unknown", ""
	}
	message := resultErr.Error()
	lower := strings.ToLower(message)
	for _, evidence := range []string{"no api key", "missing api key"} {
		if strings.Contains(lower, evidence) {
			return "invalid", "DSH_CREDENTIAL_MISSING"
		}
	}
	for _, evidence := range []string{"invalid api key", "api key is invalid", "authentication_error", "unauthorized", "status 401", "status code 401", "http 401", "revoked api key", "api key has been revoked", "invalid credentials"} {
		if strings.Contains(lower, evidence) {
			return "invalid", "DSH_CREDENTIAL_INVALID"
		}
	}
	// Diagnostics travel in ordinary health/API output. Keep the exact upstream
	// message out of that output even when an opaque key is not known to this caller.
	return "unknown", "DSH_REQUEST_FAILED"
}
