package main

import (
	"encoding/json"
	"os"
	"regexp"
	"sort"
	"strings"
	"testing"
	"time"
)

const capabilityTestExe = "/usr/local/bin/orbit"

// capabilityHeadlessContext is a process outside any session with nothing in its environment; the
// caller adds the credential the scenario is about.
func capabilityHeadlessContext(t *testing.T, registered bool) {
	t.Helper()
	home := t.TempDir()
	t.Setenv("ORBIT_HOME", home)
	for _, name := range []string{"ORBIT_SESSION_ID", "ORBIT_AGENT_ID", "ORBIT_TASK_ID", envOrchestrationToken,
		envUserToken, envServiceToken, envRunnerChild, envWatches, envWiki} {
		t.Setenv(name, "")
	}
	t.Setenv(envMCPOrchestration, "")
	if registered {
		if err := saveConfig(&RunnerConfig{ServerURL: "http://127.0.0.1:1", RunnerID: "runner-1", RunnerToken: "runner-token", Name: "test"}); err != nil {
			t.Fatal(err)
		}
	}
}

type capabilityReading struct {
	doc       cliCapabilitiesDocument
	listed    map[string]cliCapability
	withheld  map[string]cliCapability
	listedIDs []string
}

func readCapabilities(t *testing.T) capabilityReading {
	t.Helper()
	doc := buildCLICapabilities(capabilityTestExe)
	r := capabilityReading{doc: doc, listed: map[string]cliCapability{}, withheld: map[string]cliCapability{}}
	for _, c := range doc.Capabilities {
		if _, dup := r.listed[c.ID]; dup {
			t.Fatalf("%s is listed twice", c.ID)
		}
		r.listed[c.ID] = c
		r.listedIDs = append(r.listedIDs, c.ID)
	}
	for _, c := range doc.UnavailableCapabilities {
		if _, dup := r.withheld[c.ID]; dup {
			t.Fatalf("%s is in unavailableCapabilities twice", c.ID)
		}
		r.withheld[c.ID] = c
	}
	return r
}

// code is the stable reason a command cannot run here, "" when it can.
func (r capabilityReading) code(t *testing.T, id string) string {
	t.Helper()
	listed, isListed := r.listed[id]
	withheld, isWithheld := r.withheld[id]
	switch {
	case isListed && listed.Available:
		if isWithheld {
			t.Fatalf("%s is available and also in unavailableCapabilities", id)
		}
		return ""
	case isListed:
		if !isWithheld || withheld.UnavailableCode != listed.UnavailableCode {
			t.Fatalf("%s is listed unavailable (%s) but unavailableCapabilities says %q", id, listed.UnavailableCode, withheld.UnavailableCode)
		}
		return listed.UnavailableCode
	case isWithheld:
		return withheld.UnavailableCode
	}
	t.Fatalf("%s is neither in capabilities nor in unavailableCapabilities", id)
	return ""
}

// The credential scenarios the document has to tell apart (docs/orbit-agent-contract.md §2.5): what
// it says runs is what runs, and what it says does not carries the reason that is actually true.
func TestCapabilitiesAnswerEachCredentialScenarioAccurately(t *testing.T) {
	type want map[string]string // capability id -> code ("" = available)
	cases := []struct {
		name  string
		setup func(t *testing.T)
		want  want
	}{
		{
			name: "valid service token with one scope",
			setup: func(t *testing.T) {
				capabilityHeadlessContext(t, true)
				t.Setenv(envServiceToken, fakeServiceToken(t, []string{"session:list"}, "agent-1", time.Hour))
			},
			want: want{
				"session_list":   "",
				"session_create": capabilityServiceTokenScopeMissing,
				"session_send":   capabilityServiceTokenScopeMissing,
				"session_end":    capabilityNoSessionContext,
				"agent_list":     capabilityNoSessionContext,
				"task_get":       "",
				"watch_create":   capabilityNoSessionContext,
				"api":            capabilityRequiresUserLogin,
				"whoami":         "",
			},
		},
		{
			name: "valid service token on a machine with no runner credential",
			setup: func(t *testing.T) {
				capabilityHeadlessContext(t, false)
				t.Setenv(envServiceToken, fakeServiceToken(t, []string{"session:list", "session:create"}, "agent-1", time.Hour))
			},
			want: want{
				"session_list":   capabilityRunnerNotRegistered,
				"session_create": capabilityRunnerNotRegistered,
				"task_get":       capabilityRunnerNotRegistered,
				"login":          "",
				"whoami":         "",
			},
		},
		{
			name: "invalid service token",
			setup: func(t *testing.T) {
				capabilityHeadlessContext(t, true)
				t.Setenv(envServiceToken, "not-a-token")
			},
			want: want{
				"session_list":   capabilityTokenInvalid,
				"session_get":    capabilityTokenInvalid,
				"session_send":   capabilityTokenInvalid,
				"session_create": capabilityTokenInvalid,
				"session_end":    capabilityNoSessionContext,
				// The task commands send with the runner credential, not the token.
				"task_get": "",
			},
		},
		{
			name: "expired service token",
			setup: func(t *testing.T) {
				capabilityHeadlessContext(t, true)
				t.Setenv(envServiceToken, fakeServiceToken(t, []string{"session:list", "session:get"}, "agent-1", -time.Minute))
			},
			want: want{
				"session_list": capabilityTokenExpired,
				"session_get":  capabilityTokenExpired,
				"task_get":     "",
			},
		},
		{
			name:  "no credential at all",
			setup: func(t *testing.T) { capabilityHeadlessContext(t, false) },
			want: want{
				"task_get":     capabilityRunnerNotRegistered,
				"task_create":  capabilityRunnerNotRegistered,
				"session_list": capabilityRunnerNotRegistered,
				"api":          capabilityRequiresUserLogin,
				"login":        "",
			},
		},
		{
			name:  "headless on the runner credential",
			setup: func(t *testing.T) { capabilityHeadlessContext(t, true) },
			want: want{
				"task_get":       "",
				"session_list":   "",
				"session_create": capabilityNoSessionContext,
				"agent_list":     capabilityNoSessionContext,
				"watch_create":   capabilityNoSessionContext,
				"project_send":   capabilityNoSessionContext,
			},
		},
		{
			name: "the person's own token",
			setup: func(t *testing.T) {
				capabilityHeadlessContext(t, false)
				t.Setenv(envUserToken, "orbit_pat_test")
			},
			want: want{
				"api":        "",
				"agent_list": capabilityNotAvailableAsUser,
				"task_get":   "",
			},
		},
		{
			name: "a session with orchestration off",
			setup: func(t *testing.T) {
				catalogFullestCLIContext(t)
				t.Setenv(envMCPOrchestration, "false")
			},
			want: want{
				"task_create":           "",
				"session_create":        capabilityOrchestrationDisabled,
				"session_list":          capabilityOrchestrationDisabled,
				"agent_update":          capabilityOrchestrationDisabled,
				"runner_list":           capabilityOrchestrationDisabled,
				"project_send":          capabilityOrchestrationDisabled,
				"project_get":           "",
				"login":                 capabilityHumanOnly,
				"api":                   capabilityHumanOnly,
				"watch_create":          "",
				"wiki_search":           "",
				"session_await":         capabilityOrchestrationDisabled,
				"project_request_start": "",
			},
		},
		{
			name: "a session spawned with watches and the wiki off",
			setup: func(t *testing.T) {
				catalogFullestCLIContext(t)
				t.Setenv(envWatches, "off")
				t.Setenv(envWiki, "off")
			},
			want: want{
				"watch_create":   capabilityWatchesOff,
				"task_await":     capabilityWatchesOff,
				"session_await":  capabilityWatchesOff,
				"wiki_search":    capabilityWikiOff,
				"session_create": "",
			},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			tc.setup(t)
			r := readCapabilities(t)
			for id, wantCode := range tc.want {
				if got := r.code(t, id); got != wantCode {
					detail := r.withheld[id].UnavailableReason
					t.Errorf("%s: code %q, want %q (%s)", id, got, wantCode, detail)
				}
			}
		})
	}
}

// capabilityContexts is every shape of process the document is read in.
var capabilityContexts = []struct {
	name  string
	setup func(t *testing.T)
}{
	{"session, fullest", catalogFullestCLIContext},
	{"session, orchestration off", func(t *testing.T) { catalogFullestCLIContext(t); t.Setenv(envMCPOrchestration, "false") }},
	{"session, switches off", func(t *testing.T) {
		catalogFullestCLIContext(t)
		t.Setenv(envWatches, "off")
		t.Setenv(envWiki, "off")
	}},
	{"headless, runner credential", func(t *testing.T) { capabilityHeadlessContext(t, true) }},
	{"headless, nothing", func(t *testing.T) { capabilityHeadlessContext(t, false) }},
	{"headless, scoped token", func(t *testing.T) {
		capabilityHeadlessContext(t, true)
		t.Setenv(envServiceToken, fakeServiceToken(t, []string{"session:get", "session:send"}, "agent-1", time.Hour))
	}},
	{"headless, invalid token", func(t *testing.T) { capabilityHeadlessContext(t, true); t.Setenv(envServiceToken, "x.y.z") }},
	{"headless, expired token", func(t *testing.T) {
		capabilityHeadlessContext(t, true)
		t.Setenv(envServiceToken, fakeServiceToken(t, []string{"session:create"}, "agent-1", -time.Hour))
	}},
	{"person", func(t *testing.T) { capabilityHeadlessContext(t, true); t.Setenv(envUserToken, "orbit_pat_test") }},
}

// Every catalogue command is answered for in every context: listed, or in unavailableCapabilities
// with one of the stable codes — never dropped without a word — and every entry declares the same
// contract fields whichever list it is in. The one exception is the Orbit Cloud browser's commands in a
// session spawned with its switch off: off means absent, so they are in neither list (browser_tools.go).
func TestEveryWithheldCapabilityHasAStableReason(t *testing.T) {
	known := map[string]bool{}
	for _, code := range capabilityUnavailableCodes {
		known[code] = true
	}
	for _, ctx := range capabilityContexts {
		t.Run(ctx.name, func(t *testing.T) {
			ctx.setup(t)
			r := readCapabilities(t)
			for _, op := range operationCatalog().Ops {
				if op.CLI == nil {
					continue
				}
				if browserOpAbsent(op) {
					if _, listed := r.listed[op.Tool]; listed {
						t.Errorf("%s is listed with the browser switch off", op.Tool)
					}
					if _, withheld := r.withheld[op.Tool]; withheld {
						t.Errorf("%s is in unavailableCapabilities with the browser switch off", op.Tool)
					}
					continue
				}
				code := r.code(t, op.Tool)
				if code == "" {
					continue
				}
				if !known[code] {
					t.Errorf("%s: unavailableCode %q is not one of the stable codes", op.Tool, code)
				}
				entry := r.withheld[op.Tool]
				if entry.UnavailableReason == "" || entry.UnavailableReason == "not offered to this process" {
					t.Errorf("%s (%s) has no reason of its own: %q", op.Tool, code, entry.UnavailableReason)
				}
			}
			for _, entry := range append(append([]cliCapability{}, r.doc.Capabilities...), r.doc.UnavailableCapabilities...) {
				if entry.Argv[0] != capabilityTestExe || len(entry.Argv) < 2 {
					t.Errorf("%s argv %v does not start with the absolute executable", entry.ID, entry.Argv)
				}
				if entry.MCPInputSchema == nil {
					t.Errorf("%s declares no input schema", entry.ID)
				}
				if entry.RetryPolicy.OnNoAnswer == "" || entry.Interaction == "" || entry.Availability.CLI == "" {
					t.Errorf("%s does not declare retryPolicy, interaction and availability: %+v %q %+v",
						entry.ID, entry.RetryPolicy, entry.Interaction, entry.Availability)
				}
				if (entry.Idempotency == idempotencyCallerKey) != (entry.IdempotencyArg != nil) {
					t.Errorf("%s: idempotency %s but idempotencyArg %+v", entry.ID, entry.Idempotency, entry.IdempotencyArg)
				}
			}
		})
	}
}

// The argument a caller_key operation is keyed by is real on both surfaces: a property of its MCP
// schema and a flag its CLI parses (or, for a reply, the request it answers).
func TestIdempotencyArgNamesARealArgument(t *testing.T) {
	for _, op := range operationCatalog().Ops {
		arg := op.idempotencyArg()
		if op.Idempotency != idempotencyCallerKey {
			if arg != nil {
				t.Errorf("%s is %s but declares idempotencyArg %+v", op.Tool, op.Idempotency, arg)
			}
			continue
		}
		if arg == nil {
			t.Errorf("%s is caller_key and names no argument that carries the key", op.Tool)
			continue
		}
		if op.MCP != nil {
			props, _ := op.MCP.InputSchema["properties"].(map[string]interface{})
			if _, ok := props[arg.MCP]; !ok {
				t.Errorf("%s: idempotencyArg.mcp %q is not in its input schema", op.Tool, arg.MCP)
			}
		}
		if op.CLI != nil {
			if arg.CLI == "" {
				t.Errorf("%s has a CLI command and no CLI idempotency argument", op.Tool)
			} else if strings.HasPrefix(arg.CLI, "--") && !strings.Contains(strings.Join(op.CLI.Arguments, "\n"), arg.CLI) {
				t.Errorf("%s: idempotencyArg.cli %q is not among its arguments", op.Tool, arg.CLI)
			} else if !strings.HasPrefix(arg.CLI, "--") && !strings.Contains(op.CLI.Usage, arg.CLI) {
				t.Errorf("%s: idempotencyArg.cli %q is not in its usage", op.Tool, arg.CLI)
			}
		}
		if arg.Repeat != idempotencyRepeatReturns && arg.Repeat != idempotencyRepeatIsRefused {
			t.Errorf("%s: repeat %q", op.Tool, arg.Repeat)
		}
	}
}

// retryPolicy is what the receipt actually says: a write that got no answer is resent only when it
// carried a key whose repeat answers with the first result.
func TestRetryPolicyIsTheReceiptsRule(t *testing.T) {
	for _, tool := range []string{"task_create", "session_send", "watch_create"} {
		op := catalogOperation(tool)
		policy := op.retryPolicy()
		if policy.OnNoAnswer != retryRereadFirst || policy.OnNoAnswerWithKey != retryResend {
			t.Errorf("%s retryPolicy %+v, want reread_first / resend", tool, policy)
		}
		arg := op.idempotencyArg()
		if !op.keyedCall(map[string]interface{}{arg.MCP: "k1"}) || op.keyedCall(map[string]interface{}{}) {
			t.Errorf("%s: keyedCall does not read %s", tool, arg.MCP)
		}
	}
	if p := catalogOperation("session_reply").retryPolicy(); p.OnNoAnswer != retryRereadFirst || p.OnNoAnswerWithKey != retryRereadFirst {
		t.Errorf("session_reply takes one answer, so a repeat is refused rather than answered: %+v", p)
	}
	if p := catalogOperation("task_get").retryPolicy(); p.OnNoAnswer != retryResend || p.OnNoAnswerWithKey != "" {
		t.Errorf("a read is resent: %+v", p)
	}
	if p := catalogOperation("task_update").retryPolicy(); p.OnNoAnswer != retryRereadFirst || p.OnNoAnswerWithKey != "" {
		t.Errorf("an unkeyed write is re-read first: %+v", p)
	}
}

// The allowlist and the capability document are two projections of one catalogue, held together in
// every session shape: the rules are exactly `capabilities --json`, what the session is offered, and
// what it is withheld only because a session switch is off — whose rules are kept on purpose, since a
// rule nobody can use costs nothing and a missing one costs a prompt. Nothing withheld for any other
// reason (the grant, a human-only command) is pre-approved.
func TestTheAllowlistIsTheCapabilitySpecInEverySessionShape(t *testing.T) {
	for _, orchestration := range []bool{false, true} {
		for _, watches := range []string{"on", "off"} {
			for _, wiki := range []string{"on", "off"} {
				for _, browser := range []bool{true, false} {
					catalogFullestCLIContext(t)
					t.Setenv(envMCPOrchestration, map[bool]string{true: "true", false: "false"}[orchestration])
					t.Setenv(envWatches, watches)
					t.Setenv(envWiki, wiki)
					t.Setenv(envBrowser, browserEnv(browser))
					shape := "orchestration=" + map[bool]string{true: "on", false: "off"}[orchestration] + " watches=" + watches + " wiki=" + wiki + " browser=" + browserEnv(browser)
					r := readCapabilities(t)
					// The document's own doors: `capabilities --json` itself, and its graded views (`capabilities *`:
					// --summary, --family, --id), which the instructions send an agent to (operation_discovery.go).
					want := map[string]bool{"Bash(" + capabilityTestExe + " capabilities --json)": true,
						"Bash(" + capabilityTestExe + " capabilities *)": true}
					for _, c := range r.doc.Capabilities {
						want["Bash("+strings.Join(c.Argv, " ")+" *)"] = true
					}
					forbidden := map[string]string{}
					for _, c := range r.doc.UnavailableCapabilities {
						rule := "Bash(" + strings.Join(c.Argv, " ") + " *)"
						switch c.UnavailableCode {
						case capabilityWatchesOff, capabilityWikiOff:
							want[rule] = true
						default:
							forbidden[rule] = c.UnavailableCode
						}
					}
					got := map[string]bool{}
					for _, rule := range orbitCLIAllowedTools(capabilityTestExe, orchestration, browser) {
						if !strings.HasPrefix(rule, "Bash('") {
							got[rule] = true
						}
					}
					for rule := range want {
						if !got[rule] {
							t.Errorf("%s: no rule for %s", shape, rule)
						}
					}
					for rule := range got {
						if code, bad := forbidden[rule]; bad {
							t.Errorf("%s: %s is pre-approved but withheld (%s)", shape, rule, code)
						} else if !want[rule] {
							t.Errorf("%s: %s is pre-approved and the document says nothing of it", shape, rule)
						}
					}
				}
			}
		}
	}
}

// orbitTopLevelCommands is every first word the CLI dispatches, read from its router in main.go, so a
// command added there is held to this test the moment it exists.
func orbitTopLevelCommands(t *testing.T) []string {
	t.Helper()
	src, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatal(err)
	}
	text := string(src)
	start := strings.Index(text, "\tswitch cmd {\n\tcase \"register\":")
	if start < 0 {
		t.Fatal("main.go's command router moved; update orbitTopLevelCommands")
	}
	end := strings.Index(text[start:], "\n\tdefault:\n")
	words := map[string]bool{"secret": true} // dispatched before the router (main.go: os.Args[1] == "secret")
	for _, m := range regexp.MustCompile(`\n\tcase ([^:]+):`).FindAllStringSubmatch(text[start:start+end], -1) {
		for _, quoted := range strings.Split(m[1], ",") {
			word := strings.Trim(strings.TrimSpace(quoted), `"`)
			if !strings.HasPrefix(word, "-") {
				words[word] = true
			}
		}
	}
	list := make([]string, 0, len(words))
	for word := range words {
		list = append(list, word)
	}
	sort.Strings(list)
	return list
}

// Every `orbit` command is pre-approved for an orchestrating session or excluded with a reason: the
// catalogue's agent commands have their rules; its human-only commands carry their catalogue reason;
// every other first word is in orbitCLIAllowlistExclusions, and none of those has a rule.
func TestEveryOrbitCommandIsPreApprovedOrExcludedWithAReason(t *testing.T) {
	// On the Orbit Cloud runner, the one place browser_request_sign_in is offered and pre-approved.
	t.Setenv(envManagedRunnerGeneration, "3")
	rules := strings.Join(orbitCLIAllowedTools(capabilityTestExe, true, true), "\n")
	catalogWords := map[string]bool{}
	for _, op := range operationCatalog().Ops {
		if op.CLI == nil {
			continue
		}
		words := strings.Join(op.CLI.Argv[1:], " ")
		catalogWords[op.CLI.Argv[1]] = true
		rule := "Bash(" + capabilityTestExe + " " + words + " *)"
		if op.CLI.HeadlessOnly {
			if catalogMCPExemptions[op.Tool] == "" {
				t.Errorf("%s is human-only with no reason recorded", op.Tool)
			}
			if strings.Contains(rules, rule) {
				t.Errorf("%s is human-only and pre-approved", op.Tool)
			}
			continue
		}
		if !strings.Contains(rules, rule) {
			t.Errorf("%s (%s) has no allowlist rule", op.Tool, words)
		}
	}
	kinds := map[string]bool{allowlistHumanOnly: true, allowlistHeadlessOnly: true, allowlistArbitraryCommand: true, allowlistRunnerLocal: true}
	seen := map[string]bool{}
	for _, word := range orbitTopLevelCommands(t) {
		seen[word] = true
		exclusion, excluded := orbitCLIAllowlistExclusions[word]
		switch {
		case word == "capabilities":
			if !strings.Contains(rules, "Bash("+capabilityTestExe+" capabilities --json)") {
				t.Error("capabilities --json is not pre-approved")
			}
		case word == "documents":
			// `orbit drive` under its name while Drive was called Drive (drive_cli.go), still served for prompts
			// that name it: the catalogue and the allowlist carry the commands under their current name only.
			if !catalogWords["drive"] || strings.Contains(rules, "Bash("+capabilityTestExe+" documents ") {
				t.Error("`orbit documents` is the unlisted alias of the catalogued `orbit drive`, never pre-approved itself")
			}
		case catalogWords[word]:
			if excluded {
				t.Errorf("%s carries catalogue commands and is also excluded", word)
			}
		case !excluded:
			t.Errorf("`orbit %s` is neither a catalogue command nor excluded with a reason", word)
		default:
			if !kinds[exclusion.kind] || exclusion.reason == "" {
				t.Errorf("`orbit %s` is excluded without a kind and a reason: %+v", word, exclusion)
			}
			if strings.Contains(rules, "Bash("+capabilityTestExe+" "+word+" ") {
				t.Errorf("`orbit %s` is excluded but pre-approved", word)
			}
		}
	}
	for word := range orbitCLIAllowlistExclusions {
		if !seen[word] {
			t.Errorf("orbitCLIAllowlistExclusions names `orbit %s`, which the CLI does not dispatch", word)
		}
	}
}

// A recovery step that tells the caller to run something names a command this process can run: the
// CLI surface reads only what the document marks available, so a credential the document now
// refuses (an invalid or expired token) takes its readers out of every recovery with it, and in a
// session each one is pre-approved.
func TestRecoveryInvokesNameOnlyRunnableCapabilities(t *testing.T) {
	for _, ctx := range capabilityContexts {
		t.Run(ctx.name, func(t *testing.T) {
			ctx.setup(t)
			r := readCapabilities(t)
			inSession := os.Getenv("ORBIT_SESSION_ID") != ""
			rules := map[string]bool{}
			for _, rule := range orbitCLIAllowedTools(capabilityTestExe, mcpOrchestrationEnabled(), false) {
				rules[rule] = true
			}
			surface := cliRecoverySurface{executable: capabilityTestExe, capabilities: r.doc.Capabilities, replayStdin: true}
			for _, reader := range recoveryReaders {
				n, ok := surface.read(reader[0], reader[1], "abc123")
				if r.code(t, reader[0]) != "" {
					if ok {
						t.Errorf("recovery offers %s, which cannot run here (%s)", reader[0], r.code(t, reader[0]))
					}
					continue
				}
				if !ok {
					t.Errorf("recovery does not offer %s, which runs here", reader[0])
					continue
				}
				c := r.listed[reader[0]]
				if strings.Join(n.Argv[:len(c.Argv)], " ") != strings.Join(c.Argv, " ") {
					t.Errorf("recovery's %s argv %v is not the capability's %v", reader[0], n.Argv, c.Argv)
				}
				if inSession && !rules["Bash("+strings.Join(c.Argv, " ")+" *)"] {
					t.Errorf("recovery's %s is not pre-approved in this session", reader[0])
				}
			}
			for _, c := range r.doc.Capabilities {
				surface.argv = append(append([]string{}, c.Argv[1:]...), "x", "--json")
				_, again := surface.again()
				if again != c.Available {
					t.Errorf("recovery offers %s again=%v, but available=%v (%s)", c.ID, again, c.Available, c.UnavailableCode)
				}
			}
		})
	}
}

// An older consumer reads the document as it always did: the fields it knew are where they were, and
// the new ones are additions it can ignore.
func TestCapabilitiesV16FieldsAreAdditive(t *testing.T) {
	catalogFullestCLIContext(t)
	raw, err := json.Marshal(buildCLICapabilities(capabilityTestExe))
	if err != nil {
		t.Fatal(err)
	}
	var legacy struct {
		SchemaVersion int `json:"schemaVersion"`
		Capabilities  []struct {
			ID        string   `json:"id"`
			Argv      []string `json:"argv"`
			Available bool     `json:"available"`
			Mutates   bool     `json:"mutates"`
		} `json:"capabilities"`
	}
	if err := json.Unmarshal(raw, &legacy); err != nil {
		t.Fatal(err)
	}
	if legacy.SchemaVersion != runnerWriteSchemaRevision || len(legacy.Capabilities) == 0 {
		t.Fatalf("legacy read: schemaVersion %d, %d capabilities", legacy.SchemaVersion, len(legacy.Capabilities))
	}
	for _, c := range legacy.Capabilities {
		if !c.Available {
			t.Errorf("%s reads as unavailable to a legacy consumer in the fullest session", c.ID)
		}
	}
	var decoded map[string]interface{}
	_ = json.Unmarshal(raw, &decoded)
	if _, ok := decoded["unavailableCapabilities"].([]interface{}); !ok {
		t.Error("unavailableCapabilities is not an array (an empty list must be [], not null)")
	}
}
