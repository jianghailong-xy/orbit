package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// A subprocess fixture exercises the actual LaunchSpec environment and files. It is not
// a substitute for P0's real dsh evidence or P3's protocol driver tests.
func TestDshEnvironmentChildProcess(t *testing.T) {
	if os.Getenv("ORBIT_DSH_TEST_CHILD") != "1" {
		return
	}
	home := os.Getenv("DSH_HOME")
	var patch []struct {
		Config struct {
			APIKeyEnv string `json:"apiKeyEnv"`
			BaseURL   string `json:"baseURL"`
		} `json:"config"`
	}
	data, err := os.ReadFile(filepath.Join(home, "orbit.patch.json"))
	if err != nil || json.Unmarshal(data, &patch) != nil || len(patch) != 1 {
		os.Exit(21)
	}
	key := os.Getenv(patch[0].Config.APIKeyEnv)
	if key == "" {
		fmt.Println(`{"error":"DSH_CREDENTIAL_MISSING"}`)
		os.Exit(22)
	}
	previous, _ := os.ReadFile(filepath.Join(home, "runtime-session.json"))
	for _, name := range []string{"package.json", "pnpm-workspace.yaml", "cordis.patch.yml", "cordis.yml"} {
		path := filepath.Join(home, "profiles", "acp", name)
		if _, err := os.Stat(path); os.IsNotExist(err) {
			if os.WriteFile(path, []byte("synthetic-profile:"+name), 0o600) != nil {
				os.Exit(27)
			}
		}
	}
	body, _ := json.Marshal(map[string]string{"dshHome": home, "home": os.Getenv("HOME"), "cwd": mustChildCwd(), "permission": os.Getenv("DSH_PERMISSION_MODE"), "previous": string(previous)})
	req, _ := http.NewRequest("POST", patch[0].Config.BaseURL+"/v1/messages", bytes.NewReader(body))
	req.Header.Set("x-api-key", key)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		os.Exit(23)
	}
	io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	if resp.StatusCode == 401 {
		fmt.Println(`{"error":"DSH_CREDENTIAL_INVALID"}`)
		os.Exit(24)
	}
	if resp.StatusCode != 200 {
		os.Exit(25)
	}
	if len(previous) == 0 {
		if os.WriteFile(filepath.Join(home, "runtime-session.json"), []byte("durable:"+filepath.Base(home)), 0o600) != nil {
			os.Exit(26)
		}
	}
	fmt.Println(`{"stopReason":"end_turn"}`)
	os.Exit(0)
}

func mustChildCwd() string { cwd, _ := os.Getwd(); return cwd }

func dshEnvironmentFixture(t *testing.T) (string, string) {
	t.Helper()
	root := t.TempDir()
	userDir := filepath.Join(root, "user")
	workspace := filepath.Join(root, "workspace")
	for _, dir := range []string{filepath.Join(userDir, ".dsh", "profiles", "acp"), workspace} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	for path, value := range map[string]string{
		filepath.Join(userDir, ".dsh", "cordis.patch.yml"):                    "user-config",
		filepath.Join(userDir, ".dsh", ".credentials.yaml"):                   "version: 1\nrefs:\n  ORBIT_DSH_API_KEY: fake-user-key\n",
		filepath.Join(userDir, ".dsh", "profiles", "acp", "cordis.patch.yml"): "user-profile",
		filepath.Join(workspace, ".env"):                                      "ORBIT_DSH_API_KEY=fake-project-key\nDEEPSEEK_API_KEY=fake-project-default\n",
	} {
		if err := os.WriteFile(path, []byte(value), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("HOME", userDir)
	t.Setenv("ORBIT_HOME", filepath.Join(root, "orbit"))
	t.Setenv("DSH_HOME", filepath.Join(userDir, ".dsh"))
	t.Setenv("ORBIT_DSH_API_KEY", "fake-ambient-key")
	t.Setenv("DEEPSEEK_API_KEY", "fake-ambient-default")
	t.Setenv("ANTHROPIC_API_KEY", "fake-unrelated-key")
	t.Setenv("NODE_OPTIONS", "--fake-unsafe-option")
	return userDir, workspace
}

func dshSnapshot(t *testing.T, root string) string {
	t.Helper()
	h := sha256.New()
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		fmt.Fprint(h, strings.TrimPrefix(path, root), info.Mode())
		if entry.Type().IsRegular() {
			data, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			h.Write(data)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return fmt.Sprintf("%x", h.Sum(nil))
}

func runDshFixture(spec DshLaunchSpec) (string, error) {
	cmd := exec.Command(spec.Executable, append([]string{"-test.run=^TestDshEnvironmentChildProcess$", "--"}, spec.Args...)...)
	cmd.Env = append(spec.Env, "ORBIT_DSH_TEST_CHILD=1")
	cmd.Dir = spec.Cwd
	data, err := cmd.CombinedOutput()
	return string(data), err
}

func testDshExecutable(t *testing.T) string {
	t.Helper()
	path, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	return path
}

func TestDshConcurrentSessionIsolationAndRestart(t *testing.T) {
	userDir, workspace := dshEnvironmentFixture(t)
	before := dshSnapshot(t, userDir)
	type recorded struct {
		key, path string
		body      map[string]string
	}
	requests := make(chan recorded, 4)
	release := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]string
		if json.NewDecoder(r.Body).Decode(&body) != nil {
			w.WriteHeader(400)
			return
		}
		requests <- recorded{r.Header.Get("x-api-key"), r.URL.Path, body}
		<-release
		w.WriteHeader(200)
	}))
	defer server.Close()
	var releaseOnce sync.Once
	defer releaseOnce.Do(func() { close(release) })
	inputs := []DshLaunchInput{
		{"session-alpha", workspace, "fake-key-alpha", server.URL + "/alpha", "read-only"},
		{"session-beta", workspace, "fake-key-beta", server.URL + "/beta", "workspace-write"},
	}
	specs := make([]DshLaunchSpec, 2)
	for i, input := range inputs {
		var err error
		specs[i], err = prepareDshConfig(input, testDshExecutable(t))
		if err != nil {
			t.Fatal(err)
		}
	}
	if specs[0].DshHome == specs[1].DshHome || specs[0].ConfigHash == specs[1].ConfigHash {
		t.Fatal("session config collision")
	}
	for round := 0; round < 2; round++ {
		var wg sync.WaitGroup
		outputs := make([]string, 2)
		errs := make([]error, 2)
		for i := range inputs {
			if round == 1 {
				resumed, err := prepareDshConfig(inputs[i], testDshExecutable(t))
				if err != nil {
					t.Fatal(err)
				}
				if resumed.DshHome != specs[i].DshHome || resumed.ConfigHash != specs[i].ConfigHash {
					t.Fatal("restart changed session identity")
				}
				specs[i] = resumed
			}
			wg.Add(1)
			go func(i int) { defer wg.Done(); outputs[i], errs[i] = runDshFixture(specs[i]) }(i)
		}
		// Both children reach the server before either request is released.
		for range inputs {
			var r recorded
			select {
			case r = <-requests:
			case <-time.After(15 * time.Second):
				t.Fatal("both fake Harness processes must reach the mock concurrently")
			}
			i := 0
			if r.key == inputs[1].APIKey {
				i = 1
			}
			if r.key != inputs[i].APIKey || r.path != []string{"/alpha/v1/messages", "/beta/v1/messages"}[i] || r.body["dshHome"] != specs[i].DshHome || r.body["permission"] != inputs[i].FileMode || r.body["home"] != userDir || r.body["cwd"] != workspace {
				t.Fatalf("cross-session request: %+v", r.body)
			}
			if (round == 0 && r.body["previous"] != "") || (round == 1 && r.body["previous"] != "durable:"+filepath.Base(specs[i].DshHome)) {
				t.Fatal("recovery state was lost or shared")
			}
		}
		if round == 0 {
			releaseOnce.Do(func() { close(release) })
		}
		wg.Wait()
		for i := range inputs {
			if errs[i] != nil || !strings.Contains(outputs[i], "end_turn") {
				t.Fatalf("fake Harness launch failed: %v %s", errs[i], outputs[i])
			}
			if err := SealDshProfile(specs[i]); err != nil {
				t.Fatal(err)
			}
			for _, key := range []string{inputs[0].APIKey, inputs[1].APIKey} {
				if strings.Contains(outputs[i], key) {
					t.Fatal("key in ordinary process output")
				}
			}
		}
	}
	if after := dshSnapshot(t, userDir); after != before {
		t.Fatal("user Harness configuration changed")
	}
}

func TestDshProfileAndOverlayHashesPreserveRecovery(t *testing.T) {
	_, workspace := dshEnvironmentFixture(t)
	input := DshLaunchInput{"hash-session", workspace, "fake-original", "https://synthetic.example", "read-only"}
	spec, err := prepareDshConfig(input, testDshExecutable(t))
	if err != nil {
		t.Fatal(err)
	}
	if err := SealDshProfile(spec); err == nil {
		t.Fatal("missing startup profile was sealed")
	}
	for _, name := range []string{"package.json", "pnpm-workspace.yaml", "cordis.patch.yml", "cordis.yml"} {
		if err := os.WriteFile(filepath.Join(spec.DshHome, "profiles", "acp", name), []byte("synthetic-profile:"+name), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := SealDshProfile(spec); err != nil {
		t.Fatal(err)
	}
	input.APIKey, input.BaseURL = "fake-rotated", "https://rotated.example"
	changed, err := prepareDshConfig(input, testDshExecutable(t))
	if err != nil || changed.ConfigHash == spec.ConfigHash || changed.DshHome != spec.DshHome {
		t.Fatalf("authorized update lost identity or retained old settings: %v", err)
	}
	before := dshSnapshot(t, changed.DshHome)
	if err := SealDshProfile(spec); err == nil {
		t.Fatal("stale process sealed new launch configuration")
	}
	if dshSnapshot(t, changed.DshHome) != before {
		t.Fatal("stale seal changed recovery data")
	}
	profile := filepath.Join(changed.DshHome, "profiles", "acp", "cordis.patch.yml")
	if err := os.WriteFile(profile, []byte("tampered profile"), 0o600); err != nil {
		t.Fatal(err)
	}
	before = dshSnapshot(t, changed.DshHome)
	if _, err := prepareDshConfig(input, testDshExecutable(t)); err == nil || !strings.Contains(err.Error(), "profile hash") {
		t.Fatal("profile mismatch was silently replaced")
	}
	if dshSnapshot(t, changed.DshHome) != before {
		t.Fatal("profile conflict destroyed recovery data")
	}
	if err := os.WriteFile(profile, []byte("synthetic-profile:cordis.patch.yml"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(changed.Args[3], []byte("tampered overlay"), 0o600); err != nil {
		t.Fatal(err)
	}
	before = dshSnapshot(t, changed.DshHome)
	if _, err := prepareDshConfig(input, testDshExecutable(t)); err == nil || !strings.Contains(err.Error(), "overlay hash") {
		t.Fatal("overlay mismatch was silently replaced")
	}
	if dshSnapshot(t, changed.DshHome) != before {
		t.Fatal("overlay conflict destroyed recovery data")
	}
}

func TestDshMissingRevokedAndInvalidCredentials(t *testing.T) {
	userDir, workspace := dshEnvironmentFixture(t)
	before := dshSnapshot(t, userDir)
	requests := make(chan string, 4)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		key := r.Header.Get("x-api-key")
		requests <- key
		if key == "fake-valid" || key == "fake-rotated" {
			w.WriteHeader(200)
		} else {
			w.WriteHeader(401)
		}
	}))
	defer server.Close()
	input := DshLaunchInput{"credential-session", workspace, "fake-valid", server.URL, "read-only"}
	spec, err := prepareDshConfig(input, testDshExecutable(t))
	if err != nil {
		t.Fatal(err)
	}
	if output, err := runDshFixture(spec); err != nil {
		t.Fatalf("valid credential failed %v %s", err, output)
	}
	if <-requests != "fake-valid" {
		t.Fatal("wrong dispatched key")
	}
	for _, key := range []string{"fake-revoked", "fake-invalid", "fake-rotated"} {
		input.APIKey = key
		fresh, err := prepareDshConfig(input, testDshExecutable(t))
		if err != nil {
			t.Fatal(err)
		}
		if fresh.DshHome != spec.DshHome {
			t.Fatal("rotation dropped recovery state")
		}
		output, err := runDshFixture(fresh)
		if key == "fake-rotated" {
			if err != nil {
				t.Fatal("new key did not recover")
			}
		} else if err == nil || !strings.Contains(output, "DSH_CREDENTIAL_INVALID") {
			t.Fatal("invalid/revoked key accepted")
		}
		if strings.Contains(output, key) || <-requests != key {
			t.Fatal("stale or exposed key")
		}
	}
	job := &ClaimedSession{SessionID: input.OrbitSessionID, Agent: AgentExecConfig{Env: map[string]string{"ORBIT_DSH_BASE_URL": server.URL, "DEEPSEEK_API_KEY": "fake-agent-ambient"}}}
	if _, err := PrepareDshSessionLaunch(context.Background(), job, workspace, "read-only"); err == nil || !strings.Contains(err.Error(), "DSH_CREDENTIAL_MISSING") {
		t.Fatal("missing authorized key fell back to ambient credentials")
	}
	select {
	case <-requests:
		t.Fatal("missing key sent a request")
	default:
	}
	if dshSnapshot(t, userDir) != before {
		t.Fatal("user configuration changed during credential failure")
	}
}

func TestDshPrivateConfigurationAndSafeDiagnostics(t *testing.T) {
	userDir, workspace := dshEnvironmentFixture(t)
	before := dshSnapshot(t, userDir)
	input := DshLaunchInput{"private-session", workspace, "opaque/arbitrary-secret", "https://synthetic.example/anthropic", "read-only"}
	spec, err := prepareDshConfig(input, testDshExecutable(t))
	if err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"DEEPSEEK_API_KEY", "ANTHROPIC_API_KEY", "NODE_OPTIONS", "ORBIT_HOME"} {
		if envValue(spec.Env, key) != "" {
			t.Fatalf("inherited %s", key)
		}
	}
	if envValue(spec.Env, "ORBIT_DSH_API_KEY") != input.APIKey || envValue(spec.Env, "HOME") != userDir || envValue(spec.Env, "DSH_TELEMETRY_DISABLED") != "1" {
		t.Fatal("launch environment lost explicit settings")
	}
	for _, path := range []string{spec.DshHome, filepath.Join(spec.DshHome, "profiles", "acp"), spec.Args[3], filepath.Join(spec.DshHome, "orbit-owner.json")} {
		info, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		want := os.FileMode(0o600)
		if info.IsDir() {
			want = 0o700
		}
		if info.Mode().Perm() != want {
			t.Fatalf("private config mode %o", info.Mode().Perm())
		}
	}
	api, _ := json.Marshal(spec)
	for _, output := range []string{string(api), fmt.Sprintf("%+v", spec), fmt.Sprintf("%#v", spec), fmt.Sprintf("%+v", input), fmt.Sprintf("%#v", input)} {
		if strings.Contains(output, input.APIKey) || strings.Contains(output, "fake-ambient") {
			t.Fatal("launch key leaked to ordinary diagnostics/API")
		}
	}
	filepath.WalkDir(spec.DshHome, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			t.Fatal(err)
		}
		if entry.Type().IsRegular() {
			data, _ := os.ReadFile(path)
			if bytes.Contains(data, []byte(input.APIKey)) {
				t.Fatal("key persisted to recovery data")
			}
		}
		return nil
	})
	if dshSnapshot(t, userDir) != before {
		t.Fatal("user profile changed")
	}
}

func TestDshRecoveryDirectoryConflictsFailClosed(t *testing.T) {
	_, workspace := dshEnvironmentFixture(t)
	input := DshLaunchInput{"safe-session", workspace, "fake-key", "https://synthetic.example", "read-only"}
	spec, err := prepareDshConfig(input, testDshExecutable(t))
	if err != nil {
		t.Fatal(err)
	}
	before := dshSnapshot(t, spec.DshHome)
	other := t.TempDir()
	input.ExecutionDir = other
	if _, err := prepareDshConfig(input, testDshExecutable(t)); err == nil {
		t.Fatal("same session moved to another workspace")
	}
	if dshSnapshot(t, spec.DshHome) != before {
		t.Fatal("conflict overwrote recovery files")
	}
	input.ExecutionDir = workspace
	input.OrbitSessionID = "../../user/.dsh"
	if _, err := prepareDshConfig(input, testDshExecutable(t)); err == nil {
		t.Fatal("path traversal accepted")
	}
	input.OrbitSessionID = "safe-session"
	input.FileMode = "danger-full-access"
	if _, err := prepareDshConfig(input, testDshExecutable(t)); err == nil {
		t.Fatal("unsupported file policy accepted")
	}
	input.FileMode = "read-only"
	input.BaseURL = "https://user:secret@example.test"
	if _, err := prepareDshConfig(input, testDshExecutable(t)); err == nil || strings.Contains(err.Error(), "secret") {
		t.Fatal("embedded URL credential accepted or exposed")
	}
	unowned := t.TempDir()
	input.BaseURL = "https://synthetic.example"
	if err := os.WriteFile(filepath.Join(unowned, "cordis.patch.yml"), []byte("retain"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := prepareDshConfigAt(input, testDshExecutable(t), unowned); err == nil {
		t.Fatal("existing Harness config claimed")
	}
	input.BaseURL = "https://synthetic.example"
	if err := os.Remove(spec.Args[3]); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(unowned, "cordis.patch.yml"), spec.Args[3]); err != nil {
		t.Fatal(err)
	}
	if _, err := prepareDshConfig(input, testDshExecutable(t)); err == nil {
		t.Fatal("config symlink overwritten")
	}
	data, _ := os.ReadFile(filepath.Join(unowned, "cordis.patch.yml"))
	if string(data) != "retain" {
		t.Fatal("symlink target changed")
	}
}
