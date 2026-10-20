package main

// Cursor CLI's model catalogue (docs/cursor-runtime-contract.md §10).
//
// The catalogue is ACP's own: `cursor/list_available_models`, asked of an `agent acp` that declared
// the parameterized model picker, lists every model the account may use by its bare name — Auto is
// `default` — each with the parameters it takes: an effort, whose id is the model's own (`effort`,
// `reasoning_effort` or `reasoning`), a context size, a fast lane, thinking on or off. A session
// selects the model and each parameter with session/set_config_option by those values, which are
// opaque: none is rebuilt from a label or carried from one model to another. `agent models` names
// models another way and is not the catalogue (§10).
//
// The list comes from Cursor's servers and may differ by account (§10), so it is read with an
// account's credential — the Default account's here — in a throwaway home, and while that account is
// signed out there is none: ACP answers the request with "Authentication required". ACP reports no
// context window for any model (§4.1), so no window is reported and the context gauge reads
// unavailable rather than a number of Orbit's own.

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
	"unicode"
)

var errCursorSignedOut = errors.New("cursor catalogue: the Default account is signed out")

// cursorVariantParameters are the settings a session's model value carries beside the model's name, by
// Cursor's option ids (§10): the context size and the fast lane. The effort is the session's own field,
// and the mode is its permission mode's, so a model value names neither.
var cursorVariantParameters = []string{"context", "fast"}

// cursorModelSetting is one `id=value` a session's model value names.
type cursorModelSetting struct{ id, value string }

// decodeCursorModel reads a session's model value as shared's decodeCursorModel does
// (src/shared/src/cursorModels.ts): `name[id=value,…]`, with at least one setting, is the model `name` with
// those settings, written the way Cursor writes a variant (`claude-opus-5-5[context=1m,fast=true]`), and
// anything else is a model's name as it stands, naming no settings — `default[]` and every other empty
// `[]` among them, which reach the CLI unread, as they did before variants.
func decodeCursorModel(value string) (string, []cursorModelSetting) {
	text := strings.TrimSpace(value)
	open := strings.Index(text, "[")
	if open <= 0 || !strings.HasSuffix(text, "]") || strings.Index(text, "]") != len(text)-1 || strings.LastIndex(text, "[") != open {
		return text, nil
	}
	var settings []cursorModelSetting
	seen := map[string]bool{}
	for _, pair := range strings.Split(text[open+1:len(text)-1], ",") {
		id, setting, _ := strings.Cut(pair, "=")
		if !cursorSettingToken(id) || !cursorSettingToken(setting) || seen[id] {
			return text, nil
		}
		seen[id] = true
		settings = append(settings, cursorModelSetting{id: id, value: setting})
	}
	return text[:open], settings
}

// cursorSettingToken is one side of an `id=value`: something, and nothing the syntax is made of.
func cursorSettingToken(token string) bool {
	return token != "" && !strings.ContainsAny(token, "=,[]") && !strings.ContainsFunc(token, unicode.IsSpace)
}

// cursorParameterDefault is the value a model starts one of its settings on, as this runner's catalogue
// lists it (the CLI's own, read in a throwaway home), or "" while the catalogue has nothing to say: before
// its first read, or while the Default account is signed out.
func cursorParameterDefault(model, id string) string {
	modelWindowMu.RLock()
	catalog := modelWindows
	modelWindowMu.RUnlock()
	if catalog == nil {
		return ""
	}
	for _, info := range catalog.Cursor {
		if info.Value != model {
			continue
		}
		for _, parameter := range info.Parameters {
			if parameter.ID == id {
				return parameter.Default
			}
		}
	}
	return ""
}

type cursorCatalogModel struct {
	Value         string               `json:"value"`
	Name          string               `json:"name"`
	ConfigOptions []cursorConfigOption `json:"configOptions"`
}

type cursorConfigOption struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	Category     string `json:"category"`
	Type         string `json:"type"`
	CurrentValue string `json:"currentValue"`
	Options      []struct {
		Value string `json:"value"`
		Name  string `json:"name"`
	} `json:"options"`
}

// parseCursorModelCatalog reads a `cursor/list_available_models` result. Every parameter a model lists
// is kept, with its values and its default; the effort among them — its thought_level that is a scale
// rather than an on/off switch — is also the model's reasoning levels, where the pickers already show
// an effort beside a model.
func parseCursorModelCatalog(raw []byte) ([]ModelInfo, error) {
	var result struct {
		Models []cursorCatalogModel `json:"models"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		return nil, errors.New("cursor catalogue: the model list is not valid JSON")
	}
	var models []ModelInfo
	seen := map[string]bool{}
	for _, model := range result.Models {
		if strings.TrimSpace(model.Value) == "" || seen[model.Value] {
			continue
		}
		seen[model.Value] = true
		info := ModelInfo{Value: model.Value, Label: cursorLabel(model.Name, model.Value)}
		for _, option := range model.ConfigOptions {
			if option.Type != "select" || strings.TrimSpace(option.ID) == "" {
				continue
			}
			parameter := ModelParameter{ID: option.ID, Label: cursorLabel(option.Name, option.ID), Category: option.Category}
			for _, value := range option.Options {
				if strings.TrimSpace(value.Value) == "" {
					continue
				}
				parameter.Values = append(parameter.Values, ModelParameterValue{Value: value.Value, Label: cursorLabel(value.Name, value.Value)})
				if value.Value == option.CurrentValue {
					parameter.Default = option.CurrentValue
				}
			}
			if len(parameter.Values) == 0 {
				continue
			}
			info.Parameters = append(info.Parameters, parameter)
			if option.Category == "thought_level" && info.ReasoningLevels == nil && !cursorOnOff(parameter) {
				for _, value := range parameter.Values {
					info.ReasoningLevels = append(info.ReasoningLevels, value.Value)
				}
				info.DefaultReasoningLevel = parameter.Default
			}
		}
		models = append(models, info)
	}
	if len(models) == 0 {
		return nil, errors.New("cursor catalogue: the model list is empty")
	}
	return models, nil
}

// cursorOnOff is a parameter that switches something on or off — Claude models' `thinking` — rather
// than setting a level.
func cursorOnOff(parameter ModelParameter) bool {
	if len(parameter.Values) != 2 {
		return false
	}
	a, b := parameter.Values[0].Value, parameter.Values[1].Value
	return (a == "false" && b == "true") || (a == "true" && b == "false")
}

// cursorLabel is a display name as the CLI sent it, without the zero-width characters it pads some
// with ("Fast" and two U+200B), or fallback when it sent none.
func cursorLabel(name, fallback string) string {
	if label := strings.Trim(name, " \t\r\n\u200b\u200c\u200d\ufeff"); label != "" {
		return label
	}
	return fallback
}

func cursorCLIAvailable() bool {
	_, err := cursorExecutablePath()
	return err == nil
}

// fetchCursorModelCatalog reads the Default account's catalogue from the pinned build.
func fetchCursorModelCatalog(ctx context.Context) ([]ModelInfo, error) {
	exe, err := cursorExecutablePath()
	if err != nil {
		return nil, err
	}
	token, err := cursorStoredLogin(cursorDefaultAccountDir())
	if err != nil {
		return nil, err
	}
	if token == "" || cursorTokenExpired(token, time.Now()) {
		return nil, errCursorSignedOut
	}
	return fetchCursorModelCatalogWith(ctx, exe, "CURSOR_AUTH_TOKEN="+token)
}

// stopCursorProcess ends an `agent acp` the runner started, which does not exit when its stdin closes
// (§3.4): SIGTERM first, which it handles by exiting — and so by deleting the in-use marker it keeps in
// its version directory while it runs (<version>/.running/<pid>, measured on the pinned build) — and
// after a grace period cancel, which kills it and everything it started.
func stopCursorProcess(cmd *exec.Cmd, cancel context.CancelFunc) {
	_ = cmd.Process.Signal(syscall.SIGTERM)
	exited := make(chan struct{})
	go func() {
		_ = waitSessionProcessTree(cmd)
		close(exited)
	}()
	select {
	case <-exited:
	case <-time.After(5 * time.Second):
		cancel()
		<-exited
	}
}

// fetchCursorModelCatalogWith starts `agent acp` with credential (KEY=value) in a throwaway home,
// initializes it with the parameterized model picker, asks for the catalogue and ends the process
// (stopCursorProcess).
func fetchCursorModelCatalogWith(ctx context.Context, exe, credential string) (models []ModelInfo, resultErr error) {
	root, err := newCursorProbeRoot("orbit-cursor-catalog-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(root)
	workspace := filepath.Join(root, "workspace")
	if err := os.Mkdir(workspace, machineHomePerm); err != nil {
		return nil, err
	}
	cctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	cmd := exec.CommandContext(cctx, exe, cursorACPArgs()...)
	configureSessionProcessTree(cmd)
	cmd.Dir = workspace
	cmd.Env = append(cursorProbeEnv(root), credential)
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
		return nil, fmt.Errorf("cursor catalogue: starting the CLI failed: %w", err)
	}
	defer func() {
		_ = stdin.Close()
		stopCursorProcess(cmd, cancel)
	}()
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 64*1024), 16*1024*1024)
	encoder := json.NewEncoder(stdin)
	call := func(id int, method string, params interface{}) (json.RawMessage, error) {
		if err := encoder.Encode(map[string]interface{}{"jsonrpc": "2.0", "id": id, "method": method, "params": params}); err != nil {
			return nil, fmt.Errorf("cursor catalogue: writing %s failed: %w", method, err)
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
				return nil, errors.New("cursor catalogue: the CLI wrote something that is not JSON-RPC")
			}
			if message.Method != "" {
				if len(message.ID) != 0 {
					return nil, fmt.Errorf("cursor catalogue: the CLI sent an unexpected request (%s)", message.Method)
				}
				continue // a notification: available commands, say
			}
			if string(message.ID) != fmt.Sprint(id) {
				return nil, errors.New("cursor catalogue: the CLI answered a request that was not made")
			}
			if message.Error != nil {
				if message.Error.Code == -32000 {
					return nil, errCursorSignedOut
				}
				return nil, fmt.Errorf("cursor catalogue: %s failed (%d %s)", method, message.Error.Code, firstLine(message.Error.Message))
			}
			if len(message.Result) == 0 {
				return nil, fmt.Errorf("cursor catalogue: %s returned no result", method)
			}
			return message.Result, nil
		}
		if err := cctx.Err(); err != nil {
			return nil, fmt.Errorf("cursor catalogue: %w", err)
		}
		return nil, fmt.Errorf("cursor catalogue: the CLI exited before answering %s", method)
	}
	initialized, err := call(1, "initialize", cursorInitializeParams())
	if err != nil {
		return nil, err
	}
	var handshake struct {
		ProtocolVersion int `json:"protocolVersion"`
	}
	if json.Unmarshal(initialized, &handshake) != nil || handshake.ProtocolVersion != 1 {
		return nil, errors.New("cursor catalogue: the CLI speaks another ACP protocol version")
	}
	listed, err := call(2, "cursor/list_available_models", map[string]interface{}{})
	if err != nil {
		return nil, err
	}
	return parseCursorModelCatalog(listed)
}

// cursorInitializeParams is the initialize request the contract settled on (§2.2): no client
// filesystem or terminal, which the CLI never calls anyway, subagents announced, and the
// parameterized model picker, which lists a model's parameters beside its bare name.
func cursorInitializeParams() map[string]interface{} {
	return map[string]interface{}{
		"protocolVersion": 1,
		"clientCapabilities": map[string]interface{}{
			"fs":       map[string]interface{}{"readTextFile": false, "writeTextFile": false},
			"terminal": false,
			"_meta":    map[string]interface{}{"subagents": true, "parameterizedModelPicker": true},
		},
		"clientInfo": map[string]interface{}{"name": "orbit", "version": version},
	}
}
