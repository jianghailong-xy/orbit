//go:build linux || darwin

package main

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// secretTestHome points HOME and ORBIT_HOME at a fresh directory, as a runner user's home would be.
func secretTestHome(t *testing.T) string {
	t.Helper()
	home, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", home)
	t.Setenv("ORBIT_HOME", filepath.Join(home, ".orbit"))
	if err := os.MkdirAll(filepath.Join(home, ".orbit"), 0o700); err != nil {
		t.Fatal(err)
	}
	return home
}

func secretPathCode(err error) string {
	var refused *secretPathError
	if errors.As(err, &refused) {
		return refused.code
	}
	return ""
}

func TestSecretFilePathRefusesEachRule(t *testing.T) {
	home := secretTestHome(t)
	mustMkdir := func(path string) {
		t.Helper()
		if err := os.MkdirAll(path, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	workspace := filepath.Join(home, "work", "site")
	mustMkdir(workspace)
	mustMkdir(filepath.Join(home, "repo", ".git"))
	mustMkdir(filepath.Join(home, "repo", "sub"))
	mustMkdir(filepath.Join(home, "real"))
	if err := os.Symlink(filepath.Join(home, "real"), filepath.Join(home, "link")); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "plain"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, ".bashrc"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}

	for _, tc := range []struct {
		name, path, code, says string
	}{
		{"empty", "", secretPathCodeShape, "is empty"},
		{"relative", "keys/deepseek", secretPathCodeShape, "absolute or start with ~/"},
		{"dot dot", "~/keys/../.bashrc", secretPathCodeShape, ".. segment"},
		{"NUL", "~/keys/a\x00b", secretPathCodeShape, "NUL"},
		{"too long", "~/" + strings.Repeat("a", secretFilePathMax), secretPathCodeShape, "longer than"},
		{"outside the home", "/etc/orbit-secret-test", secretPathCodeRefused, "under the runner user's home"},
		{"the home itself", home, secretPathCodeRefused, "under the runner user's home"},
		{"Orbit's directory", "~/.orbit/runs/key", secretPathCodeRefused, "Orbit's own directory"},
		{"a workspace", filepath.Join(workspace, "key"), secretPathCodeRefused, "workspace's working directory"},
		{"a git repository", "~/repo/sub/key", secretPathCodeRefused, "git repository"},
		{"an engine's directory", "~/.claude/key", secretPathCodeRefused, "coding engine's configuration directory"},
		{"another engine's directory", "~/.config/opencode/key", secretPathCodeRefused, "coding engine's configuration directory"},
		{"a symbolic link", "~/link/key", secretPathCodeLink, "symbolic link"},
		{"not a directory", "~/plain/key", secretPathCodeRefused, "not a directory"},
		{"an existing file", "~/.bashrc", secretPathCodeExists, "already exists"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := checkSecretFilePath(tc.path, []string{workspace})
			if err == nil {
				t.Fatalf("%q was accepted", tc.path)
			}
			if code := secretPathCode(err); code != tc.code {
				t.Fatalf("%q refused with code %q, want %q: %v", tc.path, code, tc.code, err)
			}
			if !strings.Contains(err.Error(), tc.says) {
				t.Fatalf("%q refused as %q, which does not say %q", tc.path, err, tc.says)
			}
		})
	}
}

func TestSecretFilePathAcceptsANewFileAndListsMissingParents(t *testing.T) {
	home := secretTestHome(t)
	target, err := checkSecretFilePath("~/.config/deepseek/keys/api", nil)
	if err != nil {
		t.Fatal(err)
	}
	if target.path != filepath.Join(home, ".config", "deepseek", "keys", "api") {
		t.Fatalf("path = %q", target.path)
	}
	want := []string{filepath.Join(home, ".config"), filepath.Join(home, ".config", "deepseek"), filepath.Join(home, ".config", "deepseek", "keys")}
	if strings.Join(target.missing, "|") != strings.Join(want, "|") {
		t.Fatalf("missing = %v, want %v", target.missing, want)
	}
}

func TestSecretEnvVarRules(t *testing.T) {
	for _, ok := range []string{"DEEPSEEK_API_KEY", "A", "X9_"} {
		if err := checkSecretEnvVar(ok); err != nil {
			t.Errorf("%s refused: %v", ok, err)
		}
	}
	for _, bad := range []string{"", "lower", "9LEAD", "WITH-DASH", strings.Repeat("A", 65), "PATH", "HOME", "ENV", "BASH_ENV",
		"NODE_OPTIONS", "ORBIT_ANYTHING", "ORBIT_SESSION_ID", "ORBIT_USER_TOKEN", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES", "PYTHONPATH"} {
		if err := checkSecretEnvVar(bad); err == nil {
			t.Errorf("%q accepted", bad)
		}
	}
}

func TestWriteSecretFileCreatesPrivateFileAndParents(t *testing.T) {
	home := secretTestHome(t)
	target, err := checkSecretFilePath("~/keys/deep/api.key", nil)
	if err != nil {
		t.Fatal(err)
	}
	var recorded []string
	var gotDev, gotIno uint64
	dev, ino, err := writeSecretFile(target, []byte("sk-test-value-123"), func(dir string) error {
		recorded = append(recorded, dir)
		if _, err := os.Lstat(dir); err == nil {
			t.Errorf("%s was recorded after it was created", dir)
		}
		return nil
	}, func(d, i uint64) error {
		gotDev, gotIno = d, i
		if data, _ := os.ReadFile(target.path); len(data) != 0 {
			t.Error("the value was written before the file was recorded")
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if dev != gotDev || ino != gotIno {
		t.Fatal("recorded device and inode differ from the ones returned")
	}
	if strings.Join(recorded, "|") != filepath.Join(home, "keys")+"|"+filepath.Join(home, "keys", "deep") {
		t.Fatalf("recorded parents %v", recorded)
	}
	info, err := os.Stat(target.path)
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("file mode %v, %v", info, err)
	}
	for _, dir := range recorded {
		if info, err := os.Stat(dir); err != nil || info.Mode().Perm() != 0o700 {
			t.Fatalf("%s mode %v, %v", dir, info, err)
		}
	}
	if state, _ := inspectSecretFile(target.path, dev, ino); state != secretFileOurs {
		t.Fatalf("state = %v", state)
	}
}

// A link put in place after the rules looked must not move the write: the write goes down with O_NOFOLLOW.
func TestWriteSecretFileRefusesASymlinkSwappedInAfterTheCheck(t *testing.T) {
	home := secretTestHome(t)
	if err := os.MkdirAll(filepath.Join(home, "keys", "deep"), 0o700); err != nil {
		t.Fatal(err)
	}
	elsewhere := filepath.Join(home, "elsewhere")
	if err := os.MkdirAll(filepath.Join(elsewhere, "deep"), 0o700); err != nil {
		t.Fatal(err)
	}
	target, err := checkSecretFilePath("~/keys/deep/api.key", nil)
	if err != nil {
		t.Fatal(err)
	}
	// The swap: ~/keys becomes a link to a directory the rules never looked at.
	if err := os.RemoveAll(filepath.Join(home, "keys")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(elsewhere, filepath.Join(home, "keys")); err != nil {
		t.Fatal(err)
	}
	_, _, err = writeSecretFile(target, []byte("sk-test-value-123"), func(string) error { return nil },
		func(uint64, uint64) error { return nil })
	if secretPathCode(err) != secretPathCodeLink {
		t.Fatalf("write through a swapped-in link: %v", err)
	}
	if _, err := os.Lstat(filepath.Join(elsewhere, "deep", "api.key")); !os.IsNotExist(err) {
		t.Fatalf("the write went through the link: %v", err)
	}

	// The leaf swapped for a link to the owner's file is refused by O_EXCL|O_NOFOLLOW, and the file is untouched.
	if err := os.Remove(filepath.Join(home, "keys")); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(home, "keys", "deep"), 0o700); err != nil {
		t.Fatal(err)
	}
	target, err = checkSecretFilePath("~/keys/deep/api.key", nil)
	if err != nil {
		t.Fatal(err)
	}
	owners := filepath.Join(home, "owners-file")
	if err := os.WriteFile(owners, []byte("mine"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(owners, target.path); err != nil {
		t.Fatal(err)
	}
	_, _, err = writeSecretFile(target, []byte("sk-test-value-123"), func(string) error { return nil },
		func(uint64, uint64) error { return nil })
	if secretPathCode(err) != secretPathCodeExists {
		t.Fatalf("write onto a swapped-in leaf link: %v", err)
	}
	if data, _ := os.ReadFile(owners); string(data) != "mine" {
		t.Fatalf("the owner's file was written: %q", data)
	}
}

// The walk for a .git stops at the home: a repository above it is not the user's checkout (a shared /tmp may hold one
// for a moment), while one at the home itself, a dotfiles repository, still refuses.
func TestSecretFilePathLooksForAGitRepositoryUpToTheHomeOnly(t *testing.T) {
	outer, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	home := filepath.Join(outer, "home")
	if err := os.MkdirAll(filepath.Join(home, ".orbit"), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", home)
	t.Setenv("ORBIT_HOME", filepath.Join(home, ".orbit"))
	if err := os.Mkdir(filepath.Join(outer, ".git"), 0o700); err != nil {
		t.Fatal(err)
	}
	if _, err := checkSecretFilePath("~/.config/tool/key", nil); err != nil {
		t.Fatalf("a .git above the home refused the path: %v", err)
	}
	if err := os.Mkdir(filepath.Join(home, ".git"), 0o700); err != nil {
		t.Fatal(err)
	}
	if _, err := checkSecretFilePath("~/.config/tool/key", nil); secretPathCode(err) != secretPathCodeRefused {
		t.Fatalf("a .git at the home did not refuse the path: %v", err)
	}
}
