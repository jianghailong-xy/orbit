package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestRemovalScratchExcludesOnlyPublishedHistory(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	repo := initRepo(t)
	commitFile(t, repo, "public.env", testSecretValue, "published value")
	mustGit(t, repo, "update-ref", "refs/remotes/origin/published", "HEAD")
	r := newSecretRedactor([]string{testSecretValue})
	ids, _, err := listPublishedObjects(repo, "HEAD", "", "--remotes=origin")
	if err != nil || len(ids) != 0 {
		t.Fatalf("published history would be read: %v, %v", ids, err)
	}
	if err := taintCheckout(repo, "_integrate-no-base", r); err != nil {
		t.Fatal(err)
	}
	entries, err := readSecretTaint()
	if err != nil || len(entries) != 0 {
		t.Fatalf("published history recorded: %v, %v", entries, err)
	}
	commitFile(t, repo, "private.env", testSecretValue+"\nprivate", "unpublished value")
	tip := mustGit(t, repo, "rev-parse", "HEAD")
	if err := taintCheckout(repo, "_integrate-no-base", r); err != nil {
		t.Fatal(err)
	}
	entries, err = readSecretTaint()
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, e := range entries {
		if e.Commit == tip {
			for _, o := range e.Objects {
				if o.Path == "private.env" {
					found = true
				}
			}
		}
	}
	if !found {
		t.Fatalf("unpublished scratch commit not recorded: %+v", entries)
	}
}

func TestRemovalBaseSkipStillScansChangedStateAndMatchers(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	repo := initRepo(t)
	mustGit(t, repo, "update-ref", baseRefName("clean"), "HEAD")
	base := mustGit(t, repo, "rev-parse", "HEAD")
	if tip, err := checkoutSecretHistoryTip(repo, base); err != nil || tip != "" {
		t.Fatalf("base was not skipped: %q %v", tip, err)
	}
	scan := func(value string) {
		t.Helper()
		if err := taintCheckout(repo, "clean", newSecretRedactor([]string{value})); err != nil {
			t.Fatal(err)
		}
	}
	scan(testSecretValue)
	// Index and HEAD are unchanged; an untracked value must still be found.
	if err := os.WriteFile(filepath.Join(repo, "new.env"), []byte(testSecretValue), 0600); err != nil {
		t.Fatal(err)
	}
	other := "another-owner-secret-value-238501"
	if err := os.WriteFile(filepath.Join(repo, "other.env"), []byte(other), 0600); err != nil {
		t.Fatal(err)
	}
	scan(testSecretValue)
	// Scan exactly the same checkout state for a different value.
	scan(other)
	// A change to HEAD must cause history to be scanned too.
	commitFile(t, repo, "committed.env", other, "advance HEAD")
	if tip, err := checkoutSecretHistoryTip(repo, base); err != nil || tip == "" {
		t.Fatalf("changed HEAD skipped: %q %v", tip, err)
	}
	scan(other)
	entries, err := readSecretTaint()
	if err != nil {
		t.Fatal(err)
	}
	found := map[string]bool{}
	for _, e := range entries {
		for _, o := range e.Objects {
			found[o.Path] = true
		}
	}
	for _, name := range []string{"new.env", "other.env", "committed.env"} {
		if !found[name] {
			t.Errorf("missing %s: %+v", name, entries)
		}
	}
}

func TestRemovalCandidateSkipKeepsStagedOnlyValue(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	repo := initRepo(t)
	commitFile(t, repo, "staged.env", "clean", "clean base")
	mustGit(t, repo, "update-ref", baseRefName("staged"), "HEAD")
	path := filepath.Join(repo, "staged.env")
	if err := os.WriteFile(path, []byte(testSecretValue), 0600); err != nil {
		t.Fatal(err)
	}
	mustGit(t, repo, "add", "staged.env")
	id := mustGit(t, repo, "rev-parse", ":staged.env")
	if err := os.WriteFile(path, []byte("clean"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := taintCheckout(repo, "staged", newSecretRedactor([]string{testSecretValue})); err != nil {
		t.Fatal(err)
	}
	entries, err := readSecretTaint()
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		for _, o := range e.Objects {
			if o.ID == id && o.Path == "staged.env" {
				return
			}
		}
	}
	t.Fatalf("staged-only value was skipped: %+v", entries)
}
