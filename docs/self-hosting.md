# Self-hosting Orbit

This guide covers the included Docker Compose deployment: PostgreSQL, the control plane, the wiki worker, web UI,
backup sidecar, and nginx gateway. It is a practical starting point for one trusted team. Production operators remain
responsible for TLS, host security, monitoring, and off-host backups.

For a fresh host, follow the [first-run checklist](first-run.md) through one completed task. Use the
[configuration reference](configuration.md) for defaults, secret handling, and rebuild/recreate requirements,
and [runner troubleshooting](runner-troubleshooting.md) when enrollment or execution fails.

## Requirements

- Docker Engine with the Compose plugin
- Enough CPU, memory, and disk to build the images and retain Postgres data
- A Linux host for the server deployment
- One or more runner machines with a supported runtime installed and authenticated, or room on this host for
  [managed runners](#managed-runners): by default 2 CPUs, 4 GiB of memory and a 20 GiB volume for each runner awake.
  Their [firewall](#isolation-and-its-limits) needs Docker run as root with its iptables firewall backend (the
  default), not rootless

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
```

For a new deployment, `scripts/install-server.sh` does the rest of this section and the next: it writes `.env`
with two independently generated secrets, prepares [managed runners](#managed-runners), firewalls their network on
this host, and starts the stack. Give it the external origin when you serve Orbit on a domain:

```bash
scripts/install-server.sh --public-origin https://orbit.example.com
```

It stops without changing anything where a `.env` or `data/postgres` already exists: that checkout holds a
deployment, which is [upgraded](#upgrading), never installed over. What follows is what it does, for configuring a
deployment by hand. A `.env` written by hand leaves managed runners off until it switches them on
([Turn them off or on](#turn-them-off-or-on)).

```bash
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

The install script has started it already. By hand:

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

To see Orbit as one of those users while helping them, an administrator opens **Admin → Users → View as**: Orbit as
that user sees it, read-only, for 30 minutes, under a band that says whose Orbit it is and offers **Exit**. The
reason asked for first is recorded with the account. Nothing can be changed while viewing, and administration and
stored keys stay out of reach. Your own account, another administrator's and a disabled one cannot be viewed, and
disabling either account ends the view.

Useful diagnostics:

```bash
docker compose ps
docker compose logs --tail=200 apiserver
docker compose logs --tail=200 gateway
docker compose logs --tail=200 wiki-worker
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

With managed runners on, every account is given a runner at sign-in, and this step is optional: register a machine
when the work needs that machine's repositories, network or credentials.

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
   turns to **On**: Google sign-in is on only while it is switched on, both the client ID and the secret are
   saved, and the saved secret can still be read with the deployment's `PROVIDER_SECRET_KEY`.
4. In a private window, open the login page: it now offers **Continue with Google**.

The client secret is encrypted with `PROVIDER_SECRET_KEY` and never shown again. Leave the field empty to keep
the saved secret, or paste a new one to replace it. After `PROVIDER_SECRET_KEY` changes, the saved secret can no
longer be read: **Admin → Sign-in** says the saved client secret cannot be decrypted, the badge reads **Off**
while the switch stays on, and no Google sign-in works until the secret is entered again.

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
  adds them. A model provider an administrator added for everyone (one with no owner, made through
  `/api/admin/providers`) runs administrators' sessions only. A session on a model provider hands the
  provider's API key to the runner it runs on, which a member registers themselves, so members are not
  offered these providers. A member who names one, or whose session, task or agent was already on one, is
  told it is available to admins only. To share an OpenAI API key with members, put it in a shared Codex pool
  and add them: their sessions reach the key through the control plane's pool gateway, and it never reaches
  their runners. No other kind of key can be shared with members.
- Nothing limits how many accounts sign up, or what each one stores or runs.
- To keep someone out, disable their account: **Admin → Users → Disable**. They are signed out everywhere and
  can no longer sign in, with their password or with Google, and their personal access tokens, runners and service
  tokens are refused, all within 30 seconds. A provider pool they own stops with them: within the same 30 seconds
  it serves nobody's sessions, on any of its API keys or ChatGPT accounts, including keys other people put in it.
  An API key or ChatGPT account they put in someone else's pool stops serving that pool, while its other keys and
  accounts carry on. A session refused this way is told whose account is disabled. Their Google account cannot
  sign up again: it stays linked to the disabled account. Nothing they own is deleted. **Enable** lets them back
  in: they sign in again, their personal access tokens and runners work as before, and their pools, keys and
  ChatGPT accounts serve again. You cannot disable your own account or the last
  administrator. Disable rather than delete: deleting an account still fails while it owns runners, workspaces or
  tasks.
- **Admin → Users** shows how each account signs in, when it was created and when it last used Orbit (in one of
  the apps or with an access token), so unexpected sign-ups and accounts nobody uses any more stand out. Search
  finds an account by name or email.

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
| **Admin → Sign-in** warns that the saved client secret cannot be decrypted; the badge reads **Off** while the switch is on | `PROVIDER_SECRET_KEY` changed since the secret was saved. Enter the client secret again under **Admin → Sign-in**. Until then Google sign-in fails. |
| "This Orbit account is disabled. Ask an administrator to enable it again." | An administrator disabled the account. **Admin → Users → Enable** lets it back in. |

The apiserver logs why a sign-in failed after Google sent the browser back, under `GoogleSignIn`
(`docker compose logs apiserver | grep GoogleSignIn`). The lines carry Google's error code at most, nothing else
of the request:

- `Google's token endpoint refused the code: 401 invalid_client`: Google does not accept the client ID and
  secret together, most often because the secret is wrong or was replaced in the Google console.
- `Google's token endpoint could not be reached`: the apiserver has no route to `oauth2.googleapis.com`.
- `the saved Google client secret cannot be decrypted; an administrator must enter it again`: `PROVIDER_SECRET_KEY`
  changed since the secret was saved. **Admin → Sign-in** reports it too, and asks for the secret again.
- `refused Google's ID token: its … claim did not pass`: the ID token Google returned does not fit this
  sign-in. The claim it names says how: `aud` names another client, and `exp` an expired token, which points
  at the apiserver's clock.

## Wiki System model

The `wiki-worker` service calls the wiki's System model: a model endpoint the deployment runs itself and that speaks
the Anthropic Messages API, such as vLLM. It runs the apiserver image with another command, serves no port, and
starts once the apiserver is healthy. It is the only service given the model's address and key; users' provider
keys, subscriptions and account pools are not used for it.

To configure it, set all three in `.env` and recreate the worker:

```dotenv
ORBIT_WIKI_MODEL_BASE_URL="http://192.168.1.20:8000"
ORBIT_WIKI_MODEL_API_KEY="the key the endpoint expects"
ORBIT_WIKI_MODEL="the model name it serves"
```

```bash
docker compose up -d wiki-worker
docker compose logs --tail=50 wiki-worker
```

The address must be reachable from inside the container, whose `127.0.0.1` is the container itself: for a model on
the Docker host, use the host's LAN or tunnel address. The worker probes `{base}/health` every 10 seconds (200 or 404
counts as up) and records the result. The wiki settings and health line show the model's name and its state, never
its address or key; if the endpoint refuses the key, correct it and recreate the worker. See the
[configuration reference](configuration.md#wiki-worker-and-system-model) for every variable. The worker runs every
account's wiki jobs with this model. To pause them, stop it with `docker compose stop wiki-worker`: the jobs wait in
the queue until it is started again.

## Runner link

Runners reach the control plane over HTTPS. The runner link is the connection that is to replace those requests: one
WebSocket per runner, to a link gateway that serves the runners of its cell. The gateway is part of this stack, as the
`link-gateway` service under the `runner-link` Compose profile, with the `nats` service beside it under the same
profile. Both run only where `.env` turns that profile on.

For now the link runs in shadow. Runners keep working over HTTPS. The gateway authenticates their connections, keeps
them alive, and compares the heartbeats and event batches runners mirror to it with what the HTTPS side received. It
forwards nothing to the control plane, so turning it off changes no runner's work. Once the link is switched over, the
gateway forwards each runner's requests, heartbeats and events to the apiserver's
[internal listener](#runner-link-calls), and its live stream to NATS while someone watches the session.

Whenever work waits for a runner (a queued session, a message in its inbox, or a sign-in, merge or update that its
heartbeat delivers), the apiserver also publishes a hint on NATS, on the subject of that runner alone. The gateway
subscribes for the runners it holds connections of and relays each hint to that runner. While the link runs in shadow,
hints are counted and not sent. NATS keeps nothing: no JetStream, no volume. It has no port on the host, and a hint lost
while it is down costs a runner one heartbeat interval. The apiserver publishes only while the connection tokens below
are configured, to `nats://nats:4222` unless `RUNNER_LINK_NATS_URL` names another server. With NATS unreachable, it
logs the hints it dropped once a minute and goes on. Session content crosses NATS too (the live stream, and the text a
turn has streamed so far), so NATS admits only the apiserver and the gateway, each by its own
[nkey](#nats-credentials).
[src/link-gateway/README.md](../src/link-gateway/README.md) describes the gateway in full.

### Connection tokens

Before it connects, a runner trades its runner token for a connection token, and the gateway refuses the tokens of
revoked credentials. Both come from the apiserver, which offers them only when all three of these are set in `.env`.
While they are not, those routes answer 404 and runners keep working over HTTP. A value that cannot be used leaves the
link off too, and the apiserver logs why when it starts:

```dotenv
RUNNER_LINK_SIGNING_KEY="base64 of an Ed25519 private key in PEM"
RUNNER_LINK_URL="wss://link.orbit.example.com"
RUNNER_LINK_GATEWAY_TOKEN="a secret only the gateway is given"
```

Generate the key and the secret. The gateway is given the public key and the secret, never the private key:

```bash
openssl genpkey -algorithm ed25519 -out runner-link.pem
base64 -w0 runner-link.pem                          # RUNNER_LINK_SIGNING_KEY
openssl pkey -in runner-link.pem -pubout | base64 -w0  # RUNNER_LINK_PUBLIC_KEY, for the gateway
openssl rand -base64 32                             # RUNNER_LINK_GATEWAY_TOKEN, at least 32 characters
```

Keep `runner-link.pem` with the deployment's other protected secrets, then recreate the apiserver and check its log:

```bash
docker compose up -d apiserver
docker compose logs --tail=50 apiserver | grep RunnerLink
```

How the tokens work:

- A runner calls `POST /api/runner/link-token` with its runner token and the process identity it heartbeats with.
  The token it gets back lasts one hour and names the runner, its account, its cell (`cell-1`, the only cell) and
  the address in `RUNNER_LINK_URL`, which the response repeats.
- Tokens are signed EdDSA over Ed25519 and name their key (`kid`, the public key's RFC 7638 thumbprint), so the
  gateway verifies them with the public key alone and can accept an old and a new key while the signing key is
  replaced. Tokens signed with the old key stop working within the hour.
- Deleting a runner, `orbit unregister`, rotating a runner's token and registering a runner again under the same
  name revoke every token minted with its old credential. The gateway reads `GET /api/runner/link-token/revocations`
  with `Authorization: Bearer <RUNNER_LINK_GATEWAY_TOKEN>` and refuses those tokens; one it has not yet heard of
  stops working when it expires.

### Runner link calls

Once the link carries the runners' work, the gateway calls the runner routes on the apiserver's behalf, through a
listener of their own that serves the gateway alone: every call must present `RUNNER_LINK_GATEWAY_TOKEN`, and only the
runner routes answer there. Compose sets it up:

```dotenv
RUNNER_LINK_INTERNAL_PORT=3001       # the listener's port; Compose's default
RUNNER_LINK_INTERNAL_HOST=0.0.0.0    # every interface of the apiserver's container; Compose's default
```

The listener opens only while the connection tokens above are configured; without them the apiserver logs
`runner link calls are not served: the runner link is off` and opens nothing. Inside its container, `0.0.0.0` means this
project's network: the gateway reaches it as `apiserver:3001` (its `LINK_INTERNAL_API_URLS`). **Never publish this
port** on the host or put it behind the web gateway. Outside Compose, the apiserver binds `127.0.0.1` unless
`RUNNER_LINK_INTERNAL_HOST` says otherwise; give it an address only the gateway's network reaches.

### NATS credentials

NATS admits two users, each by an nkey, an Ed25519 key pair: the apiserver, which publishes hints and reads live
streams, and the gateway, which reads hints and publishes live streams. `src/link-gateway/nats.conf`, which the `nats`
service reads, allows each nothing else, and a client without a key cannot connect. Make two pairs:

```bash
docker compose --profile runner-link build link-gateway
docker compose --profile runner-link run --rm --no-deps link-gateway nkey   # the apiserver's pair
docker compose --profile runner-link run --rm --no-deps link-gateway nkey   # the gateway's pair
```

Each run prints a new pair once, `seed=SU…` and `public=U…`, and keeps no copy. Put the four values in `.env`:

```dotenv
RUNNER_LINK_NATS_APISERVER_SEED=SU...   # the apiserver's seed: given to the apiserver alone
RUNNER_LINK_NATS_APISERVER_KEY=U...     # its public key: given to nats alone
RUNNER_LINK_NATS_GATEWAY_SEED=SU...     # the gateway's seed: given to the link gateway alone
RUNNER_LINK_NATS_GATEWAY_KEY=U...       # its public key: given to nats alone
```

A seed is a credential: keep it with the deployment's other secrets. To replace a pair, make a new one, set both its
values and recreate `apiserver` (or `link-gateway`) and `nats`.

What missing values look like:

- Either public key empty or unset: `nats` refuses to start, and `docker compose logs nats` says
  `User entry requires a user` (empty) or `variable reference for 'RUNNER_LINK_NATS_…_KEY' … can not be found`
  (unset). Hints, and the live stream once the link is switched over, stop; runners on HTTPS are not affected.
- The apiserver's seed unset: its log warns `RUNNER_LINK_NATS_SEED is not set` and then that NATS is unreachable
  (`Authorization Violation`); it drops hints and counts them.
- The gateway's seed unset: its log warns `LINK_NATS_SEED is not set`, `link_nats_connected` stays `0`, and no hint is
  relayed.

> **Upgrading a deployment that already runs the `runner-link` profile:** add the four values above to `.env` before
> you upgrade. From this release on, `nats` reads `src/link-gateway/nats.conf` and refuses to start without the two
> public keys, and the apiserver and the gateway connect only with their seeds.

### Deploy the link gateway

Runners connect to the gateway directly, on a host name and a port of its own. A proxying CDN or the web gateway
never stands between them: a CDN would terminate and inspect the connection, and its outages and limits would become
the link's. Set it up in this order.

1. **DNS.** Give the link a host name of its own, such as `link.orbit.example.com`, with an A or AAAA record for this
   host. Make the record **DNS only**: on Cloudflare, a grey cloud, not proxied. The web origin's own record stays as
   it is.
2. **Certificates.** Choose one way:
   - **ACME.** The gateway obtains a Let's Encrypt certificate on its first connection and renews it on its own. Set
     `RUNNER_LINK_ACME_DOMAINS` to the link's host name and `RUNNER_LINK_ACME_EMAIL` to a contact address. Its
     TLS-ALPN-01 challenge reaches the gateway on port 443, so set `RUNNER_LINK_PORT=443`. Certificates are kept in
     `RUNNER_LINK_GATEWAY_DIR/acme`.
   - **Files.** Put the certificate chain and its key in `RUNNER_LINK_GATEWAY_DIR/tls/fullchain.pem` and
     `RUNNER_LINK_GATEWAY_DIR/tls/privkey.pem`, from certbot, another ACME client or your own CA. Any port works.
     When the files change, the gateway loads them within 30 seconds without a restart, and open connections stay
     up. A certbot deploy hook that copies the renewed files there is enough. To load them at once, run
     `docker compose kill -s HUP link-gateway`.
3. **Firewall.**
   - Open TCP `RUNNER_LINK_PORT` to the internet: runners connect from wherever they are.
   - Leave the gateway's metrics port closed. Compose binds it to `127.0.0.1:RUNNER_LINK_METRICS_PORT` (9464).
   - Keep the web origin's rules: where it sits behind Cloudflare, it accepts only Cloudflare's address ranges. The
     link's port is a separate entrance and does not change them.
   - In ACME mode, the gateway needs outbound HTTPS to Let's Encrypt.
4. **Configure.** Add to `.env`, keeping any profiles `COMPOSE_PROFILES` already lists:

   ```dotenv
   COMPOSE_PROFILES=runner-link
   RUNNER_LINK_URL="wss://link.orbit.example.com"
   RUNNER_LINK_PUBLIC_KEY="base64 of the public key in PEM"
   RUNNER_LINK_GATEWAY_DIR=/srv/orbit/link-gateway
   RUNNER_LINK_PORT=443
   RUNNER_LINK_ACME_DOMAINS=link.orbit.example.com
   RUNNER_LINK_ACME_EMAIL=ops@example.com
   ```

   and the four [NATS credentials](#nats-credentials).

   `RUNNER_LINK_URL` carries the port when it is not 443, as in `wss://link.orbit.example.com:8443`. Create
   `RUNNER_LINK_GATEWAY_DIR` before starting, with `tls/` inside it when certificates come from files. The gateway
   runs as root in its container, with every capability dropped, so root-owned certificate files are readable.
5. **Start and check.**

   ```bash
   docker compose up -d --build apiserver link-gateway nats
   docker compose ps link-gateway nats
   docker compose logs --tail=50 link-gateway
   docker compose logs apiserver | grep RunnerHints
   curl -s http://127.0.0.1:9464/metrics | grep -E '^link_(connections|handshakes_total|revocation_fetches_total|nats_connected)'
   curl -sI https://link.orbit.example.com   # 426: the gateway speaks WebSocket only
   ```

   `link_revocation_fetches_total{result="ok"}` rising every 30 seconds shows that the gateway reads the apiserver
   with the right secret. `link_nats_connected 1`, and `connected to NATS` in the apiserver's log, show that hints flow,
   both clients signed in with their seeds. `runner link calls are served on 0.0.0.0:3001` in the apiserver's log shows
   the listener the gateway forwards to once the link is switched over.

### Operate the link gateway

- **Releases.** An upgrade, or `docker compose up -d --force-recreate link-gateway`, stops the gateway gracefully.
  It drains first:
  1. It refuses new connections.
  2. It tells its runners, in batches, to reconnect after a delay drawn at random within 30 seconds.
  3. It closes what is left within 80 seconds.

  Compose waits up to 90 seconds before it stops the container. Runners come back to the new gateway once it is up.
- **Certificate rotation.** In ACME mode it is automatic. With files, replace them. Either way,
  `link_tls_certificate_not_after_timestamp_seconds` shows the expiry of the certificate in use (files mode).
- **Replacing the signing key.**
  1. Give the gateway both public keys, comma-separated (`RUNNER_LINK_PUBLIC_KEY="<old>,<new>"`), and recreate it.
  2. Switch the apiserver to the new `RUNNER_LINK_SIGNING_KEY`.
  3. After an hour, when every old token has expired, drop the old public key.
- **Monitoring.** `/metrics` on the metrics port counts connections, handshakes by result and their duration,
  disconnects by reason, ping round trips, token refusals by reason, revocation reads, the shadow comparison, and
  hints by kind and by what became of them. Once the link is switched over it also counts forwarded calls by result and
  their latency, retries across apiserver instances, events stored and their acknowledgement latency, the ingest queue
  and the credit it grants, the live stream by what became of it, and frames dropped or connections closed for slow
  reading.
  [The gateway's README](../src/link-gateway/README.md#metrics) lists them all.
- **Logs.** `docker compose logs link-gateway` shows one line per connection event. Set `LINK_FRAME_LOG=all` in the
  service's environment to log a summary of every frame, too. The gateway decodes frames that it or a runner logged:
  `docker compose logs link-gateway | docker compose exec -T link-gateway /link-gateway dump`.
- **Turning it off.** Remove `runner-link` from `COMPOSE_PROFILES`, then run
  `docker compose stop link-gateway nats && docker compose rm -f link-gateway nats`. Runners keep working over HTTPS.

## Large deployments

The stack as installed runs one apiserver, which is enough for a team. Once runners work over the
[runner link](#runner-link), a deployment the size of a link cell needs more than that. A cell is up to 10,000
people, with 15,000 runner connections. Its runners' heartbeats, events and live streams alone keep several Node
processes and a database host of its own busy.

### The cell's size

The cell's load at its peak:

- 15,000 connections;
- 500 heartbeats a second, a quarter of them reconciled in full (an estimate for production's commands and changes);
- 2,000 durable events a second;
- 10,000 live deltas a second, forwarded to whoever watches.

The sizes below are what each operation costs on the runner link's load test, measured at a fifth of that and projected
linearly. [The load test's README](../scripts/runner-link/README.md#the-cells-size) gives the measurements, the
arithmetic, and how to repeat both.

| Part | For a cell | What it carries at the peak |
| --- | --- | --- |
| Link gateway | 3 nodes, each 2 cores and 4 GB, behind a TCP (layer 4) load balancer | 5,000 connections each, 7,500 with one node down (about 1.4 GB of connections); about 0.4 cores across the cell |
| apiservers | 4 processes, each 2 GB | The runners' calls: about 1.8 cores at the peak, spread evenly. Each process's main thread is 41% busy, 54% with one of them down. The live relay adds about 0.4 cores, spread too: 52% busy, 70% with one down (see below). The first one also takes people's other requests. |
| Database | 8 cores, 32 GB of memory, its own fast disk | 4.2 cores at its 10-second peak, 53% of its cores |
| NATS | 1 node, 1 core | Hints, and the live stream |

- **The apiservers' limit is the main thread.** It does nine tenths of a process's work, so a process carries about one
  core. The count leaves room for one process to fail: three carry the peak at 54%.
- **Losing a gateway node.** Its 5,000 runners reconnect to the other two, which let in 200 handshakes a second each.
  For about 13 seconds that adds up to 1.9 apiserver cores and 3.5 database cores, while each connection's first
  heartbeat is reconciled in full. The database then runs near its 8 cores; about 13 would keep even that under 60%.
- **Commands and changes.** A heartbeat costs the database 0.63 ms, or 6.37 ms when it is reconciled in full: when
  something it delivers changed (a merge, a commit, a sign-in, a cancellation), and at least every five minutes. Each
  percent of beats reconciled in full adds about 0.03 database cores.
- **The database's disk and memory.** On the load test's sessions an event takes about 1.5 KB stored (its row, its tool
  call and their indexes) and about 5.7 KB of WAL. At 4,000 events a person a day that is about 60 GB of tables and
  230 GB of WAL a day for a cell, before the archive compresses it. Size the disk and the WAL archive for that.
  - Raise `max_wal_size` to 8 GB or more. At the default 1 GB the peak's WAL forces a checkpoint every 90 seconds or
    so, each followed by full-page writes. With 8 GB, checkpoints wait for `checkpoint_timeout` (5 minutes).
  - Give `shared_buffers` a quarter of the memory.
- **A failover must not lose an acknowledged commit.** A runner lets go of its copy of a batch of events once their
  acknowledgement arrives, so an event the database acknowledged exists nowhere else. An asynchronous standby can lose
  the last moments' commits when it takes over. A cell's database needs one of these:
  - a synchronous standby: `synchronous_commit = on`, with the standby named in `synchronous_standby_names`;
  - two standbys and a quorum (`ANY 1 (...)`), so that losing one standby does not stop commits;
  - a managed database whose failover keeps every acknowledged commit.

  Keep the standby near, since every commit that writes events waits for it.
- **The live relay** is spread over every apiserver, with the session streams it feeds (the web gateway's routes under
  [Several apiservers](#several-apiservers)).
  - **Its cost** is an order-of-magnitude estimate: every run that could have measured it cleanly on the test host was
    voided by the host's swapping. Each delta forwarded to a watcher costs about 0.04 ms of CPU on the apiserver that
    holds the session's streams, which comes to 0.4 cores at 10,000 a second. Each delta reached its watcher about
    105 ms after it was produced (p99): two 50 ms gatherings, the runner's and the stream's.
  - **Why it is spread.** On one apiserver it does not fit. With every stream on the first apiserver, its main thread
    would be about 87% busy at the peak, with its share of the runners' calls. A test on a slower host measured it: at
    a cell's live rate, the first apiserver's main thread was 98% busy and the others' about 40%. Every delta still
    reached its watcher, but the other work of that process waited, the link tokens it alone signed among it.
- **Not measured here:** people's own requests (web and apps), which go to the first apiserver, their session streams
  apart; and what each apiserver's own background work costs the database. Each process's figures leave room for them.

### Several apiservers

An apiserver is one Node process, and its main thread is what fills first. The link gateway can spread the runners'
calls over several apiservers. It sends each call, whether a request, a heartbeat or an event batch, to the next
apiserver in `LINK_INTERNAL_API_URLS`. A call that is safe to send again goes to the next apiserver when one cannot be
reached.

The web gateway sends two kinds of request to every apiserver, once the deployment mounts its routes for several
apiservers (below):

- **Session streams** (`GET /api/sessions/:id/events`, the transcript a person watches as it is written), by session.
- **Link tokens** (`POST /api/runner/link-token`), to the apiserver with the fewest requests in flight. A runner asks for
  one when it connects and about once an hour after, and every runner asks at once when they all restart after a
  release.

It sends everything else a person does to the first apiserver. A Codex "Sign in with ChatGPT" runs its sign-in in the
process that started it, so all of one person's other requests must reach that same process.

**Only where the link carries the runners' work.** Run several apiservers in a cell whose runners work over the
[runner link](#runner-link), with `RUNNER_LINK_REQUIRED` on. A runner that works over HTTPS posts the deltas of its
replies to the first apiserver, which hands them to its own streams alone. A stream on another apiserver then shows
that runner's replies only as each one is stored, not as it is written. Until the switch is on, the link gateway runs
in shadow and forwards nothing, so the other apiservers would carry no runner calls anyway.

Add the other apiservers in `docker-compose.override.yml` beside `docker-compose.yml`. Compose reads the file with
every command run in the checkout:

```yaml
# docker-compose.override.yml: a second apiserver (docs/self-hosting.md, "Several apiservers").
services:
  apiserver-2:
    extends:
      file: docker-compose.yml
      service: apiserver
    build: !reset null
    container_name: orbit-apiserver-2
    depends_on:
      postgres:
        condition: service_healthy
      apiserver:
        condition: service_healthy
  gateway:
    volumes:
      - ./gateway/several-apiservers:/etc/nginx/several-apiservers:ro
  link-gateway:
    environment:
      LINK_INTERNAL_API_URLS: "http://apiserver:${RUNNER_LINK_INTERNAL_PORT:-3001},http://apiserver-2:${RUNNER_LINK_INTERNAL_PORT:-3001}"
```

- **`extends`** gives `apiserver-2` the first apiserver's whole definition: its image, environment, mounts, network
  name and health check. It builds nothing and runs the image the first one builds.
- **Migrations.** It starts only once the first apiserver is healthy. So the first applies any pending migrations, and
  the second finds none: its log says `No pending migrations to apply`.
- **The web gateway's routes** are the two files in `gateway/several-apiservers/`. `gateway/nginx.conf` includes them
  only where that directory is mounted, so a deployment that does not mount it sends every request to the first
  apiserver. They reach the apiservers by `orbit-apiservers`, a name that `docker-compose.yml` gives the apiserver and
  that `apiserver-2` takes with the rest of its definition. The web gateway looks the name up every 10 seconds.
  `apiserver` still names the first apiserver alone.
- **More apiservers.** For a third and more, repeat the `apiserver-2` block as `apiserver-3` and on, and add each one
  to `LINK_INTERNAL_API_URLS`. Keep the first apiserver in the list. The web gateway finds them by their shared name.

**The routes need nginx 1.27.3 or later in the web gateway.** They use upstream `resolve`, which older versions do
not have, and an nginx that cannot read its configuration does not start: the gateway would serve nothing. A deployment
keeps the `nginx:alpine` image it first pulled, since upgrades refresh it only with `--pull-base`. So check the version
before you add the gateway's lines, and pull a newer image if it is older:

```bash
docker compose exec gateway nginx -v      # nginx version: nginx/1.27.3 or later
docker compose pull gateway
```

An older nginx refuses the routes with `"resolver" directive is not allowed here`. `gateway/nginx.conf` alone loads on
any version.

Start the new apiservers, and recreate both gateways so that they read the new settings:

```bash
docker compose up -d --wait apiserver-2 link-gateway gateway
docker compose ps apiserver apiserver-2 link-gateway gateway
docker compose logs apiserver-2 | grep -E 'pending migrations|runner link calls are served'
```

**How the session streams are spread:**

- **By session.** The web gateway hashes the session's id in the stream's address, so all of one session's streams,
  from every tab and device, reach one apiserver while the set of apiservers stays the same. That apiserver alone
  subscribes to the session's live stream on NATS and relays its deltas. The apps address a session by its public id;
  a stream addressed by its UUID can reach another apiserver, which costs that apiserver a subscription of its own.
- **When the set changes.** When an apiserver is added or stops, some sessions move to another apiserver, each when its
  stream next connects. A stream already open stays where it is.
- **When an apiserver stops.** Its streams end, and the clients open them again on the others: the web gateway gives up
  on the stopped one after 2 seconds, then leaves it out. Each stream picks up from the last stored event it had, and
  the deltas go on.
- **Who watches.** Each apiserver tells the link gateway how many streams it has of each session, and the gateway adds
  the counts up. The count of an apiserver that stopped lapses after 60 seconds.

**Turning the switch off.** Before turning `RUNNER_LINK_REQUIRED` off, put every session stream back on the first
apiserver, where runners that go back to HTTPS post their deltas. Either remove the gateway's lines from
`docker-compose.override.yml` and run `docker compose up -d gateway`, or stop the other apiservers with
`docker compose stop apiserver-2`. Then turn the switch off ([the design's rollback](runner-link-design.md#114-回滚)).

This was tested with Docker Compose v5.5.1. Versions have treated `extends` from a service with `depends_on`
differently. `docker compose config apiserver-2` should list both `postgres` and `apiserver` under its `depends_on`.

**Upgrades.** [Upgrading](#upgrading) with `docker compose up -d --build` recreates the other apiservers too, because
their image is the one it rebuilt. So does `/upgrade`'s script. It finds them among the services Compose lists, by
their names (`apiserver-` and a number), and recreates them once the first apiserver has applied the migrations and is
healthy. Until then they run the old code against the schema the first apiserver has just migrated.

**Background jobs.** Most background jobs run in every apiserver. They coordinate through the database, so with
several processes they repeat work but do nothing twice:

- watches, open items and managed runners;
- scheduled wakeups and session requests;
- mentions and claims.

**The reaper, the task scheduler's sweep and the auto-retry sweep** run in one apiserver at a time:

- **Which one.** The one that holds a PostgreSQL advisory lock, on a connection of its own. Its log says
  `now runs the reaper, the task sweep and the auto-retry sweep`. The others ask for the lock every 5 seconds.
- **Takeover.** When that apiserver stops or loses the database, the lock is released with its connection, and another
  apiserver takes it within a few seconds. For its first 3 minutes the new one reaps no session for a silent runner,
  as an apiserver that has just started does.
- **Heartbeats another apiserver could not write.** Each apiserver records in the `apiserver_process` table when it last
  failed to write a runner's heartbeat, and reports there every 10 seconds. The reaper reads every other apiserver's
  row. So it reaps no session for a silent runner while another apiserver's heartbeat writes are failing, or while
  another apiserver has stopped reporting.

**Antigravity's pasted sign-in code and the Cursor key check** are held in the memory of the apiserver that took them.
The apiserver a runner's heartbeat lands on asks that one for them over the runner link's NATS, so they reach the runner
whichever apiserver the link gateway hands its heartbeats to.

### Database connections

Each apiserver process opens at most 12 connections to PostgreSQL:

- ten are its pool (node-postgres's default, which the apiserver keeps);
- one listens for the notices the processes send each other;
- one holds the locks that decide which apiserver runs the reaper and the other sweeps above.

The wiki worker opens as many: its pool of ten, and a listener for each of its two queues.

So N apiservers and the wiki worker need up to 12 × (N + 1) connections, and the backup sidecar and anyone working
in `psql` a few more. The default `max_connections` is 100, which is reached at about seven apiservers. Raise it,
then restart PostgreSQL:

```bash
docker compose exec postgres psql -U orbit -d orbit -c "ALTER SYSTEM SET max_connections = 200"
docker compose restart postgres
```

`ALTER SYSTEM` writes `postgresql.auto.conf` in the data directory, so the setting stays until it is reset.

**Pool in session mode only.** The apiserver sends its most frequent statement, the runner link heartbeat's, as a
named prepared statement. It is prepared once on each connection and reused after that.

- A pooler in **transaction mode** (PgBouncer's `pool_mode = transaction`) hands each transaction whichever server
  connection is free, and that connection may never have prepared the statement. Never put the apiservers behind one.
- **Connect them directly, or through a pooler in session mode**, which gives each client connection one server
  connection for as long as it lasts.

**If the database runs hot.** Every statement is sent unnamed except that heartbeat statement and any others marked
the same way (`PREPARED_STATEMENT` in `src/apiserver/src/prisma/prisma-client.ts`). PostgreSQL then parses and plans
each unnamed statement every time it runs, at about 0.21 ms of database CPU each. Naming more statements is the first
optimization left. Only statements whose text is fixed can be named:

- **First: the merged event call's five fixed statements.** They run once per call, not per event, and save about
  0.02–0.05 ms of database CPU per event: 0.04–0.1 cores at a cell's 2,000 events a second.
- **Statements whose text varies with the batch** must be rewritten to fixed text first, with arrays as parameters,
  before they can be named. These are the event insert, the session updates, and the tool-call writes. Their parse
  and plan are most of what is left of an event's database cost.

## Managed runners

A new deployment gives every account a runner of its own, so nobody has to register a machine before a first
session. It is a container on this host's Docker, given when the account signs in, with a data volume that keeps
its checkouts, sessions and engine sign-ins. After an hour with nothing to do it sleeps: the container stops and
the volume stays. A new message, a task that can run or a scheduled wakeup starts it again, on the same volume.
Runners that people register themselves keep working beside it.

### What the install sets up

`scripts/install-server.sh` prepares managed runners, then writes three lines into `.env`:

```dotenv
ORBIT_MANAGED_RUNNERS_ENABLED=true
ORBIT_MANAGED_RUNNERS_DIR=./data/managed-runners
COMPOSE_PROFILES=managed-runners-docker,managed-runner-firewall
```

- **The switch.** `ORBIT_MANAGED_RUNNERS_ENABLED=true` turns managed runners on in the apiserver. Absent, empty or
  `false` is off, and so is any other value, with a warning in the apiserver's log.
- **The Docker backend.** The `managed-runners-docker` Compose profile starts `docker-channel`, the
  [restricted Docker channel](../deploy/managed-runner/docker-channel/README.md): the only process given the Docker
  socket. It makes each runner's container and volume from its own template and touches nothing it did not make.
  The apiserver reaches it through a socket in `data/managed-runners` and is never given the Docker socket.
- **Their files.** `data/managed-runners` (mode 0700) holds the channel's token, its configuration
  (`channel.json`) and the apiserver's managed runner profile (`profile.json`, `"backend": "docker"`). The profile
  gives each runner 2 CPUs, 4 GiB of memory with its `/tmp` counted in it, 4096 processes and a 20 GiB volume, and
  the channel refuses anything above its own ceilings. The pool is what this host has, less a quarter of its CPU
  and memory and a tenth of the disk Docker's volumes live on, whichever filesystem the checkout is on; a runner
  that does not fit waits until another one sleeps. The channel also makes no more containers than one per CPU and
  per GiB of this host's memory, whichever is fewer, and deletes no volume unless an operator turns that on. To
  change these, edit both files and run `docker compose up -d --force-recreate docker-channel apiserver`
  ([where each setting lives](managed-runner-docker-operations.md#where-each-setting-lives)).
- **The image.** The script builds the managed runner image from
  [deploy/managed-runner/image](../deploy/managed-runner/image/Dockerfile) on this host, as
  `orbit-managed-runner:local`, and pushes it nowhere. Both files name it by its local image ID. To use an image
  built elsewhere from a commit you reviewed, load it with `docker load` and pass `--managed-runner-image <image>`.
- **Their network.** `orbit-managed-runners`, an IPv4-only bridge network on which containers cannot reach one
  another. A runner reaches the internet (its model's endpoint, Git hosts) and reaches this deployment the way a
  runner on another machine does: through the gateway's published port 2086, at the host's address on that network.
  It reaches neither another runner nor the stack's own containers.
- **Their firewall.** The `managed-runner-firewall` Compose profile starts `managed-runner-firewall`, which keeps rules
  on this host's iptables for that network: a runner reaches the gateway's port, DNS and public addresses, and nothing
  else of this host or the private networks behind it ([Isolation and its limits](#isolation-and-its-limits)). Before
  writing anything the install checks that this host can carry the rules; then it applies them once and checks from
  the network that this host and a private address are refused and that DNS still resolves, and once the stack is up
  that the gateway's port is reached. Where any of that fails it stops and says why.
- **Their server address.** `profile.json` gives each runner `http://<gateway of orbit-managed-runners>:2086`. A
  runner sends its credential with every request, and a managed runner accepts plain HTTP to any private address,
  so keep `runner.serverUrl` on this host's own address on that network, or make it `https://`. Never point it at
  another machine over plain HTTP, a LAN address included.

The first account, the administrator created at `/setup`, is given its runner when it signs in. The runner takes
sessions once a runtime is signed in on it; until then it reports that none is installed and signed in.
`--no-managed-runners` installs with `ORBIT_MANAGED_RUNNERS_ENABLED=false` and prepares none of the above.
`--no-managed-runner-firewall` installs managed runners without their firewall and leaves this host's firewall alone:
`COMPOSE_PROFILES` then names `managed-runners-docker` alone, `.env` carries a note that the firewall is off, and the
install says so as it starts and as it ends. Read [Isolation and its limits](#isolation-and-its-limits) before
choosing it.

### Who gets one

Every account, including the ones open sign-up creates ("Anyone with a Google account" under
[Who can sign in with Google](#who-can-sign-in-with-google)), except a disabled one. Disabling an account
(**Admin → Users → Disable**) stops its runner from being given, started or woken, and puts a running one to sleep
with its volume kept.

### Isolation and its limits

Read this before opening sign-up on a deployment with managed runners. A managed runner is a container, and every
container shares this host's kernel: with every other managed runner and with the Orbit stack itself. The channel
makes each one from the same template: an unprivileged user, every capability dropped, no privilege escalation, a
read-only root filesystem, limits on CPU, memory, processes and disk, no host directory and no Docker socket. Its
`/tmp` is executable, as builds and `go test` need, and `nosuid` and `nodev`; on Docker older than 27 it stays
`noexec`.
Managed runners cannot reach one another on their network. That keeps honest users apart and contains their
mistakes. It is not a strong boundary against a malicious user: a flaw in the kernel or the container runtime lets
code in one container reach the host, other people's runners and data, and this deployment's secrets. Where anyone
can sign up, that risk comes with the deployment, and accepting it is the deployer's decision. Where it is not
acceptable, switch managed runners off or keep sign-up to people you trust.

Without a firewall, a runner can also reach every service this host listens to on an address other than loopback
(sshd and rpcbind, on the host task D5 measured), and through the host the private network it sits on. So the install
firewalls the managed runners' network on this host: from it a runner reaches the gateway's published port at the
network's gateway address (how it reaches this deployment), DNS, and public addresses. Every other port of this host,
on any of its addresses, is refused, and so are private (10/8, 172.16/12, 192.168/16), shared (100.64/10), link-local
(169.254/16, the cloud metadata address among them), loopback and reserved addresses behind it, and anything IPv6.
The rules match only traffic from that network's bridge: no other container and no service of this host is affected.
`managed-runner-firewall` keeps them: it checks them every 10 seconds, writes again what changed, and writes them anew
after this host restarts; Docker's own restarts leave them in place. The Docker channel starts no runner container
while the firewall does not report them in force, so a runner never starts unprotected. What a runner reaches, how to
check the rules, let runners reach an internal model endpoint, turn the firewall off and remove its rules:
[the managed runners' firewall](managed-runner-docker-operations.md#the-managed-runners-firewall).

The firewall needs Docker's iptables (or iptables with firewalld) firewall backend, nft or legacy iptables underneath,
and Docker run as root. With rootless Docker, Docker's nftables backend, or `"iptables": false`, the install stops
before it writes anything. A cloud provider's firewall or security groups are neither changed nor needed. The firewall
decides where a runner's packets may go; it is not a boundary against a flaw in the kernel or the container runtime,
which the paragraph above is about.

Installing with `--no-managed-runner-firewall`, or turning the firewall off later, gives every account's runner this
host's services and the private networks behind it again: anyone who can sign in can probe and reach them from code
in their runner. Choose it only where those are firewalled otherwise, or where every account is trusted with them.

### Turn them off or on

Managed runners are switched in `.env`, and only there. An upgrade never writes these lines.

- **Off:** set `ORBIT_MANAGED_RUNNERS_ENABLED=false` and recreate the apiserver with `docker compose up -d apiserver`.
  From then on no account is given a runner, and none is started or woken. Nothing is stopped or deleted: a runner
  that is running keeps running, every volume stays, and switching them on again carries on from where they were.
- **On again:** set `ORBIT_MANAGED_RUNNERS_ENABLED=true` and run `docker compose up -d apiserver`.
- **On, for a deployment installed without them:** every deployment installed before managed runners existed, and
  one installed with `--no-managed-runners`. Upgrade it first, then, from its checkout:

  ```bash
  scripts/install-server.sh --enable-managed-runners
  ```

  This prepares managed runners as a fresh install does, their firewall included, writes the three lines into `.env`
  (replacing an `ORBIT_MANAGED_RUNNERS_ENABLED=false` line and leaving every other line as it was), starts
  `managed-runner-firewall` and `docker-channel`, and recreates the apiserver from the image it already runs. Add
  `--no-managed-runner-firewall` to leave this host's firewall alone.
- **Their firewall, for a deployment that has managed runners without it:** one installed before the firewall
  existed, or with `--no-managed-runner-firewall`. Upgrade it first, then run
  `scripts/install-server.sh --enable-managed-runner-firewall`. Turning the firewall off and removing its rules are in
  [the runbook](managed-runner-docker-operations.md#turn-it-off).

### What an upgrade does

An upgrade (the `/upgrade` skill's script, or the steps under [Upgrading](#upgrading)) never writes `.env`, so
managed runners stay as they were: off on a deployment whose `.env` does not switch them on, which is every
deployment installed before them. There `/upgrade` builds and recreates exactly what it did before managed runners
existed, and writes nothing under `data/`.

`/upgrade` never builds, starts or recreates `managed-runner-firewall`, and changes no rule on this host's firewall:
a deployment without the firewall gets none, and one with it keeps its service and rules as they were. Add it to a
deployment with `scripts/install-server.sh --enable-managed-runner-firewall`.

Where `.env` turns on the `managed-runners-docker` profile, `/upgrade` also keeps the managed runners current. The
runner in their image never updates itself, so each upgrade:

1. stops before building anything unless `channel.json` and `profile.json` are in the managed runners' directory,
   as Compose binds it into `docker-channel`;
2. rebuilds `docker-channel` with the other images, then the managed runner image from this checkout, as
   `orbit-managed-runner:local`, on this host and pushed nowhere;
3. when the image ID is new, writes it into both files (the channel's `image`, the profile's `runner.image`), each
   file replaced whole by a rename;
4. recreates the other services, then the apiserver if that did not recreate it, and with it any
   [other apiservers](#several-apiservers), then `docker-channel`, last. Both read their file only as they start.
   Until the channel serves the image the apiserver's profile names, the apiserver starts no runner and only waits;
   in the other order, a channel already on the new image would refuse the previous apiserver and fail a runner it
   was starting.

Nothing a managed runner is doing is interrupted. A container keeps the image it was made from: the upgrade does not
stop, drain or restart it, and the channel still reads, stops and removes containers of the previous image. Each
runner moves to the new image with its next container, the one the wake after its next sleep makes, on the same
volume and with the same runner. A sleep comes after an hour with nothing to do, or sooner when its owner asks for
one through the API (`POST /api/managed-runner/sleep`), and only while nothing runs on it; one container per volume
and the stop proof are as for any sleep. A container of the previous image that was made and never started is never started: the
channel removes it and makes a new one from the current image.

`/upgrade` deletes no image, and Docker keeps whatever a container still runs. What happens to the previous image
then depends on Docker's image store:

- In the containerd image store, which a fresh Docker 29 uses (`docker info` lists `io.containerd.snapshotter.v1`),
  the previous image loses its name as soon as the new one takes the tag: `docker image ls` no longer shows it and
  nothing new can be made from it, but containers made from it keep running on it, and its storage goes when the
  last of them is removed. Nothing is left to delete.
- In the classic store it stays as an untagged image. Docker refuses to remove it while any container, running or
  stopped, was made from it, and `/upgrade --prune` (`docker image prune -f`) removes it once none is.

Either way it is gone once every runner has slept once. To see which runners still run a previous image, list the
managed runner containers with their images:

```bash
docker ps -a --filter label=orbit.managed-runner.instance --format '{{.Names}} {{.Image}}'
```

The layers of every image an upgrade rebuilds also stay in Docker's build cache until `docker builder prune`.

If an upgrade stops between writing the files and starting both services on them, `data/managed-runners/.image-switch`
names the image, and the next `/upgrade` starts the apiserver and the channel again whatever it builds.

Every new commit gives a new image, since the image is stamped with the commit it was built from, and so a few
minutes of building on each upgrade: the build's package step runs again, which needs the network.

Each runner's data is on a Docker volume, `mr-data-<runner id>`, on this host's disk alone. The Postgres backups
above do not include it, and neither switching managed runners off nor disabling an account deletes it. Back the
volumes up, restore them, and handle a full disk, a memory limit, a channel or apiserver outage and a host restart as
[Managed runners on Docker: backup, restore and failure handling](managed-runner-docker-operations.md) describes.

## Upgrading

Review the release notes and create a verified backup before upgrading. Then fetch and check out the desired
release tag or reviewed commit and rebuild the changed services:

```bash
git fetch --tags
git checkout <release-tag-or-reviewed-commit>
docker compose up -d --build
```

The control plane applies pending Prisma migrations on startup, and `wiki-worker`, which runs the same image,
starts once it is healthy. Keep Postgres running unless the release notes explicitly require a database change
outside the normal migration path. An upgrade leaves `.env`, and with it [managed runners](#what-an-upgrade-does),
as it was.

These steps leave the managed runner image as it was. On a deployment with managed runners, upgrade with
`/upgrade`'s script (`.claude/skills/upgrade/upgrade.sh`), which also rebuilds that image and switches to it, or do
its steps after the ones above:

```bash
docker build -f deploy/managed-runner/image/Dockerfile --build-arg "ORBIT_SOURCE_SHA=$(git rev-parse HEAD)" \
  -t orbit-managed-runner:local .
docker image inspect -f '{{.Id}}' orbit-managed-runner:local
# Write that ID as "image" in data/managed-runners/channel.json and as runner.image in profile.json, then:
docker compose up -d --wait --no-deps --force-recreate apiserver
docker compose up -d --wait --no-deps --force-recreate docker-channel
```

## Production checklist

- [ ] `JWT_SECRET` and `PROVIDER_SECRET_KEY` are unique, protected, and backed up.
- [ ] The runner link is off, or `RUNNER_LINK_SIGNING_KEY` and `RUNNER_LINK_GATEWAY_TOKEN` are unique and protected,
      and the gateway holds the public key, not the private one.
- [ ] Where the link gateway runs, its DNS record is DNS only (not proxied), its port is the only other one open to
      the internet, and its metrics port stays on loopback.
- [ ] The public endpoint uses HTTPS and the configured origin matches it.
- [ ] Only the gateway is publicly reachable.
- [ ] The first administrator uses a strong password and user access is reviewed.
- [ ] Runner machines use least-privilege OS accounts and narrowly scoped credentials.
- [ ] Personal access tokens carry only the scopes, workspaces and lifetime their scripts need, and nobody
      scripts with one under a runner service's OS account.
- [ ] If Google sign-in is on, the Google app is published and who can sign in with Google is a deliberate
      choice.
- [ ] Managed runners are on or off by a deliberate choice in `.env`, and where they are on and anyone can sign up,
      the shared-kernel risk under [Isolation and its limits](#isolation-and-its-limits) is accepted.
- [ ] Where managed runners are on, `managed-runner-firewall` is healthy (`docker compose ps`), or it is off by a
      deliberate choice and this host's services and private networks are firewalled otherwise.
- [ ] Backups are copied off-host and a restore has been tested.
- [ ] Container health, disk space, backup failures, and runner availability are monitored.
- [ ] The deployment is pinned to a known release or commit and has a documented upgrade cadence.
