//go:build go1.24

package main

import "net/http"

// wikiCheckConnHealth turns the health check on for tr's HTTP/2 connections. net/http's HTTP2Config is
// go1.24's, newer than the go1.23 this module's go.mod asks for, so it is named only in a file for go1.24 and
// later; a toolchain before it has no health check to turn on (wiki_conn_go123.go).
func wikiCheckConnHealth(tr *http.Transport) {
	tr.HTTP2 = &http.HTTP2Config{SendPingTimeout: wikiConnHealth.sendPing, PingTimeout: wikiConnHealth.ping}
}
