//go:build linux || darwin

package main

import (
	"fmt"
	"path/filepath"
	"testing"
)

// A step whose command exits 0 while a child it started still holds the output pipe is a SUCCESS
// with a child left behind — not a failure, and the child is not the job's to leave running.
//
// exec.Cmd.Wait answers exec.ErrWaitDelay for exactly that shape (WaitDelay is what
// configureSessionProcessTree sets). Read as an ordinary error it became ERROR /
// CHECK_TREE_UNPREPARED for the tree's recipe and CHECK_FAILED for a check, both of them false reds
// about work that was fine, and the child survived the step it was holding the output of.

func waitDelayRecipe(t *testing.T, pidFile string) string {
	t.Helper()
	return fmt.Sprintf("#!/usr/bin/env bash\nsleep 300 &\necho $! > %q\nexit 0\n", pidFile)
}

// TestARecipeThatExitsZeroWithAChildHoldingTheOutputIsPrepared is the prepare half: the tree's own
// recipe (scripts/worktree-overlay.sh) exits 0, its child keeps the pipe open, and the job must go
// on to its checks rather than answer CHECK_TREE_UNPREPARED.
func TestARecipeThatExitsZeroWithAChildHoldingTheOutputIsPrepared(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	r := newIntegrationRepo(t)
	pidFile := filepath.Join(t.TempDir(), "recipe-child.pid")
	r.writeIn("scripts/worktree-overlay.sh", waitDelayRecipe(t, pidFile))
	r.commit("the environment recipe")
	r.checkoutNew("project/line", "main")
	r.push("project/line")
	r.checkoutNew("task/recipe", "main")
	r.write("recipe.txt", "the task's work\n")
	r.commit("task work")
	r.push("task/recipe")
	r.checkout("main")

	check := IntegrationCheckSpec{Name: "MERGE_CHECK", Command: "test -f recipe.txt", ExpectedExitCode: 0, TimeoutSeconds: 60}
	result := runIntegrationJob(r.command("task/recipe", "project/line", check), silent)
	if result.State != "LANDED" {
		t.Fatalf("state = %s (%s %s), want LANDED: the recipe exited 0", result.State, result.ErrorCode, result.Phase)
	}
	if len(result.Checks) != 1 || result.Checks[0].ExitCode == nil || *result.Checks[0].ExitCode != 0 {
		t.Fatalf("checks = %+v, want the check to have run and passed", result.Checks)
	}
	child := waitForPID(t, pidFile)
	if !processEnded(child) {
		t.Fatalf("the recipe's child %d outlived the step", child)
	}
}

// TestACheckThatExitsZeroWithAChildHoldingTheOutputIsNotAFailure is the check half: the command exits
// 0 while its child holds the pipe, and that is an exit code of 0 rather than a check with none at
// all — which the expected-exit-code comparison would read as a failure.
func TestACheckThatExitsZeroWithAChildHoldingTheOutputIsNotAFailure(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	r := newIntegrationRepo(t)
	r.checkoutNew("project/line", "main")
	r.push("project/line")
	r.checkoutNew("task/check-child", "main")
	r.write("check.txt", "the task's work\n")
	r.commit("task work")
	r.push("task/check-child")
	r.checkout("main")

	pidFile := filepath.Join(t.TempDir(), "check-child.pid")
	check := IntegrationCheckSpec{
		Name:             "TASK_ACCEPTANCE",
		Command:          fmt.Sprintf("sleep 300 &\necho $! > %q\nexit 0", pidFile),
		ExpectedExitCode: 0,
		TimeoutSeconds:   60,
	}
	result := runIntegrationJob(r.command("task/check-child", "project/line", check), silent)
	if result.State != "LANDED" {
		t.Fatalf("state = %s (%s %s), want LANDED: the check exited 0", result.State, result.ErrorCode, result.Phase)
	}
	if len(result.Checks) != 1 {
		t.Fatalf("checks = %+v, want one", result.Checks)
	}
	if result.Checks[0].TimedOut || result.Checks[0].ExitCode == nil || *result.Checks[0].ExitCode != 0 {
		t.Fatalf("check = %+v, want exit 0 and no timeout", result.Checks[0])
	}
	child := waitForPID(t, pidFile)
	if !processEnded(child) {
		t.Fatalf("the check's child %d outlived the step", child)
	}
}
