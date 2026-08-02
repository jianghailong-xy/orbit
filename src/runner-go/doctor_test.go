package main

import (
	"os"
	"path/filepath"
	"runtime"
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

func fakeKimiACP(t *testing.T, authResponse string) string {
	t.Helper()
	return writeFakeBin(t, t.TempDir(), "kimi", `
if [ "$1" != "acp" ]; then exit 3; fi
IFS= read -r initialize
case "$initialize" in
  *'"method":"initialize"'*'"protocolVersion":1'*) ;;
  *) exit 4 ;;
esac
# A notification before the response verifies the probe matches JSON-RPC IDs.
echo '{"jsonrpc":"2.0","method":"window/logMessage","params":{}}'
echo '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}'
IFS= read -r authenticate
case "$authenticate" in
  *'"method":"authenticate"'*'"methodId":"login"'*) ;;
  *) exit 5 ;;
esac
echo '`+authResponse+`'
`)
}

func TestProbeAuthKimiACP(t *testing.T) {
	yes := fakeKimiACP(t, `{"jsonrpc":"2.0","id":2,"result":null}`)
	if got := probeAuth(providerKimi, yes); got != authYes {
		t.Fatalf("successful ACP authenticate should be authYes, got %v", got)
	}
	no := fakeKimiACP(t, `{"jsonrpc":"2.0","id":2,"error":{"code":-32000,"message":"Authentication required"}}`)
	if got := probeAuth(providerKimi, no); got != authNo {
		t.Fatalf("ACP authRequired should be authNo, got %v", got)
	}
	unknown := fakeKimiACP(t, `{"jsonrpc":"2.0","id":2,"error":{"code":-32602,"message":"bad request"}}`)
	if got := probeAuth(providerKimi, unknown); got != authUnknown {
		t.Fatalf("an ACP protocol error should stay authUnknown, got %v", got)
	}
}

func TestKimiEngineSpec(t *testing.T) {
	spec, ok := specFor(providerKimi)
	if !ok {
		t.Fatal("Kimi engine spec is missing")
	}
	if spec.name != "Kimi Code" || spec.bin != "kimi" {
		t.Fatalf("unexpected Kimi identity: %+v", spec)
	}
	if spec.installCmd != "curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash" {
		t.Fatalf("Kimi install command = %q", spec.installCmd)
	}
	if spec.loginCmd() != "kimi login" {
		t.Fatalf("Kimi login command = %q", spec.loginCmd())
	}
}

func TestProbeAuthOpenCodeDoesNotTreatZeroCredentialsAsSignedOut(t *testing.T) {
	empty := writeFakeBin(t, t.TempDir(), providerOpenCode, `echo '0 credentials'`)
	if got := probeAuth(providerOpenCode, empty); got != authUnknown {
		t.Fatalf("zero credentials can still use local providers, got %v", got)
	}
	configured := writeFakeBin(t, t.TempDir(), providerOpenCode, `echo '2 credentials'`)
	if got := probeAuth(providerOpenCode, configured); got != authYes {
		t.Fatalf("configured credentials should be authYes, got %v", got)
	}
}

func TestEngineInstallPathsIncludeOpenCode(t *testing.T) {
	got := runnerEnginePath("/home/orbit", "/usr/bin")
	if !strings.HasPrefix(got, "/home/orbit/.local/bin:/home/orbit/.opencode/bin:") {
		t.Fatalf("engine PATH = %q", got)
	}
}

func TestEngineInstallPathsExposeOpenCodeToExistingServiceProcess(t *testing.T) {
	home := t.TempDir()
	binDir := filepath.Join(home, ".opencode", "bin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatal(err)
	}
	writeFakeBin(t, binDir, providerOpenCode, `exit 0`)

	// Model a service unit written before Orbit knew about OpenCode's official install path.
	t.Setenv("PATH", "/usr/bin")
	path := runnerEnginePath(home, os.Getenv("PATH"))
	if _, ok := lookPathIn(providerOpenCode, path); !ok {
		t.Fatalf("OpenCode under the official install dir is not executable through PATH %q", path)
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

func TestRemoteMachine(t *testing.T) {
	for _, k := range []string{"SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY", "DISPLAY", "WAYLAND_DISPLAY"} {
		t.Setenv(k, "")
	}
	t.Setenv("SSH_CONNECTION", "10.0.0.2 51000 10.0.0.9 22")
	if !remoteMachine() {
		t.Fatal("an SSH session must count as remote")
	}
	t.Setenv("SSH_CONNECTION", "")
	t.Setenv("DISPLAY", ":0")
	if runtime.GOOS == "linux" && remoteMachine() {
		t.Fatal("a Linux desktop with DISPLAY set is local")
	}
	t.Setenv("DISPLAY", "")
	if runtime.GOOS == "linux" && !remoteMachine() {
		t.Fatal("a Linux box with no display server must count as remote")
	}
}

// codexLoginHelp is the shape of `codex login --help`: the flag is advertised there,
// which is how we tell a CLI that supports the device flow from one that doesn't.
const codexLoginHelp = `Manage login

Usage: codex login [OPTIONS] [COMMAND]

Options:
      --with-api-key  Read the API key from stdin
      --device-auth
`

func TestSupportsLoginFlag(t *testing.T) {
	spec := engineSpec{bin: "codex", loginArgs: []string{"login"}, loginRemoteFlag: "--device-auth"}
	current := writeFakeBin(t, t.TempDir(), "codex", "cat <<'EOF'\n"+codexLoginHelp+"EOF")
	if !supportsLoginFlag(current, spec) {
		t.Fatal("help advertising --device-auth should count as supported")
	}
	old := writeFakeBin(t, t.TempDir(), "codex", `echo "Usage: codex login [OPTIONS]"`)
	if supportsLoginFlag(old, spec) {
		t.Fatal("a CLI that never mentions the flag must not be used with it")
	}
}

// TestSignInEngineUsesDeviceAuthWhenRemote pins the actual regression: over SSH,
// plain `codex login` waits on a localhost callback the user's browser can't reach.
func TestSignInEngineUsesDeviceAuthWhenRemote(t *testing.T) {
	dir := t.TempDir()
	argvLog := filepath.Join(dir, "argv")
	bin := writeFakeBin(t, dir, "codex", `if [ "$2" = "--help" ]; then cat <<'EOF'
`+codexLoginHelp+`EOF
  exit 0
fi
echo "$@" > `+argvLog)
	spec := engineSpec{name: "Codex", bin: "codex", loginArgs: []string{"login"}, loginRemoteFlag: "--device-auth"}

	t.Setenv("SSH_CONNECTION", "10.0.0.2 51000 10.0.0.9 22")
	if !signInEngine(spec, bin) { // stdin isn't a tty under `go test`, so confirm() takes the default yes
		t.Fatal("sign-in should report success when the CLI exits 0")
	}
	got, _ := os.ReadFile(argvLog)
	if strings.TrimSpace(string(got)) != "login --device-auth" {
		t.Fatalf("remote machine must get the device flow, ran: %q", strings.TrimSpace(string(got)))
	}

	for _, k := range []string{"SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY"} {
		t.Setenv(k, "")
	}
	t.Setenv("DISPLAY", ":0") // local desktop: keep the browser-opening flow
	if runtime.GOOS == "linux" {
		if !signInEngine(spec, bin) {
			t.Fatal("sign-in should report success when the CLI exits 0")
		}
		got, _ = os.ReadFile(argvLog)
		if strings.TrimSpace(string(got)) != "login" {
			t.Fatalf("local machine should keep the default flow, ran: %q", strings.TrimSpace(string(got)))
		}
	}
}

func TestSignInEngineKeepsDefaultFlowWithoutRemoteFlag(t *testing.T) {
	dir := t.TempDir()
	argvLog := filepath.Join(dir, "argv")
	bin := writeFakeBin(t, dir, "claude", `echo "$@" > `+argvLog)
	spec := engineSpec{name: "Claude Code", bin: "claude", loginArgs: []string{"auth", "login"}}

	t.Setenv("SSH_CONNECTION", "10.0.0.2 51000 10.0.0.9 22")
	if !signInEngine(spec, bin) {
		t.Fatal("sign-in should report success when the CLI exits 0")
	}
	// claude's sign-in finishes on a hosted callback + pasted code, so SSH changes nothing.
	if got, _ := os.ReadFile(argvLog); strings.TrimSpace(string(got)) != "auth login" {
		t.Fatalf("engine without a remote flag must run unchanged, ran: %q", strings.TrimSpace(string(got)))
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
