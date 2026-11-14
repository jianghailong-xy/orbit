//go:build !linux && !darwin

package main

// readPlatformResources has no reading of CPU, memory or load here: the page shows a dash for each, never a zero.
func readPlatformResources(*MachineResources, *cpuCounter) {}
