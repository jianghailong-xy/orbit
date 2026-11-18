//go:build darwin

package main

import (
	"encoding/binary"
	"testing"
)

func TestParseVMStatAvailable(t *testing.T) {
	out := "Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free:                               10.\nPages active:                            999.\nPages inactive:                            20.\nPages speculative:                          3.\nPages purgeable:                            1.\n"
	if b := parseVMStatAvailable(out); b == nil || *b != 34*16384 {
		t.Fatalf("available = %v", b)
	}
}

func TestParseLoadavgAndPs(t *testing.T) {
	raw := make([]byte, 24)
	binary.LittleEndian.PutUint32(raw[0:4], 3*2048+1024)
	binary.LittleEndian.PutUint64(raw[16:24], 2048)
	if l := parseLoadavg(raw); l == nil || *l != 3.5 {
		t.Fatalf("load1 = %v", l)
	}
	if p := parsePsCPU(" 12.0\n 0,5\n 3.5\n", 4); p == nil || *p != 4 {
		t.Fatalf("cpu = %v", p)
	}
}
