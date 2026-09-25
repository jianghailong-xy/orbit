package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// alreadyMergedFixture is the 2026-09-25 incident in a real repository: a session branch whose work
// reached main by cherry-pick after main had moved on, so origin/main carries the content under a
// new commit and the branch's own tip is no ancestor of it. Both doors check in this repository.
func alreadyMergedFixture(t *testing.T) (landed, branchTip string) {
	t.Helper()
	repo := initRepo(t)
	mustGit(t, repo, "checkout", "-b", "orbit/session")
	commitFile(t, repo, "work.txt", "work\n", "the session's work")
	branchTip = mustGit(t, repo, "rev-parse", "HEAD")
	mustGit(t, repo, "checkout", "main")
	commitFile(t, repo, "other.txt", "other\n", "main moved on")
	mustGit(t, repo, "cherry-pick", branchTip)
	landed = mustGit(t, repo, "rev-parse", "HEAD")
	addOriginBare(t, repo)
	mergeReceiptRepoDir = repo
	t.Cleanup(func() { mergeReceiptRepoDir = "" })
	return landed, branchTip
}

// mergeReceiptServer records the body of every receipt that reaches the control plane.
func mergeReceiptServer(t *testing.T, bodies *[]map[string]interface{}) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/runner/sessions/s1/merge-receipts" {
			t.Errorf("request = %s %s", r.Method, r.URL.Path)
		}
		var body map[string]interface{}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decode receipt body: %v", err)
		}
		*bodies = append(*bodies, body)
		_, _ = w.Write([]byte(`{"receipt":{"id":"r1"},"created":true}`))
	}))
	t.Cleanup(srv.Close)
	return srv
}

// An ALREADY_MERGED receipt naming a commit the target does not contain cannot be taken back: it
// enters every dependent task's dependency closure, and the runner refuses them
// DEPENDENCY_BASE_NOT_LANDED from then on. So the claim is checked before anything is sent.
func TestMCPMergeReceiptRefusesAlreadyMergedShaNotInTarget(t *testing.T) {
	landed, branchTip := alreadyMergedFixture(t)
	var bodies []map[string]interface{}
	srv := mergeReceiptServer(t, &bodies)
	mcp := &mcpServer{t: NewTransport(srv.URL, "tok")}

	for _, tc := range []struct {
		name  string
		extra map[string]interface{}
		want  []string
	}{
		{"branch tip against origin/main", map[string]interface{}{"sourceSha": branchTip},
			[]string{branchTip, "origin/main", "cherry-pick", "DEPENDENCY_BASE_NOT_LANDED"}},
		{"branch tip against targetShaAfter", map[string]interface{}{"sourceSha": branchTip, "targetShaAfter": landed},
			[]string{"targetShaAfter " + landed}},
		{"a commit this repository does not have", map[string]interface{}{"sourceSha": strings.Repeat("1", 40)},
			[]string{"git fetch"}},
	} {
		args := map[string]interface{}{"sessionId": "s1", "result": "ALREADY_MERGED", "targetBranch": "main"}
		for k, v := range tc.extra {
			args[k] = v
		}
		res := mcp.callTool("merge_receipt", args)
		if res["isError"] != true {
			t.Fatalf("%s: receipt accepted: %#v", tc.name, res)
		}
		text := watchToolText(t, res)
		for _, want := range tc.want {
			if !strings.Contains(text, want) {
				t.Errorf("%s: refusal does not say %q: %s", tc.name, want, text)
			}
		}
	}
	if len(bodies) != 0 {
		t.Fatalf("a refused receipt reached the control plane: %#v", bodies)
	}

	res := mcp.callTool("merge_receipt", map[string]interface{}{
		"sessionId": "s1", "result": "ALREADY_MERGED", "sourceSha": landed, "targetBranch": "main",
	})
	if res["isError"] == true {
		t.Fatalf("the commit main carries was refused: %s", watchToolText(t, res))
	}
	if len(bodies) != 1 || bodies[0]["sourceSha"] != landed || bodies[0]["result"] != "ALREADY_MERGED" {
		t.Fatalf("forwarded receipts = %#v, want one ALREADY_MERGED with sourceSha %s", bodies, landed)
	}

	// Only ALREADY_MERGED claims the target already holds the commit; a CONFLICT is sent unchecked.
	res = mcp.callTool("merge_receipt", map[string]interface{}{
		"sessionId": "s1", "result": "CONFLICT", "sourceSha": branchTip, "targetBranch": "main", "conflicts": []interface{}{"work.txt"},
	})
	if res["isError"] == true || len(bodies) != 2 || bodies[1]["sourceSha"] != branchTip {
		t.Fatalf("CONFLICT receipt: result %#v, forwarded %#v", res, bodies)
	}
}

// The CLI door runs the same check as the MCP one.
func TestCLIMergeReceiptRefusesAlreadyMergedShaNotInTarget(t *testing.T) {
	landed, branchTip := alreadyMergedFixture(t)
	var bodies []map[string]interface{}
	srv := mergeReceiptServer(t, &bodies)
	configureCLITestRunner(t, srv.URL)

	for _, tc := range []struct {
		name  string
		extra []string
		want  []string
	}{
		{"branch tip against origin/main", []string{"--source-sha", branchTip},
			[]string{branchTip, "origin/main", "cherry-pick", "DEPENDENCY_BASE_NOT_LANDED"}},
		{"branch tip against --target-sha-before", []string{"--source-sha", branchTip, "--target-sha-before", landed},
			[]string{"targetShaBefore " + landed}},
		{"a commit this repository does not have", []string{"--source-sha", strings.Repeat("1", 40)},
			[]string{"git fetch"}},
	} {
		args := append([]string{"merge-receipt", "s1", "--result", "ALREADY_MERGED", "--target-branch", "main"}, tc.extra...)
		err := cmdSessionCLI(args, strings.NewReader(""), &bytes.Buffer{})
		if err == nil {
			t.Fatalf("%s: receipt accepted", tc.name)
		}
		for _, want := range tc.want {
			if !strings.Contains(err.Error(), want) {
				t.Errorf("%s: refusal does not say %q: %v", tc.name, want, err)
			}
		}
	}
	if len(bodies) != 0 {
		t.Fatalf("a refused receipt reached the control plane: %#v", bodies)
	}

	var out bytes.Buffer
	if err := cmdSessionCLI([]string{"merge-receipt", "s1", "--result", "ALREADY_MERGED",
		"--source-sha", landed, "--target-branch", "main", "--json"}, strings.NewReader(""), &out); err != nil {
		t.Fatalf("the commit main carries was refused: %v", err)
	}
	if len(bodies) != 1 || bodies[0]["sourceSha"] != landed || bodies[0]["result"] != "ALREADY_MERGED" {
		t.Fatalf("forwarded receipts = %#v, want one ALREADY_MERGED with sourceSha %s", bodies, landed)
	}

	// Only ALREADY_MERGED claims the target already holds the commit; a MERGED is sent unchecked.
	if err := cmdSessionCLI([]string{"merge-receipt", "s1", "--result", "MERGED", "--source-sha", branchTip,
		"--target-branch", "main", "--target-sha-after", landed, "--json"}, strings.NewReader(""), &out); err != nil {
		t.Fatalf("MERGED receipt: %v", err)
	}
	if len(bodies) != 2 || bodies[1]["sourceSha"] != branchTip {
		t.Fatalf("MERGED receipt forwarded %#v", bodies)
	}
}
