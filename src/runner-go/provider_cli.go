package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"
)

// `orbit provider` — the CLI half of the MCP provider_* tools. `--provider` on a session or a
// task takes a built-in engine slug or one the owner configured, and a configured provider's slug
// is derived from its label rather than typed by anyone, so the only way to learn one used to be
// to guess and read the refusal back. `list` is that list.
//
// Plain runner auth, no orchestration gate: `orbit task create --provider` is available to every
// agent, so the discovery of what to pass has to be too. The writes ride the same auth and reach
// only the runner owner's own providers; from inside a session each first puts a confirmation card
// in front of the owner (askBeforeCreate), exactly as `orbit task create` does.

const providerHelp = `orbit provider — list and configure the providers a session or task may run on

Usage:
  orbit provider list [--json]
  orbit provider create --label LABEL --base-url URL (--api-key KEY | --api-key-file -) --models JSON [options]
  orbit provider update SLUG [options]
  orbit provider delete SLUG [--json]

Run 'orbit provider <command> --help' for options.
`

var providerActionHelp = map[string]string{
	"list": `orbit provider list — list the provider slugs this owner may dispatch with

Usage:
  orbit provider list [--json]

Reports every slug accepted by --provider on 'orbit session create', 'orbit task create'
and 'orbit task update': the built-in engines (builtin true), plus the providers configured
on the account, each with the runtime it borrows and the models it offers. A slug that is
not on this list is refused with "provider not available".
`,
	"create": `orbit provider create — configure a provider on this account, e.g. a self-hosted endpoint

Usage:
  orbit provider create --label LABEL --base-url URL (--api-key KEY | --api-key-file -) --models JSON [options]

Options:
  --label TEXT        (required) Display name. The slug sessions and tasks name it by is derived
                      from it — read it back from this command's output.
  --runtime NAME      The coding engine that drives it: claude (default; an endpoint serving the
                      Anthropic Messages API, e.g. vLLM's /v1/messages), codex (the OpenAI
                      Responses API) or kimi (Moonshot's API).
  --base-url URL      (required) The endpoint as that engine will call it. It is resolved on the
                      machine the session runs on: http://127.0.0.1:8000 is that runner's own port.
  --api-key KEY       The key the endpoint expects. An endpoint that checks none still needs a
                      non-empty placeholder.
  --api-key-file -    Read the key from stdin instead, keeping it out of argv and shell history.
  --models JSON       (required) The models it serves, as a JSON array:
                        [{"value":"<model id>","label":"<name>","contextWindow":<tokens>,
                          "reasoningLevels":["low","medium","xhigh"]}]
                      contextWindow reaches Claude Code as the model's real window, which it
                      otherwise assumes is 200k. reasoningLevels (claude runtime only) lists the
                      efforts the model accepts, of low, medium, high, xhigh and max: every
                      session's effort is moved onto the nearest of them (no effort counts as
                      high, the level Claude Code sends by default), and [] means the model takes
                      no effort at all. Omit it and effort is passed through unchanged.
  --default-model ID  The model a session that names none runs on; defaults to the first.
  --json

Inside a session this first puts the provider on a confirmation card in front of the account
owner — the key shown only as set — and writes nothing if they decline. The key is stored
encrypted and never returned: this command's output, like every read, reports only hasApiKey.
`,
	"update": `orbit provider update — change one of this account's own providers

Usage:
  orbit provider update SLUG [options]

Options:
  --label TEXT
  --runtime NAME      claude, codex or kimi
  --base-url URL
  --api-key KEY       Replace the stored key; omit to keep it.
  --api-key-file -    Read the replacement key from stdin.
  --models JSON       REPLACES the whole model list (same shape as on create).
  --default-model ID
  --json

SLUG is the one 'orbit provider list' shows. Only the account's own providers can be changed,
never a shared one. Inside a session the change is put on a confirmation card first, exactly as
a create is. A running session keeps the endpoint it was started with until it next restarts.
`,
	"delete": `orbit provider delete — remove one of this account's own providers

Usage:
  orbit provider delete SLUG [--json]

SLUG is the one 'orbit provider list' shows. New sessions and tasks can no longer name it, and
one already pinned to it runs on the built-in claude engine — the runner's own sign-in — the
next time it starts. Inside a session this is put on a confirmation card first.
`,
}

var providerCLICapabilities = []cliCapabilitySpec{
	{Tool: "provider_list", Argv: []string{"orbit", "provider", "list"}, Usage: "orbit provider list [--json]", Arguments: []string{"--json"}},
	{Tool: "provider_create", Argv: []string{"orbit", "provider", "create"}, Usage: "orbit provider create --label LABEL --base-url URL (--api-key KEY | --api-key-file -) --models JSON [options]", Arguments: []string{"--label <text> (required)", "--runtime <claude|codex|kimi>", "--base-url <url> (required; resolved on the runner the session runs on)", "--api-key <key> | --api-key-file - (required)", "--models <json array> (required; [{value,label,contextWindow?,reasoningLevels?}])", "--default-model <model id>", "--json"}, Mutates: true},
	{Tool: "provider_update", Argv: []string{"orbit", "provider", "update"}, Usage: "orbit provider update SLUG [options]", Arguments: []string{"[slug] (required)", "--label <text>", "--runtime <claude|codex|kimi>", "--base-url <url>", "--api-key <key> | --api-key-file -", "--models <json array> (replaces the list)", "--default-model <model id>", "--json"}, Mutates: true},
	{Tool: "provider_delete", Argv: []string{"orbit", "provider", "delete"}, Usage: "orbit provider delete SLUG [--json]", Arguments: []string{"[slug] (required)", "--json"}, Mutates: true},
}

func cmdProviderCLI(args []string, in io.Reader, out io.Writer) error {
	if len(args) == 0 || args[0] == "--help" || args[0] == "-h" {
		_, err := fmt.Fprint(out, providerHelp)
		return err
	}
	if args[0] == "help" {
		if len(args) == 1 {
			_, err := fmt.Fprint(out, providerHelp)
			return err
		}
		h, ok := providerActionHelp[args[1]]
		if !ok {
			return fmt.Errorf("unknown command %q", args[1])
		}
		_, err := fmt.Fprint(out, h)
		return err
	}
	action := args[0]
	h, known := providerActionHelp[action]
	if !known {
		return fmt.Errorf("unknown command %q\n\n%s", action, providerHelp)
	}
	if wantsHelp(args[1:]) {
		_, err := fmt.Fprint(out, h)
		return err
	}
	switch action {
	case "list":
		return cliProviderList(args[1:], out)
	case "create":
		return cliProviderCreate(args[1:], in, out)
	case "update":
		return cliProviderUpdate(args[1:], in, out)
	case "delete":
		return cliProviderDelete(args[1:], out)
	default:
		panic("unreachable provider command")
	}
}

func cliProviderList(args []string, out io.Writer) error {
	fs := newCLIFlagSet("orbit provider list")
	jsonOut := fs.Bool("json", false, "emit compact JSON")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if err := rejectTrailing(fs); err != nil {
		return err
	}
	t, err := cliTransport()
	if err != nil {
		return err
	}
	raw, err := t.listProviders()
	if err != nil {
		return fmt.Errorf("list providers: %w", err)
	}
	return writeCLIRawJSON(out, raw, *jsonOut)
}

// providerCLIWriteFlags are the provider fields create and update both take, in MCP's spelling
// once rendered by body().
type providerCLIWriteFlags struct {
	label        *string
	runtime      *string
	baseURL      *string
	apiKey       *string
	apiKeyFile   *string
	models       *string
	defaultModel *string
}

func registerProviderWriteFlags(fs *flag.FlagSet) *providerCLIWriteFlags {
	return &providerCLIWriteFlags{
		label:        fs.String("label", "", "display name; the slug is derived from it"),
		runtime:      fs.String("runtime", "", "claude, codex or kimi"),
		baseURL:      fs.String("base-url", "", "the endpoint, resolved on the runner the session runs on"),
		apiKey:       fs.String("api-key", "", "the key the endpoint expects"),
		apiKeyFile:   fs.String("api-key-file", "", "read the key from stdin (-)"),
		models:       fs.String("models", "", "JSON array of {value,label,contextWindow?,reasoningLevels?}"),
		defaultModel: fs.String("default-model", "", "the model a session that names none runs on"),
	}
}

// body renders the flags that were given. An empty value is refused rather than sent: the server
// takes whatever it receives, so a bare --base-url would point every session at nothing.
func (f *providerCLIWriteFlags) body(fs *flag.FlagSet, in io.Reader) (map[string]interface{}, error) {
	body := map[string]interface{}{}
	for flagName, field := range map[string]struct {
		key   string
		value *string
	}{
		"label":         {"label", f.label},
		"runtime":       {"runtime", f.runtime},
		"base-url":      {"baseUrl", f.baseURL},
		"default-model": {"defaultModel", f.defaultModel},
	} {
		if !flagWasSet(fs, flagName) {
			continue
		}
		if strings.TrimSpace(*field.value) == "" {
			return nil, fmt.Errorf("--%s cannot be empty", flagName)
		}
		body[field.key] = strings.TrimSpace(*field.value)
	}
	key, keySet, err := readCLIText(in, *f.apiKey, flagWasSet(fs, "api-key"), *f.apiKeyFile, flagWasSet(fs, "api-key-file"), "api-key")
	if err != nil {
		return nil, err
	}
	if keySet {
		// A key read from a file or a pipe usually ends in a newline no endpoint means.
		if key = strings.TrimSpace(key); key == "" {
			return nil, fmt.Errorf("--api-key cannot be empty")
		}
		body["apiKey"] = key
	}
	if flagWasSet(fs, "models") {
		var models []interface{}
		if err := json.Unmarshal([]byte(*f.models), &models); err != nil || len(models) == 0 {
			return nil, fmt.Errorf("--models must be a non-empty JSON array of {\"value\":\"<model id>\",\"label\":\"<name>\",...}")
		}
		body["models"] = models
	}
	return body, nil
}

// providerCard is the confirmation card a provider write puts in front of the owner: the body about
// to be sent, with the key reduced to the fact that one is being set. A card is stored, pushed to
// every client of the account and rendered as it stands, so the key itself is never on it.
func providerCard(slug string, body map[string]interface{}) map[string]interface{} {
	card := map[string]interface{}{}
	if slug != "" {
		card["slug"] = slug
	}
	for field, value := range body {
		if field == "apiKey" {
			card["apiKey"] = "(set — not shown)"
			continue
		}
		card[field] = value
	}
	return card
}

const (
	providerCreateApprovalToolName = "orbit_provider_create"
	providerUpdateApprovalToolName = "orbit_provider_update"
	providerDeleteApprovalToolName = "orbit_provider_delete"
)

func cliProviderCreate(args []string, in io.Reader, out io.Writer) error {
	fs := newCLIFlagSet("orbit provider create")
	fields := registerProviderWriteFlags(fs)
	jsonOut := fs.Bool("json", false, "emit compact JSON")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if err := rejectTrailing(fs); err != nil {
		return err
	}
	body, err := fields.body(fs, in)
	if err != nil {
		return err
	}
	for _, required := range []struct{ key, flag string }{
		{"label", "--label"}, {"baseUrl", "--base-url"}, {"apiKey", "--api-key or --api-key-file"}, {"models", "--models"},
	} {
		if _, ok := body[required.key]; !ok {
			return fmt.Errorf("%s is required", required.flag)
		}
	}
	t, err := cliTransport()
	if err != nil {
		return err
	}
	// The same card provider_create raises over MCP; headless there is no session and nobody to ask.
	sessionID := strings.TrimSpace(os.Getenv("ORBIT_SESSION_ID"))
	if declined, err := askBeforeCreate(t, sessionID, providerCreateApprovalToolName, providerCard("", body)); err != nil {
		return fmt.Errorf("create provider: %w", err)
	} else if declined != "" {
		return fmt.Errorf("create provider: the human rejected this provider: %s", declined)
	}
	raw, err := t.createProvider(body)
	if err != nil {
		return fmt.Errorf("create provider: %w", err)
	}
	return writeCLIRawJSON(out, raw, *jsonOut)
}

func cliProviderUpdate(args []string, in io.Reader, out io.Writer) error {
	slug, rest := peelLeadingID(args)
	fs := newCLIFlagSet("orbit provider update")
	fields := registerProviderWriteFlags(fs)
	jsonOut := fs.Bool("json", false, "emit compact JSON")
	if err := fs.Parse(rest); err != nil {
		return err
	}
	if err := rejectTrailing(fs); err != nil {
		return err
	}
	if slug == "" {
		return fmt.Errorf("provider slug is required")
	}
	body, err := fields.body(fs, in)
	if err != nil {
		return err
	}
	if len(body) == 0 {
		return fmt.Errorf("no fields to update")
	}
	t, err := cliTransport()
	if err != nil {
		return err
	}
	sessionID := strings.TrimSpace(os.Getenv("ORBIT_SESSION_ID"))
	if declined, err := askBeforeCreate(t, sessionID, providerUpdateApprovalToolName, providerCard(slug, body)); err != nil {
		return fmt.Errorf("update provider: %w", err)
	} else if declined != "" {
		return fmt.Errorf("update provider: the human rejected this change: %s", declined)
	}
	raw, err := t.updateProvider(slug, body)
	if err != nil {
		return fmt.Errorf("update provider: %w", err)
	}
	return writeCLIRawJSON(out, raw, *jsonOut)
}

func cliProviderDelete(args []string, out io.Writer) error {
	slug, rest := peelLeadingID(args)
	fs := newCLIFlagSet("orbit provider delete")
	jsonOut := fs.Bool("json", false, "emit compact JSON")
	if err := fs.Parse(rest); err != nil {
		return err
	}
	if err := rejectTrailing(fs); err != nil {
		return err
	}
	if slug == "" {
		return fmt.Errorf("provider slug is required")
	}
	t, err := cliTransport()
	if err != nil {
		return err
	}
	sessionID := strings.TrimSpace(os.Getenv("ORBIT_SESSION_ID"))
	if declined, err := askBeforeCreate(t, sessionID, providerDeleteApprovalToolName, providerCard(slug, nil)); err != nil {
		return fmt.Errorf("delete provider: %w", err)
	} else if declined != "" {
		return fmt.Errorf("delete provider: the human rejected this deletion: %s", declined)
	}
	raw, err := t.deleteProvider(slug)
	if err != nil {
		return fmt.Errorf("delete provider: %w", err)
	}
	return writeCLIRawJSON(out, raw, *jsonOut)
}
