//go:build !linux && !darwin

package main

// awaitChildExit returns at once where the runner never re-executes into a self-update (selfupdate.go
// platformKey): no job is ever handed on, so reaping it as soon as it exits is all there is.
func awaitChildExit(pid int) {}
