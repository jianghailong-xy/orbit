package main

import (
	"bytes"
	"os"
	"strings"
	"testing"
)

// Off means absent for all four browser tools at once (docs/runner-browser-design.md §2): browser_status, browser_open,
// browser_clear_logins and browser_request_sign_in are in neither `orbit mcp`'s tool list nor `orbit capabilities`, and
// `orbit browser <command>` is an unknown command, when ORBIT_BROWSER is absent, off or false — whatever else the runner
// is (the server only says "on" to a managed runner with managed runners on). With it on, the first three are listed;
// request-sign-in only inside the Orbit Cloud runner (a managed runner's generation in the environment).
func TestAllFourBrowserToolsAreAbsentWithTheSwitchOffAndListedWhenOn(t *testing.T) {
	catalogFullestCLIContext(t)
	tools := []string{"browser_status", "browser_open", "browser_clear_logins", browserRequestSignInTool}
	commands := map[string]string{
		"browser_status": "status", "browser_open": "open", "browser_clear_logins": "clear-logins", browserRequestSignInTool: "request-sign-in",
	}
	type state struct {
		name       string
		browser    string // "-" is unset
		cloud      bool
		wantListed map[string]bool
	}
	none := map[string]bool{}
	three := map[string]bool{"browser_status": true, "browser_open": true, "browser_clear_logins": true}
	all := map[string]bool{"browser_status": true, "browser_open": true, "browser_clear_logins": true, browserRequestSignInTool: true}
	for _, s := range []state{
		{"switch absent, Orbit Cloud runner", "-", true, none},
		{"switch absent, other runner", "-", false, none},
		{"switch false, Orbit Cloud runner", "false", true, none},
		{"switch off, Orbit Cloud runner", "off", true, none},
		{"switch off, other runner", "off", false, none},
		{"managed runners off (the server sends off), switch unset", "-", false, none},
		{"switch on, not the Orbit Cloud runner", "on", false, three},
		{"switch on, Orbit Cloud runner", "on", true, all},
	} {
		t.Run(s.name, func(t *testing.T) {
			if s.browser == "-" {
				t.Setenv(envBrowser, "")
				os.Unsetenv(envBrowser)
			} else {
				t.Setenv(envBrowser, s.browser)
			}
			if s.cloud {
				t.Setenv(envManagedRunnerGeneration, "1")
			} else {
				t.Setenv(envManagedRunnerGeneration, "")
				os.Unsetenv(envManagedRunnerGeneration)
			}
			server := &mcpServer{sessionID: "s", browserOn: browserToolsEnabledFromEnv()}
			help := mcpHelp()
			for _, tool := range tools {
				want := s.wantListed[tool]
				if got := listsTool(server, tool); got != want {
					t.Errorf("%s in tools/list = %v, want %v", tool, got, want)
				}
				offered, code := offersCommand(t, tool)
				if offered != want {
					t.Errorf("%s offered by `orbit capabilities` = %v (%s), want %v", tool, offered, code, want)
				}
				if !want && code != "" {
					t.Errorf("%s is listed as unavailable (%s), want in neither list", tool, code)
				}
				err := runOrbitCLI([]string{"browser", commands[tool], "--help"}, strings.NewReader(""), &bytes.Buffer{}, &bytes.Buffer{})
				if want && err != nil {
					t.Errorf("`orbit browser %s`: %v", commands[tool], err)
				}
				if !want && (err == nil || !strings.Contains(err.Error(), "unknown command")) {
					t.Errorf("`orbit browser %s` = %v, want an unknown command", commands[tool], err)
				}
				if !want && strings.Contains(help, tool) {
					t.Errorf("`orbit mcp help` names %s", tool)
				}
			}
		})
	}
}
