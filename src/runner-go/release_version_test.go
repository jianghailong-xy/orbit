package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// The release ordering both the runner and the control plane use is pinned once, in
// contracts/release-versions.json. This test reads the same file runner-release.spec.ts reads, so the
// two implementations cannot drift apart on which release is newer.

type releaseVersionsContract struct {
	Valid   []string `json:"valid"`
	Invalid []string `json:"invalid"`
	Compare []struct {
		A    string `json:"a"`
		B    string `json:"b"`
		Want int    `json:"want"`
	} `json:"compare"`
}

func loadReleaseVersions(t *testing.T) releaseVersionsContract {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "contracts", "release-versions.json"))
	if err != nil {
		t.Fatalf("read contracts/release-versions.json: %v", err)
	}
	var contract releaseVersionsContract
	if err := json.Unmarshal(raw, &contract); err != nil {
		t.Fatalf("parse contracts/release-versions.json: %v", err)
	}
	return contract
}

func TestReleaseVersionSyntaxMatchesTheSharedContract(t *testing.T) {
	contract := loadReleaseVersions(t)
	for _, version := range contract.Valid {
		if _, ok := parseReleaseVersion(version); !ok {
			t.Errorf("parseReleaseVersion(%q) = invalid, contract says valid", version)
		}
	}
	for _, version := range contract.Invalid {
		if _, ok := parseReleaseVersion(version); ok {
			t.Errorf("parseReleaseVersion(%q) = valid, contract says invalid", version)
		}
	}
}

func TestReleaseOrderingMatchesTheSharedContract(t *testing.T) {
	contract := loadReleaseVersions(t)
	for _, c := range contract.Compare {
		if got := compareReleaseVersions(c.A, c.B); got != c.Want {
			t.Errorf("compareReleaseVersions(%q, %q) = %d, want %d", c.A, c.B, got, c.Want)
		}
		if got := compareReleaseVersions(c.B, c.A); got != -c.Want {
			t.Errorf("compareReleaseVersions(%q, %q) = %d, want %d", c.B, c.A, got, -c.Want)
		}
	}
}

func TestNewerSeesPrereleases(t *testing.T) {
	for _, c := range []struct {
		remote, local string
		want          bool
	}{
		// The beta this rule ships first is newer than the 0.1.25x line it follows: the old comparator
		// read "257-beta" as 0 and left every runner on the release before it.
		{"0.1.257-beta.1", "0.1.256", true},
		{"0.1.256", "0.1.257-beta.1", false},
		{"0.1.257-beta.2", "0.1.257-beta.1", true},
		{"0.1.257", "0.1.257-beta.2", true},
		{"0.1.257-beta.2", "0.1.257", false},
		{"0.1.257-beta.1", "0.1.257-beta.1", false},
	} {
		if got := isNewer(c.remote, c.local); got != c.want {
			t.Errorf("isNewer(%q, %q) = %v, want %v", c.remote, c.local, got, c.want)
		}
	}
}
