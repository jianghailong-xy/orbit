//go:build linux || darwin

package main

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"testing"
)

// A process the runner starts acts as its session or as the machine, never as the person whose login is
// saved on the machine (docs/personal-access-token-design.md §7.2). What made it matter: once the runner's
// OS user has run `orbit login` in the runner's own ORBIT_HOME (§8), the shell an EXECUTABLE acceptance
// command or a `!` command runs in, which carries no session, fell to that login — `orbit task list` went
// to the person's routes with their personal access token, and `orbit wiki check` and `orbit wiki plan
// check`, which act only as the machine, were refused, so every Wiki maintenance and plan task failed its
// acceptance.
//
// Held end to end: the commands run in real shell turns, with this test binary as the `orbit` they call
// (TestMain), against two control planes — the one the saved login names and the one config.json names.
// The same commands in the same login shell, started with the machine's own environment rather than one
// the runner built, act as the person, as before.

// answerAsRunnerRoutes answers as the runner door does, to the runner's credential alone: the task list,
// and the check of a plan job that stored its draft.
func answerAsRunnerRoutes(r apiRequest) (int, string) {
	if r.authorization != "Bearer runner-secret" {
		return http.StatusUnauthorized, `{"message":"invalid runner token","statusCode":401}`
	}
	switch {
	case r.method == http.MethodGet && r.path == "/api/runner/tasks":
		return http.StatusOK, `[{"id":"t1","title":"first"}]`
	case r.method == http.MethodGet && r.path == "/api/runner/wiki/spaces/space-1/plan/check" && r.query == "jobId=job-1":
		return http.StatusOK, `{"spaceId":"space-1","jobId":"job-1","kind":"draft","outcome":"succeeded","version":2,"ok":true,"problems":[]}`
	}
	return http.StatusNotFound, `{"message":"no such runner route","statusCode":404}`
}

// aRunnerWithASavedLogin is a runner machine whose ORBIT_HOME holds both the runner's config.json and the
// login its OS user saved there, each naming a control plane of its own; and the CLI, quoted for a shell.
func aRunnerWithASavedLogin(t *testing.T) (user, runner *recordingAPI, orbit string) {
	t.Helper()
	userModeEnv(t)
	user = newRecordingAPI(t, answerAsUserRoutes)
	runner = newRecordingAPI(t, answerAsRunnerRoutes)
	if err := saveConfig(&RunnerConfig{ServerURL: runner.URL, RunnerID: "runner-1", RunnerToken: "runner-secret", Name: "box"}); err != nil {
		t.Fatal(err)
	}
	loggedIn(t, user.URL, laptopToken)
	return user, runner, shellQuote(orbitCLIExecutable())
}

const planCheckArgs = " wiki plan check --space space-1 --job job-1"

func TestRunnerStartedShellsActAsTheMachineBesideASavedLogin(t *testing.T) {
	t.Run("the acceptance shell", func(t *testing.T) {
		user, runner, orbit := aRunnerWithASavedLogin(t)
		acceptance := func(command string) (int, string) {
			t.Helper()
			turn := runAcceptanceShellTurn(t, &RunInboxResponse{TurnID: "acceptance", Kind: "shell", Content: command, TaskAcceptance: true})
			return *turn.ShellExitCode, *turn.ShellOutput
		}

		exit, out := acceptance(orbit + " task list --json")
		if exit != 0 || !strings.Contains(out, `[{"id":"t1","title":"first"}]`) {
			t.Fatalf("orbit task list exited %d:\n%s", exit, out)
		}
		if got := strings.Count(out, "ignoring the personal access token on this machine"); got != 1 || !strings.Contains(out, "ORBIT_RUNNER_CHILD") {
			t.Errorf("the saved login was passed over without saying so once (%d):\n%s", got, out)
		}
		seen := runner.seen()
		if len(seen) != 1 || seen[0].method != http.MethodGet || seen[0].path != "/api/runner/tasks" ||
			seen[0].authorization != "Bearer runner-secret" || seen[0].sessionHeader != "" {
			t.Errorf("orbit task list sent the runner's control plane %+v, want one GET /api/runner/tasks with the runner credential", seen)
		}

		exit, out = acceptance(orbit + planCheckArgs)
		if exit != 0 || !strings.Contains(out, "plan job job-1 stored version 2") || strings.Contains(out, "does not run as you") {
			t.Fatalf("orbit wiki plan check exited %d:\n%s", exit, out)
		}
		seen = runner.seen()
		if len(seen) != 2 || seen[1].path != "/api/runner/wiki/spaces/space-1/plan/check" || seen[1].authorization != "Bearer runner-secret" {
			t.Errorf("the runner's control plane was sent %+v, want the plan check last, with the runner credential", seen)
		}

		if got := user.seen(); len(got) != 0 {
			t.Errorf("the person's control plane was sent %+v", got)
		}
	})

	// A `!` command runs in a shell turn built the same way; `orbit whoami` there says who it is and why.
	t.Run("a ! shell", func(t *testing.T) {
		user, runner, orbit := aRunnerWithASavedLogin(t)
		out, exit := runShellTurn(context.Background(), t.TempDir(), orbit+" whoami --json",
			func(string, map[string]interface{}) {}, "bang", nil, shellTurnTimeout)
		if exit != 0 {
			t.Fatalf("orbit whoami exited %d:\n%s", exit, out)
		}
		var identity map[string]interface{}
		for _, line := range strings.Split(out, "\n") {
			if strings.HasPrefix(line, "{") {
				if err := json.Unmarshal([]byte(line), &identity); err != nil {
					t.Fatalf("whoami --json printed %q: %v", line, err)
				}
			}
		}
		reason, _ := identity["reason"].(string)
		if identity["kind"] != identityRunner || identity["runnerId"] != "runner-1" || identity["userTokenIgnored"] != true ||
			!strings.Contains(reason, "ORBIT_RUNNER_CHILD") {
			t.Errorf("whoami in a ! shell = %v, want the runner, the saved login ignored and the mark named as the reason", identity)
		}
		if got := append(user.seen(), runner.seen()...); len(got) != 0 {
			t.Errorf("whoami of the runner sent %+v", got)
		}
	})

	// The same login shell, in a terminal the runner did not start: the order of §7.2, unchanged.
	t.Run("a terminal the runner did not start", func(t *testing.T) {
		user, runner, orbit := aRunnerWithASavedLogin(t)
		os.Unsetenv(envRunnerChild) // userModeEnv blanked it; a terminal has none at all
		terminal := func(command string) (int, string) {
			t.Helper()
			cmd := exec.Command("bash", "-lc", command)
			cmd.Dir, cmd.Env = t.TempDir(), os.Environ()
			out, err := cmd.CombinedOutput()
			if exit, ok := err.(*exec.ExitError); ok {
				return exit.ExitCode(), string(out)
			} else if err != nil {
				t.Fatalf("%s: %v", command, err)
			}
			return 0, string(out)
		}

		exit, out := terminal(orbit + " task list --json")
		if exit != 0 || !strings.Contains(out, `[{"id":"t1","title":"first"}]`) || strings.Contains(out, "ignoring the personal access token") {
			t.Fatalf("orbit task list in a terminal exited %d:\n%s", exit, out)
		}
		seen := user.seen()
		if len(seen) != 1 || seen[0].path != "/api/tasks/page" || seen[0].authorization != "Bearer "+laptopToken {
			t.Errorf("orbit task list in a terminal sent the person's control plane %+v, want GET /api/tasks/page with the saved token", seen)
		}

		exit, out = terminal(orbit + planCheckArgs)
		if exit == 0 || !strings.Contains(out, "does not run as you") {
			t.Errorf("orbit wiki plan check ran as the person in a terminal (exit %d):\n%s", exit, out)
		}
		if got := runner.seen(); len(got) != 0 {
			t.Errorf("a terminal used the runner's credential: %+v", got)
		}
		if got := user.seen(); len(got) != 1 {
			t.Errorf("the person's control plane was sent %+v, want the task list alone: a refused command sends nothing", got)
		}
	})
}
