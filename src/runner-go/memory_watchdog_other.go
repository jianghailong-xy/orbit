//go:build !linux

package main

import "context"

func startMemoryWatchdog(context.Context, bool) func() { return func() {} }
func trackMemoryRoots(string, bool, ...int)            {}
func memoryWatchdogChildEnv(env []string) []string     { return env }
func restoreOrbitOOMScore()                            {}
