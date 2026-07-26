package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestEngineMissingMessage(t *testing.T) {
	msg := engineMissingMessage(providerClaude)
	if !strings.Contains(msg, "Claude Code") || !strings.Contains(msg, "orbit doctor") {
		t.Fatalf("message should name the engine and point at doctor: %q", msg)
	}
	if got := engineMissingMessage("weirdengine"); !strings.Contains(got, "weirdengine") {
		t.Fatalf("unknown bin should echo the bin name: %q", got)
	}
}

func TestFormatEngineLine(t *testing.T) {
	notInstalled := formatEngineLine(engineHealth{spec: engineSpec{name: "Codex"}})
	if !strings.Contains(notInstalled, "not installed") {
		t.Fatalf("want not-installed line, got %q", notInstalled)
	}
	ok := formatEngineLine(engineHealth{
		spec: engineSpec{name: "Codex"}, installed: true, version: "1.2.3", auth: authYes, onServicePath: true,
	})
	if strings.Contains(ok, "⚠") {
		t.Fatalf("healthy line should carry no warning: %q", ok)
	}
	signedOut := formatEngineLine(engineHealth{
		spec: engineSpec{name: "Codex"}, installed: true, auth: authNo, onServicePath: true,
	})
	if !strings.Contains(signedOut, "not signed in") {
		t.Fatalf("want signed-out warning, got %q", signedOut)
	}
	warned := formatEngineLine(engineHealth{
		spec: engineSpec{name: "Codex"}, installed: true, auth: authUnknown, onServicePath: false,
	})
	if !strings.Contains(warned, "sign-in unverified") || !strings.Contains(warned, "not on service PATH") {
		t.Fatalf("want both warnings, got %q", warned)
	}
}

// writeFakeBin drops an executable shell script at dir/name and returns its path.
func writeFakeBin(t *testing.T, dir, name, body string) string {
	t.Helper()
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, []byte("#!/bin/sh\n"+body+"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestProbeAuthClaude(t *testing.T) {
	yes := writeFakeBin(t, t.TempDir(), "claude", `echo '{"loggedIn":true,"email":"x"}'`)
	if got := probeAuth(providerClaude, yes); got != authYes {
		t.Fatalf("loggedIn:true should be authYes, got %v", got)
	}
	no := writeFakeBin(t, t.TempDir(), "claude", `echo '{"loggedIn":false}'`)
	if got := probeAuth(providerClaude, no); got != authNo {
		t.Fatalf("loggedIn:false should be authNo, got %v", got)
	}
	junk := writeFakeBin(t, t.TempDir(), "claude", `echo not-json`)
	if got := probeAuth(providerClaude, junk); got != authUnknown {
		t.Fatalf("unparseable status should be authUnknown, got %v", got)
	}
}

func TestProbeAuthCodex(t *testing.T) {
	yes := writeFakeBin(t, t.TempDir(), "codex", `exit 0`)
	if got := probeAuth(providerCodex, yes); got != authYes {
		t.Fatalf("exit 0 should be authYes, got %v", got)
	}
	no := writeFakeBin(t, t.TempDir(), "codex", `exit 1`)
	if got := probeAuth(providerCodex, no); got != authNo {
		t.Fatalf("non-zero exit should be authNo, got %v", got)
	}
}

func TestCheckEngineDetectsBinary(t *testing.T) {
	dir := t.TempDir()
	bin := filepath.Join(dir, "claude")
	if err := os.WriteFile(bin, []byte("#!/bin/sh\necho '2.0.0 (Claude Code)'\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir) // hide any real claude so only the fake is found

	h := checkEngine(engineSpec{name: "Claude Code", bin: "claude"}, dir)
	if !h.installed {
		t.Fatal("expected the fake claude to be detected as installed")
	}
	if h.version != "2.0.0 (Claude Code)" {
		t.Fatalf("version parse: got %q", h.version)
	}
	if !h.onServicePath {
		t.Fatalf("bin dir %s should count as on servicePath %s", filepath.Dir(h.path), dir)
	}
}

func TestCheckEngineMissing(t *testing.T) {
	t.Setenv("PATH", t.TempDir()) // empty dir — nothing to find
	h := checkEngine(engineSpec{name: "Codex", bin: "codex-does-not-exist"}, "/nope")
	if h.installed {
		t.Fatal("expected not installed for a bogus binary")
	}
}

func TestRunInstallCmd(t *testing.T) {
	marker := filepath.Join(t.TempDir(), "ran")
	spec := engineSpec{name: "Fake", installCmd: "touch " + marker, installAlt: "-"}
	if !runInstallCmd(spec, nil) {
		t.Fatal("expected the installer command to succeed")
	}
	if _, err := os.Stat(marker); err != nil {
		t.Fatal("installer command did not actually run")
	}
}

func TestRunInstallCmdInjectsProxy(t *testing.T) {
	out := filepath.Join(t.TempDir(), "env")
	spec := engineSpec{name: "Fake", installCmd: "printenv https_proxy > " + out, installAlt: "-"}
	if !runInstallCmd(spec, []envVar{{"https_proxy", "http://px:8080"}}) {
		t.Fatal("install command should exit 0")
	}
	b, _ := os.ReadFile(out)
	if strings.TrimSpace(string(b)) != "http://px:8080" {
		t.Fatalf("proxy env not injected into installer: %q", string(b))
	}
}

func TestRunInstallCmdReportsFailure(t *testing.T) {
	spec := engineSpec{name: "Fake", installCmd: "exit 3", installAlt: "-"}
	if runInstallCmd(spec, nil) {
		t.Fatal("a non-zero installer must report failure")
	}
}

func TestWireAuthKeepsUnknownDistinct(t *testing.T) {
	// "couldn't tell" must not collapse into "signed out" — the UI turns `no` into a
	// prompt to re-run a login, which is wrong when the probe was merely inconclusive.
	for _, c := range []struct {
		in   authState
		want string
	}{{authYes, "yes"}, {authNo, "no"}, {authUnknown, "unknown"}} {
		if got := wireAuth(c.in); got != c.want {
			t.Fatalf("wireAuth(%v) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestProbeEngineStatusesCoversEverySpec(t *testing.T) {
	// Every engine reports a row whatever this machine has installed: a missing row reads
	// as "old runner, nothing reported", which is a different thing from "not installed".
	// (Install state itself isn't asserted — the probe reads the service login PATH, so it
	// finds whatever the test host really has; checkEngine's own tests cover detection.)
	got := probeEngineStatuses()
	if len(got) != len(engineSpecs) {
		t.Fatalf("got %d statuses for %d engines", len(got), len(engineSpecs))
	}
	for i, s := range got {
		if s.Provider != engineSpecs[i].bin {
			t.Fatalf("status %d provider = %q, want %q", i, s.Provider, engineSpecs[i].bin)
		}
		switch s.Auth {
		case "yes", "no", "unknown":
		default:
			t.Fatalf("%s auth = %q, want one of yes/no/unknown", s.Provider, s.Auth)
		}
		if !s.Installed && s.Version != "" {
			t.Fatalf("%s reports a version while not installed", s.Provider)
		}
	}
}
