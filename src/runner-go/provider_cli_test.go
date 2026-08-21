package main

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestProviderListReadsTheRunnerRouteWithoutOrchestration(t *testing.T) {
	var method, path, sessionHeader string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		method, path = r.Method, r.URL.Path
		sessionHeader = r.Header.Get("X-Orbit-Session-Id")
		_, _ = w.Write([]byte(`[{"slug":"claude","builtin":true},{"slug":"deepseek","builtin":false}]`))
	}))
	defer srv.Close()

	configureCLITestRunner(t, srv.URL)
	// Orchestration off and no calling session: the state a plain agent (or a cron job) is in.
	// The list still has to answer, because --provider works there too.
	t.Setenv(envMCPOrchestration, "")
	t.Setenv("ORBIT_SESSION_ID", "")

	var out bytes.Buffer
	if err := cmdProviderCLI([]string{"list", "--json"}, &out); err != nil {
		t.Fatalf("provider list: %v", err)
	}
	if method != http.MethodGet || path != "/api/runner/providers" {
		t.Fatalf("provider list hit %s %s", method, path)
	}
	if sessionHeader != "" {
		t.Fatalf("provider list sent an orchestration session header: %q", sessionHeader)
	}
	if out.String() != "[{\"slug\":\"claude\",\"builtin\":true},{\"slug\":\"deepseek\",\"builtin\":false}]\n" {
		t.Fatalf("provider list output = %q", out.String())
	}
}

func TestProviderCLIHelpAndUnknownCommand(t *testing.T) {
	var out bytes.Buffer
	if err := cmdProviderCLI([]string{"list", "--help"}, &out); err != nil {
		t.Fatalf("provider list --help: %v", err)
	}
	// The refusal string an agent will actually hit is the point of the help text.
	if !strings.Contains(out.String(), "provider not available") {
		t.Fatalf("provider list --help = %q", out.String())
	}

	out.Reset()
	if err := cmdProviderCLI([]string{"nope"}, &out); err == nil {
		t.Fatal("unknown provider command was accepted")
	}
}

// Defining per-action help is not enough: main answers `orbit <cmd> --help` itself with the
// family overview unless the family is named as owning its leaf help, and a family that forgets
// to say so compiles, tests green through its own handler, and ships help nobody can print. Both
// `provider` (0.1.122) and `agent` did exactly that.
func TestEveryFamilyWithPerActionHelpOwnsItsLeafHelp(t *testing.T) {
	for family, actions := range map[string]map[string]string{
		"provider": providerActionHelp,
		"agent":    agentActionHelp,
		"project":  projectActionHelp,
	} {
		if len(actions) == 0 {
			t.Fatalf("%s has no per-action help to route", family)
		}
		if !ownsLeafHelp(family) {
			t.Errorf("%s defines per-action help but main answers its --help with the family overview", family)
		}
	}
}
