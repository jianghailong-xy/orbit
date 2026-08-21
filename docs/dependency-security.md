# Dependency security baseline

This page records Orbit's first production dependency review. It is evidence for a point in time, not a claim
that dependencies remain safe indefinitely. See the [security policy](../SECURITY.md#dependency-vulnerability-handling)
for the recurring controls and response targets.

## Baseline and decision

On 2026-08-20, `npm audit --omit=dev` reported 12 affected production packages: 3 high and 9 moderate. The
review treated an alert as reachable whenever untrusted network or file input crossed the affected component.
All affected packages were upgraded, even where the vulnerable function was not reachable, so no risk
acceptance is needed for this baseline.

| Package | Locked before | Reachability | Disposition | Locked after |
| --- | --- | --- | --- | --- |
| `@nestjs/common` | 10.4.22 | Direct server framework dependency. Orbit does not use Nest's `FileTypeValidator`, but the package is present in every API process. | Upgrade with the Nest 11 runtime. | 11.2.1 |
| `@nestjs/config` | 3.3.0 | Used at process startup. Orbit does not pass request data to the affected Lodash template/path helpers. | Upgrade; remove the vulnerable Lodash version transitively. | 4.0.4 |
| `@nestjs/core` | 10.4.22 | Direct and reachable for every controller, provider, and request. | Upgrade to the patched framework line. | 11.2.1 |
| `@nestjs/platform-express` | 10.4.22 | Direct HTTP adapter; reachable for every API request and file upload. | Upgrade together with Nest core. | 11.2.1 |
| `body-parser` | 1.20.4 | Transitive request parser; reachable from untrusted HTTP bodies. | Upgrade through the Nest/Express update. | 2.3.0 |
| `express` | 4.22.1 | Transitive HTTP runtime; reachable for every API request. | Upgrade through the Nest adapter update. | 5.2.1 |
| `file-type` | 20.4.1 | No direct import or `FileTypeValidator` use was found, so the vulnerable parsers were not reachable in Orbit. | Upgrade through `@nestjs/common`; no exception retained. | 21.3.4 |
| `lodash` | 4.17.21 | No direct import was found. It was used internally by `@nestjs/config`, while Orbit's configuration sources are operator-controlled. | Upgrade through `@nestjs/config`; no exception retained. | 4.18.1 |
| `multer` | 2.0.2 | Reachable through `FileInterceptor` in attachment and runner upload endpoints. Existing file-size caps reduce impact but do not address cleanup and nesting DoS cases. | Upgrade through the Nest adapter update. | 2.2.0 |
| `qs` | 6.14.2 | Transitive query parser; reachable from untrusted query strings. | Upgrade through Express/body-parser. | 6.15.3 |
| `react-router` | 6.30.4 | The SSR hydration issue is not reachable because Orbit is a client-only SPA. Navigation APIs are active throughout the UI, so the redirect class remains relevant. | Upgrade the router runtime. | 7.18.2 |
| `react-router-dom` | 6.30.4 | Direct client runtime with extensive `Link` and `useNavigate` use. Targets are built from static paths or encoded Orbit IDs, but the open-redirect class warrants removal. | Upgrade and run the full web suite. | 7.18.2 |

The original findings were associated with
[Nest core injection](https://github.com/advisories/GHSA-36xv-jgw5-4q75),
[body-parser limits](https://github.com/advisories/GHSA-v422-hmwv-36x6),
[file-type ASF parsing](https://github.com/advisories/GHSA-5v7r-6r5c-r473),
[file-type ZIP handling](https://github.com/advisories/GHSA-j47w-4g3g-c36v),
[Lodash template injection](https://github.com/advisories/GHSA-r5fr-rjxr-66jc),
[Lodash path pollution](https://github.com/advisories/GHSA-f23m-r3pf-42rh),
[Multer upload handling](https://github.com/advisories/GHSA-72gw-mp4g-v24j),
[qs denial of service](https://github.com/advisories/GHSA-q8mj-m7cp-5q26), and
[React Router navigation](https://github.com/advisories/GHSA-wrjc-x8rr-h8h6).

The same maintenance change upgrades Vite, Vitest, and the React plugin to remove development-tool findings.
The root Node.js requirement is therefore 20.19 or newer.

## Active overrides

| Override | Reason | Removal condition |
| --- | --- | --- |
| `deepmerge-ts` pinned to `^8.0.2` | Prisma 7.9.1's CLI pins `@prisma/config` to `deepmerge-ts` 7.1.5, which carries [GHSA-ggr8-5vv4-36mx](https://github.com/advisories/GHSA-ggr8-5vv4-36mx) (high; stack exhaustion when merging recursive object graphs). The package reaches the production tree through `@prisma/client`'s optional `prisma` peer, so it is not a dev-only finding. `@prisma/config` uses only `deepmerge` as c12's config merger, and 8.x keeps that export with the same semantics for plain objects. | Drop the `overrides` entry once a Prisma release depends on `deepmerge-ts` 8 or later. |

## Verification

Run from a clean checkout:

```sh
npm ci
npm audit --json
npm run prisma:generate
npm run build
npm test -w @orbit/shared
npm test -w @orbit/apiserver
npm test -w @orbit/web
```

The 2026-08-20 clean-room run reported zero audit findings and passed 141 shared tests, 1,212 API tests, and
552 web tests. Pull requests also run the dependency review action and fail when a changed dependency introduces
a high or critical advisory. Dependabot checks npm, GitHub Actions, Go modules, Swift packages, and Dockerfiles
weekly; maintainers must still review release notes, lockfile changes, licenses, and test evidence before merge.
