package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
)

// DshLaunchInput is already-authorized dispatch data, never ambient provider credentials.
type DshLaunchInput struct {
	OrbitSessionID string
	ExecutionDir   string
	APIKey         string `json:"-"`
	BaseURL        string
	FileMode       string
}

// DshAgentOverlay is the agent configuration a session adds to the Harness defaults. A session
// launch always has one, a catalogue probe never: it is written beside the provider overlay and
// passed as a second --patch.
type DshAgentOverlay struct {
	// AppendSystemPrompt becomes one literal section after Harness's own system prompt. It is
	// never a template, a provider setting or a config key.
	AppendSystemPrompt string
}

func (i DshLaunchInput) String() string {
	return fmt.Sprintf("DeepSeek Harness input (session=%s, cwd=%s, policy=%s)", i.OrbitSessionID, i.ExecutionDir, i.FileMode)
}

func (i DshLaunchInput) GoString() string { return i.String() }

// Ordinary formatted diagnostics cannot accidentally print the launch environment.
func (s DshLaunchSpec) String() string {
	return fmt.Sprintf("DeepSeek Harness %s (cwd=%s, DSH_HOME=%s, config=%s)", s.Version, s.Cwd, s.DshHome, s.ConfigHash)
}

func (s DshLaunchSpec) GoString() string { return s.String() }

// The shared P0 launch type is also used by ACP; never serialize its credential environment.
func (s DshLaunchSpec) MarshalJSON() ([]byte, error) {
	return json.Marshal(map[string]interface{}{
		"Executable": s.Executable, "Args": s.Args, "Cwd": s.Cwd,
		"DshHome": s.DshHome, "Version": s.Version, "ConfigHash": s.ConfigHash,
	})
}

var dshConfigMu sync.Mutex
var dshSessionIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]*$`)

const dshMissingKeyMessage = "DSH_CREDENTIAL_MISSING: configure a DeepSeek Harness API key for this session; runner and workspace .env credentials are not used"

// PrepareDshSessionLaunch uses the same Agent.Env populated by encrypted provider dispatch.
func PrepareDshSessionLaunch(ctx context.Context, job *ClaimedSession, executionDir, fileMode string) (DshLaunchSpec, error) {
	return prepareDshLaunch(ctx, DshLaunchInput{
		OrbitSessionID: job.SessionID, ExecutionDir: executionDir,
		APIKey: job.Agent.Env["ORBIT_DSH_API_KEY"], BaseURL: job.Agent.Env["ORBIT_DSH_BASE_URL"], FileMode: fileMode,
	}, dshSessionAgentOverlay(job))
}

func PrepareDshLaunch(ctx context.Context, input DshLaunchInput) (DshLaunchSpec, error) {
	return prepareDshLaunch(ctx, input, nil)
}

func prepareDshLaunch(ctx context.Context, input DshLaunchInput, agent *DshAgentOverlay) (DshLaunchSpec, error) {
	if strings.TrimSpace(input.APIKey) == "" {
		return DshLaunchSpec{}, errors.New(dshMissingKeyMessage)
	}
	if msg := ensureEngine(ctx, providerDsh, func(string) {}); msg != "" {
		return DshLaunchSpec{}, errors.New(msg)
	}
	executable, err := dshExecutablePath()
	if err != nil {
		return DshLaunchSpec{}, err
	}
	return prepareDshAgentConfig(input, agent, executable)
}

func prepareDshConfig(input DshLaunchInput, executable string) (DshLaunchSpec, error) {
	return prepareDshAgentConfig(input, nil, executable)
}

func prepareDshAgentConfig(input DshLaunchInput, agent *DshAgentOverlay, executable string) (DshLaunchSpec, error) {
	if !dshSessionIDPattern.MatchString(input.OrbitSessionID) {
		return DshLaunchSpec{}, errors.New("DSH_CONFIG_CONFLICT: invalid Orbit session identity")
	}
	// This is durable engine state, outside runDir's disposable scratch files.
	root := filepath.Join(machineHome(), "dsh-sessions")
	if err := privateDshDir(root); err != nil {
		return DshLaunchSpec{}, errors.New("DSH_CONFIG_CONFLICT: session state root cannot be a symlink")
	}
	home := filepath.Join(root, decodeSessionID(input.OrbitSessionID))
	return prepareDshAgentConfigAt(input, agent, executable, home)
}

type dshConfigOwner struct {
	SessionID   string `json:"sessionId"`
	Cwd         string `json:"cwd"`
	Version     string `json:"version"`
	Schema      int    `json:"schema"`
	FileMode    string `json:"fileMode"`
	ConfigHash  string `json:"configHash"`
	ProfileHash string `json:"profileHash,omitempty"`
}

// prepareDshConfigAt also serves credentialless catalogue probes in brand-new temporary homes.
// Preparation only runs before spawn or after Dispose. Close/Dispose never delete this state.
func prepareDshConfigAt(input DshLaunchInput, executable, home string) (DshLaunchSpec, error) {
	return prepareDshAgentConfigAt(input, nil, executable, home)
}

func prepareDshAgentConfigAt(input DshLaunchInput, agent *DshAgentOverlay, executable, home string) (DshLaunchSpec, error) {
	if input.FileMode != "read-only" && input.FileMode != "workspace-write" {
		return DshLaunchSpec{}, errors.New("DSH_PERMISSION_UNSUPPORTED: explicitly choose a verified file policy")
	}
	if !filepath.IsAbs(executable) {
		return DshLaunchSpec{}, errors.New("DSH_VERSION_INCOMPATIBLE: runtime path must be absolute")
	}
	cwd, err := filepath.Abs(input.ExecutionDir)
	if err == nil {
		cwd, err = filepath.EvalSymlinks(cwd)
	}
	if err != nil {
		return DshLaunchSpec{}, errors.New("DSH_CONFIG_CONFLICT: execution directory is unavailable")
	}
	info, err := os.Stat(cwd)
	if err != nil || !info.IsDir() {
		return DshLaunchSpec{}, errors.New("DSH_CONFIG_CONFLICT: execution directory must be a directory")
	}
	baseURL := input.BaseURL
	if baseURL == "" {
		baseURL = "https://api.deepseek.com/anthropic"
	}
	u, err := url.Parse(baseURL)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return DshLaunchSpec{}, errors.New("DSH_CONFIG_INVALID: base URL must be HTTP(S) without embedded credentials, query or fragment")
	}
	home, err = filepath.Abs(home)
	if err != nil {
		return DshLaunchSpec{}, errors.New("DSH_CONFIG_CONFLICT: session home is unavailable")
	}
	dshConfigMu.Lock()
	defer dshConfigMu.Unlock()
	if err := privateDshDir(home); err != nil {
		return DshLaunchSpec{}, errors.New("DSH_CONFIG_CONFLICT: session directory must be private and cannot be a symlink")
	}
	owner := dshConfigOwner{SessionID: decodeSessionID(input.OrbitSessionID), Cwd: cwd, Version: dshSupportedVersion, Schema: 1, FileMode: input.FileMode}
	ownerPath := filepath.Join(home, "orbit-owner.json")
	if data, readErr := os.ReadFile(ownerPath); readErr == nil {
		var saved dshConfigOwner
		if json.Unmarshal(data, &saved) != nil || saved.SessionID != owner.SessionID || saved.Cwd != cwd || saved.Version != dshSupportedVersion || saved.Schema != owner.Schema {
			return DshLaunchSpec{}, errors.New("DSH_CONFIG_CONFLICT: saved session identity, workspace or runtime version differs; recovery data retained")
		}
		previousPatch, err := dshOverlayBytes(home)
		if err != nil || saved.ConfigHash != dshConfigurationHash(saved.FileMode, previousPatch) {
			return DshLaunchSpec{}, errors.New("DSH_CONFIG_CONFLICT: saved overlay hash differs; recovery data retained")
		}
		if saved.ProfileHash != "" {
			hash, err := dshProfileHash(home)
			if err != nil || hash != saved.ProfileHash {
				return DshLaunchSpec{}, errors.New("DSH_CONFIG_CONFLICT: saved ACP profile hash differs; recovery data retained")
			}
			owner.ProfileHash = saved.ProfileHash
		}
	} else if !os.IsNotExist(readErr) {
		return DshLaunchSpec{}, errors.New("DSH_CONFIG_CONFLICT: saved session identity cannot be read")
	} else {
		entries, readErr := os.ReadDir(home)
		if readErr != nil {
			return DshLaunchSpec{}, errors.New("DSH_CONFIG_CONFLICT: session home cannot be read")
		}
		if len(entries) != 0 {
			return DshLaunchSpec{}, errors.New("DSH_CONFIG_CONFLICT: unowned Harness data cannot be overwritten")
		}
	}
	for _, dir := range []string{filepath.Join(home, "profiles"), filepath.Join(home, "profiles", "acp")} {
		if err := privateDshDir(dir); err != nil {
			return DshLaunchSpec{}, errors.New("DSH_CONFIG_CONFLICT: session profile must be private and cannot be a symlink")
		}
	}
	patch, _ := json.Marshal([]interface{}{
		map[string]interface{}{"id": "llm-deepseek", "config": map[string]interface{}{
			"apiKeyEnv": "ORBIT_DSH_API_KEY", "baseURL": baseURL,
		}},
	})
	patchPath := filepath.Join(home, "orbit.patch.json")
	if err := writeDshConfigFile(patchPath, patch); err != nil {
		return DshLaunchSpec{}, errors.New("DSH_CONFIG_CONFLICT: cannot write private session overlay")
	}
	args := []string{"--profile", "acp", "--patch", patchPath}
	agentPath := filepath.Join(home, dshAgentPatchFile)
	if agent != nil {
		agentPatch, err := dshAgentOverlayPatch(home, *agent)
		if err == nil {
			err = writeDshConfigFile(agentPath, agentPatch)
		}
		if err != nil {
			return DshLaunchSpec{}, errors.New("DSH_CONFIG_CONFLICT: cannot write private agent overlay")
		}
		args = append(args, "--patch", agentPath)
	} else if err := os.Remove(agentPath); err != nil && !os.IsNotExist(err) {
		return DshLaunchSpec{}, errors.New("DSH_CONFIG_CONFLICT: cannot remove a stale agent overlay")
	}
	overlay, err := dshOverlayBytes(home)
	if err != nil {
		return DshLaunchSpec{}, errors.New("DSH_CONFIG_CONFLICT: cannot read back the session overlay")
	}
	owner.ConfigHash = dshConfigurationHash(input.FileMode, overlay)
	ownerData, _ := json.Marshal(owner)
	if err := writeDshConfigFile(ownerPath, ownerData); err != nil {
		return DshLaunchSpec{}, errors.New("DSH_CONFIG_CONFLICT: cannot persist session identity")
	}
	env := dshBaseEnv()
	// DSH_AGENTS_HOME keeps the runner user's ~/.agents skills out, as P2 keeps their profile out:
	// a session discovers its workspace's AGENTS.md and project skills only.
	env = append(env, "DSH_HOME="+home, "DSH_AGENTS_HOME="+filepath.Join(home, "agents"), "DSH_PERMISSION_MODE="+input.FileMode,
		"DSH_TELEMETRY_DISABLED=1", "ORBIT_DSH_API_KEY="+input.APIKey)
	return DshLaunchSpec{Executable: executable, Args: args,
		Env: env, Cwd: cwd, DshHome: home, Version: dshSupportedVersion, ConfigHash: owner.ConfigHash}, nil
}

const dshAgentPatchFile = "orbit-agent.patch.json"

// dshOverlayBytes is every Orbit overlay byte the hash covers, the agent overlay when present.
func dshOverlayBytes(home string) ([]byte, error) {
	patch, err := os.ReadFile(filepath.Join(home, "orbit.patch.json"))
	if err != nil {
		return nil, err
	}
	agent, err := os.ReadFile(filepath.Join(home, dshAgentPatchFile))
	if os.IsNotExist(err) {
		return patch, nil
	}
	if err != nil {
		return nil, err
	}
	return append(append(patch, '\n'), agent...), nil
}

// The additive system-prompt section, measured in P0 (literal-additive-system-prompt): it keeps
// Harness's identity and tool guidance and never interpolates the text it is given.
const dshAppendPromptPlugin = `// Orbit: one literal system-prompt section after DeepSeek Harness's own.
export const name = 'orbit-append-system-prompt';
export const inject = ['systemPrompt'];
export function apply(ctx, config) {
  ctx.systemPrompt.section({ name: 'orbit:append-system-prompt', order: 10201, text: config.text, interpolate: false });
}
`

// Tools whose work runs in a child agent. A child's escalation never reaches ACP and its tool
// calls are not projected (P4 evidence), so Orbit could neither ask about nor show them.
var dshDisabledAgentTools = []string{"tool-subagent", "tool-subagent-fork", "tool-subagent-control",
	"tool-subagent-list-agents", "tool-workflow"}

// dshAgentOverlayPatch writes the prompt plugin with its versioned manifest (dsh refuses a named
// package without a version) under a directory named for its code hash, and returns the patch.
func dshAgentOverlayPatch(home string, agent DshAgentOverlay) ([]byte, error) {
	rows := []interface{}{}
	for _, id := range dshDisabledAgentTools {
		rows = append(rows, map[string]interface{}{"id": id, "disabled": true})
	}
	if strings.TrimSpace(agent.AppendSystemPrompt) != "" {
		digest := sha256.Sum256([]byte(dshAppendPromptPlugin))
		dir := filepath.Join(home, "orbit-plugins", "append-system-prompt-"+hex.EncodeToString(digest[:6]))
		for _, path := range []string{filepath.Dir(dir), dir} {
			if err := privateDshDir(path); err != nil {
				return nil, err
			}
		}
		manifest, _ := json.Marshal(map[string]interface{}{"name": "orbit-dsh-append-system-prompt", "version": "1.0.0", "private": true, "type": "module"})
		if err := writeDshConfigFile(filepath.Join(dir, "package.json"), manifest); err != nil {
			return nil, err
		}
		entry := filepath.Join(dir, "index.mjs")
		if err := writeDshConfigFile(entry, []byte(dshAppendPromptPlugin)); err != nil {
			return nil, err
		}
		rows = append(rows, map[string]interface{}{"insert": []interface{}{map[string]interface{}{
			"id": "orbit-append-system-prompt", "name": (&url.URL{Scheme: "file", Path: entry}).String(),
			"config": map[string]interface{}{"text": agent.AppendSystemPrompt},
		}}})
	}
	return json.Marshal(rows)
}

// dshSessionAgentOverlay is the session's instructions in the order every runtime uses: the
// agent's own prompt, its appended prompt, then Orbit's CLI guidance.
func dshSessionAgentOverlay(job *ClaimedSession) *DshAgentOverlay {
	configured := strings.TrimSpace(strings.Join([]string{strings.TrimSpace(job.Agent.SystemPrompt), job.Agent.AppendSystemPrompt}, "\n\n"))
	return &DshAgentOverlay{AppendSystemPrompt: withOrbitCLIInstructions(configured, orbitCLIExecutable(), job.insideRecordedWork(), job.watchesOn())}
}

func dshConfigurationHash(fileMode string, patch []byte) string {
	digest := sha256.Sum256(append([]byte(dshSupportedVersion+"\nacp\n"+fileMode+"\n"), patch...))
	return hex.EncodeToString(digest[:])
}

// SealDshProfile records the files the pinned CLI generated, after initialize and
// before opening a session. Subsequent Prepare calls verify them before resume.
func SealDshProfile(spec DshLaunchSpec) error {
	dshConfigMu.Lock()
	defer dshConfigMu.Unlock()
	path := filepath.Join(spec.DshHome, "orbit-owner.json")
	data, err := os.ReadFile(path)
	var owner dshConfigOwner
	if err != nil || json.Unmarshal(data, &owner) != nil || owner.Cwd != spec.Cwd || owner.Version != spec.Version || owner.ConfigHash != spec.ConfigHash {
		return errors.New("DSH_CONFIG_CONFLICT: cannot seal another session configuration")
	}
	hash, err := dshProfileHash(spec.DshHome)
	if err != nil || (owner.ProfileHash != "" && owner.ProfileHash != hash) {
		return errors.New("DSH_CONFIG_CONFLICT: ACP profile changed; recovery data retained")
	}
	owner.ProfileHash = hash
	data, _ = json.Marshal(owner)
	return writeDshConfigFile(path, data)
}

func dshProfileHash(home string) (string, error) {
	profile := filepath.Join(home, "profiles", "acp")
	hash := sha256.New()
	for _, name := range []string{"package.json", "pnpm-workspace.yaml", "cordis.patch.yml", "cordis.yml"} {
		path := filepath.Join(profile, name)
		info, err := os.Lstat(path)
		if err != nil || !info.Mode().IsRegular() {
			return "", errors.New("ACP profile file missing or not regular")
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return "", err
		}
		fmt.Fprint(hash, name, "\x00", len(data), "\x00")
		hash.Write(data)
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

func privateDshDir(dir string) error {
	if err := os.MkdirAll(dir, machineHomePerm); err != nil {
		return err
	}
	info, err := os.Lstat(dir)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("invalid session directory")
	}
	return os.Chmod(dir, machineHomePerm)
}

func writeDshConfigFile(path string, data []byte) error {
	if info, err := os.Lstat(path); err == nil && !info.Mode().IsRegular() {
		return errors.New("invalid session file")
	} else if err != nil && !os.IsNotExist(err) {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".orbit-config-")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	_, writeErr := f.Write(data)
	closeErr := f.Close()
	if writeErr != nil {
		return writeErr
	}
	if closeErr != nil {
		return closeErr
	}
	return os.Rename(f.Name(), path)
}

// Keep HOME's real semantics; provider config, user profiles, NODE_OPTIONS and unrelated
// credentials are absent. A session's explicit key always wins, including an empty probe key.
func dshBaseEnv() []string {
	keys := []string{"USER", "LOGNAME", "LANG", "LC_ALL", "TERM", "TMPDIR",
		"HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy", "SSL_CERT_FILE", "SSL_CERT_DIR"}
	env := []string{"HOME=" + userHome(), "PATH=" + dshServicePath()}
	for _, key := range keys {
		if value, ok := os.LookupEnv(key); ok {
			env = append(env, key+"="+value)
		}
	}
	return env
}
