package main

import "testing"

// The two spellings of a session the control plane hands out (src/shared/src/codec.ts): pairs written by its encoder.
func TestASessionIsNamedByItsUUIDWhicheverSpellingItCameIn(t *testing.T) {
	for _, c := range []struct{ in, want string }{
		{"0190a0b0-0000-7000-8000-0000000000a1", "0190a0b0-0000-7000-8000-0000000000a1"},
		{"0190A0B0-0000-7000-8000-0000000000A1", "0190a0b0-0000-7000-8000-0000000000a1"},
		{"2x5PpI0zRtLFFWeu0anOj", "0190a0b0-0000-7000-8000-0000000000a1"},
		{"31PykwnEeaJbPHsbp3a1h", "019a1b2c-3d4e-7f80-9a1b-2c3d4e5f6071"},
		{"7n42DGM5Tflk9n8mt7Fhc7", "ffffffff-ffff-ffff-ffff-ffffffffffff"},
		{"0", "00000000-0000-0000-0000-000000000000"},
	} {
		if got, ok := sessionUUID(c.in); !ok || got != c.want {
			t.Errorf("%q: %q %v, want %q", c.in, got, ok, c.want)
		}
	}
	for _, bad := range []string{"", "not.a.session", "ses-*", "7n42DGM5Tflk9n8mt7Fhc8", "7n42DGM5Tflk9n8mt7Fhc7x", "0190a0b0-0000-7000-8000-0000000000a"} {
		if got, ok := sessionUUID(bad); ok {
			t.Errorf("%q was read as %q", bad, got)
		}
	}
}
