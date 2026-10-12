package main

import (
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

// writeClaudeLoginLapsing signs dir in the way Claude Code 2.1.292 stores a login: an access token
// good for hours, a refresh token, and that refresh token's own expiry — when the login itself lapses.
func writeClaudeLoginLapsing(t *testing.T, dir string, lapses time.Time) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	body := fmt.Sprintf(`{"claudeAiOauth":{"accessToken":"t","refreshToken":"r","expiresAt":%d,"refreshTokenExpiresAt":%d}}`,
		time.Now().Add(8*time.Hour).UnixMilli(), lapses.UnixMilli())
	if err := os.WriteFile(filepath.Join(dir, ".credentials.json"), []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestParseClaudeOAuthLoginReadsWhenTheLoginLapses(t *testing.T) {
	lapses := time.Date(2026, 10, 30, 8, 0, 0, 0, time.UTC)
	login, err := parseClaudeOAuthLogin([]byte(fmt.Sprintf(
		`{"claudeAiOauth":{"accessToken":"t","refreshToken":"r","expiresAt":1,"refreshTokenExpiresAt":%d}}`, lapses.UnixMilli())))
	if err != nil {
		t.Fatal(err)
	}
	if !login.loginExpiresAt.Equal(lapses) {
		t.Fatalf("loginExpiresAt = %v, want %v", login.loginExpiresAt, lapses)
	}
	// A CLI older than the field, or one that wrote it in a shape this runner doesn't know, leaves the
	// login with no lapse to warn about — never with a made-up one.
	for _, blob := range []string{
		`{"claudeAiOauth":{"accessToken":"t","refreshToken":"r","expiresAt":1}}`,
		`{"claudeAiOauth":{"accessToken":"t","refreshToken":"r","refreshTokenExpiresAt":"soon"}}`,
	} {
		login, err := parseClaudeOAuthLogin([]byte(blob))
		if err != nil {
			t.Fatal(err)
		}
		if !login.loginExpiresAt.IsZero() {
			t.Fatalf("%s: loginExpiresAt = %v, want none", blob, login.loginExpiresAt)
		}
	}
}

// A signed-in Claude account says when its login lapses, read from that account's own credentials:
// Default's from the runner's own login, an added account's from its directory. One whose credentials
// record no lapse, or hold no refresh token to lapse, says nothing; neither does one signed out.
func TestClaudeEngineHealthAccountsCarryWhenEachLoginLapses(t *testing.T) {
	home, _ := claudeAccountSlotTestHomes(t)
	writeClaudeLoginLapsing(t, filepath.Join(home, ".claude"), time.Date(2026, 10, 30, 8, 0, 0, 0, time.UTC))
	work, err := claudeAccountKind.create("Work")
	if err != nil {
		t.Fatal(err)
	}
	writeClaudeLoginLapsing(t, work.Dir, time.Date(2026, 10, 10, 9, 30, 0, 0, time.UTC))
	older, err := claudeAccountKind.create("Older")
	if err != nil {
		t.Fatal(err)
	}
	signInClaudeDir(t, older.Dir) // an access token alone, as a CLI older than the field stores it
	out, err := claudeAccountKind.create("Out")
	if err != nil {
		t.Fatal(err)
	}
	binDir, _ := fakeClaudeForAccountHealth(t)

	reports := probeEngines([]engineSpec{claudeSpecForTest(t)}, binDir)
	got := map[string]string{}
	for _, account := range reports[0].Accounts {
		got[account.ID] = account.LoginExpiresAt
	}
	want := map[string]string{
		accountSlotDefaultID: "2026-10-30T08:00:00Z",
		work.ID:              "2026-10-10T09:30:00Z",
		older.ID:             "",
		out.ID:               "",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("login expiries = %#v, want %#v", got, want)
	}
}
