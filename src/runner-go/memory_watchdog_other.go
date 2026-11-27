//go:build !linux

package main

import (
	"context"
	"net"
)

const memoryToolShellComm = "orbit-oom-shell"
const memoryToolExitOp = "memory_tool_exit"
const memoryReserveCommand = "orbit-headroom"

func startMemoryWatchdog(context.Context, bool) func()                      { return func() {} }
func trackMemoryRoots(string, bool, ...int)                                 {}
func memoryWatchdogChildEnv(env []string) []string                          { return env }
func restoreOrbitOOMScore()                                                 {}
func watchMemoryTool(context.Context, string) func(int)                     { return func(int) {} }
func memoryToolClaudeEnv(env []string) []string                             { return env }
func runMemoryToolShell([]string) int                                       { return 126 }
func runMemoryReserve() int                                                 { return 1 }
func (*bgJobService) reportMemoryToolExit(net.Conn, map[string]interface{}) {}
