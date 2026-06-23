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
// global ~/.claude. The result feeds the web composer's `/` autocomplete, each asset
// tagged with the agent it belongs to (empty = host-level, shared by all agents).
// Dedup is by name, first occurrence wins. Host roots (~/.claude and the runner's
// default dir) are scanned before agent project dirs, so a name shared with the host
// stays host-level (visible to every agent) instead of being captured by one agent;
// a name unique to an agent's project is attributed to that agent.
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
	// Host-level first (the user's ~/.claude + the runner's default dir), then each
	// agent's project dir, so host assets win same-name dedup and stay visible to all.
	addRoot(userHome(), "")
	for _, r := range roots {
		addRoot(r.base, r.agentID)
	}

	cmdSeen := map[string]bool{}
	skillSeen := map[string]bool{}
	for _, r := range scan {
		for _, c := range scanCommands(filepath.Join(r.base, "commands"), r.agentID) {
			if !cmdSeen[c.Name] {
				cmdSeen[c.Name] = true
				commands = append(commands, c)
			}
		}
		for _, s := range scanSkills(filepath.Join(r.base, "skills"), r.agentID) {
			if !skillSeen[s.Name] {
				skillSeen[s.Name] = true
				skills = append(skills, s)
			}
		}
	}
	return commands, skills
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
