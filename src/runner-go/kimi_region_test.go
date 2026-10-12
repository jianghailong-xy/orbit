package main

import (
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// `kimi provider list --json` (2.1.1) after each kind of login, built the way the CLI writes its
// managed provider (applyManagedKimiCodeConfig: type, baseUrl, apiKey, oauth{storage,key,oauthHost}).
func kimiProviderList(managed string) []byte {
	return []byte(`{
  "providers": {` + managed + `},
  "models": {}
}
`)
}

func TestParseKimiLoginRegion(t *testing.T) {
	for _, c := range []struct {
		name, out, want string
	}{
		{"never signed in", `{"providers": {}, "models": {}}`, ""},
		// A kimi.com login persists no host: its default slot's key is the signal (resolveKimiRegion).
		{"kimi.com login", string(kimiProviderList(`"managed:kimi-code": {"type": "kimi", "baseUrl": "https://api.kimi.com/coding/v1", "apiKey": "", "oauth": {"storage": "file", "key": "oauth/kimi-code"}}`)), kimiRegionMainland},
		{"kimi.ai login", string(kimiProviderList(`"managed:kimi-code": {"type": "kimi", "baseUrl": "https://api.kimi.ai/coding/v1", "apiKey": "", "oauth": {"storage": "file", "key": "oauth/kimi-code-env-0123456789abcdef", "oauthHost": "https://auth.kimi.ai"}}`)), kimiRegionGlobal},
		// The host outranks the API it points at, as it does in the CLI.
		{"host decides", string(kimiProviderList(`"managed:kimi-code": {"type": "kimi", "baseUrl": "https://api.kimi.com/coding/v1", "oauth": {"key": "oauth/kimi-code-env-0123456789abcdef", "oauthHost": "https://auth.kimi.ai/"}}`)), kimiRegionGlobal},
		{"key without host", string(kimiProviderList(`"managed:kimi-code": {"type": "kimi", "baseUrl": "https://kimi.example.test/v1", "oauth": {"key": "oauth/kimi-code"}}`)), kimiRegionMainland},
		{"api key, no oauth", string(kimiProviderList(`"managed:kimi-code": {"type": "kimi", "baseUrl": "https://api.kimi.ai/coding/v1", "apiKey": "sk-x"}`)), kimiRegionGlobal},
		{"custom environment", string(kimiProviderList(`"managed:kimi-code": {"type": "kimi", "baseUrl": "https://kimi.example.test/v1", "oauth": {"key": "oauth/kimi-code-env-0123456789abcdef", "oauthHost": "https://auth.example.test"}}`)), ""},
		// Another provider of type kimi is the user's own import, not Kimi Code's login.
		{"someone else's kimi provider", string(kimiProviderList(`"moonshot": {"type": "kimi", "baseUrl": "https://api.kimi.ai/coding/v1"}`)), ""},
		{"noise before the JSON", "warning: something\n" + string(kimiProviderList(`"managed:kimi-code": {"baseUrl": "https://api.kimi.ai/coding/v1"}`)), kimiRegionGlobal},
		{"not JSON", "Error: config.toml is invalid", ""},
	} {
		if got := parseKimiLoginRegion([]byte(c.out)); got != c.want {
			t.Errorf("%s: region = %q, want %q", c.name, got, c.want)
		}
	}
}

func TestKimiRegionOfURL(t *testing.T) {
	for raw, want := range map[string]string{
		"https://www.kimi.ai/code/authorize_device?user_code=7K06-QP86":  kimiRegionGlobal,
		"https://www.kimi.com/code/authorize_device?user_code=SHG3-0DSI": kimiRegionMainland,
		"https://auth.kimi.com":     kimiRegionMainland,
		"https://AUTH.KIMI.AI/":     kimiRegionGlobal,
		"https://kimi.ai":           kimiRegionGlobal,
		"https://notkimi.ai":        "",
		"https://kimi.ai.evil.test": "",
		"":                          "",
		"::not a url":               "",
	} {
		if got := kimiRegionOfURL(raw); got != want {
			t.Errorf("kimiRegionOfURL(%q) = %q, want %q", raw, got, want)
		}
	}
}

// A fake kimi that logs every command line it is given and answers the ones the runner asks: its
// sign-in help (with or without --region, per `help`), a device-code sign-in that prints the site's
// own URL the way 2.1.1 does and then exits 0, and its provider list.
func fakeKimi(t *testing.T, help, providerList string) (bin, log string) {
	t.Helper()
	dir := t.TempDir()
	log = filepath.Join(dir, "args")
	t.Setenv("KIMI_ARGS_LOG", log)
	list := filepath.Join(dir, "provider-list.json")
	if err := os.WriteFile(list, []byte(providerList), 0o600); err != nil {
		t.Fatal(err)
	}
	bin = writeFakeBin(t, dir, providerKimi, `echo "$*" >> "$KIMI_ARGS_LOG"
case "$*" in
  "login --help") echo '`+help+`' ;;
  "provider list --json") cat '`+list+`' ;;
  login*)
    host=www.kimi.com
    case "$*" in *"--region global"*) host=www.kimi.ai ;; esac
    printf '\nOpening browser for Kimi device login: https://%s/code/authorize_device?user_code=7K06-QP86\nIf the browser did not open, paste the URL above and enter code: 7K06-QP86\nCode expires in 1800s.\n' "$host" >&2
    sleep 2 ;;
esac
exit 0`)
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	previous := lookLoginEngine
	lookLoginEngine = func(engine string) (string, bool) { return bin, engine == providerKimi }
	t.Cleanup(func() { lookLoginEngine = previous })
	return bin, log
}

const kimiHelpWithRegion = `  --region <region>  Login region: "mainland-cn" (kimi.com) or "global" (kimi.ai).`
const kimiHelpWithoutRegion = `  -h, --help         Show help.`

// kimiSignIn runs one sign-in through the relay and returns every report up to its outcome.
func kimiSignIn(t *testing.T, cmd LoginCommand) []LoginResultRequest {
	t.Helper()
	relay := &loginRelay{}
	t.Cleanup(relay.stop)
	reports := make(chan LoginResultRequest, 8)
	cmd.Action, cmd.Engine = "start", providerKimi
	relay.start(cmd, func(res LoginResultRequest) { reports <- res })
	var got []LoginResultRequest
	for {
		select {
		case res := <-reports:
			got = append(got, res)
			if res.Status == loginDone || res.Status == loginFailed {
				return got
			}
		case <-time.After(15 * time.Second):
			t.Fatalf("the sign-in reached no outcome; reported %+v", got)
		}
	}
}

func kimiCommandLines(t *testing.T, log string) []string {
	t.Helper()
	raw, err := os.ReadFile(log)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		t.Fatal(err)
	}
	return strings.Split(strings.TrimSpace(string(raw)), "\n")
}

func TestKimiSignsInOnTheSiteTheStartNames(t *testing.T) {
	for region, host := range map[string]string{kimiRegionGlobal: "www.kimi.ai", kimiRegionMainland: "www.kimi.com"} {
		t.Run(region, func(t *testing.T) {
			_, log := fakeKimi(t, kimiHelpWithRegion, "")
			got := kimiSignIn(t, LoginCommand{Attempt: "kimi-" + region, Region: region})
			if len(got) != 2 || got[0].Status != loginAwaitingApproval || got[1].Status != loginDone {
				t.Fatalf("reports = %+v, want the device code and then done", got)
			}
			if want := "https://" + host + "/code/authorize_device?user_code=7K06-QP86"; got[0].URL != want || got[0].UserCode != "7K06-QP86" {
				t.Fatalf("published %q / %q, want %q and its code", got[0].URL, got[0].UserCode, want)
			}
			if lines := kimiCommandLines(t, log); strings.Join(lines, " | ") != "login --help | login --region "+region {
				t.Fatalf("kimi was run as %q, want its help and then `login --region %s`", lines, region)
			}
		})
	}
}

// A start naming no site — every control plane older than the choice — is the bare `kimi login` it
// always was, without so much as a look at the CLI's help.
func TestKimiStartNamingNoSiteIsABareLogin(t *testing.T) {
	_, log := fakeKimi(t, kimiHelpWithRegion, "")
	got := kimiSignIn(t, LoginCommand{Attempt: "kimi-bare"})
	if last := got[len(got)-1]; last.Status != loginDone {
		t.Fatalf("reports = %+v, want done", got)
	}
	if lines := kimiCommandLines(t, log); strings.Join(lines, " | ") != "login" {
		t.Fatalf("kimi was run as %q, want a bare `login`", lines)
	}
}

// A Kimi Code that predates --region signs in where it always did: kimi.com is a bare login there,
// and kimi.ai is refused in words the user can act on — never quietly signed in on the other site.
func TestKimiTooOldToChooseASite(t *testing.T) {
	t.Run("kimi.ai", func(t *testing.T) {
		_, log := fakeKimi(t, kimiHelpWithoutRegion, "")
		got := kimiSignIn(t, LoginCommand{Attempt: "old-global", Region: kimiRegionGlobal})
		if len(got) != 1 || got[0].Status != loginFailed || !strings.Contains(got[0].Message, "too old to sign in on kimi.ai") {
			t.Fatalf("reports = %+v, want one failure naming the reason", got)
		}
		if got[0].Attempt != "old-global" {
			t.Fatalf("the failure names attempt %q, want the one it is about", got[0].Attempt)
		}
		if lines := kimiCommandLines(t, log); strings.Join(lines, " | ") != "login --help" {
			t.Fatalf("kimi was run as %q, want only its help", lines)
		}
	})
	t.Run("kimi.com", func(t *testing.T) {
		_, log := fakeKimi(t, kimiHelpWithoutRegion, "")
		got := kimiSignIn(t, LoginCommand{Attempt: "old-mainland", Region: kimiRegionMainland})
		if last := got[len(got)-1]; last.Status != loginDone {
			t.Fatalf("reports = %+v, want done", got)
		}
		if lines := kimiCommandLines(t, log); strings.Join(lines, " | ") != "login --help | login" {
			t.Fatalf("kimi was run as %q, want its help and then a bare `login`", lines)
		}
	})
}

func TestKimiUnknownSiteIsRefused(t *testing.T) {
	_, log := fakeKimi(t, kimiHelpWithRegion, "")
	got := kimiSignIn(t, LoginCommand{Attempt: "kimi-eu", Region: "eu"})
	if len(got) != 1 || got[0].Status != loginFailed || !strings.Contains(got[0].Message, `unknown Kimi site "eu"`) {
		t.Fatalf("reports = %+v, want the site refused", got)
	}
	if lines := kimiCommandLines(t, log); lines != nil {
		t.Fatalf("kimi was run as %q for a site it has not got", lines)
	}
}

// The failure a sign-in can't read its URL from tells the user what to run by hand — on the site
// they asked for, not a bare login that would go wherever the CLI decides.
func TestKimiManualFallbackNamesTheSite(t *testing.T) {
	dir := t.TempDir()
	bin := writeFakeBin(t, dir, providerKimi, `case "$*" in "login --help") echo '`+kimiHelpWithRegion+`' ;; *) exit 3 ;; esac`)
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	previous := lookLoginEngine
	lookLoginEngine = func(engine string) (string, bool) { return bin, engine == providerKimi }
	t.Cleanup(func() { lookLoginEngine = previous })
	got := kimiSignIn(t, LoginCommand{Attempt: "kimi-broken", Region: kimiRegionGlobal})
	if last := got[len(got)-1]; last.Status != loginFailed || !strings.Contains(last.Message, "`kimi login --region global`") {
		t.Fatalf("reports = %+v, want the hand-run command on kimi.ai", got)
	}
}

// The health report carries the site of the CLI's own login, read off its provider list.
func TestKimiHealthReportsTheSiteOfItsLogin(t *testing.T) {
	bin, _ := fakeKimi(t, kimiHelpWithRegion, string(kimiProviderList(`"managed:kimi-code": {"type": "kimi", "baseUrl": "https://api.kimi.ai/coding/v1", "apiKey": "", "oauth": {"storage": "file", "key": "oauth/kimi-code-env-0123456789abcdef", "oauthHost": "https://auth.kimi.ai"}}`)))
	if got := probeKimiLoginRegion(bin, nil); got != kimiRegionGlobal {
		t.Fatalf("probeKimiLoginRegion = %q, want global", got)
	}
	spec, _ := specFor(providerKimi)
	reports := probeEngines([]engineSpec{spec}, filepath.Dir(bin))
	if len(reports) != 1 || !reports[0].Installed || reports[0].KimiRegion != kimiRegionGlobal {
		t.Fatalf("reports = %+v, want Kimi installed and on kimi.ai", reports)
	}
}

func TestKimiHealthReportsNoSiteBeforeASignIn(t *testing.T) {
	bin, _ := fakeKimi(t, kimiHelpWithRegion, `{"providers": {}, "models": {}}`)
	if got := probeKimiLoginRegion(bin, nil); got != "" {
		t.Fatalf("probeKimiLoginRegion = %q before any sign-in, want none", got)
	}
}

// The runner says it signs Kimi in on a chosen site, in the words the control plane asks for.
func TestTheRunnerDeclaresItSignsKimiInOnAChosenSite(t *testing.T) {
	if !strings.Contains(","+runnerCapabilitiesV1+",", ","+kimiLoginRegionCapabilityV1+",") {
		t.Fatalf("this runner does not declare %s: %q", kimiLoginRegionCapabilityV1, runnerCapabilitiesV1)
	}
	shared, err := os.ReadFile(filepath.Join("..", "shared", "src", "dto.ts"))
	if err != nil {
		t.Fatal(err)
	}
	if want := "KIMI_LOGIN_REGION_V1 = '" + kimiLoginRegionCapabilityV1 + "'"; !strings.Contains(string(shared), want) {
		t.Fatalf("the control plane does not ask for %s in those words (%s)", kimiLoginRegionCapabilityV1, want)
	}
	for _, region := range []string{kimiRegionMainland, kimiRegionGlobal} {
		if !strings.Contains(string(shared), "'"+region+"'") {
			t.Fatalf("@orbit/shared's KimiRegion has no %q", region)
		}
	}
}

// A Kimi login moved to the other site rewrites the models Kimi's config lists, so the catalog is
// told, as it is after a sign-in from signed out. Reading the same site again, or a first reading,
// is no news.
func TestKimiSignInOnTheOtherSiteRefreshesTheCatalog(t *testing.T) {
	report := EngineHealthReport{Engine: providerKimi, Installed: true, Auth: "yes", KimiRegion: kimiRegionMainland}
	signedIn := 0
	p := &engineHealthProbe{
		probe:    func() []EngineHealthReport { return []EngineHealthReport{report} },
		probeOne: func(string) []EngineHealthReport { return []EngineHealthReport{report} },
		onSignIn: func() { signedIn++ },
	}
	p.refresh()
	p.refreshEngine(providerKimi)
	if signedIn != 0 {
		t.Fatalf("onSignIn calls = %d for a login that stayed on kimi.com, want 0", signedIn)
	}
	report.KimiRegion = kimiRegionGlobal
	p.refreshEngine(providerKimi)
	if signedIn != 1 {
		t.Fatalf("onSignIn calls = %d after the login moved to kimi.ai, want 1", signedIn)
	}
	p.refresh()
	if signedIn != 1 {
		t.Fatalf("onSignIn calls = %d after kimi.ai was read again, want still 1", signedIn)
	}
}

// The same, against the real CLI and Kimi's own sign-in servers — checked when asked
// (ORBIT_REAL_KIMI=1), since it needs the network and asks each site for a device code. The machine's
// own login is never touched: the CLI runs on a home of the test's own.
func TestRealKimiSignsInOnTheSiteTheStartNames(t *testing.T) {
	if os.Getenv("ORBIT_REAL_KIMI") != "1" {
		t.Skip("set ORBIT_REAL_KIMI=1 to check `kimi login --region` against the real CLI and Kimi's servers")
	}
	if _, ok := lookLoginEngine(providerKimi); !ok {
		t.Fatal("ORBIT_REAL_KIMI=1, but this machine has no kimi")
	}
	t.Setenv("KIMI_CODE_HOME", t.TempDir())
	for region, host := range map[string]string{kimiRegionGlobal: "www.kimi.ai", kimiRegionMainland: "www.kimi.com"} {
		t.Run(region, func(t *testing.T) {
			relay := &loginRelay{}
			t.Cleanup(relay.stop)
			reports := make(chan LoginResultRequest, 8)
			attempt := "real-" + region
			relay.start(LoginCommand{Action: "start", Engine: providerKimi, Attempt: attempt, Region: region}, func(res LoginResultRequest) { reports <- res })
			select {
			case res := <-reports:
				if res.Status != loginAwaitingApproval || res.UserCode == "" {
					t.Fatalf("first report %+v, want a device code to approve", res)
				}
				if u, err := url.Parse(res.URL); err != nil || u.Hostname() != host || kimiRegionOfURL(res.URL) != region {
					t.Fatalf("the code is for %q, want a page on %s", res.URL, host)
				}
			case <-time.After(90 * time.Second):
				t.Fatal("the real kimi published no device code")
			}
			relay.cancelLogin(LoginCommand{Action: "cancel", Engine: providerKimi, Attempt: attempt})
		})
	}
}
