package main

import "testing"

func TestNewLeaseGenerationIsFreshUUID(t *testing.T) {
	first, err := newLeaseGeneration()
	if err != nil {
		t.Fatal(err)
	}
	second, err := newLeaseGeneration()
	if err != nil {
		t.Fatal(err)
	}
	if !uuidRE.MatchString(first) || !uuidRE.MatchString(second) {
		t.Fatalf("lease generations are not UUIDs: %q, %q", first, second)
	}
	if first == second {
		t.Fatalf("lease generations repeated: %q", first)
	}
}
