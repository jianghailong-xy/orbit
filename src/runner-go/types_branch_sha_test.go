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

// `[K6]` §7: the already-merged answer travels as a FLAG beside the status a control plane
// already knows, not as a fifth status value.
//
// A control plane validates `status` against a closed set and rejects anything else with a 400 —
// which, for a merge result, means the runner reports a completed merge forever. So a new status
// would have made this unit undeployable without a lockstep upgrade. The flag is `omitempty`, so a
// runner that did not take the short-circuit sends exactly the bytes it always sent, and an older
// control plane that ignores the field records `MERGED`, which is true; a current one records
// `ALREADY_MERGED`, which is truer.
func TestMergeResultAlreadyMergedWireField(t *testing.T) {
	decoded := func(t *testing.T, req MergeResultRequest) map[string]interface{} {
		t.Helper()
		encoded, err := json.Marshal(req)
		if err != nil {
			t.Fatal(err)
		}
		var got map[string]interface{}
		if err := json.Unmarshal(encoded, &got); err != nil {
			t.Fatal(err)
		}
		return got
	}

	landed := decoded(t, MergeResultRequest{
		Status: "merged", MergedSha: "tip", SourceSha: "tip", AlreadyMerged: true,
	})
	if landed["status"] != "merged" {
		t.Fatalf("status = %#v, want the value every control plane already accepts", landed["status"])
	}
	if landed["alreadyMerged"] != true {
		t.Fatalf("alreadyMerged = %#v", landed["alreadyMerged"])
	}

	ordinary := decoded(t, MergeResultRequest{
		Status: "merged", MergedSha: "new-tip", SourceSha: "source-tip",
	})
	if _, present := ordinary["alreadyMerged"]; present {
		t.Fatalf("an ordinary merge sent a new field: %#v", ordinary)
	}
}

// The other direction of the same upgrade window: a control plane that knows nothing about §7 sends
// no `requiredSourceSha`, and the command it sends must be byte-identical to the one it always sent.
func TestMergeCommandRequiredSourceShaWireField(t *testing.T) {
	encode := func(t *testing.T, cmd MergeCommand) map[string]interface{} {
		t.Helper()
		encoded, err := json.Marshal(cmd)
		if err != nil {
			t.Fatal(err)
		}
		var got map[string]interface{}
		if err := json.Unmarshal(encoded, &got); err != nil {
			t.Fatal(err)
		}
		return got
	}

	gated := encode(t, MergeCommand{SessionID: "s1", Branch: "b", WorkDir: "/r", RequiredSourceSha: "abc"})
	if gated["requiredSourceSha"] != "abc" {
		t.Fatalf("requiredSourceSha = %#v", gated["requiredSourceSha"])
	}
	ungated := encode(t, MergeCommand{SessionID: "s1", Branch: "b", WorkDir: "/r"})
	if _, present := ungated["requiredSourceSha"]; present {
		t.Fatalf("an ungated merge carried the field: %#v", ungated)
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
