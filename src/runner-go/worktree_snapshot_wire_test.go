package main

import (
	"encoding/json"
	"testing"
)

func TestWorktreeSnapshotWirePairsBaseWithExplicitArrays(t *testing.T) {
	tests := []struct {
		name     string
		body     interface{}
		hasPatch bool
	}{
		{
			name: "heartbeat",
			body: SessionLiveState{
				BaseSha:      "heartbeat-base",
				ChangedFiles: []ChangedFile{},
			},
		},
		{name: "diff result", body: DiffResultRequest{BaseSha: "diff-base"}, hasPatch: true},
		{name: "turn complete", body: TurnCompleteRequest{BaseSha: "turn-base"}, hasPatch: true},
		{name: "run finalize", body: RunFinalizeRequest{BaseSha: "finalize-base"}, hasPatch: true},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			encoded, err := json.Marshal(tc.body)
			if err != nil {
				t.Fatal(err)
			}
			var got map[string]interface{}
			if err := json.Unmarshal(encoded, &got); err != nil {
				t.Fatal(err)
			}
			if got["baseSha"] == nil {
				t.Fatalf("baseSha missing from payload: %s", encoded)
			}
			files, ok := got["changedFiles"].([]interface{})
			if !ok || len(files) != 0 {
				t.Fatalf("changedFiles = %#v, want an explicit empty array; payload: %s", got["changedFiles"], encoded)
			}
			if tc.hasPatch {
				patches, ok := got["changedDiff"].([]interface{})
				if !ok || len(patches) != 0 {
					t.Fatalf("changedDiff = %#v, want an explicit empty array; payload: %s", got["changedDiff"], encoded)
				}
			}
		})
	}
}

func TestWorktreeSnapshotWireKeepsLegacyOmissionWithoutBase(t *testing.T) {
	for _, body := range []interface{}{TurnCompleteRequest{}, DiffResultRequest{}, RunFinalizeRequest{}} {
		encoded, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		var got map[string]interface{}
		if err := json.Unmarshal(encoded, &got); err != nil {
			t.Fatal(err)
		}
		for _, field := range []string{"baseSha", "changedFiles", "changedDiff"} {
			if _, present := got[field]; present {
				t.Fatalf("%T unexpectedly sent %s without a worktree snapshot: %s", body, field, encoded)
			}
		}
	}
}
