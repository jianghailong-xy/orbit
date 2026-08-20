package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Orbit reaches another machine by running a runner ON it, not by shelling out to `ssh`:
// nothing in this repo execs ssh, and neither a runner nor an agent has a host to reach.
// A "remote" Claude session is therefore this same local spawn, running somewhere else —
// so the two properties an SSH hop would have put at risk are asserted here, against the
// only transport there is:
//
//   - the engine is exec'd as an argv vector, never assembled into a command string for
//     an outer shell to re-parse, and
//   - the user's text is not in that vector at all. It is a `user` frame on a stdin that
//     stays open, which is what puts shell metacharacters in a prompt out of reach of any
//     parser rather than merely quoting them past one.
//
// The fake CLI is reached through a `#!/bin/sh` shim (newFakeClaude), so a real shell does
// sit in this exec chain. It passes argv through `"$@"` and so expands nothing itself —
// which is what makes the canaries below a live tripwire for the one regression that would
// matter: an argv element that is a command string somebody built by concatenation.

// injectionProbe is a prompt carrying every way a shell is asked to run something else:
// command substitution in both spellings, a statement separator, a pipeline, a redirect,
// an unbalanced quote, and a newline — which would also split the JSONL frame in two if it
// ever reached stdin unescaped.
func injectionProbe(canaryDir string) string {
	canary := func(name string) string { return filepath.Join(canaryDir, name) }
	return "rename $(touch " + canary("substituted") + ") the widget\n" +
		"and `touch " + canary("backticked") + "` explain why\n" +
		"; touch " + canary("separated") + " | tee /dev/null > /dev/null \"unbalanced"
}

// The canary dir starts empty and nothing legitimate ever writes to it, so any file in it
// is a command the prompt talked something into running.
func assertNoCanaryFired(t *testing.T, canaryDir string) {
	t.Helper()
	fired, err := os.ReadDir(canaryDir)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range fired {
		t.Errorf("a shell expanded the prompt: it created %s", e.Name())
	}
}

// The engine is started as an argv vector: the exec target is the CLI itself, not a shell
// asked to interpret a command line Orbit built.
func TestSpawnClaudeExecsTheEngineWithNoShellInBetween(t *testing.T) {
	fake := newFakeClaude(t, fakeStep{Await: "user"})
	job := claudeSpawnJob(t)
	job.Prompt = injectionProbe(t.TempDir())
	rt, _ := startFakeRuntime(t, fake, job)

	cmd := rt.cmd
	if got := filepath.Base(cmd.Path); got != "claude" {
		t.Errorf("the exec target is %q (%s), want the claude binary", got, cmd.Path)
	}
	if len(cmd.Args) == 0 || cmd.Args[0] != "claude" {
		t.Fatalf("argv[0] is %v, want claude", cmd.Args)
	}
	for i, arg := range cmd.Args {
		switch filepath.Base(arg) {
		case "sh", "bash", "zsh", "ssh":
			t.Errorf("argv[%d] = %q puts a shell between Orbit and the engine (argv %v)", i, arg, cmd.Args)
		}
		if arg == "-c" || arg == "-lc" {
			t.Errorf("argv[%d] = %q is a shell command flag (argv %v)", i, arg, cmd.Args)
		}
	}
}

// A prompt made entirely of shell metacharacters reaches the CLI byte for byte on stdin,
// appears nowhere on the command line, and expands nowhere along the way — and the process
// it reaches is the same one before and after a `result`.
func TestClaudePromptCarriesShellMetacharactersToStdinAndNowhereElse(t *testing.T) {
	canaryDir := t.TempDir()
	probe := injectionProbe(canaryDir)
	fake := newFakeClaude(t,
		fakeStep{Await: "user"},
		fakeStep{Emit: "result", Text: "ok"},
		fakeStep{Await: "user"},
		fakeStep{Emit: "result", Text: "ok"},
	)
	job := claudeSpawnJob(t)
	job.Prompt, job.Title = probe, probe
	rt, frames := startFakeRuntime(t, fake, job)

	// Two turns, the second sent after the first turn's result: an SSH transport that put
	// the prompt in the remote command would have needed a second connection here.
	turns := []string{probe, probe + "\nand `touch " + filepath.Join(canaryDir, "separated") + "` again"}
	for _, turn := range turns {
		if err := rt.send(textFrame(turn)); err != nil {
			t.Fatalf("send(%q): %v", turn, err)
		}
		rt.beginTurn()
		waitFrameType(t, frames, "result")
		rt.endTurn()
	}

	spawns := fake.Spawns()
	if len(spawns) != 1 {
		t.Fatalf("claude was spawned %d time(s), want 1 for both turns", len(spawns))
	}
	if spawns[0].PID != rt.pid() {
		t.Errorf("the recorded process is pid %d, but the runtime holds pid %d", spawns[0].PID, rt.pid())
	}
	for i, arg := range spawns[0].Argv {
		if strings.Contains(arg, "touch") || strings.Contains(arg, probe) {
			t.Errorf("argv[%d] = %q carries the prompt (argv %v)", i, arg, spawns[0].Argv)
		}
	}
	// One whole, well-formed `user` frame per turn: a newline that reached stdin unescaped
	// would have split one of them, and Stdin() would have failed to parse the halves.
	stdin := fake.WaitStdin(len(turns))
	if len(stdin) != len(turns) {
		t.Errorf("%d frames reached stdin, want %d", len(stdin), len(turns))
	}
	for i, want := range turns {
		if got := stdin[i]["type"]; got != frameUser {
			t.Errorf("stdin frame %d is a %v, want a %s frame", i, got, frameUser)
		}
		if got := userFrameText(t, stdin[i]); got != want {
			t.Errorf("stdin frame %d carried %q, want %q", i, got, want)
		}
	}
	assertNoCanaryFired(t, canaryDir)
}
