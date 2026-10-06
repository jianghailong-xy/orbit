package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeUserAPI is a control plane's user API as far as the person's commands use it: GET and DELETE
// /api/pat/self, the task routes `orbit api` is tried on, and 401 for any token it does not hold or
// that was revoked — the one answer the real server gives all three of unknown, revoked and expired.
type fakeUserAPI struct {
	*httptest.Server
	mu     sync.Mutex
	tokens map[string]*fakePAT
	// Every request, "METHOD /path?query token", and its body.
	requests []string
	bodies   []string
}

type fakePAT struct {
	id, name     string
	scopes       []string
	workspaceIDs []string
	expiresAt    *string
	revoked      bool
}

const (
	fakeUserEmail = "me@example.test"
	laptopToken   = userTokenPrefix + "laptop-0123456789abcdefghijklmnopqrstuvwxyzABCD"
	otherToken    = userTokenPrefix + "other-0123456789abcdefghijklmnopqrstuvwxyzABCDE"
)

func newFakeUserAPI(t *testing.T) *fakeUserAPI {
	t.Helper()
	expires := "2027-01-04T09:00:00.000Z"
	f := &fakeUserAPI{tokens: map[string]*fakePAT{
		laptopToken: {id: "pat-laptop", name: "laptop", scopes: []string{"tasks:read", "tasks:write"}, workspaceIDs: []string{}, expiresAt: &expires},
		otherToken:  {id: "pat-other", name: "ci", scopes: []string{"tasks:read"}, workspaceIDs: []string{"ws-1"}},
	}}
	f.Server = httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(f.Close)
	return f
}

func (f *fakeUserAPI) serve(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	body, _ := io.ReadAll(r.Body)
	token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	f.requests = append(f.requests, r.Method+" "+r.URL.RequestURI()+" "+token)
	f.bodies = append(f.bodies, string(body))
	w.Header().Set("Content-Type", "application/json")
	pat := f.tokens[token]
	if pat == nil || pat.revoked {
		w.WriteHeader(http.StatusUnauthorized)
		io.WriteString(w, `{"message":"invalid token","error":"Unauthorized","statusCode":401}`)
		return
	}
	switch {
	case r.Method == http.MethodGet && r.URL.Path == "/api/pat/self":
		json.NewEncoder(w).Encode(map[string]interface{}{
			"userId": "user-1", "email": fakeUserEmail,
			"token": map[string]interface{}{"id": pat.id, "name": pat.name, "scopes": pat.scopes, "workspaceIds": pat.workspaceIDs, "expiresAt": pat.expiresAt},
		})
	case r.Method == http.MethodDelete && r.URL.Path == "/api/pat/self":
		pat.revoked = true
		io.WriteString(w, `{"id":"`+pat.id+`","revokedAt":"2026-10-06T10:00:00.000Z","revokedReason":"USER"}`)
	case r.Method == http.MethodGet && r.URL.Path == "/api/tasks":
		io.WriteString(w, `[{"id":"t1","title":"first"},{"id":"t2","title":"second"}]`)
	case r.Method == http.MethodGet && r.URL.Path == "/api/tasks/page":
		next := map[string]string{"": `"c2"`, "c2": `"c3"`, "c3": `null`}[r.URL.Query().Get("cursor")]
		io.WriteString(w, `{"items":[{"id":"`+firstNonEmpty(r.URL.Query().Get("cursor"), "c1")+`"}],"nextCursor":`+next+`}`)
	case r.URL.Path == "/api/tasks" || strings.HasPrefix(r.URL.Path, "/api/tasks/"):
		w.WriteHeader(http.StatusCreated)
		w.Write(body)
	case r.URL.Path == "/api/projects":
		w.WriteHeader(http.StatusForbidden)
		io.WriteString(w, `{"code":"PAT_SCOPE_MISSING","scope":"projects:read","message":"This access token was not granted the projects:read scope this route needs"}`)
	default:
		w.WriteHeader(http.StatusNotFound)
		io.WriteString(w, `{"message":"Cannot `+r.Method+` `+r.URL.Path+`","statusCode":404}`)
	}
}

func (f *fakeUserAPI) seen() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string{}, f.requests...)
}

// loggedIn saves a login the way `orbit login --with-token` would have.
func loggedIn(t *testing.T, server, token string) {
	t.Helper()
	if err := saveUserLogin(userLogin{ServerURL: server, Token: token, TokenID: "pat-laptop", Name: "laptop", Email: fakeUserEmail}); err != nil {
		t.Fatal(err)
	}
}

func TestLoginWithTokenReadsStdinChecksTheTokenAndSavesIt(t *testing.T) {
	home := userModeEnv(t)
	api := newFakeUserAPI(t)
	var out, errOut bytes.Buffer
	if err := cmdLoginCLI([]string{"--with-token", "--server", api.URL + "/"}, strings.NewReader(laptopToken+"\n"), &out, &errOut); err != nil {
		t.Fatalf("login: %v\n%s", err, errOut.String())
	}
	if got := api.seen(); len(got) != 1 || got[0] != "GET /api/pat/self "+laptopToken {
		t.Fatalf("requests = %q, want the one GET /api/pat/self with the token", got)
	}
	for _, want := range []string{"Logged in to " + api.URL + " as " + fakeUserEmail, `"laptop"`, "tasks:read, tasks:write", "expires 2027-01-04"} {
		if !strings.Contains(out.String(), want) {
			t.Errorf("output lacks %q:\n%s", want, out.String())
		}
	}
	if strings.Contains(out.String()+errOut.String(), laptopToken) {
		t.Error("login printed the token")
	}
	if strings.Contains(errOut.String(), "Warning") {
		t.Errorf("a machine with no runner was warned:\n%s", errOut.String())
	}
	saved, err := loadUserLogin()
	if err != nil {
		t.Fatal(err)
	}
	want := userLogin{ServerURL: api.URL, Token: laptopToken, TokenID: "pat-laptop", Name: "laptop", Email: fakeUserEmail}
	if saved == nil || *saved != want {
		t.Fatalf("saved %+v, want %+v", saved, want)
	}
	if runtime.GOOS != "windows" {
		for path, mode := range map[string]os.FileMode{home: 0o700, userLoginFile(): 0o600} {
			if info, err := os.Stat(path); err != nil || info.Mode().Perm() != mode {
				t.Errorf("%s: %v, mode %v, want %04o", path, err, info, mode)
			}
		}
	}
	// It is kept apart from the runner's config, which login neither writes nor needs.
	if _, err := os.Stat(configPath()); !os.IsNotExist(err) {
		t.Errorf("login wrote %s: %v", configPath(), err)
	}
}

func TestLoginTakesTheTokenFromStdinOnlyAndOnlyAPersonalAccessToken(t *testing.T) {
	userModeEnv(t)
	api := newFakeUserAPI(t)
	cases := []struct {
		name  string
		args  []string
		stdin string
		want  string
	}{
		{"the token as an argument", []string{"--with-token", laptopToken, "--server", api.URL}, "", "never from an argument"},
		{"nothing on stdin", []string{"--with-token", "--server", api.URL}, "", "no token on stdin"},
		{"not a personal access token", []string{"--with-token", "--server", api.URL}, "eyJhbGciOiJIUzI1NiJ9.e30.sig\n", "not a personal access token"},
		{"a token the server refuses", []string{"--with-token", "--server", api.URL}, userTokenPrefix + "revoked\n", "refused the token (401)"},
		{"no --with-token", []string{"--server", api.URL}, laptopToken + "\n", "--with-token"},
		{"a server that is not a URL", []string{"--with-token", "--server", "orbit.example.com"}, laptopToken + "\n", "not a server URL"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var out, errOut bytes.Buffer
			err := cmdLoginCLI(tc.args, strings.NewReader(tc.stdin), &out, &errOut)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err = %v, want it to say %q", err, tc.want)
			}
			if exists(userLoginFile()) {
				t.Error("a refused login saved user.json")
			}
		})
	}
	// Only the token the server refused was sent anywhere.
	for _, request := range api.seen() {
		if !strings.HasSuffix(request, userTokenPrefix+"revoked") {
			t.Errorf("sent %q", request)
		}
	}
}

func TestLoginAndLogoutAreRefusedInsideASession(t *testing.T) {
	userModeEnv(t)
	api := newFakeUserAPI(t)
	loggedIn(t, api.URL, laptopToken)
	t.Setenv("ORBIT_SESSION_ID", "session-1")
	var out, errOut bytes.Buffer
	if err := cmdLoginCLI([]string{"--with-token", "--server", api.URL}, strings.NewReader(otherToken+"\n"), &out, &errOut); err == nil || !strings.Contains(err.Error(), "ORBIT_SESSION_ID") {
		t.Fatalf("login inside a session: %v", err)
	}
	if err := cmdLogoutCLI(nil, &out, &errOut); err == nil || !strings.Contains(err.Error(), "ORBIT_SESSION_ID") {
		t.Fatalf("logout inside a session: %v", err)
	}
	if got := api.seen(); len(got) != 0 {
		t.Errorf("a session sent %q", got)
	}
	if saved, _ := loadUserLogin(); saved == nil || saved.Token != laptopToken {
		t.Errorf("the saved login changed: %+v", saved)
	}
}

// §8: on a registered runner whose service runs as this OS user, `orbit login` says — once — that the
// agents it runs can read the token.
func TestLoginWarnsOnceOnARunnerThatRunsAsThisOSUser(t *testing.T) {
	userModeEnv(t)
	api := newFakeUserAPI(t)
	if err := saveConfig(&RunnerConfig{ServerURL: api.URL, RunnerID: "runner-1", RunnerToken: "runner-secret", Name: "build-box"}); err != nil {
		t.Fatal(err)
	}
	var out, errOut bytes.Buffer
	// No --server: the runner's own server is the default.
	if err := cmdLoginCLI([]string{"--with-token"}, strings.NewReader(laptopToken), &out, &errOut); err != nil {
		t.Fatal(err)
	}
	warning := errOut.String()
	if got := strings.Count(warning, "Warning: this machine is the registered Orbit runner"); got != 1 {
		t.Fatalf("warned %d times:\n%s", got, warning)
	}
	for _, want := range []string{`"build-box"`, userLoginFile(), "separate OS user", "scopes", "workspaces", "expiry"} {
		if !strings.Contains(warning, want) {
			t.Errorf("the warning lacks %q:\n%s", want, warning)
		}
	}
	if !strings.Contains(out.String(), "Logged in to "+api.URL) {
		t.Errorf("did not log in to the runner's server:\n%s", out.String())
	}
	// The runner's credential was not what checked the token.
	for _, request := range api.seen() {
		if strings.Contains(request, "runner-secret") {
			t.Errorf("sent the runner credential: %q", request)
		}
	}
}

func TestLogoutRevokesTheTokenItSavedAndRemovesTheLogin(t *testing.T) {
	userModeEnv(t)
	api := newFakeUserAPI(t)
	loggedIn(t, api.URL, laptopToken)
	var out, errOut bytes.Buffer
	if err := cmdLogoutCLI(nil, &out, &errOut); err != nil {
		t.Fatal(err)
	}
	if got := api.seen(); len(got) != 1 || got[0] != "DELETE /api/pat/self "+laptopToken {
		t.Fatalf("requests = %q, want one DELETE /api/pat/self with the saved token", got)
	}
	if !api.tokens[laptopToken].revoked || api.tokens[otherToken].revoked {
		t.Error("logout did not revoke exactly its own token")
	}
	if exists(userLoginFile()) {
		t.Error("user.json is still there")
	}
	if !strings.Contains(out.String(), `revoked the token "laptop"`) {
		t.Errorf("output: %s", out.String())
	}
	if err := cmdLogoutCLI(nil, &out, &errOut); err == nil || !strings.Contains(err.Error(), "not logged in") {
		t.Errorf("logging out twice: %v", err)
	}
}

func TestLogoutKeepTokenOnlyForgetsTheLogin(t *testing.T) {
	userModeEnv(t)
	api := newFakeUserAPI(t)
	loggedIn(t, api.URL, laptopToken)
	var out, errOut bytes.Buffer
	if err := cmdLogoutCLI([]string{"--keep-token"}, &out, &errOut); err != nil {
		t.Fatal(err)
	}
	if got := api.seen(); len(got) != 0 {
		t.Errorf("--keep-token sent %q", got)
	}
	if exists(userLoginFile()) || api.tokens[laptopToken].revoked {
		t.Error("--keep-token left the file or revoked the token")
	}
	if !strings.Contains(out.String(), "keeps working") {
		t.Errorf("output: %s", out.String())
	}
}

// A token that could not be revoked is not forgotten either: the login stays, so it can be retried.
func TestLogoutRemovesNothingWhenTheServerCannotRevoke(t *testing.T) {
	userModeEnv(t)
	gone := httptest.NewServer(http.NotFoundHandler())
	unreachable := gone.URL
	gone.Close()
	loggedIn(t, unreachable, laptopToken)
	var out, errOut bytes.Buffer
	err := cmdLogoutCLI(nil, &out, &errOut)
	if err == nil || !strings.Contains(err.Error(), "Nothing was removed") || !strings.Contains(err.Error(), "--keep-token") {
		t.Fatalf("err = %v", err)
	}
	if !exists(userLoginFile()) {
		t.Fatal("the login was removed although its token was not revoked")
	}
}

// A token the server no longer takes has nothing left to revoke: logout still forgets it.
func TestLogoutForgetsATokenThatWasAlreadyRevoked(t *testing.T) {
	userModeEnv(t)
	api := newFakeUserAPI(t)
	loggedIn(t, api.URL, laptopToken)
	api.tokens[laptopToken].revoked = true
	var out, errOut bytes.Buffer
	if err := cmdLogoutCLI(nil, &out, &errOut); err != nil {
		t.Fatal(err)
	}
	if exists(userLoginFile()) || !strings.Contains(out.String(), "already invalid, revoked or expired") {
		t.Errorf("output %q, file still there: %v", out.String(), exists(userLoginFile()))
	}
}

func TestLogoutLeavesORBIT_USER_TOKENAlone(t *testing.T) {
	userModeEnv(t)
	api := newFakeUserAPI(t)
	t.Setenv(envUserToken, laptopToken)
	t.Setenv(envUserServerURL, api.URL)
	var out, errOut bytes.Buffer
	err := cmdLogoutCLI(nil, &out, &errOut)
	if err == nil || !strings.Contains(err.Error(), "ORBIT_USER_TOKEN") {
		t.Fatalf("err = %v", err)
	}
	if got := api.seen(); len(got) != 0 {
		t.Errorf("logout sent %q", got)
	}
}

func TestWhoamiShowsTheUserTheServerConfirms(t *testing.T) {
	userModeEnv(t)
	api := newFakeUserAPI(t)
	loggedIn(t, api.URL, laptopToken)
	var out, errOut bytes.Buffer
	if err := cmdWhoamiCLI(nil, &out, &errOut); err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"identity:   user", "reason:     the login `orbit login` saved in " + userLoginFile(),
		"server:     " + api.URL, "email:      " + fakeUserEmail, "token:      laptop (pat-laptop)",
		"scopes:     tasks:read, tasks:write", "workspaces: all (not confined)", "expires:    2027-01-04T09:00:00.000Z"} {
		if !strings.Contains(out.String(), want) {
			t.Errorf("whoami lacks %q:\n%s", want, out.String())
		}
	}

	out.Reset()
	t.Setenv(envUserToken, otherToken)
	t.Setenv(envUserServerURL, api.URL)
	if err := cmdWhoamiCLI([]string{"--json"}, &out, &errOut); err != nil {
		t.Fatal(err)
	}
	var identity map[string]interface{}
	if err := json.Unmarshal(out.Bytes(), &identity); err != nil {
		t.Fatalf("%v: %s", err, out.String())
	}
	want := map[string]interface{}{
		"kind": "user", "reason": "ORBIT_USER_TOKEN is set", "source": "ORBIT_USER_TOKEN", "serverUrl": api.URL,
		"userId": "user-1", "email": fakeUserEmail, "tokenId": "pat-other", "tokenName": "ci",
		"scopes": []interface{}{"tasks:read"}, "workspaceIds": []interface{}{"ws-1"}, "neverExpires": true,
	}
	if got, _ := json.Marshal(identity); string(got) != mustJSON(t, want) {
		t.Errorf("whoami --json = %s\nwant %s", got, mustJSON(t, want))
	}
	if strings.Contains(out.String(), otherToken) {
		t.Error("whoami printed the token")
	}
}

// Every command acting as the person says the same thing to a 401 (§6.1): run `orbit login`.
func TestA401SaysTheTokenIsInvalidRevokedOrExpiredAndToRunOrbitLogin(t *testing.T) {
	userModeEnv(t)
	api := newFakeUserAPI(t)
	loggedIn(t, api.URL, laptopToken)
	api.tokens[laptopToken].revoked = true
	var out, errOut bytes.Buffer
	for name, run := range map[string]func() error{
		"whoami": func() error { return cmdWhoamiCLI(nil, &out, &errOut) },
		"api":    func() error { return cmdAPICLI([]string{"/api/tasks"}, strings.NewReader(""), &out, &errOut) },
	} {
		err := run()
		if err == nil || !strings.Contains(err.Error(), "(401)") || !strings.Contains(err.Error(), "invalid, revoked or expired") ||
			!strings.Contains(err.Error(), "orbit login") {
			t.Errorf("%s: %v", name, err)
		}
	}
	t.Setenv(envUserToken, userTokenPrefix+"unknown")
	t.Setenv(envUserServerURL, api.URL)
	err := cmdAPICLI([]string{"tasks"}, strings.NewReader(""), &out, &errOut)
	if err == nil || !strings.Contains(err.Error(), "ORBIT_USER_TOKEN") || !strings.Contains(err.Error(), "orbit login") {
		t.Errorf("api with a refused ORBIT_USER_TOKEN: %v", err)
	}
}

func TestWhoamiInsideASessionIsTheSessionAndAsksNoServer(t *testing.T) {
	userModeEnv(t)
	api := newFakeUserAPI(t)
	loggedIn(t, api.URL, laptopToken)
	t.Setenv("ORBIT_SESSION_ID", "session-1")
	var out, errOut bytes.Buffer
	if err := cmdWhoamiCLI(nil, &out, &errOut); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "identity:   session") || !strings.Contains(out.String(), "session:    session-1") {
		t.Errorf("whoami:\n%s", out.String())
	}
	if strings.Count(errOut.String(), "ignoring the personal access token") != 1 {
		t.Errorf("stderr: %q", errOut.String())
	}
	if got := api.seen(); len(got) != 0 {
		t.Errorf("whoami in a session sent %q", got)
	}
}

func TestWhoamiWithNoIdentityExitsNonZero(t *testing.T) {
	userModeEnv(t)
	var out, errOut bytes.Buffer
	err := cmdWhoamiCLI(nil, &out, &errOut)
	if err == nil || !strings.Contains(err.Error(), "orbit login --with-token") {
		t.Fatalf("err = %v", err)
	}
	if !strings.Contains(out.String(), "identity:   none") {
		t.Errorf("whoami:\n%s", out.String())
	}
}

func TestAPISendsOneRequestUnderAPIAsTheUser(t *testing.T) {
	userModeEnv(t)
	api := newFakeUserAPI(t)
	loggedIn(t, api.URL, laptopToken)
	var out, errOut bytes.Buffer
	if err := cmdAPICLI([]string{"/api/tasks"}, strings.NewReader(""), &out, &errOut); err != nil {
		t.Fatal(err)
	}
	if want := "[\n  {\n    \"id\": \"t1\",\n"; !strings.HasPrefix(out.String(), want) {
		t.Errorf("default output is not indented JSON:\n%s", out.String())
	}
	out.Reset()
	// PATH may leave /api off, and --json prints compact JSON.
	if err := cmdAPICLI([]string{"tasks", "--json"}, strings.NewReader(""), &out, &errOut); err != nil {
		t.Fatal(err)
	}
	if out.String() != `[{"id":"t1","title":"first"},{"id":"t2","title":"second"}]`+"\n" {
		t.Errorf("--json output: %q", out.String())
	}
	if got := api.seen(); len(got) != 2 || got[0] != "GET /api/tasks "+laptopToken || got[1] != got[0] {
		t.Errorf("requests = %q", got)
	}
}

func TestAPIBodiesAndMethods(t *testing.T) {
	userModeEnv(t)
	api := newFakeUserAPI(t)
	loggedIn(t, api.URL, laptopToken)
	var out, errOut bytes.Buffer
	// --data alone is a POST.
	if err := cmdAPICLI([]string{"/api/tasks", "--data", `{"title":"from the cli"}`}, strings.NewReader(""), &out, &errOut); err != nil {
		t.Fatal(err)
	}
	// -X anywhere among the flags, and the body from stdin.
	if err := cmdAPICLI([]string{"-X", "patch", "/api/tasks/t1", "--data-file", "-", "--json"}, strings.NewReader(`{"status":"DONE"}`), &out, &errOut); err != nil {
		t.Fatal(err)
	}
	if err := cmdAPICLI([]string{"-X", "DELETE", "api/tasks/t1"}, strings.NewReader(""), &out, &errOut); err != nil {
		t.Fatal(err)
	}
	want := []string{"POST /api/tasks " + laptopToken, "PATCH /api/tasks/t1 " + laptopToken, "DELETE /api/tasks/t1 " + laptopToken}
	if got := api.seen(); strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Errorf("requests = %q, want %q", got, want)
	}
	if api.bodies[0] != `{"title":"from the cli"}` || api.bodies[1] != `{"status":"DONE"}` || api.bodies[2] != "" {
		t.Errorf("bodies = %q", api.bodies)
	}
	for _, refused := range []struct {
		args  []string
		stdin string
		want  string
	}{
		{[]string{"/api/tasks", "--data", "{not json"}, "", "not valid JSON"},
		{[]string{"-X", "GET", "/api/tasks", "--data", "{}"}, "", "a GET takes no body"},
		{[]string{"/api/tasks", "--data", "{}", "--data-file", "-"}, "{}", "cannot be used together"},
		{[]string{"/api/tasks", "--data-file", "body.json"}, "", "only '-'"},
		{[]string{"-X", "TRACE", "/api/tasks"}, "", "-X must be"},
		{[]string{"-X", "POST", "/api/tasks/page", "--paginate", "--data", "{}"}, "", "--paginate"},
		{[]string{"https://elsewhere.example/api/tasks"}, "", "not a URL"},
		{[]string{"//elsewhere.example/api/tasks"}, "", "not a URL"},
		{[]string{"/api/../dl/orbit"}, "", "not under /api"},
		{[]string{}, "", "expected one PATH"},
		{[]string{"/api/tasks", "/api/projects"}, "", "expected one PATH"},
	} {
		if err := cmdAPICLI(refused.args, strings.NewReader(refused.stdin), &out, &errOut); err == nil || !strings.Contains(err.Error(), refused.want) {
			t.Errorf("orbit api %q: %v, want it to say %q", refused.args, err, refused.want)
		}
	}
	if got := api.seen(); len(got) != 3 {
		t.Errorf("a refused invocation sent a request: %q", got[3:])
	}
}

func TestAPIPaginateFollowsNextCursorAndPrintsEveryPage(t *testing.T) {
	userModeEnv(t)
	api := newFakeUserAPI(t)
	loggedIn(t, api.URL, laptopToken)
	var out, errOut bytes.Buffer
	if err := cmdAPICLI([]string{"/api/tasks/page?limit=1", "--paginate", "--json"}, strings.NewReader(""), &out, &errOut); err != nil {
		t.Fatal(err)
	}
	want := `{"items":[{"id":"c1"}],"nextCursor":"c2"}` + "\n" + `{"items":[{"id":"c2"}],"nextCursor":"c3"}` + "\n" + `{"items":[{"id":"c3"}],"nextCursor":null}` + "\n"
	if out.String() != want {
		t.Errorf("pages:\n%s\nwant:\n%s", out.String(), want)
	}
	wantRequests := []string{
		"GET /api/tasks/page?limit=1 " + laptopToken,
		"GET /api/tasks/page?cursor=c2&limit=1 " + laptopToken,
		"GET /api/tasks/page?cursor=c3&limit=1 " + laptopToken,
	}
	if got := api.seen(); strings.Join(got, "\n") != strings.Join(wantRequests, "\n") {
		t.Errorf("requests = %q", got)
	}
}

// A refusal is printed as the server answered it, and the command fails with its code.
func TestAPIPrintsANon2xxAnswerAndExitsNonZero(t *testing.T) {
	userModeEnv(t)
	api := newFakeUserAPI(t)
	loggedIn(t, api.URL, laptopToken)
	var out, errOut bytes.Buffer
	err := cmdAPICLI([]string{"/api/projects"}, strings.NewReader(""), &out, &errOut)
	if err == nil || !strings.Contains(err.Error(), "GET /api/projects -> 403") || !strings.Contains(err.Error(), "PAT_SCOPE_MISSING") {
		t.Fatalf("err = %v", err)
	}
	if !strings.Contains(out.String(), `"scope": "projects:read"`) {
		t.Errorf("the refusal was not printed:\n%s", out.String())
	}
}

// `orbit api` acts as the person or not at all: a session, a service token, or only the runner's
// credential is refused before anything is sent, and no credential is borrowed to make the request.
func TestAPIActsAsThePersonOrNotAtAll(t *testing.T) {
	cases := []struct {
		name  string
		setup func(t *testing.T, api *fakeUserAPI)
		want  string
	}{
		{"inside a session, with a login and ORBIT_USER_TOKEN on hand", func(t *testing.T, api *fakeUserAPI) {
			loggedIn(t, api.URL, laptopToken)
			t.Setenv(envUserToken, otherToken)
			t.Setenv(envUserServerURL, api.URL)
			t.Setenv("ORBIT_SESSION_ID", "session-1")
		}, "inside an Orbit session"},
		{"with a service token", func(t *testing.T, api *fakeUserAPI) {
			loggedIn(t, api.URL, laptopToken)
			t.Setenv(envServiceToken, fakeServiceToken(t, []string{"session:get"}, "", time.Hour))
		}, "ORBIT_SERVICE_TOKEN is set"},
		{"with only the runner's credential", func(t *testing.T, api *fakeUserAPI) {
			if err := saveConfig(&RunnerConfig{ServerURL: api.URL, RunnerToken: "runner-secret"}); err != nil {
				t.Fatal(err)
			}
		}, "not logged in"},
		{"with nothing", func(t *testing.T, api *fakeUserAPI) {}, "not logged in"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			userModeEnv(t)
			api := newFakeUserAPI(t)
			tc.setup(t, api)
			var out, errOut bytes.Buffer
			err := cmdAPICLI([]string{"/api/tasks"}, strings.NewReader(""), &out, &errOut)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err = %v, want it to say %q", err, tc.want)
			}
			if got := api.seen(); len(got) != 0 {
				t.Errorf("sent %q", got)
			}
		})
	}
}

// `capabilities --json` carries the identity `whoami` reports, without asking the server, and offers
// the person's commands to a terminal but not to a running agent.
func TestCapabilitiesCarryTheIdentityAndOfferThePersonsCommandsHeadlessOnly(t *testing.T) {
	userModeEnv(t)
	api := newFakeUserAPI(t)
	loggedIn(t, api.URL, laptopToken)
	headless := buildCLICapabilities("/usr/local/bin/orbit")
	if headless.Identity.Kind != identityUser || headless.Identity.Source != userLoginFile() || headless.Identity.Email != fakeUserEmail {
		t.Errorf("identity = %+v", headless.Identity)
	}
	ids := capabilityIDs(headless)
	for _, id := range []string{"login", "logout", "whoami", "api"} {
		if !contains(ids, id) {
			t.Errorf("a terminal is not offered %s: %v", id, ids)
		}
	}
	document, err := json.Marshal(headless)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(document), `"identity":{"kind":"user"`) || strings.Contains(string(document), laptopToken) {
		t.Errorf("document identity: %s", document)
	}

	t.Setenv("ORBIT_SESSION_ID", "session-1")
	inSession := buildCLICapabilities("/usr/local/bin/orbit")
	if inSession.Identity.Kind != identitySession || !inSession.Identity.UserTokenIgnored {
		t.Errorf("identity in a session = %+v", inSession.Identity)
	}
	for _, id := range []string{"login", "logout", "whoami", "api"} {
		if contains(capabilityIDs(inSession), id) {
			t.Errorf("a running agent is offered %s", id)
		}
	}
	if got := api.seen(); len(got) != 0 {
		t.Errorf("capabilities sent %q", got)
	}
}
