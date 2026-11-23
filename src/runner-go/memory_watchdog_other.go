//go:build !linux

package main

import "context"

func startMemoryWatchdog(context.Context, bool) func() { return func() {} }
func trackMemoryRoots(string, bool, ...int)            {}
