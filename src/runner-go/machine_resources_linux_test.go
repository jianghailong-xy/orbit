//go:build linux

package main

import (
	"bufio"
	"strings"
	"testing"
)

func TestParseProcStatCPU(t *testing.T) {
	busy, total, ok := parseProcStatCPU("cpu  100 5 50 800 40 3 2 0 7 0")
	if !ok || total != 1000 || busy != 160 {
		t.Fatalf("busy/total = %d/%d %v, want 160/1000 (guest left out, idle+iowait not busy)", busy, total, ok)
	}
	if _, _, ok := parseProcStatCPU("cpu0 1 2 3 4"); ok {
		t.Fatal("a per-core line is not the machine's")
	}
}

func TestParseMeminfoAndLoad(t *testing.T) {
	total, avail := parseMeminfo(bufio.NewScanner(strings.NewReader("MemTotal:       32000 kB\nMemFree:  100 kB\nMemAvailable:   8000 kB\n")))
	if total == nil || *total != 32000*1024 || avail == nil || *avail != 8000*1024 {
		t.Fatalf("meminfo = %v/%v", total, avail)
	}
	if l := parseLoad1("3.04 2.50 1.00 2/300 1234\n"); l == nil || *l != 3.04 {
		t.Fatalf("load1 = %v", l)
	}
}

func TestReadPlatformResourcesOnThisMachine(t *testing.T) {
	var c cpuCounter
	var r MachineResources
	readPlatformResources(&r, &c)
	if r.MemTotalBytes == nil || r.MemAvailableBytes == nil || *r.MemAvailableBytes > *r.MemTotalBytes {
		t.Fatalf("memory = %v/%v", r.MemAvailableBytes, r.MemTotalBytes)
	}
	if r.Load1 == nil {
		t.Fatal("no load average")
	}
}
