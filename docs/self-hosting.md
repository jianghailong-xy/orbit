# Self-hosting Orbit

This guide covers the included Docker Compose deployment: PostgreSQL, the control plane, web UI, backup
sidecar, and nginx gateway. It is a practical starting point for one trusted team. Production operators remain
responsible for TLS, host security, monitoring, and off-host backups.

For a fresh host, follow the [first-run checklist](first-run.md) through one completed task. Use the
[configuration reference](configuration.md) for defaults, secret handling, and rebuild/recreate requirements,
and [runner troubleshooting](runner-troubleshooting.md) when enrollment or execution fails.

## Requirements

- Docker Engine with the Compose plugin
- Enough CPU, memory, and disk to build the images and retain Postgres data
- A Linux host for the server deployment
- One or more runner machines with a supported runtime installed and authenticated

The server does not need the runtime credentials. Claude Code, Codex, Kimi, and OpenCode logins stay on the
runner machines.

The one exception is a Codex pool of one's own signed in with ChatGPT: the control plane runs the official codex
CLI's device-code sign-in (`codex login --device-auth`) itself and keeps that login encrypted with
`PROVIDER_SECRET_KEY`. The apiserver image ships the CLI, pinned in `src/apiserver/Dockerfile` to the version the
runners use, together with the CA certificates it verifies `auth.openai.com` with. A control plane run outside that
image needs the same: `codex` on its `PATH` (or its path in `CODEX_LOGIN_BIN`) and a system CA store. Point it at
the native binary, as the standalone installer does, rather than npm's Node wrapper, which cannot pass on the
SIGKILL that ends an abandoned sign-in.

## 1. Configure the deployment

```bash
git clone https://github.com/jianghailong-xy/orbit.git
cd orbit
cp .env.example .env
```

Set at least these values in `.env`:

```dotenv
JWT_SECRET="generate-a-unique-value"
PROVIDER_SECRET_KEY="generate-a-different-unique-value"
PUBLIC_ORIGIN="https://orbit.example.com"
```

Generate the two secrets independently:

```bash
openssl rand -base64 32
```

`JWT_SECRET` signs user authentication. `PROVIDER_SECRET_KEY` encrypts model-provider API keys at rest and is
required by the Compose service definition. Losing either secret can invalidate credentials or make stored
provider keys unreadable, so include the values in a protected secret backup. Do not commit `.env`.

Anyone who can read `JWT_SECRET` can mint an owner JWT. Consequently, an agent with host/container control
cannot be distinguished from a person merely by checking that JWT; Orbit's project `HUMAN_ONLY` actions are
then workflow boundaries with action-specific traceability, not proof of human presence. Keep runners and
agents away from the apiserver environment and Docker control socket when that distinction matters. See
[HUMAN_ONLY authority and credential trust](human-only-authority.md) for the exact guarantee and stronger
deployment options.

`PUBLIC_ORIGIN` is baked into the web image and runner install instructions. Set it before building and
rebuild the web image whenever it changes.

## 2. Start the stack

```bash
docker compose up -d --build
docker compose ps
```

The commit is embedded in the downloadable runner, read from the checkout at build time. Building
from a source archive, which carries no Git metadata, needs it named explicitly:
`ORBIT_SOURCE_SHA=<40-character commit> docker compose up -d --build`. Do not save it in `.env`,
where it would become stale after changing revisions.

By default, the gateway listens on <http://localhost:2086>. A fresh deployment redirects the first visitor to
`/setup`; that account becomes the initial administrator. Additional users are provisioned by an administrator.
There is no public self-service signup unless an administrator opens sign-up through
[Google sign-in](#google-sign-in).

Useful diagnostics:

```bash
docker compose ps
docker compose logs --tail=200 apiserver
docker compose logs --tail=200 gateway
```

## 3. Put HTTPS in front

The included gateway serves HTTP. Before exposing Orbit beyond a trusted local host:

- terminate TLS in a reverse proxy or load balancer;
- redirect HTTP to HTTPS;
- forward the original host and protocol headers;
- allow long-lived SSE responses without proxy buffering or a short idle timeout;
- restrict database and control-plane ports so only the gateway can reach them;
- set `PUBLIC_ORIGIN` to the exact external HTTPS origin and rebuild the web image.

Orbit can execute code with the runner account's privileges. Do not expose an instance to untrusted users or
attach a runner with broader credentials than its users should be able to exercise.

## 4. Register a runner

Open **Add a runner** in the web UI and use the generated command. It points at this deployment and enrolls
the machine through browser approval. A generic example is:

```bash
curl -fsSL https://orbit.example.com/install.sh | bash
```

Registration can attach routing labels and a concurrency limit:

```bash
curl -fsSL https://orbit.example.com/install.sh | bash -s -- \
  --labels linux,internal-network --max-concurrent 2
```

The installer can create a systemd or launchd service. Use `--foreground` for an interactive process, or set
`ORBIT_NO_REGISTER=1` to install only the binary. Run `orbit doctor` on the runner to diagnose missing runtime
installations or authentication.

Scripts can also act as a person rather than a machine. A user logs the `orbit` CLI in with a personal
access token, on a runner or on any other machine. `orbit login` opens the deployment's `/cli-login` page to
approve one, and `--with-token` takes one issued under **Settings → Access tokens**:

```bash
orbit login --server https://orbit.example.com
orbit login --with-token --server https://orbit.example.com < token.txt
orbit whoami
```

The binary this deployment serves already defaults to its own `PUBLIC_ORIGIN`, so `--server` can be left off
where it was installed from here. On a runner machine, have users script as an OS account other than the
runner service's: that service's agent sessions can read the account's saved login. See
[CLI automation](runner-cli.md#personal-access-tokens), including when to use a service token instead.

## 5. Back up and monitor

The Compose stack writes Postgres data to `./data/postgres`. A sidecar writes base backups and archived WAL to
`./data/pg-archive`.

- Set `ORBIT_BACKUP_SYNC_TARGET` (plus `ORBIT_BACKUP_SYNC_SSH_PORT` when it is not 22) so the sidecar mirrors
  `./data/pg-archive` to another host over ssh; give it a directory of its own, since the mirror deletes
  anything else there. A same-disk backup does not protect against disk or host loss.
- Periodically perform the verification procedure in the [backup and restore runbook](postgres-backup-restore.md).
- Monitor container health, free disk, failed backups, runner heartbeat status, and HTTP error rates.
- Decide an attachment/artifact retention policy appropriate for your deployment.

## Google sign-in

People can sign in with their Google account as well as with their email and password, on the web and in
the iOS, macOS and Android apps. It is off until an administrator sets it up, and while it is off no login page
offers it. Orbit uses one Google OAuth client of the **Web application** type for the web and the apps. It asks
Google only for `openid`, `email` and `profile`, and keeps no Google token.

The settings live in the database, not in `.env`: an administrator enters them in the web UI, and they apply
from the next request without a restart. What the deployment itself must provide:

- `PUBLIC_ORIGIN` set to the address people open Orbit at. Google sends the browser back to
  `${PUBLIC_ORIGIN}/api/auth/google/callback`, the redirect URI, which must equal the one registered with Google
  character for character.
- An address Google accepts in a redirect URI: `https`, on a domain name whose top-level domain is a public one.
  Google refuses raw IP addresses and private names such as `.local`. The one exception is `http://localhost`
  (see [Limits](#limits)). Orbit need not be reachable from the internet: Google sends the browser to the
  redirect URI and never calls it itself.
- Outbound HTTPS from the apiserver to `oauth2.googleapis.com`, and from people's browsers to
  `accounts.google.com`.

### Set it up

1. In Orbit, sign in as an administrator and open **Admin → Sign-in** (Admin is in the account menu). Copy the
   **Authorized redirect URI** it shows: `https://orbit.example.com/api/auth/google/callback` for
   `PUBLIC_ORIGIN="https://orbit.example.com"`. If it shows another origin, correct `PUBLIC_ORIGIN` first
   (see [Configure the deployment](#1-configure-the-deployment)).
2. In the [Google Cloud console](https://console.cloud.google.com/), select or create a project and open
   **Google Auth Platform**. A project that has not used it yet asks you to **Get started**: an app name (for
   example, Orbit), a support email, the audience and a contact email. Then:
   - **Audience**: **External** lets any Google account sign in. **Internal** admits only the accounts of your
     Google Workspace organization, and is offered only to a project in that organization.
   - **Branding**: under **Authorized domains**, add the domain of your deployment (`example.com` for
     `orbit.example.com`).
   - **Data access**: nothing to add. Orbit asks only for the basic sign-in scopes.
   - **Clients → Create client**: application type **Web application**. Under **Authorized redirect URIs**, add
     the URI from step 1. Leave **Authorized JavaScript origins** empty.
   - Copy the **Client ID** and the **Client secret** from the dialog that follows. Google shows the secret only
     there. If you lose it, add a new secret to the client and enter that one in Orbit.
3. Back in **Admin → Sign-in**, paste the **Client ID** and **Client secret**, switch on **Allow signing in with
   Google**, choose **Who can sign in with Google** (below), and **Save**. The badge beside **Google sign-in**
   turns to **On**: Google sign-in is on only while it is switched on and both the client ID and the secret are
   saved.
4. In a private window, open the login page: it now offers **Continue with Google**.

The client secret is encrypted with `PROVIDER_SECRET_KEY` and never shown again. Leave the field empty to keep
the saved secret, or paste a new one to replace it. After `PROVIDER_SECRET_KEY` changes, the saved secret can no
longer be read, although **Admin → Sign-in** still shows it as saved and the badge still says **On**: enter
the secret again.

### Who can sign in with Google

- **Existing accounts only**, the default, signs in people who already have an Orbit account. A Google account
  with none is refused, and its owner is told to ask an administrator. To let someone in, create their account
  in **Admin → Users** with the email address of their Google account. **Google sign-in only**, offered there
  while Google sign-in is on, creates the account without a password.
- **Anyone with a Google account** opens sign-up. A Google account with no Orbit account gets one at its first
  sign-in: a member with no password, named after its Google profile. The login page adds "New to Orbit?
  Continue with Google to create an account."

A Google account is known by Google's own account ID, not by its email address. Its first sign-in links it to
the Orbit account with the same email address (capitalization aside), but only when Google vouches for that
address: a Gmail address, or an account of a Google Workspace organization. Anyone else is told to sign in with
their password and connect Google on their **Profile** page (**Sign-in methods → Connect Google**). Give such
people a password, not **Google sign-in only**: an account without a password, whose address Google does not
vouch for, has no way in.

Switching back to **Existing accounts only** stops sign-ups at once. Accounts already created keep working.

Open sign-up turns a deployment built for one trusted team into one that strangers can join. Nobody approves
a sign-up and no confirmation email is sent; Google's verified email address is the only check. Before you
open it:

- A new member sees only their own runners, workspaces and tasks, and uses a provider pool only once its owner
  adds them. Model providers an administrator shared with all users are the exception: every account is
  offered them, and a session hands the provider's API key to the runner it runs on, which a new member can
  register themselves. Do not open sign-up on a deployment that has shared providers.
- Nothing limits how many accounts sign up, or what each one stores or runs.
- An administrator cannot suspend an account or keep one person out. Deleting an account fails while it owns
  runners, workspaces or tasks, and its owner can sign up again. Unlinking its Google account or resetting its
  password does not stop someone with a Gmail or Workspace address either: their next Google sign-in links the
  account again.
- **Admin → Users** shows how each account signs in and when it was created, so unexpected sign-ups stand out.

### Testing and publishing the Google app

A new External app starts in **Testing**, where Google normally admits only up to 100 listed test users. Google
[exempts](https://support.google.com/cloud/answer/15549945) apps that ask only for the basic sign-in scopes, as
Orbit does: any Google account can already sign in while the app is in Testing, without a warning screen. Do not
rely on the test-user list to decide who uses Orbit; the setting above decides that.

Publish the app (**Audience → Publish app**) before it serves people outside your team. Google requires an
External app in production to give home page and privacy policy links (**Branding → App domain**). It shows the
app's name and logo on its sign-in screen only once it has verified your brand, the ownership of your domains
included (**Branding → Verify branding**); until then it shows your domain. The basic sign-in scopes need no
other review.

### Limits

- For a trial on one machine, Google accepts `http://localhost`. Keep the default
  `PUBLIC_ORIGIN="http://localhost:2086"`, register `http://localhost:2086/api/auth/google/callback`, and open
  Orbit at exactly that address, through an SSH tunnel (`ssh -L 2086:localhost:2086 <host>`) when it runs on
  another machine.
- Open Orbit at the `PUBLIC_ORIGIN` address, in browsers and in the apps' server setting. A sign-in started at
  another address, such as an IP address or another host name, fails when Google sends the browser back to
  `PUBLIC_ORIGIN`: "That Google sign-in expired or was finished in a different browser."
- The web login page starts a Google sign-in only over HTTPS or on `localhost`.
- People whose network cannot reach Google keep signing in with their password, which stays available. The first
  administrator is always created at `/setup` with a password; Google sign-in refuses everyone until then.
- Signing out of Google, or losing the Google account, does not sign anyone out of Orbit: an Orbit session
  lasts as long as its refresh token, up to 30 days after last use.
- One client address may start 30 Google sign-ins a minute, and complete 30. The address is the one the
  gateway sees: behind a reverse proxy, the proxy's, so everybody shares that budget.

### Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| Google shows `Error 400: redirect_uri_mismatch` | The redirect URI registered on the client differs from the one **Admin → Sign-in** shows. |
| Google shows `Error 401: invalid_client` | The client ID is wrong. |
| Google shows `Error 401: deleted_client` | The client was deleted. Google deletes clients unused for six months; a deleted client can be restored within 30 days. |
| "Orbit couldn't confirm your sign-in with Google" | The apiserver log says why (below): most often a wrong client secret. |
| "That Google sign-in expired or was finished in a different browser" | The sign-in started at an address other than `PUBLIC_ORIGIN`, took more than ten minutes, or the browser blocked its cookie. |
| "Google sign-in is turned off on this Orbit server" | The switch is off, or the client ID or the secret is not saved. |

The apiserver logs why a sign-in failed after Google sent the browser back, under `GoogleSignIn`
(`docker compose logs apiserver | grep GoogleSignIn`). The lines carry Google's error code at most, nothing else
of the request:

- `Google's token endpoint refused the code: 401 invalid_client`: Google does not accept the client ID and
  secret together, most often because the secret is wrong or was replaced in the Google console.
- `Google's token endpoint could not be reached`: the apiserver has no route to `oauth2.googleapis.com`.
- `the saved Google client secret cannot be decrypted; an administrator must enter it again`: `PROVIDER_SECRET_KEY`
  changed since the secret was saved.
- `refused Google's ID token: its … claim did not pass`: the ID token Google returned does not fit this
  sign-in. The claim it names says how: `aud` names another client, and `exp` an expired token, which points
  at the apiserver's clock.

## Upgrading

Review the release notes and create a verified backup before upgrading. Then fetch and check out the desired
release tag or reviewed commit and rebuild the changed services:

```bash
git fetch --tags
git checkout <release-tag-or-reviewed-commit>
docker compose up -d --build
```

The control plane applies pending Prisma migrations on startup. Keep Postgres running unless the release notes
explicitly require a database change outside the normal migration path.

## Production checklist

- [ ] `JWT_SECRET` and `PROVIDER_SECRET_KEY` are unique, protected, and backed up.
- [ ] The public endpoint uses HTTPS and the configured origin matches it.
- [ ] Only the gateway is publicly reachable.
- [ ] The first administrator uses a strong password and user access is reviewed.
- [ ] Runner machines use least-privilege OS accounts and narrowly scoped credentials.
- [ ] Personal access tokens carry only the scopes, workspaces and lifetime their scripts need, and nobody
      scripts with one under a runner service's OS account.
- [ ] If Google sign-in is on, the Google app is published and who can sign in with Google is a deliberate
      choice.
- [ ] Backups are copied off-host and a restore has been tested.
- [ ] Container health, disk space, backup failures, and runner availability are monitored.
- [ ] The deployment is pinned to a known release or commit and has a documented upgrade cadence.
