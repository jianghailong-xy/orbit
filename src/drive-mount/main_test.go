package main

import "testing"

// The mount credential's variable was ORBIT_DOCUMENTS_MOUNT_TOKEN, and before that ORBIT_FILES_MOUNT_TOKEN: still read
// when the newer name is unset, never over it.
func TestMountTokenFromEnv(t *testing.T) {
	t.Setenv("ORBIT_DRIVE_MOUNT_TOKEN", "")
	t.Setenv("ORBIT_DOCUMENTS_MOUNT_TOKEN", "")
	t.Setenv("ORBIT_FILES_MOUNT_TOKEN", " oldest ")
	if got := mountTokenFromEnv(); got != "oldest" {
		t.Fatalf("with only ORBIT_FILES_MOUNT_TOKEN set: %q", got)
	}
	t.Setenv("ORBIT_DOCUMENTS_MOUNT_TOKEN", " old ")
	if got := mountTokenFromEnv(); got != "old" {
		t.Fatalf("with ORBIT_DOCUMENTS_MOUNT_TOKEN and ORBIT_FILES_MOUNT_TOKEN set: %q", got)
	}
	t.Setenv("ORBIT_DRIVE_MOUNT_TOKEN", "new")
	if got := mountTokenFromEnv(); got != "new" {
		t.Fatalf("with all three set: %q", got)
	}
	t.Setenv("ORBIT_DOCUMENTS_MOUNT_TOKEN", "")
	t.Setenv("ORBIT_FILES_MOUNT_TOKEN", "")
	if got := mountTokenFromEnv(); got != "new" {
		t.Fatalf("with only the new name set: %q", got)
	}
}
