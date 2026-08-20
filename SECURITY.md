# Security policy

Orbit coordinates tools that can read and modify source code and may hold infrastructure credentials on runner
machines. Please report suspected vulnerabilities carefully.

## Supported versions

Orbit is pre-1.0 and evolving quickly. Security fixes are normally made on `main` and included in the next
release. The latest published release is the only release line that receives best-effort security updates;
older releases are not maintained as separate security branches.

| Version | Support |
| --- | --- |
| Latest release | Best-effort security fixes |
| `main` | Development branch; not a production support channel |
| Older releases | Not supported |

## Reporting a vulnerability

Do not include vulnerability details, credentials, exploit code, or affected user data in a public issue.

1. On the repository **Security** tab, use **Report a vulnerability** if private vulnerability reporting is
   available.
2. If no private reporting button is available, open a minimal issue titled `Security contact request` with no
   technical details. A maintainer will establish a private channel and then close the public request.

Include the affected version, component, impact, prerequisites, reproduction steps, and any suggested
mitigation in the private report. Use synthetic data and redact all secrets.

The project aims to acknowledge a private report within three business days and provide an initial assessment
within seven. These are targets for a volunteer project, not guaranteed service levels. Please allow time for a
coordinated fix and release before public disclosure.

## Dependency vulnerability handling

Orbit checks dependency changes on every pull request and asks Dependabot to check supported package ecosystems
weekly. The root `package-lock.json` is the authoritative JavaScript lockfile; workspace-local lockfiles are not
used. Dependency updates are reviewed and tested like any other code change and are never merged solely because
an automated tool opened them.

The maintainers use the following response targets after a dependency alert is published or reported:

| Severity | Triage target | Fix or mitigation target |
| --- | --- | --- |
| Critical | 1 business day | 7 calendar days |
| High | 3 business days | 14 calendar days |
| Moderate | 10 business days | 30 calendar days |
| Low | Next scheduled dependency review | Next routine update when practical |

If a target cannot be met, the tracking issue or security advisory must record reachability, impact, an owner,
compensating controls, and a review date. An alert is not considered resolved merely because it was dismissed.
See the [dependency security baseline](docs/dependency-security.md) for the current audit record and verification
commands.

## Scope

Reports are especially useful for:

- authentication or authorization bypasses;
- cross-user or cross-workspace data exposure;
- runner enrollment, service-token, or orchestration-proof flaws;
- command execution outside the permission and workspace boundaries described by Orbit;
- secret disclosure through logs, events, attachments, builds, or release artifacts;
- unsafe update, installer, or release-signing behavior;
- injection or request-forgery flaws reachable in a supported deployment.

The following are normally not vulnerabilities by themselves:

- an agent using permissions that an administrator explicitly granted;
- processes owned by the same runner OS account reading each other's files;
- an administrator's ability to access data in the instance they operate;
- missing rate limits or hardening in a deployment exposed contrary to the self-hosting guidance;
- issues that require a compromised host, database, administrator account, or release-signing credential.

Boundary cases are welcome as private reports when the impact is unclear.

## Operator responsibilities

Operators should use HTTPS, protect application secrets, isolate runner accounts, grant least privilege, keep
Orbit and agent runtimes updated, restrict network exposure, and test off-host backups. See the [architecture
trust boundaries](docs/architecture.md#trust-boundaries) and [self-hosting checklist](docs/self-hosting.md#production-checklist).
