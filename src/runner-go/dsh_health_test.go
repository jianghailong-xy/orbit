package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
)

func TestDshHealthSeparatesCredentialCatalogueAndAuthentication(t *testing.T) {
	for _, credentials := range []bool{false, true} {
		for _, catalog := range []bool{false, true} {
			h := dshRuntimeHealth(dshSupportedVersion, credentials, catalog)
			if !h.VersionCompatible || h.CredentialPresent != credentials || h.ModelCatalogReadable != catalog || h.RequestValidation != "unknown" || h.SandboxEnforcement != "unknown" {
				t.Fatalf("installation, credential presence, catalogue and request statuses conflated: %#v", h)
			}
			report := EngineHealthReport{Engine: providerDsh, Installed: true, Auth: "unknown", Dsh: h}
			if report.signedIn() || report.signedOut() {
				t.Fatalf("ACP handshake or configured key became a local login: %#v", report)
			}
		}
	}
	if dshRuntimeHealth("0.0.1", true, true).VersionCompatible {
		t.Fatal("ACP plugin version became the installed CLI version")
	}
	if dshRuntimeHealth("0.2.0", true, true).VersionCompatible {
		t.Fatal("unsupported latest CLI version became compatible")
	}
}

func TestDshRequestValidationAndDiagnosticRedaction(t *testing.T) {
	opaqueKey := "arbitrary\nopaque credential!? value"
	for _, tc := range []struct {
		name       string
		message    string
		success    bool
		validation string
		diagnostic string
	}{
		{"missing-key", "-32603: no API key", false, "invalid", "DSH_CREDENTIAL_MISSING"},
		{"invalid-key", "-32603: invalid API key " + opaqueKey, false, "invalid", "DSH_CREDENTIAL_INVALID"},
		{"revoked-key", "-32603: API key has been revoked " + opaqueKey, false, "invalid", "DSH_CREDENTIAL_INVALID"},
		{"unauthorized", "HTTP 401 Unauthorized " + opaqueKey, false, "invalid", "DSH_CREDENTIAL_INVALID"},
		{"rate-limit", "-32603: status 429 " + opaqueKey, false, "unknown", "DSH_REQUEST_FAILED"},
		{"server-error", "-32603: status 500 " + opaqueKey, false, "unknown", "DSH_REQUEST_FAILED"},
		{"permission-forbidden", "HTTP 403 forbidden by file policy", false, "unknown", "DSH_REQUEST_FAILED"},
		{"protocol-internal-error", "-32603", false, "unknown", "DSH_REQUEST_FAILED"},
		{"success", "", true, "valid", ""},
		{"ambiguous-success-with-error", "-32603: status 500", true, "unknown", "DSH_REQUEST_FAILED"},
		{"incomplete-request", "", false, "unknown", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var err error
			if tc.message != "" {
				err = errors.New(tc.message)
			}
			validation, diagnostic := dshRequestValidation(err, tc.success, opaqueKey)
			if validation != tc.validation || diagnostic != tc.diagnostic {
				t.Fatalf("request classification = %q/%q, want %q/%q", validation, diagnostic, tc.validation, tc.diagnostic)
			}
			h := dshRuntimeHealth(dshSupportedVersion, true, true)
			h.RequestValidation, h.Diagnostic = validation, diagnostic
			serialized, _ := json.Marshal(EngineHealthReport{Engine: providerDsh, Installed: true, Auth: "unknown", Dsh: h})
			for _, output := range []string{diagnostic, string(serialized), fmt.Sprint(h)} {
				if strings.Contains(output, opaqueKey) || strings.Contains(output, "opaque credential") || strings.Contains(output, "status 500") {
					t.Fatalf("health/log/API output exposed upstream secrets or raw errors: %q", output)
				}
			}
		})
	}
}
