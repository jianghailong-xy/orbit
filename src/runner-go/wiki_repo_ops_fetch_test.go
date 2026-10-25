package main

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// Fetches of one checkout racing each other (fetchWikiOriginMain). On 2026-10-09 the canary's docs
// build 79620f23 lost two reads to it: each read fetched origin's main before it read, two were in
// flight, main moved between them, and the slower fetch's update of refs/remotes/origin/main was refused —
//
//	error: cannot lock ref 'refs/remotes/origin/main': is at 6c9cebd4d… but expected 8fcd5b3c7…
//
// The window is a fetch's whole transfer: git reads the ref's value before it asks for a pack and
// writes it, against that value, after. These tests hold the window open (holdPacksUntilAllAsk), so the
// race is lost every time if anything can lose it, rather than on the run the timing happens to fall.

// holdPacksUntilAllAsk makes origin hold every pack it is asked for until `fetches` fetches have asked
// for one: each of them has read refs/remotes/origin/main by then, and none can write it until all have.
// A fetch that waits alone goes on after a quiet spell — once the fetches take turns, the one that is
// asking has the checkout to itself, and the others are waiting for it rather than coming.
func holdPacksUntilAllAsk(t *testing.T, home string, fetches int) {
	t.Helper()
	asked := filepath.Join(home, "packs-asked")
	if err := os.MkdirAll(asked, 0o755); err != nil {
		t.Fatal(err)
	}
	hook := filepath.Join(home, "hold-packs.sh")
	script := fmt.Sprintf(`#!/bin/sh
: > '%[1]s'/$$
seen=0 quiet=0
while [ "$quiet" -lt 40 ]; do
	now=$(($(ls '%[1]s' | wc -l)))
	[ "$now" -ge %[2]d ] && break
	if [ "$now" -ne "$seen" ]; then seen=$now quiet=0; else quiet=$((quiet + 1)); fi
	sleep 0.05
done
exec "$@"
`, asked, fetches)
	if err := os.WriteFile(hook, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	// Git reads the hook only from a protected configuration (git-config(1), uploadpack.packObjectsHook):
	// the global one, here the fixture's own, and every process of the test reads that one.
	t.Setenv("GIT_CONFIG_GLOBAL", filepath.Join(home, ".gitconfig"))
	mustGit(t, home, "config", "--global", "uploadpack.packObjectsHook", hook)
}

// Several reads and a snapshot of one checkout at once, origin's main having moved since its last fetch:
// what the docs build does with its reads in flight. Every one of them answers.
func TestWikiRepoOpsOfOneCheckoutAtOnceAllAnswerWhileMainMoves(t *testing.T) {
	f := newWikiRepoOpFixture(t)
	moved := f.push(t, "main moves", func() { f.write(t, "docs/moved.md", "# Moved\n\nmain moved on.\n") })
	const reads = 4
	holdPacksUntilAllAsk(t, f.home, reads+1)

	commands := []WikiRepoOpCommand{f.command(t, "snapshot", map[string]interface{}{})}
	for i := 0; i < reads; i++ {
		commands = append(commands, f.command(t, "read", map[string]interface{}{
			"sha": moved, "items": []map[string]interface{}{{"path": "docs/moved.md"}},
		}))
	}
	outcomes := make([]wikiRepoOpOutcome, len(commands))
	var wg sync.WaitGroup
	for i, cmd := range commands {
		wg.Add(1)
		go func(i int, cmd WikiRepoOpCommand) {
			defer wg.Done()
			outcomes[i] = runWikiRepoOp(cmd, nil)
		}(i, cmd)
	}
	wg.Wait()

	for i, outcome := range outcomes {
		if outcome.state != "succeeded" {
			t.Errorf("%s %d of %d at once: %s", commands[i].Kind, i, len(commands), outcome.err)
		}
	}
	if t.Failed() {
		t.FailNow()
	}
	if outcomes[0].result["sha"] != moved {
		t.Fatalf("the snapshot was taken at %v, want the commit main moved to (%s)", outcomes[0].result["sha"], moved)
	}
	for _, outcome := range outcomes[1:] {
		answer := decodeResult[wikiRepoOpReadAnswer](t, outcome, "read")
		if len(answer.Items) != 1 || !answer.Items[0].Found || !strings.Contains(answer.Items[0].Text, "main moved on.") {
			t.Fatalf("a read did not answer with the file at %s: %+v", moved, answer.Items)
		}
	}
	if got := mustGit(t, f.checkout, "rev-parse", "refs/remotes/origin/main"); got != moved {
		t.Fatalf("origin/main is %s after the operations, want %s", got, moved)
	}
}

// A wiki fetch of the same checkout from another process — another runner on the machine with the same work
// directory — takes the same lock the runner's operations take, and the operations beside it all answer: the
// same race, across processes. The other process's fetch runs here in a child process, beside a snapshot and
// a read in this one.
func TestWikiFetchInAnotherProcessAndTheRunnersOperationsAllAnswerWhileMainMoves(t *testing.T) {
	if repo := os.Getenv("ORBIT_WIKI_FETCH_RACE_REPO"); os.Getenv("ORBIT_WIKI_FETCH_RACE_CHILD") == "1" {
		// The other process. "ready" is the parent's cue to start its own operations.
		fmt.Println("ready")
		if err := fetchWikiOriginMain(repo); err != nil {
			t.Fatalf("the other process's fetch: %v", err)
		}
		return
	}
	f := newWikiRepoOpFixture(t)
	moved := f.push(t, "main moves", func() { f.write(t, "docs/moved.md", "# Moved\n\nmain moved on.\n") })
	holdPacksUntilAllAsk(t, f.home, 3)

	child := exec.Command(os.Args[0], "-test.run=^TestWikiFetchInAnotherProcessAndTheRunnersOperationsAllAnswerWhileMainMoves$")
	child.Env = append(os.Environ(), "ORBIT_WIKI_FETCH_RACE_CHILD=1", "ORBIT_WIKI_FETCH_RACE_REPO="+f.checkout)
	stdout, err := child.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	child.Stderr = child.Stdout
	if err := child.Start(); err != nil {
		t.Fatal(err)
	}
	childOut := bufio.NewReader(stdout)
	if line, err := childOut.ReadString('\n'); err != nil || line != "ready\n" {
		_ = child.Process.Kill()
		_ = child.Wait()
		t.Fatalf("the other process did not start: %q, %v", line, err)
	}

	commands := []WikiRepoOpCommand{
		f.command(t, "snapshot", map[string]interface{}{}),
		f.command(t, "read", map[string]interface{}{"sha": moved, "items": []map[string]interface{}{{"path": "docs/moved.md"}}}),
	}
	outcomes := make([]wikiRepoOpOutcome, len(commands))
	var wg sync.WaitGroup
	for i, cmd := range commands {
		wg.Add(1)
		go func(i int, cmd WikiRepoOpCommand) {
			defer wg.Done()
			outcomes[i] = runWikiRepoOp(cmd, nil)
		}(i, cmd)
	}
	wg.Wait()
	rest, _ := io.ReadAll(childOut)
	if err := child.Wait(); err != nil {
		t.Errorf("the other process's fetch, beside the runner's operations: %v\n%s", err, rest)
	}
	for i, outcome := range outcomes {
		if outcome.state != "succeeded" {
			t.Errorf("the runner's %s beside the other process's fetch: %s", commands[i].Kind, outcome.err)
		}
	}
	if t.Failed() {
		t.FailNow()
	}
	if outcomes[0].result["sha"] != moved {
		t.Fatalf("the snapshot was taken at %v, want %s", outcomes[0].result["sha"], moved)
	}
	if got := mustGit(t, f.checkout, "rev-parse", "refs/remotes/origin/main"); got != moved {
		t.Fatalf("origin/main is %s after the fetches, want %s", got, moved)
	}
}
