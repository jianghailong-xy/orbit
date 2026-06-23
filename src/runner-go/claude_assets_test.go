package main

import (
	"os"
	"path/filepath"
	"sort"
	"testing"
)

// mkSkill creates <base>/.claude/skills/<name>/SKILL.md with a minimal frontmatter.
func mkSkill(t *testing.T, base, name string) {
	t.Helper()
	dir := filepath.Join(base, ".claude", "skills", name)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	body := "---\nname: " + name + "\ndescription: d\n---\n"
	if err := os.WriteFile(filepath.Join(dir, "SKILL.md"), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

// scanSlashAssets must dedup per scope: a host-level name shadows the agents and is
// emitted once; a project name shared by two agents is kept once per agent (each
// scoped to its own), so a dev and a prod agent both surface their copy.
func TestScanSlashAssetsScoping(t *testing.T) {
	home, dev, prod := t.TempDir(), t.TempDir(), t.TempDir()
	t.Setenv("HOME", home)

	mkSkill(t, home, "upgrade") // host-level
	mkSkill(t, dev, "ios-dev")  // same name on both agents
	mkSkill(t, prod, "ios-dev") //
	mkSkill(t, dev, "dev-only") // only on dev
	mkSkill(t, prod, "upgrade") // collides with a host name -> shadowed

	_, skills := scanSlashAssets([]assetRoot{
		{base: dev, agentID: "dev"},
		{base: prod, agentID: "prod"},
	})

	got := map[string][]string{}
	for _, s := range skills {
		got[s.Name] = append(got[s.Name], s.AgentID)
	}
	for _, ids := range got {
		sort.Strings(ids)
	}

	want := map[string][]string{
		"upgrade":  {""},            // host only; prod's copy shadowed
		"ios-dev":  {"dev", "prod"}, // one per agent
		"dev-only": {"dev"},
	}
	if len(got) != len(want) {
		t.Fatalf("skill name set mismatch:\n got  %v\n want %v", got, want)
	}
	for name, wantIDs := range want {
		gotIDs := got[name]
		if len(gotIDs) != len(wantIDs) {
			t.Errorf("%q agentIDs: got %v, want %v", name, gotIDs, wantIDs)
			continue
		}
		for i := range wantIDs {
			if gotIDs[i] != wantIDs[i] {
				t.Errorf("%q agentIDs: got %v, want %v", name, gotIDs, wantIDs)
				break
			}
		}
	}
}
