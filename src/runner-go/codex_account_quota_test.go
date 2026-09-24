package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

// Plan usage is kept per Codex account slot (codex_account_usage.go): an account's windows come from
// its own reads and its own sessions, land in its own snapshot, and reach the heartbeat under that
// account — never in Default's windows, and never as a reset block, which is Default's alone.

// codexAccountQuotaRead is an account/rateLimits/read answer whose plan bucket has spent used% of
// its 5h window, with reset credits and an account id beside it as a real read has them.
func codexAccountQuotaRead(used int) map[string]interface{} {
	return map[string]interface{}{
		"rateLimits": map[string]interface{}{
			"limitId": codexPlanLimitID,
			"primary": map[string]interface{}{"usedPercent": used, "windowDurationMins": 300, "resetsAt": 1789003600},
		},
		"rateLimitResetCredits": map[string]interface{}{"availableCount": 1, "credits": nil},
		"accountId":             "acct_orbit_test_quota",
	}
}

// answerInCodexHome makes the fake app-server answer file `name` this way when it runs in codexHome.
func answerInCodexHome(t *testing.T, codexHome, name string, answer interface{}) {
	t.Helper()
	data, err := json.Marshal(answer)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(codexHome, fakeCodexHomeAnswer+name), data, 0o600); err != nil {
		t.Fatal(err)
	}
}

type fakeCodexSpawn struct {
	Argv      []string `json:"argv"`
	CodexHome string   `json:"codexHome"`
}

func (f *fakeCodexBinary) spawns(t *testing.T) []fakeCodexSpawn {
	t.Helper()
	var out []fakeCodexSpawn
	for _, line := range f.lines(t, "spawns.jsonl") {
		var spawn fakeCodexSpawn
		if err := json.Unmarshal([]byte(line), &spawn); err != nil {
			t.Fatal(err)
		}
		out = append(out, spawn)
	}
	return out
}

// sqliteHome is the sqlite_home an app-server spawn was given.
func (s fakeCodexSpawn) sqliteHome() string {
	for i, arg := range s.Argv {
		if arg == "-c" && i+1 < len(s.Argv) && strings.HasPrefix(s.Argv[i+1], "sqlite_home=") {
			return strings.Trim(strings.TrimPrefix(s.Argv[i+1], "sqlite_home="), `"`)
		}
	}
	return ""
}

func codexStatePartitionDir(codexHome string) string {
	return filepath.Join(codexStateRoot(), codexStatePartition(codexHome))
}

// storeSlotUsage puts a read of added slot id into usage, as the slot's own probe stores one.
func storeSlotUsage(usage *codexAccountUsage, id string, read *PlanUsage) {
	usage.mu.Lock()
	probe := usage.slot(id).probe
	usage.mu.Unlock()
	probe.store(read)
}

func TestCodexAccountQuotaSessionSlotIsTheCodexHomeItRunsIn(t *testing.T) {
	home, orbitHome := codexAccountSlotTestHomes(t)
	work, err := createCodexAccountSlot("Work")
	if err != nil {
		t.Fatal(err)
	}
	defaultHome := filepath.Join(home, ".codex")
	execDir := t.TempDir()
	for _, row := range []struct {
		name     string
		agentEnv map[string]string
		execDir  string
		slot     string // empty: no slot's subscription
	}{
		// The three the task names: no CODEX_HOME, Default's, an added slot's.
		{"no CODEX_HOME", nil, execDir, codexAccountDefaultSlot},
		{"CODEX_HOME names Default", map[string]string{"CODEX_HOME": defaultHome}, execDir, codexAccountDefaultSlot},
		{"CODEX_HOME names an added slot", map[string]string{"CODEX_HOME": work.CodexHome}, execDir, work.ID},
		// Resolved as codex resolves it: relative to where the session runs.
		{"a relative CODEX_HOME that lands on the slot", map[string]string{"CODEX_HOME": work.ID}, filepath.Dir(work.CodexHome), work.ID},
		{"CODEX_HOME names some other directory", map[string]string{"CODEX_HOME": t.TempDir()}, execDir, ""},
		{"HOME moves CODEX_HOME", map[string]string{"HOME": t.TempDir()}, execDir, ""},
		{"CODEX_HOME names a slot this runner never added", map[string]string{"CODEX_HOME": filepath.Join(orbitHome, "codex-accounts", "0badf00d")}, execDir, ""},
		// A key of the session's own spends no slot's subscription, whichever CODEX_HOME it runs in.
		{"an added slot with a CODEX_API_KEY", map[string]string{"CODEX_HOME": work.CodexHome, "CODEX_API_KEY": "orbit-test-codex-api-key"}, execDir, ""},
		{"Default with an OPENAI_ variable", map[string]string{"OPENAI_BASE_URL": "https://provider.example.invalid/v1"}, execDir, ""},
	} {
		t.Run(row.name, func(t *testing.T) {
			slot, ok := codexSessionAccountSlot(row.agentEnv, envWithAgent(row.agentEnv), row.execDir)
			if row.slot == "" {
				if ok {
					t.Fatalf("resolved to slot %q, want no slot", slot)
				}
				return
			}
			if !ok || slot != row.slot {
				t.Fatalf("resolved to (%q, %v), want %q", slot, ok, row.slot)
			}
		})
	}
}

// Every row is the real runCodexAppServerSessionProcess handed the per-account merge the way runloop.go
// hands it, against this test binary posing as `codex app-server`: after thread/start it says one
// account/rateLimits/updated for the plan's own bucket, then a text delta, so by the delta the rate
// limits have been dealt with.
func TestCodexAccountQuotaSessionRateLimitsFeedOnlyTheirOwnSlot(t *testing.T) {
	fixture := codexResetReadFixture(t, "details-complete")
	fake := newFakeCodexBinary(t, fixture.account, fixture.rateLimits)
	fake.useAsRunnerDefault(t)
	const handled = "orbit-test: the rate limits before this delta were handled"
	fake.answerSessionsWith(t,
		map[string]interface{}{"method": "account/rateLimits/updated", "params": map[string]interface{}{
			"rateLimits": map[string]interface{}{
				"limitId":   codexPlanLimitID,
				"primary":   map[string]interface{}{"usedPercent": 37, "windowDurationMins": 300, "resetsAt": 1789003600},
				"secondary": map[string]interface{}{"usedPercent": 58, "windowDurationMins": 10080, "resetsAt": 1789400000},
			},
		}},
		map[string]interface{}{"method": "item/agentMessage/delta", "params": map[string]interface{}{"delta": handled}},
	)
	work, err := createCodexAccountSlot("Work")
	if err != nil {
		t.Fatal(err)
	}
	answerInCodexHome(t, work.CodexHome, "rateLimits.json", codexAccountQuotaRead(8))

	// Each account as its own probe reads it: Default's windows with its reset block, Work's without.
	reads := newCodexAccountUsage(codexResetTestLeaseOwner)
	defaultRead, err := reads.def.fetch(context.Background(), reads.def.client)
	if err != nil {
		t.Fatal(err)
	}
	if defaultRead.RateLimitReset == nil || defaultRead.Primary == nil || defaultRead.Primary.Utilization != 100 {
		t.Fatalf("Default's read produced %+v", defaultRead)
	}
	workRead, _, err := fetchCodexAccountPlanUsage(context.Background(), work.CodexHome)
	if err != nil {
		t.Fatal(err)
	}
	if workRead.RateLimitReset != nil || workRead.Primary == nil || workRead.Primary.Utilization != 8 {
		t.Fatalf("Work's read produced %+v", workRead)
	}
	inbox := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-r.Context().Done():
		case <-time.After(200 * time.Millisecond):
		}
		_, _ = w.Write([]byte(`{}`))
	}))
	t.Cleanup(inbox.Close)
	refreshed := func(t *testing.T, got *PlanUsage) {
		t.Helper()
		if got == nil || got.Primary == nil || got.Primary.Utilization != 37 || got.Secondary == nil || got.Secondary.Utilization != 58 {
			t.Fatalf("the session's own account was not refreshed: %+v", got)
		}
	}

	t.Run("a session on an added slot", func(t *testing.T) {
		usage := newCodexAccountUsage(codexResetTestLeaseOwner)
		usage.def.store(defaultRead)
		before := usage.def.snapshot()
		runCodexSessionUntilHandled(t, inbox.URL, map[string]string{"CODEX_HOME": work.CodexHome}, usage.mergeCodexRateLimits, handled)
		// Not one field of Default's snapshot moved: windows, reset block, fetch time.
		if got := usage.def.snapshot(); !reflect.DeepEqual(got, before) {
			t.Fatalf("Work's session wrote into Default's snapshot: %+v, want %+v", got, before)
		}
		accounts := usage.snapshot().Accounts
		if len(accounts) != 1 {
			t.Fatalf("accounts %+v, want Work's alone", accounts)
		}
		refreshed(t, accounts[work.ID])
		if accounts[work.ID].RateLimitReset != nil {
			t.Fatalf("Work's snapshot carries a reset block: %+v", accounts[work.ID].RateLimitReset)
		}
	})

	t.Run("a session on Default", func(t *testing.T) {
		usage := newCodexAccountUsage(codexResetTestLeaseOwner)
		usage.def.store(defaultRead)
		storeSlotUsage(usage, work.ID, workRead)
		runCodexSessionUntilHandled(t, inbox.URL, nil, usage.mergeCodexRateLimits, handled)
		got := usage.def.snapshot()
		refreshed(t, got)
		if got.RateLimitReset == nil || !reflect.DeepEqual(*got.RateLimitReset, *defaultRead.RateLimitReset) {
			t.Fatalf("Default's reset block moved: %+v", got.RateLimitReset)
		}
		if accounts := usage.snapshot().Accounts; len(accounts) != 1 || !reflect.DeepEqual(accounts[work.ID], workRead) {
			t.Fatalf("Default's session wrote into Work's snapshot: %+v, want %+v", accounts[work.ID], workRead)
		}
	})
}

func TestCodexAccountQuotaEachSlotIsReadInItsOwnHomeAndPartition(t *testing.T) {
	fixture := codexResetReadFixture(t, "details-complete")
	fake := newFakeCodexBinary(t, fixture.account, codexAccountQuotaRead(62))
	fake.useAsRunnerDefault(t)
	// Default is signed in. Its auth.json is the file a copied login would come from, so it is a
	// sentinel: its bytes and its mtime must survive every read of another account.
	defaultHome := filepath.Join(os.Getenv("HOME"), ".codex")
	signInCodexHome(t, defaultHome)
	sentinel := filepath.Join(defaultHome, "auth.json")
	pinned := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	if err := os.Chtimes(sentinel, pinned, pinned); err != nil {
		t.Fatal(err)
	}
	sentinelBytes, err := os.ReadFile(sentinel)
	if err != nil {
		t.Fatal(err)
	}
	work, err := createCodexAccountSlot("Work")
	if err != nil {
		t.Fatal(err)
	}
	answerInCodexHome(t, work.CodexHome, "rateLimits.json", codexAccountQuotaRead(8))

	// One pass the way run makes it: Default's probe, then every listed slot's.
	ctx := context.Background()
	usage := newCodexAccountUsage(codexResetTestLeaseOwner)
	read, err := usage.def.fetch(ctx, usage.def.client)
	if err != nil {
		t.Fatal(err)
	}
	usage.def.store(read)
	started := 0
	usage.syncSlots(ctx, func(_ context.Context, probe *planUsageProbe) {
		started++
		read, err := probe.fetch(ctx, probe.client)
		if err != nil {
			t.Fatal(err)
		}
		probe.store(read)
	})
	if started != 1 {
		t.Fatalf("started %d slot probes, want Work's", started)
	}

	got := usage.snapshot()
	if got.Primary == nil || got.Primary.Utilization != 62 || got.RateLimitReset == nil {
		t.Fatalf("Default's snapshot %+v, want its own 62%% and its reset block", got)
	}
	if len(got.Accounts) != 1 || got.Accounts[work.ID] == nil {
		t.Fatalf("accounts %+v, want Work's", got.Accounts)
	}
	if w := got.Accounts[work.ID]; w.Primary == nil || w.Primary.Utilization != 8 || w.RateLimitReset != nil {
		t.Fatalf("Work's snapshot %+v, want its own 8%% and no reset block", w)
	}

	// On the wire: Default's windows where every reader has always found them, Work's under its id.
	wire, err := json.Marshal(HeartbeatRequest{PlanUsage: combinePlanUsage(nil, got)})
	if err != nil {
		t.Fatal(err)
	}
	var beat struct {
		PlanUsage struct {
			Primary        PlanUsageWindow                       `json:"primary"`
			RateLimitReset json.RawMessage                       `json:"rateLimitReset"`
			Accounts       map[string]map[string]json.RawMessage `json:"accounts"`
		} `json:"planUsage"`
	}
	if err := json.Unmarshal(wire, &beat); err != nil {
		t.Fatal(err)
	}
	var workPrimary PlanUsageWindow
	if err := json.Unmarshal(beat.PlanUsage.Accounts[work.ID]["primary"], &workPrimary); err != nil {
		t.Fatalf("no primary window for Work on the wire: %s", wire)
	}
	if beat.PlanUsage.Primary.Utilization != 62 || len(beat.PlanUsage.RateLimitReset) == 0 || workPrimary.Utilization != 8 {
		t.Fatalf("heartbeat planUsage %s", wire)
	}
	if _, ok := beat.PlanUsage.Accounts[work.ID]["rateLimitReset"]; ok {
		t.Fatalf("Work carries a reset block on the wire: %s", wire)
	}

	// Every app-server of Work's ran in Work's CODEX_HOME on Work's own partition, and every other one
	// in Default's — the runner's own environment, or its bootstrap naming that same home: no fresh
	// sqlite_home, and neither account's state opened for the other.
	workSpawns := 0
	for _, spawn := range fake.spawns(t) {
		want := codexStatePartitionDir(defaultHome)
		if spawn.CodexHome == work.CodexHome {
			want = codexStatePartitionDir(work.CodexHome)
			workSpawns++
		} else if spawn.CodexHome != "" && spawn.CodexHome != defaultHome {
			t.Fatalf("an app-server ran in CODEX_HOME %s", spawn.CodexHome)
		}
		if got := spawn.sqliteHome(); got != want {
			t.Fatalf("an app-server in CODEX_HOME %q had sqlite_home %q, want %q", spawn.CodexHome, got, want)
		}
	}
	if workSpawns == 0 {
		t.Fatal("no app-server ran in Work's CODEX_HOME")
	}
	// Nothing was copied from Default's login into Work, and Default's was not touched.
	if _, err := os.Lstat(filepath.Join(work.CodexHome, "auth.json")); !os.IsNotExist(err) {
		t.Fatalf("Work's CODEX_HOME has an auth.json: %v", err)
	}
	info, err := os.Stat(sentinel)
	if err != nil {
		t.Fatal(err)
	}
	now, err := os.ReadFile(sentinel)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(now, sentinelBytes) || !info.ModTime().Equal(pinned) {
		t.Fatalf("Default's auth.json changed: %q at %v", now, info.ModTime())
	}
}

// A slot's read starts its app-server under the handshake lock of the slot's own partition, the lock
// a session starting on that slot takes: held there, the read waits; held on Default's, it does not.
func TestCodexAccountQuotaSlotReadHoldsItsOwnPartitionsHandshakeLock(t *testing.T) {
	fixture := codexResetReadFixture(t, "details-complete")
	fake := newFakeCodexBinary(t, fixture.account, fixture.rateLimits)
	fake.useAsRunnerDefault(t)
	work, err := createCodexAccountSlot("Work")
	if err != nil {
		t.Fatal(err)
	}
	answerInCodexHome(t, work.CodexHome, "rateLimits.json", codexAccountQuotaRead(8))
	ctx := context.Background()
	// The first read bootstraps the slot's partition; later ones take only the handshake lock.
	if _, _, err := fetchCodexAccountPlanUsage(ctx, work.CodexHome); err != nil {
		t.Fatal(err)
	}
	workSpawns := func() int {
		n := 0
		for _, spawn := range fake.spawns(t) {
			if spawn.CodexHome == work.CodexHome {
				n++
			}
		}
		return n
	}
	lock := func(t *testing.T, codexHome string) func() {
		t.Helper()
		path, err := codexStateInitLockPath(codexStatePartition(codexHome))
		if err != nil {
			t.Fatal(err)
		}
		unlock, err := acquireCodexStateInitFileLock(ctx, path)
		if err != nil {
			t.Fatal(err)
		}
		return unlock
	}
	read := func() chan error {
		done := make(chan error, 1)
		go func() {
			usage, _, err := fetchCodexAccountPlanUsage(ctx, work.CodexHome)
			if err == nil && (usage.Primary == nil || usage.Primary.Utilization != 8) {
				err = fmt.Errorf("Work's read came back as %+v, not its own 8%%", usage)
			}
			done <- err
		}()
		return done
	}

	t.Run("Default's lock does not hold it", func(t *testing.T) {
		unlock := lock(t, filepath.Join(os.Getenv("HOME"), ".codex"))
		defer unlock()
		select {
		case err := <-read():
			if err != nil {
				t.Fatal(err)
			}
		case <-time.After(30 * time.Second):
			t.Fatal("Work's read waited on Default's partition")
		}
	})

	t.Run("its own partition's lock does", func(t *testing.T) {
		unlock := lock(t, work.CodexHome)
		before := workSpawns()
		done := read()
		select {
		case err := <-done:
			unlock()
			t.Fatalf("Work's read ran while its partition was locked: %v", err)
		case <-time.After(500 * time.Millisecond):
		}
		if n := workSpawns(); n != before {
			unlock()
			t.Fatalf("%d app-server(s) started in Work's partition while it was locked", n-before)
		}
		unlock()
		select {
		case err := <-done:
			if err != nil {
				t.Fatal(err)
			}
		case <-time.After(30 * time.Second):
			t.Fatal("Work's read never ran once its partition's lock was released")
		}
		if n := workSpawns(); n != before+1 {
			t.Fatalf("%d app-server(s) for the read, want 1", n-before)
		}
	})
}

// The accounts read are the slots the runner has: one it adds is picked up, one that is gone is no
// longer read or reported. A session's rate limits reach a slot's snapshot before its first read.
func TestCodexAccountQuotaFollowsTheSlotsTheRunnerHas(t *testing.T) {
	codexAccountSlotTestHomes(t)
	work, err := createCodexAccountSlot("Work")
	if err != nil {
		t.Fatal(err)
	}
	usage := newCodexAccountUsage(codexResetTestLeaseOwner)
	loops := map[*planUsageProbe]context.Context{}
	start := func(ctx context.Context, probe *planUsageProbe) { loops[probe] = ctx }
	usage.syncSlots(context.Background(), start)
	usage.syncSlots(context.Background(), start)
	workProbe := usage.slots[work.ID].probe
	if len(loops) != 1 || loops[workProbe] == nil {
		t.Fatalf("started %d loops, want Work's once", len(loops))
	}

	usage.mergeCodexRateLimits(work.ID, map[string]interface{}{
		"limitId": codexPlanLimitID,
		"primary": map[string]interface{}{"usedPercent": 8, "windowDurationMins": 300},
	})
	got := usage.snapshot()
	// Nothing of Default's has been read: the report holds Work's and no windows of Default's.
	if got == nil || got.Provider != providerCodex || got.Primary != nil || got.RateLimitReset != nil ||
		got.Accounts[work.ID] == nil || got.Accounts[work.ID].Primary.Utilization != 8 {
		t.Fatalf("snapshot %+v", got)
	}

	personal, err := createCodexAccountSlot("Personal")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(work.CodexHome); err != nil {
		t.Fatal(err)
	}
	usage.syncSlots(context.Background(), start)
	if loops[workProbe].Err() == nil {
		t.Fatal("Work's loop still runs after Work is gone")
	}
	if _, ok := usage.slots[work.ID]; ok {
		t.Fatal("Work is still kept after it is gone")
	}
	if p := usage.slots[personal.ID]; p == nil || loops[p.probe] == nil {
		t.Fatal("Personal is not read after it was added")
	}
	if got := usage.snapshot(); got != nil {
		t.Fatalf("snapshot %+v after the only account read is gone", got)
	}
}
