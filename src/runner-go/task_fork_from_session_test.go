package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// forkFromSession (docs/task-fork-from-session-design.md §2.1, §2.2, SR55) on both create doors: the
// runner snapshots the calling session's checkout and posts the fork the server accepts.

func TestMCPTaskToolsDeclareForkFromSession(t *testing.T) {
	tools := toolDescriptors(false, false)
	batch := mcpToolProps(tools, "task_create_batch")
	tasks, _ := batch["tasks"].(map[string]interface{})
	items, _ := tasks["items"].(map[string]interface{})
	itemProps, _ := items["properties"].(map[string]interface{})

	for label, props := range map[string]map[string]interface{}{
		"task_create":            mcpToolProps(tools, "task_create"),
		"task_create_batch item": itemProps,
	} {
		fork, ok := props["forkFromSession"].(map[string]interface{})
		if !ok || fork["type"] != "boolean" {
			t.Fatalf("%s forkFromSession = %#v, want a boolean", label, props["forkFromSession"])
		}
		description, _ := fork["description"].(string)
		for _, phrase := range []string{"not committed", "this machine", "code binding"} {
			if !strings.Contains(description, phrase) {
				t.Errorf("%s forkFromSession description does not say %q: %q", label, phrase, description)
			}
		}
	}
	if _, declared := mcpToolProps(tools, "task_update")["forkFromSession"]; declared {
		t.Errorf("task_update declares forkFromSession: a fork is a fact of the task's creation and is never edited")
	}
}

// forkSessionFixture is a session's own sparse-free linked worktree under ORBIT_HOME/worktrees/<id>, with an
// uncommitted edit, and the workDir it belongs to. The process's cwd is moved into the workDir for the
// test, so nothing can fall back to the checkout the tests run in.
func forkSessionFixture(t *testing.T) (sessionID, workDir, checkout string) {
	t.Helper()
	sessionID = "0190aaaa-0000-7000-8000-0000000000aa"
	home := t.TempDir()
	t.Setenv("ORBIT_HOME", home)
	workDir = initRepo(t)
	checkout = filepath.Join(home, "worktrees", sessionID)
	mustGit(t, workDir, "worktree", "add", "-q", "-b", "orbit/forking", checkout)
	writeForkFile(t, filepath.Join(checkout, "base.txt"), "uncommitted\n")
	cwd, _ := os.Getwd()
	if err := os.Chdir(workDir); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chdir(cwd) })
	return sessionID, workDir, checkout
}

// forkCreateServer answers the card with decision and records every create body, by path.
func forkCreateServer(t *testing.T, decision string) (*httptest.Server, *[]map[string]interface{}) {
	t.Helper()
	var bodies []map[string]interface{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		if strings.Contains(r.URL.Path, "/approvals") {
			_, _ = w.Write([]byte(`{"id":"ap1","status":"` + decision + `","message":"no"}`))
			return
		}
		var body map[string]interface{}
		_ = json.NewDecoder(r.Body).Decode(&body)
		body["@path"] = r.URL.Path
		bodies = append(bodies, body)
		_, _ = w.Write([]byte(`{"id":"created-task"}`))
	}))
	t.Cleanup(srv.Close)
	return srv, &bodies
}

func forkRefs(t *testing.T, repo string) []string {
	t.Helper()
	out := mustGit(t, repo, "for-each-ref", "--format=%(refname) %(objectname)", forkRefPrefix)
	if out == "" {
		return nil
	}
	return strings.Split(out, "\n")
}

// task_create with forkFromSession posts the fork P1 accepts: this session, S carrying its uncommitted
// edit, HEAD as baseHead. The keep-alive ref names S, and the session's checkout is untouched.
func TestMCPTaskCreatePostsTheSessionSnapshot(t *testing.T) {
	sessionID, workDir, checkout := forkSessionFixture(t)
	srv, bodies := forkCreateServer(t, "ALLOWED")
	mcp := &mcpServer{agentID: "agent-1", sessionID: sessionID, t: NewTransport(srv.URL, "tok")}
	before := checkoutFingerprint(t, checkout)
	head := mustGit(t, checkout, "rev-parse", "HEAD")

	res := mcp.callTool("task_create", map[string]interface{}{
		"title": "Continue from here", "forkFromSession": true, "completionCriterion": "EVIDENCE_JUDGMENT",
	})
	if res["isError"] == true {
		t.Fatalf("task_create: %s", resultText(res))
	}
	if after := checkoutFingerprint(t, checkout); after != before {
		t.Fatal("the fork changed the session's checkout")
	}
	if len(*bodies) != 1 {
		t.Fatalf("posted %d bodies", len(*bodies))
	}
	body := (*bodies)[0]
	if _, leaked := body["forkFromSession"]; leaked {
		t.Error("the flag itself was posted; the server takes the fork")
	}
	fork, _ := body["fork"].(map[string]interface{})
	sha, _ := fork["sha"].(string)
	if fork["sessionId"] != sessionID || fork["baseHead"] != head || sha == head || fork["includesUncommitted"] != true {
		t.Fatalf("fork = %#v (HEAD %s)", fork, head)
	}
	if got := blobAt(workDir, sha, "base.txt"); got != "uncommitted" {
		t.Fatalf("S:base.txt = %q", got)
	}
	if refs := forkRefs(t, workDir); len(refs) != 1 || !strings.HasSuffix(refs[0], " "+sha) {
		t.Fatalf("keep-alive refs = %v, want one naming %s", refs, sha)
	}
}

// One snapshot for the call, shared by every batch item that forks; an item that does not fork carries
// no fork.
func TestMCPTaskCreateBatchSharesOneSnapshot(t *testing.T) {
	sessionID, workDir, _ := forkSessionFixture(t)
	srv, bodies := forkCreateServer(t, "ALLOWED")
	mcp := &mcpServer{agentID: "agent-1", sessionID: sessionID, t: NewTransport(srv.URL, "tok")}
	res := mcp.callTool("task_create_batch", map[string]interface{}{
		"tasks": []interface{}{
			map[string]interface{}{"title": "A", "forkFromSession": true, "completionCriterion": "EVIDENCE_JUDGMENT"},
			map[string]interface{}{"title": "Plain", "completionCriterion": "EVIDENCE_JUDGMENT"},
			map[string]interface{}{"title": "B", "forkFromSession": true, "completionCriterion": "EVIDENCE_JUDGMENT"},
		},
	})
	if res["isError"] == true {
		t.Fatalf("task_create_batch: %s", resultText(res))
	}
	var create map[string]interface{}
	for _, b := range *bodies {
		if b["@path"] == "/api/runner/tasks/batch-create" {
			create = b
		}
	}
	items, _ := create["tasks"].([]interface{})
	if len(items) != 3 {
		t.Fatalf("batch-create body = %#v", create)
	}
	forkOf := func(i int) map[string]interface{} {
		f, _ := items[i].(map[string]interface{})["fork"].(map[string]interface{})
		return f
	}
	if forkOf(0) == nil || forkOf(2) == nil || forkOf(1) != nil || forkOf(0)["sha"] != forkOf(2)["sha"] {
		t.Fatalf("forks = %#v / %#v / %#v", forkOf(0), forkOf(1), forkOf(2))
	}
	if refs := forkRefs(t, workDir); len(refs) != 1 {
		t.Fatalf("keep-alive refs = %v, want exactly one for the call", refs)
	}
}

// A declined card creates nothing, so the snapshot's ref is let go at once.
func TestMCPTaskCreateDeclinedReleasesTheSnapshotRef(t *testing.T) {
	sessionID, workDir, _ := forkSessionFixture(t)
	srv, bodies := forkCreateServer(t, "DENIED")
	mcp := &mcpServer{agentID: "agent-1", sessionID: sessionID, t: NewTransport(srv.URL, "tok")}
	mcp.callTool("task_create", map[string]interface{}{
		"title": "No", "forkFromSession": true, "completionCriterion": "EVIDENCE_JUDGMENT",
	})
	if len(*bodies) != 0 {
		t.Fatalf("a declined create posted %d bodies", len(*bodies))
	}
	if refs := forkRefs(t, workDir); len(refs) != 0 {
		t.Fatalf("a declined fork kept its ref: %v", refs)
	}
}

// A submodule the snapshot cannot carry refuses the fork before anything is posted (design §2.7 F3).
func TestMCPTaskCreateRefusesAnUnshareableSubmoduleBeforePosting(t *testing.T) {
	sessionID := "0190aaaa-0000-7000-8000-0000000000ab"
	home := t.TempDir()
	t.Setenv("ORBIT_HOME", home)
	workDir, checkout := repoWithSubmoduleAt(t, filepath.Join(home, "worktrees", sessionID))
	writeForkFile(t, filepath.Join(checkout, "sub", "sub.txt"), "dirty in the submodule\n")
	srv, bodies := forkCreateServer(t, "ALLOWED")
	mcp := &mcpServer{agentID: "agent-1", sessionID: sessionID, t: NewTransport(srv.URL, "tok")}
	res := mcp.callTool("task_create", map[string]interface{}{
		"title": "Sub", "forkFromSession": true, "completionCriterion": "EVIDENCE_JUDGMENT",
	})
	if res["isError"] != true || !strings.Contains(resultText(res), forkSubmoduleNotShareable) || !strings.Contains(resultText(res), `"sub"`) {
		t.Fatalf("result = %s", resultText(res))
	}
	if len(*bodies) != 0 || len(forkRefs(t, workDir)) != 0 {
		t.Fatalf("a refused fork posted %d requests and left refs %v", len(*bodies), forkRefs(t, workDir))
	}
}
