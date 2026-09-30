//go:build !go1.24

package main

import "net/http"

// wikiCheckConnHealth has nothing to turn on before go1.24, whose net/http has no HTTP/2 health check to set.
// It keeps a build with the go1.23 this module's go.mod asks for compiling; every build that ships is newer.
func wikiCheckConnHealth(*http.Transport) {}
