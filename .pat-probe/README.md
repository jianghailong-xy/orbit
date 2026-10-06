# TEMPORARY evidence probe — never merged

Task 34ajRKoVR1CNRAVNE4KbK (iOS / macOS: access token list and revoke). Builds the iPhone app's
`CompactShell` with Settings' sheet over it, and the Mac app's Settings form (`SettingsView`), from the
real shared sources into throwaway apps pointed at `stub.py` — one account with six personal access
tokens: three that work (one never expires, one confined to a workspace, one issued by `orbit login`)
and three that stopped. `PatShotTests` opens Settings → Access tokens, photographs the list, and revokes
"MacBook Air" through the real controls (swipe or Revoke…, then the confirmation), which sends the real
`DELETE /api/access-tokens/34ajPat3`; the stub then lists it under Revoked & expired. All data is made up.
