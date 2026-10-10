# Login page remembering the last account — simulator pictures

Real screens of the shared `LoginView` and `AppModel` on an iPhone 17 Pro simulator (iOS 26.5) and a
Mac window, taken on GitHub's `macos-26` runner by the probe in
`docs/evidence/login-remember-account/probe-harness/` (run
[38022499919](https://github.com/jianghailong-xy/orbit/actions/runs/38022499919), app code at
`a410403f7`). The app points at the probe's stub API (`-orbit.instance http://127.0.0.1:8765`), so the
card's third line names that domain, `127.0.0.1:8765`, where the board shows `orbitd.io`. Alex Morgan,
Sam Lee and the photo are made up. `compare.png` puts each board frame beside the light and dark
pictures.

## The surfaces on the board, light and dark

| Board | Pictures |
| --- | --- |
| ① a password account comes back: card, password, Sign In, Use another account | `1-password-card-{light,dark}.png` |
| ② a Google account comes back: card, only Continue with Google | `2-google-card-{light,dark}.png` |
| ③ Use another account: today's form, empty Email, "Sign in as Alex Morgan" | `3-another-account-{light,dark}.png` |
| ④ long press on the card: Remove from this device | `4-long-press-{light,dark}.png` |
| ⑤ keyboard up: the brand folds into one row above the card | `5-keyboard-up-{light,dark}.png` |
| logo double tap: the Server sheet | `6-server-sheet-{light,dark}.png` |
| the Mac window (same LoginView) | `8-mac-password-card-{light,dark}.png` |

## The flows behind them (light)

| Picture | What it shows |
| --- | --- |
| `1b-unknown-card-light.png` | An account recorded while signed in (no sign-in said how): password, Sign In, "or" and Google. |
| `2b-google-card-asking-light.png` | A Google card while the server is asked (the stub held its answer 8 s): the slot stays empty. |
| `2d-google-card-server-without-google-light.png` | A Google card on a server without Google: the password and Sign In instead. |
| `4b-removed-light.png` | After Remove from this device: the empty form, no "Sign in as". A relaunch shows the same pixels. |
| `6b-another-domain-light.png` | The Server sheet switched to `localhost:8765`: that domain's own last account (Sam Lee, Google). Switching back shows Alex Morgan's card again. |
| `7a-empty-form-with-the-pre-card-email-light.png` | No account remembered yet: the old `orbit.email` still fills the empty form. |
| `7b-failed-sign-in-remembers-nothing-light.png` | A wrong password against the stub: refused, nothing remembered. |
| `7c-after-sign-out-light.png` | The right password, then Sign out (the refresh token revoked): the card, with the photo the sign-in fetched. Its pixels equal `1-password-card-light.png`, which the probe seeded through the same store. |
| `7d-failed-sign-in-as-someone-else-light.png`, `7e-the-card-unchanged-light.png` | Use another account, a refused sign-in as bob@example.com, then "Sign in as Alex Morgan": the card is unchanged. |
| `7f-signed-in-from-the-card-light.png` | Signing in from the card: only the password typed; the stub logged the card's email on the card's domain. |
| `8b-mac-google-card-light.png`, `8c-mac-right-click-light.png`, `8d-mac-removed-light.png` | The Mac: a Google card, its right-click menu, and the empty form after Remove from this device. |

## Notes

- The long-press menu is iOS 26's own: the system places it (above the card here) and puts the icon
  first; the board drew an iOS 18 menu below the card.
- iOS keeps a password field's keyboard and dots out of the screenshots a UI test takes, so the two
  keyboard pictures are the simulator's own (`simctl io screenshot`). That is also why they show the
  Dynamic Island, which the other pictures don't.
