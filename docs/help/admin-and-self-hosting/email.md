---
title: Email
summary: Send welcome emails to new accounts through Resend.
category: admin-and-self-hosting
routes: [/admin/email, /admin]
errors: []
platforms: [web]
common: false
updated: 2026-11-14
---

Orbit can send one email: a welcome email to each new account, through [Resend](https://resend.com). It is off until an administrator sets it up. The settings apply without a restart.

## Set it up

1. In Resend, add and verify the domain you will send from, then create an API key with **Sending access**. Copy it; it starts with `re_`.
2. In Orbit, open [Admin → Email](orbit:/admin/email).
3. Paste the key under **Resend API key**.
4. Fill in **From** with an address on the verified domain, such as `Orbit <orbit@example.com>`. Its domain must be verified in Resend.
5. **Reply-To** is optional. Left empty, replies go to the first administrator's address.
6. Turn on **Send email from this deployment**, and keep **Send a welcome email to new accounts** on.
7. Press **Save**, then **Send test email**. Orbit sends you a short email and shows what Resend answered.

## What gets sent

Each account created after email is on gets one welcome email. It says how to sign in and get started, and never contains a password, token or sign-in link. For an older account, use **Send welcome email** in its menu under **Admin → Users**.

A failed send is retried. If it keeps failing, **Admin → Users** shows **Welcome email failed** under the account; hover it for Resend's error. **Admin → Email** shows how many were sent and failed in the last 7 days.

## Common errors

| Resend answered | Fix |
| --- | --- |
| `403 — The example.com domain is not verified` | Verify the domain in Resend, or use a From address on a verified one. |
| `401 — API key is invalid` | Create a new key and paste it. |
| `403 — You can only send testing emails to your own email address` | Verify a domain and use it in From. |

Full guide: [Self-hosting: configure outgoing email](../../self-hosting.md#configure-outgoing-email).
