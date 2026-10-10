# TEMPORARY evidence probe — never merged as a workflow

The login page remembering the last account per domain (docs/mocks/login-remember-account/), on
the real shared `LoginView` and `AppModel`, in throwaway iPhone and Mac apps pointed at `stub.py`
with `-orbit.instance http://127.0.0.1:8765`. `ProbeArgs.seed` writes what each launch remembers
through the app's own `RememberedAccounts` store, from launch arguments: `-probe.account
password|google|unknown` (Alex Morgan on the stub's domain), `-probe.photo 1` (with `avatar.jpg`,
the same made-up photo the stub serves), `-probe.other <address>` (Sam Lee's Google account on a
second domain), `-probe.legacy <email>` (the pre-card `orbit.email`), `-probe.keep 1` (a relaunch
that reads what the last one left).

`LoginShotTests` photographs, in light and dark on an iPhone simulator: the password card, the
Google card, Use another account, the long-press menu, the keyboard up, and the Server sheet opened
by a double tap on the logo. It also drives the flows behind them — a Google card while the server
is asked and on a server without Google, Remove from this device (and a relaunch after it), another
domain's card from the Server sheet, and a real password sign-in against the stub: refused, then
accepted, then Sign out (revoked, account kept), then a refused sign-in as someone else that changes
nothing. On the Mac it photographs the same page and its right-click menu.

To run it: put `client.probe.yml` at `.github/workflows/client.yml` on a `probe/login-remember-account`
branch and push; the workflow copies this directory to `.lra-probe/` at the repository root and runs
`run.sh`. The report job pushes the pictures, notes and request logs to
`probe/login-remember-account-results`. Nothing here is a real account; all of it is made up.
