package main

import (
	"encoding/json"
	"strings"
	"testing"
)

// The control plane distinguishes three states for this field: root, not root, and never reported
// (NULL, which stays unrestricted so an un-upgraded runner keeps every mode). That only works if a
// non-root runner actually SENDS false rather than omitting it — which is why the field is a pointer
// and `omitempty` keys off the pointer instead of the value. A plain bool here would make every
// non-root runner indistinguishable from an old one.
func TestRunsAsRootReportsFalseRatherThanOmittingIt(t *testing.T) {
	no, yes := false, true

	body, err := json.Marshal(HeartbeatRequest{RunsAsRoot: &no})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(body), `"runsAsRoot":false`) {
		t.Errorf("a non-root runner must report false, got %s", body)
	}

	body, err = json.Marshal(HeartbeatRequest{RunsAsRoot: &yes})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(body), `"runsAsRoot":true`) {
		t.Errorf("a root runner must report true, got %s", body)
	}

	// Nil stays off the wire, so an older control plane sees exactly the payload it used to.
	body, err = json.Marshal(HeartbeatRequest{})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(body), "runsAsRoot") {
		t.Errorf("an unset report must be omitted entirely, got %s", body)
	}
}
