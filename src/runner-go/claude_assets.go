package main

import (
	"os"
	"path/filepath"
	"strings"
)

// assetRoot is one base dir to scan for slash assets, tagged with the agent that owns
// it. agentID is empty for host-level roots (the runner's default dir and the user's
// global ~/.claude), which every agent shares; a non-empty agentID scopes a project's
// assets to that agent so the web composer can filter `/` autocomplete to the session's
// agent.
type assetRoot struct {
	base    string
	agentID string
}

// scanSlashAssets discovers custom slash commands (.claude/commands/*.md) and
// skills (.claude/skills/<name>/SKILL.md) across the given roots plus the user's
// global ~/.claude, tagging each asset with the agent it belongs to (empty =
// host-level, shared by all agents). The result feeds the web composer's `/`
// autocomplete, which scopes the menu to host assets + the session's agent.
//
// Dedup is per scope, host-first: host-level names (~/.claude + the runner's default
// dir) collapse by name and shadow the agents — a name found at host level is visible
// to everyone, so it's emitted once and not re-tagged per agent. A name absent from
// host is kept once per agent that has it, so two agents sharing a project skill name
// (e.g. a dev and a prod checkout of the same repo) each surface their own scoped copy.
func scanSlashAssets(roots []assetRoot) (commands, skills []SlashCommandInfo) {
	var scan []assetRoot
	seenRoot := map[string]bool{}
	addRoot := func(base, agentID string) {
		if base == "" {
			return
		}
		dir := filepath.Join(expandTilde(base), ".claude")
		if seenRoot[dir] {
			return
		}
		seenRoot[dir] = true
		scan = append(scan, assetRoot{base: dir, agentID: agentID})
	}
	// All host-level roots (the user's ~/.claude + the runner's default dir) before any
	// agent's, so host names are fully known and can shadow agents in the scoped dedup.
	addRoot(userHome(), "")
	for _, r := range roots {
		if r.agentID == "" {
			addRoot(r.base, r.agentID)
		}
	}
	for _, r := range roots {
		if r.agentID != "" {
			addRoot(r.base, r.agentID)
		}
	}

	cmdHost, cmdSeen := map[string]bool{}, map[string]bool{}
	skillHost, skillSeen := map[string]bool{}, map[string]bool{}
	for _, r := range scan {
		commands = dedupScoped(commands, scanCommands(filepath.Join(r.base, "commands"), r.agentID), cmdHost, cmdSeen)
		skills = dedupScoped(skills, scanSkills(filepath.Join(r.base, "skills"), r.agentID), skillHost, skillSeen)
	}
	return commands, skills
}

// dedupScoped appends src into dst with scope-aware dedup. hostNames records names
// already claimed at host level (agentID ""); seen records "<agentID>\x00<name>" pairs
// already emitted. A host asset collapses by name and is recorded so a later agent asset
// of the same name is dropped (host shadows project). An agent asset is kept unless its
// name is host-level or already emitted for that same agent — so two agents can each keep
// their own copy of a shared name. Host roots must be scanned before agent roots.
func dedupScoped(dst, src []SlashCommandInfo, hostNames, seen map[string]bool) []SlashCommandInfo {
	for _, a := range src {
		if a.AgentID == "" {
			if hostNames[a.Name] {
				continue
			}
			hostNames[a.Name] = true
		} else {
			if hostNames[a.Name] {
				continue
			}
			key := a.AgentID + "\x00" + a.Name
			if seen[key] {
				continue
			}
			seen[key] = true
		}
		dst = append(dst, a)
	}
	return dst
}

func scanCommands(dir, agentID string) []SlashCommandInfo {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var out []SlashCommandInfo
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".md") {
			continue
		}
		_, desc := readFrontmatter(filepath.Join(dir, e.Name()))
		out = append(out, SlashCommandInfo{
			Name:        strings.TrimSuffix(e.Name(), ".md"),
			Description: desc,
			Type:        "command",
			AgentID:     agentID,
		})
	}
	return out
}

func scanSkills(dir, agentID string) []SlashCommandInfo {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var out []SlashCommandInfo
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		name, desc := readFrontmatter(filepath.Join(dir, e.Name(), "SKILL.md"))
		if name == "" {
			name = e.Name()
		}
		out = append(out, SlashCommandInfo{Name: name, Description: desc, Type: "skill", AgentID: agentID})
	}
	return out
}

// readFrontmatter returns the `name` and `description` from a file's leading
// `---`-fenced YAML block. Minimal by design: it handles only the flat
// `key: value` lines orbit's command/skill files use (single-line values, no
// nested/multi-line YAML), which is all the composer hint needs.
func readFrontmatter(path string) (name, description string) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", ""
	}
	lines := strings.Split(string(data), "\n")
	i := 0
	for i < len(lines) && strings.TrimSpace(lines[i]) == "" {
		i++
	}
	if i >= len(lines) || strings.TrimSpace(lines[i]) != "---" {
		return "", ""
	}
	for i++; i < len(lines); i++ {
		if strings.TrimSpace(lines[i]) == "---" {
			break
		}
		key, val, ok := strings.Cut(lines[i], ":")
		if !ok {
			continue
		}
		val = strings.Trim(strings.TrimSpace(val), `"'`)
		switch strings.TrimSpace(key) {
		case "name":
			name = val
		case "description":
			description = val
		}
	}
	return name, description
}
