package main

import (
	"context"
	"crypto/sha256"
	"fmt"
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

// fakeKimiForAccounts stands in for kimi wherever the runner runs it about an account. Every call
// appends "<args>\t<the KIMI_CODE_HOME it runs in>" to $FAKE_KIMI_SEEN and answers from that home the
// way Kimi Code 2.1 does: `login [--region R]` prints the device code on R's site and then writes the
// login into the home it runs in — config.toml with the managed provider, and credentials/, the files
// a sign-in into the wrong account would overwrite; `acp` answers authenticate from those credentials;
// `provider list --json` reads the managed provider back on the site it was signed in on.
// $FAKE_KIMI_LOGIN_FAILS makes the sign-in end without signing in, $FAKE_KIMI_HELP_WITHOUT_REGION makes
// it a Kimi Code older than --region, and $FAKE_KIMI_ACP_CAPTURE makes `acp` write down where the
// stores of the home it runs in lead, and exit.
const fakeKimiForAccounts = `home="${KIMI_CODE_HOME:-$HOME/.kimi-code}"
printf '%s\t%s\n' "$*" "$home" >> "$FAKE_KIMI_SEEN"
case "$1" in
--version) echo 2.1.1 ;;
login)
	if [ "$2" = "--help" ]; then
		[ -n "$FAKE_KIMI_HELP_WITHOUT_REGION" ] || echo '  --region <region>  Login region: "mainland-cn" (kimi.com) or "global" (kimi.ai).'
		exit 0
	fi
	site=mainland-cn host=www.kimi.com model=kimi-code/kimi-for-coding
	if [ "$2 $3" = "--region global" ]; then site=global host=www.kimi.ai model=kimi-code/k3; fi
	printf '\nOpening browser for Kimi device login: https://%s/code/authorize_device?user_code=7K06-QP86\nIf the browser did not open, paste the URL above and enter code: 7K06-QP86\n' "$host" >&2
	sleep 1
	[ -z "$FAKE_KIMI_LOGIN_FAILS" ] || exit 4
	mkdir -p "$home/credentials"
	printf 'default_model = "%s"\n# fake-site = %s\n[providers."managed:kimi-code"]\ntype = "kimi"\n' "$model" "$site" > "$home/config.toml"
	printf '{"access_token":"signed in on %s"}' "$site" > "$home/credentials/kimi-code.json" ;;
acp)
	if [ -n "$FAKE_KIMI_ACP_CAPTURE" ]; then
		for store in credentials oauth sessions; do printf '%s %s\n' "$store" "$(readlink "$home/$store")" >> "$FAKE_KIMI_ACP_CAPTURE"; done
		exit 0
	fi
	while IFS= read -r line; do
		case "$line" in
		*'"method":"initialize"'*) echo '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}' ;;
		*'"method":"authenticate"'*)
			if [ -f "$home/credentials/kimi-code.json" ]; then echo '{"jsonrpc":"2.0","id":2,"result":{}}'
			else echo '{"jsonrpc":"2.0","id":2,"error":{"code":-32000,"message":"Authentication required"}}'; fi ;;
		esac
	done ;;
provider)
	case "$(sed -n 's/^# fake-site = //p' "$home/config.toml" 2>/dev/null)" in
	global) echo '{"providers":{"managed:kimi-code":{"type":"kimi","baseUrl":"https://api.kimi.ai/coding/v1","apiKey":"","oauth":{"storage":"file","key":"oauth/kimi-code-env-0123456789abcdef","oauthHost":"https://auth.kimi.ai"}}},"models":{"kimi-code/k3":{"displayName":"K3","maxContextSize":262144}}}' ;;
	mainland-cn) echo '{"providers":{"managed:kimi-code":{"type":"kimi","baseUrl":"https://api.kimi.com/coding/v1","apiKey":"","oauth":{"storage":"file","key":"oauth/kimi-code"}}},"models":{"kimi-code/kimi-for-coding":{"displayName":"Kimi for Coding","maxContextSize":262144}}}' ;;
	*) echo '{"providers": {}, "models": {}}' ;;
	esac ;;
--resume) ;;
*) exit 2 ;;
esac`

// kimiAccountTestHomes gives the runner a throwaway HOME, whose ~/.kimi-code is Default, and a
// throwaway ORBIT_HOME for the accounts it adds — and no KIMI_CODE_HOME or environment-backed model
// of its own, either of which would decide what Default is.
func kimiAccountTestHomes(t *testing.T) (defaultHome, orbitHome string) {
	t.Helper()
	root := t.TempDir()
	home := filepath.Join(root, "home")
	orbitHome = filepath.Join(root, "orbit")
	t.Setenv("HOME", home)
	t.Setenv("ORBIT_HOME", orbitHome)
	t.Setenv("KIMI_CODE_HOME", "")
	t.Setenv("KIMI_MODEL_NAME", "")
	t.Setenv("KIMI_MODEL_API_KEY", "")
	return filepath.Join(home, ".kimi-code"), orbitHome
}

// installFakeKimiForAccounts puts fakeKimiForAccounts first on PATH — sign-ins, the model list and
// sessions exec `kimi` by name — and makes it the binary the relay probes. It returns the binary and
// the file its calls are written to.
func installFakeKimiForAccounts(t *testing.T) (bin, seen string) {
	t.Helper()
	dir := t.TempDir()
	bin = writeFakeBin(t, dir, providerKimi, fakeKimiForAccounts)
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	seen = filepath.Join(t.TempDir(), "seen")
	t.Setenv("FAKE_KIMI_SEEN", seen)
	previous := lookLoginEngine
	lookLoginEngine = func(engine string) (string, bool) { return bin, engine == providerKimi }
	t.Cleanup(func() { lookLoginEngine = previous })
	return bin, seen
}

// signInKimiHome writes into home the login fakeKimiForAccounts' sign-in writes, on site.
func signInKimiHome(t *testing.T, home, site string) {
	t.Helper()
	model := "kimi-code/kimi-for-coding"
	if site == kimiRegionGlobal {
		model = "kimi-code/k3"
	}
	if err := os.MkdirAll(filepath.Join(home, "credentials"), 0o700); err != nil {
		t.Fatal(err)
	}
	config := fmt.Sprintf("default_model = %q\n# fake-site = %s\n[providers.\"managed:kimi-code\"]\ntype = \"kimi\"\n", model, site)
	if err := os.WriteFile(filepath.Join(home, "config.toml"), []byte(config), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "credentials", "kimi-code.json"), []byte(`{"access_token":"signed in on `+site+`"}`), 0o600); err != nil {
		t.Fatal(err)
	}
}

// kimiTreeSnapshot is every entry under dir — its mode, size, modification time and, for a file, a
// digest of what it holds: what "untouched" means for a home nothing may write to. A file added,
// removed or rewritten, even with the same bytes, shows; so does a directory gaining an entry.
func kimiTreeSnapshot(t *testing.T, dir string) map[string]string {
	t.Helper()
	out := map[string]string{}
	err := filepath.WalkDir(dir, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		info, err := os.Lstat(path)
		if err != nil {
			return err
		}
		digest := ""
		if info.Mode().IsRegular() {
			b, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			digest = fmt.Sprintf("%x", sha256.Sum256(b))
		}
		rel, _ := filepath.Rel(dir, path)
		out[rel] = fmt.Sprintf("%v %d %d %s", info.Mode(), info.Size(), info.ModTime().UnixNano(), digest)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return out
}

// kimiCallsIn is every call the fake kimi saw, as "<args>\t<home>".
func kimiCallsIn(t *testing.T, seen string) []string {
	t.Helper()
	b, err := os.ReadFile(seen)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		t.Fatal(err)
	}
	var out []string
	for _, line := range strings.Split(string(b), "\n") {
		if line != "" {
			out = append(out, line)
		}
	}
	return out
}

func assertKimiPrivateDir(t *testing.T, dir string) {
	t.Helper()
	info, err := os.Lstat(dir)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		t.Fatalf("%s is not a real directory: %v", dir, info.Mode())
	}
	if runtime.GOOS != "windows" && info.Mode().Perm() != 0o700 {
		t.Fatalf("%s mode = %04o, want 0700", dir, info.Mode().Perm())
	}
}

// kimiAccountRelay is a sign-in relay whose reports are kept, so a test can wait for them.
type kimiAccountRelay struct {
	relay   *loginRelay
	mu      sync.Mutex
	reports []LoginResultRequest
}

func newKimiAccountRelay(t *testing.T) *kimiAccountRelay {
	r := &kimiAccountRelay{relay: &loginRelay{}}
	t.Cleanup(r.relay.stop)
	return r
}

func (r *kimiAccountRelay) start(lr LoginCommand) {
	lr.Action, lr.Engine = "start", providerKimi
	r.relay.start(lr, func(res LoginResultRequest) {
		r.mu.Lock()
		r.reports = append(r.reports, res)
		r.mu.Unlock()
	})
}

// outcome waits for attempt's done or failed report and returns every report about attempt so far.
func (r *kimiAccountRelay) outcome(t *testing.T, attempt string) []LoginResultRequest {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	for {
		r.mu.Lock()
		var got []LoginResultRequest
		for _, res := range r.reports {
			if res.Attempt == attempt {
				got = append(got, res)
			}
		}
		r.mu.Unlock()
		if n := len(got); n > 0 && (got[n-1].Status == loginDone || got[n-1].Status == loginFailed) {
			return got
		}
		if time.Now().After(deadline) {
			t.Fatalf("no outcome for attempt %q; reported %+v", attempt, got)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// addedKimiSlots is every account the runner added, with what is on disk now.
func addedKimiSlots(t *testing.T) []accountSlot {
	t.Helper()
	slots, err := kimiAccountKind.list()
	if err != nil {
		t.Fatal(err)
	}
	return slots[1:]
}

// A new account is added and signed in on the site the start names, in a home of its own: every
// kimi its sign-in runs, the help that decides whether --region is understood included, runs there,
// and Default's home is not written to at all.
func TestKimiLoginAddsANamedAccountOnTheChosenSite(t *testing.T) {
	defaultHome, orbitHome := kimiAccountTestHomes(t)
	_, seen := installFakeKimiForAccounts(t)
	signInKimiHome(t, defaultHome, kimiRegionMainland)
	before := kimiTreeSnapshot(t, defaultHome)

	r := newKimiAccountRelay(t)
	const attempt = "2026-10-08T13:00:00.000Z"
	r.start(LoginCommand{AccountName: "Work", Region: kimiRegionGlobal, Attempt: attempt})
	got := r.outcome(t, attempt)
	r.relay.wg.Wait()

	added := addedKimiSlots(t)
	if len(added) != 1 || added[0].Name != "Work" {
		t.Fatalf("added accounts = %#v, want the one named Work", added)
	}
	work := added[0]
	if want := filepath.Join(orbitHome, "kimi-accounts", work.ID); work.Dir != want {
		t.Fatalf("Work lives at %s, want %s", work.Dir, want)
	}
	assertKimiPrivateDir(t, work.Dir)
	if len(got) != 2 || got[0].Status != loginAwaitingApproval || got[1].Status != loginDone {
		t.Fatalf("reports = %+v, want the device code and then done", got)
	}
	if got[0].URL != "https://www.kimi.ai/code/authorize_device?user_code=7K06-QP86" || got[0].UserCode != "7K06-QP86" {
		t.Fatalf("published %q / %q, want kimi.ai's page and its code", got[0].URL, got[0].UserCode)
	}
	for _, res := range got {
		if res.Account != work.ID {
			t.Fatalf("report %+v names account %q, want the one this attempt added (%s)", res, res.Account, work.ID)
		}
	}
	want := []string{"login --help\t" + work.Dir, "login --region global\t" + work.Dir}
	if calls := kimiCallsIn(t, seen); !reflect.DeepEqual(calls, want) {
		t.Fatalf("kimi ran as %q, want %q", calls, want)
	}
	if !kimiLoginSavedIn(work.Dir) {
		t.Fatal("Work keeps no login after its sign-in")
	}
	if _, err := os.Stat(filepath.Join(work.Dir, "credentials", "kimi-code.json")); err != nil {
		t.Fatalf("Work's credentials are not in its own home: %v", err)
	}
	if after := kimiTreeSnapshot(t, defaultHome); !reflect.DeepEqual(after, before) {
		t.Fatalf("Default's home changed:\nbefore %v\nafter  %v", before, after)
	}
}

// An add that ends without a sign-in leaves no account behind: the empty one it added is taken away
// again, every kimi it ran ran in that account's home, and Default's is not written to.
func TestKimiLoginAccountThatIsNotSignedInIsTakenAway(t *testing.T) {
	for _, c := range []struct {
		name, env, message string
		want               func(slot string) []string
	}{
		{
			name: "the sign-in ends signed out", env: "FAKE_KIMI_LOGIN_FAILS", message: "sign-in did not complete",
			// The sign-in, the question whether it landed after all, and whether the account is
			// signed in before it is taken away — each in the account's home.
			want: func(slot string) []string {
				return []string{"login --help\t" + slot, "login --region global\t" + slot, "acp\t" + slot, "acp\t" + slot}
			},
		},
		{
			name: "kimi too old for kimi.ai", env: "FAKE_KIMI_HELP_WITHOUT_REGION", message: "too old to sign in on kimi.ai",
			want: func(slot string) []string { return []string{"login --help\t" + slot, "acp\t" + slot} },
		},
	} {
		t.Run(c.name, func(t *testing.T) {
			defaultHome, orbitHome := kimiAccountTestHomes(t)
			_, seen := installFakeKimiForAccounts(t)
			t.Setenv(c.env, "1")
			signInKimiHome(t, defaultHome, kimiRegionMainland)
			before := kimiTreeSnapshot(t, defaultHome)

			r := newKimiAccountRelay(t)
			const attempt = "2026-10-08T13:10:00.000Z"
			r.start(LoginCommand{AccountName: "Work", Region: kimiRegionGlobal, Attempt: attempt})
			got := r.outcome(t, attempt)
			if last := got[len(got)-1]; last.Status != loginFailed || !strings.Contains(last.Message, c.message) {
				t.Fatalf("reports = %+v, want a failure saying %q", got, c.message)
			}
			// The account is taken away after the failure is reported; wait for the sign-in to end.
			r.relay.wg.Wait()
			calls := kimiCallsIn(t, seen)
			if len(calls) == 0 {
				t.Fatal("kimi never ran")
			}
			slot := strings.SplitN(calls[0], "\t", 2)[1]
			if filepath.Dir(slot) != filepath.Join(orbitHome, "kimi-accounts") {
				t.Fatalf("the sign-in ran in %s, not in an added account's home", slot)
			}
			if want := c.want(slot); !reflect.DeepEqual(calls, want) {
				t.Fatalf("kimi ran as %q, want %q", calls, want)
			}
			if added := addedKimiSlots(t); len(added) != 0 {
				t.Fatalf("the failed add left accounts behind: %#v", added)
			}
			if _, err := os.Lstat(slot); !os.IsNotExist(err) {
				t.Fatalf("the empty account's home outlived the attempt (err %v)", err)
			}
			if _, err := os.Lstat(slot + ".json"); !os.IsNotExist(err) {
				t.Fatalf("the empty account's record outlived the attempt (err %v)", err)
			}
			// A redelivery of the same start fails too, rather than adding the account back.
			r.start(LoginCommand{AccountName: "Work", Region: kimiRegionGlobal, Attempt: attempt})
			r.relay.wg.Wait()
			r.mu.Lock()
			reports := append([]LoginResultRequest(nil), r.reports...)
			r.mu.Unlock()
			if len(reports) != len(got)+1 || reports[len(got)].Status != loginFailed {
				t.Fatalf("reports after the redelivery = %+v, want one more failure", reports)
			}
			if added := addedKimiSlots(t); len(added) != 0 {
				t.Fatalf("the redelivered start added an account: %#v", added)
			}
			if calls := kimiCallsIn(t, seen); len(calls) != len(c.want(slot)) {
				t.Fatalf("the redelivered start ran kimi: %q", calls)
			}
			if after := kimiTreeSnapshot(t, defaultHome); !reflect.DeepEqual(after, before) {
				t.Fatalf("Default's home changed:\nbefore %v\nafter  %v", before, after)
			}
		})
	}
}

// The heartbeat lists every Kimi account with its own sign-in and its own site, each asked in its own
// home; Default's answers are the engine probe's, which the engine's own auth and kimiRegion still
// carry.
func TestKimiEngineHealthReportsEveryAccountAndItsSite(t *testing.T) {
	defaultHome, _ := kimiAccountTestHomes(t)
	bin, seen := installFakeKimiForAccounts(t)
	signInKimiHome(t, defaultHome, kimiRegionMainland)
	work, err := kimiAccountKind.create("Work")
	if err != nil {
		t.Fatal(err)
	}
	signInKimiHome(t, work.Dir, kimiRegionGlobal)
	idle, err := kimiAccountKind.create("Idle")
	if err != nil {
		t.Fatal(err)
	}
	spec, _ := specFor(providerKimi)

	reports := probeEngines([]engineSpec{spec}, filepath.Dir(bin))
	if len(reports) != 1 || !reports[0].Installed || reports[0].Auth != "yes" || reports[0].KimiRegion != kimiRegionMainland {
		t.Fatalf("report = %+v, want Kimi installed, signed in, on kimi.com", reports)
	}
	want := []EngineAccountReport{
		{ID: accountSlotDefaultID, Dir: defaultHome, Auth: "yes", KimiRegion: kimiRegionMainland},
		{ID: work.ID, Name: "Work", Dir: work.Dir, Auth: "yes", KimiRegion: kimiRegionGlobal},
		{ID: idle.ID, Name: "Idle", Dir: idle.Dir, Auth: "no"},
	}
	if !reflect.DeepEqual(reports[0].Accounts, want) {
		t.Fatalf("accounts = %#v\nwant %#v", reports[0].Accounts, want)
	}
	// On the wire: {id, name, home, auth, kimiRegion}, and nothing under Codex's old name.
	wire := heartbeatEngines(t, reports)[0]
	accounts, _ := wire["accounts"].([]interface{})
	if len(accounts) != 3 {
		t.Fatalf("wire accounts = %#v", wire["accounts"])
	}
	if got, want := accounts[1], map[string]interface{}{"id": work.ID, "name": "Work", "home": work.Dir, "auth": "yes", "kimiRegion": kimiRegionGlobal}; !reflect.DeepEqual(got, want) {
		t.Fatalf("Work on the wire = %#v, want %#v", got, want)
	}
	if got := accounts[2].(map[string]interface{}); got["kimiRegion"] != nil || got["auth"] != "no" {
		t.Fatalf("Idle on the wire = %#v, want signed out and on no site", got)
	}
	if wire["kimiRegion"] != kimiRegionMainland {
		t.Fatalf("engine kimiRegion = %#v, want Default's", wire["kimiRegion"])
	}
	// Each account asked once, in its own home; Default's questions only by the engine probe.
	wantCalls := []string{
		"--version\t" + defaultHome, "acp\t" + defaultHome, "provider list --json\t" + defaultHome,
		"acp\t" + work.Dir, "provider list --json\t" + work.Dir,
		"acp\t" + idle.Dir, "provider list --json\t" + idle.Dir,
	}
	if calls := kimiCallsIn(t, seen); !reflect.DeepEqual(calls, wantCalls) {
		t.Fatalf("kimi ran as %q\nwant %q", calls, wantCalls)
	}
}

// A session's sign-in preflight asks the account the session was dispatched onto, not Default.
func TestKimiSessionSignInIsAskedOfItsAccount(t *testing.T) {
	_, _ = kimiAccountTestHomes(t)
	bin, _ := installFakeKimiForAccounts(t)
	work, err := kimiAccountKind.create("Work")
	if err != nil {
		t.Fatal(err)
	}
	signInKimiHome(t, work.Dir, kimiRegionGlobal)
	if got := sessionEngineAuth(providerKimi, bin, map[string]string{"KIMI_CODE_HOME": work.Dir}); got != authYes {
		t.Fatalf("a session on Work = %v, want signed in", got)
	}
	if got := sessionEngineAuth(providerKimi, bin, nil); got != authNo {
		t.Fatalf("a session on Default, never signed in = %v, want signed out", got)
	}
}

// Removing an account takes its home and its record and nothing else; one a running session is on is
// refused; Default is never removed; and an account once gone is signed out without being brought back.
func TestKimiAccountRemoval(t *testing.T) {
	defaultHome, orbitHome := kimiAccountTestHomes(t)
	signInKimiHome(t, defaultHome, kimiRegionMainland)
	before := kimiTreeSnapshot(t, defaultHome)
	work, err := kimiAccountKind.create("Work")
	if err != nil {
		t.Fatal(err)
	}
	signInKimiHome(t, work.Dir, kimiRegionGlobal)

	// Two running sessions, recorded the way a session's run records itself before its kimi starts.
	const onWork, onDefault = "5d0c3c0e-1d0f-4c6e-9a7b-2f3e4d5c6b7a", "6e1d4d1f-2e10-4d7f-8b8c-3f4e5d6c7b8a"
	for id, env := range map[string]map[string]string{onWork: {"KIMI_CODE_HOME": work.Dir}, onDefault: nil} {
		if err := os.MkdirAll(runDir(id), 0o700); err != nil {
			t.Fatal(err)
		}
		writeSessionMeta(runDir(id), &ClaimedSession{SessionID: id, SessionUUID: id, Provider: providerKimi,
			Agent: AgentExecConfig{Provider: providerKimi, Env: env}}, t.TempDir())
	}
	if meta := readSessionMeta(filepath.Join(runDir(onWork), "meta.json")); meta == nil || meta.KimiCodeHome != work.Dir {
		t.Fatalf("the session on Work records %#v, want its home", meta)
	}
	if meta := readSessionMeta(filepath.Join(runDir(onDefault), "meta.json")); meta == nil || meta.KimiCodeHome != "" {
		t.Fatalf("the session on Default records %#v, want no account", meta)
	}
	live := kimiAccountKind.liveDirs([]string{onWork, onDefault})
	if !reflect.DeepEqual(live, map[string]bool{work.Dir: true}) {
		t.Fatalf("live homes = %v, want only Work's", live)
	}

	if err := removeAccount(kimiAccountKind, nil, nil, work.ID, live); err == nil || !strings.Contains(err.Error(), "in use") {
		t.Fatalf("removing Work under a running session = %v, want it refused", err)
	}
	if _, err := os.Stat(filepath.Join(work.Dir, "credentials", "kimi-code.json")); err != nil {
		t.Fatalf("the refused removal took Work's login: %v", err)
	}

	// That session over, the account goes: its home and its record, and nothing else.
	if err := removeAccount(kimiAccountKind, nil, nil, work.ID, kimiAccountKind.liveDirs([]string{onDefault})); err != nil {
		t.Fatalf("removing Work: %v", err)
	}
	for _, path := range []string{work.Dir, filepath.Join(orbitHome, "kimi-accounts", work.ID+".json")} {
		if _, err := os.Lstat(path); !os.IsNotExist(err) {
			t.Fatalf("%s outlived the removal (err %v)", path, err)
		}
	}
	// Redelivered until the runner reports: done again.
	if err := removeAccount(kimiAccountKind, nil, nil, work.ID, nil); err != nil {
		t.Fatalf("removing Work again: %v", err)
	}
	if err := removeAccount(kimiAccountKind, nil, nil, accountSlotDefaultID, nil); err == nil {
		t.Fatal("Default was removable")
	}
	if after := kimiTreeSnapshot(t, defaultHome); !reflect.DeepEqual(after, before) {
		t.Fatalf("Default's home changed:\nbefore %v\nafter  %v", before, after)
	}

	// Gone is signed out. A kimi asked there would make the home it runs in — as the real one does —
	// and bring the account back as an empty one, so it is not asked.
	bin := writeFakeBin(t, t.TempDir(), providerKimi, `mkdir -p "$KIMI_CODE_HOME/logs"; exit 1`)
	if got := kimiSlotLoginStatus(context.Background(), bin, work.Dir); got != authNo {
		t.Fatalf("a removed account = %v, want signed out", got)
	}
	if _, err := os.Lstat(work.Dir); !os.IsNotExist(err) {
		t.Fatalf("asking about the removed account brought its home back (err %v)", err)
	}
}

// A session runs in an overlay of its account's home, and the stores Kimi writes a session's lasting
// state into — sessions/, oauth/, credentials/ — exist in that home before kimi starts, 0700, so the
// overlay borrows them instead of Kimi making them inside the overlay, where they would go with it.
// Default's home gets them the same way; an account removed since dispatch is not brought back.
func TestKimiSessionBorrowsItsAccountsHomeWithItsStoresMade(t *testing.T) {
	defaultHome, _ := kimiAccountTestHomes(t)
	installFakeKimiForAccounts(t)
	capture := filepath.Join(t.TempDir(), "capture")
	t.Setenv("FAKE_KIMI_ACP_CAPTURE", capture)
	signInKimiHome(t, defaultHome, kimiRegionMainland)
	work, err := kimiAccountKind.create("Work")
	if err != nil {
		t.Fatal(err)
	}
	signInKimiHome(t, work.Dir, kimiRegionGlobal)

	run := func(env map[string]string) []string {
		t.Helper()
		_ = os.Remove(capture)
		scratch := t.TempDir()
		job := &ClaimedSession{SessionID: "kimi-account-session", SessionUUID: "kimi-account-session", Provider: providerKimi,
			Agent: AgentExecConfig{Provider: providerKimi, Env: env}}
		var mu sync.Mutex
		var errors []string
		emit := func(eventType string, payload map[string]interface{}) {
			if eventType == evError {
				mu.Lock()
				errors = append(errors, fmt.Sprint(payload["message"]))
				mu.Unlock()
			}
		}
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		status, _, _ := runKimiSessionProcess(ctx, ctx, NewTransport("http://127.0.0.1:1", "runner-token"), job, "1", t.TempDir(), scratch,
			emit, nil, func(string) {}, false, nil, nil, nil, nil)
		if status != stFailed {
			t.Fatalf("status = %q, want the fake's exit to end the run", status)
		}
		// The overlay goes with the run; what it borrowed stays.
		if _, err := os.Lstat(filepath.Join(scratch, "kimi-home")); !os.IsNotExist(err) {
			t.Fatalf("the overlay outlived the run (err %v)", err)
		}
		mu.Lock()
		defer mu.Unlock()
		return errors
	}
	borrowed := func(home string) {
		t.Helper()
		b, err := os.ReadFile(capture)
		if err != nil {
			t.Fatalf("kimi never started: %v", err)
		}
		want := ""
		for _, store := range kimiHomeStores {
			want += store + " " + filepath.Join(home, store) + "\n"
			assertKimiPrivateDir(t, filepath.Join(home, store))
		}
		if string(b) != want {
			t.Fatalf("kimi started with its stores leading to\n%s\nwant\n%s", b, want)
		}
	}

	defaultBefore := kimiTreeSnapshot(t, defaultHome)
	run(map[string]string{"KIMI_CODE_HOME": work.Dir})
	borrowed(work.Dir)
	if after := kimiTreeSnapshot(t, defaultHome); !reflect.DeepEqual(after, defaultBefore) {
		t.Fatalf("a session on Work changed Default's home:\nbefore %v\nafter  %v", defaultBefore, after)
	}

	run(nil)
	borrowed(defaultHome)
	if b, err := os.ReadFile(filepath.Join(defaultHome, "credentials", "kimi-code.json")); err != nil || !strings.Contains(string(b), kimiRegionMainland) {
		t.Fatalf("Default's login after its session = %q, %v", b, err)
	}

	// Removed after the session was dispatched: refused, and not made again.
	if err := removeAccount(kimiAccountKind, nil, nil, work.ID, nil); err != nil {
		t.Fatal(err)
	}
	errors := run(map[string]string{"KIMI_CODE_HOME": work.Dir})
	if len(errors) != 1 || !strings.Contains(errors[0], "this runner has no Kimi account at "+work.Dir) {
		t.Fatalf("errors = %q, want the missing account named", errors)
	}
	if _, err := os.Lstat(capture); !os.IsNotExist(err) {
		t.Fatal("kimi started on a removed account")
	}
	if _, err := os.Lstat(work.Dir); !os.IsNotExist(err) {
		t.Fatalf("the session brought the removed account's home back (err %v)", err)
	}
}

// The model list and the default model are read on Default when it keeps a login, else on the first
// added account that does: a signed-out Default's list is empty, and a runner whose only sign-in is an
// added account still has models to offer.
func TestKimiModelsAreReadOnDefaultElseTheFirstSignedInAccount(t *testing.T) {
	defaultHome, _ := kimiAccountTestHomes(t)
	_, seen := installFakeKimiForAccounts(t)
	if _, err := kimiAccountKind.create("Idle"); err != nil {
		t.Fatal(err)
	}
	work, err := kimiAccountKind.create("Work")
	if err != nil {
		t.Fatal(err)
	}
	signInKimiHome(t, work.Dir, kimiRegionGlobal)
	read := func() (string, string) {
		t.Helper()
		models, err := fetchKimiModelCatalog(context.Background())
		if err != nil || len(models) != 1 {
			t.Fatalf("models = %#v, %v", models, err)
		}
		model, err := fetchKimiDefaultModel()
		if err != nil {
			t.Fatal(err)
		}
		return models[0].Value, model
	}

	if home := kimiCatalogHome(); home != work.Dir {
		t.Fatalf("catalog home = %q with Default signed out, want Work's", home)
	}
	if listed, def := read(); listed != "kimi-code/k3" || def != "kimi-code/k3" {
		t.Fatalf("with Default signed out: listed %q, default %q — want Work's", listed, def)
	}
	signInKimiHome(t, defaultHome, kimiRegionMainland)
	if home := kimiCatalogHome(); home != "" {
		t.Fatalf("catalog home = %q with Default signed in, want the runner's own (Default)", home)
	}
	if listed, def := read(); listed != "kimi-code/kimi-for-coding" || def != "kimi-code/kimi-for-coding" {
		t.Fatalf("with Default signed in: listed %q, default %q — want Default's", listed, def)
	}
	want := []string{"provider list --json\t" + work.Dir, "provider list --json\t" + defaultHome}
	if calls := kimiCallsIn(t, seen); !reflect.DeepEqual(calls, want) {
		t.Fatalf("kimi ran as %q, want %q", calls, want)
	}
}

// `orbit resume` of a Kimi session runs `kimi --resume` in the home the session's conversation is in:
// its account's, or — with none recorded — Default's.
func TestOrbitResumeRunsKimiInTheSessionsAccountHome(t *testing.T) {
	defaultHome, _ := kimiAccountTestHomes(t)
	_, seen := installFakeKimiForAccounts(t)
	work, err := kimiAccountKind.create("Work")
	if err != nil {
		t.Fatal(err)
	}
	for id, home := range map[string]string{"5d0c3c0e-1d0f-4c6e-9a7b-2f3e4d5c6b7a": work.Dir, "6e1d4d1f-2e10-4d7f-8b8c-3f4e5d6c7b8a": ""} {
		if err := os.MkdirAll(runDir(id), 0o700); err != nil {
			t.Fatal(err)
		}
		b := fmt.Sprintf(`{"provider":"kimi","sessionUuid":%q,"runtimeSessionId":"session_%s","kimiCodeHome":%q,"workDir":%q}`, id, id[:8], home, t.TempDir())
		if err := os.WriteFile(filepath.Join(runDir(id), "meta.json"), []byte(b), 0o600); err != nil {
			t.Fatal(err)
		}
		cmdResume([]string{id})
	}
	got := kimiCallsIn(t, seen)
	want := map[string]bool{"--resume session_5d0c3c0e\t" + work.Dir: true, "--resume session_6e1d4d1f\t" + defaultHome: true}
	if len(got) != 2 || !want[got[0]] || !want[got[1]] {
		t.Fatalf("kimi ran as %q, want --resume in Work's home and in Default's", got)
	}
}

// A Kimi site that changes on any signed-in account is news for the catalog — the one it reads may
// be that account's — and a first reading, the same site again or a signed-out account is not.
func TestKimiSiteChangeOfAnyAccountRefreshesTheCatalog(t *testing.T) {
	work := EngineAccountReport{ID: "0a1b2c3d", Name: "Work", Auth: "yes", KimiRegion: kimiRegionGlobal}
	report := func() EngineHealthReport {
		return EngineHealthReport{Engine: providerKimi, Installed: true, Auth: "yes", KimiRegion: kimiRegionMainland,
			Accounts: []EngineAccountReport{{ID: accountSlotDefaultID, Auth: "yes", KimiRegion: kimiRegionMainland}, work}}
	}
	signedIn := 0
	p := &engineHealthProbe{
		probe:    func() []EngineHealthReport { return []EngineHealthReport{report()} },
		probeOne: func(string) []EngineHealthReport { return []EngineHealthReport{report()} },
		onSignIn: func() { signedIn++ },
	}
	p.refresh()
	p.refreshEngine(providerKimi)
	if signedIn != 0 {
		t.Fatalf("onSignIn calls = %d with every account where it was, want 0", signedIn)
	}
	work.KimiRegion = kimiRegionMainland
	p.refreshEngine(providerKimi)
	if signedIn != 1 {
		t.Fatalf("onSignIn calls = %d after Work signed in on kimi.com, want 1", signedIn)
	}
	work.Auth, work.KimiRegion = "no", kimiRegionGlobal
	p.refresh()
	if signedIn != 1 {
		t.Fatalf("onSignIn calls = %d for a signed-out account's site, want still 1", signedIn)
	}
}

// The runner says it keeps Kimi accounts, and carries a conversation between them
// (carryKimiConversation), in the words the project's contract gives.
func TestTheRunnerDeclaresItKeepsKimiAccounts(t *testing.T) {
	declared := "," + runnerCapabilitiesV1 + ","
	for _, capability := range []string{"kimi-account-login/v1", "kimi-account-remove/v1", "kimi-account-move/v1"} {
		if !strings.Contains(declared, ","+capability+",") {
			t.Fatalf("this runner does not declare %s: %q", capability, runnerCapabilitiesV1)
		}
	}
}

// The add, against the real CLI and Kimi's own sign-in servers — checked when asked (ORBIT_REAL_KIMI=1),
// since it needs the network and asks each site for a device code. The account is added under a
// throwaway ORBIT_HOME, while Default is this machine's own home, which has to come out exactly as it
// went in. It stops at the device code: the attempt is cancelled and nobody approves it.
func TestRealKimiAddsAnAccountInItsOwnHome(t *testing.T) {
	if os.Getenv("ORBIT_REAL_KIMI") != "1" {
		t.Skip("set ORBIT_REAL_KIMI=1 to add a Kimi account with the real CLI, up to its device code")
	}
	bin, ok := lookLoginEngine(providerKimi)
	if !ok {
		t.Fatal("ORBIT_REAL_KIMI=1, but this machine has no kimi")
	}
	t.Setenv("ORBIT_HOME", t.TempDir())
	t.Setenv("KIMI_CODE_HOME", "")
	def, err := kimiAccountKind.home(accountSlotDefaultID)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("kimi %s at %s; Default is %s", engineVersion(bin), bin, def)
	for region, host := range map[string]string{kimiRegionMainland: "www.kimi.com", kimiRegionGlobal: "www.kimi.ai"} {
		t.Run(region, func(t *testing.T) {
			before := kimiTreeSnapshot(t, def)
			relay := &loginRelay{}
			t.Cleanup(relay.stop)
			reports := make(chan LoginResultRequest, 8)
			attempt := "real-add-" + region
			relay.start(LoginCommand{Action: "start", Engine: providerKimi, AccountName: "Real " + region, Region: region, Attempt: attempt},
				func(res LoginResultRequest) { reports <- res })
			select {
			case res := <-reports:
				if res.Status != loginAwaitingApproval || res.UserCode == "" || kimiRegionOfURL(res.URL) != region || !strings.Contains(res.URL, "//"+host+"/") {
					t.Fatalf("first report %+v, want a device code to approve on %s", res, host)
				}
				t.Logf("device code published: %s (code %d characters) for account %s", strings.Split(res.URL, "?")[0], len(res.UserCode), res.Account)
			case <-time.After(90 * time.Second):
				t.Fatal("the real kimi published no device code")
			}

			// What the new account's home holds now, by name, kind and size — never by content.
			added := addedKimiSlots(t)
			if len(added) != 1 || added[0].Name != "Real "+region {
				t.Fatalf("added accounts = %#v, want the one this attempt named", added)
			}
			slot := added[0]
			assertKimiPrivateDir(t, slot.Dir)
			defaultDigests := map[string]string{}
			for path, entry := range before {
				if fields := strings.Fields(entry); len(fields) == 4 {
					defaultDigests[fields[3]] = path
				}
			}
			err := filepath.WalkDir(slot.Dir, func(path string, entry fs.DirEntry, err error) error {
				if err != nil {
					return err
				}
				info, err := os.Lstat(path)
				if err != nil {
					return err
				}
				rel, _ := filepath.Rel(slot.Dir, path)
				t.Logf("new account %s: %v %6d %s", slot.ID, info.Mode(), info.Size(), rel)
				if info.Mode()&os.ModeSymlink != 0 {
					t.Errorf("%s is a link out of the account's home", rel)
				}
				if info.Mode().IsRegular() {
					b, err := os.ReadFile(path)
					if err != nil {
						return err
					}
					if from, ok := defaultDigests[fmt.Sprintf("%x", sha256.Sum256(b))]; ok {
						t.Errorf("%s holds what Default's %s holds", rel, from)
					}
				}
				return nil
			})
			if err != nil {
				t.Fatal(err)
			}

			// Cut off before anybody signs in: the account goes again, and Default is as it was.
			relay.cancelLogin(LoginCommand{Action: "cancel", Engine: providerKimi, Attempt: attempt})
			select {
			case res := <-reports:
				if res.Status != loginFailed {
					t.Fatalf("after the cancel: %+v, want the attempt failed", res)
				}
			case <-time.After(60 * time.Second):
				t.Fatal("the cancelled sign-in reported nothing")
			}
			relay.wg.Wait()
			if left := addedKimiSlots(t); len(left) != 0 {
				t.Fatalf("the cancelled add left accounts behind: %#v", left)
			}
			if after := kimiTreeSnapshot(t, def); !reflect.DeepEqual(after, before) {
				t.Fatalf("Default's home changed during the add")
			}
			t.Logf("Default %s: %d entries, unchanged", def, len(before))
		})
	}
}

// The command to run by hand names the account's home by Kimi's own variable, whatever else the
// runner's environment sets.
func TestKimiHandRunSignInNamesTheAccountsHome(t *testing.T) {
	env := []string{"CLAUDE_CONFIG_DIR=/srv/claude", "CODEX_HOME=/srv/codex", "KIMI_CODE_HOME=/srv/kimi accounts/0a1b2c3d"}
	if got, want := loginCommandIn(providerKimi, env, "kimi login --region global"), `KIMI_CODE_HOME='/srv/kimi accounts/0a1b2c3d' kimi login --region global`; got != want {
		t.Fatalf("hand-run command = %q, want %q", got, want)
	}
	if got := loginCommandIn(providerKimi, nil, "kimi login"); got != "kimi login" {
		t.Fatalf("Default's hand-run command = %q, want the bare one", got)
	}
}
