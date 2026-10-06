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
	"sort"
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
		ID     string `json:"id"`
		Config struct {
			APIKeyEnv string `json:"apiKeyEnv"`
			BaseURL   string `json:"baseURL"`
		} `json:"config"`
	}
	data, err := os.ReadFile(filepath.Join(home, "orbit.patch.json"))
	if err != nil || json.Unmarshal(data, &patch) != nil || len(patch) != 3 || patch[0].ID != "llm-deepseek" {
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

// dshUploadRows are Harness's official switches for the two request fields its default profile
// adds to every model request: the session log and the active plugin inventory.
var dshUploadRows = []string{"session-log-deepseek", "plugin-package-inventory-deepseek"}

// dshPatchRows reads every --patch a launch passes, in order, keyed by row id (last write wins).
func dshPatchRows(t *testing.T, spec DshLaunchSpec) map[string]map[string]interface{} {
	t.Helper()
	rows := map[string]map[string]interface{}{}
	for i, arg := range spec.Args {
		if arg != "--patch" {
			continue
		}
		data, err := os.ReadFile(spec.Args[i+1])
		if err != nil {
			t.Fatal(err)
		}
		var patch []map[string]interface{}
		if err := json.Unmarshal(data, &patch); err != nil {
			t.Fatal(err)
		}
		for _, row := range patch {
			if id, _ := row["id"].(string); id != "" {
				rows[id] = row
			}
		}
	}
	return rows
}

// TestDshSessionLogUploadDisabledByDefault: every Orbit launch, a session with its agent overlay
// and a credentialless catalogue probe alike, turns both upload contributions off.
func TestDshSessionLogUploadDisabledByDefault(t *testing.T) {
	_, workspace := dshEnvironmentFixture(t)
	input := DshLaunchInput{"upload-session", workspace, "fake-key", "https://synthetic.example", "workspace-write"}
	session, err := prepareDshAgentConfigAt(input, &DshAgentOverlay{AppendSystemPrompt: "synthetic"}, testDshExecutable(t), filepath.Join(t.TempDir(), "session"))
	if err != nil {
		t.Fatal(err)
	}
	probe, err := prepareDshConfigAt(input, testDshExecutable(t), filepath.Join(t.TempDir(), "probe"))
	if err != nil {
		t.Fatal(err)
	}
	for name, spec := range map[string]DshLaunchSpec{"session": session, "probe": probe} {
		rows := dshPatchRows(t, spec)
		for _, id := range dshUploadRows {
			config, _ := json.Marshal(rows[id]["config"])
			if string(config) != `{"enabled":false}` || rows[id]["disabled"] != nil {
				t.Fatalf("%s launch leaves %s at %v", name, id, rows[id])
			}
		}
	}
}

// dshUploadMarkers are synthetic values a recorded session puts in each place a log could carry.
type dshUploadMarker struct{ name, value string }

// dshFieldPaths lists a JSON value's key paths, arrays collapsed to [], with each leaf's JSON type.
func dshFieldPaths(prefix string, value interface{}, out map[string]string) {
	switch v := value.(type) {
	case map[string]interface{}:
		for key, child := range v {
			if key == "parameters" {
				// A tool's JSON schema is the tool definition the model sees, not session data.
				out[prefix+".parameters"] = "schema"
				continue
			}
			dshFieldPaths(prefix+"."+key, child, out)
		}
	case []interface{}:
		if len(v) == 0 {
			out[prefix+"[]"] = "empty"
		}
		for _, child := range v {
			dshFieldPaths(prefix+"[]", child, out)
		}
	case string:
		out[prefix] = "string"
	case float64:
		out[prefix] = "number"
	case bool:
		out[prefix] = "boolean"
	case nil:
		out[prefix] = "null"
	}
}

func dshSortedKeys(m map[string]interface{}) []string {
	keys := make([]string, 0, len(m))
	for key := range m {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

// dshRedactedUploads reduces recorded requests to structure: field presence, event types, key paths,
// package identities and which synthetic markers each part carries. No recorded text is kept.
func dshRedactedUploads(bodies []map[string]interface{}, headers []http.Header, markers []dshUploadMarker) map[string]interface{} {
	var requests []map[string]interface{}
	eventTypes, eventPaths, headerPaths := map[string]int{}, map[string]map[string]string{}, map[string]string{}
	packages := map[string]bool{}
	found := map[string]map[string]bool{}
	for _, marker := range markers {
		found[marker.name] = map[string]bool{}
	}
	for i, body := range bodies {
		row := map[string]interface{}{"index": i, "topLevelKeys": dshSortedKeys(body)}
		var harnessHeaders []string
		for name := range headers[i] {
			if strings.HasPrefix(strings.ToLower(name), "x-deepseek-harness-") {
				harnessHeaders = append(harnessHeaders, strings.ToLower(name))
			}
		}
		sort.Strings(harnessHeaders)
		row["harnessHeaders"] = harnessHeaders
		if log, ok := body["dsh_session_log"].(map[string]interface{}); ok {
			events, _ := log["events"].([]interface{})
			types := map[string]int{}
			for _, raw := range events {
				event := mapValue(raw)
				typ, _ := event["type"].(string)
				types[typ]++
				eventTypes[typ]++
				if eventPaths[typ] == nil {
					eventPaths[typ] = map[string]string{}
				}
				dshFieldPaths("", event, eventPaths[typ])
			}
			dshFieldPaths("", map[string]interface{}{"session": log["session"]}, headerPaths)
			encoded, _ := json.Marshal(log)
			row["dsh_session_log"] = map[string]interface{}{"keys": dshSortedKeys(log), "version": log["version"], "afterSeq": log["afterSeq"],
				"throughSeq": log["throughSeq"], "events": len(events), "eventTypes": types, "bytes": len(encoded)}
		}
		if inventory, ok := body["dsh_plugin_packages"].(map[string]interface{}); ok {
			list, _ := inventory["packages"].([]interface{})
			for _, raw := range list {
				pkg := mapValue(raw)
				packages[fmt.Sprintf("%v@%v", pkg["name"], pkg["version"])] = true
			}
			row["dsh_plugin_packages"] = map[string]interface{}{"keys": dshSortedKeys(inventory), "version": inventory["version"], "packages": len(list)}
		}
		parts := map[string]string{}
		for _, field := range []string{"dsh_session_log", "dsh_plugin_packages"} {
			if value, ok := body[field]; ok {
				data, _ := json.Marshal(value)
				parts[field] = string(data)
			}
		}
		for _, field := range []string{"system", "messages", "tools"} {
			data, _ := json.Marshal(body[field])
			parts["modelInput."+field] = string(data)
		}
		// The request's own authentication header is where the key belongs; every other header is scanned.
		other := headers[i].Clone()
		other.Del("x-api-key")
		other.Del("authorization")
		headerText, _ := json.Marshal(other)
		parts["otherHeaders"] = string(headerText)
		for _, marker := range markers {
			for part, text := range parts {
				// JSON escapes path separators nowhere and quotes nothing in these markers, so a substring is exact.
				if strings.Contains(text, marker.value) {
					found[marker.name][part] = true
				}
			}
		}
		requests = append(requests, row)
	}
	var names []string
	for name := range packages {
		names = append(names, name)
	}
	sort.Strings(names)
	matrix := map[string][]string{}
	for name, parts := range found {
		matrix[name] = []string{}
		for part := range parts {
			matrix[name] = append(matrix[name], part)
		}
		sort.Strings(matrix[name])
	}
	paths := map[string][]string{}
	for typ, set := range eventPaths {
		for path, kind := range set {
			paths[typ] = append(paths[typ], path+": "+kind)
		}
		sort.Strings(paths[typ])
	}
	var header []string
	for path, kind := range headerPaths {
		header = append(header, path+": "+kind)
	}
	sort.Strings(header)
	return map[string]interface{}{"requests": requests, "eventTypes": eventTypes, "eventFieldPaths": paths, "sessionHeaderPaths": header,
		"pluginPackages": names, "markerFoundIn": matrix}
}

// TestDshRealSessionLogUpload records what the pinned official dsh sends beside the model input:
// once with the two upload rows stripped from Orbit's launch patch (Harness's shipped default) and
// once under Orbit's launch configuration unchanged. Each session holds a plain turn, a file read and
// write, and a command that prints the process environment.
func TestDshRealSessionLogUpload(t *testing.T) {
	for _, variant := range []struct {
		name     string
		upstream bool
	}{{"upstream-default", true}, {"orbit-default", false}} {
		t.Run(variant.name, func(t *testing.T) { dshRecordSessionLogUpload(t, variant.upstream) })
	}
}

func dshRecordSessionLogUpload(t *testing.T, upstream bool) {
	h := newDshRealHarness(t, "auto", true)
	const key, ambient = "sk-sl-synthetic-credential-5e1f", "sl-runner-ambient-secret-77c2"
	h.job.Agent.Env["ORBIT_DSH_API_KEY"], h.model.key = key, key
	t.Setenv("SL_RUNNER_SECRET", ambient)
	h.job.Agent.AppendSystemPrompt = "SL_SYSTEM_PROMPT_MARKER"
	var mu sync.Mutex
	var bodies []map[string]interface{}
	var headers []http.Header
	recorder := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		data, _ := io.ReadAll(r.Body)
		var body map[string]interface{}
		_ = json.Unmarshal(data, &body)
		mu.Lock()
		bodies, headers = append(bodies, body), append(headers, r.Header.Clone())
		mu.Unlock()
		r.Body = io.NopCloser(bytes.NewReader(data))
		h.model.serve(w, r)
	}))
	t.Cleanup(recorder.Close)
	h.job.Agent.Env["ORBIT_DSH_BASE_URL"] = recorder.URL
	if upstream {
		prepare := prepareDshSessionLaunch
		prepareDshSessionLaunch = func(ctx context.Context, job *ClaimedSession, execDir string) (DshLaunchSpec, error) {
			spec, err := prepare(ctx, job, execDir)
			if err != nil {
				return spec, err
			}
			path := filepath.Join(spec.DshHome, "orbit.patch.json")
			data, _ := os.ReadFile(path)
			var rows []map[string]interface{}
			_ = json.Unmarshal(data, &rows)
			kept := rows[:0]
			for _, row := range rows {
				if id := row["id"]; id != dshUploadRows[0] && id != dshUploadRows[1] {
					kept = append(kept, row)
				}
			}
			stripped, _ := json.Marshal(kept)
			return spec, os.WriteFile(path, stripped, 0o600)
		}
	}
	h.writeWorkspace("notes.txt", "SL_FILE_CONTENT_MARKER\n")
	written := filepath.Join(h.work, "out.txt")
	h.model.plans = []dshPlan{
		{text: "SL_ASSISTANT_MARKER plain answer"},
		{tool: "read", args: map[string]interface{}{"file_path": filepath.Join(h.work, "notes.txt")}},
		{tool: "write", args: map[string]interface{}{"file_path": written, "content": "SL_WRITE_CONTENT_MARKER\n"}},
		{text: "SL file turn answer"},
		{tool: "bash", args: map[string]interface{}{"command": "printf 'SL_BASH_OUTPUT_MARKER\\n'; env | sort", "description": "print the environment"}},
		{text: "SL bash turn answer"},
	}
	h.start()
	for _, turn := range []struct{ id, text string }{
		{"t1", "SL_USER_MARKER say hello"}, {"t2", "Read notes.txt and write out.txt."}, {"t3", "Print the environment."},
	} {
		h.send(turn.id, "message", turn.text)
		if done := h.settled(turn.id); done.Status != stSucceeded {
			t.Fatalf("turn %s = %+v", turn.id, done)
		}
	}
	if dshFileState(written) != "SL_WRITE_CONTENT_MARKER\n" {
		t.Fatalf("write tool left %q", dshFileState(written))
	}
	_, bash := h.toolResult("t3", "bash")
	bashSawKey := strings.Contains(firstString(bash, "content"), key)
	h.end()
	mu.Lock()
	defer mu.Unlock()
	markers := []dshUploadMarker{
		{"userMessage", "SL_USER_MARKER"}, {"assistantText", "SL_ASSISTANT_MARKER"}, {"orbitSystemPrompt", "SL_SYSTEM_PROMPT_MARKER"},
		{"fileContentRead", "SL_FILE_CONTENT_MARKER"}, {"fileContentWritten", "SL_WRITE_CONTENT_MARKER"}, {"bashOutput", "SL_BASH_OUTPUT_MARKER"},
		{"workspacePath", h.work}, {"dshHomePath", h.home}, {"runnerHome", userHome()}, {"apiKey", key}, {"runnerAmbientSecret", ambient},
	}
	report := dshRedactedUploads(bodies, headers, markers)
	carried := 0
	for _, body := range bodies {
		_, log := body["dsh_session_log"]
		_, inventory := body["dsh_plugin_packages"]
		if log || inventory {
			carried++
		}
	}
	// Harness keeps each session's canonical log zstd-compressed; count its acceptance marks.
	logs, _ := filepath.Glob(filepath.Join(h.home, "sessions", "*", "*", "session.v*.jsonl.zstd"))
	if len(logs) != 1 {
		t.Fatalf("found %d session logs in DSH_HOME, want 1", len(logs))
	}
	canonical, err := exec.Command(os.Getenv("P4_NODE_BIN"), "-e",
		"process.stdout.write(require('node:zlib').zstdDecompressSync(require('node:fs').readFileSync(process.argv[1])))", logs[0]).Output()
	if err != nil {
		t.Fatalf("decompress the session log: %v", err)
	}
	accepted := bytes.Count(canonical, []byte(`"session-log-deepseek/delivery-accepted"`))
	if len(bodies) < 6 {
		t.Fatalf("recorded %d model requests, want at least 6", len(bodies))
	}
	if upstream && carried != len(bodies) {
		t.Fatalf("Harness's shipped default sent the upload fields on %d of %d requests", carried, len(bodies))
	}
	if !upstream && (carried != 0 || accepted != 0) {
		t.Fatalf("Orbit's launch sent upload fields on %d requests and recorded %d acceptance marks", carried, accepted)
	}
	for _, part := range report["markerFoundIn"].(map[string][]string)["apiKey"] {
		if !upstream && !strings.HasPrefix(part, "modelInput.") {
			t.Fatalf("the API key reached %s", part)
		}
	}
	report["variant"] = map[bool]string{true: "upstream-default", false: "orbit-default"}[upstream]
	report["modelRequests"] = len(bodies)
	report["requestsCarryingUploadFields"] = carried
	report["deliveryAcceptedMarksInDshHome"] = accepted
	report["bashToolSawApiKey"] = bashSawKey
	t.Logf("variant=%s requests=%d carrying=%d accepted=%d bashSawKey=%v markers=%v", report["variant"], len(bodies), carried, accepted, bashSawKey, report["markerFoundIn"])
	if dir := os.Getenv("DSH_SESSION_LOG_EVIDENCE_DIR"); dir != "" {
		_ = os.MkdirAll(dir, 0o755)
		data, _ := json.MarshalIndent(report, "", "  ")
		if err := os.WriteFile(filepath.Join(dir, report["variant"].(string)+".json"), append(data, '\n'), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}
