package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
)

// fakeCodexForAccountHealth writes a codex that answers `login status` the way the real one does —
// exit 0 when the CODEX_HOME it runs in holds a login, non-zero when it doesn't — and appends the
// CODEX_HOME of every such call to the returned log, "<own>" for a call left on the runner's own
// environment (whose CODEX_HOME the test homes set empty, so codex falls back to ~/.codex). PATH
// is the fake's directory alone: checkEngine falls back to PATH, and a real codex found there would
// be asked about the throwaway homes instead of the fake.
func fakeCodexForAccountHealth(t *testing.T) (binDir, calls string) {
	t.Helper()
	binDir = t.TempDir()
	t.Setenv("PATH", binDir)
	calls = filepath.Join(t.TempDir(), "login-status.log")
	writeFakeBin(t, binDir, "codex", `home="${CODEX_HOME:-$HOME/.codex}"
case "$1 $2" in
"--version "*) echo "codex-cli 0.156.0" ;;
"login status")
	printf '%s\n' "${CODEX_HOME:-<own>}" >> '`+calls+`'
	if [ -f "$home/auth.json" ]; then echo "Logged in using ChatGPT"; exit 0; fi
	echo "Not logged in" >&2; exit 1 ;;
*) exit 2 ;;
esac`)
	return binDir, calls
}

func signInCodexHome(t *testing.T, dir string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "auth.json"), []byte(`{"tokens":{}}`), 0o600); err != nil {
		t.Fatal(err)
	}
}

func codexSpecForTest(t *testing.T) engineSpec {
	t.Helper()
	spec, ok := specFor(providerCodex)
	if !ok {
		t.Fatal("no codex engine spec")
	}
	return spec
}

// heartbeatEngines is the engines list exactly as a heartbeat puts it on the wire.
func heartbeatEngines(t *testing.T, engines []EngineHealthReport) []map[string]interface{} {
	t.Helper()
	b, err := json.Marshal(HeartbeatRequest{Engines: engines})
	if err != nil {
		t.Fatal(err)
	}
	var wire struct {
		Engines []map[string]interface{} `json:"engines"`
	}
	if err := json.Unmarshal(b, &wire); err != nil {
		t.Fatal(err)
	}
	return wire.Engines
}

func TestCodexEngineHealthAccountsProbeEachSlotInItsOwnCodexHome(t *testing.T) {
	home, _ := codexAccountSlotTestHomes(t)
	signInCodexHome(t, filepath.Join(home, ".codex"))
	work, err := createCodexAccountSlot("Work")
	if err != nil {
		t.Fatal(err)
	}
	signInCodexHome(t, work.CodexHome)
	personal, err := createCodexAccountSlot("Personal")
	if err != nil {
		t.Fatal(err)
	}
	binDir, calls := fakeCodexForAccountHealth(t)

	engines := heartbeatEngines(t, probeEngines([]engineSpec{codexSpecForTest(t)}, binDir))
	if len(engines) != 1 {
		t.Fatalf("engines = %#v, want the one codex report", engines)
	}
	codex := engines[0]
	// The engine's own answer is still Default's: every reader older than accounts takes it so.
	if codex["engine"] != "codex" || codex["installed"] != true || codex["auth"] != "yes" {
		t.Fatalf("codex report = %#v, want installed and signed in (Default's answer)", codex)
	}
	raw, _ := codex["accounts"].([]interface{})
	if len(raw) != 3 {
		t.Fatalf("accounts = %#v, want Default, Work and Personal", codex["accounts"])
	}
	byID := map[string]map[string]interface{}{}
	for _, a := range raw {
		account := a.(map[string]interface{})
		byID[account["id"].(string)] = account
	}
	if first := raw[0].(map[string]interface{}); first["id"] != codexAccountDefaultSlot {
		t.Fatalf("first account = %#v, want Default", first)
	}
	want := map[string]map[string]interface{}{
		// Default has no name of its own and lives where it always did.
		codexAccountDefaultSlot: {"id": "default", "codexHome": filepath.Join(home, ".codex"), "auth": "yes"},
		work.ID:                 {"id": work.ID, "name": "Work", "codexHome": work.CodexHome, "auth": "yes"},
		// Signed out in its own CODEX_HOME, whatever Default says.
		personal.ID: {"id": personal.ID, "name": "Personal", "codexHome": personal.CodexHome, "auth": "no"},
	}
	if !reflect.DeepEqual(byID, want) {
		t.Fatalf("accounts on the wire = %#v\nwant %#v", byID, want)
	}

	// One `codex login status` per slot, each in that slot's CODEX_HOME. Default's is the engine
	// probe's own, run in the runner's environment exactly as before accounts — not a second one.
	b, err := os.ReadFile(calls)
	if err != nil {
		t.Fatal(err)
	}
	got := strings.Fields(string(b))
	sort.Strings(got)
	wantCalls := []string{"<own>", work.CodexHome, personal.CodexHome}
	sort.Strings(wantCalls)
	if !reflect.DeepEqual(got, wantCalls) {
		t.Fatalf("login status ran in %q, want once in each of %q", got, wantCalls)
	}
}

func TestCodexEngineHealthAccountsFollowTheSlotsNotDefault(t *testing.T) {
	home, _ := codexAccountSlotTestHomes(t)
	binDir, _ := fakeCodexForAccountHealth(t)
	// Default signed out, the added account signed in: each row speaks for its own CODEX_HOME.
	work, err := createCodexAccountSlot("Work")
	if err != nil {
		t.Fatal(err)
	}
	signInCodexHome(t, work.CodexHome)

	reports := probeEngines([]engineSpec{codexSpecForTest(t)}, binDir)
	if reports[0].Auth != "no" {
		t.Fatalf("engine auth = %q, want Default's signed-out answer", reports[0].Auth)
	}
	want := []EngineAccountReport{
		{ID: codexAccountDefaultSlot, CodexHome: filepath.Join(home, ".codex"), Auth: "no"},
		{ID: work.ID, Name: "Work", CodexHome: work.CodexHome, Auth: "yes"},
	}
	if !reflect.DeepEqual(reports[0].Accounts, want) {
		t.Fatalf("accounts = %#v\nwant %#v", reports[0].Accounts, want)
	}
}

func TestCodexEngineHealthAccountsOneAccountIsJustDefault(t *testing.T) {
	home, orbitHome := codexAccountSlotTestHomes(t)
	signInCodexHome(t, filepath.Join(home, ".codex"))
	binDir, calls := fakeCodexForAccountHealth(t)

	reports := probeEngines([]engineSpec{codexSpecForTest(t)}, binDir)
	want := []EngineAccountReport{{ID: codexAccountDefaultSlot, CodexHome: filepath.Join(home, ".codex"), Auth: "yes"}}
	if !reflect.DeepEqual(reports[0].Accounts, want) {
		t.Fatalf("accounts = %#v, want only Default", reports[0].Accounts)
	}
	// A machine that never added an account costs the probe nothing extra, and gains no
	// codex-accounts directory from being asked.
	if b, _ := os.ReadFile(calls); strings.TrimSpace(string(b)) != "<own>" {
		t.Fatalf("login status calls = %q, want only the engine probe's own", b)
	}
	if _, err := os.Lstat(filepath.Join(orbitHome, "codex-accounts")); !os.IsNotExist(err) {
		t.Fatalf("probing created codex-accounts (err %v)", err)
	}
}

func TestCodexEngineHealthAccountsOnlyForAnInstalledCodex(t *testing.T) {
	home, _ := codexAccountSlotTestHomes(t)
	signInCodexHome(t, filepath.Join(home, ".codex"))
	if _, err := createCodexAccountSlot("Work"); err != nil {
		t.Fatal(err)
	}
	binDir, _ := fakeCodexForAccountHealth(t)
	writeFakeBin(t, binDir, "claude", `echo '{"loggedIn":true}'`)
	claude, _ := specFor(providerClaude)

	engines := heartbeatEngines(t, probeEngines([]engineSpec{claude, codexSpecForTest(t)}, binDir))
	if _, ok := engines[0]["accounts"]; ok {
		t.Fatalf("claude reported accounts: %#v", engines[0])
	}
	if accounts, _ := engines[1]["accounts"].([]interface{}); len(accounts) != 2 {
		t.Fatalf("codex accounts = %#v, want Default and Work", engines[1]["accounts"])
	}

	// No binary, no probe — and no accounts, which the page reads as the one row it always drew.
	nowhere := t.TempDir()
	t.Setenv("PATH", nowhere)
	missing := heartbeatEngines(t, probeEngines([]engineSpec{codexSpecForTest(t)}, nowhere))
	if missing[0]["installed"] != false {
		t.Fatalf("codex = %#v, want not installed", missing[0])
	}
	if _, ok := missing[0]["accounts"]; ok {
		t.Fatalf("an uninstalled codex reported accounts: %#v", missing[0])
	}
}

// One account, one fingerprint: each row is labelled with the prefix of the fingerprint this runner
// read for THAT account — Default's from the reset block of the read that produced its credits, an
// added slot's from its own account/rateLimits/read — so two slots holding one account are the same
// on the page, and no slot is ever labelled with another's.
func TestCodexEngineHealthAccountsCarryEachAccountsFingerprintPrefix(t *testing.T) {
	const defaultFingerprint = "cxa1_9f3a41c7e2d5b8a60123456789abcdef"
	const workFingerprint = "cxa1_2b7e9013c4d5e6f708192a3b4c5d6e7f"
	engines := []EngineHealthReport{
		{Engine: providerClaude, Installed: true, Auth: "yes"},
		{Engine: providerCodex, Installed: true, Auth: "yes", Accounts: []EngineAccountReport{
			{ID: codexAccountDefaultSlot, CodexHome: "/home/u/.codex", Auth: "yes"},
			{ID: "3fa91c2e", Name: "Work", CodexHome: "/home/u/.orbit/codex-accounts/3fa91c2e", Auth: "yes"},
			{ID: "7c21de40", Name: "Personal", CodexHome: "/home/u/.orbit/codex-accounts/7c21de40", Auth: "no"},
		}},
	}
	usage := accountUsageWithFingerprints(t, defaultFingerprint, map[string]string{"3fa91c2e": workFingerprint})

	out := withCodexAccountFingerprints(engines, usage)
	if got := out[1].Accounts[0].FingerprintPrefix; got != "cxa1_9f3a41c7" {
		t.Fatalf("Default's fingerprint prefix = %q, want cxa1_9f3a41c7", got)
	}
	if got := out[1].Accounts[1].FingerprintPrefix; got != "cxa1_2b7e9013" {
		t.Fatalf("Work's fingerprint prefix = %q, want cxa1_2b7e9013 (its own read, not Default's)", got)
	}
	// Nobody has read Personal: it is left unlabelled rather than given Work's fingerprint, which
	// would draw two different accounts as one.
	if got := out[1].Accounts[2].FingerprintPrefix; got != "" {
		t.Fatalf("Personal carries a fingerprint nobody read for it: %q", got)
	}
	// Only the prefix goes on the wire; the whole fingerprint stays behind.
	b, _ := json.Marshal(HeartbeatRequest{Engines: out})
	for _, fingerprint := range []string{defaultFingerprint, workFingerprint} {
		if strings.Contains(string(b), fingerprint) {
			t.Fatalf("the heartbeat's engines carry the whole fingerprint %s: %s", fingerprint, b)
		}
	}
	// The snapshot the probe keeps is shared with it: labelling must not write into it.
	if engines[1].Accounts[0].FingerprintPrefix != "" || engines[1].Accounts[1].FingerprintPrefix != "" {
		t.Fatal("labelling wrote into the probe's snapshot")
	}

	// Nothing read, nothing usable: the snapshot goes out as it is.
	for name, fingerprints := range map[string]struct {
		block *PlanUsageRateLimitReset
		slots map[string]string
	}{
		"no block":                       {nil, nil},
		"no account":                     {&PlanUsageRateLimitReset{Support: codexResetAccountUnidentified}, nil},
		"not a cxa1_":                    {&PlanUsageRateLimitReset{AccountFingerprint: "acct_1234567890"}, nil},
		"a short cxa1":                   {&PlanUsageRateLimitReset{AccountFingerprint: "cxa1_9f3a"}, nil},
		"a slot's read named no account": {nil, map[string]string{"3fa91c2e": ""}},
		"a slot's read produced a value that is not a fingerprint": {nil, map[string]string{"3fa91c2e": "acct_1234567890"}},
	} {
		u := newCodexAccountUsage(codexResetTestLeaseOwner)
		if fingerprints.block != nil {
			u.def.store(&PlanUsage{RateLimitReset: fingerprints.block})
		}
		for id, fingerprint := range fingerprints.slots {
			u.slots[id] = &codexSlotUsage{fingerprint: fingerprint}
		}
		if got := withCodexAccountFingerprints(engines, u); got[1].Accounts[0].FingerprintPrefix != "" ||
			got[1].Accounts[1].FingerprintPrefix != "" {
			t.Fatalf("%s: accounts labelled %q / %q", name, got[1].Accounts[0].FingerprintPrefix, got[1].Accounts[1].FingerprintPrefix)
		}
	}
	if withCodexAccountFingerprints(nil, usage) != nil {
		t.Fatal("no probe yet must stay nil, which the heartbeat omits")
	}
	if withCodexAccountFingerprints(engines, nil) == nil {
		t.Fatal("no account usage must leave the snapshot alone rather than drop it")
	}
}

// accountUsageWithFingerprints is a runner's account usage with Default's fingerprint read (the
// reset block of its last read) and each named slot's (its own read).
func accountUsageWithFingerprints(t *testing.T, defaultFingerprint string, slots map[string]string) *codexAccountUsage {
	t.Helper()
	u := newCodexAccountUsage(codexResetTestLeaseOwner)
	if defaultFingerprint != "" {
		u.def.store(&PlanUsage{RateLimitReset: &PlanUsageRateLimitReset{
			ProtocolVersion: codexRateLimitResetProtocolVersion, Support: codexResetSupported,
			AccountFingerprint: defaultFingerprint,
		}})
	}
	for id, fingerprint := range slots {
		u.slots[id] = &codexSlotUsage{fingerprint: fingerprint}
	}
	return u
}
