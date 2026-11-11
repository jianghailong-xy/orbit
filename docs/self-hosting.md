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
this host, sets up the [runner link](#runner-link), and starts the stack. Give it the external origin when you serve
Orbit on a domain or at an address of its own:

```bash
scripts/install-server.sh --public-origin https://orbit.example.com
```

It stops without changing anything where a `.env` or `data/postgres` already exists: that checkout holds a
deployment, which is [upgraded](#upgrading), never installed over. What follows is what it does, for configuring a
deployment by hand. A `.env` written by hand leaves managed runners off until it switches them on
([Turn them off or on](#turn-them-off-or-on)), and has no runner link until `.claude/skills/upgrade/upgrade.sh` first
runs in this checkout, which sets one up.

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
- list the proxy's addresses (a CDN's published ranges) in `TRUSTED_PROXIES`, so Orbit sees each visitor's own address
  rather than the proxy's ([configuration](configuration.md));
- allow long-lived SSE responses without proxy buffering or a short idle timeout;
- pass WebSocket upgrades on to `/runner-link`, which is how runners [reach the link](#how-a-runner-reaches-the-link).
  Cloudflare, Caddy and Traefik do so as they stand. nginx needs it said:

  ```nginx
  location = /runner-link {
      proxy_pass http://127.0.0.1:2086;
      proxy_http_version 1.1;
      proxy_set_header Host $host;
      proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
      proxy_set_header X-Forwarded-Proto $scheme;
      proxy_set_header Upgrade $http_upgrade;
      proxy_set_header Connection "upgrade";
      proxy_read_timeout 120s;
  }
  ```

- pass on the `Content-Security-Policy` headers of Orbit's pages (`src/web/nginx.conf`), and add no script to the
  pages: the browser refuses any script but Orbit's own files, so a CDN feature that writes one in (on Cloudflare:
  Rocket Loader, Zaraz, automatic Web Analytics, JavaScript Detections) reports an error in the console, and can stop
  the page, until it is turned off;
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

The runner works as the OS account that registers it. Under sudo — `curl … | sudo bash`, `sudo orbit register`,
or `orbit register` in a `sudo -i` shell — registration runs as the account that ran sudo: the runner runs as
that account and keeps its config in that account's `~/.orbit`. That account's own sudo installs the system
service, so without a terminal it has to need no password. `orbit unregister` under sudo removes that same
account's runner. For a runner of root's own from a sudo shell, name root: `sudo -i env -u SUDO_USER orbit
register`. Registration says the machine is online only once its service has reached the deployment. When that
does not happen within two minutes, `orbit register` says why, shows the end of the service's log and the
commands to look further, and exits non-zero.

The service runs the account's own copy at `~/.orbit/bin/orbit`, which the runner replaces when it updates itself.
`/usr/local/bin/orbit`, which `sudo orbit` finds, stays root's own file. When the binary registering sits in
`/usr/local/bin`, as an older install's does, register copies it into `~/.orbit/bin` and leaves
`/usr/local/bin/orbit` as it is, so that `orbit` falls behind the runner's updates until root runs
`sudo /usr/local/bin/orbit upgrade`. `orbit version` and `~/.orbit/bin/orbit version` show the two. Earlier
releases of register and upgrade replaced `/usr/local/bin/orbit` with a link to the account's copy, which made
every `sudo orbit …` run a file the account can change as root. The next register or `sudo orbit upgrade` puts a
root-owned copy back in place of the link and says so:

```text
✓ /usr/local/bin/orbit is root's own copy again, not a link to a file this account can change; `sudo /usr/local/bin/orbit upgrade` keeps it current.
```

That command still runs the linked file as root once, before it can replace the link. Where an account may already
have changed its copy, put a verified release at `/usr/local/bin/orbit` first
([details](runner-machine-binary-design.md#what-the-repair-cannot-undo)).

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

On a Linux machine where several accounts each run a runner of their own, set the machine up once and have each
account register itself: [Multi-user Linux machines](#multi-user-linux-machines).

### Session checkouts on the runner's disk

Each session works in a checkout of its own, under `<ORBIT_HOME>/worktrees` (`~/.orbit/worktrees` by default).
Three things keep them from filling the runner's disk:

- **Keep Free.** Set on the runner's page (Capacity), it is the free space below which the runner reclaims
  checkouts: finished sessions' first, then those of resting sessions left unwritten for two weeks, when nothing
  in them would be lost. With none set, a registered runner reclaims only finished sessions' checkouts beyond the
  32 most recent. Set it at least as high as whatever else guards that disk. A managed runner has a default floor,
  and takes resting sessions' checkouts sooner ([Their storage](#their-storage)).
- **Cloned checkouts.** Where the filesystem can clone files, on APFS, XFS made with `reflink=1`, btrfs, or
  OpenZFS 2.2 or later with block cloning enabled, a session's checkout is cloned from the workspace's own
  checkout and costs next to nothing on disk until its files change. The workspace's checkout has to be on the
  same filesystem as `ORBIT_HOME` (on btrfs, in the same subvolume). On ext4, exFAT and any other filesystem that
  cannot clone, the runner falls back to a plain checkout, which git writes out in full, as before. It needs no
  setting and no privilege either way.
- **Paths a repository leaves out.** A repository that commits `.orbit/checkout-exclude`, one pattern a line in
  gitignore syntax, gets session checkouts without those paths, on runners with git 2.34 or later. The runner
  reads the file from the commit a session forks from, and an agent brings a left-out path in with
  `git sparse-checkout add <path>`.

What the runner logs about each checkout, and why one went:
[runner troubleshooting](runner-troubleshooting.md#d-the-disk-is-short-or-a-sessions-checkout-has-gone),
sections D to F.

## 5. Back up and monitor

The Compose stack writes Postgres data to `./data/postgres` and attachment bytes to `./data/files`. A sidecar writes
base backups and archived WAL to `./data/pg-archive`.

- Set `ORBIT_BACKUP_SYNC_TARGET` (plus `ORBIT_BACKUP_SYNC_SSH_PORT` when it is not 22) so the sidecar mirrors
  `./data/pg-archive` to another host over ssh; give it a directory of its own, since the mirror deletes
  anything else there. A same-disk backup does not protect against disk or host loss.
- The same setting copies `./data/files` to the directory beside the target, `<target>-files`, leaving out `tmp/`.
  With no target, `./data/files` is the only copy of those bytes: they are not in Postgres or
  in any local backup. With `ORBIT_FILES_BACKEND=s3` the bucket holds them, and its versioning or replication is what
  protects them. See [Attachment files](postgres-backup-restore.md#attachment-files).
- The sidecar reads the target before mirroring, and refuses one holding another cluster's archive, with the reason in
  its log, rather than replace it: [The off-host mirror](postgres-backup-restore.md#the-off-host-mirror).
- Files agents keep with `file_upload` expire, which is what stops `./data/files` growing without end:
  [File retention and quota](#file-retention-and-quota).
- Uploads pass through `./data/files/tmp`, with either store. A process killed during one leaves its file there. Each
  apiserver start removes regular files there that have not been written for a day, so that file stays on disk until the
  first start at least a day later, which on a deployment that rarely restarts can be weeks away.
- A restore goes Postgres first, then the files, then the apiserver:
  [Restore the attachment files](postgres-backup-restore.md#restore-the-attachment-files). On a replacement host,
  restore the archive before the first `docker compose up -d`, or you have a new, empty cluster to move aside first:
  [Restore on a replacement host](postgres-backup-restore.md#restore-on-a-replacement-host).
- Periodically perform the verification procedure in the [backup and restore runbook](postgres-backup-restore.md).
- Monitor container health, free disk, failed backups, runner heartbeat status, and HTTP error rates.
- Decide an attachment/artifact retention policy appropriate for your deployment.

### File retention and quota

Orbit deletes the bytes of files agents upload with `file_upload`, on these dates. Reply images, your own uploads and task
attachments are not touched: they stay as long as their session or task.

| A file agents uploaded | Expires |
| --- | --- |
| No evidence cites it | 14 days after the upload |
| Cited by evidence still waiting for a decision | Does not expire |
| Cited by a version that was sent back or replaced | 30 days after that |
| Cited by a confirmed version | When the task is deleted, or 14 days after the upload if that is later |
| Pinned (`file_pin`, `PUT /api/attachments/:id/pin`) | Does not expire |

Where several apply, the latest wins. Expiring writes a tombstone and keeps the file's name, size, sha256 and test summary, so
evidence stays complete and its cards show an expired placeholder. The bytes go a grace period later, once no row holds them:
max(7 days, `ORBIT_BASE_BACKUP_INTERVAL` × (`ORBIT_BASE_BACKUP_KEEP` + 1)). The apiserver reads those two values for this, so
set them where the sidecar reads them, in `.env`, and recreate both services when they change. Pinning a file in its grace
period brings it back. The sweep runs on one apiserver about once an hour, and says what it did in the apiserver's log.

A session in Trash stays there past its 30 days while one of its files is pinned, or is cited by evidence and has not expired,
even with a date ahead of it. Everything else in the session stays with it, including its transcript. Its other files still
expire on their own dates, and a pin still holds the file after its task is deleted. Once nothing holds it, the hourly purge
takes the session and its rows, an expired file's included, though that file's bytes still have their grace period.

Deleting a session from Trash by hand takes its files with it, pinned or cited. Whichever way a row goes, evidence that cited it
keeps only the sha256 it recorded, and its card shows an expired placeholder: the name and test summary went with the row.

Settings shows an account's storage, its largest projects and tasks, and what each week added. Set `ORBIT_FILES_QUOTA_BYTES` in
`.env` to limit what one account may keep; past it an upload is refused with `413` and the code `FILE_QUOTA_EXCEEDED`. A
self-hosted deployment needs no limit, and has none unless you set one. Each content counts once, an expired file no longer
counts, and uploads racing at the limit can pass it by at most 25 MiB each.

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

## Configure outgoing email

Orbit can send one email: a welcome email to each new account, through [Resend](https://resend.com). It is
off until an administrator sets it up. Like Google sign-in, the settings live in the database, not in `.env`,
and apply from the next request without a restart. The deployment itself must provide:

- `PUBLIC_ORIGIN`, the address people open Orbit at: the email's **Open Orbit** button and its links point there.
- `PROVIDER_SECRET_KEY`, which encrypts the saved Resend API key.
- Outbound HTTPS from the apiserver to `api.resend.com`.

### Set up Resend

1. Create an account at [resend.com](https://resend.com).
2. In Resend, open **Domains → Add Domain** and add the domain you will send from, for example `example.com`.
   Add the DNS records Resend lists (SPF, DKIM and, if offered, the return-path record) at your DNS provider,
   then press **Verify DNS Records**. Wait until the domain reads **Verified**; until then Resend refuses every
   send from it with `403 The example.com domain is not verified`.
3. In Resend, open **API Keys → Create API Key**. **Sending access** is enough; you can limit it to the domain
   from step 2. Copy the key (it starts with `re_`). Resend shows it only once.
4. In Orbit, sign in as an administrator and open **Admin → Email** (Admin is in the account menu). Paste the key
   under **Resend API key**, fill in **From** with an address on the verified domain, such as
   `Orbit <orbit@example.com>`, and switch on **Send email from this deployment**. **Reply-To** is optional:
   left empty, replies go to the first administrator's address. **Send a welcome email to new accounts** is on
   by default. Press **Save**. The badge beside **Outgoing email** turns to **On**.
5. Press **Send test email**. Orbit sends a short email to your own address and shows what Resend answered:
   the email's id, or the HTTP status and Resend's message.

### What gets sent

- Every account created after the setting is on gets one welcome email: a Google sign-up, and an account an
  administrator creates in **Admin → Users**. It says which address and deployment the account is on, how to
  sign in (with Google, or with the password the administrator gave them), and how to get started. It never
  contains a password, a token or a sign-in link. The first administrator created at `/setup` gets none.
- Accounts that existed before email was set up get none, and neither do accounts created while it was off or
  while the welcome toggle was off. An administrator can send one by hand: **Send welcome email** in the
  account's ⋯ menu in **Admin → Users**.
- A failed send is tried again after 1 minute, 10 minutes and 1 hour. After the fourth failure it is marked
  failed, and **Admin → Users** shows **Welcome email failed** under the account's status (hover for Resend's
  error), with **Send welcome email** in its menu. A `422` from Resend (an address it will not send to) is
  marked failed at once. **Admin → Email** shows how many were sent and failed in the last 7 days.
- Each send carries an `Idempotency-Key`, so Resend does not deliver an email twice when the apiserver
  restarts in the middle of a send. Several apiservers never send the same email twice.

The API key is encrypted with `PROVIDER_SECRET_KEY` and never shown again. Leave the field empty to keep the
saved key, or paste a new one to replace it. After `PROVIDER_SECRET_KEY` changes, the saved key can no longer be
read: **Admin → Email** asks for it again, and sending pauses (nothing is lost or counted as failed) until it is
pasted again.

### Email troubleshooting

| Symptom | Likely cause |
| --- | --- |
| Send test email: `Resend answered 403 — The example.com domain is not verified` | The From domain is not verified in Resend yet (step 2), or From uses another domain. |
| Send test email: `Resend answered 401 — API key is invalid` | The key was deleted or mistyped. Create a new one and paste it. |
| Send test email: `Resend answered 403 — You can only send testing emails to your own email address` | No domain is verified, and the account still sends from Resend's test domain. Verify a domain and use it in From. |
| The badge reads **Off** | The switch is off, or the API key or From is missing. The card says which. |
| Users show **Welcome email failed** | Hover the line for Resend's error. Fix the cause, then use **Send welcome email** in the account's menu. |

The apiserver logs a `401` or `403` from Resend under `EmailOutbox`
(`docker compose logs apiserver | grep EmailOutbox`). The line names the account's id and Resend's message,
never the key.

## Wiki System model

The `wiki-worker` service calls the wiki's System model: a model endpoint that speaks the Anthropic Messages API, such
as vLLM run by the deployment itself, or DeepSeek's API. It runs the apiserver image with another command, serves no
port, and starts once the apiserver is healthy. It is the only service given the model's address and key; users'
provider keys, subscriptions and account pools are not used for it.

To configure it, set all three in `.env` and recreate the worker:

```dotenv
ORBIT_WIKI_MODEL_BASE_URL="http://192.168.1.20:8000"
ORBIT_WIKI_MODEL_API_KEY="the key the endpoint expects"
ORBIT_WIKI_MODEL="the model name it serves"
```

For DeepSeek, use its Anthropic-compatible endpoint, your DeepSeek API key, the model `deepseek-v4-pro` or
`deepseek-flash`, and turn thinking off:

```dotenv
ORBIT_WIKI_MODEL_BASE_URL="https://api.deepseek.com/anthropic"
ORBIT_WIKI_MODEL_API_KEY="your DeepSeek API key"
ORBIT_WIKI_MODEL="deepseek-v4-pro"
ORBIT_WIKI_MODEL_THINKING="disabled"
```

DeepSeek's V4 models think unless a request turns thinking off, which makes every wiki call slower, bills more output
tokens, and can spend a small budget, such as a verification's 1,024 tokens, before any answer text arrives.

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

Each runner keeps one WebSocket to a link gateway, which is part of this stack. Whenever work waits for a runner, the
apiserver tells it over that connection at once, and all of the runner's work travels over it. The `link-gateway`
service runs under the `runner-link` Compose profile, with the `nats` service beside it under the same profile.

### What you need to do

Nothing, on a default install or an upgrade. `scripts/install-server.sh` and `/upgrade`'s script
(`.claude/skills/upgrade/upgrade.sh`) set the link up, with no port, certificate or firewall rule of its own and no
question to answer. What they do, by what `.env` holds:

| `.env` holds | What happens |
| --- | --- |
| No `RUNNER_LINK_*` value and no `runner-link` profile | The link's secrets are generated once, and appended to `.env` with `RUNNER_LINK_URL=same-origin`. The existing lines stay as they were, byte for byte. `COMPOSE_PROFILES` gains `runner-link` in a line of its own at the end, repeating the list above it, since Compose takes the last. None of it is printed. `nats` and `link-gateway` start, and the web gateway is recreated if the `gateway/nginx.conf` it runs is not this checkout's. |
| `RUNNER_LINK_URL=same-origin` | `.env` stays as it is. The gateway's image is rebuilt, and named by the last commit under `src/link-gateway`, so that a commit elsewhere recreates nothing. |
| Anything else: a link you set up yourself, as under [A link gateway of its own](#a-link-gateway-of-its-own) | `.env` is not opened for writing, and `link-gateway` and `nats` are neither built nor restarted. An unfinished link, or a `link-gateway` that is not healthy, stops the upgrade before anything is built, naming what is missing, never its value. |

An upgrade that sets the link up prints these lines:

```text
==> Runner link: this deployment has none; setting it up
==> Building the link gateway from src/link-gateway (orbit-link-gateway:local, local, never pushed)
    Wrote the runner link's secrets to .env (not shown); keep them with this deployment's other secrets.
==> Starting the runner link (nats, link-gateway)
    http://192.168.1.20:2086/runner-link reaches the link gateway.
    Runner link: up. Runners connect at the address they reach this server at, within about 20 minutes, or at once
    as they update themselves. docs/self-hosting.md, "Runner link".
```

**Keep the new `.env` lines with the deployment's other secrets**, in the backup you already keep of `JWT_SECRET` and
`PROVIDER_SECRET_KEY`. Losing them costs little: with new ones in `.env`, runners fetch new tokens by themselves.

**An old `/upgrade` script.** Where the script is older than the link's and pulls this build itself, as it does in a
checkout on `main`, it stops when Compose refuses to render, having recreated nothing. Run it again: it is the new one now.
From the link's script on, a script that a pull changes runs the new one by itself.

**A hand-written `.env`:** run `.claude/skills/upgrade/upgrade.sh` once. Compose refuses to start a deployment with no link.

### How a runner reaches the link

Through the web gateway's own port, at the address the runner already uses: the gateway passes `/runner-link` on to
the link gateway inside the project's network. A runner registered at `http://192.168.1.20:2086` connects to
`ws://192.168.1.20:2086/runner-link`. A managed runner connects to the one address its firewall leaves it. Behind your
HTTPS, a runner connects to `wss://orbit.example.com/runner-link` through whatever serves your HTTPS, which has to
[pass WebSocket upgrades](#3-put-https-in-front). If it does not, the upgrade's check says so by name.

**The link is encrypted exactly where your deployment is.** On a plain `http://` deployment the link is plain `ws://`:
session content and a one-hour link token cross the network unencrypted, as session content and the long-lived runner
token do over its HTTP. Install and upgrade warn about it once on each run. Put [HTTPS in front](#3-put-https-in-front)
of anything beyond a trusted LAN.

How the apiserver decides each runner's address, and what a forged header can do to it
(`sameOriginLinkUrl` in `src/apiserver/src/runner-api/runner-link-token.ts`):

| `PUBLIC_ORIGIN` | A runner is told | What the request's headers can change |
| --- | --- | --- |
| `https://…` | That origin's `wss://…/runner-link` | Nothing. `Host`, `X-Forwarded-Proto`, `X-Forwarded-For` and `X-Forwarded-Host` are not read for the address. The one other answer is the plain address `runner.serverUrl` gives managed runners in their profile, for a request that names that host and shows no proxy in front. |
| `http://…` | `ws://` and the `Host` it arrived with, checked to be a host and a port | `Host` decides the address, since the deployment may not know its own (the default is `localhost`). It reaches only the answer to the request that carried it, which is not cached. `X-Forwarded-Proto: https` raises the answer to `wss://`, and nothing lowers it. |

So keep `PUBLIC_ORIGIN` set to your HTTPS origin behind a TLS proxy: with it, no header can move a runner off `wss://`.
`TRUSTED_PROXIES` is not needed for any of this. A request through a proxy it names counts as having come through a
proxy, whatever its `X-Forwarded-For` says. The web gateway overwrites the two `X-Orbit-Request-*` headers the apiserver
reads, so a client cannot write them.

**A runner behind an HTTP proxy.** Over `ws://` a runner dials through `HTTP_PROXY` as its HTTP calls do, and most
forward proxies drop the upgrade. Name the server in `NO_PROXY`, or use `https://`, which a proxy tunnels. `orbit doctor`
on the runner says what is in the way.

**The limit of this path.** Each runner holds two of an nginx worker's 1024 connections, so one worker carries about 500
runners, and the web gateway runs one worker per CPU. Past that, or to keep the link apart from web traffic, give it
[a host name of its own](#a-link-gateway-of-its-own).

### What it costs a small machine

Measured on a fresh default install with two runners connected and idle:

| Service | Memory | CPU | Image |
| --- | --- | --- | --- |
| `link-gateway` | 20 MiB | 0.15% of one core | 17 MB |
| `nats` | 8.5 MiB | 0.1% of one core | 42 MB |

Each connected runner adds about 158 KiB at the gateway, as measured at 15,000 connections, so 100 runners take about
16 MiB more. The gateway's image is built on this host from `src/link-gateway`. Its first build downloads
`golang:1.27.3-alpine` (about 380 MB, which stays in Docker's build cache) and then builds for about 15 seconds. A later
build of the same source takes seconds and recreates nothing.

### If the link does not come up

This build serves runners only over the link, so it has to be up before anything changes. An upgrade starts `nats` and
`link-gateway` before it recreates the apiserver, and then asks the web gateway's `/runner-link`, and `PUBLIC_ORIGIN`'s
where it has one of its own, for the link gateway's own refusal of a request with no token. When a step fails, the upgrade
stops there and exits 1. The apiserver is not recreated, so the deployment goes on running the build it has, and its
runners keep working:

```text
error: this build serves runners only over the runner link, and it did not come up: nats or link-gateway did not come up within 3 minutes
       NAME              IMAGE                      SERVICE        STATUS
       ...
       The apiserver was not recreated: this deployment goes on running the build it has, and its runners keep
       working. Fix that and run this script again: it keeps what it already wrote to .env.
       docs/self-hosting.md, "Runner link".
```

Fix what it names and run the script again. The secrets it wrote stay, and it writes none twice.

| Answer the check names | What it means |
| --- | --- |
| `502` from the web gateway | `link-gateway` is not running: `docker compose ps link-gateway nats`, `docker compose logs link-gateway nats` |
| `426 WEBSOCKET_REQUIRED` at your origin | Your TLS proxy does not pass upgrades on: [the lines it needs](#3-put-https-in-front) |
| Any other status at your origin | It does not send `/runner-link` to this deployment at all |
| `could not be checked from here` | This host cannot reach its own public address. That proves nothing: the runners' own logs and `orbit doctor` will say |

**`docker compose up -d --build` by hand,** on a deployment with no link, gets a refusal from Compose:
`required variable RUNNER_LINK_SIGNING_KEY is missing a value`, naming the script. That holds for every Compose command in
that checkout, `ps`, `logs` and `down` among them, until the script has run, and nothing is recreated. To read logs
meanwhile, use `docker logs orbit-apiserver`.

**If the gateway stops later,** `docker compose ps` shows `link-gateway` down or unhealthy, the runners log that the link
is not connected and go offline in the Runners page, and they come back by themselves once it runs.

### Old runners

A runner takes its updates from your deployment's own `/dl`, with the release its `GET /api/runner/release` names, and
those two stay on HTTP(S) in every build, so an upgrade of the server brings runners with it. A runner that is idle
updates itself within 10 minutes; a busy one waits for its turns to end.

One from before 0.1.237 does not wait: its first call is refused with 426, and it stops. The service `orbit register`
installs starts it again within seconds (systemd's `Restart=always`, launchd's `KeepAlive`), and it then updates itself
at once and comes back on the link, carrying on a turn it was running. A runner started another way, such as `orbit run`
in a terminal, stays stopped until you start it again.

A [managed runner](#managed-runners) never updates itself either: it takes the new image with its next container, made
when it wakes after it next sleeps, or, for one from before 0.1.237, when it exits at the 426 or the manager replaces it
([What an upgrade does](#what-an-upgrade-does)). Until then it runs the binary its container started with, as a runner
with self-update off does. One of those that is busy when you upgrade loses what its turns do after the upgrade, so let
them finish first.

A runner with self-update off (`ORBIT_NO_SELFUPDATE`, or an install directory it cannot write to):

- at 0.1.237 or later, speaks the link and needs nothing;
- older, cannot. Its first call is refused with 426 and it stops, and its log says
  `Run \`orbit upgrade\` to update this runner` each time its service starts it. Do what it says on that machine.

### How the link runs

The gateway forwards each runner's requests, heartbeats and events to the apiserver's [internal
listener](#runner-link-calls), and its live stream to NATS while someone watches the session.

Whenever work waits for a runner (a queued session, a message in its inbox, or a sign-in, merge or update that its
heartbeat delivers), the apiserver also publishes a hint on NATS, on the subject of that runner alone. The gateway
subscribes for the runners it holds connections of and relays each hint to that runner. NATS keeps nothing: no JetStream,
no volume. It has no port on the host, and a hint lost while it is down costs a runner one heartbeat interval. The
apiserver publishes to `nats://nats:4222` unless `RUNNER_LINK_NATS_URL` names another server. With NATS unreachable, it
logs the hints it dropped once a minute and goes on. Session content crosses NATS too (the live stream, and the text a
turn has streamed so far), so NATS admits only the apiserver and the gateway, each by its own
[nkey](#nats-credentials).
[src/link-gateway/README.md](../src/link-gateway/README.md) describes the gateway in full.

### Connection tokens

Before it connects, a runner trades its runner token for a connection token, and the gateway refuses the tokens of
revoked credentials. Both come from the apiserver, which offers them only when all three of these are set in `.env`,
as install and upgrade set them. While they are not, those routes answer 404. A value that cannot be used leaves the
link off too, and the apiserver logs why when it starts:

```dotenv
RUNNER_LINK_SIGNING_KEY="base64 of an Ed25519 private key in PEM"
RUNNER_LINK_URL="same-origin"   # or the gateway's own address: wss://link.orbit.example.com
RUNNER_LINK_GATEWAY_TOKEN="a secret only the gateway is given"
```

To make them by hand, generate the key and the secret. The gateway is given the public key and the secret, never the
private key. `docker compose run --rm --no-deps link-gateway secrets` prints all of them, the NATS pairs below too, as
`.env` lines:

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
  the address it is to connect to, which the response repeats.
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
service reads, allows each nothing else, and a client without a key cannot connect. Install and upgrade make both pairs.
By hand, make two:

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
  (unset). Hints and the live stream stop: runners learn of work at their next heartbeat, and a reply shows only as it
  is stored.
- The apiserver's seed unset: its log warns `RUNNER_LINK_NATS_SEED is not set` and then that NATS is unreachable
  (`Authorization Violation`); it drops hints and counts them.
- The gateway's seed unset: its log warns `LINK_NATS_SEED is not set`, `link_nats_connected` stays `0`, and no hint is
  relayed.

> **Upgrading a deployment that already runs the `runner-link` profile by hand:** an upgrade leaves it to you, so add the
> four values above to `.env` before you upgrade. `nats` reads `src/link-gateway/nats.conf` and refuses to start without
> the two public keys, and the apiserver and the gateway connect only with their seeds.

### A link gateway of its own

A deployment past [the web gateway's limit](#how-a-runner-reaches-the-link), or one that wants the link apart from its web
traffic, gives the gateway a host name and a port of its own, as orbitd.io does. Runners then connect to it directly. A
proxying CDN or the web gateway never stands between them: a CDN would terminate and inspect the connection, and its
outages and limits would become the link's. An upgrade leaves such a link as it is, `.env` included. Set it up in this
order.

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

   and the four [NATS credentials](#nats-credentials). Moving a deployment that `RUNNER_LINK_URL=same-origin` set up onto
   this: change that line, and remove `RUNNER_LINK_ENV_FILE`, `RUNNER_LINK_BIND`, `RUNNER_LINK_METRICS_PORT` and the
   `RUNNER_LINK_PORT` that says `0`.

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
   the listener the gateway forwards to.

### Operate the link gateway

- **Releases.** `docker compose up -d --force-recreate link-gateway`, or an upgrade that brings a new image of it on a
  deployment set up with `same-origin`, stops the gateway gracefully. It drains first:
  1. It refuses new connections.
  2. It tells its runners, in batches, to reconnect after a delay drawn at random within 30 seconds.
  3. It closes what is left within 80 seconds.

  Compose waits up to 90 seconds before it stops the container. Runners come back to the new gateway once it is up.
- **What recreates it.** `docker compose up` recreates the gateway, draining it as above, when its image or its rendered
  definition changes. It also does so once after Compose itself moves to a version that hashes the same definition
  otherwise: the first `up` of v5.5.1 recreates a gateway that v2.38.2 created. On
  [a link of its own](#a-link-gateway-of-its-own), `RUNNER_LINK_ENV_FILE` and `RUNNER_LINK_BIND` are unset: the
  `env_file` line adds nothing and the port is published on every address, so the definition is the one it had before
  a `same-origin` link needed those lines, and `up` leaves the gateway running. Compose from v2.22.0 to v5.4.x even so
  prints a `docker compose config --hash link-gateway` that differs from the container's `com.docker.compose.config-hash`
  label: it hashes the `env_file` line as written, where `up` merges it into the environment first
  ([docker/compose#14001](https://github.com/docker/compose/issues/14001)). To see what `up` would do, run
  `docker compose --dry-run up -d --no-deps link-gateway`: it prints `Recreate` for a gateway it would recreate.
- **Certificate rotation.** In ACME mode it is automatic. With files, replace them. Either way,
  `link_tls_certificate_not_after_timestamp_seconds` shows the expiry of the certificate in use (files mode).
- **Replacing the signing key.**
  1. Give the gateway both public keys, comma-separated (`RUNNER_LINK_PUBLIC_KEY="<old>,<new>"`), and recreate it.
  2. Switch the apiserver to the new `RUNNER_LINK_SIGNING_KEY`.
  3. After an hour, when every old token has expired, drop the old public key.
- **Monitoring.** `/metrics` on the metrics port (`docker compose port link-gateway 9464` finds it on a `same-origin`
  link, which takes a free port) counts connections, handshakes by result and their duration,
  disconnects by reason, ping round trips, token refusals by reason, revocation reads, and hints by kind and by what
  became of them. It also counts forwarded calls by result and
  their latency, retries across apiserver instances, events stored and their acknowledgement latency, the ingest queue
  and the credit it grants, the live stream by what became of it, and frames dropped or connections closed for slow
  reading.
  [The gateway's README](../src/link-gateway/README.md#metrics) lists them all.
- **Logs.** `docker compose logs link-gateway` shows one line per connection event. Set `LINK_FRAME_LOG=all` in the
  service's environment to log a summary of every frame, too. The gateway decodes frames that it or a runner logged:
  `docker compose logs link-gateway | docker compose exec -T link-gateway /link-gateway dump`.
- **Turning it off** stops every runner: runners work only over the link.

## Large deployments

The stack as installed runs one apiserver, which is enough for a team. Once runners work over the
[runner link](#runner-link), a deployment the size of a link cell needs more than that. A cell is up to 10,000
people, with 15,000 runner connections. Its runners' heartbeats, events and live streams alone keep several Node
processes and a database host of its own busy.

### The cell's size

The cell's load at its peak:

- 15,000 connections;
- 500 heartbeats a second, 11.4% of them reconciled in full: every five minutes, and whenever a report that changes in
  production changed, at production's rates. Commands, cancellations and settings changes mark more of them; an
  estimate puts production's share at a quarter, which the figures below do not cover;
- 2,000 durable events a second;
- 10,000 live deltas a second, forwarded to whoever watches.

A cell of the sizes below carried that load for an hour on the runner link's load test (task C2b, 2026-10-31), the
whole stack on one machine, a GCE c2d-standard-56 (AMD EPYC 7B13): once as the criterion has it, and once with the
live deltas too. What the table gives as measured comes from those two hours, the task's comments C2b evidence 24 to
29. What it gives as projected is linear in each rate, from what each operation cost on the same machine (C2b
evidence 23). [The load test's README](../scripts/runner-link/README.md#re-testing-at-cell-scale-task-c2b) gives the
runs, the arithmetic, and how to repeat both.

| Part | For a cell | Measured | Projected, at the peak |
| --- | --- | --- | --- |
| Link gateway | 3 nodes, each 2 cores and 4 GB, behind a TCP (layer 4) load balancer | One node carried all 15,000 connections: 0.8 cores on average (1.5 with the live deltas) and 2.2 GiB | 5,000 connections a node, 7,500 with one node down (1.1 GiB of them); 1.5 cores across the cell |
| apiservers | 6 processes, each 2 GB | With the live deltas, each process's main thread was at most 49–52% busy over 10 seconds; without them, 33–37%. Each process used under 600 MiB | Each main thread 52% busy, 62% with one process down. The first one also takes people's other requests |
| Database | 11 cores, 32 GB of memory, its own fast disk | 5.85 cores at its 10-second peak, 53.2% of its cores, during an autovacuum (43.4% outside one); 50.3% with the live deltas | 4.2 cores on average, 6.3 at its 10-second peak |
| NATS | 1 node, 1 core | 0.34 cores with the live deltas | 0.3 cores |

- **Why six and 11.** The cell was first sized at four apiservers and 8 database cores, from a fifth of its load. On
  the same machine, four apiservers carrying the live deltas ran their main threads 63–64% busy at the 10-second peak,
  and the database's peak measured above would be 73.1% of 8 cores (C2b evidence 23, 26). Six and 11 are the
  projection from the costs measured there; the two hours above then measured a cell of that size.
- **The apiservers' limit is the main thread.** It does nine tenths of a process's work, so a process carries about one
  core. The count leaves room for one process to fail: five carry the peak at 62% (projected).
- **Losing a gateway node.** Its 5,000 runners reconnect to the other two, which let in 200 handshakes a second each,
  for about 13 seconds. Projected as if each runner minted a link token and had its first heartbeat reconciled in full,
  that adds up to 5.4 apiserver cores and 8.7 database cores meanwhile, more than 11 cores have spare at the peak. A
  runner whose token is still good does not mint one. Measured: when the test's one gateway restarted, its 15,000
  runners came back at 200 a second over about 110 seconds, and the database's busiest 5 seconds took 6.5 cores (with
  four apiservers and 8 cores then; C2b evidence 20).
- **Commands and changes.** On the test's machine a heartbeat cost the database 3.35 ms on average, 11.4% of them
  reconciled in full (C2b evidence 17, 23); the two kinds were not measured apart there. On another host (task O1) a heartbeat cost the
  database 0.63 ms, or 6.37 ms when it was reconciled in full: when something it delivers changed (a merge, a commit, a
  sign-in, a cancellation), and at least every five minutes. Each percent of beats reconciled in full added about
  0.03 database cores there.
- **The database's disk and memory.** On the load test's sessions an event takes about 1.5 KB stored (its row, its tool
  call and their indexes) and about 5.7 KB of WAL. At 4,000 events a person a day that is about 60 GB of tables and
  230 GB of WAL a day for a cell, before the archive compresses it. Size the disk and the WAL archive for that.
  - Raise `max_wal_size` to 8 GB or more. At the default 1 GB the peak's WAL forces a checkpoint every 90 seconds or
    so, each followed by full-page writes. With 8 GB, checkpoints wait for `checkpoint_timeout` (5 minutes).
  - Give `shared_buffers` a quarter of the memory.
  - The test's database had 16 GiB of memory, and sat at that limit throughout: its page cache was evicted and read
    back all hour, though nothing was killed and its CPU stayed within the criterion (C2b evidence 26, 29). The 32 GB
    in the table is the earlier projection's, for the newest events' cache, and was not measured.
- **A failover must not lose an acknowledged commit.** A runner lets go of its copy of a batch of events once their
  acknowledgement arrives, so an event the database acknowledged exists nowhere else. An asynchronous standby can lose
  the last moments' commits when it takes over. A cell's database needs one of these:
  - a synchronous standby: `synchronous_commit = on`, with the standby named in `synchronous_standby_names`;
  - two standbys and a quorum (`ANY 1 (...)`), so that losing one standby does not stop commits;
  - a managed database whose failover keeps every acknowledged commit.

  Keep the standby near, since every commit that writes events waits for it.
- **The live relay** is spread over every apiserver, with the session streams it feeds (the web gateway's routes under
  [Several apiservers](#several-apiservers)).
  - **Its cost**, measured: each delta forwarded to a watcher took about 0.09 ms of CPU across the apiservers (0.1 ms
    over six), about one core at 10,000 a second. Every delta reached its watcher, 116 ms after it was produced at the
    p99: two 50 ms gatherings, the runner's and the stream's (C2b evidence 23, 29).
  - **Why it is spread.** On one apiserver it does not fit: the relay alone would keep its main thread about 99% busy
    at the peak (projected, C2b evidence 23). A test on a slower host measured it: at a cell's live rate, the first apiserver's main
    thread was 98% busy and the others' about 40%. Every delta still reached its watcher, but the other work of that
    process waited, the link tokens it alone signed among it.
- **Not measured here:** a cell of three gateway nodes, since the test's one node carried every connection; how the
  database's peak moves as its tables grow, each autovacuum longer and heavier (the judging hour began with 19.8
  million stored events); people's own requests (web and apps), which go to the first apiserver, their session
  streams apart; and what each apiserver's own background work costs a production database. Each process's figures
  leave room for them.

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
process that started it, so all of one person's other requests must reach that same process. While the first apiserver
is stopping or stopped, as an upgrade recreates it, those requests go to the others
(`gateway/several-apiservers/first/`), and back to the first once it answers again. A sign-in that was under way when it
stopped has to be started again.

**Runners on the link.** Several apiservers need every runner to work over the [runner link](#runner-link), as every
runner of this release does.

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

**Idle connections: the caller closes first.** Every apiserver keeps an idle HTTP connection open for 120 seconds,
on port 3000 and on `RUNNER_LINK_INTERNAL_PORT`. Whatever calls it must close an idle connection sooner. If the
apiserver closed it first, a request sent on it at that moment would be reset: through the web gateway the caller gets
a 502, and the link gateway sends the call again or tells the runner to.

- The web gateway closes an idle connection after 60 seconds. That is nginx's upstream `keepalive_timeout`, which
  applies with no `keepalive` directive since nginx 1.29.7.
- The link gateway closes one after 90 seconds (`IdleConnTimeout` in `src/link-gateway/backend.go`).
- If you set `keepalive_timeout` in the web gateway's upstreams, or put another proxy or load balancer in front of the
  apiservers, keep its idle timeout under 120 seconds.

One hop out the rule holds the same way. The web gateway keeps a client's idle connection for 120 seconds
(`keepalive_timeout` in `gateway/nginx.conf`), and runners close theirs after 90 seconds, Go's default. A test in the
runner (`src/runner-go/idle_connections_test.go`) fails if a runner's client would keep one as long as the gateway does.

**How an apiserver stops.** On `docker stop`, so also when an upgrade or `docker compose up` recreates it, an apiserver
stops by itself and loses nothing that is in flight (`src/apiserver/src/common/graceful-stop.ts`):

1. It stops accepting connections, on port 3000 and on `RUNNER_LINK_INTERNAL_PORT`. The web gateway and the link
   gateway find the connection refused at once, and send the request to another apiserver. They do this for a POST too,
   since none of it was sent.
2. Its session streams and control-plane streams end. The clients open them again on another apiserver: each session
   stream picks up after the last stored event it had.
3. It finishes the requests in flight, for up to 6 seconds. Each answer tells the caller to close the connection, and
   the apiserver closes it once the answer is sent. It closes idle connections at once.
4. It then stops its background work and closes NATS, its coordination connection and the database. The leader's lock
   goes with that connection, so another apiserver takes over the reaper and the sweeps at its next poll.
5. It exits, but no sooner than 4 seconds after the stop began. Until then its address refuses connections, so a
   session stream that opens again a moment later is sent to another apiserver at once. An address that no longer
   answers at all would make the web gateway wait out its 2-second connect timeout first.

It exits 0 within 9 seconds, inside Docker's default grace period of 10 seconds. A request still unanswered after the
6 seconds is cut, and its caller asks again. Only the slow ones wait that long, such as a merge called with
`waitSeconds`. If the migration that runs before it starts is still running when the stop comes, Docker waits out the
grace period and kills the container.

**How the session streams are spread:**

- **By session.** The web gateway hashes the session's id in the stream's address, so all of one session's streams,
  from every tab and device, reach one apiserver while the set of apiservers stays the same. That apiserver alone
  subscribes to the session's live stream on NATS and relays its deltas. The apps address a session by its public id;
  a stream addressed by its UUID can reach another apiserver, which costs that apiserver a subscription of its own.
- **When the set changes.** When an apiserver is added or stops, some sessions move to another apiserver, each when its
  stream next connects. A stream already open stays where it is.
- **When an apiserver stops.** Its streams end, and the clients open them again on the others. A stopping apiserver
  refuses connections, so the web gateway moves on at once. It gives up on one that went away without stopping after
  2 seconds, then leaves it out. Each stream picks up from the last stored event it had, and the deltas go on.
- **When the web gateway starts.** It looks the name up as it starts, which Compose does once the first apiserver is
  healthy. Had no apiserver been running then, the two routes would answer 502 until its next look-up, 10 seconds
  later.
- **Who watches.** Each apiserver tells the link gateway how many streams it has of each session, and the gateway adds
  the counts up. The count of an apiserver that stopped lapses after 60 seconds.

**Events another apiserver stored.** The apiserver that stores a batch of a session's events tells the others, and the
one holding the session's streams hands the batch on to them. A batch too big to ride along in that notice is read back
from the database instead.

- **When the read fails**, it is tried again after 250 ms, 1 s and 3 s. Each failure is logged with the session, the
  events' sequence numbers and the error, never the events themselves:
  `session <id>: could not read back seq 3-14, stored by another apiserver (attempt 1 of 4: <error>); trying again in 250 ms`.
- **Meanwhile** the session's later events wait behind it, so its streams receive them in order.
- **After four failed reads**, or 10 seconds after the notice, the apiserver gives up and logs
  `gave up reading back seq 3-14`. It tells the session's streams to fetch the transcript again: the web and the apps
  drop the part they hold and load its newest page. The owner's session lists that follow that apiserver get the
  session's row again, read from the database.
- **When its listener drops.** Each apiserver hears the others' notices on a connection of its own, which it opens
  again 2 seconds after losing it. A notice sent in between never reaches it, and the database keeps no copy.
  - Once the connection is back, the apiserver checks whether another apiserver ran meanwhile, that is, wrote its row
    in `apiserver_process` during the gap or in the 30 seconds before it. If one did, the apiserver handles every
    session it has a stream of open as if it had given up a read: the streams fetch the transcript again, and the
    owner's lists there get the session's row again.
  - It logs one line, with how long and how many sessions:
    `LISTEN/NOTIFY back after 2345 ms without it: 1 other apiserver(s) ran meanwhile and what they announced did not reach this one, so this apiserver's streams of 3 session(s) were told to re-fetch`.
  - An apiserver that is alone missed nothing. It logs that no other apiserver ran, and sends nothing.
  - A database restart drops every apiserver's listener at once, so afterwards every session stream in the deployment
    loads its newest page again, within a few seconds.
  - The owner's lists are not re-read for the sessions it has no stream of. If another apiserver changed one of them in
    those seconds, the change shows at the session's next change, or when the list is next loaded.

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

**Recaps, approval alerts and agents' notifications** are decided on the database rows they are about, not in the
memory of the apiserver that took the call. So with several apiservers, a session's recap still asks its model once per two-minute
window, one turn's tool approvals ring the owner's phone once, and an agent's `notify` rings it at most once a minute.

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

**Before production.** Several apiservers rely on all of the following. The first is the runners'; the others are in
the apiserver, and this section says how each works:

- Every runner works over the runner link.
- The reaper, the task scheduler's sweep and the auto-retry sweep run in one apiserver at a time.
- Antigravity's pasted sign-in code and the Cursor key check reach the runner from any apiserver.
- Recaps, approval alerts and agents' notifications are decided on the database rows they are about.
- An upgrade recreates every apiserver.
- A batch another apiserver stored reaches a session's streams, or they are told to fetch the transcript again.
- When an apiserver's listener comes back, the session streams on it fetch the transcript again if another apiserver
  ran meanwhile.

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

### Their storage

A managed runner keeps its sessions' checkouts on its data volume, 20 GiB by default (`storage.capacity` in
`profile.json`). The channel stops a runner whose volume holds more than its limit (`VOLUME_OVER_LIMIT`), and the
runner reclaims checkouts before that:

- **Against the volume, not the host's disk.** The apiserver relays the channel's latest measurement of the volume
  to the runner with each heartbeat answer, and the runner judges free space by what the volume has left under its
  limit.
- **The floor** is the owner's **Keep Free** when one is set, and a quarter of the volume's limit otherwise: 5 GiB
  of 20 GiB. The default is worked out for each heartbeat answer and never stored, so the runner's page shows Keep
  Free only as its owner set it, and auto-run, which holds ready tasks while a runner's disk is under its floor,
  applies only that.
- **Before a new checkout** that would leave less than the floor free, the runner makes room for it first. Below
  the floor it reclaims resting sessions' checkouts however recently they were written, the oldest first, when
  nothing in them would be lost; each comes back at its session's next message.
- **A checkout is never refused,** and a session at work, or whose engine is still warm (up to four hours after
  its turn), keeps its checkout. So the volume has to hold the workspace and its runner's Max Concurrent + 1
  session checkouts, with what they install and build. The default profile (20 GiB, Max Concurrent 2) holds that
  for a repository the size of Orbit's, whose checkout is about 1.75 GiB, or 0.93 GiB with the paths it leaves out.
- **Clones count at full size.** Docker sizes a volume by adding up its files' apparent sizes, so the channel's
  limit counts a cloned file as much as a copy. Putting Docker's data root on XFS (`reflink=1`) or btrfs saves this
  host's disk, not an account's limit. A repository's `.orbit/checkout-exclude` lowers both.

All of this needs managed runners switched on: with `ORBIT_MANAGED_RUNNERS_ENABLED` off, a runner gets neither the
volume's measurement nor the default floor. The details and the runner's log lines are in
[the runbook](managed-runner-docker-operations.md#session-checkouts-and-the-volumes-limit).

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
  (replacing an `ORBIT_MANAGED_RUNNERS_ENABLED=false` line, adding its profiles to a `COMPOSE_PROFILES` line the
  deployment already has, and leaving every other line as it was), starts
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

The exception is a runner from before the runner link's client, in a container made before about 2026-10-25. This
version takes the runner daemon's calls over the [runner link](#runner-link) alone ([Old runners](#old-runners)) and
answers each of that runner's calls 426, and what happens next depends on whether it is busy:

- **Idle**, or with a slot free, it asks for work, takes the 426 as final and exits. The manager starts it again from the
  current image, on the same volume and with the same runner, as after any stop: in the drill of 2026-11-06 it was
  `READY` on the link 40 seconds after the new apiserver started, and its session answered the next message at once.
- **Busy**, every slot taken by a turn, it asks for no work and keeps going, unheard. The server sees nothing more of
  those turns, and its owner sees the runner offline. The reaper fails their sessions (`runner offline`): after 10
  minutes 45 seconds where every runner fell silent at once, as in the drill, and sooner where others are still heard.
  Once the runner has been silent for those 10 minutes 45 seconds, the manager asks the channel to stop the container,
  waits for Docker's report that it exited, and starts the next generation from the current image, which works over
  the link. The wait is as long as the reaper holds the silence of runners that lose contact together, so an outage
  that silences every runner at once, such as the apiserver or the link gateway restarting, stops none of them.

What a busy runner does after the upgrade is lost to its sessions. In the drill, each of two agent turns ran 46 tool
steps; the server holds the first 10, and the other 36, 12 commits among them, ran unseen for 11 minutes before the
container was stopped. Both sessions ended `FAILED`, so a new message to either is refused, and those commits were made
only in each session's worktree on the runner's volume. So before you upgrade to this version from one that still takes
runners' calls over HTTPS, let every managed runner from before the link client finish its turns. On a deployment already at a version from after 2026-10-25, you can also stop
each such container once it is idle (`docker stop mr-<runner id>`), and the manager makes its next one from the current
image, which has the link client. The `docker ps` command a few paragraphs below lists the containers and their images.

The apiserver logs the first line below at each pass, every few seconds, until Docker reports the exit, then the
second:

```text
WARN [ManagedRunnerManager] managed runner <mapping id>: READY, its container <instance uid> of generation 1 made from a previous image (sha256:…) and silent since <time>, on a server that takes runners over the link alone; asking it to stop, so that the next generation starts from the current image
WARN [ManagedRunnerManager] managed runner <mapping id>: POD_TERMINATED: container <instance uid> of generation 1 stopped in READY with exit code 0, not out of memory; starting generation 2 on the same volume in 8 s (attempt 1 of 5)
```

Until the new container is ready, its owner reads "The runner instance stopped, so it is being started again on the
same data volume." A container that ends without Docker's report of its exit, or disappears, is not replaced: the
runner waits in `FENCING`, as for any [container that vanished](managed-runner-docker-operations.md#a-runners-container-vanished-without-dockers-report).
A runner that still reports in is never stopped for its image, and a silent one on the current image is left as it
is. The manager takes Docker's report of a `docker stop` you ran as it takes any other, and starts the next generation
from the current image.

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

## Multi-user Linux machines

A Linux machine that several people use can carry a runner for each of their accounts. Each runner is a process of
its own account, with its own credential, heartbeat and sessions, runs that account's own copy of orbit, updates that
copy itself, and drains on its own when it stops. Root is needed once, to set the machine up. From then on, every
account registers, checks and removes its own runner without sudo. A machine that is not set up keeps the
single-account flow of [Register a runner](#4-register-a-runner), and macOS is not affected.

[scripts/hostd-e2e.sh](../scripts/hostd-e2e.sh) runs every command in this section, with the same arguments, on a
real systemd with no sudo installed (root runs the ones shown with `sudo` itself), and marks each one with the
heading it comes from.

### Set up the machine once

The machine runs a host broker, hostd, as root. It is what starts and stops each account's runner, so that no account
needs sudo for it. The broker runs one binary, `/usr/local/bin/orbit`, and no other: a regular file root owns and only
root can write, in directories only root can write all the way up to `/`. The accounts' runners do not run it. Each
runs its account's own `~/.orbit/bin/orbit`.

[install.sh](../src/web/public/install.sh) does not put the broker's copy in place: it installs into
`~/.orbit/bin/orbit` of whichever account runs it, root included, with a `~/.local/bin/orbit` launcher linked to it.
So first, as the account that ran install.sh, put a root-owned copy at `/usr/local/bin/orbit`:

```bash
sudo install -o 0 -g 0 -m 0755 ~/.orbit/bin/orbit /usr/local/bin/orbit
```

Then, once, set the machine up from that copy:

```bash
sudo /usr/local/bin/orbit host setup --server https://orbit.example.com
```

`--server` is the deployment's `PUBLIC_ORIGIN`. After these two commands, no account needs root to register, check,
remove or update its runner. Setup writes five files, each one whole every time it runs, so running it again is safe:

- `/etc/systemd/system/orbit-runner@.service`: the template every account's runner is an instance of,
  `orbit-runner@<user name>.service`. The instance name is the account's user name escaped by systemd's own rule,
  the one `systemd-escape` prints, which can be undone, so no two accounts share a unit: `alice` and `test.user` stay
  as they are, and `test-user` becomes `test\x2duser`, its runner `orbit-runner@test\x2duser.service`. The instance
  runs as that account (`User=%I`) and starts the account's own copy
  (`ExecStart=/bin/sh -c 'exec "$HOME/.orbit/bin/orbit" run'`, with `$HOME` from the passwd database).
  `Restart=always` brings a runner back when it exits, and `KillMode=mixed` with `TimeoutStopSec=180` lets it drain
  when it stops.
- `/etc/systemd/system/orbit-hostd.socket`: the host broker's socket, `/run/orbit/host.sock`, mode 0666. Setup
  enables and starts it.
- `/etc/systemd/system/orbit-hostd.service`: the host broker, `/usr/local/bin/orbit hostd`, run as root. The socket
  starts it when an account's `orbit` connects, and it exits after 30 quiet seconds.
- `/usr/lib/tmpfiles.d/orbit-hostd.conf`: recreates `/run/orbit` at every boot, for the socket to listen in.
- `/etc/orbit/config.json`: the control plane the machine belongs to, `{"server":"https://orbit.example.com"}`. The
  broker installs updates of its own binary from this server and from no other.

It then creates `/run/orbit`, reloads systemd and starts the socket:

```text
Created symlink /etc/systemd/system/sockets.target.wants/orbit-hostd.socket → /etc/systemd/system/orbit-hostd.socket.

✓ this host is set up for Orbit runners.
  Broker:  orbit-hostd.socket (socket-activated; /run/orbit/host.sock), running /usr/local/bin/orbit
  Runners: orbit-runner@<user>.service, one instance per Linux user,
           each running that user's own ~/.orbit/bin/orbit
  Server:  https://orbit.example.com

  Every user on this host can now run `orbit register` without root.
```

Run without root, it changes nothing and says what to run instead:

```text
orbit host: setup writes machine-wide systemd units and must run as root — re-run: sudo /usr/local/bin/orbit host setup --server https://orbit.example.com
```

Setup refuses any binary other than `/usr/local/bin/orbit` before it writes or runs anything. Root's own copy, where
install.sh puts it, is one:

```text
orbit host: refusing to set this host up with /root/.orbit/bin/orbit: the host broker runs only /usr/local/bin/orbit.
It runs as root, so it runs one binary, the root-owned copy at /usr/local/bin/orbit that hostd's updates replace; every account's runner runs that account's own ~/.orbit/bin/orbit instead.
Put a root-owned copy in place, then set the host up from it:
  sudo install -o 0 -g 0 -m 0755 /root/.orbit/bin/orbit /usr/local/bin/orbit
  sudo /usr/local/bin/orbit host setup --server https://orbit.example.com
```

It also refuses a binary an account could change, since the broker would run it as root. An account's own copy is
one, which the account, or any agent it runs, can replace, whether setup runs from it or through the link to it that
earlier releases of install.sh made `/usr/local/bin/orbit`:

```text
orbit host: refusing to set this host up with /home/alice/.orbit/bin/orbit: it belongs to uid 1000 rather than root.
The host broker would run this binary as root, so no account may be able to change it: it has to be a regular file root owns and only root can write, in directories only root can write, from its own up to /.
Put a root-owned copy in place, then set the host up from it:
  sudo install -o 0 -g 0 -m 0755 /home/alice/.orbit/bin/orbit /usr/local/bin/orbit
  sudo /usr/local/bin/orbit host setup --server https://orbit.example.com
```

In both, the first command puts a copy root owns at `/usr/local/bin/orbit`, in place of any link there, and leaves the
copy it was made from as it was. A directory its group can write is refused too. Older Debian installs have
`/usr/local` and `/usr/local/bin` owned by `root:staff` with mode 2775, which would let any member of `staff` put
another binary in place, so setup names every such directory (the mode it reports leaves out the setgid bit):

```text
orbit host: refusing to set this host up with /usr/local/bin/orbit: its directory /usr/local/bin is not root's alone (owned by uid 0, mode 0775); /usr/local, a directory above it, is not root's alone (owned by uid 0, mode 0775).
The host broker would run this binary as root, so no account may be able to change it: it has to be a regular file root owns and only root can write, in directories only root can write, from its own up to /.
Take that write access back, then set the host up again:
  sudo chmod g-w /usr/local/bin /usr/local
  sudo /usr/local/bin/orbit host setup --server https://orbit.example.com
```

Members of `staff` then need root to install there too. Whatever setup refuses, it names what is wrong and the
commands that put it right.

A machine set up by an earlier release, whose runners are `orbit-runner@<uid>`, is moved by running setup again:
[Moving a machine set up by an earlier release](#moving-a-machine-set-up-by-an-earlier-release).

### Register each account's runner

Each account registers its own runner, as itself:

```bash
orbit register --server https://orbit.example.com --name build-01-alice
```

`--server` can be left off when the binary came from this deployment, whose origin is then its default. The name
defaults to the machine's host name, the same for every account. Where one Orbit account registers runners for
several of a machine's accounts, give each its own `--name`: registering under a name the Orbit account already has
re-issues that runner's credential instead of adding a runner. Approval is as under
[Register a runner](#4-register-a-runner).

An account can install orbit first, the way it does on a machine that is not set up: the install command **Add a
runner** generates, run as the account itself, puts the account's own copy in `~/.orbit/bin/orbit` with the
`~/.local/bin/orbit` launcher, asks for no sudo and never writes `/usr/local/bin/orbit`. It does not edit `~/.bashrc`
or `~/.zshrc`: where `~/.local/bin` is not on the account's PATH, it prints the line that adds it. Registration needs
no install of its own, though. Run from any orbit, `/usr/local/bin/orbit` included, `orbit register` first puts the
binary it runs from at the account's `~/.orbit/bin/orbit`, as the account: `~/.orbit` made mode 0700 if it is not
there, then a new file renamed over the old one. When it already runs from that file, through the launcher or not, it
copies nothing.

So which `orbit` a shell finds matters. Debian's `~/.profile` puts `~/.local/bin` first on PATH once it exists, so a
login shell finds the launcher:

```bash
command -v orbit
```

Where `/usr/local/bin` comes before `~/.local/bin` on PATH, a bare `orbit` is the broker's binary instead, and
`orbit register` copies that build over the account's own copy. Type the launcher's path, `~/.local/bin/orbit`, to
register from the account's own copy there.

The broker enables and starts the account's instance, nothing asks for a password, and the command ends with:

```text
    ✓ Approved — build-01-alice is now a runner.
    ✓ Put this account's own copy of orbit at /home/alice/.orbit/bin/orbit, which its runner runs and updates.
    Waiting for the runner to reach https://orbit.example.com (up to 2m0s)…
    ✓ Background service started as alice (runs at boot).
      Stop or remove it later with `orbit unregister`.

✓ Setup complete — build-01-alice is online.

    Machine  build-01-alice (build-01)
    Next     Start a session
             https://orbit.example.com/runners/30tWePD4IYjCW1G8zmKpO/new
    orbit status · orbit doctor · orbit unregister
```

hostd-e2e also runs the receipt's `orbit status`, `orbit unregister` and `orbit doctor`; the last reports missing
coding engines on its test machine.

Before it starts the instance, the broker takes down every older runner unit of the account (see
[Migrating from per-user units](#migrating-from-per-user-units)), each drained on stop and confirmed down by systemd,
so the account never runs two runners. Taking one down can take up to three minutes, the unit's drain. The command
says when it is waiting for that, and waits; it never goes around a broker that is still working:

```text
    Waiting for the machine broker to finish "enable" — it may be draining an older runner, which takes up to 3 minutes (giving up after 15m0s)…
```

When an older runner will not stop, the broker neither enables nor starts the instance, and `orbit register` stops
there with the broker's answer and systemd's, without falling back to sudo. The older runner keeps running as it did:

```text
✗ Could not start the background service: refusing to enable orbit-runner@alice.service: alice's older runner orbit-runner-alice.service could not be stopped: systemctl stop orbit-runner-alice.service failed: exit status 4: Failed to stop orbit-runner-alice.service: Operation refused, unit orbit-runner-alice.service may be requested by dependency only (it is configured to refuse manual start/stop).
See system logs and 'systemctl status orbit-runner-alice.service' for details.
It is still alice's runner, so orbit-runner@alice.service was neither enabled nor started. Once it can be stopped, run `orbit register` again.
```

The runner is registered by then. Once root has let the old unit stop, the account runs its `orbit register` command
again, with the flags it registers with (`--server`, `--name` and any others). A broker that has not answered after
15 minutes stops the command the same way, naming `systemctl status orbit-hostd.service` to look at, since it may
still be carrying the request out. The broker also refuses an account with no home directory, or with no
`~/.orbit/bin/orbit` it can execute, and says what to run.

The account reads its runner's state and log itself:

```bash
systemctl status "orbit-runner@$(systemd-escape "$(id -un)")"
journalctl -u "orbit-runner@$(systemd-escape "$(id -un)")"
```

`systemd-escape` gives the account's instance name, `test\x2duser` for `test-user`. `journalctl` shows an account what
its own runner logged when the journal is persistent (`/var/log/journal` exists). systemd's own lines about the unit,
and other accounts' runners, need root or the `adm` or `systemd-journal` group.

To remove the runner:

```bash
orbit unregister --yes
```

Without `--yes` it asks first, and with no terminal to ask on it prints `aborted` and changes nothing. The broker
stops and disables the account's instance, the runner is deleted from the control plane and the account's runner
config is removed. Its own copy of orbit stays. Every other account's runner keeps running:

```text
✓ removed the orbit-runner@alice.service runner service
✓ deleted "build-01-alice" from the control plane
✓ unregistered "build-01-alice"
```

### Moving a machine set up by an earlier release

Machines set up by an earlier release run each account's runner as `orbit-runner@<uid>.service`, on the shared
`/usr/local/bin/orbit`. To move one, root puts the new release in place of the broker's binary, as under
[Set up the machine once](#set-up-the-machine-once), from root's own copy of the new release, where install.sh puts it:

```bash
sudo install -o 0 -g 0 -m 0755 ~/.orbit/bin/orbit /usr/local/bin/orbit
```

and runs setup again:

```bash
sudo /usr/local/bin/orbit host setup --server https://orbit.example.com
```

Setup writes the new template, then moves each `orbit-runner@<uid>` whose account has its own `~/.orbit/bin/orbit`
that it can execute, one account at a time: the uid instance is stopped, draining as it does, and disabled, each
confirmed by systemd, and only then is `orbit-runner@<user name>` enabled and started on the account's copy. No
account has two runners at any point. A move that fails is put back, and named. Setup then lists every account it
left, each with the one command that account runs:

```text
  Moved to instances named after their accounts:
    orbit-runner@1000.service → orbit-runner@alice.service (alice)

  Left on their orbit-runner@<uid> instance (1):
    bob (orbit-runner@1001.service): /home/bob/.orbit/bin/orbit is missing or bob cannot execute it.
      bob runs:  /usr/local/bin/orbit register
  An instance left keeps its current process. At its next restart it runs its account's own
  ~/.orbit/bin/orbit, so it needs that copy by then: the command above puts it in place and
  moves the runner to orbit-runner@<user name>.
```

An account without a copy is left on its uid instance, which keeps running the process it had. That process is still
the earlier release's, whose file root has replaced. The instance now reads the new template, though, so the next time
it starts, after a crash, a reboot or a restart, it starts `~/.orbit/bin/orbit`, and without that file it
keeps failing to start. So the account runs the command setup gave it, as itself, before then:

```bash
/usr/local/bin/orbit register
```

Registration puts the account's own copy in place and has the broker move its runner, taking the uid instance down
first, as above. Without arguments it asks the browser approval of [Register a runner](#4-register-a-runner) again and
takes the machine's host name; add `--name` and the other flags it was registered with to keep them.

### Root's runner and its legacy unit

Root is an ordinary account to hostd: root's register uses the same template, producing
`orbit-runner@root.service`, running as uid 0 from `/root/.orbit/bin/orbit`. Run the registration command above
in root's own shell, with a distinct runner name. For unattended registration with an enrollment token:

```bash
orbit register --server https://orbit.example.com --token <enrollment-token> --name <runner-name> --force
```

The root-access warning still applies.

To move an existing `orbit-runner-root.service`, run as root, with the deployment's server origin:

```bash
/usr/local/bin/orbit host setup --server https://orbit.example.com
```

Setup drains and confirms the legacy unit down before starting the instance, preserving the registration and runner
id without new approval. It puts root's `~/.orbit/bin/orbit` in place from the checked machine binary if missing.
The legacy unit file is removed. Its drop-ins are **not carried over**: they can override `User=` or `ExecStart=`.
Setup leaves them in place and names them, including files under both
`/etc/systemd/system/<unit>.d/` and `/etc/systemd/system.control/<unit>.d/` (written by
`systemctl set-property`).

Review the settings, then recreate the ones you need for the instance. For example, as root, recreate a PATH
drop-in and a CPU weight:

```bash
mkdir -p /etc/systemd/system/orbit-runner@root.service.d
printf '%s\n' '[Service]' 'Environment=PATH=/opt/node-v26/bin:/usr/local/bin:/usr/bin:/bin' > /etc/systemd/system/orbit-runner@root.service.d/path.conf
systemctl daemon-reload
systemctl set-property orbit-runner@root.service CPUWeight=200
systemctl restart orbit-runner@root.service
```

After reviewing and recreating the settings, remove the old directories by hand:

```bash
rm -r /etc/systemd/system/orbit-runner-root.service.d /etc/systemd/system.control/orbit-runner-root.service.d
```

Root's runner then updates its own `/root/.orbit/bin/orbit` and asks hostd to update `/usr/local/bin/orbit`,
like every account's runner. Hosts that are not set up keep root on the legacy `orbit-runner-root.service`.

### Migrating from per-user units

An account that registered before the machine was set up has a unit of its own that root wrote:
`orbit-runner-<user>.service`, or `orbit-runner.service` from older releases. Nothing has to be done about it by hand:

- The account's next `orbit register` has the broker stop, disable and delete that unit, and the account's
  `orbit-runner@<uid>` if it has one, before it starts `orbit-runner@<user name>.service`, so the account never runs
  two runners.
- `orbit unregister` has the broker take the same units down after the instance, so none is left behind on a
  credential the control plane has deleted.

A unit is the account's by its `User=`, never by its name, so another account's unit is left alone. A numeric
`User=` is that uid. Until an account registers again, its old unit keeps running as it did.

### Updates

Each account's runner updates its own copy, as on a machine that is not set up: offered a newer release, it installs
it into its `~/.orbit/bin/orbit` and re-executes into it, as its own account and without asking the broker. Then it
asks the broker once to bring its own binary along, and logs the answer:

```text
[orbit-runner 2026-11-01T02:48:12.402Z] installed orbit 0.1.250 into this runner's own copy; asked the host broker at /run/orbit/host.sock to update its own binary: it is installing orbit 0.1.250 as its own binary
```

The request names nothing: no server, release or account. The broker reads the server from `/etc/orbit/config.json`
and the release from its `/dl/version.json` as anybody reads it, without a runner's credential, and installs only a
release newer than its binary, checked as every install is: the manifest's SHA-256, then the version and write
contract the download reports, each run as the account that asked, or as the unprivileged account `nobody` when root
asks. It replaces only the binary `orbit-hostd.service` names, `/usr/local/bin/orbit`, and restarts no runner. Its journal, `orbit-hostd.service`,
records it:

```text
[orbit-runner 2026-11-01T02:48:43.188Z] installed orbit 0.1.250 at /usr/local/bin/orbit (verified as uid 1000); no runner restarted: each runs its account's own copy
```

It runs one update per five minutes; runners asking meanwhile are told that one just ran, and one asking after the
install is told the release is already there. The broker installs only what `/dl` publishes to everyone and takes no
part in staged rollouts or rollbacks, which are per runner
([Runner rollout and rollback](release-process.md#runner-rollout-and-rollback)). Each runner moves when its own
assignment offers it another release, and the broker's binary moves when the first runner that installed a newer one
asks.

An account's copy from a release before this layout, 0.1.243 say, updates itself just the same, but does not ask the
broker afterwards. The broker's binary then follows from the next release, which that runner, by then on the new code,
installs and asks about, or at once if root installs it:

```bash
sudo /usr/local/bin/orbit upgrade
```

`orbit upgrade` replaces `/usr/local/bin/orbit` where it is and restarts no runner, which none of the accounts' runners
needs, since none runs that file:

```text
checking https://orbit.example.com for updates...
updating 0.1.249 -> 0.1.250...
✓ orbit is now 0.1.250
```

The broker holds its binary to the rule setup does every time it replaces it: a regular file root owns and only root
can write, in directories only root can write all the way up to `/`. A directory that its group can write after setup,
such as `/usr/local/bin` changed to `root:staff` with mode 2775 as older Debian installs have it, would let any member
of the group replace what the broker runs as root, so the broker refuses to update its binary there. It fails closed:
the binary stays as it is, and the runner that asked logs why (the mode it reports leaves out the setgid bit). Its own
update stands:

```text
[orbit-runner 2026-11-01T02:54:42.491Z] installed orbit 0.1.250 into this runner's own copy; asked the host broker at /run/orbit/host.sock to update its own binary: it declined: refusing to update /usr/local/bin/orbit: its directory /usr/local/bin is not root's alone (owned by uid 0, mode 0775), and root writes nothing it downloaded where another account can reach
```

An administrator makes the directory root's alone:

```bash
sudo chmod g-w /usr/local/bin
```

Members of `staff` then need root to install there too. The broker installs the next release itself, or
`sudo /usr/local/bin/orbit upgrade` installs this one.

### Without the broker

`orbit register` and `orbit unregister` use the broker only where `/run/orbit/host.sock` exists. Without it, on a
machine that was never set up or whose socket is gone, they work as they did before the broker existed: on the
account's own `orbit-runner-<user>.service`, written or removed through sudo
([Register a runner](#4-register-a-runner)), with nothing said about a broker. A socket that is there with nothing
answering it, or a broker that refuses for any reason other than an older runner of the account that will not stop,
is reported before the same fallback:

```text
note: the machine broker at /run/orbit/host.sock did not answer "enable" (dial unix /run/orbit/host.sock: connect: connection refused) — falling back to the sudo path.
```

### Security model

- **Anyone may connect, and nobody gains anything by it.** The socket is mode 0666, but every verb acts on the
  caller's own runner: hostd takes the caller's uid from the kernel (`SO_PEERCRED`) and its name from the passwd
  database, never from the request, and refuses a request that names a user or any other target. A user name
  becomes a unit name only through systemd's own escaping, which can be undone, so no account can name another's
  unit.
- **hostd runs one binary, and never one an account can change or a download.** hostd runs only
  `/usr/local/bin/orbit`, held to the rule above. It never executes, reads or writes a file in an account's home:
  whether an account's `~/.orbit/bin/orbit` is there and executable is asked as that account. Checking a release
  means running it, to read its version and write contract, and each of those runs is dropped to the uid of the
  account that asked, or to `nobody` when root asks.
- **Root is an ordinary instance.** Each instance runs as its account (`User=%I`), from that account's own
  file. Only a caller with uid 0 can act on `orbit-runner@root.service`. Its heartbeat reports
  `runsAsRoot=true`, and registration warns that its agents have root access.

### Known limitations

**`--proxy` is not carried into the template.** The legacy path writes the proxy into a unit of the account's own;
the template is shared by every account and has no per-account environment. So on a machine that is set up,
`orbit register` starts the runner without the proxy, announcing the proxy first and then saying it is not used:

```text
the runner will use HTTP proxy http://proxy.example.com:3128 for claude
…
note: --proxy is not carried into orbit-runner@alice.service — the machine's shared runner template has no per-user proxy environment.
```

The runner comes online, but its coding engines get no proxy settings: where the model APIs are reachable only
through the proxy, they cannot reach them. Until a later release carries the proxy, do not set up a machine whose
runners need one. Register its accounts the single-account way instead, whose sudo step writes the proxy into each
account's own unit ([Register a runner](#4-register-a-runner)).

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
outside the normal migration path. These steps leave `.env` as it was, and an upgrade leaves [managed
runners](#what-an-upgrade-does) as it found them.

These steps do not set up the [runner link](#runner-link), or bring a new image of it, or recreate the web gateway for a
new `gateway/nginx.conf`, which it reads only as it starts. `/upgrade`'s script (`.claude/skills/upgrade/upgrade.sh`) does
all three, and Compose refuses these steps on a deployment with no link until it has run once.

`pgbackup` keeps the `scripts/pg-backup.sh` it started on until it is recreated, and these steps recreate it only when
its Compose definition changes. After a change to the script alone, run `docker compose up -d --no-deps --force-recreate
pgbackup` in this checkout; `/upgrade`'s script does that by itself.

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

### Moving old attachments out of Postgres

Attachments uploaded before the `./data/files` mount existed keep their bytes in Postgres. They move to the file store
(`./data/files`, or the bucket with `ORBIT_FILES_BACKEND=s3`) in two steps: a copy that runs by itself and can be undone,
and a clear that you run yourself and cannot undo. Attachments stay readable and uploads keep working during both, so
neither needs downtime.

**The copy.** After each start the apiserver copies those bytes to the file store in the background, at most 100
attachments or 64 MiB at a time, with a pause of a second in between. The start does not wait for it. Identical bytes are
stored once. Postgres keeps its copy, so `./data/files` or the bucket needs room for those bytes and nothing is freed
yet. The copy waits while the disk under `./data/files` has less than 2 GiB free, logs that it is waiting, and carries on
when there is room. You can stop the apiserver at any time, and the next start carries on from where it got to. If the
store fails, the apiserver logs the failure and tries again a minute later.

The apiserver logs its progress after each batch. With [several apiservers](#several-apiservers), each one that starts
with attachments waiting copies them, which does the work more than once but changes nothing else:

```text
attachment copy: 300 (52428800 bytes) copied this run, 1180 (734003200 bytes) left
```

To confirm the copy has finished, ask where every attachment's bytes are. This writes nothing:

```bash
docker compose exec apiserver node src/apiserver/dist/files/attachment-migration.cli.js status
```

```text
attachments waiting for the copy: 0 (0 bytes)
attachments copied and still in Postgres: 1480 (786432000 bytes)
attachments only in the file store: 2210 (1073741824 bytes)
```

The copy has finished when none are waiting. Any that an older apiserver wrote afterwards, during an upgrade of
[several apiservers](#several-apiservers), wait for the next start.

While a copied attachment still has its bytes in Postgres, it stays readable if the file store fails or has lost them:
the apiserver answers from Postgres and logs a warning naming the attachment, the store and the error, at most once a
minute for each store. Fix the store when you see this, because the clear refuses those attachments.

**The clear.** This removes the bytes from Postgres, which is the step you can't take back. Run it only when all of these
are true:

- `status` shows none waiting for the copy.
- You will not need to go back to an older version: after the clear,
  [an older version can't read any attachment](#going-back-to-an-older-version).
- The file store is backed up. Once the bytes leave Postgres they leave every new backup of it too, so `./data/files` is
  their only copy on this host. With `ORBIT_BACKUP_SYNC_TARGET` set, confirm that the sidecar has copied it to
  `<target>-files` since the copy finished, as described in
  [Attachment files](postgres-backup-restore.md#attachment-files). With a bucket, confirm its versioning or replication.
  Bytes kept in `./data/files` before a move to a bucket stay there, so they need the sidecar's copy either way.
- The disk has room for what the clear writes. It frees nothing at first: Postgres writes about as much WAL as the bytes
  it removes, and `./data/pg-archive` keeps that WAL until newer base backups replace the old ones. Have free at least
  what `status` shows as still in Postgres, plus 2 GiB.

Then run:

```bash
docker compose exec apiserver node src/apiserver/dist/files/attachment-migration.cli.js clear
```

For each copied attachment, the command reads the bytes back from the file store and checks them against the sha256 the
row names. It then checks that the bytes in Postgres are the same content, and only then removes them. It prints its
progress, then the same counts as `status`. It exits 0 when no attachment has bytes left in Postgres, and 1 otherwise.
You can stop it at any point and run it again: it carries on with the rows that still have bytes in Postgres, and changes
nothing on the others. Any attachment it has already cleared stays cleared, so stopping it does not bring back the
older version for those. It stops by itself, and says so, if the disk under `./data/files` falls below 2 GiB free, so
that it cannot fill the disk under Postgres; run it again when there is room.

An attachment that fails the check keeps its bytes in Postgres and is reported, and the command moves on to the next:

```text
refused 0198f6a2-7c3e-7a10-9d2b-5e1c4f0a8b37 (sha256 ab12…): the local file store does not hold these bytes
```

- **The store does not hold the bytes, or holds other bytes under that name.** Copy them again from Postgres. Remove
  whatever is at `./data/files/ab/ab12…` (in a bucket, the object `files/ab/ab12…`), take the row back to before the copy,
  restart the apiserver, and run the clear again once `status` shows none waiting:

  ```bash
  docker compose exec postgres psql -U orbit -d orbit \
    -c "UPDATE attachment SET sha256 = NULL WHERE id = '0198f6a2-7c3e-7a10-9d2b-5e1c4f0a8b37'"
  docker compose restart apiserver
  ```

- **The store could not be read.** Fix the store and run the clear again.
- **Its data in Postgres does not hash to this sha256.** The two copies differ, and only you can say which is right. The
  attachment stays as it is until you do.

The clear leaves the database the same size on disk: Postgres keeps the freed space and reuses it. To give the space back
to the host, run `VACUUM FULL attachment` in `psql` at a quiet time. Attachments can't be read or written while it runs.

### Going back to an older version

An apiserver with the `./data/files` mount keeps each new attachment's bytes there (or in the bucket, with
`ORBIT_FILES_BACKEND=s3`), and Postgres only names them. An older apiserver reads attachment bytes from Postgres alone,
so what it can read after you go back depends on where the bytes are:

- **Until the clear, attachments from before the upgrade work on both versions**, whether or not the copy has reached
  them, because the copy leaves their bytes in Postgres. So do the ones uploaded while the older version runs.
- **Attachments uploaded since the upgrade can't be read.** The older version fails on them: opening one, and anything
  else that needs its bytes, such as starting a run of a task that has one as an input.
- **After the clear, an older version can't read any attachment.** It fails on all of them in the same way, however old
  they are. See [Moving old attachments out of Postgres](#moving-old-attachments-out-of-postgres).
- **The bytes stay safe.** Going back changes nothing in `./data/files` or the bucket, and upgrading again serves those
  attachments as before.

A Compose upgrade replaces the apiserver in one step, so in normal operation no older version serves these attachments.
The exception is [several apiservers](#several-apiservers): the others run the old code until they are recreated, and
until then they fail on an attachment uploaded through the first one.

**The runner link, going back.** A version from before the link's default setup reads `RUNNER_LINK_URL=same-origin` as
no link: it logs that the value is not a `ws://` or `wss://` address, and its runners work over HTTPS. Its `link-gateway`
has no certificate to start with and restarts over and over, which harms nothing; take `runner-link` out of
`COMPOSE_PROFILES` to stop it, and put it back before you upgrade again.

## Production checklist

- [ ] `JWT_SECRET` and `PROVIDER_SECRET_KEY` are unique, protected, and backed up.
- [ ] `RUNNER_LINK_SIGNING_KEY`, `RUNNER_LINK_GATEWAY_TOKEN` and the NATS seeds are unique, protected and backed up, and
      the gateway holds the public key, not the private one.
- [ ] Where the link gateway has a host name of its own, its DNS record is DNS only (not proxied), its port is the only
      other one open to the internet, and its metrics port stays on loopback.
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
