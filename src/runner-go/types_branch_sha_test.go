package main

import (
	"encoding/json"
	"testing"
)

func TestBranchShaWireFields(t *testing.T) {
	tests := []struct {
		name string
		body interface{}
	}{
		{name: "heartbeat live state", body: SessionLiveState{BranchSha: "live-tip"}},
		{name: "diff result", body: DiffResultRequest{BranchSha: "diff-tip"}},
		{name: "turn complete", body: TurnCompleteRequest{BranchSha: "turn-tip"}},
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
			if got["branchSha"] == nil {
				t.Fatalf("branchSha missing from %s payload: %s", tc.name, encoded)
			}
		})
	}
}

func TestMergeResultSourceShaWireField(t *testing.T) {
	encoded, err := json.Marshal(MergeResultRequest{
		Status: "merged", MergedSha: "target-tip", SourceSha: "source-tip",
	})
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]interface{}
	if err := json.Unmarshal(encoded, &got); err != nil {
		t.Fatal(err)
	}
	if got["sourceSha"] != "source-tip" {
		t.Fatalf("sourceSha = %#v, payload = %s", got["sourceSha"], encoded)
	}
}
