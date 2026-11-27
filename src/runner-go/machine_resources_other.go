//go:build !linux && !darwin

package main

// readPlatformResources has no reading of CPU, memory or load here: the page shows a dash for each, never a zero.
func readPlatformResources(*MachineResources, *cpuCounter) {}

// availableMemory has no reading here: the turn memory gate admits (memory_reserve.go).
func availableMemory() (uint64, bool) { return 0, false }
