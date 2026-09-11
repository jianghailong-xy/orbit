package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

// The reset-credit read, named in scripts/test-codex-reset-read.sh. Every provider answer is a
// contracts/codex-rate-limit-reset.fixtures.json provider read, served by the in-process
// fakeCodexAppServer or by this test binary posing as `codex app-server`. No test here reaches a
// real Codex account, and nothing answers account/rateLimitResetCredit/consume.

const (
	codexResetTestLeaseOwner      = "6f1c2b7e-4d3a-4b8e-9c21-7a5e0d3f9b12"
	codexResetTestOtherLeaseOwner = "0b9e8d7c-6a5f-4e3d-8c2b-1a0f9e8d7c6b"
	codexResetTestEmail           = "fixture@example.invalid"

	fakeCodexDirEnv = "ORBIT_FAKE_CODEX_DIR"
)

type codexResetReadCase struct {
	account, rateLimits map[string]interface{}
	support, accountID  string
	credits             json.RawMessage
}

func codexResetReadFixture(t *testing.T, name string) codexResetReadCase {
	t.Helper()
	for _, read := range loadCodexResetFixtures(t).ProviderReads {
		if read.Name != name {
			continue
		}
		c := codexResetReadCase{account: read.Account, rateLimits: read.RateLimits, support: read.Expect.Support, credits: read.Expect.RateLimitResetCredits}
		if read.Expect.AccountID != nil {
			c.accountID = *read.Expect.AccountID
		}
		return c
	}
	t.Fatalf("no provider read fixture %q", name)
	return codexResetReadCase{}
}

// codexResetTestKey is the fingerprint key the read under test created in the machine home.
func codexResetTestKey(t *testing.T) []byte {
	t.Helper()
	key, err := os.ReadFile(filepath.Join(machineHome(), codexAccountFingerprintKeyFile))
	if err != nil || len(key) != codexAccountFingerprintKeySize {
		t.Fatalf("fingerprint key: %v (%d bytes)", err, len(key))
	}
	return key
}

type codexResetFakeRead struct {
	usage          *PlanUsage
	accountRequest map[string]interface{}
	readRequest    map[string]interface{}
	// When the fake received account/read, the first request of the read.
	accountAskedAt time.Time
}

// readCodexResetThroughFake runs one read against the in-process fake app-server, answering
// account/read with account (refusing it when nil) and account/rateLimits/read with rateLimits.
func readCodexResetThroughFake(t *testing.T, reader *codexResetReader, account, rateLimits map[string]interface{}) codexResetFakeRead {
	t.Helper()
	fake := newFakeCodexAppServer(t)
	type outcome struct {
		usage *PlanUsage
		err   error
	}
	done := make(chan outcome, 1)
	go func() {
		usage, err := reader.readCodexPlanUsage(context.Background(), fake.app)
		done <- outcome{usage, err}
	}()
	read := codexResetFakeRead{accountRequest: fake.take(codexAccountReadMethod), accountAskedAt: time.Now()}
	// Answer a little later, so a read stamped when it ended rather than when it started is
	// milliseconds past accountAskedAt instead of hiding inside the same millisecond.
	time.Sleep(5 * time.Millisecond)
	if account == nil {
		fake.refuse(read.accountRequest, "account/read is unavailable")
	} else {
		fake.answer(read.accountRequest, account)
	}
	read.readRequest = fake.take(codexRateLimitsReadMethod)
	fake.answer(read.readRequest, rateLimits)
	select {
	case got := <-done:
		if got.err != nil {
			t.Fatal(got.err)
		}
		if methods := fake.methods(); !reflect.DeepEqual(methods, []string{codexAccountReadMethod, codexRateLimitsReadMethod}) {
			t.Fatalf("the read sent %v", methods)
		}
		read.usage = got.usage
		return read
	case <-time.After(5 * time.Second):
		t.Fatal("the read did not finish")
		return read
	}
}

// §2 / I10: the block carries the provider's top-level rateLimitResetCredits exactly. The count is
// availableCount whether the details are null, empty, shorter than the count or unreadable, and the
// heartbeat keeps that null and that shortfall on the wire instead of tidying them away.
func TestCodexResetReadKeepsTopLevelCreditsLossless(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	for _, name := range []string{
		"details-null-count-only",
		"details-truncated-count-exceeds-rows",
		"details-empty-array",
		"details-complete",
		"details-malformed-row-drops-details-not-count",
		"summary-null",
	} {
		t.Run(name, func(t *testing.T) {
			fixture := codexResetReadFixture(t, name)
			read := readCodexResetThroughFake(t, &codexResetReader{leaseOwner: codexResetTestLeaseOwner}, fixture.account, fixture.rateLimits)
			block := read.usage.RateLimitReset
			if block == nil || block.Support != fixture.support {
				t.Fatalf("block %+v, want support %s", block, fixture.support)
			}
			codexResetSameJSON(t, "rateLimitResetCredits", block.RateLimitResetCredits, fixture.credits)
			if want := codexAccountFingerprint(codexResetTestKey(t), fixture.accountID); block.AccountFingerprint != want {
				t.Fatalf("fingerprint %q, want %q", block.AccountFingerprint, want)
			}
			// Everything is asked for: no token refresh, and never excludeResetCreditDetails.
			codexResetSameJSON(t, "account/read params", read.accountRequest["params"], []byte(`{"refreshToken":false}`))
			if params := read.readRequest["params"]; params != nil {
				t.Fatalf("account/rateLimits/read params %v, want null", params)
			}

			wire, err := json.Marshal(HeartbeatRequest{Status: "ONLINE", LeaseOwner: codexResetTestLeaseOwner, PlanUsage: combinePlanUsage(nil, read.usage)})
			if err != nil {
				t.Fatal(err)
			}
			var sent struct {
				PlanUsage struct {
					RateLimitReset json.RawMessage `json:"rateLimitReset"`
				} `json:"planUsage"`
			}
			if err := json.Unmarshal(wire, &sent); err != nil {
				t.Fatal(err)
			}
			decoded, err := decodeCodexResetWire(sent.PlanUsage.RateLimitReset, codexRateLimitResetBlockViolations)
			if err != nil {
				t.Fatalf("the heartbeat block is not a v1 block: %v\n%s", err, sent.PlanUsage.RateLimitReset)
			}
			codexResetSameJSON(t, "heartbeat rateLimitResetCredits", decoded.RateLimitResetCredits, fixture.credits)
		})
	}
}

// §2: fetchedAt is when the read started, to the millisecond; generation is the reading process's
// heartbeat leaseOwner; sequence counts that process's reads from 1. Another process on the same
// machine counts from 1 under its own generation and names the account identically.
func TestCodexResetReadStampsFetchedAtAndProcessGeneration(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	fixture := codexResetReadFixture(t, "details-truncated-count-exceeds-rows")
	reader := &codexResetReader{leaseOwner: codexResetTestLeaseOwner}
	var blocks []*PlanUsageRateLimitReset
	for i := 1; i <= 2; i++ {
		before := time.Now().UTC().Truncate(time.Millisecond)
		read := readCodexResetThroughFake(t, reader, fixture.account, fixture.rateLimits)
		block := read.usage.RateLimitReset
		fetchedAt, err := time.Parse(codexResetFetchedAtLayout, block.FetchedAt)
		if err != nil || !codexResetTimestamp(block.FetchedAt, true) {
			t.Fatalf("fetchedAt %q is not RFC3339 UTC milliseconds: %v", block.FetchedAt, err)
		}
		if fetchedAt.Before(before) || fetchedAt.After(read.accountAskedAt) {
			t.Fatalf("fetchedAt %s is not when the read started (%s, before account/read reached %s)", block.FetchedAt, before, read.accountAskedAt)
		}
		if block.Generation != codexResetTestLeaseOwner || block.Sequence != int64(i) {
			t.Fatalf("read %d: generation %s sequence %d", i, block.Generation, block.Sequence)
		}
		if violations := codexRateLimitResetBlockViolations(*block); len(violations) > 0 {
			t.Fatal(violations)
		}
		blocks = append(blocks, block)
	}
	if !codexResetBlockSupersedes(blocks[1], blocks[0]) || codexResetBlockSupersedes(blocks[0], blocks[1]) {
		t.Fatalf("reads do not order by start: %+v then %+v", blocks[0], blocks[1])
	}
	next := readCodexResetThroughFake(t, &codexResetReader{leaseOwner: codexResetTestOtherLeaseOwner}, fixture.account, fixture.rateLimits)
	if got := next.usage.RateLimitReset; got.Generation != codexResetTestOtherLeaseOwner || got.Sequence != 1 || got.AccountFingerprint != blocks[0].AccountFingerprint {
		t.Fatalf("a new process's first block %+v, want generation %s, sequence 1 and fingerprint %s", got, codexResetTestOtherLeaseOwner, blocks[0].AccountFingerprint)
	}
}

// §3: the key is 32 random bytes, created once under the machine home with mode 0600, and never
// sent. Racing first uses agree on one key; another machine home names the same account
// differently; a key that cannot be used leaves the read ACCOUNT_UNIDENTIFIED, and the log says so
// without saying what was in it.
func TestCodexAccountFingerprintKeyIsCreatedOnceAndPrivate(t *testing.T) {
	home := t.TempDir()
	t.Setenv("ORBIT_HOME", home)
	keys := make([][]byte, 8)
	errs := make([]error, len(keys))
	var wg sync.WaitGroup
	for i := range keys {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			keys[i], errs[i] = loadCodexAccountFingerprintKey()
		}(i)
	}
	wg.Wait()
	for i := range keys {
		if errs[i] != nil || len(keys[i]) != codexAccountFingerprintKeySize || !bytes.Equal(keys[i], keys[0]) {
			t.Fatalf("racing first use %d: %v (%x vs %x)", i, errs[i], keys[i], keys[0])
		}
	}
	info, err := os.Stat(filepath.Join(home, codexAccountFingerprintKeyFile))
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" && info.Mode().Perm() != 0o600 {
		t.Fatalf("key mode %v, want 0600", info.Mode().Perm())
	}
	if entries, _ := os.ReadDir(home); len(entries) != 1 {
		t.Fatalf("the machine home holds %d entries, want only the key", len(entries))
	}
	fingerprint := codexAccountFingerprint(keys[0], "acct_fixture_primary")

	t.Setenv("ORBIT_HOME", t.TempDir())
	otherKey, err := loadCodexAccountFingerprintKey()
	if err != nil {
		t.Fatal(err)
	}
	if codexAccountFingerprint(otherKey, "acct_fixture_primary") == fingerprint {
		t.Fatal("two machine homes fingerprint one account identically")
	}

	broken := t.TempDir()
	t.Setenv("ORBIT_HOME", broken)
	if err := os.WriteFile(filepath.Join(broken, codexAccountFingerprintKeyFile), []byte("not-a-32-byte-key"), 0o600); err != nil {
		t.Fatal(err)
	}
	fixture := codexResetReadFixture(t, "details-complete")
	var read codexResetFakeRead
	logs := captureRunnerStdout(t, func() {
		read = readCodexResetThroughFake(t, &codexResetReader{leaseOwner: codexResetTestLeaseOwner}, fixture.account, fixture.rateLimits)
	})
	block := read.usage.RateLimitReset
	if block == nil || block.Support != codexResetAccountUnidentified || block.AccountFingerprint != "" || block.RateLimitResetCredits != nil {
		t.Fatalf("a read with an unusable key produced %+v", block)
	}
	if !strings.Contains(logs, "fingerprint key is unusable") {
		t.Fatalf("the unusable key was not reported: %q", logs)
	}
	wire, err := json.Marshal(block)
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{"not-a-32-byte-key", fixture.accountID, codexResetTestEmail, hex.EncodeToString(keys[0])} {
		if strings.Contains(logs, secret) || strings.Contains(string(wire), secret) {
			t.Fatalf("%q reached the log or the wire:\n%s\n%s", secret, logs, wire)
		}
	}
}

// §2 support order: a login that is not ChatGPT (an API key, or signed out) is UNSUPPORTED_AUTH
// with no fingerprint and no credits, and never even creates the key; an older CLI without the
// summary is PROVIDER_UNSUPPORTED; a read without an account id is ACCOUNT_UNIDENTIFIED. A failed
// account/read yields no block at all rather than a guessed one.
func TestCodexResetReadMarksUnsupportedAuthAndUnidentifiedAccounts(t *testing.T) {
	home := t.TempDir()
	t.Setenv("ORBIT_HOME", home)
	for _, name := range []string{"api-key-auth", "signed-out", "summary-absent-older-cli", "account-id-null"} {
		fixture := codexResetReadFixture(t, name)
		read := readCodexResetThroughFake(t, &codexResetReader{leaseOwner: codexResetTestLeaseOwner}, fixture.account, fixture.rateLimits)
		block := read.usage.RateLimitReset
		if block == nil || block.Support != fixture.support || block.AccountFingerprint != "" || block.RateLimitResetCredits != nil {
			t.Fatalf("%s: block %+v, want %s with no fingerprint and no credits", name, block, fixture.support)
		}
		if violations := codexRateLimitResetBlockViolations(*block); len(violations) > 0 {
			t.Fatalf("%s: %v", name, violations)
		}
	}
	if _, err := os.Stat(filepath.Join(home, codexAccountFingerprintKeyFile)); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("a read that names no supported account touched the fingerprint key: %v", err)
	}

	fixture := codexResetReadFixture(t, "details-complete")
	read := readCodexResetThroughFake(t, &codexResetReader{leaseOwner: codexResetTestLeaseOwner}, nil, fixture.rateLimits)
	if read.usage == nil || read.usage.LimitID != codexPlanLimitID || read.usage.RateLimitReset != nil {
		t.Fatalf("a failed account/read produced %+v", read.usage)
	}
}

// Only the runner's default Codex account can open reset. A runner whose own environment carries
// custom API credentials reads no Codex usage — no app-server starts, no block is sent, and the
// value never reaches the error or the log. A session running under an overridden account
// (CODEX_HOME, CODEX_API_KEY, OPENAI_*) is kept away from the probe
// (TestCodexSessionRateLimitsFeedPlanUsageOnlyFromTheDefaultAccount), and a rolling rate-limit
// notification that does reach it can neither create a block nor change the default account's.
func TestCodexResetOverrideAccountsNeverOpenReset(t *testing.T) {
	fixture := codexResetReadFixture(t, "details-complete")
	for _, variable := range []string{"OPENAI_API_KEY", "OPENAI_BASE_URL"} {
		t.Run("runner environment sets "+variable, func(t *testing.T) {
			fake := newFakeCodexBinary(t, fixture.account, fixture.rateLimits)
			fake.useAsRunnerDefault(t)
			secret := "orbit-test-secret-" + strings.ToLower(variable)
			t.Setenv(variable, secret)
			probe := newCodexPlanUsageProbe(codexResetTestLeaseOwner)
			var usage *PlanUsage
			var err error
			logs := captureRunnerStdout(t, func() { usage, err = probe.fetch(context.Background(), probe.client) })
			if err == nil || usage != nil {
				t.Fatalf("the probe read Codex usage under %s: %+v", variable, usage)
			}
			if spawns := fake.lines(t, "spawns.jsonl"); len(spawns) != 0 {
				t.Fatalf("an app-server started under %s: %v", variable, spawns)
			}
			if strings.Contains(err.Error(), secret) || strings.Contains(logs, secret) {
				t.Fatalf("the %s value leaked: %v / %q", variable, err, logs)
			}
			wire, _ := json.Marshal(HeartbeatRequest{LeaseOwner: codexResetTestLeaseOwner, PlanUsage: combinePlanUsage(nil, probe.snapshot())})
			if bytes.Contains(wire, []byte("rateLimitReset")) || bytes.Contains(wire, []byte(secret)) {
				t.Fatalf("the heartbeat offers reset under %s: %s", variable, wire)
			}
		})
	}

	t.Run("a session under an overridden account", func(t *testing.T) {
		t.Setenv("ORBIT_HOME", t.TempDir())
		overridden := map[string]interface{}{
			"limitId":               codexPlanLimitID,
			"primary":               map[string]interface{}{"usedPercent": float64(64), "windowDurationMins": float64(300)},
			"accountId":             "acct_fixture_other",
			"rateLimitResetCredits": map[string]interface{}{"availableCount": float64(99), "credits": nil},
		}
		probe := newCodexPlanUsageProbe(codexResetTestLeaseOwner)
		probe.mergeCodexRateLimits(overridden)
		if got := probe.snapshot(); got == nil || got.RateLimitReset != nil {
			t.Fatalf("a session notification before any read produced %+v", got)
		}
		read := readCodexResetThroughFake(t, &codexResetReader{leaseOwner: codexResetTestLeaseOwner}, fixture.account, fixture.rateLimits)
		probe.store(read.usage)
		want := *probe.snapshot().RateLimitReset
		probe.mergeCodexRateLimits(overridden)
		got := probe.snapshot()
		if got.RateLimitReset == nil || !reflect.DeepEqual(*got.RateLimitReset, want) {
			t.Fatalf("a session notification changed the default account's block: %+v, want %+v", got.RateLimitReset, want)
		}
		if got.Primary == nil || got.Primary.Utilization != 64 {
			t.Fatalf("the notification's windows did not merge: %+v", got.Primary)
		}
	})
}

// The probe cache moves only forwards, in the order the control plane stores blocks: a read that
// finishes after a later-started one keeps the later block while its windows still land, a later
// read replaces it, and neither a notification nor a read without a block takes it away.
func TestCodexResetProbeCacheOnlyMovesForward(t *testing.T) {
	probe := newCodexPlanUsageProbe(codexResetTestLeaseOwner)
	read := func(utilization float64, fetchedAt string, sequence int64) *PlanUsage {
		usage := codexPlanUsageFromSnapshot(map[string]interface{}{
			"limitId": codexPlanLimitID,
			"primary": map[string]interface{}{"usedPercent": utilization, "windowDurationMins": float64(300)},
		})
		if sequence > 0 {
			usage.RateLimitReset = &PlanUsageRateLimitReset{
				ProtocolVersion: codexRateLimitResetProtocolVersion, Support: codexResetSupported,
				AccountFingerprint:    "cxa1_92381c922ad04574cc61964161fd5687",
				RateLimitResetCredits: &PlanUsageRateLimitResetCredits{AvailableCount: sequence},
				FetchedAt:             fetchedAt, Generation: codexResetTestLeaseOwner, Sequence: sequence,
			}
		}
		return usage
	}
	expect := func(step string, sequence int64, utilization float64) {
		t.Helper()
		got := probe.snapshot()
		if got == nil || got.RateLimitReset == nil || got.RateLimitReset.Sequence != sequence || got.Primary == nil || got.Primary.Utilization != utilization {
			t.Fatalf("%s: cached %+v / %+v, want block %d with %v%%", step, got.RateLimitReset, got.Primary, sequence, utilization)
		}
	}
	probe.store(read(10, "2026-09-11T04:21:30.123Z", 7))
	expect("first read", 7, 10)
	probe.store(read(20, "2026-09-11T04:21:29.000Z", 6))
	expect("an earlier-started read finishing late", 7, 20)
	probe.store(read(30, "2026-09-11T04:21:30.123Z", 8))
	expect("a later read in the same millisecond", 8, 30)
	probe.store(read(40, "2026-09-11T04:26:30.000Z", 9))
	expect("a later read", 9, 40)
	probe.mergeCodexRateLimits(map[string]interface{}{
		"limitId": codexPlanLimitID,
		"primary": map[string]interface{}{"usedPercent": float64(50), "windowDurationMins": float64(300)},
	})
	expect("a rolling notification", 9, 50)
	probe.store(read(60, "", 0))
	expect("a read whose account/read failed", 9, 60)
}

// The probe exactly as runloop.go runs it — shared state bootstrap, handshake lock, a spawned
// `codex app-server` — against this test binary posing as one. The heartbeat carries the default
// account's block under the process's own leaseOwner, read after read; nothing it sends or logs
// holds the account id, the email or the fingerprint key; and the app-server hears only the
// handshake and the two reads, never consume.
func TestCodexUsageProbeReadsResetThroughAFakeAppServer(t *testing.T) {
	fixture := codexResetReadFixture(t, "details-truncated-count-exceeds-rows")
	fake := newFakeCodexBinary(t, fixture.account, fixture.rateLimits)
	fake.useAsRunnerDefault(t)
	probe := newCodexPlanUsageProbe(codexResetTestLeaseOwner)
	var wires [][]byte
	logs := captureRunnerStdout(t, func() {
		for i := 0; i < 2; i++ {
			usage, err := probe.fetch(context.Background(), probe.client)
			if err != nil {
				t.Fatal(err)
			}
			probe.store(usage)
			wire, err := json.Marshal(HeartbeatRequest{Status: "ONLINE", LeaseOwner: codexResetTestLeaseOwner, PlanUsage: combinePlanUsage(nil, probe.snapshot())})
			if err != nil {
				t.Fatal(err)
			}
			wires = append(wires, wire)
		}
	})
	key := codexResetTestKey(t)
	for i, wire := range wires {
		var request HeartbeatRequest
		if err := json.Unmarshal(wire, &request); err != nil {
			t.Fatal(err)
		}
		block := request.PlanUsage.RateLimitReset
		if block == nil || block.Support != codexResetSupported || block.Generation != request.LeaseOwner || block.Sequence != int64(i+1) {
			t.Fatalf("heartbeat %d carries %+v", i+1, block)
		}
		if block.AccountFingerprint != codexAccountFingerprint(key, fixture.accountID) {
			t.Fatalf("heartbeat %d fingerprint %s", i+1, block.AccountFingerprint)
		}
		codexResetSameJSON(t, "heartbeat rateLimitResetCredits", block.RateLimitResetCredits, fixture.credits)
		for _, secret := range []string{fixture.accountID, codexResetTestEmail, hex.EncodeToString(key)} {
			if strings.Contains(string(wire), secret) || strings.Contains(logs, secret) {
				t.Fatalf("%q reached the heartbeat or the log:\n%s\n%s", secret, wire, logs)
			}
		}
	}

	if spawns := fake.lines(t, "spawns.jsonl"); len(spawns) < 2 {
		t.Fatalf("the fake app-server was not what the probe spawned: %v", spawns)
	}
	counts := map[string]int{}
	for _, line := range fake.lines(t, "requests.jsonl") {
		var frame map[string]interface{}
		if err := json.Unmarshal([]byte(line), &frame); err != nil {
			t.Fatal(err)
		}
		method, _ := frame["method"].(string)
		counts[method]++
		switch method {
		case "initialize", "initialized":
		case codexAccountReadMethod:
			codexResetSameJSON(t, "account/read params", frame["params"], []byte(`{"refreshToken":false}`))
		case codexRateLimitsReadMethod:
			if frame["params"] != nil {
				t.Fatalf("account/rateLimits/read params %v, want null", frame["params"])
			}
		default:
			t.Fatalf("the probe sent %s to the app-server", method)
		}
	}
	if counts[codexAccountReadMethod] != 2 || counts[codexRateLimitsReadMethod] != 2 || counts[codexRateLimitResetConsumeMethod] != 0 {
		t.Fatalf("app-server requests %v", counts)
	}
}

// fakeCodexBinary is this test binary posing as `codex`: a shim on PATH that runs
// runFakeCodexAppServer over the answers in dir, recording what it hears there.
type fakeCodexBinary struct {
	bin string
	dir string
}

func newFakeCodexBinary(t *testing.T, account, rateLimits map[string]interface{}) *fakeCodexBinary {
	t.Helper()
	base := t.TempDir()
	fake := &fakeCodexBinary{bin: filepath.Join(base, "bin"), dir: filepath.Join(base, "rec")}
	for _, dir := range []string{fake.bin, fake.dir} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	for name, answer := range map[string]map[string]interface{}{"account.json": account, "rateLimits.json": rateLimits} {
		data, err := json.Marshal(answer)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(fake.dir, name), data, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	shim := "#!/bin/sh\n" + fakeCodexDirEnv + "='" + fake.dir + "' exec '" + self + "' \"$@\"\n"
	if err := os.WriteFile(filepath.Join(fake.bin, "codex"), []byte(shim), 0o755); err != nil {
		t.Fatal(err)
	}
	return fake
}

// useAsRunnerDefault makes the test process the runner the probe runs in: a private machine home
// and user home, so the default CODEX_HOME is an empty temporary directory and never a real login;
// the fake first on PATH; and none of the variables that override the Codex account.
func (f *fakeCodexBinary) useAsRunnerDefault(t *testing.T) {
	t.Helper()
	home := t.TempDir()
	for _, dir := range []string{"orbit", "user"} {
		if err := os.MkdirAll(filepath.Join(home, dir), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("ORBIT_HOME", filepath.Join(home, "orbit"))
	t.Setenv("HOME", filepath.Join(home, "user"))
	for _, name := range []string{"CODEX_HOME", "CODEX_API_KEY", "OPENAI_API_KEY", "OPENAI_BASE_URL"} {
		t.Setenv(name, "")
	}
	t.Setenv("PATH", f.bin+string(os.PathListSeparator)+os.Getenv("PATH"))
}

func (f *fakeCodexBinary) lines(t *testing.T, name string) []string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(f.dir, name))
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		t.Fatal(err)
	}
	var out []string
	for _, line := range strings.Split(string(data), "\n") {
		if strings.TrimSpace(line) != "" {
			out = append(out, line)
		}
	}
	return out
}

// answerSessionsWith lets the fake serve sessions too: thread/start opens a thread, and frames follow
// its answer the way a live session's notifications do.
func (f *fakeCodexBinary) answerSessionsWith(t *testing.T, frames ...map[string]interface{}) {
	t.Helper()
	var after []byte
	for _, frame := range frames {
		data, err := json.Marshal(frame)
		if err != nil {
			t.Fatal(err)
		}
		after = append(append(after, data...), '\n')
	}
	thread, _ := json.Marshal(map[string]interface{}{"thread": map[string]interface{}{"id": "thread-fake-session"}})
	for name, data := range map[string][]byte{"threadStart.json": thread, "afterThreadStart.jsonl": after} {
		if err := os.WriteFile(filepath.Join(f.dir, name), data, 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

// runFakeCodexAppServer is `codex app-server --stdio` for the shim. It records the spawn and every
// frame it receives, answers initialize, account/read and account/rateLimits/read from the answer
// files — thread/start too once a test serves sessions, saying that test's frames after the answer —
// and refuses anything else as the real server refuses an unknown method —
// account/rateLimitResetCredit/consume included, which the recording lets a test rule out.
func runFakeCodexAppServer(dir string) int {
	appendJSONL(filepath.Join(dir, "spawns.jsonl"), map[string]interface{}{"pid": os.Getpid(), "argv": os.Args[1:]})
	answers := map[string]json.RawMessage{"initialize": json.RawMessage(`{"userAgent":"fake-codex/0.154.0"}`)}
	for method, name := range map[string]string{codexAccountReadMethod: "account.json", codexRateLimitsReadMethod: "rateLimits.json", "thread/start": "threadStart.json"} {
		if data, err := os.ReadFile(filepath.Join(dir, name)); err == nil {
			answers[method] = data
		}
	}
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	for scanner.Scan() {
		var frame map[string]interface{}
		if json.Unmarshal(scanner.Bytes(), &frame) != nil {
			continue
		}
		appendJSONL(filepath.Join(dir, "requests.jsonl"), frame)
		id, isRequest := frame["id"]
		if !isRequest {
			continue
		}
		method, _ := frame["method"].(string)
		reply := map[string]interface{}{"id": id}
		if answer, ok := answers[method]; ok {
			reply["result"] = answer
		} else {
			reply["error"] = map[string]interface{}{"code": -32600, "message": "the fake app-server does not answer " + method}
		}
		data, _ := json.Marshal(reply)
		if _, err := os.Stdout.Write(append(data, '\n')); err != nil {
			return 1
		}
		if _, answered := answers[method]; answered && method == "thread/start" {
			after, _ := os.ReadFile(filepath.Join(dir, "afterThreadStart.jsonl"))
			if _, err := os.Stdout.Write(after); err != nil {
				return 1
			}
		}
	}
	return 0
}
