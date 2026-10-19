//go:build linux && !amd64 && !386

package main

import "syscall"

const sysSyncfs = syscall.SYS_SYNCFS
