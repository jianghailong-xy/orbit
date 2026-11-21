package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
)

// Settings from a conversation (docs/settings-from-conversation-design.md §7): settings_get reads the account owner's
// preferences a session may propose a change to, and settings_propose files the change as a SETTINGS_CHANGE card the
// owner answers. The agent's credential never writes a preference: only the owner's Save changes on the card does.
// `orbit settings get|propose` run the same runSettingsTool, so the two doors are one implementation.
//
// Both tools are listed whether or not Session orchestration is on (gateAlways): they fix ordinary settings, and
// turning orchestration off is itself a valid proposal. Both act for the session they run in, so the CLI commands are
// SessionOnly: a terminal outside a session has no conversation to put a card in.

// settingsToolNames is the set callSettingsTool answers for.
var settingsToolNames = map[string]bool{"settings_get": true, "settings_propose": true}

// settingsTierThreeKeys are the agent-reach keys (src/shared/src/settingsTiers.ts, tier 3), named in settings_propose's
// description because only their narrowing direction may be proposed. TestSettingsTierThreeKeysAreTheSharedTable holds
// this list to the shared table.
var settingsTierThreeKeys = []string{"enableOrchestration", "defaultPermissionMode", "subagentBlockedProviders", "cardFreeTaskCreates"}

const settingsGetDescription = "Read the account owner's own Settings that this conversation can propose a change to: " +
	"every key with its value in force, its tier, and the title, page (path) and orbit-settings: link of its Settings " +
	"row. Tier 1 is personal (theme, translation, notifications and the like); tier 2 is defaults for new work, which " +
	"apply to new sessions only; tier 3 is agent reach, of which only the direction that gives agents less reach can " +
	"be proposed. Reads only. Call it before settings_propose, to see what is already set and what the key is called."

func settingsProposeDescription() string {
	return "When a person's problem is one of their own Settings, propose the change here instead of describing where " +
		"the row is. Orbit files a card in front of the account owner with each setting's current and new value, and " +
		"writes nothing until the owner presses Save changes on it: no session can apply its own card. This call " +
		"does NOT block: it returns at once with the request (ok: true, outcome: written, its id and status PENDING), " +
		"as request_owner_action does, and the owner's answer arrives later as a turn in this conversation. A new " +
		"proposal from this session withdraws its card still waiting. Tiers (settings_get lists every key with its " +
		"tier): 1 personal and 2 defaults for new work (applies to new sessions only) can be proposed in either " +
		"direction; 3 agent reach (" + strings.Join(settingsTierThreeKeys, ", ") + ") only in the direction that " +
		"gives agents less reach. Each refusal files nothing: SETTING_OWNER_ONLY (403) when a change would give " +
		"agents more reach, which only the owner makes, so put the link it returns in your reply as " +
		"[title](orbit-settings:key) for them to open; SETTINGS_ALREADY_SET (409) when every change is already in " +
		"force; SETTINGS_CHANGE_DECLINED (409) when the owner declined this same change from this session. A declined " +
		"card is a refusal: do not file it again, ask the person instead."
}

func settingsToolDescriptors(obj func(map[string]interface{}, ...string) map[string]interface{}) []map[string]interface{} {
	return []map[string]interface{}{
		{
			"name":        "settings_get",
			"description": settingsGetDescription,
			"inputSchema": obj(map[string]interface{}{}),
		},
		{
			"name":        "settings_propose",
			"description": settingsProposeDescription(),
			"inputSchema": obj(map[string]interface{}{
				"changes": map[string]interface{}{
					"type": "object",
					"description": "The settings to change: each key as settings_get names it, with the value it " +
						"should become, typed as settings_get shows it (true, \"zh-Hans\", 3, [\"codex\"]). A key " +
						"settings_get does not list cannot be proposed.",
				},
				"why": map[string]interface{}{
					"type":        "string",
					"description": "What the person asked for, in a sentence. The card shows it as your words.",
				},
			}, "changes", "why"),
		},
	}
}

// callSettingsTool runs one settings tool for the session this server runs in, and reports whether it handled the name.
func (s *mcpServer) callSettingsTool(name string, args map[string]interface{}) (map[string]interface{}, bool) {
	if !settingsToolNames[name] {
		return nil, false
	}
	raw, err := runSettingsTool(s.t, strings.TrimSpace(s.sessionID), name, args)
	if err != nil {
		return toolResult(err.Error(), true), true
	}
	if name == "settings_propose" {
		return toolResult("The proposal is with the account owner. Their answer will arrive as a turn in this "+
			"conversation; nothing is waiting on this call.\n"+prettyJSON(raw), false), true
	}
	return toolResult(prettyJSON(raw), false), true
}

// runSettingsTool is one call of a settings tool, from either door.
func runSettingsTool(t *Transport, sessionID, name string, args map[string]interface{}) (json.RawMessage, error) {
	if sessionID == "" {
		return nil, fmt.Errorf("%s acts for the session it runs in, and there is no Orbit session here (ORBIT_SESSION_ID)", name)
	}
	switch name {
	case "settings_get":
		raw, err := t.getSettings(sessionID)
		if err != nil {
			return nil, fmt.Errorf("settings get failed: %w", err)
		}
		return raw, nil
	case "settings_propose":
		changes, _ := args["changes"].(map[string]interface{})
		if len(changes) == 0 {
			return nil, errors.New("changes is required: name at least one setting and the value it should become")
		}
		why := strings.TrimSpace(getString(args, "why"))
		if why == "" {
			return nil, errors.New("why is required: say what the person asked for")
		}
		raw, err := t.proposeSettings(sessionID, map[string]interface{}{"changes": changes, "why": why})
		if err != nil {
			return nil, fmt.Errorf("settings propose failed: %w", err)
		}
		return raw, nil
	default:
		return nil, fmt.Errorf("unknown settings tool %q", name)
	}
}

// getSettings reads the session owner's preferences a conversation can propose a change to, with their tiers and
// Settings rows (GET /runner/settings).
func (t *Transport) getSettings(sessionID string) (json.RawMessage, error) {
	var out json.RawMessage
	err := t.doHeaders(nil, "GET", "/runner/settings", nil, &out, taskOpTimeout, sessionHeader(sessionID))
	return out, err
}

// proposeSettings files a SETTINGS_CHANGE card for the owner to answer, and returns at once with the request
// (POST /runner/settings-proposals). The session header names who is proposing.
func (t *Transport) proposeSettings(sessionID string, body map[string]interface{}) (json.RawMessage, error) {
	var out json.RawMessage
	err := t.doHeaders(nil, "POST", "/runner/settings-proposals", body, &out, taskOpTimeout, sessionHeader(sessionID))
	return out, err
}

// settingsCLICapabilities are `orbit settings`: ungated like the tools, and SessionOnly, since both act for the session
// they run in.
var settingsCLICapabilities = []cliCapabilitySpec{
	{
		Tool:        "settings_get",
		Argv:        []string{"orbit", "settings", "get"},
		Usage:       "orbit settings get [--json]",
		Arguments:   []string{"--json"},
		SessionOnly: true,
	},
	{
		Tool:        "settings_propose",
		Argv:        []string{"orbit", "settings", "propose"},
		Usage:       "orbit settings propose --set KEY=VALUE [--set KEY=VALUE ...] --why TEXT [--json]",
		Arguments:   []string{"--set <key=value> (changes: one setting each; required, repeatable; the value is read as JSON when it parses as JSON, else as a string)", "--why <text> (required; shown to the owner on the card)", "--json"},
		Mutates:     true,
		SessionOnly: true,
	},
}

const settingsHelp = `orbit settings — read the owner's Settings, and propose a change to them

Usage:
  orbit settings get [--json]
  orbit settings propose --set KEY=VALUE [--set KEY=VALUE ...] --why TEXT [--json]

When a person's problem is one of their own Settings, read them with get, then propose the
change: the owner sees a card with each setting's current and new value, and nothing is
written until they press Save changes. Both act for the session they run in (ORBIT_SESSION_ID).
Run 'orbit settings <command> --help' for options.
`

var settingsActionHelp = map[string]string{
	"get": `orbit settings get — the owner's Settings a conversation can propose a change to

Usage:
  orbit settings get [--json]

Lists every key with its value in force, its tier, and the title, page and orbit-settings:
link of its Settings row. Tier 1 is personal; tier 2 is defaults for new work, which apply
to new sessions only; tier 3 is agent reach, of which only the direction that gives agents
less reach can be proposed. Reads only.
`,
	"propose": `orbit settings propose — ask the owner to change their Settings

Usage:
  orbit settings propose --set KEY=VALUE [--set KEY=VALUE ...] --why TEXT [--json]

Options:
  --set KEY=VALUE   A setting and the value it should become, as 'orbit settings get' names
                    it. Repeatable. VALUE is read as JSON when it parses as JSON (true, 3,
                    ["codex"]), and as a string otherwise (zh-Hans)
  --why TEXT        What the person asked for. Required; the card shows it as your words
  --json

Files a card in front of the account owner and returns at once with the request, status
PENDING; their answer arrives later as a turn in this session. A new proposal from this
session withdraws its card still waiting. Each refusal files nothing:
  SETTING_OWNER_ONLY        a change gives agents more reach (tier 3); only the owner makes
                            it, so link the row it names, [title](orbit-settings:key)
  SETTINGS_ALREADY_SET      every change is already in force
  SETTINGS_CHANGE_DECLINED  the owner declined this same change from this session. A declined
                            card is a refusal: do not file it again, ask the person instead
`,
}

// settingFlag collects --set KEY=VALUE pairs in order, each value kept whole (a JSON array has commas in it).
type settingFlag []string

func (f *settingFlag) String() string { return strings.Join(*f, " ") }

func (f *settingFlag) Set(value string) error {
	*f = append(*f, value)
	return nil
}

// parseSettingChanges reads --set pairs into the changes a proposal sends: a value that parses as JSON is that value,
// anything else is a string. A key named twice is refused rather than letting the last one win silently.
func parseSettingChanges(pairs []string) (map[string]interface{}, error) {
	changes := make(map[string]interface{}, len(pairs))
	for _, pair := range pairs {
		key, raw, ok := strings.Cut(pair, "=")
		key = strings.TrimSpace(key)
		if !ok || key == "" {
			return nil, fmt.Errorf("--set takes KEY=VALUE, got %q", pair)
		}
		if _, twice := changes[key]; twice {
			return nil, fmt.Errorf("--set names %s twice", key)
		}
		var value interface{}
		if err := json.Unmarshal([]byte(raw), &value); err != nil {
			value = raw
		}
		changes[key] = value
	}
	return changes, nil
}

func cmdSettingsCLI(args []string, out io.Writer) error {
	if len(args) == 0 || args[0] == "--help" || args[0] == "-h" {
		_, err := fmt.Fprint(out, settingsHelp)
		return err
	}
	if args[0] == "help" {
		if len(args) == 1 {
			_, err := fmt.Fprint(out, settingsHelp)
			return err
		}
		h, ok := settingsActionHelp[args[1]]
		if !ok {
			return fmt.Errorf("unknown command %q", args[1])
		}
		_, err := fmt.Fprint(out, h)
		return err
	}
	action := args[0]
	h, known := settingsActionHelp[action]
	if !known {
		return fmt.Errorf("unknown command %q\n\n%s", action, settingsHelp)
	}
	if wantsHelp(args[1:]) {
		_, err := fmt.Fprint(out, h)
		return err
	}
	fs := newCLIFlagSet("orbit settings " + action)
	jsonOut := fs.Bool("json", false, "emit compact JSON")
	var sets settingFlag
	var why *string
	if action == "propose" {
		fs.Var(&sets, "set", "a setting and its new value, KEY=VALUE (repeatable)")
		why = fs.String("why", "", "what the person asked for")
	}
	if err := fs.Parse(args[1:]); err != nil {
		return err
	}
	if err := rejectTrailing(fs); err != nil {
		return err
	}
	toolArgs := map[string]interface{}{}
	tool := "settings_" + action
	if action == "propose" {
		if len(sets) == 0 {
			return errors.New("--set KEY=VALUE is required")
		}
		changes, err := parseSettingChanges(sets)
		if err != nil {
			return err
		}
		if strings.TrimSpace(*why) == "" {
			return errors.New("--why is required")
		}
		toolArgs["changes"], toolArgs["why"] = changes, *why
	}
	t, err := cliTransport()
	if err != nil {
		return err
	}
	raw, err := runSettingsTool(t, strings.TrimSpace(os.Getenv("ORBIT_SESSION_ID")), tool, toolArgs)
	if err != nil {
		return err
	}
	return writeCLIRawJSON(out, raw, *jsonOut)
}
