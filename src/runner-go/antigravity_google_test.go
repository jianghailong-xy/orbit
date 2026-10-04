package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type googleProbeRecording struct {
	Stdout   string `json:"stdout"`
	Stderr   string `json:"stderr"`
	ExitCode int    `json:"exit_code"`
}

func loadGoogleProbeRecording(t *testing.T, name string) googleProbeRecording {
	t.Helper()
	body, err := os.ReadFile(filepath.Join("..", "..", "docs", "evidence", "antigravity-cli-1.2.16", name))
	if err != nil {
		t.Fatal(err)
	}
	var recording googleProbeRecording
	if err := json.Unmarshal(body, &recording); err != nil {
		t.Fatal(err)
	}
	return recording
}

func TestAntigravityGoogleUsageRecordings(t *testing.T) {
	for _, name := range []string{"google-auth-print-usage.json", "google-auth-usage-after-concurrency.json"} {
		t.Run(name, func(t *testing.T) {
			recording := loadGoogleProbeRecording(t, name)
			result := parseAntigravityGoogleProbe([]byte(recording.Stdout), recording.Stderr, recording.ExitCode)
			if result.auth != authYes || result.usage == nil || result.usage.Provider != providerAntigravity {
				t.Fatalf("successful usage recording did not authenticate: %+v", result)
			}
			if len(result.usage.Buckets) != 4 {
				t.Fatalf("want four buckets, without duplicating command_result and result: %+v", result.usage.Buckets)
			}
			wantIDs := []string{"gemini-weekly", "gemini-5h", "3p-weekly", "3p-5h"}
			for i, bucket := range result.usage.Buckets {
				if bucket.ID != wantIDs[i] || bucket.RemainingFraction <= 0 || bucket.RemainingFraction > 1 || bucket.ResetTime == "" {
					t.Fatalf("bucket %d lost a recorded quota field: %+v", i, bucket)
				}
				wantWindow := "weekly"
				if i%2 == 1 {
					wantWindow = "5h"
				}
				if bucket.Window != wantWindow {
					t.Fatalf("bucket %s window = %q, want %q", bucket.ID, bucket.Window, wantWindow)
				}
			}
			if name == "google-auth-print-usage.json" && result.usage.Buckets[0].RemainingFraction != 0.9999245405197144 {
				t.Fatalf("remaining fraction was rounded or turned into utilization: %v", result.usage.Buckets[0].RemainingFraction)
			}
		})
	}
}

func TestAntigravityGoogleAuthThreeStates(t *testing.T) {
	for _, name := range []string{"google-auth-invalid-refresh.json", "google-auth-post-logout.json", "google-auth-held-stream.json"} {
		t.Run(name, func(t *testing.T) {
			recording := loadGoogleProbeRecording(t, name)
			result := parseAntigravityGoogleProbe([]byte(recording.Stdout), recording.Stderr, recording.ExitCode)
			if result.auth != authNo || result.usage != nil {
				t.Fatalf("recorded authentication failure = %+v, want no without quota", result)
			}
		})
	}
	no := loadGoogleProbeRecording(t, "google-auth-invalid-refresh.json")
	for _, test := range []struct {
		name, stdout, stderr string
		exitCode             int
	}{
		{"zero-is-not-success", "", "", 0},
		{"network-error", no.Stdout, "connection timed out", 1},
		{"generic-auth-error", no.Stdout, "authentication failed or timed out", 1},
		{"missing-second-message", no.Stdout, "authentication required", 1},
		{"wrong-exit", no.Stdout, no.Stderr, 2},
		{"already-initialized", "{\"event\":\"init\"}\n" + no.Stdout, no.Stderr, 1},
		{"unparseable", "not-json", no.Stderr, 1},
	} {
		t.Run(test.name, func(t *testing.T) {
			if result := parseAntigravityGoogleProbe([]byte(test.stdout), test.stderr, test.exitCode); result.auth != authUnknown || result.usage != nil {
				t.Fatalf("ambiguous probe = %+v, want unknown", result)
			}
		})
	}
}

func TestAntigravityGoogleUsageReportWhitelist(t *testing.T) {
	stdout := `{"event":"command_result","command":{"name":"usage","data":{"email":"private@example.invalid","token":"private-token","groups":[{"email":"private@example.invalid","buckets":[{"id":"gemini-5h","window":"5h","remaining_fraction":0,"reset_time":"2026-10-04T05:00:00Z","token":"private-token"}]}]}}}` + "\n" +
		`{"event":"result","result":{"status":"SUCCESS","response":"private@example.invalid private-token"}}`
	result := parseAntigravityGoogleProbe([]byte(stdout), "", 0)
	body, err := json.Marshal(EngineHealthReport{Engine: providerAntigravity, Auth: authWord(result.auth), AuthSource: "google", PlanUsage: result.usage})
	if err != nil {
		t.Fatal(err)
	}
	for _, private := range []string{"private@example.invalid", "private-token", "email", "token", "response"} {
		if strings.Contains(string(body), private) {
			t.Fatalf("usage report retained a private/irrelevant field %q", private)
		}
	}
	if !strings.Contains(string(body), `"remainingFraction":0`) || !strings.Contains(string(body), `"resetTime":"2026-10-04T05:00:00Z"`) {
		t.Fatalf("public quota wire fields missing: %s", body)
	}
}
