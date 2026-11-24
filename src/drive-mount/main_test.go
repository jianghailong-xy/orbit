package main

import "testing"

// The mount credential's variable was ORBIT_FILES_MOUNT_TOKEN before the drive was renamed Documents: still read
// when the new name is unset, never over it.
func TestMountTokenFromEnv(t *testing.T) {
	t.Setenv("ORBIT_DOCUMENTS_MOUNT_TOKEN", "")
	t.Setenv("ORBIT_FILES_MOUNT_TOKEN", " old ")
	if got := mountTokenFromEnv(); got != "old" {
		t.Fatalf("with only the old name set: %q", got)
	}
	t.Setenv("ORBIT_DOCUMENTS_MOUNT_TOKEN", "new")
	if got := mountTokenFromEnv(); got != "new" {
		t.Fatalf("with both set: %q", got)
	}
	t.Setenv("ORBIT_FILES_MOUNT_TOKEN", "")
	if got := mountTokenFromEnv(); got != "new" {
		t.Fatalf("with only the new name set: %q", got)
	}
}
