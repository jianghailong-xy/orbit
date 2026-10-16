# Push registrations end with their login session

Status: implemented (migration 0425, 2026-10-15). Server only: no client changes.

## Problem

A `device_token` row lasts until a client removes it with `POST /api/push/unregister`, and the server
pushes to every row the account has. When that request does not get through, the server keeps
pushing to a signed-out device. That happens when the sign-out was made offline, or when the app was
forced to sign out because its login had already ended: its refresh token expired or was revoked, so
its access token is refused. iOS draws an alert push itself, so only the server can stop it.

## Login session

A login session is one sign-in and every refresh token rotated from it.

- `refresh_token.login_session_id` (uuid) names it. Every sign-in (password, first-run setup,
  Google) leaves through `AuthService.completeLogin`, which mints a new one. `refresh()` gives the
  token it issues the presented token's session, so a rotation stays in the same session.
- The access JWT carries it as `sid` (`{sub, email, sid}`). `JwtAuthGuard` hands it on as the
  `LOGIN` credential's `loginSessionId`.
- A session is **live** while one of its refresh tokens is neither revoked nor expired. There is no
  session table: the refresh tokens already record every way a session ends, so liveness is read
  from them and there is no second record to keep in step.

| What happens | Its refresh tokens | The session |
| --- | --- | --- |
| Refresh (rotation) | the presented token revoked, the next one issued with the same id | live |
| `POST /auth/logout` | the live token revoked | ended |
| A consumed token replayed (reuse detection) | every live token of its session revoked | that session ended; the account's others stand |
| Account disabled, or enabled again | every live token revoked, or every token deleted | ended |
| 30 days without a refresh | the live token expires | ended |

Reuse detection ends one session (2026-10-16). It used to revoke every live token of the account,
and that never settled once two devices were signed in. The other devices did not notice: their
access tokens kept working until `ACCESS_TOKEN_TTL` (7 days) ran out. Then each one's refresh
presented a revoked token, which was a replay in turn and ended every session signed in since. A
stolen token says nothing about the account's other sessions, so they stand.

## Registration

`POST /api/push/register` stores the caller's `sid` on `device_token.login_session_id` on every
registration. That covers a new row, an APNs token registered again (also when it moves to another
account), and the new binding an Android registration creates. Registering again is how a row moves
to a new session; the iOS app registers at every launch while signed in (`enablePush`).

## Push

`PushService.targets()` leaves out every row whose session is not live. `deliver()` asks the same in
the check it makes before each send and each FCM retry, so a sign-out that lands while a push is in
flight stops it too.

Rows are filtered at send time, not deleted when a session ends: expiry has no event to hook, and
filtering covers every revocation path without touching any of them. Such a row stays until the
device registers again, unregisters, or its account is deleted, and nothing is sent to it meanwhile.

## Compatibility

- A row with no session (`NULL`) is pushed to as before. It was registered before 0425, or with an
  access token signed before it, and it binds once the device registers with a token that has `sid`.
- A refresh token issued before 0425 has no session; its first rotation starts one. Replayed, it is
  refused and revokes nothing, since it names no session to end. An access token without `sid` still
  authenticates.
- Clients change nothing. Android's `registrationKey` contract and the iOS `{token}` unregister are
  unchanged, and unregistering is still how a client removes its binding at once.

## Not covered

- An offline sign-out does not revoke the refresh token either. That session stays live, and the
  device keeps receiving pushes, until it expires (at most 30 days after its last refresh) or the
  device registers under a new sign-in.
- Access tokens stay stateless: one from an ended session keeps working until `ACCESS_TOKEN_TTL`
  runs out. A registration made with it names the ended session, so it receives nothing.
- A rotation revokes the presented token before it writes the next one. For those few milliseconds
  the session has no live token, and a push sent in that window skips the device.

## Tests

`src/apiserver/src/push/push-login-session.pg.spec.ts` signs in through `AuthService`, registers
through `JwtAuthGuard` and `PushController`, and sends through `PushService` with the APNs and FCM
transports replaced, against a real PostgreSQL:

```sh
bash scripts/run-pg-spec.sh src/apiserver/src/push/push-login-session.pg.spec.ts
```

It holds that a device of a live session is pushed to, also across a rotation; that sign-out, expiry
and reuse detection each stop the pushes, and a sign-out that lands while an FCM send is in flight
stops that send; that reuse detection ends only the replayed token's session, so another sign-in
refreshes and is pushed to as before, and that a token from before sessions revokes nothing; that a
row with no session is still pushed to; and that registering again under a new sign-in brings the
device back.
