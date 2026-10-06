# TEMPORARY evidence probe — never merged

Task A1 (34bAKshYuCWyoAqoDR9m9, Google sign-in on iOS / macOS). Builds the iPhone app's and the Mac
app's own `LoginView` and `AppModel` from the real shared sources into throwaway apps whose root is
the apps' sign-in gate (LoginView until signed in), pointed at `stub.py` — one port per kind of
server: Google on and opening accounts (8765), Google on for existing accounts (8766), Google off
(8767), a server from before Google sign-in whose /auth/methods is a 404 (8768), and one whose
exchange refuses GOOGLE_ACCOUNT_NOT_FOUND (8769). `GoogleShotTests` photographs the login page
against each, then presses Continue with Google: the real `ASWebAuthenticationSession` opens the
stub's /api/auth/google/start, which answers with the 302 to orbit://auth/google?ticket&state that
the real callback ends in; the app exchanges the ticket, and the stub checks the PKCE pair. No real
Google, and all data made up.
