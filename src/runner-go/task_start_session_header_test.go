package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// The server holds what a session may start to that session's own mode, so a task_start from a session
// has to say which one it is, for the MCP tool and `orbit task start` alike. A person's shell has no
// session and names none.
func TestStartTaskNamesTheSessionItRunsIn(t *testing.T) {
	for _, tc := range []struct {
		name string
		env  string
		want string
	}{
		{name: "inside a session", env: "34qi5OjBPHREayUBCZEJA", want: "34qi5OjBPHREayUBCZEJA"},
		{name: "from a person's shell", env: "", want: ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("ORBIT_SESSION_ID", tc.env)
			var got []string
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				got = append(got, r.Header.Get("X-Orbit-Session-Id"))
				_, _ = w.Write([]byte(`{"ok":true,"sessionId":"s1"}`))
			}))
			t.Cleanup(srv.Close)

			if _, err := NewTransport(srv.URL, "tok").startTask("t1", "341DOGTVEs0Fk0gAn1mje"); err != nil {
				t.Fatalf("startTask: %v", err)
			}
			if len(got) != 1 || got[0] != tc.want {
				t.Fatalf("X-Orbit-Session-Id = %q, want %q", got, tc.want)
			}
		})
	}
}
