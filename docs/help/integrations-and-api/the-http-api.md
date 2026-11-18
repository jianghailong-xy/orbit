---
title: The HTTP API
summary: Every route the web app uses is open to your scripts, under /api, with a bearer token.
category: integrations-and-api
routes: [/settings/access-tokens]
errors: []
platforms: [web]
common: false
updated: 2026-11-14
---

The web app, the phone and desktop apps, the `orbit` CLI and runners all talk to the same HTTP API. Your scripts can use it too.

## Basics

- **Base path**: every route starts with `/api` on your Orbit server, for example `https://orbit.example.com/api/tasks`.
- **Authentication**: send `Authorization: Bearer <token>` with a [personal access token](orbit:/settings/access-tokens). The token acts as you, limited to the access you gave it.
- **Bodies and answers** are JSON. A refusal answers with its HTTP status and a JSON body; many add a stable `code` and a `requiredAction` saying what to do instead.
- **Ids** can be the short form you see in Orbit's URLs or the full UUID.

## A first call

```bash
curl -fsS -H "Authorization: Bearer $ORBIT_TOKEN" https://orbit.example.com/api/tasks
```

Or let the CLI handle the token and server for you:

```bash
orbit login
orbit api /api/tasks
orbit api /api/tasks/page --paginate --json
```

`orbit api` prints the answer and exits non-zero on anything but a 2xx.

## What the API will not do with a token

Your own decisions, such as confirmations, approvals and evidence verdicts, the account itself, administration and access tokens, stay in the app. See [Personal access tokens](orbit:/help/integrations-and-api/access-tokens).

## Where every route is listed

The full reference is generated from the server's code, so it always matches the version you run. It says who may call each route and what it takes and returns.

Full guide: [External HTTP API reference](../../api-reference.md).
