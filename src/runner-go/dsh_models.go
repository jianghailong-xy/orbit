package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

type dshConfigOption struct {
	ID           string            `json:"id"`
	Type         string            `json:"type"`
	CurrentValue string            `json:"currentValue"`
	Options      []dshSelectOption `json:"options"`
}

type dshSelectOption struct {
	Value   string            `json:"value"`
	Name    string            `json:"name"`
	Options []dshSelectOption `json:"options"`
}

func dshOptionLeaves(options []dshSelectOption) []dshSelectOption {
	var leaves []dshSelectOption
	for _, option := range options {
		if len(option.Options) != 0 {
			leaves = append(leaves, dshOptionLeaves(option.Options)...)
		} else if strings.TrimSpace(option.Value) != "" {
			leaves = append(leaves, option)
		}
	}
	return leaves
}

// parseDshModelCatalog consumes a complete session/new or resume result. Values
// are opaque ACP tokens, including whitespace and JSON strings; labels cannot be
// used to reconstruct them. ACP supplies no context window in this directory.
func parseDshModelCatalog(out []byte) ([]ModelInfo, error) {
	var result struct {
		ConfigOptions []dshConfigOption `json:"configOptions"`
	}
	if err := json.Unmarshal(out, &result); err != nil {
		return nil, fmt.Errorf("dsh model directory is invalid JSON")
	}
	var models []ModelInfo
	var levels []string
	var defaultLevel string
	for _, option := range result.ConfigOptions {
		if option.Type != "select" {
			continue
		}
		switch option.ID {
		case "model":
			for _, entry := range dshOptionLeaves(option.Options) {
				label := strings.TrimSpace(entry.Name)
				if label == "" {
					label = entry.Value
				}
				models = append(models, ModelInfo{Value: entry.Value, Label: label})
			}
		case "reasoning_effort":
			for _, entry := range dshOptionLeaves(option.Options) {
				levels = append(levels, entry.Value)
				if entry.Value == option.CurrentValue {
					defaultLevel = entry.Value
				}
			}
		}
	}
	if len(models) == 0 {
		return nil, fmt.Errorf("dsh model directory reported no models")
	}
	for i := range models {
		models[i].ReasoningLevels = append([]string(nil), levels...)
		models[i].DefaultReasoningLevel = defaultLevel
	}
	return models, nil
}

func dshCLIAvailable() bool {
	_, err := dshExecutablePath()
	return err == nil
}

func fetchDshModelCatalog(ctx context.Context) ([]ModelInfo, error) {
	executable, err := dshExecutablePath()
	if err != nil {
		noteDshCatalogRead(false)
		return nil, err
	}
	return fetchDshModelCatalogWithExecutable(ctx, executable)
}

// The catalogue needs no key. It is read in a disposable private DSH_HOME so the
// probe cannot change the user's profile or add sessions to a recoverable home.
func fetchDshModelCatalogWithExecutable(ctx context.Context, executable string) (models []ModelInfo, resultErr error) {
	noteDshCatalogRead(false)
	probeRoot, err := os.MkdirTemp("", "orbit-dsh-catalog-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(probeRoot)
	workspace := filepath.Join(probeRoot, "workspace")
	if err := os.Mkdir(workspace, 0700); err != nil {
		return nil, err
	}
	spec, err := prepareDshConfigAt(DshLaunchInput{
		OrbitSessionID: "catalog-probe", ExecutionDir: workspace, FileMode: "read-only",
	}, executable, filepath.Join(probeRoot, "home"))
	if err != nil {
		return nil, err
	}
	cctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	cmd := exec.CommandContext(cctx, spec.Executable, spec.Args...)
	configureSessionProcessTree(cmd)
	cmd.Dir, cmd.Env = spec.Cwd, spec.Env
	diagnostics := &dshProbeDiagnostics{}
	cmd.Stderr = diagnostics
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		_ = stdin.Close()
		return nil, err
	}
	if err := startSessionProcess(cmd); err != nil {
		_ = stdin.Close()
		_ = stdout.Close()
		return nil, fmt.Errorf("dsh catalogue start: %w", err)
	}
	defer func() {
		_ = stdin.Close()
		if resultErr != nil {
			cancel()
		} else {
			_, _ = io.Copy(io.Discard, stdout)
		}
		if err := waitSessionProcessTree(cmd); resultErr == nil && err != nil {
			models, resultErr = nil, fmt.Errorf("dsh catalogue exit: %w", err)
		}
		if resultErr == nil && dshCatalogDiagnostic(diagnostics.text) == "DSH_SANDBOX_UNAVAILABLE" {
			models, resultErr = nil, fmt.Errorf("dsh catalogue initialization failed")
		}
		if resultErr != nil && diagnostics.text != "" {
			resultErr = fmt.Errorf("%s: %s", resultErr, dshCatalogDiagnostic(diagnostics.text))
		}
		noteDshCatalogRead(resultErr == nil)
	}()
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 64*1024), 4*1024*1024)
	encoder := json.NewEncoder(stdin)
	request := func(id int, method string, params interface{}) (json.RawMessage, error) {
		if err := encoder.Encode(map[string]interface{}{"jsonrpc": "2.0", "id": id, "method": method, "params": params}); err != nil {
			return nil, fmt.Errorf("dsh catalogue write: %w", err)
		}
		for scanner.Scan() {
			var message struct {
				JSONRPC string          `json:"jsonrpc"`
				ID      json.RawMessage `json:"id"`
				Method  string          `json:"method"`
				Result  json.RawMessage `json:"result"`
				Error   *struct {
					Code    int    `json:"code"`
					Message string `json:"message"`
				} `json:"error"`
			}
			if err := json.Unmarshal(scanner.Bytes(), &message); err != nil || message.JSONRPC != "2.0" {
				return nil, fmt.Errorf("dsh catalogue received invalid ACP output")
			}
			if message.Method != "" {
				if len(message.ID) != 0 {
					return nil, fmt.Errorf("dsh catalogue received an unexpected server request")
				}
				continue
			}
			if string(message.ID) != fmt.Sprint(id) {
				return nil, fmt.Errorf("dsh catalogue received an unexpected response id")
			}
			if message.Error != nil {
				return nil, fmt.Errorf("dsh %s (%d): %s", method, message.Error.Code, dshCatalogDiagnostic(message.Error.Message))
			}
			if len(message.Result) == 0 {
				return nil, fmt.Errorf("dsh %s returned no result", method)
			}
			return message.Result, nil
		}
		if err := cctx.Err(); err != nil {
			return nil, fmt.Errorf("dsh catalogue: %w", err)
		}
		return nil, fmt.Errorf("dsh catalogue closed before %s response", method)
	}
	initialized, err := request(1, "initialize", map[string]interface{}{"protocolVersion": 1, "clientCapabilities": map[string]interface{}{}})
	if err != nil {
		return nil, err
	}
	var init struct {
		ProtocolVersion int `json:"protocolVersion"`
	}
	if json.Unmarshal(initialized, &init) != nil || init.ProtocolVersion != 1 {
		return nil, fmt.Errorf("dsh catalogue ACP protocol version is incompatible")
	}
	opened, err := request(2, "session/new", map[string]interface{}{"cwd": spec.Cwd, "mcpServers": []interface{}{}})
	if err != nil {
		return nil, err
	}
	var session struct {
		SessionID string `json:"sessionId"`
	}
	if json.Unmarshal(opened, &session) != nil || session.SessionID == "" {
		return nil, fmt.Errorf("dsh catalogue session/new returned no session id")
	}
	models, err = parseDshModelCatalog(opened)
	if err != nil {
		return nil, err
	}
	if _, err := request(3, "session/close", map[string]interface{}{"sessionId": session.SessionID}); err != nil {
		return nil, err
	}
	return models, nil
}

// Keep startup diagnostics bounded even if a broken CLI writes indefinitely.
type dshProbeDiagnostics struct{ text string }

func dshCatalogDiagnostic(message string) string {
	lower := strings.ToLower(message)
	if strings.Contains(lower, "sandbox_unavailable") || strings.Contains(lower, "sandbox unavailable") {
		return "DSH_SANDBOX_UNAVAILABLE"
	}
	_, diagnostic := dshRequestValidation(fmt.Errorf("%s", message), false, "")
	if diagnostic == "DSH_REQUEST_FAILED" {
		return "DSH_CATALOG_STARTUP_FAILED"
	}
	return diagnostic
}

func (d *dshProbeDiagnostics) Write(p []byte) (int, error) {
	if remaining := 8192 - len(d.text); remaining > 0 {
		if remaining > len(p) {
			remaining = len(p)
		}
		d.text += string(p[:remaining])
	}
	return len(p), nil
}
