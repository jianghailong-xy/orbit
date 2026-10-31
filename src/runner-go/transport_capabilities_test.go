package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"runtime"
	"strings"
	"testing"
)

func TestTransportAdvertisesSupportedProviders(t *testing.T) {
	seen := map[string]bool{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capabilities := "," + r.Header.Get(runnerCapabilitiesHeader) + ","
		for _, capability := range []string{
			sessionClaudeCoordinatorContextV1,
			sessionCodexCoordinatorContextV1,
		} {
			if !strings.Contains(capabilities, ","+capability+",") {
				t.Errorf("runner capability header %q omits %q", capabilities, capability)
			}
		}
		if got := r.Header.Get("X-Orbit-Supported-Providers"); got != runnerSupportedProviders {
			t.Errorf("provider capability header = %q, want %q", got, runnerSupportedProviders)
		}
		if got := r.Header.Get("X-Orbit-Runner-Os"); got != runtime.GOOS {
			t.Errorf("runner OS header = %q, want %q", got, runtime.GOOS)
		}
		if got := r.Header.Get(runnerWriteCapabilityRevisionHeader); got != "2" {
			t.Errorf("runner capability revision = %q, want 2", got)
		}
		if got := r.Header.Get(runnerWriteSchemaRevisionHeader); got != "2" {
			t.Errorf("runner schema revision = %q, want 2", got)
		}
		if got := r.Header.Get(runnerWriteContractDigestHeader); got != runnerWriteContractDigest {
			t.Errorf("runner contract digest = %q", got)
		}
		seen[r.URL.Path] = true
		w.Header().Set("content-type", "application/json")
		if r.URL.Path == "/api/runner/sessions/reclaim" {
			_, _ = w.Write([]byte(`{"sessions":[]}`))
			return
		}
		_, _ = w.Write([]byte(`null`))
	}))
	defer server.Close()

	if _, err := NewTransport(server.URL, "runner-token").claimSession(context.Background(), nil); err != nil {
		t.Fatal(err)
	}
	if _, err := NewTransport(server.URL, "runner-token").reclaim(context.Background()); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"/api/runner/sessions/claim", "/api/runner/sessions/reclaim"} {
		if !seen[path] {
			t.Errorf("request %s was not observed", path)
		}
	}
}

// The directory probe and Orbit-made folders are declared as the shared contract spells them
// (@orbit/shared DIR_PROBE_CAPABILITY, CREATE_WORKDIR_CAPABILITY): on every HTTPS call, and in the
// runner link's Hello, which lists the same header. A client asks only a runner that declares
// dir-probe/v1, and POST /sessions makes a new folder only on one that declares create-workdir/v1.
func TestTransportDeclaresDirProbeAndCreateWorkDir(t *testing.T) {
	dto, err := os.ReadFile("../shared/src/dto.ts")
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct{ name, token string }{
		{"DIR_PROBE_CAPABILITY", dirProbeCapabilityV1},
		{"CREATE_WORKDIR_CAPABILITY", createWorkDirCapabilityV1},
	} {
		if want := "export const " + c.name + " = '" + c.token + "';"; !strings.Contains(string(dto), want) {
			t.Errorf("@orbit/shared does not say %s", want)
		}
	}

	var header string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		header = r.Header.Get(runnerCapabilitiesHeader)
		_, _ = w.Write([]byte(`{"ok":true,"applied":true}`))
	}))
	defer server.Close()
	if err := NewTransport(server.URL, "runner-token").dirProbeResult(RunnerDirProbeResult{Path: "~"}); err != nil {
		t.Fatal(err)
	}
	hello := strings.Join(linkHello("process-a").GetCapabilities(), ",")
	for _, token := range []string{dirProbeCapabilityV1, createWorkDirCapabilityV1} {
		if !strings.Contains(","+header+",", ","+token+",") {
			t.Errorf("the capability header %q omits %s", header, token)
		}
		if !strings.Contains(","+hello+",", ","+token+",") {
			t.Errorf("the link Hello's capabilities %q omit %s", hello, token)
		}
	}
}
