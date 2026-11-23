//go:build linux || darwin

package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/cgi"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"
)

// Push as me on the runner (docs/design/protected-branch-landing.md §5.2, §9 items 3 and 5, §13 "Runner Go tests").
//
// Real git against a real git server: `git http-backend` behind Basic auth, standing in for github.com
// (githubGitOrigin), as clone_workdir_test.go's fixture does. The server takes pushes with the machine's own
// credential (saved in a credential store, which today's networkGit reads) and with the owner's token. Its
// pre-receive hook logs every ref it is asked to update and answers main the way GitHub does: GH006 / GH013 and exit
// 1 for a refusal, "Bypassed rule violations" and exit 0 for an accepted bypass.

const (
	pushAsMeOwnerToken = "gho_testownertokenforpushasme"
	pushAsMeLease      = "lease-push-as-me"
	bypassWords        = "Bypassed rule violations for refs/heads/main:\n\n- Changes must be made through a pull request.\n\n- Required status check \"ci\" is expected.\n"
	secondAskRefusal   = "Orbit refused a second request for your GitHub token during a landing."
)

type pushAsMeFixture struct {
	dir  string
	bare string
	work string
	// The pre-receive hook's files: the refs it was asked to update, and what it answers main with.
	hookLog, hookSay, hookExit string

	mu sync.Mutex
	// What happened, in order: "push-report" for the synchronous PUSH report, "ask" for a PUSH_AS_ME request, "ask-app"
	// for any other credential request, "receive:<user>" for a push request the server authenticated.
	events []string
	asks   []RunnerGitCredentialRequest
	// The server refuses the owner's token (the token not accepted), the credential route refuses to answer.
	ownerRefused, routeRefuses bool
}

func newPushAsMeFixture(t *testing.T) *pushAsMeFixture {
	t.Helper()
	t.Setenv("ORBIT_HOME", t.TempDir())
	fx := &pushAsMeFixture{dir: t.TempDir()}
	home := filepath.Join(fx.dir, "home")
	if err := os.MkdirAll(home, 0o755); err != nil {
		t.Fatal(err)
	}
	config := filepath.Join(fx.dir, "gitconfig")
	store := filepath.Join(fx.dir, "machine-credentials")
	t.Setenv("HOME", home)
	t.Setenv("GIT_CONFIG_GLOBAL", config)
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	for _, name := range []string{"GIT_ASKPASS", "SSH_ASKPASS", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT", orbitGitCredentialEnv} {
		t.Setenv(name, "")
		_ = os.Unsetenv(name)
	}
	if err := os.WriteFile(config, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	mustRun(t, fx.dir, "git", "config", "--file", config, "credential.helper", "store --file="+store)
	mustRun(t, fx.dir, "git", "config", "--file", config, "user.email", "orbit@example.invalid")
	mustRun(t, fx.dir, "git", "config", "--file", config, "user.name", "orbit")

	srv := filepath.Join(fx.dir, "srv")
	fx.bare = filepath.Join(srv, "owner", "repo.git")
	seed := filepath.Join(fx.dir, "seed")
	mustRun(t, fx.dir, "git", "init", "--quiet", "--bare", "--initial-branch=main", fx.bare)
	mustRun(t, fx.bare, "git", "config", "http.receivepack", "true")
	mustRun(t, fx.dir, "git", "init", "--quiet", "--initial-branch=main", seed)
	if err := os.WriteFile(filepath.Join(seed, "README.md"), []byte("base\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	mustRun(t, seed, "git", "add", ".")
	mustRun(t, seed, "git", "commit", "--quiet", "-m", "base")
	mustRun(t, seed, "git", "push", "--quiet", fx.bare, "main")

	fx.hookLog, fx.hookSay, fx.hookExit = filepath.Join(fx.dir, "hook.log"), filepath.Join(fx.dir, "hook.say"), filepath.Join(fx.dir, "hook.exit")
	hook := "#!/bin/sh\nwhile read old new ref; do\n  echo \"$ref\" >> " + shellQuote(fx.hookLog) + "\n" +
		"  if [ \"$ref\" = refs/heads/main ] && [ -f " + shellQuote(fx.hookSay) + " ]; then\n" +
		"    cat " + shellQuote(fx.hookSay) + " >&2\n    exit \"$(cat " + shellQuote(fx.hookExit) + ")\"\n  fi\ndone\nexit 0\n"
	if err := os.WriteFile(filepath.Join(fx.bare, "hooks", "pre-receive"), []byte(hook), 0o755); err != nil {
		t.Fatal(err)
	}

	gitPath, err := exec.LookPath("git")
	if err != nil {
		t.Fatal(err)
	}
	backend := &cgi.Handler{Path: gitPath, Args: []string{"http-backend"}, Env: []string{"GIT_PROJECT_ROOT=" + srv, "GIT_HTTP_EXPORT_ALL=1"}}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth := r.Header.Get("Authorization")
		fx.mu.Lock()
		user := ""
		switch {
		case auth == basicAuth("orbit", machineGoodPass):
			user = "machine"
		case auth == basicAuth("x-access-token", pushAsMeOwnerToken) && !fx.ownerRefused:
			user = "owner"
		}
		if user != "" && r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/git-receive-pack") {
			fx.events = append(fx.events, "receive:"+user)
		}
		fx.mu.Unlock()
		if user == "" {
			w.Header().Set("WWW-Authenticate", `Basic realm="GitHub"`)
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		r.Header.Set("Authorization", "")
		backend.ServeHTTP(w, r)
	}))
	t.Cleanup(server.Close)
	previousOrigin := githubGitOrigin
	githubGitOrigin = server.URL
	t.Cleanup(func() { githubGitOrigin = previousOrigin })
	entry := strings.Replace(server.URL, "://", "://orbit:"+machineGoodPass+"@", 1)
	if err := os.WriteFile(store, []byte(entry+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	setOrbitGitCredentialSource(func(_ context.Context, request RunnerGitCredentialRequest) (*RunnerGitCredentialAnswer, error) {
		fx.mu.Lock()
		defer fx.mu.Unlock()
		if request.Purpose != pushAsMePurpose {
			fx.events = append(fx.events, "ask-app")
			return nil, &transportHTTPError{method: "POST", path: "/runner/git-credential", statusCode: 409,
				body: `{"message":"this test answers only Push as me"}`}
		}
		fx.events = append(fx.events, "ask")
		fx.asks = append(fx.asks, request)
		if fx.routeRefuses {
			return nil, &transportHTTPError{method: "POST", path: "/runner/git-credential", statusCode: 409,
				body: `{"code":"PUSH_AS_ME_ALREADY_ANSWERED","message":"` + secondAskRefusal + `"}`}
		}
		return &RunnerGitCredentialAnswer{Username: "x-access-token", Password: pushAsMeOwnerToken, ExpiresAt: time.Now().Add(8 * time.Hour).Format(time.RFC3339)}, nil
	})
	t.Cleanup(func() { setOrbitGitCredentialSource(nil) })

	fx.work = filepath.Join(fx.dir, "work")
	mustRun(t, fx.dir, "git", "clone", "--quiet", fx.bare, fx.work)
	mustRun(t, fx.work, "git", "remote", "set-url", "origin", server.URL+"/owner/repo.git")
	mustRun(t, fx.work, "git", "fetch", "--quiet", "origin")
	mustRun(t, fx.work, "git", "config", "user.email", "orbit@example.invalid")
	mustRun(t, fx.work, "git", "config", "user.name", "orbit")
	if err := markGithubWorkspace(fx.work, testCloneWorkspace); err != nil {
		t.Fatal(err)
	}
	return fx
}

// githubAnswersMain makes the server's hook answer every update of main with words on stderr and exit.
func (fx *pushAsMeFixture) githubAnswersMain(t *testing.T, words string, exit string) {
	t.Helper()
	if err := os.WriteFile(fx.hookSay, []byte(words), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(fx.hookExit, []byte(exit), 0o644); err != nil {
		t.Fatal(err)
	}
}

// githubRefusalOutput is GitHub's refusal as its pre-receive writes it: one `error:` line each.
func githubRefusalOutput(words string) string {
	var out strings.Builder
	for _, line := range strings.Split(words, "\n") {
		out.WriteString("error: " + line + "\n")
	}
	return out.String()
}

// mainPushes is how many times the server was asked to update main.
func (fx *pushAsMeFixture) mainPushes() int {
	raw, _ := os.ReadFile(fx.hookLog)
	n := 0
	for _, line := range strings.Split(string(raw), "\n") {
		if line == "refs/heads/main" {
			n++
		}
	}
	return n
}

func (fx *pushAsMeFixture) snapshot() ([]string, []RunnerGitCredentialRequest) {
	fx.mu.Lock()
	defer fx.mu.Unlock()
	return append([]string(nil), fx.events...), append([]RunnerGitCredentialRequest(nil), fx.asks...)
}

// repo is the fixture as an integrationRepo, for the job helpers.
func (fx *pushAsMeFixture) repo(t *testing.T) *integrationRepo {
	return &integrationRepo{t: t, origin: fx.bare, work: fx.work, scratch: filepath.Join(fx.dir, "scratch")}
}

// sender is a v2 control plane that accepts every report, and runs onPush when the synchronous PUSH report arrives.
func (fx *pushAsMeFixture) sender(onPush func()) integrationProgressSender {
	return func(_ context.Context, req IntegrationJobProgressRequest) (*IntegrationJobProgressResponse, error) {
		if req.Phase == "PUSH" && req.TestedSha != "" {
			fx.mu.Lock()
			fx.events = append(fx.events, "push-report")
			fx.mu.Unlock()
			if onPush != nil {
				onPush()
			}
		}
		return &IntegrationJobProgressResponse{Accepted: true}, nil
	}
}

// pushAsMeJob is a v2 claim of a LAND_TASK onto main with landVia PUSH_AS_ME.
func pushAsMeJob(t *testing.T, r *integrationRepo) IntegrationJobCommand {
	cmd := taskOntoMain(t, r, landViaPushAsMe)
	cmd.ReportBeforePush = true
	cmd.ClaimGeneration = "7"
	cmd.LeaseOwner = pushAsMeLease
	return cmd
}

// checkTokenStaysInThePush: the owner's token is in no checkout's configuration or git directory, no remote URL,
// and not in the runner's own environment, from which every engine's is made.
func checkTokenStaysInThePush(t *testing.T, fx *pushAsMeFixture) {
	t.Helper()
	_ = filepath.Walk(filepath.Join(fx.work, ".git"), func(path string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() || info.Size() > 1<<20 {
			return nil
		}
		if raw, err := os.ReadFile(path); err == nil && strings.Contains(string(raw), pushAsMeOwnerToken) {
			t.Errorf("%s holds the owner's token", path)
		}
		return nil
	})
	if remotes := mustGit(t, fx.work, "remote", "-v"); strings.Contains(remotes, pushAsMeOwnerToken) {
		t.Errorf("a remote URL carries the owner's token: %s", remotes)
	}
	for _, entry := range os.Environ() {
		if strings.Contains(entry, pushAsMeOwnerToken) {
			t.Errorf("the runner's environment carries the owner's token: %s", strings.SplitN(entry, "=", 2)[0])
		}
	}
}

// The ask comes after the accepted PUSH report, once, naming the claim; the push GitHub takes is the owner's, and the
// result says so with the rules GitHub said it bypassed.
func TestPushAsMeLandTaskAcceptedSaysItBypassed(t *testing.T) {
	fx := newPushAsMeFixture(t)
	r := fx.repo(t)
	cmd := pushAsMeJob(t, r)
	fx.githubAnswersMain(t, bypassWords, "0")

	result := runIntegrationJobUntilWithProgress(context.Background(), cmd, silent, fx.sender(nil))
	if result.State != "LANDED" || result.PushedAs != "OWNER" {
		t.Fatalf("result = %s/%s %s %v pushedAs %q, want LANDED as the owner", result.State, result.Phase, result.ErrorCode, result.ErrorDetail, result.PushedAs)
	}
	want := []string{"Changes must be made through a pull request.", `Required status check "ci" is expected.`}
	if !slices.Equal(result.BypassedRules, want) {
		t.Fatalf("bypassed rules = %q, want %q", result.BypassedRules, want)
	}
	if got := r.originRev("refs/heads/main"); got != result.TestedSha || result.LandedSha != result.TestedSha {
		t.Fatalf("origin's main is %s, landed %s, tested %s", got, result.LandedSha, result.TestedSha)
	}
	events, asks := fx.snapshot()
	if len(asks) != 1 {
		t.Fatalf("asked %d times for the owner's token, want once: %+v", len(asks), asks)
	}
	ask := asks[0]
	if ask.Purpose != "PUSH_AS_ME" || ask.JobID != cmd.JobID || ask.ClaimGeneration != "7" || ask.LeaseOwner != pushAsMeLease ||
		ask.WorkspaceID != testCloneWorkspace || ask.Host != "github.com" || ask.Path != "owner/repo" || ask.SessionID != "" || ask.MergeOperationID != "" {
		t.Fatalf("ask = %+v", ask)
	}
	report, asked := slices.Index(events, "push-report"), slices.Index(events, "ask")
	if report < 0 || asked < report {
		t.Fatalf("events %q: the token must be asked for only after the PUSH report", events)
	}
	if after := events[asked+1:]; !slices.Contains(after, "receive:owner") || slices.Contains(after, "receive:machine") || slices.Contains(after, "ask-app") {
		t.Fatalf("events after the ask %q: the target push must be the owner's", after)
	}
	if fx.mainPushes() != 1 {
		t.Fatalf("main was pushed %d times", fx.mainPushes())
	}
	if listed, _ := git(fx.bare, "for-each-ref", "refs/heads/orbit/"); listed != "" {
		t.Fatalf("a landing branch was pushed: %s", listed)
	}
	if got := r.rev("main"); got != result.TestedSha {
		t.Fatalf("this checkout's main is %s, want it advanced to %s", got, result.TestedSha)
	}
	checkTokenStaysInThePush(t, fx)

	body, _ := json.Marshal(IntegrationJobResultRequest{State: "LANDED", PushedAs: result.PushedAs, BypassedRules: result.BypassedRules})
	if !strings.Contains(string(body), `"pushedAs":"OWNER"`) || !strings.Contains(string(body), `"bypassedRules":["Changes must`) {
		t.Fatalf("result body %s", body)
	}
	if plain, _ := json.Marshal(IntegrationJobResultRequest{State: "LANDED"}); strings.Contains(string(plain), "pushedAs") || strings.Contains(string(plain), "bypassedRules") {
		t.Fatalf("a landing not pushed as the owner says so: %s", plain)
	}
}

// GitHub refusing the owner's push because of the branch's rules is a landing branch push and PULL_REQUEST with
// GitHub's words; the target is never pushed again, with the machine's credential or any other.
func TestPushAsMeLandTaskProtectedRefusalFallsBack(t *testing.T) {
	for _, words := range []string{gh006Refusal, gh013Refusal} {
		t.Run(strings.SplitN(words, ":", 2)[0], func(t *testing.T) {
			fx := newPushAsMeFixture(t)
			r := fx.repo(t)
			cmd := pushAsMeJob(t, r)
			mainBefore := r.originRev("refs/heads/main")
			fx.githubAnswersMain(t, githubRefusalOutput(words), "1")

			result := runIntegrationJobUntilWithProgress(context.Background(), cmd, silent, fx.sender(nil))
			if result.State != "PULL_REQUEST" || result.PushedAs != "" {
				t.Fatalf("result = %s/%s %s %v, want PULL_REQUEST", result.State, result.Phase, result.ErrorCode, result.ErrorDetail)
			}
			first := strings.SplitN(words, "\n", 2)[0]
			if !strings.Contains(result.PushRefusal, first) {
				t.Fatalf("push refusal %q does not quote GitHub", result.PushRefusal)
			}
			if got := r.originRev(cmd.LandingRef); got != result.TestedSha || result.LandingRefSha != got {
				t.Fatalf("landing branch holds %q, answered %q, tested %q", got, result.LandingRefSha, result.TestedSha)
			}
			if got := r.originRev("refs/heads/main"); got != mainBefore {
				t.Fatalf("origin's main moved to %s", got)
			}
			if fx.mainPushes() != 1 {
				t.Fatalf("main was pushed %d times, want once: never again with another credential", fx.mainPushes())
			}
			if _, asks := fx.snapshot(); len(asks) != 1 {
				t.Fatalf("asked %d times", len(asks))
			}
			checkTokenStaysInThePush(t, fx)
		})
	}
}

// The owner's token not accepted is a refusal too, never a reason to try the machine's credential — which here would
// have pushed main.
func TestPushAsMeLandTaskTokenNotAcceptedFallsBack(t *testing.T) {
	fx := newPushAsMeFixture(t)
	fx.ownerRefused = true
	r := fx.repo(t)
	cmd := pushAsMeJob(t, r)
	mainBefore := r.originRev("refs/heads/main")

	result := runIntegrationJobUntilWithProgress(context.Background(), cmd, silent, fx.sender(nil))
	if result.State != "PULL_REQUEST" || !strings.HasPrefix(result.PushRefusal, "GitHub did not accept your token: ") {
		t.Fatalf("result = %s %s refusal %q", result.State, result.ErrorCode, result.PushRefusal)
	}
	if got := r.originRev("refs/heads/main"); got != mainBefore || fx.mainPushes() != 0 {
		t.Fatalf("origin's main is %s after %d pushes reached it", got, fx.mainPushes())
	}
	if got := r.originRev(cmd.LandingRef); got != result.TestedSha {
		t.Fatalf("landing branch holds %q", got)
	}
	events, _ := fx.snapshot()
	if slices.Contains(events, "ask-app") {
		t.Fatalf("events %q: the App's token was asked for", events)
	}
}

// The credential route refusing (a second request, no connection) is the same fallback, with Orbit's sentence, and the
// target is not tried.
func TestPushAsMeLandTaskCredentialRefusedFallsBack(t *testing.T) {
	fx := newPushAsMeFixture(t)
	fx.routeRefuses = true
	r := fx.repo(t)
	cmd := pushAsMeJob(t, r)

	result := runIntegrationJobUntilWithProgress(context.Background(), cmd, silent, fx.sender(nil))
	if want := "Orbit could not use your GitHub account for this push: " + secondAskRefusal; result.State != "PULL_REQUEST" || result.PushRefusal != want {
		t.Fatalf("result = %s %s refusal %q, want PULL_REQUEST %q", result.State, result.ErrorCode, result.PushRefusal, want)
	}
	if fx.mainPushes() != 0 {
		t.Fatalf("main was pushed %d times", fx.mainPushes())
	}
	if got := r.originRev(cmd.LandingRef); got != result.TestedSha {
		t.Fatalf("landing branch holds %q", got)
	}
}

// PUSH_AS_ME on a claim that does not report its push first has no boundary to ask at: nothing is asked, the target
// is not pushed, and the landing branch is.
func TestPushAsMeWithoutAPushReportPushesOnlyTheLandingBranch(t *testing.T) {
	fx := newPushAsMeFixture(t)
	r := fx.repo(t)
	cmd := taskOntoMain(t, r, landViaPushAsMe)

	result := runIntegrationJob(cmd, silent)
	if result.State != "PULL_REQUEST" || result.PushRefusal != pushAsMeWithoutPushReport {
		t.Fatalf("result = %s %s refusal %q", result.State, result.ErrorCode, result.PushRefusal)
	}
	if _, asks := fx.snapshot(); len(asks) != 0 || fx.mainPushes() != 0 {
		t.Fatalf("asked %d times, main pushed %d times", len(asks), fx.mainPushes())
	}
}

// A target that moved under the owner's push is TARGET_MOVED, as today: here on every round, so the job's refetch
// rounds run out and it answers TARGET_MOVED. The owner's token is asked for once for the claim, and every round's
// push carries it.
func TestPushAsMeLandTaskTargetMoved(t *testing.T) {
	fx := newPushAsMeFixture(t)
	r := fx.repo(t)
	cmd := pushAsMeJob(t, r)
	moved := ""
	advance := func() {
		tree := mustGit(t, fx.bare, "rev-parse", "main^{tree}")
		moved = mustGit(t, fx.bare, "commit-tree", tree, "-p", "main", "-m", "somebody else's")
		mustGit(t, fx.bare, "update-ref", "refs/heads/main", moved)
	}

	result := runIntegrationJobUntilWithProgress(context.Background(), cmd, silent, fx.sender(advance))
	if result.State != "ERROR" || result.ErrorCode != "TARGET_MOVED" {
		t.Fatalf("result = %s %s %v, want TARGET_MOVED", result.State, result.ErrorCode, result.ErrorDetail)
	}
	if got := r.originRev("refs/heads/main"); got != moved {
		t.Fatalf("origin's main is %s, want the other commit %s", got, moved)
	}
	if listed, _ := git(fx.bare, "for-each-ref", "refs/heads/orbit/"); listed != "" {
		t.Fatalf("a landing branch was pushed: %s", listed)
	}
	events, asks := fx.snapshot()
	if len(asks) != 1 {
		t.Fatalf("asked %d times, want once for the claim", len(asks))
	}
	if reports := strings.Count(strings.Join(events, " "), "push-report"); reports != integrationRefetchRounds+1 {
		t.Fatalf("%d PUSH reports, want one per round (%d): %q", reports, integrationRefetchRounds+1, events)
	}
}

// A promotion takes the same step at M-S4.
func TestPushAsMePromotionAccepted(t *testing.T) {
	fx := newPushAsMeFixture(t)
	r := fx.repo(t)
	r.checkoutNew("project/p", "main")
	r.write("p.txt", "project work\n")
	r.commit("project work")
	r.push("project/p")
	r.checkout("main")
	fx.githubAnswersMain(t, bypassWords, "0")

	land := r.promotionCommand("LAND_PROMOTION", "project/p", "PROJECT_BRANCH")
	land.LandVia, land.LandingRef = landViaPushAsMe, landingRefOf(t)
	land.ReportBeforePush, land.ClaimGeneration, land.LeaseOwner = true, "3", pushAsMeLease
	result := runIntegrationJobUntilWithProgress(context.Background(), land, silent, fx.sender(nil))
	if result.State != "LANDED" || result.PushedAs != "OWNER" || len(result.BypassedRules) != 2 {
		t.Fatalf("result = %s %s %v pushedAs %q rules %q", result.State, result.ErrorCode, result.ErrorDetail, result.PushedAs, result.BypassedRules)
	}
	if got := r.originRev("refs/heads/main"); got != result.TestedSha {
		t.Fatalf("origin's main is %s, want %s", got, result.TestedSha)
	}
	if _, asks := fx.snapshot(); len(asks) != 1 || asks[0].JobID != land.JobID || asks[0].ClaimGeneration != "3" {
		t.Fatalf("asks = %+v", asks)
	}
}

// sessionMergeAsMe is a session's Merge onto main with landVia PUSH_AS_ME.
func sessionMergeAsMe(t *testing.T, fx *pushAsMeFixture) MergeCommand {
	t.Helper()
	base := mustGit(t, fx.work, "rev-parse", "main")
	mustGit(t, fx.work, "checkout", "--quiet", "-b", "orbit/feat")
	commitFile(t, fx.work, "feature.txt", "feature\n", "feature work")
	mustGit(t, fx.work, "checkout", "--quiet", "main")
	return MergeCommand{
		WorkDir: fx.work, Branch: "orbit/feat", SessionID: "as-me-session", OperationID: "op-as-me", LeaseOwner: pushAsMeLease,
		BaseSha: base, TargetBranch: "main", LandVia: landViaPushAsMe, LandingRef: "refs/heads/orbit/land/as-me-session",
	}
}

func TestPushAsMeSessionMergeAccepted(t *testing.T) {
	fx := newPushAsMeFixture(t)
	req := sessionMergeAsMe(t, fx)
	fx.githubAnswersMain(t, bypassWords, "0")

	out := mergeToMain(req)
	if out.Status != "merged" || out.PushedAs != "OWNER" || out.LandVia != landViaPushAsMe || len(out.BypassedRules) != 2 {
		t.Fatalf("merge = %+v, want merged as the owner", out)
	}
	if got := mustGit(t, fx.bare, "rev-parse", "main"); got != out.MergedSha {
		t.Fatalf("origin's main is %s, merged %s", got, out.MergedSha)
	}
	_, asks := fx.snapshot()
	if len(asks) != 1 || asks[0].Purpose != "PUSH_AS_ME" || asks[0].SessionID != req.SessionID || asks[0].MergeOperationID != req.OperationID ||
		asks[0].LeaseOwner != pushAsMeLease || asks[0].JobID != "" || asks[0].ClaimGeneration != "" {
		t.Fatalf("asks = %+v", asks)
	}
	checkTokenStaysInThePush(t, fx)
}

func TestPushAsMeSessionMergeRefusedOpensAPullRequest(t *testing.T) {
	fx := newPushAsMeFixture(t)
	req := sessionMergeAsMe(t, fx)
	originMain := mustGit(t, fx.bare, "rev-parse", "main")
	fx.githubAnswersMain(t, githubRefusalOutput(gh006Refusal), "1")

	out := mergeToMain(req)
	if out.Status != "pull_request" || out.LandVia != landViaPushAsMe || !strings.Contains(out.PushRefusal, "GH006") || out.PushedAs != "" {
		t.Fatalf("merge = %+v, want pull_request with GitHub's words and landVia echoed", out)
	}
	if got := mustGit(t, fx.bare, "rev-parse", req.LandingRef); got != out.PushedSha {
		t.Fatalf("landing branch %s, answered %s", got, out.PushedSha)
	}
	if got := mustGit(t, fx.bare, "rev-parse", "main"); got != originMain || fx.mainPushes() != 1 {
		t.Fatalf("origin's main %s after %d pushes", got, fx.mainPushes())
	}
	if got := mustGit(t, fx.work, "rev-parse", "main"); got != originMain {
		t.Fatalf("this machine's main moved to %s", got)
	}
}

func TestPushAsMeSessionMergeCredentialRefused(t *testing.T) {
	fx := newPushAsMeFixture(t)
	fx.routeRefuses = true
	req := sessionMergeAsMe(t, fx)

	out := mergeToMain(req)
	if want := "Orbit could not use your GitHub account for this push: " + secondAskRefusal; out.Status != "pull_request" || out.PushRefusal != want || out.LandVia != landViaPushAsMe {
		t.Fatalf("merge = %+v, want pull_request %q", out, want)
	}
	if fx.mainPushes() != 0 {
		t.Fatalf("main was pushed %d times", fx.mainPushes())
	}
}

// The owner's push names Orbit's helper alone, told to answer the owner's credential and nothing else, with hooks off;
// the token is in that command's environment only.
func TestPushAsMeOwnerPushArgvAndEnv(t *testing.T) {
	t.Parallel()
	credential := &orbitGitCredential{WorkspaceID: testCloneWorkspace, Protocol: "https", Host: "github.com", Path: "owner/repo",
		Username: "x-access-token", Password: pushAsMeOwnerToken}
	args := networkGitArgsFor("/repo", credential, true, []string{"push", "origin", "abc:refs/heads/main"})
	exe := orbitCLIExecutable()
	if exe == "" {
		t.Skip("no executable path")
	}
	want := []string{"-C", "/repo", "-c", "credential.helper=",
		"-c", "credential.helper=!" + shellQuote(filepath.ToSlash(exe)) + " git-credential-readonly --workspace " + shellQuote(testCloneWorkspace) + " --only",
		"-c", "credential.useHttpPath=true", "-c", "core.hooksPath=" + filepath.ToSlash(os.DevNull),
		"push", "origin", "abc:refs/heads/main"}
	if !slices.Equal(args, want) {
		t.Fatalf("argv\n got %q\nwant %q", args, want)
	}
	if strings.Contains(strings.Join(args, " "), pushAsMeOwnerToken) {
		t.Fatal("the token is on the command line")
	}
	// Every other command keeps its helper as it was.
	if plain := networkGitArgsWith("/repo", credential, []string{"fetch"}); strings.Contains(strings.Join(plain, " "), "--only") {
		t.Fatalf("a command with the App's token names --only: %q", plain)
	}
	carried := false
	for _, entry := range networkGitCommandEnv(credential) {
		carried = carried || (strings.HasPrefix(entry, orbitGitCredentialEnv+"=") && strings.Contains(entry, pushAsMeOwnerToken))
	}
	if !carried {
		t.Fatal("the push's environment does not carry the owner's credential")
	}
}

// With --only the helper answers the owner's credential and never falls back to the machine's helpers for a question
// the credential does not match; without it, the same question is answered by the machine's credential, as always.
func TestPushAsMeHelperOnlyDoesNotFallBack(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	store := filepath.Join(dir, "store")
	config := filepath.Join(dir, "gitconfig")
	if err := os.WriteFile(store, []byte("https://machine:machine-secret@github.com\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(config, []byte("[credential]\n\thelper = store --file="+store+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(orbitGitCredential{WorkspaceID: testCloneWorkspace, Protocol: "https", Host: "github.com", Path: "owner/repo",
		Username: "x-access-token", Password: pushAsMeOwnerToken})
	helper := func(question string, flags ...string) string {
		t.Helper()
		cmd := exec.Command(os.Args[0], append(append([]string{gitCredentialReadOnlyCommand}, flags...), "get")...)
		cmd.Env = append(withoutGitCommandLineConfig(os.Environ()), "HOME="+dir, "GIT_CONFIG_GLOBAL="+config, "GIT_CONFIG_NOSYSTEM=1",
			orbitGitCredentialEnv+"="+string(raw))
		cmd.Stdin = strings.NewReader(question)
		out, err := cmd.Output()
		if err != nil {
			t.Fatalf("helper %q: %v", flags, err)
		}
		return string(out)
	}
	other := "protocol=https\nhost=github.com\npath=owner/another.git\n\n"
	only := []string{gitCredentialWorkspaceFlag, testCloneWorkspace, gitCredentialOnlyFlag}
	if got := helper(other, only...); got != "" {
		t.Fatalf("--only answered a question the owner's credential does not match: %q", got)
	}
	if got := helper(other, gitCredentialWorkspaceFlag, testCloneWorkspace); !strings.Contains(got, "machine-secret") {
		t.Fatalf("without --only the machine's credential should answer: %q", got)
	}
	if got := helper("protocol=https\nhost=github.com\npath=owner/repo.git\n\n", only...); !strings.Contains(got, "password="+pushAsMeOwnerToken) {
		t.Fatalf("--only did not answer the owner's credential: %q", got)
	}
}

func TestBypassedRulesOf(t *testing.T) {
	t.Parallel()
	accepted := "remote: Bypassed rule violations for refs/heads/main:\nremote: \nremote: - Changes must be made through a pull request.\nremote: \nremote: - Required status check \"ci\" is expected.\nremote: \nTo https://github.com/o/r.git\n   abc..def  HEAD -> main"
	if got, want := bypassedRulesOf(accepted), []string{"Changes must be made through a pull request.", `Required status check "ci" is expected.`}; !slices.Equal(got, want) {
		t.Fatalf("rules = %q, want %q", got, want)
	}
	refused := "remote: error: GH013: Repository rule violations found for refs/heads/main.\nremote: - Changes must be made through a pull request."
	if got := bypassedRulesOf(refused); got != nil {
		t.Fatalf("a refusal's rules read as bypassed: %q", got)
	}
	var many strings.Builder
	many.WriteString("remote: Bypassed rule violations for refs/heads/main:\n")
	for i := 0; i < 30; i++ {
		many.WriteString("remote: - " + strings.Repeat("x", 300) + "\n")
	}
	got := bypassedRulesOf(many.String())
	if len(got) != bypassedRulesMax || len([]rune(got[0])) > bypassedRuleLenMax+1 {
		t.Fatalf("%d rules, the first %d long", len(got), len([]rune(got[0])))
	}
	if bypassedRulesOf("To https://github.com/o/r.git\n   abc..def  HEAD -> main") != nil {
		t.Fatal("a plain push read as a bypass")
	}
}

func TestRunnerDeclaresPushAsMe(t *testing.T) {
	t.Parallel()
	for _, d := range strings.Split(runnerCapabilitiesV1, ",") {
		if strings.TrimSpace(d) == "push-as-me/v1" {
			return
		}
	}
	t.Fatalf("push-as-me/v1 is not declared: %s", runnerCapabilitiesV1)
}

// Every other landVia pushes the target as it always did: no ask, no owner push.
func TestPushesAsOwnerOnlyForPushAsMe(t *testing.T) {
	t.Parallel()
	cases := []struct {
		landVia     string
		viaPR, open bool
		want        bool
	}{
		{landViaPushAsMe, true, false, true},
		{landViaPushAsMe, true, true, false},
		{landViaPushAsMe, false, false, false},
		{landViaPullRequest, true, false, false},
		{landViaPush, false, false, false},
		{"", false, false, false},
	}
	for _, c := range cases {
		if got := pushesAsOwner(c.landVia, c.viaPR, c.open); got != c.want {
			t.Errorf("pushesAsOwner(%q, %v, %v) = %v, want %v", c.landVia, c.viaPR, c.open, got, c.want)
		}
	}
}
