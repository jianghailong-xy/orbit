//go:build linux || darwin

package main

import (
	"context"
	"encoding/json"
	"go/ast"
	"go/parser"
	"go/token"
	"go/types"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"
)

// No agent process is handed a person's access token (docs/personal-access-token-design.md §8): signing
// in on a runner machine is supported, and the agents that machine runs must not be able to borrow the key.
//
// Two halves. The census reads this package's source for every function that writes ORBIT_SESSION_ID into
// an environment — the mark of an environment an agent runs in, since neither `orbit mcp` nor the CLI can
// act for a session without it — and fails on any such function no case below builds. Each case then
// builds that environment for real, with one token in the runner's own environment and another in the
// agent's configuration, and reads back what the process was handed. So a new place that builds an agent's
// environment fails the census until it is a case, and as a case it fails unless what it builds went
// through userCredentialEnvKey.
//
// Each case is also held to the runner's mark (§7.2): the process it starts carries ORBIT_RUNNER_CHILD=1,
// once, though the runner's own environment and the agent's configuration both blank it — so the CLI there
// never acts as the login saved on the machine, session or no session. A terminal the runner did not start
// does not carry it, and acts as that login as before (runner_child_identity_test.go).

const (
	runnerUserToken    = "orbit_pat_held-by-the-runner-environment"
	agentUserToken     = "orbit_pat_held-by-the-agent-configuration"
	userTokenSessionID = "019fcbf3-0fa8-7f83-9302-46b25389cb16"
)

// userTokenEnvCase is one place that builds an agent's environment.
type userTokenEnvCase struct {
	name string
	// sites are the census entries ("file.go function") this case builds.
	sites []string
	// holds are entries the environment must have: it is the one the site builds, and where the site
	// inherits, it demonstrably did — so the tokens' absence is the site's doing, not the fixture's.
	holds []string
	env   func(t *testing.T, job *ClaimedSession, dir string) []string
}

func userTokenEnvCases() []userTokenEnvCase {
	session := "ORBIT_SESSION_ID=" + publicID(userTokenSessionID)
	runner, agent := "PAT_TEST_RUNNER_VALUE=runner", "PAT_TEST_AGENT_VALUE=agent"
	inherited := []string{session, runner, agent}
	ignore := func(string, map[string]interface{}) {}
	return []userTokenEnvCase{
		{
			name: "claude", sites: []string{"claude_spawn.go spawnClaude"}, holds: inherited,
			env: func(t *testing.T, job *ClaimedSession, dir string) []string {
				capture := fakeEngineCapturingEnv(t, "claude")
				proc, err := spawnClaude(context.Background(), job, dir, nil)
				if err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() { _ = proc.stdin.Close(); _ = proc.cmd.Wait() })
				return readCapturedEnv(t, capture)
			},
		},
		{
			// Built from nothing and two allowlists, so it inherits neither token; held to the rule all the same.
			name:  "claude wiki maintenance clean start",
			sites: []string{"claude_spawn.go spawnClaude", "wiki_maintenance_session.go wikiMaintenanceEnv"},
			holds: []string{session},
			env: func(t *testing.T, job *ClaimedSession, dir string) []string {
				capture := fakeEngineCapturingEnv(t, "claude")
				job.WikiMaintenance = &WikiMaintenanceRun{CleanStart: true}
				if err := prepareWikiMaintenanceStart(job, filepath.Join(dir, "scratch")); err != nil {
					t.Fatal(err)
				}
				proc, err := spawnClaude(context.Background(), job, dir, nil)
				if err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() { _ = proc.stdin.Close(); _ = proc.cmd.Wait() })
				return readCapturedEnv(t, capture)
			},
		},
		{
			name: "codex exec", sites: []string{"codex.go runCodexTurn"}, holds: inherited,
			env: func(t *testing.T, job *ClaimedSession, dir string) []string {
				capture := fakeEngineCapturingEnv(t, providerCodex)
				runCodexTurn(context.Background(), job, dir, "work", nil, ignore)
				return readCapturedEnv(t, capture)
			},
		},
		{
			// Handed the runner's environment with the agent's token on top, as a caller that dropped
			// nothing would hand it: the spawn drops them itself.
			name: "codex app-server", sites: []string{"codex_appserver.go startCodexAppServer"}, holds: []string{session, runner},
			env: func(t *testing.T, job *ClaimedSession, dir string) []string {
				capture := fakeEngineCapturingEnv(t, providerCodex)
				app, err := startCodexAppServer(context.Background(), job, dir, dir,
					append(os.Environ(), "ORBIT_USER_TOKEN="+agentUserToken), ignore, nil)
				if err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() { app.cancel(); _ = app.cmd.Wait() })
				return readCapturedEnv(t, capture)
			},
		},
		{
			name: "kimi", sites: []string{"kimi_acp.go startKimiACP"}, holds: inherited,
			env: func(t *testing.T, job *ClaimedSession, dir string) []string {
				capture := fakeEngineCapturingEnv(t, providerKimi)
				app, err := startKimiACP(context.Background(), NewTransport("http://127.0.0.1:1", "runner-token"),
					job, dir, filepath.Join(dir, "kimi-home"), ignore)
				if err != nil {
					t.Fatal(err)
				}
				t.Cleanup(app.close)
				return readCapturedEnv(t, capture)
			},
		},
		{
			name: "opencode", sites: []string{"opencode.go runOpenCodeTurn"}, holds: inherited,
			env: func(t *testing.T, job *ClaimedSession, dir string) []string {
				capture := fakeEngineCapturingEnv(t, providerOpenCode)
				runOpenCodeTurn(context.Background(), job, dir, dir, "work", nil, ignore)
				return readCapturedEnv(t, capture)
			},
		},
		{
			// The block OpenCode adds, for `orbit mcp`, to the environment it was itself started with.
			name: "opencode orbit MCP server", sites: []string{"opencode.go openCodeConfigContent"}, holds: []string{session},
			env: func(t *testing.T, job *ClaimedSession, dir string) []string {
				content, err := openCodeConfigContent(job, dir, "orbit", nil)
				if err != nil {
					t.Fatal(err)
				}
				var config struct {
					MCP map[string]struct {
						Environment map[string]string `json:"environment"`
					} `json:"mcp"`
				}
				if err := json.Unmarshal([]byte(content), &config); err != nil {
					t.Fatalf("generated OpenCode config is not JSON: %v", err)
				}
				var env []string
				for key, value := range config.MCP["orbit"].Environment {
					env = append(env, key+"="+value)
				}
				return env
			},
		},
		{
			name: "antigravity", sites: []string{"antigravity.go antigravityEnv"}, holds: inherited,
			env: func(t *testing.T, job *ClaimedSession, dir string) []string {
				return antigravityEnv(job, dir)
			},
		},
		{
			name: "antigravity google sign-in", sites: []string{"antigravity.go antigravityEnv"}, holds: inherited,
			env: func(t *testing.T, job *ClaimedSession, dir string) []string {
				return antigravityGoogleEnv(antigravityEnv(job, dir), filepath.Join(dir, "gemini"))
			},
		},
		{
			// dsh starts its stdio servers from the declared environment alone, so this is the whole of it.
			name: "dsh orbit MCP server", sites: []string{"dsh_mcp.go dshOrbitMCPEnv"}, holds: []string{session},
			env: func(t *testing.T, job *ClaimedSession, dir string) []string {
				var env []string
				for _, pair := range dshOrbitMCPEnv(job) {
					env = append(env, pair["name"]+"="+pair["value"])
				}
				return env
			},
		},
		{
			// Not in the census: dsh itself is handed no session context, its orbit MCP server is (above).
			// Its environment is an allowlist, held to the rule all the same.
			name: "dsh", holds: []string{"DSH_PERMISSION_MODE=read-only"},
			env: func(t *testing.T, job *ClaimedSession, dir string) []string {
				exe, err := os.Executable()
				if err != nil {
					t.Fatal(err)
				}
				spec, err := prepareDshAgentConfigAt(DshLaunchInput{
					OrbitSessionID: job.SessionID, ExecutionDir: dir, APIKey: "sk-user-token-env",
					BaseURL: "http://127.0.0.1:9", FileMode: "read-only",
				}, &DshAgentOverlay{}, exe, filepath.Join(dir, "dsh-home"))
				if err != nil {
					t.Fatal(err)
				}
				return spec.Env
			},
		},
		{
			name: "runner-hosted background job", sites: []string{"background_job.go (*bgTailer).startJob"}, holds: inherited,
			env: func(t *testing.T, job *ClaimedSession, dir string) []string {
				bg := newBgTailer(context.Background(), ignore, nil)
				t.Cleanup(bg.stopAll)
				capture := filepath.Join(dir, "job.env")
				if _, err := bg.startJob(bgJobSpec{
					Command: captureEnvCommand(capture), Kind: bgKindJob, Dir: dir, ScratchDir: dir,
					SessionID: job.SessionID, Env: job.Agent.Env,
				}); err != nil {
					t.Fatal(err)
				}
				return readCapturedEnv(t, capture)
			},
		},
		{
			// Not in the census: a shell turn carries no session context. It is where a `!` command and an
			// EXECUTABLE acceptance command run, and an agent can write the latter.
			name: "shell turn", holds: []string{runner, agent},
			env: func(t *testing.T, job *ClaimedSession, dir string) []string {
				out, exit := runShellTurn(context.Background(), dir, "/usr/bin/env", ignore, "user-token-env",
					job.Agent.Env, shellTurnTimeout)
				if exit != 0 {
					t.Fatalf("env exited %d: %s", exit, out)
				}
				return strings.Split(out, "\n")
			},
		},
		{
			// Not in the census either: the base every inheriting spawn above starts from, and the whole of
			// what a person's background shell and the runner's own engine probes are given.
			name: "envWithAgent", holds: []string{runner, agent},
			env: func(t *testing.T, job *ClaimedSession, dir string) []string {
				return envWithAgent(job.Agent.Env)
			},
		},
	}
}

func TestAgentEnvironmentsWithholdUserCredentials(t *testing.T) {
	cases := userTokenEnvCases()

	t.Run("census", func(t *testing.T) {
		writers := sessionContextWriters(t)
		built := map[string]bool{}
		for _, c := range cases {
			for _, site := range c.sites {
				built[site] = true
				if !writers[site] {
					t.Errorf("case %q builds %s, which the census no longer finds writing ORBIT_SESSION_ID: "+
						"point the case at where that environment is built now", c.name, site)
				}
			}
		}
		sites := make([]string, 0, len(writers))
		for site := range writers {
			sites = append(sites, site)
		}
		sort.Strings(sites)
		for _, site := range sites {
			if !built[site] {
				t.Errorf("%s writes ORBIT_SESSION_ID into an environment that no case here builds: add a case "+
					"that builds it, and build it on envWithAgent or pass it through withoutUserCredentials "+
					"before the session's ORBIT_* go on", site)
			}
		}
	})

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			dir := t.TempDir()
			t.Setenv("ORBIT_HOME", filepath.Join(dir, "orbit-home"))
			t.Setenv("ORBIT_USER_TOKEN", runnerUserToken)
			t.Setenv("PAT_TEST_RUNNER_VALUE", "runner")
			// Blank, which the CLI reads as unmarked: inherited, it would leave the process the person's.
			t.Setenv(envRunnerChild, "")
			job := &ClaimedSession{
				SessionID: userTokenSessionID, SessionUUID: userTokenSessionID,
				AgentID: "31111111-2222-4333-8444-555555555555", TaskID: "21111111-2222-4333-8444-555555555555",
				Agent: AgentExecConfig{Model: "model", PermissionMode: "dontAsk", Env: map[string]string{
					"ORBIT_USER_TOKEN":     agentUserToken,
					"PAT_TEST_AGENT_VALUE": "agent",
					envRunnerChild:         "",
				}},
			}
			env := c.env(t, job, dir)
			for _, want := range c.holds {
				if !containsString(env, want) {
					t.Fatalf("the environment lacks %q, so it is not the one this site builds: %q", want, env)
				}
			}
			var marks []string
			for _, entry := range env {
				key, _, _ := strings.Cut(entry, "=")
				if strings.EqualFold(key, "ORBIT_USER_TOKEN") {
					t.Errorf("the environment holds %q", entry)
				} else if strings.Contains(entry, runnerUserToken) || strings.Contains(entry, agentUserToken) {
					t.Errorf("the environment carries a user token under another name: %q", entry)
				}
				if strings.EqualFold(key, envRunnerChild) {
					marks = append(marks, entry)
				}
			}
			if len(marks) != 1 || marks[0] != envRunnerChild+"=1" {
				t.Errorf("the process is marked %q, want %s=1 alone: build it on envWithAgent or runnerChildEnv, "+
					"or say it where the environment is built from nothing", marks, envRunnerChild)
			}
		})
	}

	// The same login shell a shell turn runs, started with the machine's own environment rather than one the
	// runner built: nothing on the way in — the shell's profile included — marks it.
	t.Run("a terminal the runner did not start", func(t *testing.T) {
		if _, inherited := os.LookupEnv(envRunnerChild); inherited {
			t.Fatalf("the suite's own environment holds %s: clearCallingSession should have dropped it", envRunnerChild)
		}
		cmd := exec.Command("bash", "-lc", "/usr/bin/env")
		cmd.Env = os.Environ()
		out, err := cmd.Output()
		if err != nil {
			t.Fatalf("bash -lc env: %v", err)
		}
		for _, entry := range strings.Split(string(out), "\n") {
			if key, _, _ := strings.Cut(entry, "="); strings.EqualFold(key, envRunnerChild) {
				t.Errorf("a terminal the runner did not start is marked: %q", entry)
			}
		}
	})
}

// sessionContextWriters is every function in this package, tests aside, that writes ORBIT_SESSION_ID into an
// environment, as "file.go function" ("file.go (*T).method" for a method). A string literal naming the
// variable counts unless it is read (os.Getenv, os.LookupEnv, envValue) or matched by a switch case
// (sessionContextEnvKey): a shape this does not know is counted, not missed.
func sessionContextWriters(t *testing.T) map[string]bool {
	t.Helper()
	files, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	fset := token.NewFileSet()
	writers := map[string]bool{}
	for _, name := range files {
		if strings.HasSuffix(name, "_test.go") {
			continue
		}
		file, err := parser.ParseFile(fset, name, nil, parser.SkipObjectResolution)
		if err != nil {
			t.Fatal(err)
		}
		for _, decl := range file.Decls {
			fn, ok := decl.(*ast.FuncDecl)
			if !ok {
				if writesSessionContext(decl) {
					t.Errorf("%s names ORBIT_SESSION_ID outside a function, where the census cannot follow it "+
						"to the environment it ends up in", fset.Position(decl.Pos()))
				}
				continue
			}
			if fn.Body != nil && writesSessionContext(fn.Body) {
				writers[name+" "+funcDeclName(fn)] = true
			}
		}
	}
	return writers
}

// writesSessionContext reports whether node holds a string literal that writes ORBIT_SESSION_ID: one that
// starts "ORBIT_SESSION_ID=", or the bare name anywhere but a read or a switch case.
func writesSessionContext(node ast.Node) bool {
	found := false
	var parents []ast.Node
	ast.Inspect(node, func(n ast.Node) bool {
		if n == nil {
			parents = parents[:len(parents)-1]
			return true
		}
		if lit, ok := n.(*ast.BasicLit); ok && lit.Kind == token.STRING {
			value, _ := strconv.Unquote(lit.Value)
			if strings.HasPrefix(value, "ORBIT_SESSION_ID=") ||
				value == "ORBIT_SESSION_ID" && (len(parents) == 0 || !readsOrMatches(parents[len(parents)-1])) {
				found = true
			}
		}
		parents = append(parents, n)
		return true
	})
	return found
}

// readsOrMatches reports whether a bare ORBIT_SESSION_ID directly under parent is read or matched rather
// than written.
func readsOrMatches(parent ast.Node) bool {
	switch p := parent.(type) {
	case *ast.CaseClause:
		return true
	case *ast.CallExpr:
		switch fun := p.Fun.(type) {
		case *ast.SelectorExpr:
			pkg, _ := fun.X.(*ast.Ident)
			return pkg != nil && pkg.Name == "os" && (fun.Sel.Name == "Getenv" || fun.Sel.Name == "LookupEnv")
		case *ast.Ident:
			return fun.Name == "envValue"
		}
	}
	return false
}

func funcDeclName(fn *ast.FuncDecl) string {
	if fn.Recv == nil || len(fn.Recv.List) == 0 {
		return fn.Name.Name
	}
	recv := types.ExprString(fn.Recv.List[0].Type)
	if strings.HasPrefix(recv, "*") {
		recv = "(" + recv + ")"
	}
	return recv + "." + fn.Name.Name
}

// fakeEngineCapturingEnv puts a `name` first on PATH that writes the environment it was started with to a
// file and exits, and returns that file. Its paths are absolute, so it works under whatever PATH a site
// hands its process.
func fakeEngineCapturingEnv(t *testing.T, name string) string {
	t.Helper()
	bin := t.TempDir()
	capture := filepath.Join(bin, name+".env")
	writeFakeBin(t, bin, name, captureEnvCommand(capture))
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	return capture
}

// captureEnvCommand is a shell command that writes its environment to capture, whole or not at all.
func captureEnvCommand(capture string) string {
	return "/usr/bin/env > '" + capture + ".partial' && /bin/mv '" + capture + ".partial' '" + capture + "'"
}

// readCapturedEnv waits for what captureEnvCommand wrote.
func readCapturedEnv(t *testing.T, capture string) []string {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		data, err := os.ReadFile(capture)
		if err == nil {
			return strings.Split(strings.TrimRight(string(data), "\n"), "\n")
		}
		if time.Now().After(deadline) {
			t.Fatalf("the process never reported its environment: %v", err)
		}
		time.Sleep(10 * time.Millisecond)
	}
}
