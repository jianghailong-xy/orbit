package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// slashRegistry caches the slash names each runtime itself registers. Claude learns them
// from its `system`/`init` message; Kimi learns them from ACP's
// `available_commands_update` notification.
//
// The on-disk scan (claude_assets.go) only knows `.claude/commands/*.md` and
// `.claude/skills/<name>/SKILL.md`, so it can't see built-in skills (/loop, /review, …),
// plugin skills, or namespaced commands (`commands/<ns>/<x>.md` → `/ns:x`) — and a composer
// that gates sending on that scan rejects every one of them as "Unsupported slash command".
// The CLI's own handshake is the authority: remember what it reports and put the names the
// scan missed on the heartbeat, so the composer stops blocking commands that do exist.
//
// The set is persisted under ~/.orbit so a restart doesn't blank it until the first session
// boots. A stale entry (skill deleted, CLI downgraded) only costs a pass-through — the CLI
// answers "Unknown command: /x" in zero turns.
type slashRegistry struct {
	mu           sync.Mutex
	commands     map[string]bool
	skills       map[string]bool
	kimiCommands map[string]bool
	kimiSkills   map[string]bool
	path         string
}

var slashReg = newSlashRegistry(filepath.Join(machineHome(), "slash-registry.json"))

func newSlashRegistry(path string) *slashRegistry {
	r := &slashRegistry{
		commands: map[string]bool{}, skills: map[string]bool{},
		kimiCommands: map[string]bool{}, kimiSkills: map[string]bool{}, path: path,
	}
	r.load()
	return r
}

type slashRegistryFile struct {
	Commands     []string `json:"commands"`
	Skills       []string `json:"skills"`
	KimiCommands []string `json:"kimiCommands,omitempty"`
	KimiSkills   []string `json:"kimiSkills,omitempty"`
}

// learn records one CLI init handshake, returning whether anything was new. Names accumulate
// across sessions: each session's list is scoped to its own cwd, so the union is what this
// machine can invoke. The CLI reports skills inside `slash_commands` too — keep them on the
// skill side only, so the composer's `+` menu files them under Skills. `__`-prefixed names
// are internal plumbing, not user-facing.
func (r *slashRegistry) learn(commands, skills []string) bool {
	return r.learnFor(providerClaude, commands, skills)
}

// learnFor keeps runtime registries separate. A command advertised by Kimi must never
// make a Claude composer accept it (or vice versa), even when both runtimes share a runner.
func (r *slashRegistry) learnFor(provider string, commands, skills []string) bool {
	isSkill := map[string]bool{}
	for _, n := range skills {
		isSkill[n] = true
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	commandSet, skillSet := r.commands, r.skills
	if provider == providerKimi {
		commandSet, skillSet = r.kimiCommands, r.kimiSkills
	}
	changed := false
	for _, n := range commands {
		if !isSkill[n] {
			changed = addSlashName(commandSet, n) || changed
		}
	}
	for _, n := range skills {
		changed = addSlashName(skillSet, n) || changed
	}
	if changed {
		r.save()
	}
	return changed
}

func addSlashName(set map[string]bool, name string) bool {
	name = strings.TrimSpace(name)
	if name == "" || strings.HasPrefix(name, "__") || set[name] {
		return false
	}
	set[name] = true
	return true
}

// emptyFor reports whether nothing has been learned for a provider yet — the state a freshly
// enrolled runner is in until its first session boots. Gates the start-up probe below.
func (r *slashRegistry) emptyFor(provider string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	commandSet, skillSet := r.commands, r.skills
	if provider == providerKimi {
		commandSet, skillSet = r.kimiCommands, r.kimiSkills
	}
	return len(commandSet) == 0 && len(skillSet) == 0
}

// extras reports the registered names the disk scan didn't produce — built-ins, plugin
// skills, namespaced commands, and assets living in a worktree the scan doesn't cover.
// They're host-level (no agentId): the CLI reports one flat list per session, with no way
// to tell which agent's checkout a name came from.
func (r *slashRegistry) extras(scanned map[string]bool) (commands, skills []SlashCommandInfo) {
	return r.extrasFor(providerClaude, scanned)
}

func (r *slashRegistry) extrasFor(provider string, scanned map[string]bool) (commands, skills []SlashCommandInfo) {
	r.mu.Lock()
	defer r.mu.Unlock()
	commandSet, skillSet := r.commands, r.skills
	if provider == providerKimi {
		commandSet, skillSet = r.kimiCommands, r.kimiSkills
	}
	collect := func(set map[string]bool, kind string) []SlashCommandInfo {
		var names []string
		for n := range set {
			if !scanned[n] {
				names = append(names, n)
			}
		}
		sort.Strings(names)
		out := make([]SlashCommandInfo, 0, len(names))
		for _, n := range names {
			item := SlashCommandInfo{Name: n, Type: kind, Builtin: true}
			if provider == providerKimi {
				item.Provider = providerKimi
			}
			out = append(out, item)
		}
		return out
	}
	return collect(commandSet, "command"), collect(skillSet, "skill")
}

func (r *slashRegistry) load() {
	data, err := os.ReadFile(r.path)
	if err != nil {
		return
	}
	var f slashRegistryFile
	if json.Unmarshal(data, &f) != nil {
		return
	}
	for _, n := range f.Commands {
		addSlashName(r.commands, n)
	}
	for _, n := range f.Skills {
		addSlashName(r.skills, n)
	}
	for _, n := range f.KimiCommands {
		addSlashName(r.kimiCommands, n)
	}
	for _, n := range f.KimiSkills {
		addSlashName(r.kimiSkills, n)
	}
}

// save persists the set; callers hold the lock. Best-effort — the registry re-learns from
// the next session's init handshake, so a write failure only costs the restart window.
func (r *slashRegistry) save() {
	f := slashRegistryFile{
		Commands: sortedKeys(r.commands), Skills: sortedKeys(r.skills),
		KimiCommands: sortedKeys(r.kimiCommands), KimiSkills: sortedKeys(r.kimiSkills),
	}
	data, err := json.Marshal(f)
	if err != nil {
		return
	}
	if os.MkdirAll(filepath.Dir(r.path), 0o755) != nil {
		return
	}
	_ = os.WriteFile(r.path, data, 0o644)
}

func sortedKeys(set map[string]bool) []string {
	out := make([]string, 0, len(set))
	for k := range set {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// slashAssetsForHeartbeat is the disk scan plus whatever the CLI registers that the scan
// can't see. This pair is what the composer both autocompletes and gates sending on.
func slashAssetsForHeartbeat(roots []assetRoot) (commands, skills []SlashCommandInfo) {
	commands, skills = scanSlashAssets(roots)
	scanned := map[string]bool{}
	for _, a := range commands {
		scanned[a.Name] = true
	}
	for _, a := range skills {
		scanned[a.Name] = true
	}
	ec, es := slashReg.extras(scanned)
	commands, skills = append(commands, ec...), append(skills, es...)
	kc, ks := slashReg.extrasFor(providerKimi, nil)
	return append(commands, kc...), append(skills, ks...)
}

// slashProbeTimeout bounds the throwaway CLI start-up below. The init handshake lands within a
// second or two on a healthy install; the rest of the budget covers a cold node/npm start.
const slashProbeTimeout = 60 * time.Second

// ensureClaudeSlashRegistry learns the Claude CLI's own slash registry without waiting for this
// machine's first session to boot. Until it runs, a freshly enrolled runner reports only what the
// disk scan found, so the composer's `/` menu is missing every built-in, plugin skill and
// namespaced command — for hours, if nobody starts a session. Returns whether anything was
// learned (the caller re-publishes the heartbeat catalog when so).
//
// A no-op once the registry holds anything: it's persisted under ~/.orbit, so this costs one
// process spawn per fresh machine, not one per restart. Retried on the caller's rescan tick
// while still empty, because engines install on demand — `claude` is often not on PATH yet at
// start-up. Best-effort throughout: a failure leaves the registry exactly as it was.
func ensureClaudeSlashRegistry(ctx context.Context, workDir string) bool {
	if !slashReg.emptyFor(providerClaude) || !claudeCLIAvailable() {
		return false
	}
	commands, skills, err := probeClaudeSlashAssets(ctx, workDir)
	if err != nil {
		logln("slash registry probe failed:", err)
		return false
	}
	return slashReg.learn(commands, skills)
}

// probeClaudeSlashAssets reads the registry out of the CLI's own `init` handshake — the same
// message a real session learns from (see handleMessage), so this is the authoritative list
// rather than a parse of human-readable help text.
//
// The prompt is `/help` specifically because the CLI resolves slash commands client-side: it
// announces `init` (carrying `slash_commands` + `skills`), answers locally, and exits with
// `num_turns: 0` and `total_cost_usd: 0` — no API call, nothing billed. It has to be SOME
// prompt: with an empty stream-json stdin the CLI waits for a message and emits nothing at all,
// so there is no handshake to read. `--no-session-persistence` keeps the throwaway out of the
// user's `claude --resume` list.
func probeClaudeSlashAssets(ctx context.Context, workDir string) (commands, skills []string, err error) {
	cctx, cancel := context.WithTimeout(ctx, slashProbeTimeout)
	defer cancel()
	cmd := exec.CommandContext(cctx, "claude",
		"-p", "/help",
		"--output-format", "stream-json",
		"--verbose",
		"--no-session-persistence",
	)
	// Slash availability is cwd-scoped, so probe from the runner's own working dir — the same
	// host-level root the disk scan uses. Agent-level assets are already covered by that scan.
	if workDir != "" {
		if _, statErr := os.Stat(workDir); statErr == nil {
			cmd.Dir = workDir
		}
	}
	cmd.Env = envWithAgent(nil)
	out, err := cmd.Output()
	if err != nil {
		return nil, nil, err
	}
	sc := bufio.NewScanner(bytes.NewReader(out))
	sc.Buffer(make([]byte, 0, 64*1024), 4*1024*1024) // init lists every command — same cap as runSession
	for sc.Scan() {
		var msg map[string]interface{}
		if json.Unmarshal(sc.Bytes(), &msg) != nil {
			continue
		}
		if msg["type"] != "system" || msg["subtype"] != "init" {
			continue
		}
		return stringsFromJSON(msg["slash_commands"]), stringsFromJSON(msg["skills"]), nil
	}
	return nil, nil, errors.New("claude exited without an init handshake")
}

// stringsFromJSON reads a JSON array of strings out of a decoded message field.
func stringsFromJSON(v interface{}) []string {
	arr, _ := v.([]interface{})
	out := make([]string, 0, len(arr))
	for _, it := range arr {
		if s, ok := it.(string); ok {
			out = append(out, s)
		}
	}
	return out
}
