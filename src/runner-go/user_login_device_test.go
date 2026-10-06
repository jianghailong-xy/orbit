package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

// fakeDeviceLogin is the server's half of `orbit login` through the browser
// (docs/personal-access-token-design.md §7.3): one request, decided by the test the way the person at
// the browser would decide it. Its routes take no credential; one that arrives with one is noted.
type fakeDeviceLogin struct {
	// What each POST /api/access-tokens/device/start asked for.
	started []map[string]interface{}
	polls   int
	// What a poll answers: "pending" until the test decides.
	status string
	// The token an "approved" poll hands out.
	token string
	// Non-zero: start, or every poll, answers this status with errorBody.
	startStatus, pollStatus int
	errorBody               string
	// Whether any of its requests carried an Authorization header.
	authorized bool
}

const fakeUserCode = "WXYZ4-8K2QP"

func (f *fakeUserAPI) serveDeviceLogin(w http.ResponseWriter, r *http.Request, body []byte) {
	if len(r.Header.Values("Authorization")) > 0 {
		f.device.authorized = true
	}
	switch {
	case r.Method == http.MethodPost && r.URL.Path == "/api/access-tokens/device/start":
		if f.device.startStatus != 0 {
			w.WriteHeader(f.device.startStatus)
			io.WriteString(w, f.device.errorBody)
			return
		}
		var asked map[string]interface{}
		json.Unmarshal(body, &asked)
		f.device.started = append(f.device.started, asked)
		if f.device.status == "" {
			f.device.status = "pending"
		}
		w.WriteHeader(http.StatusCreated)
		io.WriteString(w, `{"deviceCode":"device-secret","userCode":"`+fakeUserCode+`","interval":0,"expiresIn":600}`)
	case r.Method == http.MethodPost && r.URL.Path == "/api/access-tokens/device/poll":
		f.device.polls++
		var poll struct {
			DeviceCode string `json:"deviceCode"`
		}
		if json.Unmarshal(body, &poll); poll.DeviceCode != "device-secret" {
			w.WriteHeader(http.StatusNotFound)
			io.WriteString(w, `{"message":"unknown device code","statusCode":404}`)
			return
		}
		if f.device.pollStatus != 0 {
			w.WriteHeader(f.device.pollStatus)
			io.WriteString(w, f.device.errorBody)
			return
		}
		answer := map[string]interface{}{"status": f.device.status}
		if f.device.status == "approved" {
			answer["token"] = f.device.token
			answer["name"] = "laptop"
			// Handed out once, as the server does: a second poll is told it was delivered.
			f.device.status = "delivered"
		}
		json.NewEncoder(w).Encode(answer)
	default:
		w.WriteHeader(http.StatusNotFound)
		io.WriteString(w, `{"message":"Cannot `+r.Method+` `+r.URL.Path+`","statusCode":404}`)
	}
}

// decide is the person at the browser: what the next poll answers.
func (f *fakeUserAPI) decide(status, token string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.device.status, f.device.token = status, token
}

func (f *fakeUserAPI) deviceState() fakeDeviceLogin {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.device
}

// browserLogin stands in for the browser `orbit login` opens: it records the page it was sent to and,
// after the CLI's first poll has been answered pending, decides the request as `decision` says.
func browserLogin(t *testing.T, api *fakeUserAPI, decision, token string) *[]string {
	t.Helper()
	opened := &[]string{}
	floor, open := loginPollFloor, openLoginPage
	t.Cleanup(func() { loginPollFloor, openLoginPage = floor, open })
	loginPollFloor = time.Millisecond
	openLoginPage = func(link string) {
		*opened = append(*opened, link)
		go func() {
			for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); time.Sleep(time.Millisecond) {
				if api.deviceState().polls > 0 {
					api.decide(decision, token)
					return
				}
			}
		}()
	}
	return opened
}

func TestLoginThroughTheBrowserAsksForATokenWaitsForApprovalAndSavesIt(t *testing.T) {
	userModeEnv(t)
	api := newFakeUserAPI(t)
	opened := browserLogin(t, api, "approved", laptopToken)
	var out, errOut bytes.Buffer
	if err := cmdLoginCLI([]string{"--server", api.URL + "/"}, strings.NewReader(""), &out, &errOut); err != nil {
		t.Fatalf("login: %v\n%s", err, errOut.String())
	}

	device := api.deviceState()
	host := hostnameOr()
	if len(device.started) != 1 {
		t.Fatalf("started %d requests", len(device.started))
	}
	// The defaults the Settings page's dialog has: read-only, for 90 days — named for this host.
	want := map[string]interface{}{"name": "orbit CLI on " + host, "preset": "read-only", "expiresInDays": float64(90), "hostname": host}
	if got := device.started[0]; len(got) != len(want) || got["name"] != want["name"] || got["preset"] != want["preset"] ||
		got["expiresInDays"] != want["expiresInDays"] || got["hostname"] != want["hostname"] {
		t.Errorf("asked for %v, want %v", got, want)
	}
	if device.authorized {
		t.Error("start or poll carried a credential: they take none")
	}
	if device.polls < 2 {
		t.Errorf("polled %d times: it should have waited while the request was pending", device.polls)
	}
	link := api.URL + "/cli-login?code=" + fakeUserCode
	if len(*opened) != 1 || (*opened)[0] != link {
		t.Errorf("opened %q, want %s", *opened, link)
	}
	for _, want := range []string{link, "Verification code: " + fakeUserCode, `token named "orbit CLI on ` + host + `"`, "Waiting for approval"} {
		if !strings.Contains(errOut.String(), want) {
			t.Errorf("the instructions lack %q:\n%s", want, errOut.String())
		}
	}
	// Then the token is checked and saved exactly as --with-token saves one.
	requests := api.seen()
	if last := requests[len(requests)-1]; last != "GET /api/pat/self "+laptopToken {
		t.Errorf("the last request was %q, want the token checked with GET /api/pat/self", last)
	}
	if !strings.Contains(out.String(), "Logged in to "+api.URL+" as "+fakeUserEmail+` with the token "laptop"`) {
		t.Errorf("output:\n%s", out.String())
	}
	if strings.Contains(out.String()+errOut.String(), laptopToken) {
		t.Error("login printed the token")
	}
	saved, err := loadUserLogin()
	if err != nil {
		t.Fatal(err)
	}
	if want := (userLogin{ServerURL: api.URL, Token: laptopToken, TokenID: "pat-laptop", Name: "laptop", Email: fakeUserEmail}); saved == nil || *saved != want {
		t.Fatalf("saved %+v, want %+v", saved, want)
	}
}

func TestLoginAsksForTheNameScopesAndExpiryItIsGiven(t *testing.T) {
	cases := []struct {
		name string
		args []string
		want map[string]interface{}
	}{
		{"listed scopes, never expiring", []string{"--name", "ci box", "--scopes", "tasks:read, tasks:write", "--expires", "never"},
			map[string]interface{}{"name": "ci box", "scopes": []interface{}{"tasks:read", "tasks:write"}, "expiresInDays": nil}},
		{"every scope for a year", []string{"--scopes", "read-write", "--expires", "365d"},
			map[string]interface{}{"preset": "read-write", "expiresInDays": float64(365)}},
		{"thirty days", []string{"--expires", "30d"}, map[string]interface{}{"preset": "read-only", "expiresInDays": float64(30)}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			userModeEnv(t)
			api := newFakeUserAPI(t)
			browserLogin(t, api, "approved", laptopToken)
			var out, errOut bytes.Buffer
			if err := cmdLoginCLI(append(tc.args, "--server", api.URL), strings.NewReader(""), &out, &errOut); err != nil {
				t.Fatalf("login: %v\n%s", err, errOut.String())
			}
			asked := api.deviceState().started[0]
			for key, want := range tc.want {
				got, present := asked[key]
				if !present {
					t.Errorf("%s was not sent: %v", key, asked)
					continue
				}
				if gotJSON, wantJSON := mustJSON(t, got), mustJSON(t, want); gotJSON != wantJSON {
					t.Errorf("%s = %s, want %s", key, gotJSON, wantJSON)
				}
			}
			if _, both := asked["preset"]; both && asked["scopes"] != nil {
				t.Errorf("sent both a preset and scopes: %v", asked)
			}
		})
	}
}

func TestLoginRefusesALifetimeOrScopesNoTokenCanHaveBeforeAskingAnything(t *testing.T) {
	userModeEnv(t)
	api := newFakeUserAPI(t)
	for _, tc := range []struct {
		args []string
		want string
	}{
		{[]string{"--expires", "7d"}, `--expires must be 30d, 90d, 365d or never, not "7d"`},
		{[]string{"--expires", "90"}, "--expires must be"},
		{[]string{"--scopes", " , "}, "--scopes names no scope"},
	} {
		var out, errOut bytes.Buffer
		err := cmdLoginCLI(append(tc.args, "--server", api.URL), strings.NewReader(""), &out, &errOut)
		if err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Errorf("%v: err = %v, want %q", tc.args, err, tc.want)
		}
	}
	if got := api.seen(); len(got) != 0 {
		t.Errorf("sent %q", got)
	}
}

func TestLoginThroughTheBrowserEndsWithoutALoginWhenTheRequestIsNotApproved(t *testing.T) {
	cases := []struct {
		name     string
		decision string
		setup    func(*fakeUserAPI)
		want     string
	}{
		{"denied in the browser", "denied", nil, "denied in the browser; no token was issued"},
		{"expired before anyone approved it", "expired", nil, "expired before it was approved: run `orbit login` again"},
		{"collected by an answer that never arrived", "delivered", nil, `revoke "orbit CLI on`},
		{"a server without the device flow", "", func(f *fakeUserAPI) {
			f.device.startStatus = http.StatusNotFound
			f.device.errorBody = `{"message":"Cannot POST /api/access-tokens/device/start","statusCode":404}`
		}, "does not offer signing in through the browser (404): issue a token under Settings → Access tokens and run `orbit login --with-token`"},
		{"a request the server refuses", "", func(f *fakeUserAPI) {
			f.device.startStatus = http.StatusBadRequest
			f.device.errorBody = `{"message":"unknown scope(s): admin:write; allowed: tasks:read","error":"Bad Request","statusCode":400}`
		}, "refused the login request (400): unknown scope(s): admin:write; allowed: tasks:read"},
		{"a token that can no longer be issued", "", func(f *fakeUserAPI) {
			f.device.pollStatus = http.StatusConflict
			f.device.errorBody = `{"code":"PAT_NAME_IN_USE","message":"You already have an access token named \"laptop\" — revoke it or pick another name"}`
		}, `refused the login (409): You already have an access token named "laptop"`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			userModeEnv(t)
			api := newFakeUserAPI(t)
			if tc.setup != nil {
				tc.setup(api)
			}
			browserLogin(t, api, tc.decision, "")
			var out, errOut bytes.Buffer
			err := cmdLoginCLI([]string{"--server", api.URL}, strings.NewReader(""), &out, &errOut)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err = %v, want it to say %q", err, tc.want)
			}
			if exists(userLoginFile()) {
				t.Error("saved a login")
			}
			for _, request := range api.seen() {
				if strings.Contains(request, "/api/pat/self") {
					t.Errorf("checked a token it was never given: %q", request)
				}
			}
		})
	}
}

func TestLoginThroughTheBrowserIsRefusedInsideASession(t *testing.T) {
	userModeEnv(t)
	api := newFakeUserAPI(t)
	opened := browserLogin(t, api, "approved", laptopToken)
	t.Setenv("ORBIT_SESSION_ID", "session-1")
	var out, errOut bytes.Buffer
	if err := cmdLoginCLI([]string{"--server", api.URL}, strings.NewReader(""), &out, &errOut); err == nil || !strings.Contains(err.Error(), "ORBIT_SESSION_ID") {
		t.Fatalf("login inside a session: %v", err)
	}
	if got := api.seen(); len(got) != 0 || len(*opened) != 0 {
		t.Errorf("a session asked %q and opened %q", got, *opened)
	}
}
