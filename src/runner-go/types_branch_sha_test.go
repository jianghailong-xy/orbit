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

func TestManualWorktreeFenceWireFields(t *testing.T) {
	tests := []struct {
		name        string
		body        interface{}
		operationID string
		leaseOwner  string
	}{
		{
			name: "merge command",
			body: MergeCommand{
				SessionID: "s1", OperationID: "merge-op", LeaseOwner: "merge-owner",
				Branch: "orbit/s1", WorkDir: "/repo",
			},
			operationID: "merge-op", leaseOwner: "merge-owner",
		},
		{
			name: "commit command",
			body: CommitCommand{
				SessionID: "s2", OperationID: "commit-op", LeaseOwner: "commit-owner",
				Branch: "orbit/s2",
			},
			operationID: "commit-op", leaseOwner: "commit-owner",
		},
		{
			name: "merge result",
			body: MergeResultRequest{
				OperationID: "merge-result-op", LeaseOwner: "merge-result-owner", Status: "merged",
			},
			operationID: "merge-result-op", leaseOwner: "merge-result-owner",
		},
		{
			name: "commit result",
			body: CommitResultRequest{
				OperationID: "commit-result-op", LeaseOwner: "commit-result-owner", Status: "committed",
			},
			operationID: "commit-result-op", leaseOwner: "commit-result-owner",
		},
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
			if got["operationId"] != tc.operationID || got["leaseOwner"] != tc.leaseOwner {
				t.Fatalf("fence fields = (%#v, %#v), want (%q, %q); payload = %s",
					got["operationId"], got["leaseOwner"], tc.operationID, tc.leaseOwner, encoded)
			}
		})
	}
}
