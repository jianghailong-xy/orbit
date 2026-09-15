package main

import (
	"encoding/json"
	"path/filepath"
	"testing"
)

// The repos root is a convention under the user's home, not a setting.
func TestReposRootIsUnderTheUsersHome(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	if got, want := reposRoot(), filepath.Join(home, "orbit-repos"); got != want {
		t.Errorf("reposRoot() = %q, want %q", got, want)
	}
}

// The wire contract with the control plane: the root rides every heartbeat, and a runner that has
// none sends no field at all — the control plane's "never told us", rather than having a path
// invented for it.
func TestHeartbeatReposRootWireField(t *testing.T) {
	encoded, err := json.Marshal(HeartbeatRequest{Status: "ONLINE", ReposRoot: "/home/u/orbit-repos"})
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]interface{}
	if err := json.Unmarshal(encoded, &got); err != nil {
		t.Fatal(err)
	}
	if got["reposRoot"] != "/home/u/orbit-repos" {
		t.Fatalf("reposRoot = %#v, payload = %s", got["reposRoot"], encoded)
	}
	encoded, err = json.Marshal(HeartbeatRequest{Status: "ONLINE"})
	if err != nil {
		t.Fatal(err)
	}
	bare := map[string]interface{}{}
	if err := json.Unmarshal(encoded, &bare); err != nil {
		t.Fatal(err)
	}
	if _, present := bare["reposRoot"]; present {
		t.Fatalf("a runner with no repos root still sent the field: %s", encoded)
	}
}
